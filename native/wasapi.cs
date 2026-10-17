// cadence-wasapi: plays s32le stereo PCM from stdin through WASAPI exclusive mode (bit-perfect at gain 1).
// Built with the .NET Framework csc.exe that ships with Windows (C# 5): see "build:native" in package.json.
//
// stdin (little-endian):  'F' rate:i32 bits:i32 tag:i32   format marker, queued in order with data
//                         'D' len:i32 bytes                PCM, s32 stereo interleaved
//                         'P' / 'R'                        pause / resume (immediate)
//                         'X' epoch:i32                    flush everything queued (immediate)
//                         'K' tag:i32                      drop every queued item of track `tag` (marker and PCM)
//                         'V' gain:f32                     software volume, 1 = untouched samples
// stdout lines:           pos <epoch> <frames>             real frames played since the last flush
//                         open <tag> <rate> <validBits> <containerBits> <bufferFrames>
//                         fail <tag> <message>        refuse <tag> <message> (this rate/bit depth only)
// argv[0]: endpoint friendly name ("" = default output).
//
// argv[0] = "--volume": the output device's own volume instead (see VolumeService).
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

static class Wasapi {
  class Fmt { public int Rate, Bits, Tag; }
  class Item { public byte[] Data; public int Off; public Fmt Fmt; public int Tag; } // Tag: track the item belongs to

  static readonly object L = new object();
  static readonly LinkedList<Item> q = new LinkedList<Item>();
  static long queuedBytes;
  static volatile bool paused, flushReq;
  static volatile float gain = 1f;
  static int epoch, inTag = -1; // inTag: track of the PCM currently arriving on stdin
  static string deviceName;
  static StreamWriter stdout;
  static volatile bool failed;
  static readonly Dictionary<int, int[]> pref = new Dictionary<int, int[]>(); // last working [container, valid] per source-depth class

  // device session
  static IAudioClient client; static IAudioRenderClient rc; static Fmt cur;
  static int bufFrames, outBytes, bufMs; static bool started;
  static long T, R, silDone, basePos, waitStart; // T = frames handed to the device, R = real (non-silence) frames
  static readonly List<long[]> sil = new List<long[]>(); // silence runs [startT, len] inserted on underrun
  static byte[] scratch = new byte[0];

