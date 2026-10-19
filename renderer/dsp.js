// 64-bit DSP for shared (Web Audio) output: a line-for-line port of native/dsp.cs, so both outputs sound the same.
// Keep the two in sync: test/dsp.test.mjs checks they agree to 1e-9. Loaded as an AudioWorklet module ('cadence-dsp')
// and imported by the tests.
// stream gain -> width/mono -> preamp -> EQ bands -> bass -> treble -> balance -> reverb -> volume -> limiter.
// The filters are linear, so they run as two chains: every cut first, then every boost, each boost kept as its own part for the
// give-back limiter. When every stage is neutral the samples pass through untouched (only delayed).

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
// .NET Math.Round: halves go to the even neighbour (44100 * 0.005 is exactly 220.5)
const round = v => { const r = Math.round(v); return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r; };

// "pre 5.1;band peaking 131 5.2 0.97;bass 0 90;treble 0 9000;bal 0;width 1;mono 0;rev 0 s d f fa pd pdm m;lim 1;ceil -1;guard 0"
export function parseConfig(text) {
  const c = { Pre: 0, Bass: 0, BassF: 90, Treble: 0, TrebleF: 9000, Bal: 0, Width: 1, Ceil: -1, Mono: false, Lim: true, RevOn: false, Guard: false,
    Size: 0, Damp: 0, Filter: 0, Fade: 0, PreDelay: 0, PreDelayMix: 0, Mix: 0, Bands: [] };
  for (const part of String(text).split(';')) {
    const w = part.trim().split(' ').filter(Boolean);
    if (w.length === 0) continue;
    const n = i => { const v = i < w.length ? Number(w[i]) : 0; return Number.isFinite(v) ? v : 0; };
    switch (w[0]) {
      case 'pre': c.Pre = clamp(n(1), -30, 30); break;
      case 'band': if (w.length >= 5 && c.Bands.length < 64) c.Bands.push({ Type: w[1], Freq: n(2), Gain: clamp(n(3), -30, 30), Q: n(4) }); break;
      case 'bass': c.Bass = clamp(n(1), -30, 30); c.BassF = n(2); break;
      case 'treble': c.Treble = clamp(n(1), -30, 30); c.TrebleF = n(2); break;
      case 'bal': c.Bal = clamp(n(1), -1, 1); break;
      case 'width': c.Width = clamp(n(1), 0, 3); break;
      case 'mono': c.Mono = n(1) !== 0; break;
      case 'lim': c.Lim = n(1) !== 0; break;
      case 'ceil': c.Ceil = clamp(n(1), -6, 0); break;
      case 'guard': c.Guard = n(1) !== 0; break;
      case 'rev':
        c.RevOn = n(1) !== 0; c.Size = clamp(n(2), 0, 1); c.Damp = clamp(n(3), 0, 1); c.Filter = clamp(n(4), 0, 1); c.Fade = clamp(n(5), 0, 1);
        c.PreDelay = clamp(n(6), 0, 1); c.PreDelayMix = clamp(n(7), 0, 1); c.Mix = clamp(n(8), 0, 1); break;
    }
  }
  return c;
}
// stages that change the sound (a lowpass/highpass/notch/... band changes it at any gain)
function cfgNeutral(c) {
  if (c.Pre !== 0 || c.Bass !== 0 || c.Treble !== 0 || c.Bal !== 0 || c.Width !== 1 || c.Mono || c.RevOn) return false;
  for (const b of c.Bands) if (!(b.Gain === 0 && (b.Type === 'peaking' || b.Type === 'lowshelf' || b.Type === 'highshelf'))) return false;
  return true;
}

