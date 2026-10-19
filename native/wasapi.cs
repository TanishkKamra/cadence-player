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
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime;
using System.Runtime.InteropServices;
using System.Threading;

static class Wasapi {
  class Fmt { public int Rate, Bits, Tag; }
  class Item { public byte[] Data; public int Off; public Fmt Fmt; public int Tag; } // Tag: track the item belongs to

  static readonly object L = new object();
  static readonly LinkedList<Item> q = new LinkedList<Item>();
  static LinkedList<Item> oldQ; // under L: the stream a seek replaced; its next 10 ms fade out
  static long queuedBytes;
  static volatile bool paused, flushReq, quit;
  static volatile float gain = 1f;
  static int epoch, inTag = -1; // inTag: track of the PCM currently arriving on stdin
  static string deviceName;
  static TextWriter stdout;
  static volatile bool failed;
  static readonly Dictionary<int, double> tagGain = new Dictionary<int, double>(); // under L
  static volatile DspConfig pendingCfg; static DspConfig cfg = new DspConfig();
  static float appliedVol = -1f;
  static Dsp dsp;
  static readonly Dictionary<int, int[]> pref = new Dictionary<int, int[]>(); // last working [container, valid] per source-depth class

  // the output device: WASAPI exclusive, or the self-test's fake one
  interface IOut { int Frames { get; } int Padding(); void Start(); void Stop(); void Reset(); void Write(byte[] b, int frames); void Release(); }
  sealed class WasOut : IOut {
    readonly IAudioClient c; readonly IAudioRenderClient rc; readonly int frames, fb;
    public WasOut(IAudioClient c, IAudioRenderClient rc, int frames, int fb) { this.c = c; this.rc = rc; this.frames = frames; this.fb = fb; }
    public int Frames { get { return frames; } }
    public int Padding() { uint p; c.GetCurrentPadding(out p); return (int)p; }
    public void Start() { c.Start(); }
    public void Stop() { c.Stop(); }
    public void Reset() { c.Reset(); }
    public void Write(byte[] b, int n) { IntPtr p; rc.GetBuffer((uint)n, out p); Marshal.Copy(b, 0, p, n * fb); rc.ReleaseBuffer((uint)n, 0); }
    public void Release() { Marshal.ReleaseComObject(rc); Marshal.ReleaseComObject(c); }
  }
  static Func<int, int, int, IOut> opener = Init; // (rate, container, valid bits) -> device, or null
  static readonly Stopwatch wall = Stopwatch.StartNew();
  static Func<long> Now = () => wall.ElapsedMilliseconds;

  // device session
  static IOut client; static Fmt cur;
  static int bufFrames, outBytes, valid, bufMs; static bool started;
  static long T, R, silDone, basePos, waitStart, lastReport; // T = frames handed to the device, R = real (non-silence) frames
  static readonly List<long[]> sil = new List<long[]>(); // silence runs [startT, len]: underruns, fades, pauses
  static byte[] scratch = new byte[0];
  // 10 ms linear fades. outG scales the DSP output: down for a pause and for the old stream after a seek, up on resume (the
  // DSP's delay line still holds the audio from before the pause, so nothing is skipped). inG scales a new stream's input
  // up from silence after a seek, a first open or a device reopen
  static double outG = 1, inG = 1; static int fadeLen = 480, oldLeft, oldN; static long quietFrames; static double[] oldBuf = new double[0];
  static long underruns; // the device ran dry: padding 0 while playing
  static Fmt lostFmt; static long lostAt, retryAt; const int LostMs = 5000; // endpoint vanished mid-stream: reopen when it returns
  static bool devVolume = true; // the self-test never touches a real device's volume

