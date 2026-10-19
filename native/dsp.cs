// 64-bit (double) DSP for exclusive output: the same chain as the Web Audio graph in renderer/engine.js, in the same order:
// stream gain (ReplayGain) -> width/mono -> crossfeed -> preamp -> EQ bands -> bass -> treble -> balance -> reverb -> volume -> limiter.
// The filters are linear, so they run as two chains: every cut first, then every boost, each boost kept as its own part for the
// give-back limiter. When every stage is neutral the samples pass through untouched (only delayed), so the output stays bit-perfect.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

sealed class DspConfig {
  public double Pre, Bass, BassF = 90, Treble, TrebleF = 9000, Bal, Width = 1, Ceil = -1;
  public bool Mono, Lim = true, RevOn, Guard, Xf;
  public double XfF = 700, XfDb = 4.5; // crossfeed corner and how far below the direct sound the crossed bass sits
  public double Size, Damp, Filter, Fade, PreDelay, PreDelayMix, Mix;
  public readonly List<Band> Bands = new List<Band>();
  public struct Band { public string Type; public double Freq, Gain, Q; }

  // "pre 5.1;band peaking 131 5.2 0.97;bass 0 90;treble 0 9000;bal 0;width 1;mono 0;xfeed 0 700 4.5;rev 0 s d f fa pd pdm m;lim 1;ceil -1;guard 0"
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
        case "xfeed": c.Xf = n(1) != 0; c.XfF = Clamp(n(2), 300, 2000); c.XfDb = Clamp(n(3), 1, 15); break;
        case "lim": c.Lim = n(1) != 0; break;
        case "ceil": c.Ceil = Clamp(n(1), -6, 0); break;   // true-peak ceiling, dBTP
        case "guard": c.Guard = n(1) != 0; break;         // true-peak stage on even when every other stage is neutral
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
      if (Pre != 0 || Bass != 0 || Treble != 0 || Bal != 0 || Width != 1 || Mono || Xf || RevOn) return false;
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
  // identity coefficients and no state left: running it would change nothing
  public bool Identity { get { return n == 0 && b0 == 1 && b1 == 0 && b2 == 0 && a1 == 0 && a2 == 0 && zl1 == 0 && zl2 == 0 && zr1 == 0 && zr2 == 0; } }

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
  const int BLK = 256, SLOTS = 3 + 64; // give-back slots: 0 preamp, 1 bass, 2 treble, 3.. EQ bands
  public readonly int Rate;
  public DspConfig Cfg = new DspConfig();
  // every gain filter has two instances: one in the cut chain, one in the boost chain. A band that boosts runs in the boost chain
  // (its cut twin glides to identity), so a band crossing 0 dB moves over without a click
  readonly List<Biquad> cutQ = new List<Biquad>(), boostQ = new List<Biquad>();
  readonly Biquad bassC = new Biquad(), bassB = new Biquad(), trebC = new Biquad(), trebB = new Biquad();
  Smooth pre, bal, vol, stream, xg; double xa, xlp; // xg: crossfeed amount g, xlp: its lowpass state
  public double Width = 1; public bool Mono;
  readonly Limiter lim;
  readonly double[] s0 = new double[2 * BLK], acc = new double[2 * BLK], tmp = new double[2 * BLK], gp = new double[BLK];
  readonly double[][] dk = new double[SLOTS][]; readonly bool[] live = new bool[SLOTS];
  Reverb rev; Smooth wet, dry;
  public int Latency { get { return lim.L + (rev != null ? rev.B : 0); } }
  public bool ReverbReady { get { return rev != null; } }
  public Limiter Lim { get { return lim; } }
  // the last Process call wrote the delayed input unchanged (no dither needed)
  public bool Exact { get; private set; }

  public Dsp(int rate) {
    Rate = rate;
    pre.Init(1, 0.02, rate); bal.Init(0, 0.02, rate); vol.Init(1, 0.015, rate); stream.Init(1, 0.02, rate);
    wet.Init(0, 0.03, rate); dry.Init(1, 0.03, rate); xg.Init(0, 0.03, rate);
    lim = new Limiter(rate, SLOTS);
    for (int k = 0; k < SLOTS; k++) dk[k] = new double[2 * BLK];
  }
  public double StreamGain { set { stream.T = value; } }
  public double Volume { set { vol.T = value; } }
  bool fresh = true;
  public long Sanitized; // non-finite input samples replaced by 0

