// PCM player: pulls interleaved f32 stereo chunks per stream, does gapless hand-off,
// equal-power crossfades, per-stream gain (ReplayGain) and stereo width.
class Stream {
  constructor(id, gain) {
    this.id = id; this.q = []; this.off = 0; this.buffered = 0;
    this.ended = false; this.frames = 0; this.consumed = 0; this.gain = gain;
  }
}

class CadenceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.streams = new Map();
    this.cur = null; this.next = null; this.xf = null;
    this.playing = false; this.width = 1; this.autoXf = 0; this.mono = false;
    this.silence = 0; this.gapFrames = 0;
    this.sinceReport = 0; this.starved = false;
    this.port.onmessage = e => this.onMsg(e.data);
  }

  onMsg(m) {
    const s = this.streams.get(m.id);
    switch (m.type) {
      case 'open': this.streams.set(m.id, new Stream(m.id, m.gain)); break;
      case 'data': if (s) { s.q.push(m.data); s.buffered += m.data.length >> 1; } break;
      case 'end': if (s) s.ended = true; break;
      case 'close':
        // the engine may close a stream the worklet has already promoted (gapless/crossfade in flight):
        // never cut the audible stream here; 'play'/'stop' replace it explicitly
        if (this.cur === m.id) break;
        this.streams.delete(m.id);
        if (this.next === m.id) { this.next = null; this.xf = null; }
        break;
      case 'stop': this.streams.clear(); this.cur = this.next = null; this.xf = null; this.silence = 0; break;
      case 'gap': this.gapFrames = m.frames; break;
      case 'play': if (this.cur !== m.id) this.drop(this.cur); if (this.next !== m.id) this.drop(this.next); this.cur = m.id; this.next = null; this.xf = null; break;
      case 'queue':
        if (this.xf) break; // never replace a stream that is fading in
        if (this.next !== m.id) this.drop(this.next);
        this.next = m.id; this.nextXf = m.xf ?? true;
        break;
      case 'mono': this.mono = m.value; break;
      case 'fadeTo': // manual skip with crossfade
        if (this.next && this.next !== m.id) this.drop(this.next);
        this.next = m.id;
        if (this.cur) this.xf = { pos: 0, len: m.frames }; else { this.cur = m.id; this.next = null; }
        break;
      case 'playing': this.playing = m.value; break;
      case 'gain': if (s) s.gain = m.gain; break;
      case 'width': this.width = m.value; break;
      case 'autoXf': this.autoXf = m.frames; break;
    }
  }

  drop(id) {
    if (id == null) return;
    this.streams.delete(id);
    this.port.postMessage({ type: 'dropped', id });
  }

  // additively mixes up to `count` frames of `s` into L/R at `at`, gain ramped g0 -> g1
  pull(s, L, R, at, count, g0, g1) {
    let i = 0;
    const step = (g1 - g0) / count;
    while (i < count && s.q.length) {
      const buf = s.q[0];
      const k = Math.min((buf.length - s.off) >> 1, count - i);
      for (let j = 0, o = s.off; j < k; j++, o += 2) {
        const g = (g0 + step * (i + j)) * s.gain;
        L[at + i + j] += buf[o] * g;
        R[at + i + j] += buf[o + 1] * g;
      }
      i += k; s.off += 2 * k;
      if (s.off >= buf.length) { s.consumed += buf.length * 4; s.q.shift(); s.off = 0; }
    }
    s.frames += i; s.buffered -= i;
    return i;
  }

  finish(s) { // stream fully played
    this.streams.delete(s.id);
    if (this.next != null) {
      this.cur = this.next; this.next = null;
      this.silence = this.gapFrames || 0; // optional "silence between tracks"
      this.port.postMessage({ type: 'switch', id: this.cur, from: s.id });
    } else {
      this.cur = null;
      this.port.postMessage({ type: 'ended', id: s.id });
    }
  }

  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
    if (!this.playing || this.cur == null) return true;

    let a = this.streams.get(this.cur);
    if (!a) { this.port.postMessage({ type: 'ended', id: this.cur }); this.cur = null; return true; }
    if (this.silence > 0) { this.silence -= n; return true; }
    const b = this.next != null ? this.streams.get(this.next) : null;

    // automatic crossfade into the queued track once the current one has <= autoXf frames left
    if (!this.xf && b && this.autoXf && this.nextXf !== false && a.ended && a.buffered <= this.autoXf && b.buffered > 0) {
      this.xf = { pos: 0, len: Math.max(a.buffered, n) };
      this.port.postMessage({ type: 'xfstart', id: b.id, from: a.id });
    }

    if (this.xf && b) {
      const t0 = this.xf.pos / this.xf.len, t1 = Math.min(1, (this.xf.pos + n) / this.xf.len);
      this.pull(a, L, R, 0, n, Math.cos(t0 * Math.PI / 2), Math.cos(t1 * Math.PI / 2));
      this.pull(b, L, R, 0, n, Math.sin(t0 * Math.PI / 2), Math.sin(t1 * Math.PI / 2));
      this.xf.pos += n;
      if (this.xf.pos >= this.xf.len || (a.ended && a.buffered <= 0)) {
        this.xf = null;
        this.report(a);
        this.streams.delete(a.id);
        this.cur = b.id; this.next = null;
        this.port.postMessage({ type: 'switch', id: b.id, from: a.id });
      }
    } else {
      let got = this.pull(a, L, R, 0, n, 1, 1);
      if (got < n && a.ended && a.buffered <= 0) {
        this.report(a);
        this.finish(a);
        const c = this.cur != null ? this.streams.get(this.cur) : null;
        if (c && !this.silence) got += this.pull(c, L, R, got, n - got, 1, 1); // gapless: continue in the same quantum
      } else if (got < n && !this.starved) {
        this.starved = true;
        this.port.postMessage({ type: 'underrun', id: a.id });
      }
      if (got === n) this.starved = false;
    }

    if (this.width !== 1 || this.mono) {
      const w = this.mono ? 0 : this.width;
      for (let i = 0; i < n; i++) {
        const m = (L[i] + R[i]) * 0.5, sd = (L[i] - R[i]) * 0.5 * w;
        L[i] = m + sd; R[i] = m - sd;
      }
    }

    if ((this.sinceReport += n) >= 2048) {
      this.sinceReport = 0;
      for (const s of this.streams.values()) this.report(s);
    }
    return true;
  }

  report(s) {
    this.port.postMessage({ type: 'pos', id: s.id, frames: s.frames, buffered: s.buffered, ended: s.ended, ack: s.consumed, current: s.id === this.cur });
    s.consumed = 0;
  }
}