// RBJ cookbook biquad, Direct Form II Transposed in double. Coefficients glide linearly over ~20 ms to new targets.
class Biquad {
  constructor() { this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = 0; this.t0 = 1; this.t1 = this.t2 = this.t3 = this.t4 = 0; this.d0 = this.d1 = this.d2 = this.d3 = this.d4 = 0; this.n = 0; this.zl1 = this.zl2 = this.zr1 = this.zr2 = 0; }
  // identity coefficients and no state left: running it would change nothing
  get Identity() { return this.n === 0 && this.b0 === 1 && this.b1 === 0 && this.b2 === 0 && this.a1 === 0 && this.a2 === 0 && this.zl1 === 0 && this.zl2 === 0 && this.zr1 === 0 && this.zr2 === 0; }
  static coef(type, fs, freq, gainDb, q) {
    if (gainDb === 0 && (type === 'peaking' || type === 'lowshelf' || type === 'highshelf')) return [1, 0, 0, 0, 0]; // exact identity
    const w = 2 * Math.PI * clamp(freq, 10, fs * 0.45) / fs, c = Math.cos(w), Q = clamp(q === 0 ? 0.71 : q, 0.1, 30);
    const al = Math.sin(w) / (2 * Q), A = Math.pow(10, clamp(gainDb, -60, 60) / 40), sa = 2 * Math.sqrt(A) * al;
    let B0, B1, B2, A0, A1, A2;
    switch (type) {
      case 'lowshelf':
        B0 = A * ((A + 1) - (A - 1) * c + sa); B1 = 2 * A * ((A - 1) - (A + 1) * c); B2 = A * ((A + 1) - (A - 1) * c - sa);
        A0 = (A + 1) + (A - 1) * c + sa; A1 = -2 * ((A - 1) + (A + 1) * c); A2 = (A + 1) + (A - 1) * c - sa; break;
      case 'highshelf':
        B0 = A * ((A + 1) + (A - 1) * c + sa); B1 = -2 * A * ((A - 1) + (A + 1) * c); B2 = A * ((A + 1) + (A - 1) * c - sa);
        A0 = (A + 1) - (A - 1) * c + sa; A1 = 2 * ((A - 1) - (A + 1) * c); A2 = (A + 1) - (A - 1) * c - sa; break;
      case 'lowpass': B0 = (1 - c) / 2; B1 = 1 - c; B2 = (1 - c) / 2; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; break;
      case 'highpass': B0 = (1 + c) / 2; B1 = -(1 + c); B2 = (1 + c) / 2; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; break;
      case 'notch': B0 = 1; B1 = -2 * c; B2 = 1; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; break;
      case 'bandpass': B0 = al; B1 = 0; B2 = -al; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; break;
      case 'allpass': B0 = 1 - al; B1 = -2 * c; B2 = 1 + al; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; break;
      default: // peaking
        B0 = 1 + al * A; B1 = -2 * c; B2 = 1 - al * A; A0 = 1 + al / A; A1 = -2 * c; A2 = 1 - al / A; break;
    }
    return [B0 / A0, B1 / A0, B2 / A0, A1 / A0, A2 / A0];
  }
  target(k, glide) {
    if (glide <= 0 || (this.n === 0 && k[0] === this.b0 && k[1] === this.b1 && k[2] === this.b2 && k[3] === this.a1 && k[4] === this.a2)) {
      this.b0 = this.t0 = k[0]; this.b1 = this.t1 = k[1]; this.b2 = this.t2 = k[2]; this.a1 = this.t3 = k[3]; this.a2 = this.t4 = k[4]; this.n = 0; return;
    }
    this.t0 = k[0]; this.t1 = k[1]; this.t2 = k[2]; this.t3 = k[3]; this.t4 = k[4]; const n = this.n = glide;
    this.d0 = (this.t0 - this.b0) / n; this.d1 = (this.t1 - this.b1) / n; this.d2 = (this.t2 - this.b2) / n; this.d3 = (this.t3 - this.a1) / n; this.d4 = (this.t4 - this.a2) / n;
  }
  reset() { this.zl1 = this.zl2 = this.zr1 = this.zr2 = 0; }
  run(x, frames) {
    let { b0, b1, b2, a1, a2, n, zl1, zl2, zr1, zr2 } = this;
    for (let i = 0, j = 0; i < frames; i++, j += 2) {
      if (n > 0) { if (--n === 0) { b0 = this.t0; b1 = this.t1; b2 = this.t2; a1 = this.t3; a2 = this.t4; } else { b0 += this.d0; b1 += this.d1; b2 += this.d2; a1 += this.d3; a2 += this.d4; } }
      let v = x[j], o = b0 * v + zl1; zl1 = b1 * v - a1 * o + zl2; zl2 = b2 * v - a2 * o; x[j] = o;
      v = x[j + 1]; o = b0 * v + zr1; zr1 = b1 * v - a1 * o + zr2; zr2 = b2 * v - a2 * o; x[j + 1] = o;
    }
    if (Math.abs(zl1) < 1e-300) zl1 = 0; if (Math.abs(zl2) < 1e-300) zl2 = 0; if (Math.abs(zr1) < 1e-300) zr1 = 0; if (Math.abs(zr2) < 1e-300) zr2 = 0;
    this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2; this.n = n; this.zl1 = zl1; this.zl2 = zl2; this.zr1 = zr1; this.zr2 = zr2;
  }
}

// one-pole glide toward a target (like AudioParam.setTargetAtTime), snapping when close so neutral values become exact
class Smooth {
  constructor(v, tau, fs) { this.V = this.T = v; this.K = 1 - Math.exp(-1 / (tau * fs)); }
  next() { if (this.V !== this.T) { this.V += (this.T - this.V) * this.K; if (Math.abs(this.T - this.V) < 1e-12) this.V = this.T; } return this.V; }
  get Settled() { return this.V === this.T; }
}

const BLK = 256, SLOTS = 3 + 64; // give-back slots: 0 preamp, 1 bass, 2 treble, 3.. EQ bands
const ID = [1, 0, 0, 0, 0];
const boosts = (type, gain) => gain > 0 && (type === 'peaking' || type === 'lowshelf' || type === 'highshelf');
const pair = (c, b, k, boost, glide) => { c.target(boost ? ID : k, glide); b.target(boost ? k : ID, glide); };

export class Dsp {
  constructor(rate) {
    this.Rate = rate; this.Cfg = parseConfig('');
    // every gain filter has two instances: one in the cut chain, one in the boost chain. A band that boosts runs in the boost chain
    // (its cut twin glides to identity), so a band crossing 0 dB moves over without a click
    this.cutQ = []; this.boostQ = [];
    this.bassC = new Biquad(); this.bassB = new Biquad(); this.trebC = new Biquad(); this.trebB = new Biquad();
    this.pre = new Smooth(1, 0.02, rate); this.bal = new Smooth(0, 0.02, rate); this.vol = new Smooth(1, 0.015, rate); this.stream = new Smooth(1, 0.02, rate);
    this.wet = new Smooth(0, 0.03, rate); this.dry = new Smooth(1, 0.03, rate);
    this.Width = 1; this.Mono = false;
    this.lim = new Limiter(rate, SLOTS);
    this.s0 = new Float64Array(2 * BLK); this.acc = new Float64Array(2 * BLK); this.tmp = new Float64Array(2 * BLK); this.gp = new Float64Array(BLK);
    this.dk = Array.from({ length: SLOTS }, () => new Float64Array(2 * BLK)); this.live = new Uint8Array(SLOTS);
    this.rev = null; this.building = null; this.fresh = true; this.Sanitized = 0; this.Exact = false;
    this.tap = null; // optional: post-EQ, pre-balance copy of the signal for visualizers (shared output only)
  }
  get Latency() { return this.lim.L + (this.rev ? this.rev.B : 0); }
  get ReverbReady() { return !!this.rev; }
  get Lim() { return this.lim; }
  set StreamGain(v) { this.stream.T = v; }
  set Volume(v) { this.vol.T = v; }

  // nothing in flight and every stage neutral: output equals input exactly
  get Neutral() {
    const { pre, bal, vol, stream } = this;
    if (!cfgNeutral(this.Cfg) || this.rev || !pre.Settled || !bal.Settled || !vol.Settled || !stream.Settled || vol.V !== 1 || stream.V !== 1 || pre.V !== 1) return false;
    for (const b of this.cutQ) if (!b.Identity) return false;
    for (const b of this.boostQ) if (!b.Identity) return false;
    return this.bassC.Identity && this.bassB.Identity && this.trebC.Identity && this.trebB.Identity;
  }