  [MTAThread]
  static void Main(string[] args) {
    if (args.Length > 0 && args[0] == "--volume") { VolumeService(); return; }
    deviceName = args.Length > 0 ? args[0] : "";
    stdout = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };
    new Thread(Render) { IsBackground = true, Priority = ThreadPriority.Highest }.Start();
    var br = new BinaryReader(Console.OpenStandardInput());
    try {
      while (true) {
        char op = (char)br.ReadByte();
        try {
        if (op == 'F') { var f = new Fmt { Rate = br.ReadInt32(), Bits = br.ReadInt32(), Tag = br.ReadInt32() }; inTag = f.Tag; lock (L) q.AddLast(new Item { Fmt = f, Tag = f.Tag }); }
        else if (op == 'D') { int len = br.ReadInt32(); if (len < 0 || len > (64 << 20)) { Console.Error.WriteLine("bad D length " + len); continue; } var d = br.ReadBytes(len); lock (L) { q.AddLast(new Item { Data = d, Tag = inTag }); queuedBytes += d.Length; } }
        else if (op == 'P') paused = true;
        else if (op == 'R') paused = false;
        else if (op == 'V') { float v = br.ReadSingle(); gain = float.IsNaN(v) || float.IsInfinity(v) ? 0f : Math.Max(0f, Math.Min(1f, v)); }
        else if (op == 'X') { int e = br.ReadInt32(); lock (L) { q.Clear(); queuedBytes = 0; flushReq = true; epoch = e; } }
        else if (op == 'K') {
          int tag = br.ReadInt32();
          lock (L) {
            // one pass: works whether or not the render thread already consumed this track's marker
            for (var n = q.First; n != null; ) {
              var nx = n.Next;
              if (n.Value.Tag == tag) { if (n.Value.Data != null) queuedBytes -= n.Value.Data.Length - n.Value.Off; q.Remove(n); }
              n = nx;
            }
          }
        }
        } catch (EndOfStreamException) { throw; } catch (Exception e) { Console.Error.WriteLine("bad command " + op + ": " + e.Message); }
      }
    } catch (EndOfStreamException) { } // parent went away
  }

  static void Say(string s) { lock (stdout) stdout.WriteLine(s); }

  static void Render() {
    int task = 0;
    AvSetMmThreadCharacteristicsW("Pro Audio", ref task);
    var clock = Stopwatch.StartNew();
    long lastReport = 0;
    while (true) {
      try {
        Item head = null; bool flush; int ep;
        lock (L) { flush = flushReq; flushReq = false; ep = epoch; if (q.Count > 0) head = q.First.Value; }
        if (flush) {
          if (client != null) { client.Stop(); client.Reset(); }
          started = false; T = R = silDone = basePos = 0; sil.Clear(); waitStart = clock.ElapsedMilliseconds;
        }
        if (head != null && head.Fmt != null && !(client != null && Same(head.Fmt))) {
          // new format (or first open): let the old one play out, then reopen the device
          if (client != null && Played() < R) {
            if (!paused) Pump(clock); else if (started) { client.Stop(); started = false; }
            Thread.Sleep(5); continue;
          }
          lock (L) { if (q.Count == 0 || q.First.Value != head) continue; q.RemoveFirst(); }
          if (client != null) { basePos += Played(); Close(); }
          Open(head.Fmt);
          waitStart = clock.ElapsedMilliseconds;
          continue;
        }
        if (client == null) {
          // no device (open failed): drop data until the next marker
          if (head != null) lock (L) { if (q.Count > 0 && q.First.Value == head) { q.RemoveFirst(); if (head.Data != null) queuedBytes -= head.Data.Length - head.Off; } }
          else Thread.Sleep(5);
          continue;
        }
        if (paused) { if (started) { client.Stop(); started = false; } }
        else Pump(clock);
        if (clock.ElapsedMilliseconds - lastReport >= 50) { lastReport = clock.ElapsedMilliseconds; Say("pos " + ep + " " + (basePos + Played())); }
        Thread.Sleep(paused ? 5 : Math.Max(2, bufMs / 4));
      } catch (Exception e) {
        // device lost / unplugged: report and stop using it
        if (!failed) Say("fail " + (cur != null ? cur.Tag : 0) + " " + Describe(e)); // once per outage
        failed = true;
        try { Close(); } catch { }
        lock (L) { q.Clear(); queuedBytes = 0; }
      }
    }
  }

  static bool Same(Fmt f) { return cur != null && f.Rate == cur.Rate && f.Bits == cur.Bits; }

  // real frames the device has played this session (excludes silence inserted on underruns)
  static long Played() {
    uint pad; client.GetCurrentPadding(out pad);
    long played = T - pad;
    while (sil.Count > 0 && sil[0][0] + sil[0][1] <= played) { silDone += sil[0][1]; sil.RemoveAt(0); }
    long part = sil.Count > 0 && sil[0][0] < played ? played - sil[0][0] : 0;
    return played - silDone - part;
  }

  static void Pump(Stopwatch clock) {
    uint pad; client.GetCurrentPadding(out pad);
    int avail = bufFrames - (int)pad, fb = 2 * outBytes, k = 0;
    if (avail <= 0) return;
    if (scratch.Length < avail * fb) scratch = new byte[avail * fb];
    lock (L) {
      if (flushReq) return;
      // don't start on a half-empty buffer (decoder still spinning up) unless it is taking long
      if (!started && queuedBytes < avail * 8L && clock.ElapsedMilliseconds - waitStart < 400) return;
      while (k < avail && q.Count > 0) {
        Item it = q.First.Value;
        if (it.Fmt != null) { if (Same(it.Fmt)) { q.RemoveFirst(); continue; } break; } // gapless: same format just continues
        int n = Math.Min(avail - k, (it.Data.Length - it.Off) / 8);
        Convert(it.Data, it.Off, scratch, k * fb, n * 2);
        k += n; it.Off += n * 8; queuedBytes -= n * 8;
        if (it.Off >= it.Data.Length) q.RemoveFirst();
      }
    }
    if (k == 0 && T == 0) return; // nothing to play yet
    Array.Clear(scratch, k * fb, (avail - k) * fb);
    IntPtr p;
    rc.GetBuffer((uint)avail, out p);
    Marshal.Copy(scratch, 0, p, avail * fb);
    rc.ReleaseBuffer((uint)avail, 0);
    if (k < avail) sil.Add(new long[] { T + k, avail - k });
    T += avail; R += k;
    if (!started) { client.Start(); started = true; }
  }

  // s32 samples -> device container (top bytes), optional gain
  static void Convert(byte[] src, int so, byte[] dst, int d, int samples) {
    float g = gain;
    if (outBytes == 4 && g == 1f) { Buffer.BlockCopy(src, so, dst, d, samples * 4); return; }
    int skip = 4 - outBytes;
    for (int i = 0; i < samples; i++, so += 4) {
      if (g != 1f) {
        int s = BitConverter.ToInt32(src, so);
        s = (int)Math.Max(int.MinValue, Math.Min(int.MaxValue, Math.Round(s * (double)g)));
        for (int b = skip; b < 4; b++) dst[d++] = (byte)(s >> (8 * b));
      } else for (int b = skip; b < 4; b++) dst[d++] = src[so + b];
    }
  }

  static void Open(Fmt f) {
    // [container, valid] candidates that carry the source bits untouched
    int[][] cands = f.Bits > 24 ? new[] { new[] { 32, 32 } }
      : f.Bits > 16 ? new[] { new[] { 32, 24 }, new[] { 24, 24 }, new[] { 32, 32 } }
      : new[] { new[] { 16, 16 }, new[] { 24, 24 }, new[] { 32, 24 }, new[] { 32, 32 } };
    failed = false;
    int pk = f.Bits > 24 ? 2 : f.Bits > 16 ? 1 : 0; int[] lead;
    if (pref.TryGetValue(pk, out lead)) cands = new[] { lead }.Concat(cands.Where(x => x[0] != lead[0] || x[1] != lead[1])).ToArray(); // reopen tries the layout that worked last time first
    string err = "format not supported"; bool refused = true;
    foreach (var c in cands) {
      try {
        if (Init(f.Rate, c[0], c[1])) {
          cur = f; outBytes = c[0] / 8; pref[pk] = c;
          Say("open " + f.Tag + " " + f.Rate + " " + c[1] + " " + c[0] + " " + bufFrames);
          return;
        }
      } catch (Exception e) {
        err = Describe(e);
        refused = e is COMException && (uint)((COMException)e).ErrorCode == 0x88890008;
        if (!refused) break; // only a format refusal is worth another try
      }
    }
    cur = null;
    Say((refused ? "refuse " : "fail ") + f.Tag + " " + err + " (" + f.Rate + " Hz, " + f.Bits + "-bit)");
  }

  static bool Init(int rate, int container, int valid) {
    var wfx = new WFX {
      tag = 0xFFFE, ch = 2, rate = (uint)rate, blockAlign = (ushort)(2 * container / 8), bits = (ushort)container,
      cbSize = 22, valid = (ushort)valid, mask = 3, sub = new Guid("00000001-0000-0010-8000-00aa00389b71"),
    };
    wfx.avgBytes = wfx.rate * wfx.blockAlign;
    long dur = 1000000; // 100 ms
    for (int attempt = 0; attempt < 2; attempt++) {
      var c = Activate();
      int hr = c.Initialize(1 /* exclusive */, 0, dur, 0, ref wfx, IntPtr.Zero);
      if ((uint)hr == 0x88890019 && attempt == 0) { // AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED: retry with the aligned size
        uint fr; c.GetBufferSize(out fr);
        dur = (long)(10000000.0 * fr / rate + 0.5);
        Marshal.ReleaseComObject(c);
        continue;
      }
      if (hr < 0) { Marshal.ReleaseComObject(c); Marshal.ThrowExceptionForHR(hr); }
      uint frames; c.GetBufferSize(out frames);
      object o; var iid = typeof(IAudioRenderClient).GUID;
      c.GetService(ref iid, out o);
      client = c; rc = (IAudioRenderClient)o; bufFrames = (int)frames; bufMs = (int)(1000L * frames / rate);
      started = false; T = R = silDone = 0; sil.Clear();
      return true;
    }
    return false;
  }

  static void Close() {
    if (client == null) return;
    try { client.Stop(); } catch { }
    Marshal.ReleaseComObject(rc); Marshal.ReleaseComObject(client);
    client = null; rc = null; cur = null; started = false; T = R = silDone = 0; sil.Clear();
  }

  // ---------- --volume: the output device's own volume, like a phone's volume keys ----------
  // stdin lines:  "dev <friendly name>" (empty = default output, followed when it changes), "set <0..1>"
  // stdout lines: "vol <0..1> <muted 0|1> <hardware 0|1>" once per device and on every change made outside Cadence,
  //               "none <message>" when the device or its volume control is unavailable
  static void VolumeService() {
    stdout = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };
    var cmds = new ConcurrentQueue<string>();
    new Thread(() => { string l; while ((l = Console.ReadLine()) != null) cmds.Enqueue(l); Environment.Exit(0); }) { IsBackground = true }.Start();
    IAudioEndpointVolume ev = null; string evId = null; float last = -1f; bool lastMute = false, haveDev = false, down = false;
    var ctx = Guid.Empty; var clock = Stopwatch.StartNew(); long resolveAt = 0;
    while (true) {
      try {
        string c;
        while (cmds.TryDequeue(out c)) {
          if (c.StartsWith("dev ")) { deviceName = c.Substring(4); haveDev = true; ev = null; evId = null; resolveAt = 0; }
          else if (c.StartsWith("set ") && ev != null) {
            float v;
            if (!float.TryParse(c.Substring(4), NumberStyles.Float, CultureInfo.InvariantCulture, out v) || float.IsNaN(v)) continue;
            v = Math.Max(0f, Math.Min(1f, v));
            ev.SetMasterVolumeLevelScalar(v, ref ctx);
            if (v > 0 && lastMute) ev.SetMute(false, ref ctx);
            last = v; lastMute = false; // our own change: not reported back
          }
        }
        if (haveDev && clock.ElapsedMilliseconds >= resolveAt) { // follow a changed default device or a replugged one
          resolveAt = clock.ElapsedMilliseconds + 1000;
          string id; var dev = Find(out id);
          if (id != evId) {
            object o; var iid = typeof(IAudioEndpointVolume).GUID;
            dev.Activate(ref iid, 23, IntPtr.Zero, out o);
            ev = (IAudioEndpointVolume)o; evId = id; last = -1f;
          }
        }
        if (ev != null) {
          float v; bool m; ev.GetMasterVolumeLevelScalar(out v); ev.GetMute(out m);
          if (Math.Abs(v - last) > 0.002f || m != lastMute) {
            uint hw; ev.QueryHardwareSupport(out hw);
            Say(string.Format(CultureInfo.InvariantCulture, "vol {0:0.####} {1} {2}", v, m ? 1 : 0, (hw & 1) != 0 ? 1 : 0));
            last = v; lastMute = m;
          }
          down = false;
        }
      } catch (Exception e) {
        if (!down) Say("none " + Describe(e)); // once per outage
        down = true; ev = null; evId = null;
      }
      Thread.Sleep(150);
    }
  }

  static IAudioClient Activate() {
    string id; var dev = Find(out id);
    object o; var iid = typeof(IAudioClient).GUID;
    dev.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o);
    return (IAudioClient)o;
  }

  static IMMDevice Find(out string devId) {
    var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDevice dev = null;
    if (deviceName != "") {
      IMMDeviceCollection all; en.EnumAudioEndpoints(0 /* render */, 1 /* active */, out all);
      uint n; all.GetCount(out n);
      for (uint i = 0; i < n && dev == null; i++) {
        IMMDevice d; all.Item(i, out d);
        IPropertyStore ps; d.OpenPropertyStore(0, out ps);
        var key = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
        PROPVARIANT v; ps.GetValue(ref key, out v);
        string id; d.GetId(out id);
        if ((v.vt == 31 && Norm(Marshal.PtrToStringUni(v.p)) == Norm(deviceName)) || id == deviceName) dev = d;
        PropVariantClear(ref v);
      }
      if (dev == null) throw new InvalidOperationException("Output device not found: " + deviceName); // never fall back to another endpoint
    } else en.GetDefaultAudioEndpoint(0, 1 /* multimedia */, out dev);
    dev.GetId(out devId);
    return dev;
  }

  // Chromium labels carry a " (vid:pid)" suffix and a "Default - " prefix the endpoint's friendly name lacks
  static string Norm(string s) {
    s = System.Text.RegularExpressions.Regex.Replace(s ?? "", @"\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{4}\)\s*$", "");
    s = System.Text.RegularExpressions.Regex.Replace(s, @"^(Default|Communications) - ", "");
    return s.Trim().ToLowerInvariant();
  }

  // map by HRESULT whatever the exception type: a vanished endpoint surfaces as COMException, NotImplementedException
  // (E_NOTIMPL) or a Win32 ERROR_NOT_FOUND, and all of them mean the device is gone
  static string Describe(Exception e) {
    switch ((uint)e.HResult) {
      case 0x80004001: case 0x80070490: case 0x80070015: case 0x80070002: case 0x80070003: // E_NOTIMPL, not found, not ready, file/path not found
      case 0x88890004: case 0x88890026: case 0x8889000D: return "Output device disconnected";
      case 0x88890008: return "the device refused this format in exclusive mode";
      case 0x8889000A: return "the device is in use by another exclusive-mode app";
      case 0x8889000E: return "exclusive mode is disabled for this device (Sound settings > Advanced)";
    }
    if (e is COMException) return "WASAPI error 0x" + ((uint)e.HResult).ToString("X8");
    return System.Text.RegularExpressions.Regex.Replace(e.Message, @"\s+", " ").Trim();
  }

  // ---------- COM interop ----------
  [DllImport("avrt.dll", CharSet = CharSet.Unicode)] static extern IntPtr AvSetMmThreadCharacteristicsW(string task, ref int index);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pv);

  [StructLayout(LayoutKind.Sequential, Pack = 2)]
  struct WFX { public ushort tag, ch; public uint rate, avgBytes; public ushort blockAlign, bits, cbSize, valid; public uint mask; public Guid sub; }
  struct PROPERTYKEY { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Explicit, Size = 24)]
  struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    void EnumAudioEndpoints(int flow, int mask, out IMMDeviceCollection devices);
    void GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection { void GetCount(out uint n); void Item(uint i, out IMMDevice d); }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    void Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
    void OpenPropertyStore(int access, out IPropertyStore ps);
    void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore { void GetCount(out uint n); void GetAt(uint i, out PROPERTYKEY k); void GetValue(ref PROPERTYKEY k, out PROPVARIANT v); }
  [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient {
    [PreserveSig] int Initialize(int shareMode, int flags, long bufferDuration, long periodicity, [In] ref WFX format, IntPtr session);
    void GetBufferSize(out uint frames);
    void GetStreamLatency(out long latency);
    void GetCurrentPadding(out uint frames);
    void IsFormatSupported(int shareMode, [In] ref WFX format, out IntPtr closest);
    void GetMixFormat(out IntPtr format);
    void GetDevicePeriod(out long def, out long min);
    void Start();
    void Stop();
    void Reset();
    void SetEventHandle(IntPtr h);
    void GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  }
  [ComImport, Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioRenderClient { void GetBuffer(uint frames, out IntPtr data); void ReleaseBuffer(uint frames, int flags); }
  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    void RegisterControlChangeNotify(IntPtr notify); void UnregisterControlChangeNotify(IntPtr notify);
    void GetChannelCount(out uint n);
    void SetMasterVolumeLevel(float db, ref Guid ctx); void SetMasterVolumeLevelScalar(float v, ref Guid ctx);
    void GetMasterVolumeLevel(out float db); void GetMasterVolumeLevelScalar(out float v);
    void SetChannelVolumeLevel(uint ch, float db, ref Guid ctx); void SetChannelVolumeLevelScalar(uint ch, float v, ref Guid ctx);
    void GetChannelVolumeLevel(uint ch, out float db); void GetChannelVolumeLevelScalar(uint ch, out float v);
    void SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx); void GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    void GetVolumeStepInfo(out uint step, out uint count); void VolumeStepUp(ref Guid ctx); void VolumeStepDown(ref Guid ctx);
    void QueryHardwareSupport(out uint mask); void GetVolumeRange(out float min, out float max, out float inc);
  }
}
