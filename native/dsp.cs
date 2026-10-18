// 64-bit (double) DSP for exclusive output: the same chain as the Web Audio graph in renderer/engine.js, in the same order:
// stream gain (ReplayGain) -> width/mono -> preamp -> EQ bands -> bass -> treble -> balance -> reverb -> volume -> limiter.
// When every stage is neutral the samples pass through untouched (only delayed), so the output stays bit-perfect.
using System;
using System.Collections.Generic;
using System.Globalization;

sealed class DspConfig {
  public double Pre, Bass, BassF = 90, Treble, TrebleF = 9000, Bal, Width = 1;
  public bool Mono, Lim = true, RevOn;
  public double Size, Damp, Filter, Fade, PreDelay, PreDelayMix, Mix;
  public readonly List<Band> Bands = new List<Band>();
  public struct Band { public string Type; public double Freq, Gain, Q; }

  // "pre 5.1;band peaking 131 5.2 0.97;bass 0 90;treble 0 9000;bal 0;width 1;mono 0;rev 0 s d f fa pd pdm m;lim 1"
  public static DspConfig Parse(string text) {
    var c = new DspConfig();
    foreach (var part in text.Split(';')) {
      var w = part.Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
      if (w.Length == 0) continue;
      Func<int, double> n = i => { double v; return i < w.Length && double.TryParse(w[i], NumberStyles.Float, CultureInfo.InvariantCulture, out v) && !double.IsNaN(v) && !double.IsInfinity(v) ? v : 0; };
      switch (w[0]) {
        case "pre": c.Pre = Clamp(n(1), -30, 30); break;
        case "band": if (w.Length >= 5 && c.Bands.Count < 64) c.Bands.Add(new Band { Type = w[1], Freq = n(2), Gain = Clamp(n(3), -30, 30), Q = n(4) }); break;
        case "bass": c.Bass = Clamp(n(1), -30, 30); c.BassF = n(2); break;
        case "treble": c.Treble = Clamp(n(1), -30, 30); c.TrebleF = n(2); break;
        case "bal": c.Bal = Clamp(n(1), -1, 1); break;
        case "width": c.Width = Clamp(n(1), 0, 3); break;
        case "mono": c.Mono = n(1) != 0; break;
        case "lim": c.Lim = n(1) != 0; break;
        case "rev":
          c.RevOn = n(1) != 0; c.Size = Clamp(n(2), 0, 1); c.Damp = Clamp(n(3), 0, 1); c.Filter = Clamp(n(4), 0, 1); c.Fade = Clamp(n(5), 0, 1);
          c.PreDelay = Clamp(n(6), 0, 1); c.PreDelayMix = Clamp(n(7), 0, 1); c.Mix = Clamp(n(8), 0, 1); break;
      }
    }
    return c;
  }
  public static double Clamp(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

  // stages that change the sound (a lowpass/highpass/notch/... band changes it at any gain)
  public bool Neutral {
    get {
      if (Pre != 0 || Bass != 0 || Treble != 0 || Bal != 0 || Width != 1 || Mono || RevOn) return false;
      foreach (var b in Bands) if (!(b.Gain == 0 && (b.Type == "peaking" || b.Type == "lowshelf" || b.Type == "highshelf"))) return false;
      return true;
    }
  }
}

// RBJ cookbook biquad, Direct Form II Transposed in double. Coefficients glide linearly over ~20 ms to new targets.
sealed class Biquad {
  public double b0 = 1, b1, b2, a1, a2;
  double t0 = 1, t1, t2, t3, t4, d0, d1, d2, d3, d4; int n;
  double zl1, zl2, zr1, zr2;
  public bool Identity { get { return n == 0 && b0 == 1 && b1 == 0 && b2 == 0 && a1 == 0 && a2 == 0; } }