  apply(c) {
    this.Cfg = c;
    const glide = Math.trunc(this.Rate * 0.02), R = this.Rate;
    while (this.cutQ.length < c.Bands.length) { this.cutQ.push(new Biquad()); this.boostQ.push(new Biquad()); }
    for (let i = 0; i < this.cutQ.length; i++) {
      if (i >= c.Bands.length) { pair(this.cutQ[i], this.boostQ[i], ID, false, glide); continue; } // removed bands glide out, pruned once flat
      const b = c.Bands[i]; pair(this.cutQ[i], this.boostQ[i], Biquad.coef(b.Type, R, b.Freq, b.Gain, b.Q), boosts(b.Type, b.Gain), glide);
    }
    pair(this.bassC, this.bassB, Biquad.coef('lowshelf', R, c.BassF, c.Bass, 0.7), c.Bass > 0, glide);
    pair(this.trebC, this.trebB, Biquad.coef('highshelf', R, c.TrebleF, c.Treble, 0.7), c.Treble > 0, glide);
    this.pre.T = Math.pow(10, c.Pre / 20); this.bal.T = c.Bal; this.Width = c.Width; this.Mono = c.Mono;
    this.lim.Ceil = Math.pow(10, c.Ceil / 20);
    if (!c.RevOn) { this.rev = null; this.building = null; } // shortcut: toggling reverb shifts the output by its block latency
    else if (this.rev && this.rev.same(c)) this.rev.params(c);
    else if (!this.building || !this.building.rev.same(c)) this.building = Reverb.build(R, c); // built a step per render quantum
    this.wet.T = c.RevOn ? c.Mix : 0; this.dry.T = 1 - (c.RevOn ? c.Mix : 0) * 0.45;
  }

  // EQ + tone magnitude (dB) at f, from the target coefficients
  responseDb(f) {
    const c = this.Cfg, R = this.Rate; let s = 0;
    for (const b of c.Bands) s += biquadDb(Biquad.coef(b.Type, R, b.Freq, b.Gain, b.Q), f, R);
    s += biquadDb(Biquad.coef('lowshelf', R, c.BassF, c.Bass, 0.7), f, R);
    s += biquadDb(Biquad.coef('highshelf', R, c.TrebleF, c.Treble, 0.7), f, R);
    return s;
  }
  // the most the preamp + EQ + tone can lift any frequency (dB, >= 0)
  boostDb() {
    let m = 0;
    for (let f = 20; f <= 20000 && f < this.Rate * 0.45; f *= 1.03) m = Math.max(m, this.Cfg.Pre + this.responseDb(f));
    return m;
  }
  // a new impulse response is built a little per call (a whole one would stall the audio thread), swapped in when ready
  step() {
    const b = this.building;
    if (!b || !b.it.next().done) return;
    this.building = null;
    if (!this.Cfg.RevOn) return;
    if (b.rev.same(this.Cfg)) { this.rev = b.rev; this.rev.params(this.Cfg); } else this.building = Reverb.build(this.Rate, this.Cfg); // settings moved on
  }

  reset() {
    for (const b of this.cutQ) b.reset(); for (const b of this.boostQ) b.reset();
    this.bassC.reset(); this.bassB.reset(); this.trebC.reset(); this.trebB.reset();
    this.lim.reset(); this.fresh = true;
    if (this.rev) this.rev.reset();
  }

  // x: interleaved stereo Float64Array, in place
  process(x, frames) {
    if (this.building) this.step();
    // a fresh stream starts at its settings, not gliding in from unity (a gliding volume would be limited for a moment)
    if (this.fresh) { this.fresh = false; for (const s of [this.pre, this.bal, this.vol, this.stream]) s.V = s.T; }
    // NaN/Inf from a broken decoder would poison every filter state for good: replace with silence
    for (let i = 0; i < 2 * frames; i++) if (x[i] - x[i] !== 0) { x[i] = 0; this.Sanitized++; }
    let exact = true;
    for (let at = 0; at < frames; at += BLK) exact = this.block(x, at, Math.min(BLK, frames - at)) && exact;
    this.Exact = exact;
    const { cutQ, boostQ } = this;
    while (cutQ.length > this.Cfg.Bands.length && cutQ[cutQ.length - 1].Identity && boostQ[boostQ.length - 1].Identity) { cutQ.pop(); boostQ.pop(); }
  }

  // one link of the boost chain: d = B(acc) - acc, acc = B(acc)
  boost(b, slot, n) {
    if (b.Identity) return;
    const { acc, tmp } = this, d = this.dk[slot];
    tmp.set(acc.subarray(0, 2 * n)); b.run(tmp, n);
    for (let j = 0; j < 2 * n; j++) d[j] = tmp[j] - acc[j];
    acc.set(tmp.subarray(0, 2 * n)); this.live[slot] = 1;
  }