  // nothing in flight and every stage neutral: output equals input exactly
  public bool Neutral {
    get {
      if (!Cfg.Neutral || rev != null || !pre.Settled || !bal.Settled || !vol.Settled || !stream.Settled || vol.V != 1 || stream.V != 1 || pre.V != 1 || !xg.Settled || xg.V != 0) return false;
      foreach (var b in cutQ) if (!b.Identity) return false;
      foreach (var b in boostQ) if (!b.Identity) return false;
      return bassC.Identity && bassB.Identity && trebC.Identity && trebB.Identity;
    }
  }

  static readonly double[] ID = { 1, 0, 0, 0, 0 };
  static bool Boosts(string type, double gain) { return gain > 0 && (type == "peaking" || type == "lowshelf" || type == "highshelf"); }
  static void Pair(Biquad c, Biquad b, double[] k, bool boost, int glide) { c.Target(boost ? ID : k, glide); b.Target(boost ? k : ID, glide); }

  public void Apply(DspConfig c) {
    Cfg = c;
    int glide = (int)(Rate * 0.02);
    while (cutQ.Count < c.Bands.Count) { cutQ.Add(new Biquad()); boostQ.Add(new Biquad()); }
    for (int i = 0; i < cutQ.Count; i++) {
      if (i >= c.Bands.Count) { Pair(cutQ[i], boostQ[i], ID, false, glide); continue; } // removed bands glide out, pruned once flat
      var b = c.Bands[i]; Pair(cutQ[i], boostQ[i], Biquad.Coef(b.Type, Rate, b.Freq, b.Gain, b.Q), Boosts(b.Type, b.Gain), glide);
    }
    Pair(bassC, bassB, Biquad.Coef("lowshelf", Rate, c.BassF, c.Bass, 0.7), c.Bass > 0, glide);
    Pair(trebC, trebB, Biquad.Coef("highshelf", Rate, c.TrebleF, c.Treble, 0.7), c.Treble > 0, glide);
    pre.T = Math.Pow(10, c.Pre / 20); bal.T = c.Bal; Width = c.Width; Mono = c.Mono;
    lim.Ceil = Math.Pow(10, c.Ceil / 20);
    xg.T = c.Xf ? 1 / (1 + Math.Pow(10, c.XfDb / 20)) : 0; xa = 1 - Math.Exp(-2 * Math.PI * c.XfF / Rate);
    if (!c.RevOn) rev = null; // shortcut: toggling reverb shifts the output by its block latency (one short gap or skip)
    else if (rev != null && rev.Same(c)) rev.Params(c);
    else Build();
    wet.T = c.RevOn ? c.Mix : 0; dry.T = 1 - (c.RevOn ? c.Mix : 0) * 0.45;
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
    foreach (var b in cutQ) b.Reset(); foreach (var b in boostQ) b.Reset();
    bassC.Reset(); bassB.Reset(); trebC.Reset(); trebB.Reset();
    lim.Reset(); fresh = true; xlp = 0;
    if (rev != null) rev.Reset();
  }

  // x: interleaved stereo, in place
  public void Process(double[] x, int frames) {
    if (building) Swap();
    // a fresh stream starts at its settings, not gliding in from unity (a gliding volume would be limited for a moment)
    if (fresh) { fresh = false; pre.V = pre.T; bal.V = bal.T; vol.V = vol.T; stream.V = stream.T; xg.V = xg.T; }
    // NaN/Inf from a broken decoder would poison every filter state for good: replace with silence
    for (int i = 0; i < 2 * frames; i++) if (x[i] - x[i] != 0) { x[i] = 0; Sanitized++; }
    bool exact = true;
    for (int at = 0; at < frames; at += BLK) exact &= Block(x, at, Math.Min(BLK, frames - at));
    Exact = exact;
    while (cutQ.Count > Cfg.Bands.Count && cutQ[cutQ.Count - 1].Identity && boostQ[boostQ.Count - 1].Identity) { cutQ.RemoveAt(cutQ.Count - 1); boostQ.RemoveAt(boostQ.Count - 1); }
  }

  // one link of the boost chain: d = B(acc) - acc, acc = B(acc)
  void Boost(Biquad b, int slot, int n) {
    if (b.Identity) return;
    Array.Copy(acc, tmp, 2 * n); b.Run(tmp, n);
    var d = dk[slot]; for (int j = 0; j < 2 * n; j++) d[j] = tmp[j] - acc[j];
    Array.Copy(tmp, acc, 2 * n); live[slot] = true;
  }