  [MTAThread]
  static void Main(string[] args) {
    if (args.Length > 0 && args[0] == "--selftest") { Environment.Exit(SelfTest()); }
    if (args.Length == 6 && args[0] == "--process") { Environment.Exit(Offline(args)); }
    GCSettings.LatencyMode = GCLatencyMode.SustainedLowLatency; // no blocking full collections while music plays
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
        else if (op == 'X') Seek(br.ReadInt32());
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

  // a new stream replaces the queue; the one playing is kept aside for its fade-out (the first one, if seeks pile up)
  static void Seek(int e) { lock (L) { if (!flushReq) oldQ = new LinkedList<Item>(q); q.Clear(); queuedBytes = 0; flushReq = true; epoch = e; } }

  static void Say(string s) { lock (stdout) stdout.WriteLine(s); }

  static void Render() {
    int task = 0;
    if (AvSetMmThreadCharacteristicsW("Pro Audio", ref task) == IntPtr.Zero) Console.Error.WriteLine("MMCSS Pro Audio unavailable (error " + Marshal.GetLastWin32Error() + "): render thread at Highest priority");
    while (!quit) {
      int ms;
      try { ms = Step(); } catch (Exception e) { ms = Lost(e); }
      if (ms > 0) Thread.Sleep(ms);
    }
  }

  // one turn of the render loop; returns the milliseconds to sleep
  static int Step() {
    Item head = null; bool flush; int ep; LinkedList<Item> old;
    lock (L) { flush = flushReq; flushReq = false; ep = epoch; old = oldQ; oldQ = null; if (q.Count > 0) head = q.First.Value; }
    if (flush) Flush(old);
    if (lostFmt != null) { Recover(); return 5; }
    if (head != null && head.Fmt != null && !(client != null && Same(head.Fmt))) {
      // new format (or first open): let the old one play out, then reopen the device
      if (client != null && Played() < R) { if (!paused || started) Pump(); return 5; }
      lock (L) { if (q.Count == 0 || q.First.Value != head) return 0; q.RemoveFirst(); }
      bool gapless = client != null; // the next track continues the program: no fade-in
      if (client != null) { basePos += Played(); Close(); }
      Open(head.Fmt, false, !gapless);
      waitStart = Now();
      return 0;
    }
    if (client == null) {
      // no device (open failed): drop data until the next marker
      if (head == null) return 5;
      lock (L) { if (q.Count > 0 && q.First.Value == head) { q.RemoveFirst(); if (head.Data != null) queuedBytes -= head.Data.Length - head.Off; } }
      return 0;
    }
    Settings();
    if (!paused || started) Pump();
    if (paused && started && outG == 0 && oldLeft == 0 && quietFrames >= bufFrames) { client.Stop(); started = false; } // only silence left in the buffer
    long now = Now();
    if (now - lastReport >= 50) { lastReport = now; Say("pos " + ep + " " + Math.Max(0, basePos + Played())); }
    return paused && !started ? 5 : Math.Max(2, bufMs / 4);
  }

  static void Flush(LinkedList<Item> old) {
    inG = 0; // the new stream starts from silence
    if (client != null && started && dsp != null) {
      // keep the device running: the old stream fades out over its next frames (from wherever a pause fade got to), then the
      // DSP starts over. Everything written so far still plays first, so none of it belongs to the new stream
      basePos = -R;
      oldN = oldLeft = (int)Math.Ceiling(outG * fadeLen - 1e-9);
      if (oldBuf.Length < 2 * oldN) oldBuf = new double[2 * oldN];
      Array.Clear(oldBuf, 0, 2 * oldN);
      int k = 0;
      if (old != null) foreach (var it in old) {
        if (k >= oldN) break;
        if (it.Fmt != null) { if (Same(it.Fmt)) continue; break; }
        int n = Math.Min(oldN - k, (it.Data.Length - it.Off) / 8);
        for (int i = 0, o = it.Off; i < 2 * n; i++, o += 4) oldBuf[2 * k + i] = BitConverter.ToInt32(it.Data, o) / 2147483648.0;
        k += n;
      }
      if (oldLeft == 0) dsp.Reset();
    } else {
      if (client != null) { client.Stop(); client.Reset(); }
      if (dsp != null) dsp.Reset();
      started = false; T = R = silDone = basePos = 0; sil.Clear(); oldLeft = 0; outG = 1;
    }
    waitStart = Now();
  }

  // the render loop threw. A vanished endpoint is waited for with the queue and the position kept; anything else is reported
  static int Lost(Exception e) {
    string why = Describe(e);
    if (why == "Output device disconnected" && cur != null && lostFmt == null && !failed) {
      lostFmt = cur; lostAt = Now(); retryAt = lostAt + 100;
      basePos += R; // what was consumed counts as played: the stream resumes where it was cut
      try { Close(); } catch { }
      if (devVolume) lock (VL) { ev = null; evTried = false; } // the volume control went with the endpoint
      Console.Error.WriteLine("device lost (" + why + "): waiting for it to return");
      return 5;
    }
    if (lostFmt != null) return 5; // still waiting
    if (!failed) Say("fail " + (cur != null ? cur.Tag : 0) + " " + why); // once per outage
    failed = true;
    try { Close(); } catch { }
    lock (L) { q.Clear(); queuedBytes = 0; }
    return 5;
  }
  static void Recover() {
    long now = Now();
    if (now < retryAt) return;
    retryAt = now + 250;
    Open(lostFmt, true, true);
    if (client != null) { Console.Error.WriteLine("device back after " + (now - lostAt) + " ms"); lostFmt = null; return; }
    if (now - lostAt < LostMs) return;
    var f = lostFmt; lostFmt = null; failed = true;
    Say("fail " + f.Tag + " Output device disconnected");
    lock (L) { q.Clear(); queuedBytes = 0; }
  }

  static bool Same(Fmt f) { return cur != null && f.Rate == cur.Rate && f.Bits == cur.Bits; }

  // real frames the device has played this session (excludes silence inserted on underruns, fades and pauses)
  static long Played() {
    long played = T - client.Padding() - (dsp != null ? dsp.Latency : 0); // the DSP delays the output by its latency
    if (played < 0) played = 0;
    while (sil.Count > 0 && sil[0][0] + sil[0][1] <= played) { silDone += sil[0][1]; sil.RemoveAt(0); }
    long part = sil.Count > 0 && sil[0][0] < played ? played - sil[0][0] : 0;
    return played - silDone - part;
  }
  static void AddSil(long at, long n) {
    var last = sil.Count > 0 ? sil[sil.Count - 1] : null;
    if (last != null && last[0] + last[1] == at) last[1] += n; else sil.Add(new long[] { at, n });
  }

  static double[] xbuf = new double[0], seg = new double[0];
  static int[] cAt = new int[16], cN = new int[16]; static double[] cG = new double[16]; // this pump's runs: start, frames, stream gain (-1 keeps it)
  static int Run(int nc, int at, int n, double g) {
    if (nc == cAt.Length) { Array.Resize(ref cAt, 2 * nc); Array.Resize(ref cN, 2 * nc); Array.Resize(ref cG, 2 * nc); }
    cAt[nc] = at; cN[nc] = n; cG[nc] = g; return nc + 1;
  }

  static void Pump() {
    int pad = client.Padding(), avail = bufFrames - pad, fb = 2 * outBytes, k = 0, nc = 0, live = avail;
    if (avail <= 0) { if (!started) { client.Start(); started = true; } return; }
    if (started && pad == 0) { underruns++; Say("xrun " + underruns); }
    if (scratch.Length < avail * fb) scratch = new byte[avail * fb];
    if (xbuf.Length < avail * 2) xbuf = new double[avail * 2];
    bool down = paused || oldLeft > 0, fromOld = oldLeft > 0; int faded = 0; // down: fading to silence. faded: frames a fade touched
    if (down) live = Math.Min(avail, (int)Math.Ceiling(outG * fadeLen - 1e-9));
    if (fromOld) {
      k = Math.Min(live, oldLeft);
      Array.Copy(oldBuf, 2 * (oldN - oldLeft), xbuf, 0, 2 * k);
      oldLeft -= k; nc = Run(nc, 0, k, -1);
    } else if (live > 0) {
      lock (L) {
        if (flushReq) return;
        // don't start on a half-empty buffer (decoder still spinning up) unless it is taking long
        if (!started && queuedBytes < avail * 8L && Now() - waitStart < 400) return;
        while (k < live && q.Count > 0) {
          Item it = q.First.Value;
          if (it.Fmt != null) { if (Same(it.Fmt)) { q.RemoveFirst(); continue; } break; } // gapless: same format just continues
          int n = Math.Min(live - k, (it.Data.Length - it.Off) / 8);
          double tg; if (!tagGain.TryGetValue(it.Tag, out tg)) tg = 1;
          nc = Run(nc, k, n, tg);
          for (int i = 0, o = it.Off, d = 2 * k; i < 2 * n; i++, o += 4, d++) xbuf[d] = BitConverter.ToInt32(it.Data, o) / 2147483648.0;
          k += n; it.Off += n * 8; queuedBytes -= n * 8;
          if (it.Off >= it.Data.Length) q.RemoveFirst();
        }
      }
      if (k == 0 && T == 0) return; // nothing to play yet
      for (int i = 0; i < k && inG < 1; i++) { inG = Math.Min(1, inG + 1.0 / fadeLen); xbuf[2 * i] *= inG; xbuf[2 * i + 1] *= inG; faded = i + 1; }
    }
    int real = fromOld ? 0 : k;
    if (k < live) { Array.Clear(xbuf, 2 * k, 2 * (live - k)); nc = Run(nc, k, live - k, -1); } // underrun / tail: silence, run through the DSP so delays and reverb play out
    bool exact = true;
    for (int c = 0; c < nc; c++) {
      int at = cAt[c], n = cN[c];
      if (cG[c] >= 0) dsp.StreamGain = cG[c];
      if (seg.Length < 2 * n) seg = new double[2 * n];
      Array.Copy(xbuf, 2 * at, seg, 0, 2 * n);
      dsp.Process(seg, n); exact &= dsp.Exact;
      Array.Copy(seg, 0, xbuf, 2 * at, 2 * n);
    }
    if (down || outG < 1) {
      double st = 1.0 / fadeLen;
      for (int i = 0; i < live; i++) { outG = down ? Math.Max(0, outG - st) : Math.Min(1, outG + st); xbuf[2 * i] *= outG; xbuf[2 * i + 1] *= outG; }
      if (down && outG < 0.5 * st) outG = 0;
      faded = live;
    }
    Array.Clear(xbuf, 2 * live, 2 * (avail - live)); // faded out: silence, the DSP waits
    if (fromOld && oldLeft == 0) { dsp.Reset(); if (!paused) outG = 1; } // the old stream is gone: start the new one clean
    quietFrames = outG == 0 ? quietFrames + avail - live : 0;
    Quantize(xbuf, avail, scratch, exact ? faded : avail); // a fade dithers only the frames it touched
    if (real < avail) AddSil(T + real, avail - real);
    T += avail; R += real; // before Write: if the device dies there, what was consumed still counts
    client.Write(scratch, avail);
    if (!started) { client.Start(); started = true; }
  }

  // double -> device container at its valid bits. Neutral DSP: exact (the samples came from these bits). Otherwise TPDF dither,
  // on the first `dither` frames
  static uint rng = 0x9E3779B9;
  static double Rand() { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng / 4294967296.0; }
  static void Quantize(double[] x, int frames, byte[] dst, int dither) {
    int skip = 4 - outBytes, d = 0;
    double scale = Math.Pow(2, valid - 1), hi = scale - 1;
    for (int i = 0; i < 2 * frames; i++) {
      double y = x[i] * scale;
      if (i < 2 * dither && valid < 32) y += Rand() - Rand();
      y = Math.Floor(y + 0.5);
      if (y > hi) y = hi; else if (y < -scale) y = -scale;
      int s32 = (int)((long)y << (32 - valid));
      for (int b = skip; b < 4; b++) dst[d++] = (byte)(s32 >> (8 * b));
    }
  }

  // quiet: a reopen attempt after the endpoint vanished (no report when it fails). fadeIn: the stream starts from silence
  static void Open(Fmt f, bool quiet = false, bool fadeIn = true) {
    // [container, valid] candidates that carry the source bits untouched
    int[][] cands = f.Bits > 24 ? new[] { new[] { 32, 32 } }
      : f.Bits > 16 ? new[] { new[] { 32, 24 }, new[] { 24, 24 }, new[] { 32, 32 } }
      : new[] { new[] { 32, 24 }, new[] { 24, 24 }, new[] { 32, 32 }, new[] { 16, 16 } }; // 16-bit sources ride in 24 bits: same samples, room for DSP
    if (!quiet) failed = false;
    int pk = f.Bits > 24 ? 2 : f.Bits > 16 ? 1 : 0; int[] lead;
    if (pref.TryGetValue(pk, out lead)) cands = new[] { lead }.Concat(cands.Where(x => x[0] != lead[0] || x[1] != lead[1])).ToArray(); // reopen tries the layout that worked last time first
    string err = "format not supported"; bool refused = true;
    foreach (var c in cands) {
      try {
        var o = opener(f.Rate, c[0], c[1]);
        if (o != null) {
          client = o; bufFrames = o.Frames; bufMs = (int)(1000L * bufFrames / f.Rate);
          started = false; T = R = silDone = 0; sil.Clear();
          cur = f; outBytes = c[0] / 8; valid = c[1]; pref[pk] = c;
          fadeLen = Math.Max(1, (int)Math.Round(f.Rate * 0.01)); inG = fadeIn ? 0 : 1; outG = 1; oldLeft = 0; quietFrames = 0;
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
    if (!quiet) Say((refused ? "refuse " : "fail ") + f.Tag + " " + err + " (" + f.Rate + " Hz, " + f.Bits + "-bit)");
  }

  static IOut Init(int rate, int container, int valid) {
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
      return new WasOut(c, (IAudioRenderClient)o, (int)frames, 2 * container / 8);
    }
    return null;
  }

  static void Close() {
    if (client == null) return;
    try { client.Stop(); } catch { }
    try { client.Release(); } catch { }
    client = null; cur = null; started = false; T = R = silDone = 0; sil.Clear();
  }

  // ---------- settings: DSP config, and the volume carried by the DAC's own hardware volume ----------
  // Like direct volume control: the samples stay at full resolution and the DAC sets the level. EQ boosts are made
  // room for digitally (-boost dB) and the DAC is turned up by the same amount, so the level of everything else stays put.
  static IAudioEndpointVolume ev; static bool hwVol, evTried; static float evMin, evMax, evInc, origDb = float.NaN, lastDac = float.NaN;
  static double pendDb = double.NaN, digital = 1; static long pendAt, lastPoll; static string lastDsp = "";
  static readonly object VL = new object(); static Guid evCtx = Guid.Empty;

  static void Settings() {
    var c = pendingCfg;
    bool changed = false;
    if (c != null) { pendingCfg = null; cfg = c; if (dsp != null) dsp.Apply(c); changed = true; }
    float g = gain;
    if (changed || g != appliedVol) { appliedVol = g; Level(g); }
    long now = Now();
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
        Level(total); // same DAC step, refreshes the reported state
      }
    }
  }

  static void Level(double g) {
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
        int pad = started ? client.Padding() : 0;
        pendDb = dac; pendAt = Now() + (started ? (long)(1000.0 * (pad + dsp.Latency) / cur.Rate) : 0);
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
    if (evTried || !devVolume) return;
    evTried = true;
    try {
      object o; var iid = typeof(IAudioEndpointVolume).GUID;
      Find().Activate(ref iid, 23, IntPtr.Zero, out o);
      var e = (IAudioEndpointVolume)o;
      uint hw; e.QueryHardwareSupport(out hw);
      e.GetVolumeRange(out evMin, out evMax, out evInc);
      float lv; e.GetMasterVolumeLevel(out lv);
      if (float.IsNaN(origDb)) origDb = lv; // a reopened endpoint keeps the level the user had before exclusive mode
      lock (VL) { ev = e; hwVol = (hw & 1) != 0; lastDac = lv; }
      Console.Error.WriteLine("device volume " + lv + " dB, range " + evMin + ".." + evMax + " step " + evInc + ", hardware " + ((hw & 1) != 0));
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

    // 1. neutral chain at each common rate: 24-bit samples come out identical, only delayed by the look-ahead; quantized bytes match (G1.1)
    int F = 20000; var x = new double[2 * F];
    for (int i = 0; i < x.Length; i++) x[i] = (rnd.Next(-8388608, 8388608) << 8) / 2147483648.0;
    foreach (int r in new[] { 44100, 48000, 96000 }) {
      var dsp = new Dsp(r); dsp.Apply(DspConfig.Parse("pre 0;band peaking 131 0 0.97;bass 0 90;treble 0 9000;bal 0;width 1;mono 0;rev 0;lim 1"));
      var y = run(dsp, x); int D = dsp.Latency; bool exact = dsp.Neutral && dsp.Exact;
      for (int i = 2 * D; i < y.Length; i++) if (y[i] != x[i - 2 * D]) { exact = false; break; }
      ok(exact, "neutral chain is bit-exact at " + r + " Hz (latency " + D + " frames)");
    }
    outBytes = 3; valid = 24; var bytes = new byte[6 * F]; Quantize(x, F, bytes, 0); bool same = true;
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

    // 3. true peak (G2.1): the output never passes the ceiling, by the ITU BS.1770-4 meter or a fine reference meter
    foreach (int r in new[] { 44100, 48000 }) {
      int n = 2 * r;
      var quarter = new double[2 * n]; var white = new double[2 * n]; var bass = new double[2 * n]; var hf = new double[2 * n]; var sq = new double[2 * n];
      for (int i = 0; i < n; i++) quarter[2 * i] = quarter[2 * i + 1] = Math.Max(-0.99, Math.Min(0.99, 0.99 * Math.Sqrt(2) * Math.Sin(Math.PI / 2 * i + Math.PI / 4)));
      for (int i = 0; i < 2 * n; i++) white[i] = rnd.NextDouble() - 0.5;
      for (int i = 0; i < n; i++) bass[2 * i] = bass[2 * i + 1] = 0.99 * Math.Sin(2 * Math.PI * 60 * i / r);
      for (int i = 0; i < n; i++) { hf[2 * i] = 0.99 * Math.Sin(2 * Math.PI * 20000 * i / r + 0.3); hf[2 * i + 1] = 0.99 * Math.Sin(2 * Math.PI * 20000 * i / r + 1.1); }
      for (int i = 0; i < n; i++) sq[2 * i] = sq[2 * i + 1] = (i / 24) % 2 == 0 ? 0.99 : -0.99;
      var cases = new[] {
        new { s = quarter, cfg = "pre 0.01", name = "fs/4 at 45 deg, samples 0.99" }, new { s = hf, cfg = "pre 0.01", name = "20 kHz 0.99" },
        new { s = sq, cfg = "pre 0.01", name = "square 0.99" }, new { s = bass, cfg = "bass 12 120", name = "60 Hz 0.99, bass +12" },
        new { s = white, cfg = "pre 6", name = "white noise +6" }, new { s = white, cfg = "pre 6;treble 6 6000", name = "white noise +6, treble +6" },
        new { s = white, cfg = "bass 12 120;band peaking 3000 9 0.7", name = "white noise, bass +12, 3 kHz +9" } };
      foreach (var c in cases)
        foreach (string ceil in new[] { "-1", "-0.3" }) {
          var d = new Dsp(r); d.Apply(DspConfig.Parse(c.cfg + ";lim 1;ceil " + ceil)); var o = run(d, c.s);
          double itu, refp, cl = double.Parse(ceil, CultureInfo.InvariantCulture); TruePeak(o, r / 2, out itu, out refp);
          ok(itu <= cl + 1e-6 && refp <= cl + 0.05 && d.Lim.Clamps == 0, "true peak at " + r + " Hz, " + c.name + ", ceiling " + ceil + ": ITU " + itu.ToString("0.00") + " / reference " + refp.ToString("0.00") + " dBTP");
        }
    }
    // headroom first (G2.2): at 50% volume a +6 dB boost fits under the ceiling and is never limited
    {
      const int r = 48000; var t = new double[4 * r]; for (int i = 0; i < 2 * r; i++) t[2 * i] = t[2 * i + 1] = 0.88 * Math.Sin(2 * Math.PI * 1000 * i / r);
      var d = new Dsp(r); d.Apply(DspConfig.Parse("band peaking 1000 6 1;lim 1")); d.Volume = 0.5; run(d, t);
      ok(d.Lim.Limited == 0, "50% volume + 6 dB boost: no sample limited (" + d.Lim.Limited + ")");
    }
    // no pumping (G2.3) and separation (G3.1, G3.2): a hot tone under a big boost is limited steadily; a tone in another band is untouched
    {
      const int r = 48000; int n = 3 * r; var t = new double[2 * n];
      for (int i = 0; i < n; i++) t[2 * i] = t[2 * i + 1] = 0.5 * Math.Sin(2 * Math.PI * 60 * i / r) + 0.1 * Math.Sin(2 * Math.PI * 3000 * i / r);
      var d = new Dsp(r); d.Apply(DspConfig.Parse("bass 12 120;lim 1")); var o = run(d, t);
      double lo = 9, hi = -9, vlo = 9, vhi = -9;
      for (int s0 = r; s0 + 4800 <= n; s0 += 4800) { // 4800 frames hold whole periods of both tones: no leakage between them
        double b = 20 * Math.Log10(Amp(o, 60, r, s0, s0 + 4800)), v = 20 * Math.Log10(Amp(o, 3000, r, s0, s0 + 4800) / 0.1);
        lo = Math.Min(lo, b); hi = Math.Max(hi, b); vlo = Math.Min(vlo, v); vhi = Math.Max(vhi, v);
      }
      ok(d.Lim.Limited > 0 && hi - lo < 0.1, "no pumping: limited 60 Hz level moves " + (hi - lo).ToString("0.000") + " dB");
      ok(vlo > -0.1 && vhi < 0.1, "bass +12 dB leaves 3 kHz at " + vlo.ToString("0.000") + ".." + vhi.ToString("0.000") + " dB");
      for (int i = 0; i < n; i++) t[2 * i] = t[2 * i + 1] = 0.1 * Math.Sin(2 * Math.PI * 60 * i / r) + 0.5 * Math.Sin(2 * Math.PI * 10000 * i / r);
      d = new Dsp(r); d.Apply(DspConfig.Parse("treble 12 6000;lim 1")); o = run(d, t); vlo = 9; vhi = -9;
      for (int s0 = r; s0 + 4800 <= n; s0 += 4800) { double v = 20 * Math.Log10(Amp(o, 60, r, s0, s0 + 4800) / 0.1); vlo = Math.Min(vlo, v); vhi = Math.Max(vhi, v); }
      ok(d.Lim.Limited > 0 && vlo > -0.1 && vhi < 0.1, "treble +12 dB leaves 60 Hz at " + vlo.ToString("0.000") + ".." + vhi.ToString("0.000") + " dB");
    }
    // THD+N (G1.3): -0.5 dBFS 1 kHz through the processing path
    {
      const int r = 48000; var t = new double[4 * r]; for (int i = 0; i < 2 * r; i++) t[2 * i] = t[2 * i + 1] = Math.Pow(10, -0.5 / 20) * Math.Sin(2 * Math.PI * 1000 * i / r);
      var d = new Dsp(r); d.Apply(DspConfig.Parse("pre 0.0001;lim 1")); var o = run(d, t);
      double sn = 0, cs = 0; int a0 = r / 2, a1 = a0 + r;
      for (int i = a0; i < a1; i++) { double w = 2 * Math.PI * 1000 * i / r; sn += o[2 * i] * Math.Sin(w); cs += o[2 * i] * Math.Cos(w); }
      sn *= 2.0 / r; cs *= 2.0 / r; double res = 0, pw = 0;
      for (int i = a0; i < a1; i++) { double w = 2 * Math.PI * 1000 * i / r, fit = sn * Math.Sin(w) + cs * Math.Cos(w); res += (o[2 * i] - fit) * (o[2 * i] - fit); pw += fit * fit; }
      double thd = 10 * Math.Log10(res / pw); ok(thd < -120, "THD+N at -0.5 dBFS: " + thd.ToString("0.0") + " dB");
    }
    // toggles (G1.4, G1.2): a stage switched on mid-stream adds no click; switched off, the output is bit-exact again
    {
      const int r = 48000; int n = 2 * r; var t = new double[2 * n]; for (int i = 0; i < n; i++) t[2 * i] = t[2 * i + 1] = 0.3 * Math.Sin(2 * Math.PI * 997 * i / r);
      var d = new Dsp(r); d.Apply(DspConfig.Parse("lim 1")); var o = (double[])t.Clone();
      for (int at = 0; at < n; at += 1000) { if (at == r) d.Apply(DspConfig.Parse("bass 3 90;lim 1")); var sg = new double[2000]; Array.Copy(o, 2 * at, sg, 0, 2000); d.Process(sg, 1000); Array.Copy(sg, 0, o, 2 * at, 2000); }
      double clean = 0.3 * Math.Pow(2 * Math.PI * 997 / r, 2), dd = 0;
      for (int i = 2000; i < n; i++) dd = Math.Max(dd, Math.Abs(o[2 * i] - 2 * o[2 * i - 2] + o[2 * i - 4]));
      ok(dd / clean <= 1.5, "bass on mid-stream: worst step " + (dd / clean).ToString("0.00") + "x a clean sine's");
      var nz = new double[2 * 3 * r]; for (int i = 0; i < nz.Length; i++) nz[i] = (rnd.Next(-2097152, 2097152) << 8) / 2147483648.0;
      foreach (var st in new[] { "pre 2", "pre -2", "band peaking 1000 3 1", "band peaking 1000 -3 1", "bass 3 90", "treble -3 9000", "bal 0.3", "width 1.5", "mono 1" }) {
        d = new Dsp(r); d.Apply(DspConfig.Parse(st + ";lim 1")); o = (double[])nz.Clone(); bool back = true;
        for (int at = 0; at < 3 * r; at += 1000) { if (at == r / 2) d.Apply(DspConfig.Parse("lim 1")); var sg = new double[2000]; Array.Copy(o, 2 * at, sg, 0, 2000); d.Process(sg, 1000); Array.Copy(sg, 0, o, 2 * at, 2000); if (at >= 2 * r && !d.Exact) back = false; }
        int D = d.Latency; for (int i = 2 * 2 * r; i < o.Length && back; i++) if (o[i] != nz[i - 2 * D]) back = false;
        ok(back, "'" + st + "' switched off: bit-exact again");
      }
    }
    // robustness (G5.1, G5.2): NaN/Inf in gives finite output that recovers; denormal and silent tails cost no extra time
    {
      const int r = 48000; int n = 2 * r; var t = new double[2 * n]; for (int i = 0; i < 2 * n; i++) t[i] = rnd.NextDouble() * 0.6 - 0.3;
      t[20000] = double.NaN; t[20001] = double.PositiveInfinity; t[30000] = double.NegativeInfinity;
      var d = new Dsp(r); d.Apply(DspConfig.Parse("bass 6 90;band peaking 1000 3 1;lim 1")); var o = run(d, t); bool fin = true; double tail = 0;
      foreach (var v in o) if (double.IsNaN(v) || double.IsInfinity(v)) fin = false;
      for (int i = o.Length - 2000; i < o.Length; i++) tail = Math.Max(tail, Math.Abs(o[i]));
      ok(fin && tail > 0.05 && d.Sanitized == 3, "NaN/Inf input: output finite and recovers (" + d.Sanitized + " samples replaced)");
      Func<Dsp> mk = () => { var q = new Dsp(r); q.Apply(DspConfig.Parse("bass 6 90;treble 4 9000;band peaking 1000 3 1;band peaking 60 6 2;lim 1")); return q; };
      var busy = mk(); var sil = mk(); run(busy, t); run(sil, t);
      var blk = new double[2000]; var tiny = new double[2000]; for (int i = 0; i < 2000; i++) tiny[i] = 1e-310;
      var sw = Stopwatch.StartNew(); for (int i = 0; i < 480; i++) { for (int j = 0; j < 2000; j++) blk[j] = rnd.NextDouble() * 0.2 - 0.1; busy.Process(blk, 1000); }
      double tb = sw.Elapsed.TotalSeconds; sw.Restart();
      for (int i = 0; i < 480; i++) { if (i % 2 == 0) Array.Copy(tiny, blk, 2000); else Array.Clear(blk, 0, 2000); sil.Process(blk, 1000); }
      double ts = sw.Elapsed.TotalSeconds;
      ok(ts < 2 * tb + 0.01, "denormal and silent tails take " + (ts / tb).ToString("0.00") + "x the time of music");
    }

    // 4. reverb: left-only impulse rings on the left, the right stays silent (stereo IR, no cross-talk); finite output
    var dr = new Dsp(fs); dr.Apply(DspConfig.Parse("rev 1 0.3 0.5 1 0.5 0 0 1;lim 0"));
    for (int w = 0; w < 400 && dr.Latency == dr.Latency && !RevReady(dr); w++) { dr.Process(new double[2000], 1000); Thread.Sleep(10); }
    var imp = new double[2 * 4 * fs]; imp[0] = 1; var ro = run(dr, imp); double el = 0, er = 0; bool finite = true;
    for (int i = 0; i < ro.Length; i += 2) { el += ro[i] * ro[i]; er += ro[i + 1] * ro[i + 1]; if (double.IsNaN(ro[i]) || double.IsInfinity(ro[i])) finite = false; }
    ok(RevReady(dr) && el > 1e-6 && er < el * 1e-20 && finite, "reverb rings on L only (L " + el.ToString("0.###e0") + ", R " + er.ToString("0.###e0") + ")");

    // 5. dithered output stays within 1 LSB of the exact value
    var z = new double[2000]; for (int i = 0; i < z.Length; i++) z[i] = rnd.NextDouble() * 1.6 - 0.8;
    var q1 = new byte[3 * 2000]; Quantize(z, 1000, q1, 1000); bool lsb = true;
    for (int i = 0; i < 2000; i++) { int v = (q1[3 * i] << 8 | q1[3 * i + 1] << 16 | q1[3 * i + 2] << 24) >> 8; if (Math.Abs(v - z[i] * 8388608) > 1.5) lsb = false; }
    ok(lsb, "TPDF dither within 1 LSB");

    // 6. headroom: +5.2 dB soft bass (Q 0.97 overshoots a little) with +5.1 preamp needs a bit over 10.3 dB
    var dh = new Dsp(fs); dh.Apply(DspConfig.Parse("pre 5.1;band lowshelf 131 5.2 0.97"));
    double hb = dh.BoostDb(); ok(hb > 10.3 && hb < 11, "boost estimate " + hb.ToString("0.00") + " dB");
    // 7. speed: 192 kHz, 10 bands + tone + limiter + the largest reverb must run well faster than real time
    {
      const int hr = 192000; var db = new Dsp(hr);
      var sb = new System.Text.StringBuilder("pre 2;bass 4 90;treble 3 9000;lim 1;xfeed 1 700 4.5;spk 1;rev 1 1 0.5 0.8 1 0.3 0.4 0.5");
      for (int k = 0; k < 10; k++) sb.Append(";band peaking " + (31 << k) + " 3 1.41");
      db.Apply(DspConfig.Parse(sb.ToString()));
      for (int w = 0; w < 2000 && !(db.ReverbReady && db.SpeakersReady); w++) { db.Process(new double[2000], 1000); Thread.Sleep(5); }
      var blk = new double[2 * 4800]; var sw = Stopwatch.StartNew(); int secs = 5;
      for (int i = 0; i < secs * hr / 4800; i++) { for (int j = 0; j < blk.Length; j++) blk[j] = rnd.NextDouble() * 0.2 - 0.1; db.Process(blk, 4800); }
      double rt = secs / sw.Elapsed.TotalSeconds;
      ok(rt > 3 && db.ReverbReady && db.SpeakersReady, "worst case 192 kHz chain (10 bands, tone, crossfeed, reverb, speakers, limiter) runs " + rt.ToString("0.0") + "x real time");
    }
    // G4.1 crossfeed: the mono sum is untouched; a hard-left bass reaches the right ear 4.5 dB down, a hard-left 10 kHz hardly
    {
      const int r = 48000; int n = r; var xs = new double[2 * n];
      for (int i = 0; i < 2 * n; i++) xs[i] = rnd.NextDouble() * 0.6 - 0.3;
      var d = new Dsp(r); d.Apply(DspConfig.Parse("xfeed 1 700 4.5;lim 0")); var o = run(d, xs); int lat = d.Latency; double dm = 0;
      for (int i = 0; i + lat < n; i++) dm = Math.Max(dm, Math.Abs(o[2 * (i + lat)] + o[2 * (i + lat) + 1] - xs[2 * i] - xs[2 * i + 1]));
      Func<double, double> ild = f => {
        var t = new double[2 * n]; for (int i = 0; i < n; i++) t[2 * i] = 0.5 * Math.Sin(2 * Math.PI * f * i / r);
        var dd = new Dsp(r); dd.Apply(DspConfig.Parse("xfeed 1 700 4.5;lim 0")); var y = run(dd, t); var yr = new double[2 * n];
        for (int i = 0; i < n; i++) yr[2 * i] = y[2 * i + 1];
        return 20 * Math.Log10(Amp(y, f, r, n / 2, n) / Amp(yr, f, r, n / 2, n));
      };
      double lo = ild(100), hi = ild(10000);
      ok(dm < 1e-12 && Math.Abs(lo - 4.5) < 0.3 && hi > 20, "crossfeed: mono sum moves " + dm.ToString("0.0e0") + ", hard-left 100 Hz reaches the right " + lo.ToString("0.00") + " dB down, 10 kHz " + hi.ToString("0.0") + " dB down");
    }
    // G4.2 virtual speakers: loudness and 1/3-octave spectrum vs dry for pink noise, independent left and right. Measured from the
    // running DSP's own impulse responses (a noise measurement of the same thing needs minutes to settle to 0.1 dB in the low bands)
    foreach (int sr in new[] { 44100, 48000, 96000, 192000 }) {
      var d = new Dsp(sr); d.Apply(DspConfig.Parse("spk 1;lim 0"));
      for (int w = 0; w < 2000 && !d.SpeakersReady; w++) { d.Process(new double[0], 0); Thread.Sleep(5); }
      int lat = d.Latency, M = 1 << 15; while (M < lat + sr * 0.6) M <<= 1;
      var pw = new double[M / 2]; // per-ear power for uncorrelated left and right, averaged over both ears
      for (int ch = 0; ch < 2; ch++) {
        d.Reset(); var dirac = new double[2 * M]; dirac[ch] = 1; var y = run(d, dirac);
        for (int ear = 0; ear < 2; ear++) {
          var re = new double[M]; var im = new double[M]; for (int i = 0; i < M; i++) re[i] = y[2 * i + ear];
          new Fft(M).Run(re, im, false);
          for (int k = 1; k < M / 2; k++) pw[k] += (re[k] * re[k] + im[k] * im[k]) / 2;
        }
      }
      double worst = 0, ln = 0, ldn = 0; int nb = 0;
      for (int bi = -16; bi <= 13; bi++) {
        double fc = 1000 * Math.Pow(2, bi / 3.0), lo = fc * Math.Pow(2, -1 / 6.0), hi = fc * Math.Pow(2, 1 / 6.0), sn = 0, sd = 0;
        if (hi > sr * 0.45) break;
        for (int k = (int)Math.Ceiling(lo * M / sr); k < hi * M / sr; k++) { double f = (double)k * sr / M; sn += pw[k] / f; sd += 1 / f; }
        worst = Math.Max(worst, Math.Abs(10 * Math.Log10(sn / sd))); nb++;
      }
      for (int k = (int)Math.Ceiling(20.0 * M / sr); k <= 20000.0 * M / sr && k < M / 2; k++) { double f = (double)k * sr / M; ln += pw[k] / f; ldn += 1 / f; }
      double loud = 10 * Math.Log10(ln / ldn);
      ok(d.SpeakersReady && worst <= 0.5 && Math.Abs(loud) <= 0.5, "virtual speakers at " + sr + " Hz: pink-noise loudness " + loud.ToString("+0.00;-0.00") + " dB, " + nb
        + " 1/3-octave bands from 25 Hz within " + worst.ToString("0.00") + " dB, latency " + lat + " frames");
    }
    if (Environment.GetEnvironmentVariable("CADENCE_QUICK") == null) DeviceTests(ok);
    return fails;
  }
  // ---------- the render loop against a fake device (G5.4-G5.7) ----------
  sealed class FakeOut : IOut {
    readonly int rate, buf; public readonly List<double> Log; // what the DAC played, interleaved (null: not kept)
    public long Written, Consumed, Starved; public bool Dead, Running;
    public double MaxJump; // largest step into or out of silence when the device stops or starts
    long t0, c0; bool cut;
    public FakeOut(int rate, int buf, bool log) { this.rate = rate; this.buf = buf; Log = log ? new List<double>() : null; }
    public int Frames { get { return buf; } }
    void Tick() {
      if (Dead) { if (!cut) { cut = true; Trunc(); } throw new COMException("device invalidated", unchecked((int)0x88890004)); }
      if (!Running) return;
      long c = c0 + (Now() - t0) * rate / 1000;
      if (c > Written) { Starved += c - Written; c0 = c = Written; t0 = Now(); }
      Consumed = c;
    }
    double At(long frame) { return Log == null || frame < 0 || frame >= Written ? 0 : Math.Max(Math.Abs(Log[(int)(2 * frame)]), Math.Abs(Log[(int)(2 * frame + 1)])); }
    void Trunc() { if (Log != null) Log.RemoveRange((int)(2 * Consumed), Log.Count - (int)(2 * Consumed)); Written = Consumed; } // unplayed data is gone
    public int Padding() { Tick(); return (int)(Written - Consumed); }
    public void Start() { Tick(); if (!Running) { MaxJump = Math.Max(MaxJump, At(Consumed)); Running = true; t0 = Now(); c0 = Consumed; } }
    public void Stop() { Tick(); if (Running) { MaxJump = Math.Max(MaxJump, At(Consumed - 1)); Running = false; } }
    public void Reset() { Tick(); Trunc(); }
    public void Write(byte[] b, int n) {
      Tick();
      if (Written + n > Consumed + buf) throw new InvalidOperationException("fake device: buffer overrun");
      if (Log != null) for (int i = 0; i < 2 * n; i++) Log.Add(BitConverter.ToInt32(b, 4 * i) / 2147483648.0);
      Written += n;
    }
    public void Release() { }
  }
  static long vt; static readonly List<FakeOut> fakes = new List<FakeOut>(); static bool gone, keepLog = true; static volatile bool stressStop; static double sink;
  static void Fresh(string cfgText) {
    lock (L) { q.Clear(); queuedBytes = 0; oldQ = null; flushReq = false; tagGain.Clear(); }
    paused = false; epoch = 0; gain = 1f; appliedVol = -1f; failed = false; lostFmt = null; client = null; cur = null; dsp = null;
    T = R = silDone = basePos = lastReport = underruns = 0; sil.Clear(); started = false; inG = outG = 1; oldLeft = 0;
    pendingCfg = null; cfg = DspConfig.Parse(cfgText); devVolume = false; evTried = true; pref.Clear(); fakes.Clear(); gone = false; vt = 0;
    stdout = new StringWriter(); Now = () => vt;
    opener = (r, c, v) => {
      if (gone) throw new InvalidOperationException("Output device not found: fake");
      if (c != 32) return null;
      var f = new FakeOut(r, r / 10, keepLog); fakes.Add(f); return f;
    };
  }
  static void FeedFmt(int rate, int tag) { lock (L) { q.AddLast(new Item { Fmt = new Fmt { Rate = rate, Bits = 24, Tag = tag }, Tag = tag }); inTag = tag; } }
  static byte[] Pcm(double[] x) { var d = new byte[4 * x.Length]; for (int i = 0; i < x.Length; i++) BitConverter.GetBytes((int)Math.Round(x[i] * 8388608) << 8).CopyTo(d, 4 * i); return d; }
  static void FeedPcm(double[] x) { var d = Pcm(x); lock (L) { q.AddLast(new Item { Data = d, Tag = inTag }); queuedBytes += d.Length; } }
  static double[] Tone(int rate, double secs, Func<double, double> f) { int n = (int)(rate * secs); var x = new double[2 * n]; for (int i = 0; i < n; i++) x[2 * i] = x[2 * i + 1] = Math.Round(f((double)i / rate) * 8388608) / 8388608; return x; }
  // the render loop on virtual time up to `end` ms; at(ms) runs the scripted events
  static void RunTo(long end, Action<long> at) {
    long next = 0;
    for (; vt <= end; vt++) {
      if (at != null) at(vt);
      for (int guard = 0; vt >= next && guard < 1000; guard++) { int ms; try { ms = Step(); } catch (Exception e) { ms = Lost(e); } next = vt + ms; }
    }
  }
  static List<long>[] Positions() {
    var p = new List<long>[8]; for (int i = 0; i < 8; i++) p[i] = new List<long>();
    foreach (var ln in stdout.ToString().Split('\n')) { var w = ln.Trim().Split(' '); if (w.Length == 3 && w[0] == "pos") p[int.Parse(w[1]) & 7].Add(long.Parse(w[2])); }
    return p;
  }
  static bool Rising(List<long> p) { for (int i = 1; i < p.Count; i++) if (p[i] < p[i - 1]) return false; return true; }

  static void DeviceTests(Action<bool, string> ok) {
    var inv = CultureInfo.InvariantCulture;
    // G5.5: pause, resume, resume inside the pause fade, seek while playing and while paused: the DAC never sees a step
    // larger than the signal's own slope plus one fade step, and never jumps into or out of silence
    foreach (var cfgText in new[] { "", "bass 6 90;lim 1" }) {
      Fresh(cfgText); const int r = 48000; bool stopped = false;
      FeedFmt(r, 1); FeedPcm(Tone(r, 3, t => 0.5 * Math.Sin(2 * Math.PI * 1000 * t)));
      RunTo(3300, t => {
        if (t == 500 || t == 1700 || t == 2100) paused = true;
        if (t == 800 || t == 1705 || t == 2400) paused = false;
        if (t == 1200) { Seek(1); FeedFmt(r, 2); FeedPcm(Tone(r, 2, x => 0.5 * Math.Sin(2 * Math.PI * 1000 * x + 1.3))); }
        if (t == 2300) { stopped = !fakes[0].Running; Seek(2); FeedFmt(r, 3); FeedPcm(Tone(r, 1, x => 0.5 * Math.Sin(2 * Math.PI * 1000 * x + 2.1))); }
      });
      var f = fakes[0]; double a = 0, step = 0;
      for (int i = 0; i < f.Log.Count; i++) a = Math.Max(a, Math.Abs(f.Log[i]));
      for (int i = 2; i < f.Log.Count; i++) step = Math.Max(step, Math.Abs(f.Log[i] - f.Log[i - 2]));
      double fstep = a / 480, bound = a * 2 * Math.PI * 1000 / r + fstep + 1e-5;
      var pos = Positions();
      ok(fakes.Count == 1 && stopped && step <= bound && f.MaxJump <= fstep + 1e-5 && Rising(pos[0]) && Rising(pos[1]) && Rising(pos[2]) && f.Starved == 0,
        "pause/resume/seek fades (" + (cfgText == "" ? "neutral" : cfgText) + "): largest step " + step.ToString("0.0000", inv) + " (bound " + bound.ToString("0.0000", inv)
        + "), into/out of silence " + f.MaxJump.ToString("0.00000", inv) + ", device stopped while paused " + stopped);
    }
    // G5.6: 44.1 -> 96 -> 44.1 kHz: each rate's samples reach the DAC complete and bit-exact, the position runs on
    {
      Fresh(""); int[] rates = { 44100, 96000, 44100 }; var src = new double[3][];
      for (int j = 0; j < 3; j++) { int rr = rates[j]; src[j] = Tone(rr, 0.3, t => 0.25 + 0.2 * Math.Sin(2 * Math.PI * 441 * t)); FeedFmt(rr, j + 1); FeedPcm(src[j]); }
      RunTo(2500, null);
      bool exact = fakes.Count == 3;
      for (int j = 0; exact && j < 3; j++) {
        var lg = fakes[j].Log; int off = 0, n = src[j].Length / 2, skip = j == 0 ? 441 : 0; // the first track fades in over 10 ms
        while (2 * off < lg.Count && Math.Abs(lg[2 * off]) < 1e-4) off++; // above the fade-in dither
        if (lg.Count < 2 * (off + n)) { exact = false; break; }
        for (int i = 2 * skip; i < 2 * n; i++) if (lg[2 * off + i] != src[j][i]) { exact = false; break; }
      }
      var pos = Positions()[0]; long total = src.Sum(x => x.Length / 2);
      ok(exact && Rising(pos) && pos.Count > 0 && pos[pos.Count - 1] == total, "rate switch 44.1 -> 96 -> 44.1 kHz: every sample bit-exact, none cut, position " + (pos.Count > 0 ? pos[pos.Count - 1] : -1) + " of " + total);
    }
    // G5.7: the endpoint vanishes mid-stream and returns 1 s later: reopened, playing on, position kept. Gone for good: reported
    {
      Fresh(""); const int r = 48000; long back = -1;
      FeedFmt(r, 1); FeedPcm(Tone(r, 2, t => 0.5 * Math.Sin(2 * Math.PI * 1000 * t)));
      RunTo(4000, t => { if (t == 500) { fakes[0].Dead = true; gone = true; } if (t == 1500) gone = false; if (back < 0 && fakes.Count == 2) back = t; });
      var pos = Positions()[0]; string said = stdout.ToString();
      ok(fakes.Count == 2 && !said.Contains("fail") && Rising(pos) && pos[pos.Count - 1] == 2 * r && fakes[1].MaxJump <= 0.5 / 480 + 1e-5,
        "device lost at 0.5 s, back at 1.5 s: reopened at " + (back / 1000.0).ToString("0.00", inv) + " s, position " + pos[pos.Count - 1] + " of " + 2 * r + ", fades back in");
      Fresh(""); long failAt = -1;
      FeedFmt(r, 1); FeedPcm(Tone(r, 10, t => 0.5 * Math.Sin(2 * Math.PI * 1000 * t)));
      RunTo(7000, t => { if (t == 500) { fakes[0].Dead = true; gone = true; } if (failAt < 0 && stdout.ToString().Contains("fail 1 Output device disconnected")) failAt = t; });
      bool empty; lock (L) empty = q.Count == 0;
      ok(failAt >= 500 + LostMs && failAt < 500 + LostMs + 300 && empty && fakes.Count == 1, "device gone for good: reported after " + ((failAt - 500) / 1000.0).ToString("0.00", inv) + " s, queue dropped");
    }
    // G5.4: the real render thread against a real-time fake device for 60 s while 12 threads load the CPU and the GC is forced
    {
      keepLog = false; Fresh("pre 3;bass 6 90;treble 4 9000;band peaking 1000 3 1;band peaking 3000 4 2;lim 1"); Now = () => wall.ElapsedMilliseconds;
      GCSettings.LatencyMode = GCLatencyMode.SustainedLowLatency;
      const int r = 48000, secs = 60; var rnd = new Random(3); var pool = new byte[16][];
      for (int i = 0; i < pool.Length; i++) { var x = new double[2 * 4800]; for (int j = 0; j < x.Length; j++) x[j] = rnd.NextDouble() * 0.9 - 0.45; pool[i] = Pcm(x); }
      FeedFmt(r, 1); stressStop = false; quit = false;
      var ts = new List<Thread>();
      ts.Add(new Thread(() => { int i = 0; while (!stressStop) { bool room; lock (L) room = queuedBytes < r * 8L; if (room) lock (L) { q.AddLast(new Item { Data = pool[i++ % pool.Length], Tag = 1 }); queuedBytes += pool[0].Length; } else Thread.Sleep(5); } }));
      for (int i = 0; i < 12; i++) ts.Add(new Thread(() => { double s = 0; while (!stressStop) s += Math.Sqrt(s + 1); sink += s; }));
      ts.Add(new Thread(() => { while (!stressStop) { sink += new byte[1 << 20].Length; GC.Collect(2, GCCollectionMode.Forced, true); Thread.Sleep(50); } }));
      foreach (var t in ts) t.Start();
      var rt = new Thread(Render) { Priority = ThreadPriority.Highest }; rt.Start();
      Thread.Sleep(secs * 1000);
      quit = true; rt.Join(); stressStop = true; foreach (var t in ts) t.Join();
      var f = fakes.Count > 0 ? fakes[0] : null; long gaps = T - R;
      ok(f != null && f.Starved == 0 && underruns == 0 && gaps == 0 && f.Consumed >= (secs - 1) * (long)r,
        "60 s under 12 busy threads and forced GCs: " + (f != null ? f.Starved : -1) + " frames starved, " + underruns + " underruns, " + gaps + " silent frames, " + (f != null ? f.Consumed / r : 0) + " s played");
      keepLog = true;
    }
  }
  static bool RevReady(Dsp d) { return d.ReverbReady; }
  // --process <rate> <script> <in.f64> <out.f64> <chunk>: runs the DSP over interleaved stereo doubles, for the parity test with
  // renderer/dsp.js. Script lines: "<frame> cfg <DspConfig text>" or "<frame> vol <gain>", applied before that frame's chunk.
  // Reverb is built synchronously here, so it is ready from the first sample.
  static int Offline(string[] a) {
    int rate = int.Parse(a[1]), chunk = int.Parse(a[5]); var d = new Dsp(rate);
    var steps = File.ReadAllLines(a[2]).Where(l => l.Trim().Length > 0).Select(l => l.Split(new[] { ' ' }, 3)).ToList();
    var b = File.ReadAllBytes(a[3]); var x = new double[b.Length / 8]; Buffer.BlockCopy(b, 0, x, 0, b.Length);
    int frames = x.Length / 2, si = 0; var seg = new double[2 * chunk];
    for (int at = 0; at < frames; at += chunk) {
      while (si < steps.Count && long.Parse(steps[si][0]) <= at) {
        var st = steps[si++];
        if (st[1] == "cfg") { d.Apply(DspConfig.Parse(st[2])); while ((!d.ReverbReady && d.Cfg.RevOn) || (!d.SpeakersReady && d.Cfg.Spk)) { d.Process(new double[0], 0); Thread.Sleep(5); } }
        else d.Volume = double.Parse(st[2], CultureInfo.InvariantCulture);
      }
      int n = Math.Min(chunk, frames - at); Array.Copy(x, 2 * at, seg, 0, 2 * n); d.Process(seg, n); Array.Copy(seg, 0, x, 2 * at, 2 * n);
    }
    Buffer.BlockCopy(x, 0, b, 0, b.Length); File.WriteAllBytes(a[4], b);
    Console.WriteLine(d.Latency + " " + d.Lim.Limited + " " + d.Lim.Clamps);
    return 0;
  }
  // amplitude of tone f in the left channel over frames [a, b)
  static double Amp(double[] x, double f, int fs, int a, int b) { double s = 0, c = 0; for (int i = a; i < b; i++) { double w = 2 * Math.PI * f * i / fs; s += x[2 * i] * Math.Sin(w); c += x[2 * i] * Math.Cos(w); } return 2 * Math.Sqrt(s * s + c * c) / (b - a); }
  // true peak in dBTP: the ITU-R BS.1770-4 Annex 2 4x meter, and a reference (Kaiser sinc, beta 12, +-64 taps, 64 points per sample) near its loudest spots
  static readonly double[][] ITU4 = {
    new[]{ 0.0017089843750, 0.0109863281250,-0.0196533203125, 0.0332031250000,-0.0594482421875, 0.1373291015625, 0.9721679687500,-0.1022949218750, 0.0476074218750,-0.0266113281250, 0.0148925781250,-0.0083007812500},
    new[]{-0.0291748046875, 0.0292968750000,-0.0517578125000, 0.0891113281250,-0.1665039062500, 0.4650878906250, 0.7797851562500,-0.2003173828125, 0.1015625000000,-0.0582275390625, 0.0330810546875,-0.0189208984375},
    new[]{-0.0189208984375, 0.0330810546875,-0.0582275390625, 0.1015625000000,-0.2003173828125, 0.7797851562500, 0.4650878906250,-0.1665039062500, 0.0891113281250,-0.0517578125000, 0.0292968750000,-0.0291748046875},
    new[]{-0.0083007812500, 0.0148925781250,-0.0266113281250, 0.0476074218750,-0.1022949218750, 0.9721679687500, 0.1373291015625,-0.0594482421875, 0.0332031250000,-0.0196533203125, 0.0109863281250, 0.0017089843750}};
  static double[] refWin;
  static void TruePeak(double[] x, int skip, out double itu, out double reff) {
    if (refWin == null) {
      Func<double, double> i0 = v => { double s = 1, t = 1; for (int k = 1; k < 50; k++) { t *= (v / (2 * k)) * (v / (2 * k)); s += t; } return s; };
      refWin = new double[64 * 64 + 1];
      for (int i = 0; i <= 64 * 64; i++) { double d = i / 64.0, q = d / 64; refWin[i] = (i == 0 ? 1 : Math.Sin(Math.PI * d) / (Math.PI * d)) * i0(12 * Math.Sqrt(Math.Max(0, 1 - q * q))) / i0(12); }
    }
    int n = x.Length / 2; double mi = 1e-12, mr = 1e-12;
    for (int ch = 0; ch < 2; ch++) {
      var e = new double[n]; double mx = 0;
      for (int i = Math.Max(11, skip); i < n; i++) { double m = 0; for (int p = 0; p < 4; p++) { double s = 0; for (int k = 0; k < 12; k++) s += ITU4[p][k] * x[2 * (i - k) + ch]; m = Math.Max(m, Math.Abs(s)); } e[i] = m; mx = Math.Max(mx, m); }
      mi = Math.Max(mi, mx);
      for (int i = skip, cnt = 0; i < n - 6 && cnt < 300; i++) {
        if (e[i] <= mx * 0.9) continue;
        int c0 = i - 6; // the ITU window ending at i peaks near sample i - 6
        for (int sp = -64; sp <= 64; sp++) {
          double v = 0;
          for (int k = c0 - 64; k <= c0 + 65; k++) { if (k < 0 || k >= n) continue; int dq = Math.Abs(64 * (c0 - k) + sp); if (dq <= 64 * 64) v += x[2 * k + ch] * refWin[dq]; }
          mr = Math.Max(mr, Math.Abs(v));
        }
        cnt++; i += 3;
      }
    }
    itu = 20 * Math.Log10(mi); reff = 20 * Math.Log10(mr);
  }

  // ---------- COM interop ----------
  [DllImport("avrt.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr AvSetMmThreadCharacteristicsW(string task, ref int index);
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