  block(x, at, n) {
    const neutral = this.Neutral, { s0, acc, gp, dk, live } = this;
    s0.set(x.subarray(2 * at, 2 * at + 2 * n));
    live.fill(0);
    if (!neutral) {
      // stream gain and the cutting part of the preamp go into the base signal; a preamp boost is give-back slot 0
      let preUp = false;
      const W = this.Width, mono = this.Mono;
      for (let i = 0, j = 0; i < n; i++, j += 2) {
        const p = this.pre.next(), g = this.stream.next() * (p < 1 ? p : 1);
        let l = s0[j] * g, r = s0[j + 1] * g;
        if (W !== 1 || mono) { const m = (l + r) * 0.5, sd = (l - r) * 0.5 * (mono ? 0 : W); l = m + sd; r = m - sd; }
        s0[j] = l; s0[j + 1] = r; gp[i] = p > 1 ? p : 1; if (p > 1) preUp = true;
      }
      // cut chain: the signal with every boost taken out
      for (const b of this.cutQ) if (!b.Identity) b.run(s0, n);
      if (!this.bassC.Identity) this.bassC.run(s0, n);
      if (!this.trebC.Identity) this.trebC.run(s0, n);
      // boost chain, telescoped: s0 + d_pre + d_1 + ... is exactly the EQ that was asked for, and each d holds only what its boost adds
      acc.set(s0.subarray(0, 2 * n));
      if (preUp) { const d = dk[0]; for (let i = 0, j = 0; i < n; i++, j += 2) { const k = gp[i] - 1; d[j] = acc[j] * k; d[j + 1] = acc[j + 1] * k; acc[j] += d[j]; acc[j + 1] += d[j + 1]; } live[0] = 1; }
      for (let i = 0; i < this.boostQ.length; i++) this.boost(this.boostQ[i], 3 + i, n);
      this.boost(this.bassB, 1, n); this.boost(this.trebB, 2, n);
      if (this.tap) this.tap.set(acc.subarray(0, 2 * n), 2 * at);
      // balance and volume are memoryless and linear: applied to every part exactly
      for (let i = 0, j = 0; i < n; i++, j += 2) {
        const p = this.bal.next(), v = this.vol.next();
        if (p === 0) { this.scale(j, v); continue; }
        // StereoPannerNode, equal power, stereo input
        if (p <= 0) { const a = (p + 1) * Math.PI / 2; this.pan(j, v, v * Math.cos(a), v * Math.sin(a), true); }
        else { const a = p * Math.PI / 2; this.pan(j, v, v * Math.cos(a), v * Math.sin(a), false); }
      }
      // reverb: the wet part cannot be split into boosts, so with reverb on everything goes to the base signal
      if (this.rev) {
        for (let k = 0; k < SLOTS; k++) if (live[k]) { const d = dk[k]; for (let j = 0; j < 2 * n; j++) s0[j] += d[j]; live[k] = 0; }
        this.rev.run(s0, n, this.wet, this.dry);
      }
    } else if (this.tap) this.tap.set(s0.subarray(0, 2 * n), 2 * at);
    const on = !neutral && this.Cfg.Lim;
    return this.lim.process(s0, dk, live, n, x, at, on, on || this.Cfg.Guard) && neutral;
  }
  scale(j, v) {
    if (v === 1) return;
    const { s0, dk, live } = this;
    s0[j] *= v; s0[j + 1] *= v;
    for (let k = 0; k < SLOTS; k++) if (live[k]) { dk[k][j] *= v; dk[k][j + 1] *= v; }
  }
  // left (p <= 0): L' = v(l + r cos), R' = v r sin; right: L' = v l cos, R' = v(r + l sin)
  pan(j, v, vc, vs, left) {
    pan1(this.s0, j, v, vc, vs, left);
    for (let k = 0; k < SLOTS; k++) if (this.live[k]) pan1(this.dk[k], j, v, vc, vs, left);
  }
}
function pan1(a, j, v, vc, vs, left) {
  const l = a[j], r = a[j + 1];
  if (left) { a[j] = v * l + vc * r; a[j + 1] = vs * r; } else { a[j] = vc * l; a[j + 1] = v * r + vs * l; }
}
export const biquadCoef = (type, fs, freq, gainDb, q) => Biquad.coef(type, fs, freq, gainDb, q);
// magnitude in dB at f
export function biquadDb(k, f, fs) {
  const w = 2 * Math.PI * f / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = k[0] + k[1] * c1 + k[2] * c2, ni = -(k[1] * s1 + k[2] * s2), dr = 1 + k[3] * c1 + k[4] * c2, di = -(k[3] * s1 + k[4] * s2);
  return 10 * Math.log10(Math.max(1e-24, (nr * nr + ni * ni) / (dr * dr + di * di)));
}

// Boost give-back limiter with true-peak detection (see native/dsp.cs for the design notes). The output is gB * (s0 + sum a_k d_k):
// stage A lowers only the boosts that push a peak over the ceiling; stage B is broadband on the actual output.
const H = 64, G = 4, PH = G - 1 + 4; // interpolator half length; G-1 positions between samples + 4 ITU phases
function I0(x) { let s = 1, t = 1; for (let k = 1; k < 40; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; } return s; }
// ITU-R BS.1770-4 Annex 2 example interpolator (4 phases, 12 taps)
const ITU0 = [0.0017089843750, 0.0109863281250, -0.0196533203125, 0.0332031250000, -0.0594482421875, 0.1373291015625, 0.9721679687500, -0.1022949218750, 0.0476074218750, -0.0266113281250, 0.0148925781250, -0.0083007812500];
const ITU1 = [-0.0291748046875, 0.0292968750000, -0.0517578125000, 0.0891113281250, -0.1665039062500, 0.4650878906250, 0.7797851562500, -0.2003173828125, 0.1015625000000, -0.0582275390625, 0.0330810546875, -0.0189208984375];
// kernels: value near the interval (m, m+1) = sum w[j] x[m + koff[p] + j]. KER finds the peak; KERS (32 taps) splits it into
// the boost parts' shares, which only set proportions: stage B holds the ceiling
const HS = 16, KOFF = new Int32Array(PH), KOFFS = new Int32Array(PH);
function kernel(h, beta, koff) {
  const ker = [];
  for (let p = 0; p < G - 1; p++) {
    const tau = (p + 1) / G, w = new Float64Array(2 * h); let sum = 0;
    for (let j = 0; j < 2 * h; j++) {
      const u = tau + h - 1 - j, r = u / h, sinc = Math.sin(Math.PI * u) / (Math.PI * u);
      w[j] = sinc * I0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / I0(beta); sum += w[j];
    }
    for (let j = 0; j < 2 * h; j++) w[j] /= sum; // exact at DC
    ker[p] = w; koff[p] = 1 - h;
  }
  // ITU y[4n+p] = sum h_p[k] x[n-k], taken at n = m + 6 so its window (m-5 .. m+6) lies inside the available samples
  const itu = [ITU0, ITU1, [...ITU1].reverse(), [...ITU0].reverse()];
  for (let p = 0; p < 4; p++) { ker[G - 1 + p] = Float64Array.from([...itu[p]].reverse()); koff[G - 1 + p] = -5; }
  return ker;
}
const KER = kernel(H, 9, KOFF), KERS = kernel(HS, 8, KOFFS);
// no kernel output can exceed KS times the largest sample in its window (+ the estimate bias)
const KS = Math.max(...KER.map(w => w.reduce((s, v) => s + Math.abs(v), 0))) * 1.0035;