  bool Block(double[] x, int at, int n) {
    bool neutral = Neutral;
    Array.Copy(x, 2 * at, s0, 0, 2 * n);
    Array.Clear(live, 0, SLOTS);
    if (!neutral) {
      // stream gain and the cutting part of the preamp go into the base signal; a preamp boost is give-back slot 0
      bool preUp = false, xf = !xg.Settled || xg.V != 0;
      for (int i = 0, j = 0; i < n; i++, j += 2) {
        double p = pre.Next(), g = stream.Next() * (p < 1 ? p : 1), l = s0[j] * g, r = s0[j + 1] * g;
        if (Width != 1 || Mono) { double m = (l + r) * 0.5, sd = (l - r) * 0.5 * (Mono ? 0 : Width); l = m + sd; r = m - sd; }
      // crossfeed: the side signal loses 2g of its low end (S - 2g LP(S)), so a hard-panned bass reaches the far ear (1-g : g),
      // the mid signal (and so a mono sum) stays exactly as it was. |1 - 2g LP| <= 1: it never adds level
        if (xf) { double m = (l + r) * 0.5, sd = (l - r) * 0.5; xlp += xa * (sd - xlp); sd -= 2 * xg.Next() * xlp; l = m + sd; r = m - sd; }
        s0[j] = l; s0[j + 1] = r; gp[i] = p > 1 ? p : 1; if (p > 1) preUp = true;
      }
      if (!xf || Math.Abs(xlp) < 1e-300) xlp = 0;
      // cut chain: the signal with every boost taken out
      foreach (var b in cutQ) if (!b.Identity) b.Run(s0, n);
      if (!bassC.Identity) bassC.Run(s0, n);
      if (!trebC.Identity) trebC.Run(s0, n);
      // boost chain, telescoped: s0 + d_pre + d_1 + ... is exactly the EQ that was asked for, and each d holds only what its boost adds
      Array.Copy(s0, acc, 2 * n);
      if (preUp) { var d = dk[0]; for (int i = 0, j = 0; i < n; i++, j += 2) { double k = gp[i] - 1; d[j] = acc[j] * k; d[j + 1] = acc[j + 1] * k; acc[j] += d[j]; acc[j + 1] += d[j + 1]; } live[0] = true; }
      for (int i = 0; i < boostQ.Count; i++) Boost(boostQ[i], 3 + i, n);
      Boost(bassB, 1, n); Boost(trebB, 2, n);
      // balance and volume are memoryless and linear: applied to every part exactly
      for (int i = 0, j = 0; i < n; i++, j += 2) {
        double p = bal.Next(), v = vol.Next();
        if (p == 0) { Scale(j, v); continue; }
        // StereoPannerNode, equal power, stereo input
        if (p <= 0) { double a = (p + 1) * Math.PI / 2; Pan(j, v, v * Math.Cos(a), v * Math.Sin(a), true); }
        else { double a = p * Math.PI / 2; Pan(j, v, v * Math.Cos(a), v * Math.Sin(a), false); }
      }
      // reverb: the wet part cannot be split into boosts, so with reverb on everything goes to the base signal
      if (rev != null) {
        for (int k = 0; k < SLOTS; k++) if (live[k]) { var d = dk[k]; for (int j = 0; j < 2 * n; j++) s0[j] += d[j]; live[k] = false; }
        rev.Run(s0, n, ref wet, ref dry);
      }
    }
    bool on = !neutral && Cfg.Lim;
    return lim.Process(s0, dk, live, n, x, at, on, on || Cfg.Guard) && neutral;
  }
  void Scale(int j, double v) {
    if (v == 1) return;
    s0[j] *= v; s0[j + 1] *= v;
    for (int k = 0; k < SLOTS; k++) if (live[k]) { dk[k][j] *= v; dk[k][j + 1] *= v; }
  }
  // left (p <= 0): L' = v(l + r cos), R' = v r sin; right: L' = v l cos, R' = v(r + l sin)
  void Pan(int j, double v, double vc, double vs, bool left) {
    Pan1(s0, j, v, vc, vs, left);
    for (int k = 0; k < SLOTS; k++) if (live[k]) Pan1(dk[k], j, v, vc, vs, left);
  }
  static void Pan1(double[] a, int j, double v, double vc, double vs, bool left) {
    double l = a[j], r = a[j + 1];
    if (left) { a[j] = v * l + vc * r; a[j + 1] = vs * r; } else { a[j] = vc * l; a[j + 1] = v * r + vs * l; }
  }
}