  public static double[] Coef(string type, double fs, double freq, double gainDb, double q) {
    if (gainDb == 0 && (type == "peaking" || type == "lowshelf" || type == "highshelf")) return new double[] { 1, 0, 0, 0, 0 }; // exact identity
    double w = 2 * Math.PI * DspConfig.Clamp(freq, 10, fs * 0.45) / fs, c = Math.Cos(w), Q = DspConfig.Clamp(q == 0 ? 0.71 : q, 0.1, 30);
    double al = Math.Sin(w) / (2 * Q), A = Math.Pow(10, DspConfig.Clamp(gainDb, -60, 60) / 40), sa = 2 * Math.Sqrt(A) * al;
    double B0, B1, B2, A0, A1, A2;
    switch (type) {
      case "lowshelf":
        B0 = A * ((A + 1) - (A - 1) * c + sa); B1 = 2 * A * ((A - 1) - (A + 1) * c); B2 = A * ((A + 1) - (A - 1) * c - sa);
        A0 = (A + 1) + (A - 1) * c + sa; A1 = -2 * ((A - 1) + (A + 1) * c); A2 = (A + 1) + (A - 1) * c - sa; break;
      case "highshelf":
        B0 = A * ((A + 1) + (A - 1) * c + sa); B1 = -2 * A * ((A - 1) + (A + 1) * c); B2 = A * ((A + 1) + (A - 1) * c - sa);
        A0 = (A + 1) - (A - 1) * c + sa; A1 = 2 * ((A - 1) - (A + 1) * c); A2 = (A + 1) - (A - 1) * c - sa; break;
      case "lowpass": B0 = (1 - c) / 2; B1 = 1 - c; B2 = (1 - c) / 2; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; break;
      case "highpass": B0 = (1 + c) / 2; B1 = -(1 + c); B2 = (1 + c) / 2; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; break;
      case "notch": B0 = 1; B1 = -2 * c; B2 = 1; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; break;
      case "bandpass": B0 = al; B1 = 0; B2 = -al; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; break;
      case "allpass": B0 = 1 - al; B1 = -2 * c; B2 = 1 + al; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; break;
      default: // peaking
        B0 = 1 + al * A; B1 = -2 * c; B2 = 1 - al * A; A0 = 1 + al / A; A1 = -2 * c; A2 = 1 - al / A; break;
    }
    return new[] { B0 / A0, B1 / A0, B2 / A0, A1 / A0, A2 / A0 };
  }
  // magnitude in dB at f
  public static double Db(double[] k, double f, double fs) {
    double w = 2 * Math.PI * f / fs, c1 = Math.Cos(w), s1 = Math.Sin(w), c2 = Math.Cos(2 * w), s2 = Math.Sin(2 * w);
    double nr = k[0] + k[1] * c1 + k[2] * c2, ni = -(k[1] * s1 + k[2] * s2), dr = 1 + k[3] * c1 + k[4] * c2, di = -(k[3] * s1 + k[4] * s2);
    return 10 * Math.Log10(Math.Max(1e-24, (nr * nr + ni * ni) / (dr * dr + di * di)));
  }
  public void Target(double[] k, int glide) {
    if (glide <= 0 || (n == 0 && k[0] == b0 && k[1] == b1 && k[2] == b2 && k[3] == a1 && k[4] == a2)) { b0 = t0 = k[0]; b1 = t1 = k[1]; b2 = t2 = k[2]; a1 = t3 = k[3]; a2 = t4 = k[4]; n = 0; return; }
    t0 = k[0]; t1 = k[1]; t2 = k[2]; t3 = k[3]; t4 = k[4]; n = glide;
    d0 = (t0 - b0) / n; d1 = (t1 - b1) / n; d2 = (t2 - b2) / n; d3 = (t3 - a1) / n; d4 = (t4 - a2) / n;
  }
  public void Reset() { zl1 = zl2 = zr1 = zr2 = 0; }
  public void Run(double[] x, int frames) {
    for (int i = 0, j = 0; i < frames; i++, j += 2) {
      if (n > 0) { if (--n == 0) { b0 = t0; b1 = t1; b2 = t2; a1 = t3; a2 = t4; } else { b0 += d0; b1 += d1; b2 += d2; a1 += d3; a2 += d4; } }
      double v = x[j], o = b0 * v + zl1; zl1 = b1 * v - a1 * o + zl2; zl2 = b2 * v - a2 * o; x[j] = o;
      v = x[j + 1]; o = b0 * v + zr1; zr1 = b1 * v - a1 * o + zr2; zr2 = b2 * v - a2 * o; x[j + 1] = o;
    }
    if (Math.Abs(zl1) < 1e-300) zl1 = 0; if (Math.Abs(zl2) < 1e-300) zl2 = 0; if (Math.Abs(zr1) < 1e-300) zr1 = 0; if (Math.Abs(zr2) < 1e-300) zr2 = 0;
  }
}

// one-pole glide toward a target (like AudioParam.setTargetAtTime), snapping when close so neutral values become exact
struct Smooth {
  public double V, T, K;
  public void Init(double v, double tau, double fs) { V = T = v; K = 1 - Math.Exp(-1 / (tau * fs)); }
  public double Next() { if (V != T) { V += (T - V) * K; if (Math.Abs(T - V) < 1e-12) V = T; } return V; }
  public bool Settled { get { return V == T; } }
}

sealed class Dsp {
  public readonly int Rate;
  public DspConfig Cfg = new DspConfig();
  readonly List<Biquad> bands = new List<Biquad>();
  readonly Biquad bass = new Biquad(), treble = new Biquad();
  Smooth pre, bal, vol, stream;
  public double Width = 1; public bool Mono;
  readonly Limiter lim;
  readonly double[] dly; int dp; // plain delay with the limiter's latency, used when the limiter is bypassed
  Reverb rev; Smooth wet, dry;
  public int Latency { get { return lim.L + (rev != null ? rev.B : 0); } }