// Rings here are per channel and mirrored (each sample written at i and i + R), so every kernel window is contiguous: the same
// sums in the same order as native/dsp.cs, without wrapping each index. `& M` is exact for any integer below 2^53.
class Limiter {
  constructor(rate, slots) {
    this.slots = slots; this.Ceil = Math.pow(10, -1.0 / 20);
    this.WA = Math.max(2, round(rate * 0.005)); this.WB = Math.max(2, round(rate * 0.003));
    this.L = 4 * H + this.WA + this.WB - 2;
    const need = 2 * H + Math.max(this.WA, this.WB) + 4; let rs = 1; while (rs < need) rs <<= 1; this.M = rs - 1; this.R = rs;
    const rel = Math.exp(-1 / (rate * 0.15)), two = () => [new Float64Array(2 * rs), new Float64Array(2 * rs)];
    this.s0R = new Float64Array(2 * rs); this.SR = two(); this.yR = two();
    // largest |sample| per 16-sample block of SR and yR, per channel: a cheap upper bound for the skip test in peak()
    this.NB = rs >> 4; const bm = () => [new Float64Array(this.NB), new Float64Array(this.NB)]; this.SRm = bm(); this.yRm = bm();
    this.dR = []; this.sm = []; this.lastNZ = new Float64Array(slots); this.alive = new Uint8Array(slots);
    for (let k = 0; k < slots; k++) { this.dR[k] = two(); this.sm[k] = new Smoother(this.WA, this.WA + 2 * H, rel); }
    this.smB = new Smoother(this.WB, this.WB + 2 * H, rel);
    this.needS = new Float64Array(slots); this.ivP = new Float64Array(slots).fill(1); this.ivC = new Float64Array(slots); this.dv = new Float64Array(slots); this.alpha = new Float64Array(slots); this.al = new Int32Array(slots);
    this.ivPB = 1; this.idx = 0; this.gv = new Float64Array(G + 1); this.pi = -1;
    this.Clamps = 0; this.Limited = 0; // samples the last-resort clamp moved by more than rounding (should stay 0), samples with any gain < 1
  }
  // shortcut: rings of slots that went quiet are cleared on revival, not on reset (they are dead, so never read)
  reset() {
    this.s0R.fill(0); for (const a of [...this.SR, ...this.yR, ...this.SRm, ...this.yRm]) a.fill(0);
    for (let k = 0; k < this.slots; k++) { this.alive[k] = 0; this.sm[k].reset(); }
    this.smB.reset(); this.ivPB = 1; this.idx = 0;
  }
  // value number p near the interval (m, m+1) of channel ring a
  interp(a, m, p, share = false) {
    const w = share ? KERS[p] : KER[p], o = (m + (share ? KOFFS[p] : KOFF[p])) & this.M; let s = 0;
    for (let j = 0; j < w.length; j++) s += w[j] * a[o + j];
    return s;
  }
  // the highest value between samples m and m+1 (signed): the G-grid maximum refined by a parabola through its neighbours, or
  // an ITU phase if that reads higher. Sets this.pi: the kernel it came from, -1 / -2 for sample m / m+1
  peak(a, bmax, m) {
    const M = this.M, gv = this.gv, NB = this.NB;
    gv[0] = a[m & M]; gv[G] = a[(m + 1) & M];
    // quick bound: when nothing in the window can reach the ceiling, the exact peak is not needed (callers only act above it).
    // Block maxima over-cover the window (whole blocks, maybe older samples): still an upper bound
    let amax = 0; for (let k = ((m + 1 - H) & M) >> 4, e = k + (2 * H >> 4) + 1; k < e; k++) { const v = bmax[k % NB]; if (v > amax) amax = v; }
    if (amax * KS <= this.Ceil) { this.pi = -1; return gv[0]; }
    for (let p = 0; p < G - 1; p++) gv[p + 1] = this.interp(a, m, p);
    let bi = 0; for (let i = 1; i <= G; i++) if (Math.abs(gv[i]) > Math.abs(gv[bi])) bi = i;
    let pk = Math.abs(gv[bi]), sg = gv[bi] < 0 ? -1 : 1;
    if (bi > 0 && bi < G) {
      const y0 = Math.abs(gv[bi - 1]), y1 = pk, y2 = Math.abs(gv[bi + 1]), den = y0 - 2 * y1 + y2;
      if (den < 0) { const d = 0.5 * (y0 - y2) / den; pk = y1 - 0.25 * (y0 - y2) * d; }
    }
    let pi = bi === 0 ? -1 : bi === G ? -2 : bi - 1;
    if (pi >= 0) pk *= 1.0035; // +0.03 dB: the measured worst grid + kernel error on music, so estimates err high
    for (let p = G - 1; p < PH; p++) { const v = this.interp(a, m, p); if (Math.abs(v) > pk) { pk = Math.abs(v); sg = v < 0 ? -1 : 1; pi = p; } }
    this.pi = pi;
    return sg * pk;
  }
  // stage A: the a_k this value (sum S, boost parts dv) needs
  alloc(S, nal, need) {
    const a = Math.abs(S), Ceil = this.Ceil, dv = this.dv, al = this.al; if (a <= Ceil) return;
    const sg = S > 0 ? 1 : -1; let C = 0;
    for (let i = 0; i < nal; i++) { const q = sg * dv[al[i]]; if (q > 0) C += q; }
    if (C <= 0) return;
    let f = (a - Ceil) / C; if (f > 1) f = 1;
    for (let i = 0; i < nal; i++) { const k = al[i]; if (sg * dv[k] > 0 && 1 - f < need[k]) need[k] = 1 - f; }
  }