// Boost give-back limiter with true-peak detection. Input: the unboosted signal s0 and one part d_k per active boost
// (preamp, bass, treble, EQ bands). The output is gB * (s0 + sum a_k d_k):
//  stage A: when the requested sum would pass the ceiling (at a sample or between samples), the boosts that push in that
//           direction give back their boost (a_k < 1, never below the unboosted level), in proportion to their share.
//           Nothing that is not boosted is touched, so a bass boost never ducks vocals or cymbals.
//  stage B: broadband, on the actual output: catches what stage A cannot (an unboosted signal that is itself over).
// Both stages: min-hold over the look-ahead then a moving average of the same length, so the gain at every peak is at or
// below what that peak needs (no exponential attack that relies on a clipper). Inter-sample peaks: a 4x grid of
// Kaiser-windowed sinc (128 taps) refined by a parabola, plus the 4 ITU-R BS.1770-4 phases, whichever reads higher.
// All gains at exactly 1 (and no boost parts in flight): the output is the delayed input, bit for bit.
sealed class Limiter {
  public const int H = 64, G = 4, PH = G - 1 + 4; // interpolator half length (taps each side); G-1 positions between samples + 4 ITU phases
  public readonly int L, WA, WB; readonly int M, slots;
  public double Ceil = Math.Pow(10, -1.0 / 20);
  readonly double[] s0R, SR, yR;
  readonly double[][] dR; readonly Smoother[] sm; readonly long[] lastNZ; readonly bool[] alive;
  readonly Smoother smB;
  readonly double[] needS, ivP, ivC, dv, alpha; readonly int[] al;
  double ivPB = 1; long idx;
  public long Clamps, Limited; // samples the last-resort clamp moved by more than rounding (should stay 0), samples with any gain < 1

  public Limiter(int rate, int slots) {
    this.slots = slots;
    WA = Math.Max(2, (int)Math.Round(rate * 0.005)); WB = Math.Max(2, (int)Math.Round(rate * 0.003));
    L = 4 * H + WA + WB - 2;
    int need = 2 * H + Math.Max(WA, WB) + 4, rs = 1; while (rs < need) rs <<= 1; M = rs - 1;
    double rel = Math.Exp(-1 / (rate * 0.15));
    s0R = new double[2 * rs]; SR = new double[2 * rs]; yR = new double[2 * rs];
    dR = new double[slots][]; sm = new Smoother[slots]; lastNZ = new long[slots]; alive = new bool[slots];
    for (int k = 0; k < slots; k++) { dR[k] = new double[2 * rs]; sm[k] = new Smoother(WA, WA + 2 * H, rel); }
    smB = new Smoother(WB, WB + 2 * H, rel);
    needS = new double[slots]; ivP = new double[slots]; ivC = new double[slots]; dv = new double[slots]; alpha = new double[slots]; al = new int[slots];
  }
  // shortcut: rings of slots that went quiet are cleared on revival, not on Reset (they are dead, so never read)
  public void Reset() {
    Array.Clear(s0R, 0, s0R.Length); Array.Clear(SR, 0, SR.Length); Array.Clear(yR, 0, yR.Length);
    for (int k = 0; k < slots; k++) { alive[k] = false; sm[k].Reset(); }
    smB.Reset(); ivPB = 1; idx = 0;
  }
  public bool Busy { get { if (!smB.Idle) return true; for (int k = 0; k < slots; k++) if (alive[k]) return true; return false; } }