  public Dsp(int rate) {
    Rate = rate;
    pre.Init(1, 0.02, rate); bal.Init(0, 0.02, rate); vol.Init(1, 0.015, rate); stream.Init(1, 0.02, rate);
    wet.Init(0, 0.03, rate); dry.Init(1, 0.03, rate);
    lim = new Limiter(rate);
    dly = new double[lim.L * 2];
  }
  public double StreamGain { set { stream.T = value; } }
  public double Volume { set { vol.T = value; } }

  // nothing in flight and every stage neutral: output equals input exactly
  public bool Neutral {
    get {
      if (!Cfg.Neutral || rev != null || !pre.Settled || !bal.Settled || !vol.Settled || !stream.Settled || vol.V != 1 || stream.V != 1) return false;
      foreach (var b in bands) if (!b.Identity) return false;
      return bass.Identity && treble.Identity;
    }
  }

  public void Apply(DspConfig c) {
    Cfg = c;
    int glide = (int)(Rate * 0.02);
    while (bands.Count < c.Bands.Count) bands.Add(new Biquad());
    if (bands.Count > c.Bands.Count) bands.RemoveRange(c.Bands.Count, bands.Count - c.Bands.Count);
    for (int i = 0; i < c.Bands.Count; i++) { var b = c.Bands[i]; bands[i].Target(Biquad.Coef(b.Type, Rate, b.Freq, b.Gain, b.Q), glide); }
    bass.Target(Biquad.Coef("lowshelf", Rate, c.BassF, c.Bass, 0.7), glide);
    treble.Target(Biquad.Coef("highshelf", Rate, c.TrebleF, c.Treble, 0.7), glide);
    pre.T = Math.Pow(10, c.Pre / 20); bal.T = c.Bal; Width = c.Width; Mono = c.Mono;
    if (!c.RevOn) rev = null; // shortcut: toggling reverb shifts the output by its block latency (one short gap or skip)
    else if (rev != null && rev.Same(c)) rev.Params(c);
    else Build();
    wet.T = c.RevOn ? c.Mix : 0; dry.T = 1 - (c.RevOn ? c.Mix : 0) * 0.45;
    var boost = new double[Limiter.CENTERS.Length];
    for (int k = 0; k < boost.Length; k++) boost[k] = Math.Pow(10, (c.Pre + ResponseDb(Limiter.CENTERS[k])) / 20);
    lim.SetBoost(boost);
  }