  // returns true when every output sample is the delayed s0 untouched
  process(s0, d, live, n, outp, at, detA, detB) {
    const { M, R, slots, s0R, SR, yR, SRm, yRm, dR, sm, smB, lastNZ, alive, needS, ivP, ivC, dv, alpha, al, WA, WB, Ceil } = this;
    const [SL, SRr] = SR, [YL, YR] = yR;
    let exact = true;
    for (let i = 0; i < n; i++, this.idx++) {
      const idx = this.idx, iw = idx & M;
      let S0 = s0[2 * i], S1 = s0[2 * i + 1];
      s0R[2 * iw] = S0; s0R[2 * iw + 1] = S1;
      let nal = 0;
      for (let k = 0; k < slots; k++) {
        if (live[k]) {
          const [dl, dr] = dR[k];
          if (!alive[k]) { alive[k] = 1; dl.fill(0); dr.fill(0); sm[k].reset(); ivP[k] = 1; }
          const a = d[k][2 * i], b = d[k][2 * i + 1]; dl[iw] = dl[iw + R] = a; dr[iw] = dr[iw + R] = b; S0 += a; S1 += b;
          if (a !== 0 || b !== 0) lastNZ[k] = idx;
        } else if (alive[k]) {
          const [dl, dr] = dR[k]; dl[iw] = dl[iw + R] = 0; dr[iw] = dr[iw + R] = 0;
          if (idx - lastNZ[k] > M && sm[k].Idle) { alive[k] = 0; continue; }
        } else continue;
        al[nal++] = k;
      }
      SL[iw] = SL[iw + R] = S0; SRr[iw] = SRr[iw + R] = S1;
      { const bk = iw >> 4, a0 = Math.abs(S0), a1 = Math.abs(S1); if ((iw & 15) === 0) { SRm[0][bk] = a0; SRm[1][bk] = a1; } else { if (a0 > SRm[0][bk]) SRm[0][bk] = a0; if (a1 > SRm[1][bk]) SRm[1][bk] = a1; } }
      // stage A at sample m = idx - H (the interpolator needs H samples after it)
      const m = idx - H;
      if (nal > 0) {
        if (detA) {
          const im = m & M;
          for (let q = 0; q < nal; q++) { needS[al[q]] = 1; ivC[al[q]] = 1; }
          for (let ch = 0; ch < 2; ch++) {
            const S = SR[ch];
            for (let q = 0; q < nal; q++) dv[al[q]] = dR[al[q]][ch][im];
            this.alloc(S[im], nal, needS);
            const sp = this.peak(S, SRm[ch], m), pi = this.pi;
            if (Math.abs(sp) > Ceil) {
              // shares of the boost parts at the point where the over peaks
              for (let q = 0; q < nal; q++) { const r = dR[al[q]][ch]; dv[al[q]] = pi >= 0 ? this.interp(r, m, pi, true) : r[(m + (pi === -2 ? 1 : 0)) & M]; }
              this.alloc(sp, nal, ivC);
            }
          }
          // an over between m and m+1 is charged to both samples
          for (let q = 0; q < nal; q++) { const k = al[q]; const nd = Math.min(needS[k], Math.min(ivP[k], ivC[k])); ivP[k] = ivC[k]; alpha[k] = sm[k].push(nd); }
        } else for (let q = 0; q < nal; q++) { const k = al[q]; ivP[k] = 1; alpha[k] = sm[k].push(1); }
      }
      // the gains just computed belong to sample mo
      const mo = m - WA + 1 - H, io = mo & M;
      let y0 = s0R[2 * io], y1 = s0R[2 * io + 1], cut = false;
      for (let q = 0; q < nal; q++) { const k = al[q], a = alpha[k], [dl, dr] = dR[k]; y0 += a * dl[io]; y1 += a * dr[io]; if (a !== 1) cut = true; }
      if (nal > 0) exact = false;
      YL[io] = YL[io + R] = y0; YR[io] = YR[io + R] = y1;
      { const bk = io >> 4, a0 = Math.abs(y0), a1 = Math.abs(y1); if ((io & 15) === 0) { yRm[0][bk] = a0; yRm[1][bk] = a1; } else { if (a0 > yRm[0][bk]) yRm[0][bk] = a0; if (a1 > yRm[1][bk]) yRm[1][bk] = a1; } }
      // stage B at sample mb, on the actual output
      const mb = mo - H; let g;
      if (detB) {
        const ib = mb & M; let nd = 1, iv = 1;
        for (let ch = 0; ch < 2; ch++) {
          const Y = yR[ch];
          let a = Math.abs(Y[ib]); if (a > Ceil && Ceil / a < nd) nd = Ceil / a;
          a = Math.abs(this.peak(Y, yRm[ch], mb)); if (a > Ceil && Ceil / a < iv) iv = Ceil / a;
        }
        g = smB.push(Math.min(nd, Math.min(this.ivPB, iv))); this.ivPB = iv;
      } else { g = smB.push(1); this.ivPB = 1; }
      const iq = (mb - WB + 1 - H) & M, j = 2 * (at + i);
      let o0 = YL[iq], o1 = YR[iq];
      if (g !== 1) { o0 *= g; o1 *= g; exact = false; cut = true; }
      if (cut) this.Limited++;
      if (detB) {
        if (o0 > Ceil) { if (o0 > Ceil * (1 + 1e-9)) this.Clamps++; o0 = Ceil; } else if (o0 < -Ceil) { if (o0 < -Ceil * (1 + 1e-9)) this.Clamps++; o0 = -Ceil; }
        if (o1 > Ceil) { if (o1 > Ceil * (1 + 1e-9)) this.Clamps++; o1 = Ceil; } else if (o1 < -Ceil) { if (o1 < -Ceil * (1 + 1e-9)) this.Clamps++; o1 = -Ceil; }
      }
      outp[j] = o0; outp[j + 1] = o1;
    }
    return exact;
  }
}