  static double I0(double x) { double s = 1, t = 1; for (int k = 1; k < 40; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; } return s; }
  // ITU-R BS.1770-4 Annex 2 example interpolator (4 phases, 12 taps). Its passband ripple makes it read up to ~0.2 dB above the
  // ideal reconstruction on some music, so the detector takes the larger of both: the output passes either meter.
  static readonly double[] ITU0 = { 0.0017089843750, 0.0109863281250, -0.0196533203125, 0.0332031250000, -0.0594482421875, 0.1373291015625, 0.9721679687500, -0.1022949218750, 0.0476074218750, -0.0266113281250, 0.0148925781250, -0.0083007812500 };
  static readonly double[] ITU1 = { -0.0291748046875, 0.0292968750000, -0.0517578125000, 0.0891113281250, -0.1665039062500, 0.4650878906250, 0.7797851562500, -0.2003173828125, 0.1015625000000, -0.0582275390625, 0.0330810546875, -0.0189208984375 };
  // kernels: value near the interval (m, m+1) = sum w[j] x[m + KOFF[p] + j]
  // KER finds the peak; KERS (32 taps) splits it into the boost parts' shares, which only set proportions: stage B holds the ceiling
  const int HS = 16;
  static readonly int[] KOFF = new int[PH], KOFFS = new int[PH];
  static readonly double[][] KER = Kernel(H, 9, KOFF), KERS = Kernel(HS, 8, KOFFS); // after KOFF and the ITU tables: static fields initialize in text order
  // no kernel output can exceed KS times the largest sample in its window (+ the estimate bias)
  static readonly double KS = KER.Max(w => w.Sum(v => Math.Abs(v))) * 1.0035;
  static double[][] Kernel(int h, double beta, int[] koff) {
    var ker = new double[PH][];
    for (int p = 0; p < G - 1; p++) {
      double tau = (p + 1) / (double)G, sum = 0; var w = new double[2 * h];
      for (int j = 0; j < 2 * h; j++) {
        double u = tau + h - 1 - j, r = u / h, sinc = Math.Sin(Math.PI * u) / (Math.PI * u);
        w[j] = sinc * I0(beta * Math.Sqrt(Math.Max(0, 1 - r * r))) / I0(beta); sum += w[j];
      }
      for (int j = 0; j < 2 * h; j++) w[j] /= sum; // exact at DC
      ker[p] = w; koff[p] = 1 - h;
    }
    // ITU y[4n+p] = sum h_p[k] x[n-k], taken at n = m + 6 so its window (m-5 .. m+6) lies inside the available samples
    var itu = new[] { ITU0, ITU1, ITU1.Reverse().ToArray(), ITU0.Reverse().ToArray() };
    for (int p = 0; p < 4; p++) { ker[G - 1 + p] = itu[p].Reverse().ToArray(); koff[G - 1 + p] = -5; }
    return ker;
  }
  // value number p near the interval (m, m+1) of ring r, channel ch
  double Interp(double[] r, long m, int p, int ch, bool share = false) {
    double[] w = share ? KERS[p] : KER[p]; double s = 0; long b = m + (share ? KOFFS[p] : KOFF[p]);
    for (int j = 0; j < w.Length; j++) s += w[j] * r[2 * (int)((b + j) & M) + ch];
    return s;
  }
  // the highest value between samples m and m+1 (signed): the G-grid maximum refined by a parabola through its neighbours, or
  // an ITU phase if that reads higher. pi: the kernel it came from, -1 / -2 for sample m / m+1
  readonly double[] gv = new double[G + 1];
  double Peak(double[] r, long m, int ch, out int pi) {
    gv[0] = r[2 * (int)(m & M) + ch]; gv[G] = r[2 * (int)((m + 1) & M) + ch];
    // quick bound: when nothing in the window can reach the ceiling, the exact peak is not needed (callers only act above it)
    double amax = 0; for (long k = m + 1 - H; k <= m + H; k++) { double v = r[2 * (int)(k & M) + ch]; if (v > amax) amax = v; else if (-v > amax) amax = -v; }
    if (amax * KS <= Ceil) { pi = -1; return gv[0]; }
    for (int p = 0; p < G - 1; p++) gv[p + 1] = Interp(r, m, p, ch);
    int bi = 0; for (int i = 1; i <= G; i++) if (Math.Abs(gv[i]) > Math.Abs(gv[bi])) bi = i;
    double pk = Math.Abs(gv[bi]), sg = gv[bi] < 0 ? -1 : 1;
    if (bi > 0 && bi < G) {
      double y0 = Math.Abs(gv[bi - 1]), y1 = pk, y2 = Math.Abs(gv[bi + 1]), den = y0 - 2 * y1 + y2;
      if (den < 0) { double d = 0.5 * (y0 - y2) / den; pk = y1 - 0.25 * (y0 - y2) * d; }
    }
    pi = bi == 0 ? -1 : bi == G ? -2 : bi - 1;
    if (pi >= 0) pk *= 1.0035; // +0.03 dB: the measured worst grid + kernel error on music (D:\ test set: 0.03 dB), so estimates err high
    for (int p = G - 1; p < PH; p++) { double v = Interp(r, m, p, ch); if (Math.Abs(v) > pk) { pk = Math.Abs(v); sg = v < 0 ? -1 : 1; pi = p; } }
    return sg * pk;
  }
  // stage A: the a_k this value (sum S, boost parts dv) needs
  void Alloc(double S, int nal, double[] need) {
    double a = Math.Abs(S); if (a <= Ceil) return;
    double sg = S > 0 ? 1 : -1, C = 0;
    for (int i = 0; i < nal; i++) { double q = sg * dv[al[i]]; if (q > 0) C += q; }
    if (C <= 0) return;
    double f = (a - Ceil) / C; if (f > 1) f = 1;
    for (int i = 0; i < nal; i++) { int k = al[i]; if (sg * dv[k] > 0 && 1 - f < need[k]) need[k] = 1 - f; }
  }