  // EQ + tone magnitude (dB) at f, from the target coefficients
  public double ResponseDb(double f) {
    double s = 0;
    foreach (var b in Cfg.Bands) s += Biquad.Db(Biquad.Coef(b.Type, Rate, b.Freq, b.Gain, b.Q), f, Rate);
    s += Biquad.Db(Biquad.Coef("lowshelf", Rate, Cfg.BassF, Cfg.Bass, 0.7), f, Rate);
    s += Biquad.Db(Biquad.Coef("highshelf", Rate, Cfg.TrebleF, Cfg.Treble, 0.7), f, Rate);
    return s;
  }
  // the most the preamp + EQ + tone can lift any frequency (dB, >= 0): the headroom the DAC volume makes up for
  public double BoostDb() {
    double m = 0;
    for (double f = 20; f <= 20000 && f < Rate * 0.45; f *= 1.03) m = Math.Max(m, Cfg.Pre + ResponseDb(f));
    return m;
  }

  // a new impulse response takes a few hundred ms at hi-res rates: built on a pool thread, swapped in when ready
  volatile Reverb ready; bool building;
  void Build() {
    if (building) return;
    building = true;
    var c = Cfg; int rate = Rate;
    System.Threading.ThreadPool.QueueUserWorkItem(_ => { ready = new Reverb(rate, c); });
  }
  void Swap() {
    var r = ready;
    if (r == null) return;
    ready = null; building = false;
    if (!Cfg.RevOn) return;
    if (r.Same(Cfg)) { rev = r; rev.Params(Cfg); } else Build(); // settings moved on while it was built
  }

  public void Reset() {
    foreach (var b in bands) b.Reset(); bass.Reset(); treble.Reset();
    lim.Reset(); Array.Clear(dly, 0, dly.Length); dp = 0;
    if (rev != null) rev.Reset();
  }

  // x: interleaved stereo, in place
  public void Process(double[] x, int frames) {
    if (building) Swap();
    bool neutral = Neutral;
    if (!neutral) {
      for (int i = 0, j = 0; i < frames; i++, j += 2) {
        double g = stream.Next() * pre.Next(), l = x[j] * g, r = x[j + 1] * g;
        if (Width != 1 || Mono) { double m = (l + r) * 0.5, sd = (l - r) * 0.5 * (Mono ? 0 : Width); l = m + sd; r = m - sd; }
        x[j] = l; x[j + 1] = r;
      }
      foreach (var b in bands) if (!b.Identity) b.Run(x, frames);
      if (!bass.Identity) bass.Run(x, frames);
      if (!treble.Identity) treble.Run(x, frames);
      for (int i = 0, j = 0; i < frames; i++, j += 2) {
        double p = bal.Next();
        if (p == 0) continue;
        // StereoPannerNode, equal power, stereo input
        double l = x[j], r = x[j + 1];
        if (p <= 0) { double a = (p + 1) * Math.PI / 2; x[j] = l + r * Math.Cos(a); x[j + 1] = r * Math.Sin(a); }
        else { double a = p * Math.PI / 2; x[j] = l * Math.Cos(a); x[j + 1] = r + l * Math.Sin(a); }
      }
      if (rev != null) rev.Run(x, frames, ref wet, ref dry);
      for (int i = 0, j = 0; i < frames; i++, j += 2) { double v = vol.Next(); x[j] *= v; x[j + 1] *= v; }
    }
    // the limiter always runs (when on) so it is primed the moment a boost appears; neutral output takes the plain delay
    if (Cfg.Lim) lim.Process(x, frames, neutral ? null : x, dly, ref dp);
    else for (int i = 0, j = 0; i < frames; i++, j += 2) {
      double l = dly[dp], r = dly[dp + 1]; dly[dp] = x[j]; dly[dp + 1] = x[j + 1]; x[j] = l; x[j + 1] = r;
      dp += 2; if (dp >= dly.Length) dp = 0;
    }
  }
}

// Port of renderer/worklet.js LimiterProcessor: 10 octave bands (LR4 crossovers that sum back to the input), 5 ms look-ahead,
// boosted bands give back their own boost first, a broadband stage catches the rest. Ceiling -0.3 dBFS.
sealed class Limiter {
  public static readonly double[] XOVER = { 44, 88, 177, 355, 710, 1420, 2840, 5680, 11360 };
  public static readonly double[] CENTERS = { 31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000 };
  public readonly int L, N;
  readonly double ceil = Math.Pow(10, -0.3 / 20), att, rel;
  readonly double[][] bq; readonly double[][][] z; readonly double[][][] dl; readonly SlidingMin[] win; readonly SlidingMin fin;
  readonly double[] g, need, boost, cut, o = new double[2]; readonly double[][] band, dlf; readonly int[] order;
  double gf = 1; long idx;