registerProcessor('cadence', CadenceProcessor);

// Biquad (direct form II transposed, a0 = 1) with coefficients set by message and glided to over ~20 ms: click-free parameter changes
class IirProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.c = [1, 0, 0, 0, 0]; this.t = this.c.slice(); this.d = [0, 0, 0, 0, 0]; this.n = 0;
    this.z = [new Float64Array(2), new Float64Array(2)];
    this.port.onmessage = e => {
      const { b, a } = e.data, len = Math.max(1, Math.round(sampleRate * 0.02));
      this.t = [b[0], b[1], b[2], a[1], a[2]];
      this.d = this.t.map((x, i) => (x - this.c[i]) / len); this.n = len;
    };
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) return true;
    const c = this.c, d = this.d;
    for (let ch = 0; ch < out.length; ch++) {
      const x = inp[ch] || inp[0], y = out[ch], z = this.z[ch] || (this.z[ch] = new Float64Array(2));
      let z1 = z[0], z2 = z[1], n = this.n, b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];
      for (let i = 0; i < y.length; i++) {
        if (n > 0) { b0 += d[0]; b1 += d[1]; b2 += d[2]; a1 += d[3]; a2 += d[4]; n--; }
        const v = x[i], o = b0 * v + z1;
        z1 = b1 * v - a1 * o + z2; z2 = b2 * v - a2 * o; y[i] = o;
      }
      z[0] = Math.abs(z1) < 1e-30 ? 0 : z1; z[1] = Math.abs(z2) < 1e-30 ? 0 : z2;
      if (ch === out.length - 1) { // advance the shared coefficient state once per block
        const k = Math.min(this.n, y.length);
        for (let i = 0; i < 5; i++) c[i] = this.n > y.length ? c[i] + d[i] * k : this.t[i];
        this.n = Math.max(0, this.n - k);
      }
    }
    return true;
  }
}
registerProcessor('cadence-iir', IirProcessor);