  // returns true when every output sample is the delayed s0 untouched
  public bool Process(double[] s0, double[][] d, bool[] live, int n, double[] outp, int at, bool detA, bool detB) {
    bool exact = true;
    for (int i = 0; i < n; i++, idx++) {
      int w = 2 * (int)(idx & M);
      double S0 = s0[2 * i], S1 = s0[2 * i + 1];
      s0R[w] = S0; s0R[w + 1] = S1;
      int nal = 0;
      for (int k = 0; k < slots; k++) {
        if (live[k]) {
          if (!alive[k]) { alive[k] = true; Array.Clear(dR[k], 0, dR[k].Length); sm[k].Reset(); ivP[k] = 1; }
          double a = d[k][2 * i], b = d[k][2 * i + 1]; dR[k][w] = a; dR[k][w + 1] = b; S0 += a; S1 += b;
          if (a != 0 || b != 0) lastNZ[k] = idx;
        } else if (alive[k]) {
          dR[k][w] = 0; dR[k][w + 1] = 0;
          if (idx - lastNZ[k] > M && sm[k].Idle) { alive[k] = false; continue; }
        } else continue;
        al[nal++] = k;
      }
      SR[w] = S0; SR[w + 1] = S1;
      // stage A at sample m = idx - H (the interpolator needs H samples after it)
      long m = idx - H;
      if (nal > 0) {
        if (detA) {
          int wm = 2 * (int)(m & M);
          for (int q = 0; q < nal; q++) { needS[al[q]] = 1; ivC[al[q]] = 1; }
          for (int ch = 0; ch < 2; ch++) {
            for (int q = 0; q < nal; q++) dv[al[q]] = dR[al[q]][wm + ch];
            Alloc(SR[wm + ch], nal, needS);
            int pi; double sp = Peak(SR, m, ch, out pi);
            if (Math.Abs(sp) > Ceil) {
              // shares of the boost parts at the point where the over peaks
              for (int q = 0; q < nal; q++) { var r = dR[al[q]]; dv[al[q]] = pi >= 0 ? Interp(r, m, pi, ch, true) : r[2 * (int)((m + (pi == -2 ? 1 : 0)) & M) + ch]; }
              Alloc(sp, nal, ivC);
            }
          }
          // an over between m and m+1 is charged to both samples
          for (int q = 0; q < nal; q++) { int k = al[q]; double nd = Math.Min(needS[k], Math.Min(ivP[k], ivC[k])); ivP[k] = ivC[k]; alpha[k] = sm[k].Push(nd); }
        } else for (int q = 0; q < nal; q++) { int k = al[q]; ivP[k] = 1; alpha[k] = sm[k].Push(1); }
      }
      // the gains just computed belong to sample mo
      long mo = m - WA + 1 - H; int wo = 2 * (int)(mo & M);
      double y0 = s0R[wo], y1 = s0R[wo + 1];
      bool cut = false;
      for (int q = 0; q < nal; q++) { int k = al[q]; double a = alpha[k]; y0 += a * dR[k][wo]; y1 += a * dR[k][wo + 1]; if (a != 1) cut = true; }
      if (nal > 0) exact = false;
      int wy = 2 * (int)(mo & M); yR[wy] = y0; yR[wy + 1] = y1;
      // stage B at sample mb, on the actual output
      long mb = mo - H; double g;
      if (detB) {
        int wb = 2 * (int)(mb & M); double nd = 1, iv = 1;
        for (int ch = 0; ch < 2; ch++) {
          double a = Math.Abs(yR[wb + ch]); if (a > Ceil && Ceil / a < nd) nd = Ceil / a;
          int pi; a = Math.Abs(Peak(yR, mb, ch, out pi)); if (a > Ceil && Ceil / a < iv) iv = Ceil / a;
        }
        g = smB.Push(Math.Min(nd, Math.Min(ivPB, iv))); ivPB = iv;
      } else { g = smB.Push(1); ivPB = 1; }
      long ob = mb - WB + 1 - H; int wq = 2 * (int)(ob & M), j = 2 * (at + i);
      double o0 = yR[wq], o1 = yR[wq + 1];
      if (g != 1) { o0 *= g; o1 *= g; exact = false; cut = true; }
      if (cut) Limited++;
      if (detB) {
        if (o0 > Ceil) { if (o0 > Ceil * (1 + 1e-9)) Clamps++; o0 = Ceil; } else if (o0 < -Ceil) { if (o0 < -Ceil * (1 + 1e-9)) Clamps++; o0 = -Ceil; }
        if (o1 > Ceil) { if (o1 > Ceil * (1 + 1e-9)) Clamps++; o1 = Ceil; } else if (o1 < -Ceil) { if (o1 < -Ceil * (1 + 1e-9)) Clamps++; o1 = -Ceil; }
      }
      outp[j] = o0; outp[j + 1] = o1;
    }
    return exact;
  }
}