  public Limiter(int rate) {
    L = Math.Max(1, (int)Math.Round(rate * 0.005));
    att = Math.Exp(-5.0 / L); rel = Math.Exp(-1 / (rate * 0.15));
    var xs = new List<double[]>();
    foreach (var f in XOVER) {
      if (f >= rate * 0.45) continue;
      double w = 2 * Math.PI * f / rate, cs = Math.Cos(w), al = Math.Sin(w) / (2 * Math.Sqrt(0.5)), a0 = 1 + al;
      xs.Add(new[] { (1 - cs) / 2 / a0, (1 - cs) / a0, (1 - cs) / 2 / a0, -2 * cs / a0, (1 - al) / a0 });
    }
    bq = xs.ToArray(); N = bq.Length + 1;
    z = new double[2][][]; dl = new double[2][][]; band = new double[2][]; dlf = new double[2][];
    for (int ch = 0; ch < 2; ch++) {
      z[ch] = new double[bq.Length][]; for (int j = 0; j < bq.Length; j++) z[ch][j] = new double[4];
      dl[ch] = new double[N][]; for (int j = 0; j < N; j++) dl[ch][j] = new double[L];
      band[ch] = new double[N]; dlf[ch] = new double[L];
    }
    win = new SlidingMin[N]; for (int j = 0; j < N; j++) win[j] = new SlidingMin(L + 1);
    fin = new SlidingMin(L + 1);
    g = new double[N]; need = new double[N]; boost = new double[N]; cut = new double[N]; order = new int[N];
    for (int k = 0; k < N; k++) { g[k] = 1; boost[k] = 1; order[k] = k; }
  }
  public void SetBoost(double[] b) { for (int k = 0; k < N; k++) boost[k] = Math.Max(1, k < b.Length ? b[k] : 1); }
  public void Reset() {
    for (int ch = 0; ch < 2; ch++) { foreach (var s in z[ch]) Array.Clear(s, 0, 4); foreach (var d in dl[ch]) Array.Clear(d, 0, L); Array.Clear(dlf[ch], 0, L); }
    for (int k = 0; k < N; k++) { g[k] = 1; win[k].Clear(); }
    fin.Clear(); gf = 1; idx = 0;
  }

  void Needs(double[] b) {
    double s = 0; for (int k = 0; k < N; k++) s += b[k];
    if (Math.Abs(s) <= ceil) return;
    double sg = s > 0 ? 1 : -1, excess = Math.Abs(s) - ceil, room = 0;
    for (int k = 0; k < N; k++) { double part = sg * b[k]; cut[k] = part > 0 && boost[k] > 1 ? part * (1 - 1 / boost[k]) : 0; room += cut[k]; }
    if (room > excess) { double f = excess / room; for (int k = 0; k < N; k++) cut[k] *= f; excess = 0; } else excess -= room;
    if (excess > 0) {
      Array.Sort(order, (p, q) => (sg * b[q] - cut[q]).CompareTo(sg * b[p] - cut[p]));
      foreach (int k in order) {
        double left = sg * b[k] - cut[k];
        if (left <= 0 || excess <= 0) break;
        double more = Math.Min(excess, left); cut[k] += more; excess -= more;
      }
    }
    for (int k = 0; k < N; k++) if (cut[k] > 0) { double gg = 1 - cut[k] / (sg * b[k]); if (gg < need[k]) need[k] = gg; }
  }

