// cadence-wasapi: plays s32le stereo PCM from stdin through WASAPI exclusive mode (bit-perfect at gain 1).
// Built with the .NET Framework csc.exe that ships with Windows (C# 5): see "build:native" in package.json.
//
// stdin (little-endian):  'F' rate:i32 bits:i32 tag:i32   format marker, queued in order with data
//                         'D' len:i32 bytes                PCM, s32 stereo interleaved
//                         'P' / 'R'                        pause / resume (immediate)
//                         'X' epoch:i32                    flush everything queued (immediate)
//                         'K' tag:i32                      drop every queued item of track `tag` (marker and PCM)
//                         'V' gain:f32                     volume (0..1, linear); the DAC's own volume carries it when it has one
//                         'G' tag:i32 gain:f32             per-track gain (ReplayGain) for track `tag`
//                         'S' len:i32 utf8                 DSP settings (see DspConfig.Parse in dsp.cs)
// stdout lines:           pos <epoch> <frames>             real frames played since the last flush
//                         open <tag> <rate> <validBits> <containerBits> <bufferFrames>
//                         fail <tag> <message>        refuse <tag> <message> (this rate/bit depth only)
//                         dsp <active 0|1> <digitalDb> <dacDb|-> <hwVolume 0|1> <boostDb>   whenever it changes
//                         uvol <gain>                      the DAC volume was changed outside Cadence (keys, Windows)
// argv[0]: endpoint friendly name ("" = default output).
using System;
using System.Collections.Generic;
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
  static readonly Dictionary<int, double> tagGain = new Dictionary<int, double>(); // under L
  static volatile DspConfig pendingCfg; static DspConfig cfg = new DspConfig();
  static float appliedVol = -1f;
  static Dsp dsp;
  static readonly Dictionary<int, int[]> pref = new Dictionary<int, int[]>(); // last working [container, valid] per source-depth class

  // device session
  static IAudioClient client; static IAudioRenderClient rc; static Fmt cur;
  static int bufFrames, outBytes, valid, bufMs; static bool started;
  static long T, R, silDone, basePos, waitStart; // T = frames handed to the device, R = real (non-silence) frames
  static readonly List<long[]> sil = new List<long[]>(); // silence runs [startT, len] inserted on underrun
  static byte[] scratch = new byte[0];

  [MTAThread]
  static void Main(string[] args) {
    if (args.Length > 0 && args[0] == "--selftest") { Environment.Exit(SelfTest()); }
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
        else if (op == 'G') { int tag = br.ReadInt32(); float v = br.ReadSingle(); lock (L) tagGain[tag] = float.IsNaN(v) || float.IsInfinity(v) ? 1 : Math.Max(0, Math.Min(16, v)); }
        else if (op == 'S') {
          int len = br.ReadInt32(); if (len < 0 || len > (1 << 16)) { Console.Error.WriteLine("bad S length " + len); continue; }
          pendingCfg = DspConfig.Parse(System.Text.Encoding.UTF8.GetString(br.ReadBytes(len)));
        }
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
    RestoreVolume();
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
          if (dsp != null) dsp.Reset();
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
        Settings(clock);
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
    long played = T - pad - (dsp != null ? dsp.Latency : 0); // the DSP delays the output by its latency
    if (played < 0) played = 0;
    while (sil.Count > 0 && sil[0][0] + sil[0][1] <= played) { silDone += sil[0][1]; sil.RemoveAt(0); }
    long part = sil.Count > 0 && sil[0][0] < played ? played - sil[0][0] : 0;
    return played - silDone - part;
  }

  static double[] xbuf = new double[0], seg = new double[0];
  static readonly List<double[]> chunks = new List<double[]>(); // [startFrame, frames, gain] of this pump's PCM

  static void Pump(Stopwatch clock) {
    uint pad; client.GetCurrentPadding(out pad);
    int avail = bufFrames - (int)pad, fb = 2 * outBytes, k = 0;
    if (avail <= 0) return;
    if (scratch.Length < avail * fb) scratch = new byte[avail * fb];
    if (xbuf.Length < avail * 2) xbuf = new double[avail * 2];
    chunks.Clear();
    lock (L) {
      if (flushReq) return;
      // don't start on a half-empty buffer (decoder still spinning up) unless it is taking long
      if (!started && queuedBytes < avail * 8L && clock.ElapsedMilliseconds - waitStart < 400) return;
      while (k < avail && q.Count > 0) {
        Item it = q.First.Value;
        if (it.Fmt != null) { if (Same(it.Fmt)) { q.RemoveFirst(); continue; } break; } // gapless: same format just continues
        int n = Math.Min(avail - k, (it.Data.Length - it.Off) / 8);
        double tg; if (!tagGain.TryGetValue(it.Tag, out tg)) tg = 1;
        chunks.Add(new double[] { k, n, tg });
        for (int i = 0, o = it.Off, d = 2 * k; i < 2 * n; i++, o += 4, d++) xbuf[d] = BitConverter.ToInt32(it.Data, o) / 2147483648.0;
        k += n; it.Off += n * 8; queuedBytes -= n * 8;
        if (it.Off >= it.Data.Length) q.RemoveFirst();
      }
    }
    if (k == 0 && T == 0) return; // nothing to play yet
    Array.Clear(xbuf, 2 * k, 2 * (avail - k)); // underrun / tail: silence, run through the DSP so delays and reverb play out
    if (k < avail) chunks.Add(new double[] { k, avail - k, -1 });
    foreach (var c in chunks) {
      int at = (int)c[0], n = (int)c[1];
      if (c[2] >= 0) dsp.StreamGain = c[2];
      if (seg.Length < 2 * n) seg = new double[2 * n];
      Array.Copy(xbuf, 2 * at, seg, 0, 2 * n);
      dsp.Process(seg, n);
      Array.Copy(seg, 0, xbuf, 2 * at, 2 * n);
    }
    Quantize(xbuf, avail, scratch, !dsp.Neutral);
    IntPtr p;
    rc.GetBuffer((uint)avail, out p);
    Marshal.Copy(scratch, 0, p, avail * fb);
    rc.ReleaseBuffer((uint)avail, 0);
    if (k < avail) sil.Add(new long[] { T + k, avail - k });
    T += avail; R += k;
    if (!started) { client.Start(); started = true; }
  }

  // double -> device container at its valid bits. Neutral DSP: exact (the samples came from these bits). Otherwise TPDF dither.
  static uint rng = 0x9E3779B9;
  static double Rand() { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng / 4294967296.0; }
  static void Quantize(double[] x, int frames, byte[] dst, bool dither) {
    int skip = 4 - outBytes, d = 0;
    double scale = Math.Pow(2, valid - 1), hi = scale - 1;
    for (int i = 0; i < 2 * frames; i++) {
      double y = x[i] * scale;
      if (dither && valid < 32) y += Rand() - Rand();
      y = Math.Floor(y + 0.5);
      if (y > hi) y = hi; else if (y < -scale) y = -scale;
      int s32 = (int)((long)y << (32 - valid));
      for (int b = skip; b < 4; b++) dst[d++] = (byte)(s32 >> (8 * b));
    }
  }

  static void Open(Fmt f) {
    // [container, valid] candidates that carry the source bits untouched
    int[][] cands = f.Bits > 24 ? new[] { new[] { 32, 32 } }
      : f.Bits > 16 ? new[] { new[] { 32, 24 }, new[] { 24, 24 }, new[] { 32, 32 } }
      : new[] { new[] { 32, 24 }, new[] { 24, 24 }, new[] { 32, 32 }, new[] { 16, 16 } }; // 16-bit sources ride in 24 bits: same samples, room for DSP
    failed = false;
    int pk = f.Bits > 24 ? 2 : f.Bits > 16 ? 1 : 0; int[] lead;
    if (pref.TryGetValue(pk, out lead)) cands = new[] { lead }.Concat(cands.Where(x => x[0] != lead[0] || x[1] != lead[1])).ToArray(); // reopen tries the layout that worked last time first
    string err = "format not supported"; bool refused = true;
    foreach (var c in cands) {
      try {
        if (Init(f.Rate, c[0], c[1])) {
          cur = f; outBytes = c[0] / 8; valid = c[1]; pref[pk] = c;
          dsp = new Dsp(f.Rate); dsp.Apply(cfg); appliedVol = -1f; // volume and headroom recomputed for this rate
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

  // ---------- settings: DSP config, and the volume carried by the DAC's own hardware volume ----------
  // Like direct volume control: the samples stay at full resolution and the DAC sets the level. EQ boosts are made
  // room for digitally (-boost dB) and the DAC is turned up by the same amount, so the level of everything else stays put.
  static IAudioEndpointVolume ev; static bool hwVol, evTried; static float evMin, evMax, evInc, origDb = float.NaN, lastDac = float.NaN;
  static double pendDb = double.NaN, digital = 1; static long pendAt, lastPoll; static string lastDsp = "";
  static readonly object VL = new object(); static Guid evCtx = Guid.Empty;

  static void Settings(Stopwatch clock) {
    var c = pendingCfg;
    bool changed = false;
    if (c != null) { pendingCfg = null; cfg = c; if (dsp != null) dsp.Apply(c); changed = true; }
    float g = gain;
    if (changed || g != appliedVol) { appliedVol = g; Level(g, clock); }
    long now = clock.ElapsedMilliseconds;
    lock (VL) {
      if (ev == null || !hwVol) return;
      if (!double.IsNaN(pendDb)) {
        if (now >= pendAt) { ev.SetMasterVolumeLevel((float)pendDb, ref evCtx); lastDac = (float)pendDb; pendDb = double.NaN; lastPoll = now; }
        return;
      }
      if (now - lastPoll < 250) return;
      lastPoll = now;
      float lv; ev.GetMasterVolumeLevel(out lv);
      if (Math.Abs(lv - lastDac) > Math.Max(0.6f, evInc)) { // changed with the volume keys or in Windows: the slider follows
        double total = Math.Min(1, digital * Math.Pow(10, lv / 20.0));
        lastDac = lv; gain = appliedVol = (float)total;
        Say("uvol " + total.ToString("0.######", System.Globalization.CultureInfo.InvariantCulture));
        Level(total, clock); // same DAC step, refreshes the reported state
      }
    }
  }

  static void Level(double g, Stopwatch clock) {
    if (dsp == null) return;
    bool neutral = cfg.Neutral, off = g <= 1e-7;
    double boost = neutral ? 0 : Math.Max(0, dsp.BoostDb()), dac = double.NaN;
    EnsureVolume();
    lock (VL) {
      if (ev != null && hwVol) {
        double want = off ? evMin : 20 * Math.Log10(g) + boost;
        dac = Snap(Math.Max(evMin, Math.Min(Math.Min(evMax, 0), want)));
        // neutral: the DAC alone sets the level, the samples stay untouched (bit-perfect); otherwise they carry the exact rest
        digital = off ? 0 : neutral ? 1 : g / Math.Pow(10, dac / 20);
        // the new digital gain reaches the DAC only after what is already buffered: change the DAC then
        uint pad = 0; if (started) client.GetCurrentPadding(out pad);
        pendDb = dac; pendAt = clock.ElapsedMilliseconds + (started ? (long)(1000.0 * (pad + dsp.Latency) / cur.Rate) : 0);
      } else digital = g;
    }
    dsp.Volume = digital;
    var inv = System.Globalization.CultureInfo.InvariantCulture;
    string line = "dsp " + (neutral && digital == 1 ? 0 : 1) + " " + (digital > 0 ? (20 * Math.Log10(digital)).ToString("0.##", inv) : "-inf") + " "
      + (double.IsNaN(dac) ? "-" : dac.ToString("0.##", inv)) + " " + (hwVol ? 1 : 0) + " " + boost.ToString("0.##", inv);
    if (line != lastDsp) { lastDsp = line; Say(line); }
  }
  static double Snap(double db) { return evInc > 0 ? Math.Min(Math.Min(evMax, 0), evMin + Math.Round((db - evMin) / evInc) * evInc) : db; }

  static void EnsureVolume() {
    if (evTried) return;
    evTried = true;
    try {
      object o; var iid = typeof(IAudioEndpointVolume).GUID;
      Find().Activate(ref iid, 23, IntPtr.Zero, out o);
      var e = (IAudioEndpointVolume)o;
      uint hw; e.QueryHardwareSupport(out hw);
      e.GetVolumeRange(out evMin, out evMax, out evInc);
      e.GetMasterVolumeLevel(out origDb);
      lock (VL) { ev = e; hwVol = (hw & 1) != 0; lastDac = origDb; }
      Console.Error.WriteLine("device volume " + origDb + " dB, range " + evMin + ".." + evMax + " step " + evInc + ", hardware " + ((hw & 1) != 0));
    } catch (Exception e) { Console.Error.WriteLine("no device volume: " + Describe(e)); }
  }
  // leave the DAC where the user had it before exclusive mode took it over
  static void RestoreVolume() {
    lock (VL) { try { if (ev != null && hwVol && !float.IsNaN(origDb)) ev.SetMasterVolumeLevel(origDb, ref evCtx); } catch { } ev = null; }
  }

  static IAudioClient Activate() {
    object o; var iid = typeof(IAudioClient).GUID;
    Find().Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o);
    return (IAudioClient)o;
  }

  static IMMDevice Find() {
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

  // ---------- --selftest: the DSP and output stage without a device (npm test) ----------
  static int SelfTest() {
    int fails = 0; const int fs = 96000;
    Action<bool, string> ok = (c, what) => { Console.WriteLine((c ? "ok   " : "FAIL ") + what); if (!c) fails++; };
    var rnd = new Random(7);
    Func<Dsp, double[], double[]> run = (d, src) => { var buf = (double[])src.Clone(); for (int at = 0; at < buf.Length / 2; at += 1000) { int n = Math.Min(1000, buf.Length / 2 - at); var sg = new double[2 * n]; Array.Copy(buf, 2 * at, sg, 0, 2 * n); d.Process(sg, n); Array.Copy(sg, 0, buf, 2 * at, 2 * n); } return buf; };

    // 1. neutral chain: 24-bit samples come out identical, only delayed by the limiter look-ahead; quantized bytes match
    var dsp = new Dsp(fs); dsp.Apply(DspConfig.Parse("pre 0;band peaking 131 0 0.97;bass 0 90;treble 0 9000;bal 0;width 1;mono 0;rev 0;lim 1"));
    int F = 20000; var x = new double[2 * F];
    for (int i = 0; i < x.Length; i++) x[i] = (rnd.Next(-8388608, 8388608) << 8) / 2147483648.0;
    var y = run(dsp, x); int D = dsp.Latency; bool exact = dsp.Neutral;
    for (int i = 2 * D; i < y.Length; i++) if (y[i] != x[i - 2 * D]) { exact = false; break; }
    ok(exact, "neutral chain is bit-exact (latency " + D + " frames)");
    outBytes = 3; valid = 24; var bytes = new byte[6 * F]; Quantize(x, F, bytes, false); bool same = true;
    for (int i = 0; i < 2 * F && same; i++) { int s32 = (int)Math.Round(x[i] * 2147483648.0); for (int b = 1; b < 4; b++) if (bytes[3 * i + b - 1] != (byte)(s32 >> (8 * b))) same = false; }
    ok(same, "24-bit quantize without dither returns the source bytes");

    // 2. a +6 dB peak at 1 kHz lifts a 1 kHz tone by 6 dB, leaves 100 Hz alone
    Func<double, string, double> gainAt = (f, cfgText) => {
      var d = new Dsp(fs); d.Apply(DspConfig.Parse(cfgText)); var t = new double[2 * fs];
      for (int i = 0; i < fs; i++) t[2 * i] = t[2 * i + 1] = 0.1 * Math.Sin(2 * Math.PI * f * i / fs);
      var o = run(d, t); double pk = 0; for (int i = fs; i < 2 * fs; i++) pk = Math.Max(pk, Math.Abs(o[i])); return 20 * Math.Log10(pk / 0.1);
    };
    double g1k = gainAt(1000, "band peaking 1000 6 1;lim 1"), g100 = gainAt(100, "band peaking 1000 6 1;lim 1");
    ok(Math.Abs(g1k - 6) < 0.05, "peak +6 dB at 1 kHz: " + g1k.ToString("0.000") + " dB");
    ok(Math.Abs(g100) < 0.1, "100 Hz untouched by the 1 kHz band: " + g100.ToString("0.000") + " dB");
    ok(Math.Abs(gainAt(1000, "pre -3;lim 1") + 3) < 0.01, "preamp -3 dB");

    // 3. limiter: +12 dB bass boost on a full-scale 60 Hz tone never passes -0.3 dBFS
    var dl = new Dsp(fs); dl.Apply(DspConfig.Parse("bass 12 120;lim 1")); var b2 = new double[4 * fs];
    for (int i = 0; i < 2 * fs; i++) b2[2 * i] = b2[2 * i + 1] = 0.99 * Math.Sin(2 * Math.PI * 60 * i / fs);
    var lo = run(dl, b2); double peak = 0; foreach (var v in lo) peak = Math.Max(peak, Math.Abs(v));
    ok(peak <= Math.Pow(10, -0.3 / 20) + 1e-9, "limiter ceiling holds: peak " + (20 * Math.Log10(peak)).ToString("0.00") + " dBFS");

    // 4. reverb: left-only impulse rings on the left, the right stays silent (stereo IR, no cross-talk); finite output
    var dr = new Dsp(fs); dr.Apply(DspConfig.Parse("rev 1 0.3 0.5 1 0.5 0 0 1;lim 0"));
    for (int w = 0; w < 400 && dr.Latency == dr.Latency && !RevReady(dr); w++) { dr.Process(new double[2000], 1000); Thread.Sleep(10); }
    var imp = new double[2 * 4 * fs]; imp[0] = 1; var ro = run(dr, imp); double el = 0, er = 0; bool finite = true;
    for (int i = 0; i < ro.Length; i += 2) { el += ro[i] * ro[i]; er += ro[i + 1] * ro[i + 1]; if (double.IsNaN(ro[i]) || double.IsInfinity(ro[i])) finite = false; }
    ok(RevReady(dr) && el > 1e-6 && er < el * 1e-20 && finite, "reverb rings on L only (L " + el.ToString("0.###e0") + ", R " + er.ToString("0.###e0") + ")");

    // 5. dithered output stays within 1 LSB of the exact value
    var z = new double[2000]; for (int i = 0; i < z.Length; i++) z[i] = rnd.NextDouble() * 1.6 - 0.8;
    var q1 = new byte[3 * 2000]; Quantize(z, 1000, q1, true); bool lsb = true;
    for (int i = 0; i < 2000; i++) { int v = (q1[3 * i] << 8 | q1[3 * i + 1] << 16 | q1[3 * i + 2] << 24) >> 8; if (Math.Abs(v - z[i] * 8388608) > 1.5) lsb = false; }
    ok(lsb, "TPDF dither within 1 LSB");

    // 6. headroom: +5.2 dB soft bass (Q 0.97 overshoots a little) with +5.1 preamp needs a bit over 10.3 dB
    var dh = new Dsp(fs); dh.Apply(DspConfig.Parse("pre 5.1;band lowshelf 131 5.2 0.97"));
    double hb = dh.BoostDb(); ok(hb > 10.3 && hb < 11, "boost estimate " + hb.ToString("0.00") + " dB");
    // 7. speed: 192 kHz, 10 bands + tone + limiter + the largest reverb must run well faster than real time
    {
      const int hr = 192000; var db = new Dsp(hr);
      var sb = new System.Text.StringBuilder("pre 2;bass 4 90;treble 3 9000;lim 1;rev 1 1 0.5 0.8 1 0.3 0.4 0.5");
      for (int k = 0; k < 10; k++) sb.Append(";band peaking " + (31 << k) + " 3 1.41");
      db.Apply(DspConfig.Parse(sb.ToString()));
      for (int w = 0; w < 2000 && db.Latency <= (int)Math.Round(hr * 0.005); w++) { db.Process(new double[2000], 1000); Thread.Sleep(5); }
      var blk = new double[2 * 4800]; var sw = Stopwatch.StartNew(); int secs = 5;
      for (int i = 0; i < secs * hr / 4800; i++) { for (int j = 0; j < blk.Length; j++) blk[j] = rnd.NextDouble() * 0.2 - 0.1; db.Process(blk, 4800); }
      double rt = secs / sw.Elapsed.TotalSeconds;
      ok(rt > 3 && db.Latency > (int)Math.Round(hr * 0.005), "worst case 192 kHz chain runs " + rt.ToString("0.0") + "x real time");
    }
    return fails;
  }
  static bool RevReady(Dsp d) { return d.Latency > (int)Math.Round(96000 * 0.005); }

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