// gain smoothing that never overshoots: min-hold over the last `hold` needs, release toward 1, then a W-long moving average.
// With hold = W + 2K, the value returned by a push belongs to the need pushed W-1+K pushes earlier and is at or below every
// need within K samples of it: the gain is flat around a peak, so the inter-sample values next to it see the same gain.
sealed class Smoother {
  readonly int W, HW, cap; readonly double rel; readonly double[] ring, dv; readonly long[] di;
  int pos, h, t, cnt, non1; double sum, r = 1; long n;
  public Smoother(int w, int hold, double rel) { W = w; HW = hold; this.rel = rel; ring = new double[w]; cap = hold + 1; dv = new double[cap]; di = new long[cap]; Reset(); }
  public void Reset() { for (int i = 0; i < W; i++) ring[i] = 1; sum = W; non1 = 0; r = 1; h = t = cnt = 0; pos = 0; }
  public bool Idle { get { return non1 == 0 && r == 1 && cnt == 0; } }
  public double Push(double need) {
    n++;
    if (need >= 1 && Idle) return 1;
    if (need < 1) { while (cnt > 0 && dv[(t - 1 + cap) % cap] >= need) { t = (t - 1 + cap) % cap; cnt--; } dv[t] = need; di[t] = n; t = (t + 1) % cap; cnt++; }
    while (cnt > 0 && di[h] <= n - HW) { h = (h + 1) % cap; cnt--; }
    // release aims a little past 1 so it lands on exactly 1 in finite time (a plain exponential would take ~4 s to snap)
    double held = cnt > 0 ? dv[h] : 1, up = 1.001 - (1.001 - r) * rel;
    if (up > 1) up = 1;
    r = held < up ? held : up;
    double old = ring[pos]; ring[pos] = r; if (++pos == W) pos = 0;
    if (old != 1) non1--; if (r != 1) non1++;
    if (non1 == 0) { sum = W; return 1; }
    sum += r - old;
    if (pos == 0) { sum = 0; for (int i = 0; i < W; i++) sum += ring[i]; } // no drift
    return sum / W;
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
    double decay = 6.5 - fade * 5; uint seed = 1234; // mulberry32, the same noise as renderer/dsp.js
    var ir = new double[2][]; double pow = 0;
    for (int ch = 0; ch < 2; ch++) {
      ir[ch] = new double[len]; double lpv = 0;
      for (int i = 0; i < len; i++) {
        double x = (double)i / len, nz = (Noise(ref seed) * 2 - 1) * Math.Pow(1 - x, decay), k = 1 - Math.Min(0.97, damp * x * 1.2);
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
  static double Noise(ref uint a) {
    a += 0x6D2B79F5; uint t = (a ^ (a >> 15)) * (1 | a);
    t = (t + (t ^ (t >> 7)) * (61 | t)) ^ t;
    return (t ^ (t >> 14)) / 4294967296.0;
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
