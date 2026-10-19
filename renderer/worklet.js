// PCM player: pulls interleaved f32 stereo chunks per stream, does gapless hand-off,
// equal-power crossfades and per-stream gain (ReplayGain). The DSP runs in dsp.js ('cadence-dsp').
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
    this.playing = false; this.autoXf = 0;
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
      case 'fadeTo': // manual skip with crossfade
        if (this.next && this.next !== m.id) this.drop(this.next);
        this.next = m.id;
        if (this.cur) this.xf = { pos: 0, len: m.frames }; else { this.cur = m.id; this.next = null; }
        break;
      case 'playing': this.playing = m.value; break;
      case 'gain': if (s) s.gain = m.gain; break;
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