// gain smoothing that never overshoots: min-hold over the last `hold` needs, release toward 1, then a W-long moving average.
class Smoother {
  constructor(w, hold, rel) {
    this.W = w; this.HW = hold; this.rel = rel; this.ring = new Float64Array(w); this.cap = hold + 1;
    this.dv = new Float64Array(this.cap); this.di = new Float64Array(this.cap); this.n = 0; this.reset();
  }
  reset() { this.ring.fill(1); this.sum = this.W; this.non1 = 0; this.r = 1; this.h = this.t = this.cnt = 0; this.pos = 0; }
  get Idle() { return this.non1 === 0 && this.r === 1 && this.cnt === 0; }
  push(need) {
    const n = ++this.n, cap = this.cap, dv = this.dv, di = this.di;
    if (need >= 1 && this.Idle) return 1;
    if (need < 1) { while (this.cnt > 0 && dv[(this.t - 1 + cap) % cap] >= need) { this.t = (this.t - 1 + cap) % cap; this.cnt--; } dv[this.t] = need; di[this.t] = n; this.t = (this.t + 1) % cap; this.cnt++; }
    while (this.cnt > 0 && di[this.h] <= n - this.HW) { this.h = (this.h + 1) % cap; this.cnt--; }
    // release aims a little past 1 so it lands on exactly 1 in finite time (a plain exponential would take ~4 s to snap)
    const held = this.cnt > 0 ? dv[this.h] : 1; let up = 1.001 - (1.001 - this.r) * this.rel;
    if (up > 1) up = 1;
    const r = this.r = held < up ? held : up;
    const old = this.ring[this.pos]; this.ring[this.pos] = r; if (++this.pos === this.W) this.pos = 0;
    if (old !== 1) this.non1--; if (r !== 1) this.non1++;
    if (this.non1 === 0) { this.sum = this.W; return 1; }
    this.sum += r - old;
    if (this.pos === 0) { let s = 0; for (let i = 0; i < this.W; i++) s += this.ring[i]; this.sum = s; } // no drift
    return this.sum / this.W;
  }
}

// seeded noise for the reverb IR (mulberry32), the same sequence as native/dsp.cs
function noise(seed) {
  let a = seed | 0;
  return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// Reverb like the Web Audio graph used to be: pre-delay -> convolver (generated stereo noise IR, Web Audio normalization) +
// pre-delay tap -> lowpass, mixed with the dry signal. Uniform partitioned FFT convolution (overlap-save), latency B frames.
class Reverb {
  // a generator that builds it in small steps; .rev is usable once the generator is done
  static build(rate, c) {
    const rev = Object.create(Reverb.prototype);
    rev.size = c.Size; rev.damp = c.Damp; rev.fade = c.Fade;
    return { rev, it: rev.init(rate, c) };
  }
  same(c) { return Math.abs(c.Size - this.size) < 1e-4 && Math.abs(c.Damp - this.damp) < 1e-4 && Math.abs(c.Fade - this.fade) < 1e-4; }
  *init(rate, c) {
    this.rate = rate; this.size = c.Size; this.damp = c.Damp; this.fade = c.Fade;
    let b = 1; while (b < rate * 0.08) b <<= 1; const B = this.B = b, N = this.N = 2 * B;
    this.fft = new Fft(N);
    // the IR: decaying noise, high frequencies die faster
    const len = Math.floor(rate * (0.25 + c.Size * 5.5)), decay = 6.5 - c.Fade * 5, rnd = noise(1234);
    const ir = [new Float64Array(len), new Float64Array(len)]; let pow = 0;
    for (let ch = 0; ch < 2; ch++) {
      let lpv = 0; const d = ir[ch];
      for (let i = 0; i < len; i++) {
        const x = i / len, nz = (rnd() * 2 - 1) * Math.pow(1 - x, decay), k = 1 - Math.min(0.97, c.Damp * x * 1.2);
        lpv += (nz - lpv) * k; d[i] = lpv; pow += lpv * lpv;
        if ((i & 16383) === 16383) yield;
      }
    }
    // ConvolverNode normalize = true (Web Audio spec): 1 / rms * 0.00125 * 44100 / rate
    pow = Math.sqrt(pow / (2.0 * len)); if (pow < 0.000125) pow = 0.000125;
    const scale = 1 / pow * 0.00125 * 44100.0 / rate;
    const P = this.P = Math.trunc((len + B - 1) / B);
    this.hre = []; this.him = []; this.xre = []; this.xim = [];
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let p = 0; p < P; p++) {
      re.fill(0); im.fill(0);
      for (let i = 0; i < B && p * B + i < len; i++) { re[i] = ir[0][p * B + i] * scale; im[i] = ir[1][p * B + i] * scale; }
      this.fft.run(re, im, false);
      this.hre[p] = new Float64Array(2 * (B + 1)); this.him[p] = new Float64Array(2 * (B + 1));
      this.split(re, im, this.hre[p], this.him[p]);
      this.xre[p] = new Float64Array(2 * (B + 1)); this.xim[p] = new Float64Array(2 * (B + 1));
      yield;
    }
    this.head = 0; this.pos = 0;
    this.inL = new Float64Array(N); this.inR = new Float64Array(N); this.outL = new Float64Array(B); this.outR = new Float64Array(B);
    this.yre = new Float64Array(N); this.yim = new Float64Array(N); this.wre = new Float64Array(2 * (B + 1)); this.wim = new Float64Array(2 * (B + 1));
    this.pd = new Float64Array(2 * (Math.trunc(rate * 0.3) + 1)); this.pdp = 0;
    this.tap = new Float64Array(2 * B); this.dryD = new Float64Array(2 * B);
    this.lp = new Biquad(); this.wbuf = new Float64Array(0);
    this.params(c);
  }
  params(c) {
    this.pdLen = Math.min(this.pd.length / 2 - 1, round(c.PreDelay * 0.3 * this.rate));
    this.tapGain = c.PreDelayMix * 0.6;
    // Web Audio lowpass reads Q as dB: Q 0.5 dB -> linear 10^(0.5/20)
    this.lp.target(Biquad.coef('lowpass', this.rate, 800 + c.Filter * c.Filter * 19000, 0, Math.pow(10, 0.5 / 20)), Math.trunc(this.rate * 0.02));
  }
  reset() {
    for (let p = 0; p < this.P; p++) { this.xre[p].fill(0); this.xim[p].fill(0); }
    this.inL.fill(0); this.inR.fill(0); this.outL.fill(0); this.outR.fill(0);
    this.pd.fill(0); this.tap.fill(0); this.dryD.fill(0); this.pos = 0; this.pdp = 0; this.lp.reset();
  }
  // full complex spectrum of (l + i r) -> separate half spectra of l and r: dst[0..B] = L, dst[B+1..2B+1] = R
  split(re, im, dre, dim) {
    const B = this.B, N = this.N;
    for (let k = 0; k <= B; k++) {
      const m = (N - k) % N;
      dre[k] = (re[k] + re[m]) / 2; dim[k] = (im[k] - im[m]) / 2;          // L
      dre[B + 1 + k] = (im[k] + im[m]) / 2; dim[B + 1 + k] = (re[m] - re[k]) / 2; // R
    }
  }
  block() {
    const { B, N, P, yre, yim, wre, wim, inL, inR } = this;
    // newest input spectrum into the delay line
    this.head = (this.head + P - 1) % P;
    yre.set(inL); yim.set(inR);
    this.fft.run(yre, yim, false);
    this.split(yre, yim, this.xre[this.head], this.xim[this.head]);
    wre.fill(0); wim.fill(0);
    const M = 2 * (B + 1);
    for (let p = 0; p < P; p++) {
      const ar = this.xre[(this.head + p) % P], ai = this.xim[(this.head + p) % P], br = this.hre[p], bi = this.him[p];
      for (let k = 0; k < M; k++) { const r = ar[k], i = ai[k], hr = br[k], hi = bi[k]; wre[k] += r * hr - i * hi; wim[k] += r * hi + i * hr; }
    }
    // Y = YL + i YR (both spectra of real signals), then the real part is yl, the imaginary part yr
    for (let k = 0; k <= B; k++) {
      const lr = wre[k], li = wim[k], rr = wre[B + 1 + k], ri = wim[B + 1 + k];
      yre[k] = lr - ri; yim[k] = li + rr;
      if (k > 0 && k < B) { yre[N - k] = lr + ri; yim[N - k] = -li + rr; }
    }
    this.fft.run(yre, yim, true);
    for (let i = 0; i < B; i++) { this.outL[i] = yre[B + i]; this.outR[i] = yim[B + i]; }
    // slide the input window
    inL.copyWithin(0, B, N); inR.copyWithin(0, B, N);
  }
  run(x, frames, wet, dry) {
    const pd = this.pd, pl = pd.length, B = this.B, tap = this.tap, dryD = this.dryD;
    if (this.wbuf.length < 2 * frames) this.wbuf = new Float64Array(2 * frames);
    const wbuf = this.wbuf;
    for (let i = 0, j = 0; i < frames; i++, j += 2) {
      const l = x[j], r = x[j + 1];
      // pre-delay
      const rp = (this.pdp - 2 * this.pdLen + pl) % pl;
      const pl0 = this.pdLen === 0 ? l : pd[rp], pr0 = this.pdLen === 0 ? r : pd[rp + 1];
      pd[this.pdp] = l; pd[this.pdp + 1] = r; this.pdp = (this.pdp + 2) % pl;
      // block convolution: this block's result plays one block later; the pre-delay tap and the dry signal are delayed to match
      const q = 2 * this.pos;
      wbuf[j] = this.outL[this.pos] + tap[q] * this.tapGain; wbuf[j + 1] = this.outR[this.pos] + tap[q + 1] * this.tapGain;
      const dl = dryD[q], dr = dryD[q + 1];
      tap[q] = pl0; tap[q + 1] = pr0; dryD[q] = l; dryD[q + 1] = r;
      this.inL[B + this.pos] = pl0; this.inR[B + this.pos] = pr0;
      if (++this.pos === B) { this.block(); this.pos = 0; }
      x[j] = dl; x[j + 1] = dr;
    }
    this.lp.run(wbuf, frames); // the wet part only
    for (let i = 0, j = 0; i < frames; i++, j += 2) { const wg = wet.next(), dg = dry.next(); x[j] = x[j] * dg + wbuf[j] * wg; x[j + 1] = x[j + 1] * dg + wbuf[j + 1] * wg; }
  }
}