  // x: input (interleaved, in place). outp == null: write the plain-delayed input instead of the limited signal (bit-exact)
  public void Process(double[] x, int frames, double[] outp, double[] dly, ref int dp) {
    for (int k = 0, j = 0; k < frames; k++, j += 2, idx++) {
      for (int i = 0; i < N; i++) need[i] = 1;
      for (int ch = 0; ch < 2; ch++) {
        double[] b = band[ch]; double rest = x[j + ch];
        for (int q = 0; q < bq.Length; q++) {
          double[] c = bq[q], s = z[ch][q];
          double y = c[0] * rest + s[0]; s[0] = c[1] * rest - c[3] * y + s[1]; s[1] = c[2] * rest - c[4] * y;
          double y2 = c[0] * y + s[2]; s[2] = c[1] * y - c[3] * y2 + s[3]; s[3] = c[2] * y - c[4] * y2;
          b[q] = y2; rest -= y2;
        }
        b[N - 1] = rest;
        Needs(b);
      }
      for (int i = 0; i < N; i++) { double t = win[i].Push(idx, need[i]); g[i] = t < g[i] ? t + (g[i] - t) * att : t + (g[i] - t) * rel; }
      int p = (int)(idx % L);
      double needF = 1;
      for (int ch = 0; ch < 2; ch++) {
        double[][] d = dl[ch]; double[] b = band[ch]; double v = 0;
        for (int i = 0; i < N; i++) { v += d[i][p] * g[i]; d[i][p] = b[i]; }
        o[ch] = v; double a = Math.Abs(v); if (a > ceil && ceil / a < needF) needF = ceil / a;
      }
      double tf = fin.Push(idx, needF);
      gf = tf < gf ? tf + (gf - tf) * att : tf + (gf - tf) * rel;
      // plain delay of the input, same latency (L frames)
      double rl = dly[dp], rr = dly[dp + 1]; dly[dp] = x[j]; dly[dp + 1] = x[j + 1]; dp += 2; if (dp >= 2 * L) dp = 0;
      for (int ch = 0; ch < 2; ch++) {
        double[] f = dlf[ch]; double v = f[p] * gf; f[p] = o[ch];
        if (outp != null) x[j + ch] = v > ceil ? ceil : v < -ceil ? -ceil : v;
        else x[j + ch] = ch == 0 ? rl : rr;
      }
    }
  }
}

// minimum of the last w values pushed (monotonic deque)
sealed class SlidingMin {
  readonly int w, cap; readonly double[] v; readonly long[] q; int h, t, n;
  public SlidingMin(int w) { this.w = w; v = new double[w]; cap = w + 1; q = new long[cap]; }
  public void Clear() { h = t = n = 0; }
  public double Push(long i, double x) {
    while (n > 0 && q[h] <= i - w) { h = (h + 1) % cap; n--; }
    while (n > 0 && v[q[(t - 1 + cap) % cap] % w] >= x) { t = (t - 1 + cap) % cap; n--; }
    q[t] = i; t = (t + 1) % cap; n++;
    v[i % w] = x;
    return v[q[h] % w];
  }
}

// Reverb like the Web Audio graph: pre-delay -> convolver (generated stereo noise IR, Web Audio normalization) + pre-delay tap
// -> lowpass, mixed with the dry signal. Uniform partitioned FFT convolution (overlap-save), latency B frames; the dry path is
// delayed by B too so dry and wet stay aligned.
sealed class Reverb {
  public readonly int B; readonly int N, P, rate;
  readonly double[][] hre, him; // per partition: [L spectrum | R spectrum], bins 0..B
  readonly double[][] xre, xim; int head; // frequency-domain delay line of input spectra
  readonly double[] inL, inR, outL, outR, yre, yim, wre, wim; int pos;
  readonly double[] pd; int pdp, pdLen; readonly double[] tap, dryD; // pre-delay line, B-delayed pre-delay tap and dry
  readonly Biquad lp = new Biquad(); double tapGain;
  readonly double size, damp, fade;
  readonly Fft fft;

  public bool Same(DspConfig c) { return Math.Abs(c.Size - size) < 1e-4 && Math.Abs(c.Damp - damp) < 1e-4 && Math.Abs(c.Fade - fade) < 1e-4; }