// Minimum of the last `w` values pushed (monotonic deque): the look-ahead window of a limiter
class SlidingMin {
  constructor(w) { this.w = w; this.v = new Float32Array(w); this.cap = w + 1; this.q = new Float64Array(this.cap); this.h = 0; this.t = 0; this.n = 0; }
  push(i, x) {
    const { w, v, q, cap } = this;
    while (this.n && q[this.h] <= i - w) { this.h = (this.h + 1) % cap; this.n--; }
    while (this.n && v[q[(this.t - 1 + cap) % cap] % w] >= x) { this.t = (this.t - 1 + cap) % cap; this.n--; }
    q[this.t] = i; this.t = (this.t + 1) % cap; this.n++;
    v[i % w] = x;
    return v[q[this.h] % w];
  }
}

// Multiband look-ahead limiter, so frequencies stay independent. The signal is split into 10 octave bands (Linkwitz-Riley lowpass at
// each crossover, the next band is what is left, so the bands always add back to the exact input). When the sum would pass the
// ceiling, the overshoot is taken from the band contributing most to it, then the next, never from bands that are not causing
// it: a boosted kick never ducks vocals or cymbals. 5 ms look-ahead: gains ease down before a peak arrives and recover over
// ~150 ms. A second, broadband look-ahead stage catches what is left when band gains undo a cancellation between bands; it
// is the only part that touches every band, and it rarely has work. Below the ceiling nothing is touched.
const XOVER = [44, 88, 177, 355, 710, 1420, 2840, 5680, 11360]; // octave edges around 31 Hz ... 16 kHz
class LimiterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const L = this.L = Math.max(1, Math.round(sampleRate * 0.005));
    this.ceil = Math.pow(10, -0.3 / 20); // -0.3 dBFS
    this.att = Math.exp(-5 / L);         // ~99% of the way down within the look-ahead
    this.rel = Math.exp(-1 / (sampleRate * 0.15));
    this.bq = XOVER.filter(f => f < sampleRate * 0.45).map(f => { // Butterworth lowpass per crossover, run twice (LR4)
      const w = 2 * Math.PI * f / sampleRate, cs = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + al;
      return [(1 - cs) / 2 / a0, (1 - cs) / a0, (1 - cs) / 2 / a0, -2 * cs / a0, (1 - al) / a0];
    });
    const N = this.N = this.bq.length + 1;
    this.z = [0, 1].map(() => this.bq.map(() => new Float64Array(4)));  // per channel, per crossover: two stages
    this.dl = [0, 1].map(() => Array.from({ length: N }, () => new Float32Array(L))); // delayed bands per channel
    this.win = Array.from({ length: N }, () => new SlidingMin(L + 1));
    this.g = new Float64Array(N).fill(1); this.need = new Float64Array(N);
    this.band = [new Float64Array(N), new Float64Array(N)]; this.order = Array.from({ length: N }, (_, k) => k);
    this.boost = new Float64Array(N).fill(1); this.cut = new Float64Array(N); // how much the EQ boosts each band (engine sends it)
    this.port.onmessage = e => { const b = e.data?.boost; if (b) for (let k = 0; k < N; k++) this.boost[k] = Math.max(1, +b[k] || 1); };
    this.fin = new SlidingMin(L + 1); this.gf = 1; this.dlf = [new Float32Array(L), new Float32Array(L)]; this.o = new Float64Array(2);
    this.i = 0;
  }
  // the gain each band needs so this channel's sum stays within the ceiling. Boosted bands give back their own boost first
  // (never below their unboosted level); only then is the rest taken from the biggest contributors.
  needs(b, need) {
    const N = this.N, c = this.ceil, boost = this.boost, cut = this.cut;
    let s = 0; for (let k = 0; k < N; k++) s += b[k];
    if (Math.abs(s) <= c) return;
    const sg = s > 0 ? 1 : -1; let excess = Math.abs(s) - c;
    // boosted bands give back in proportion to how much of their boost is in this peak (spread, so no single band takes it all)
    let room = 0;
    for (let k = 0; k < N; k++) { const part = sg * b[k]; cut[k] = part > 0 && boost[k] > 1 ? part * (1 - 1 / boost[k]) : 0; room += cut[k]; }
    if (room > excess) { const f = excess / room; for (let k = 0; k < N; k++) cut[k] *= f; excess = 0; } else excess -= room;
    if (excess > 0) {
      const order = this.order;
      order.sort((p, q) => (sg * b[q] - cut[q]) - (sg * b[p] - cut[p]));
      for (const k of order) {
        const left = sg * b[k] - cut[k];
        if (left <= 0 || excess <= 0) break;
        const more = Math.min(excess, left); cut[k] += more; excess -= more;
      }
    }
    for (let k = 0; k < N; k++) if (cut[k] > 0) { const g = 1 - cut[k] / (sg * b[k]); if (g < need[k]) need[k] = g; }
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) return true;
    const xs = [inp[0], inp[1] || inp[0]], ys = [out[0], out[1] || out[0]];
    const { L, N, ceil: c, att, rel, bq, z, dl, win, g, need, band } = this;
    let i = this.i;
    for (let k = 0; k < xs[0].length; k++, i++) {
      need.fill(1);
      for (let ch = 0; ch < 2; ch++) {
        const b = band[ch];
        let rest = xs[ch][k];
        for (let j = 0; j < bq.length; j++) { // peel the bands off from the bottom
          const [b0, b1, b2, a1, a2] = bq[j], s = z[ch][j];
          const y = b0 * rest + s[0]; s[0] = b1 * rest - a1 * y + s[1]; s[1] = b2 * rest - a2 * y;
          const y2 = b0 * y + s[2]; s[2] = b1 * y - a1 * y2 + s[3]; s[3] = b2 * y - a2 * y2;
          b[j] = y2; rest -= y2;
        }
        b[N - 1] = rest;
        this.needs(b, need);
      }
      for (let j = 0; j < N; j++) { const t = win[j].push(i, need[j]); g[j] = t < g[j] ? t + (g[j] - t) * att : t + (g[j] - t) * rel; }
      const p = i % L, o = this.o;
      let needF = 1;
      for (let ch = 0; ch < 2; ch++) {
        const d = dl[ch], b = band[ch];
        let v = 0;
        for (let j = 0; j < N; j++) { v += d[j][p] * g[j]; d[j][p] = b[j]; }
        o[ch] = v; const a = Math.abs(v); if (a > c && c / a < needF) needF = c / a;
      }
      const tf = this.fin.push(i, needF);
      this.gf = tf < this.gf ? tf + (this.gf - tf) * att : tf + (this.gf - tf) * rel;
      for (let ch = 0; ch < 2; ch++) {
        const f = this.dlf[ch], v = f[p] * this.gf;
        f[p] = o[ch];
        if (ch === 0 || ys[1] !== ys[0]) ys[ch][k] = v > c ? c : v < -c ? -c : v; // safety net for the last fraction of a dB
      }
    }
    this.i = i;
    return true;
  }
}
registerProcessor('cadence-limiter', LimiterProcessor);