// iterative radix-2 complex FFT
class Fft {
  constructor(n) {
    this.n = n; this.rev = new Int32Array(n); this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
    let bits = 0; while ((1 << bits) < n) bits++;
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if ((i & (1 << b)) !== 0) r |= 1 << (bits - 1 - b); this.rev[i] = r; }
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = Math.sin(2 * Math.PI * i / n); }
  }
  run(re, im, inverse) {
    const n = this.n, rev = this.rev, cos = this.cos, sin = this.sin;
    for (let i = 0; i < n; i++) { const r = rev[i]; if (r > i) { let t = re[i]; re[i] = re[r]; re[r] = t; t = im[i]; im[i] = im[r]; im[r] = t; } }
    const sg = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let s = 0; s < n; s += size)
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cos[t], wi = sg * sin[t], a = s + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        }
    }
    if (inverse) { const k = 1.0 / n; for (let i = 0; i < n; i++) { re[i] *= k; im[i] *= k; } }
  }
}

// AudioWorklet: input = the player's stereo output; output 0 = processed, output 1 = post-EQ copy for visualizers.
// Messages: { dsp: text } (DspConfig format above), { volume: gain }, { reset: true }. Posts { latency } when it changes.
if (typeof registerProcessor === 'function') {
  registerProcessor('cadence-dsp', class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.dsp = new Dsp(sampleRate); this.buf = new Float64Array(2 * 128); this.dsp.tap = new Float64Array(2 * 128); this.lat = -1;
      this.port.onmessage = ({ data: m }) => {
        if (m.dsp != null) this.dsp.apply(parseConfig(m.dsp));
        if (m.volume != null) this.dsp.Volume = m.volume;
        if (m.reset) this.dsp.reset();
      };
    }
    process(inputs, outputs) {
      const inp = inputs[0], out = outputs[0], tap = outputs[1], n = out[0].length;
      if (this.buf.length < 2 * n) { this.buf = new Float64Array(2 * n); this.dsp.tap = new Float64Array(2 * n); }
      const x = this.buf, l = inp[0], r = inp[1] || inp[0];
      for (let i = 0; i < n; i++) { x[2 * i] = l ? l[i] : 0; x[2 * i + 1] = r ? r[i] : 0; }
      this.dsp.process(x, n);
      const t = this.dsp.tap;
      for (let i = 0; i < n; i++) {
        out[0][i] = x[2 * i]; out[1][i] = x[2 * i + 1];
        if (tap) { tap[0][i] = t[2 * i]; tap[1][i] = t[2 * i + 1]; }
      }
      if (this.dsp.Latency !== this.lat) { this.lat = this.dsp.Latency; this.port.postMessage({ latency: this.lat }); }
      return true;
    }
  });
}