  public Reverb(int rate, DspConfig c) {
    this.rate = rate; size = c.Size; damp = c.Damp; fade = c.Fade;
    int b = 1; while (b < rate * 0.08) b <<= 1; B = b; N = 2 * B;
    fft = new Fft(N);
    // the IR (Engine.makeIR): decaying noise, high frequencies die faster
    int len = (int)Math.Floor(rate * (0.25 + size * 5.5));
    double decay = 6.5 - fade * 5; var rnd = new Random(1234);
    var ir = new double[2][]; double pow = 0;
    for (int ch = 0; ch < 2; ch++) {
      ir[ch] = new double[len]; double lpv = 0;
      for (int i = 0; i < len; i++) {
        double x = (double)i / len, nz = (rnd.NextDouble() * 2 - 1) * Math.Pow(1 - x, decay), k = 1 - Math.Min(0.97, damp * x * 1.2);
        lpv += (nz - lpv) * k; ir[ch][i] = lpv; pow += lpv * lpv;
      }
    }
    // ConvolverNode normalize = true (Web Audio spec): 1 / rms * 0.00125 * 44100 / rate
    pow = Math.Sqrt(pow / (2.0 * len)); if (pow < 0.000125) pow = 0.000125;
    double scale = 1 / pow * 0.00125 * 44100.0 / rate;
    P = (len + B - 1) / B;
    hre = new double[P][]; him = new double[P][]; xre = new double[P][]; xim = new double[P][];
    var re = new double[N]; var im = new double[N];
    for (int p = 0; p < P; p++) {
      Array.Clear(re, 0, N); Array.Clear(im, 0, N);
      for (int i = 0; i < B && p * B + i < len; i++) { re[i] = ir[0][p * B + i] * scale; im[i] = ir[1][p * B + i] * scale; }
      fft.Run(re, im, false);
      hre[p] = new double[2 * (B + 1)]; him[p] = new double[2 * (B + 1)];
      Split(re, im, hre[p], him[p]);
      xre[p] = new double[2 * (B + 1)]; xim[p] = new double[2 * (B + 1)];
    }
    inL = new double[N]; inR = new double[N]; outL = new double[B]; outR = new double[B];
    yre = new double[N]; yim = new double[N]; wre = new double[2 * (B + 1)]; wim = new double[2 * (B + 1)];
    pd = new double[2 * ((int)(rate * 0.3) + 1)];
    tap = new double[2 * B]; dryD = new double[2 * B];
    Params(c);
  }
  public void Params(DspConfig c) {
    pdLen = Math.Min(pd.Length / 2 - 1, (int)Math.Round(c.PreDelay * 0.3 * rate));
    tapGain = c.PreDelayMix * 0.6;
    // Web Audio lowpass reads Q as dB: Q 0.5 dB -> linear 10^(0.5/20)
    lp.Target(Biquad.Coef("lowpass", rate, 800 + c.Filter * c.Filter * 19000, 0, Math.Pow(10, 0.5 / 20)), (int)(rate * 0.02));
  }
  public void Reset() {
    for (int p = 0; p < P; p++) { Array.Clear(xre[p], 0, xre[p].Length); Array.Clear(xim[p], 0, xim[p].Length); }
    Array.Clear(inL, 0, N); Array.Clear(inR, 0, N); Array.Clear(outL, 0, B); Array.Clear(outR, 0, B);
    Array.Clear(pd, 0, pd.Length); Array.Clear(tap, 0, tap.Length); Array.Clear(dryD, 0, dryD.Length); pos = 0; pdp = 0; lp.Reset();
  }

  // full complex spectrum of (l + i r) -> separate half spectra of l and r: dst[0..B] = L, dst[B+1..2B+1] = R
  void Split(double[] re, double[] im, double[] dre, double[] dim) {
    for (int k = 0; k <= B; k++) {
      int m = (N - k) % N;
      dre[k] = (re[k] + re[m]) / 2; dim[k] = (im[k] - im[m]) / 2;          // L
      dre[B + 1 + k] = (im[k] + im[m]) / 2; dim[B + 1 + k] = (re[m] - re[k]) / 2; // R
    }
  }

  void Block() {
    // newest input spectrum into the delay line
    head = (head + P - 1) % P;
    Array.Copy(inL, yre, N); Array.Copy(inR, yim, N);
    fft.Run(yre, yim, false);
    Split(yre, yim, xre[head], xim[head]);
    Array.Clear(wre, 0, wre.Length); Array.Clear(wim, 0, wim.Length);
    int M = 2 * (B + 1);
    for (int p = 0; p < P; p++) {
      double[] ar = xre[(head + p) % P], ai = xim[(head + p) % P], br = hre[p], bi = him[p];
      for (int k = 0; k < M; k++) { double r = ar[k], i = ai[k], hr = br[k], hi = bi[k]; wre[k] += r * hr - i * hi; wim[k] += r * hi + i * hr; }
    }
    // Y = YL + i YR (both spectra of real signals), then the real part is yl, the imaginary part yr
    for (int k = 0; k <= B; k++) {
      double lr = wre[k], li = wim[k], rr = wre[B + 1 + k], ri = wim[B + 1 + k];
      yre[k] = lr - ri; yim[k] = li + rr;
      if (k > 0 && k < B) { yre[N - k] = lr + ri; yim[N - k] = -li + rr; }
    }
    fft.Run(yre, yim, true);
    for (int i = 0; i < B; i++) { outL[i] = yre[B + i]; outR[i] = yim[B + i]; }
    // slide the input window
    Array.Copy(inL, B, inL, 0, B); Array.Copy(inR, B, inR, 0, B);
  }

  double[] wbuf = new double[0];
  public void Run(double[] x, int frames, ref Smooth wet, ref Smooth dry) {
    int pl = pd.Length;
    if (wbuf.Length < 2 * frames) wbuf = new double[2 * frames];
    for (int i = 0, j = 0; i < frames; i++, j += 2) {
      double l = x[j], r = x[j + 1];
      // pre-delay
      int rp = (pdp - 2 * pdLen + pl) % pl;
      double pl0 = pdLen == 0 ? l : pd[rp], pr0 = pdLen == 0 ? r : pd[rp + 1];
      pd[pdp] = l; pd[pdp + 1] = r; pdp = (pdp + 2) % pl;
      // block convolution: this block's result plays one block later; the pre-delay tap and the dry signal are delayed to match
      int q = 2 * pos;
      wbuf[j] = outL[pos] + tap[q] * tapGain; wbuf[j + 1] = outR[pos] + tap[q + 1] * tapGain;
      double dl = dryD[q], dr = dryD[q + 1];
      tap[q] = pl0; tap[q + 1] = pr0; dryD[q] = l; dryD[q + 1] = r;
      inL[B + pos] = pl0; inR[B + pos] = pr0;
      if (++pos == B) { Block(); pos = 0; }
      x[j] = dl; x[j + 1] = dr;
    }
    lp.Run(wbuf, frames); // the wet part only
    for (int i = 0, j = 0; i < frames; i++, j += 2) { double wg = wet.Next(), dg = dry.Next(); x[j] = x[j] * dg + wbuf[j] * wg; x[j + 1] = x[j + 1] * dg + wbuf[j + 1] * wg; }
  }
}

// iterative radix-2 complex FFT
sealed class Fft {
  readonly int n; readonly int[] rev; readonly double[] cos, sin;
  public Fft(int n) {
    this.n = n; rev = new int[n]; cos = new double[n / 2]; sin = new double[n / 2];
    int bits = 0; while ((1 << bits) < n) bits++;
    for (int i = 0; i < n; i++) { int r = 0; for (int b = 0; b < bits; b++) if ((i & (1 << b)) != 0) r |= 1 << (bits - 1 - b); rev[i] = r; }
    for (int i = 0; i < n / 2; i++) { cos[i] = Math.Cos(2 * Math.PI * i / n); sin[i] = Math.Sin(2 * Math.PI * i / n); }
  }
  public void Run(double[] re, double[] im, bool inverse) {
    for (int i = 0; i < n; i++) { int r = rev[i]; if (r > i) { double t = re[i]; re[i] = re[r]; re[r] = t; t = im[i]; im[i] = im[r]; im[r] = t; } }
    double sg = inverse ? 1 : -1;
    for (int size = 2; size <= n; size <<= 1) {
      int half = size >> 1, step = n / size;
      for (int s = 0; s < n; s += size)
        for (int k = 0, t = 0; k < half; k++, t += step) {
          double wr = cos[t], wi = sg * sin[t];
          int a = s + k, b = a + half;
          double xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        }
    }
    if (inverse) { double k = 1.0 / n; for (int i = 0; i < n; i++) { re[i] *= k; im[i] *= k; } }
  }
}
