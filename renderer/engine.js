// Audio engine: ffmpeg (main process) -> worklet PCM player -> Web Audio DSP chain -> output device.
export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
// Reverb presets: size, filter, fade, preDelay, mix, preDelayMix, damp (0..1 each)
export const REVERB_PARAMS = ['size', 'damp', 'filter', 'fade', 'preDelay', 'preDelayMix', 'mix'];
export const REVERBS = Object.fromEntries(Object.entries({
  'Auditorium': [0.0, 0.697, 0.814, 0.0, 0.50, 0.0, 0.898],
  'Echo': [0.727, 0.905, 0.272, 0.541, 0.37, 0.583, 0.363],
  'Great Hall': [0.519, 0.709, 0.0, 0.946, 0.44, 0.526, 0.259],
  'Light Reverb': [0.602, 0.802, 0.317, 0.251, 0.375, 0.348, 0.441],
  'Natural': [0.272, 0.499, 0.349, 0.121, 0.086, 0.252, 0.650],
  'Scene': [0.245, 0.705, 0.503, 0.121, 0.45, 0.425, 0.412],
  'Small Room': [0.0, 1.0, 1.0, 0.0, 0.32, 0.623, 0.529],
  'Stadium': [0.993, 0.621, 0.828, 0.445, 0.376, 0.739, 0.840],
  'Studio': [0.030, 0.110, 1.0, 0.036, 0.47, 0.437, 0.989],
}).map(([k, [size, filter, fade, preDelay, mix, preDelayMix, damp]]) => [k, { size, filter, fade, preDelay, mix, preDelayMix, damp }]));

const dbToGain = db => Math.pow(10, db / 20);
const clamp = (v, lo, hi, d = lo) => Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d;
const RATES = [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000];
const okRate = r => RATES.includes(+r) ? +r : 0; // anything else: auto
const IIR_TYPES = new Set(['lowshelf', 'highshelf', 'lowpass', 'highpass']);

// RBJ cookbook coefficients with linear Q (Web Audio ignores Q on shelves and reads LP/HP Q as dB). Returns { b, a } with a[0] = 1.
export function rbj(type, fs, freq, gainDb, q) {
  const w = 2 * Math.PI * clamp(freq, 10, fs * 0.45, 1000) / fs, c = Math.cos(w), Q = clamp(q, 0.1, 30, 0.71);
  const al = Math.sin(w) / (2 * Q), A = Math.pow(10, clamp(gainDb, -60, 60, 0) / 40), sa = 2 * Math.sqrt(A) * al;
  let b, a;
  if (type === 'lowshelf') {
    b = [A * ((A + 1) - (A - 1) * c + sa), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sa)];
    a = [(A + 1) + (A - 1) * c + sa, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sa];
  } else if (type === 'highshelf') {
    b = [A * ((A + 1) + (A - 1) * c + sa), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sa)];
    a = [(A + 1) - (A - 1) * c + sa, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sa];
  } else {
    const hp = type === 'highpass', k = hp ? 1 + c : 1 - c;
    b = [k / 2, hp ? -k : k, k / 2]; a = [1 + al, -2 * c, 1 - al];
  }
  return { b: b.map(x => x / a[0]), a: [1, a[1] / a[0], a[2] / a[0]] };
}
// magnitude (dB) of { b, a } at freq (Hz)
export function iirDb({ b, a }, freq, fs) {
  const w = 2 * Math.PI * freq / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b[0] + b[1] * c1 + b[2] * c2, ni = -(b[1] * s1 + b[2] * s2), dr = a[0] + a[1] * c1 + a[2] * c2, di = -(a[1] * s1 + a[2] * s2);
  return 10 * Math.log10(Math.max(1e-12, (nr * nr + ni * ni) / (dr * dr + di * di)));
}
let nextId = 1;
const FLAT = { type: 'peaking', freq: 1000, q: 1 };
const FADE = 0.03, COALESCE = 16;

// A filter position that changes without clicks and without main-thread cost. Shelf/LP/HP run in a biquad AudioWorklet
// ('cadence-iir'): a change is one postMessage of RBJ coefficients, which the processor glides to over ~20 ms (IIRFilterNode
// can't change coefficients and costs ~12 ms to construct). Only a switch between worklet and native Biquad types (rare)
// builds a second branch and crossfades linearly (the branches are correlated, so gains sum to 1). Changes are coalesced
// (leading edge, then latest-wins every ~16 ms).
export class Slot {
  constructor(ctx, spec, gain = 0, mk = c => new AudioWorkletNode(c, 'cadence-iir', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' })) {
    this.ctx = ctx; this.mk = mk; this.input = ctx.createGain(); this.output = ctx.createGain();
    this.dying = new Set(); this.timer = 0; this.want = null;
    this.branch = this.build(spec, gain, 1);
  }
  disconnect() { this.output.disconnect(); }
  coef(b, spec, gain) { const c = rbj(spec.type, this.ctx.sampleRate, spec.freq, gain, spec.q); b.f.port.postMessage({ b: c.b, a: c.a }); }
  build(spec, gain, g0) {
    const ctx = this.ctx, iir = IIR_TYPES.has(spec.type), br = { iir, type: spec.type };
    if (iir) { br.f = this.mk(ctx); this.coef(br, spec, gain); }
    else { const f = br.f = ctx.createBiquadFilter(); f.type = spec.type; f.frequency.value = spec.freq; f.Q.value = spec.q || 0.71; f.gain.value = gain; }
    br.g = ctx.createGain(); br.g.gain.value = g0;
    this.input.connect(br.f); br.f.connect(br.g); br.g.connect(this.output);
    return br;
  }
  set(spec, gain) {
    this.want = [spec, gain];
    if (this.timer) return;
    this.flush();
    this.timer = setTimeout(() => { this.timer = 0; if (this.want) this.flush(); }, COALESCE);
  }
  flush() {
    const [spec, gain] = this.want; this.want = null;
    const cur = this.branch, t = this.ctx.currentTime, iir = IIR_TYPES.has(spec.type);
    if (iir && cur.iir) { this.coef(cur, spec, gain); return; }
    if (!iir && !cur.iir && cur.type === spec.type) { // peaking etc.: AudioParams already glide
      cur.f.frequency.setTargetAtTime(spec.freq, t, 0.01); cur.f.Q.setTargetAtTime(spec.q || 0.71, t, 0.01); cur.f.gain.setTargetAtTime(gain, t, 0.02);
      return;
    }
    const nb = this.branch = this.build(spec, gain, 0);
    nb.g.gain.setValueAtTime(0, t); nb.g.gain.linearRampToValueAtTime(1, t + FADE);
    cur.g.gain.cancelScheduledValues(t); cur.g.gain.setValueAtTime(cur.g.gain.value, t); cur.g.gain.linearRampToValueAtTime(0, t + FADE);
    this.dying.add(cur);
    cur.timer = setTimeout(() => this.reap(cur), FADE * 1000 + 60);
  }
  reap(b) {
    clearTimeout(b.timer);
    if (!this.dying.delete(b)) return;
    try { this.input.disconnect(b.f); } catch {}
    b.f.disconnect(); b.g.disconnect();
  }
  dispose() {
    clearTimeout(this.timer); this.want = null;
    [...this.dying].forEach(b => this.reap(b));
    this.input.disconnect(); this.output.disconnect();
    try { this.input.disconnect(this.branch.f); } catch {}
    this.branch.f.disconnect(); this.branch.g.disconnect();
  }
}

export class Engine extends EventTarget {
  constructor(opts) {
    super();
    this.o = { ...opts };
    this.streams = new Map();
    this.cur = null;          // stream currently audible
    this.next = null;         // stream queued for gapless/crossfade
    this.playing = false;
    this.getNext = () => null;
    this.ctx = null;
    api.on('dec:data', (id, u8) => this.onData(id, u8));
    api.on('dec:end', id => this.onDecEnd(id));
    api.on('dec:error', (id, msg) => this.onDecError(id, msg));
    // exclusive (bit-perfect) output: main process + WASAPI helper stand in for the worklet, same messages
    this.xoPort = { postMessage: m => api.send('xo:msg', m) };
    api.on('xo:msg', m => this.onXo(m));
    // device volume (like a phone): null = unavailable, else whether the device has a real hardware volume control
    this.hwVol = null;
    api.on('hwvol', m => this.onHwVol(m));
    this.hwDevice();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async init() {
    const o = this.o;
    const ctx = this.ctx = new AudioContext({ latencyHint: 'playback', ...(okRate(o.sampleRate) ? { sampleRate: okRate(o.sampleRate) } : {}) });
    if (o.device) await ctx.setSinkId(o.device).catch(() => {});
    await ctx.audioWorklet.addModule('worklet.js');
    this.node = new AudioWorkletNode(ctx, 'cadence', { numberOfInputs: 0, outputChannelCount: [2] });
    this.node.port.onmessage = e => this.onWorklet(e.data);
    this.port = o.exclusive ? this.xoPort : this.node.port;
    if (o.exclusive) { await this.xoConfig(); ctx.suspend(); }

    const g = () => ctx.createGain();
    const bq = (type, freq, q) => {
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq;
      if (q) f.Q.value = q;
      return f;
    };
    this.fader = g();
    this.preamp = g();
    this.bq = bq;
    this.bass = new Slot(ctx, { type: 'lowshelf', freq: 90, q: 0.7 });
    this.eqIn = g(); this.eqOut = g();
    this.eq = [];
    this.treble = new Slot(ctx, { type: 'highshelf', freq: 9000, q: 0.7 });
    this.balance = ctx.createStereoPanner();
    this.dry = g(); this.wet = g(); this.conv = ctx.createConvolver();
    this.preDelay = ctx.createDelay(1); this.preTap = g(); this.wetFilter = bq('lowpass', 12000, 0.5);
    this.limIn = g();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001; this.limiter.release.value = 0.08;
    // the compressor adds makeup gain of -0.6 * (output level at 0 dBFS): cancel it so idle gain is exactly 0 dB
    this.limPost = g(); this.limPost.gain.value = dbToGain(0.6 * (-1 + 1 / 20));
    // ceiling: soft-saturate from the compressor threshold up to -0.3 dBFS; anything beyond +-1 maps to the curve's end
    this.ceil = ctx.createWaveShaper(); this.ceil.oversample = '2x';
    this.ceil.curve = Float32Array.from({ length: 4097 }, (_, i) => {
      const x = Math.abs(i / 2048 - 1), t = dbToGain(-1), c = dbToGain(-0.3), y = x <= t ? x : t + (c - t) * Math.tanh((x - t) / (c - t));
      return i < 2048 ? -y : y;
    });
    this.tap = g();      // post-DSP, pre-volume: visualizers read from here
    this.volume = g();   // volume sits before the limiter (like ), so at normal levels EQ boosts use headroom instead of being limited

    const chain = [this.node, this.fader, this.preamp, this.eqIn];
    chain.reduce((a, b) => (a.connect(b), b));
    this.link();
    this.balance.connect(this.dry).connect(this.limIn);
    this.preDelay.connect(this.conv).connect(this.wetFilter); // fed from balance only while reverb is on
    this.preDelay.connect(this.preTap).connect(this.wetFilter);
    this.wetFilter.connect(this.wet).connect(this.limIn);
    this.limIn.connect(this.tap);
    this.limIn.connect(this.volume);

    this.applyAll();
    this.emit('ready');
  }

  link() { // eqIn -> bands -> eqOut -> bass -> treble -> balance (bands/tone are click-free Slots)
    this.linked?.forEach(n => n.disconnect());
    this.linked = [this.eqIn, ...this.eq, this.eqOut, this.bass, this.treble];
    [...this.linked, this.balance].reduce((a, b) => ((a.output || a).connect(b.input || b), b));
  }

  // ---------- settings ----------
  applyAll() {
    const o = this.o;
    this.setEq(o.eqOn, o.eqBands, o.preamp);
    this.setTone(o.toneOn, o.bass, o.treble);
    this.setBalance(o.balance);
    this.setWidth(o.width);
    this.setReverb(o.reverb);
    this.setMono(!!o.mono);
    this.setGap(o.gap || 0);
    this.setLimiter(o.limiter);
    this.setVolume(o.volume);
    this.setCrossfade(o.crossfade);
  }
  set(k, v) { this.o[k] = v; }
  // bands: [{ type: 'peaking'|'lowshelf'|'highshelf'|'lowpass'|'highpass'|'notch', freq, gain, q }]
  setEq(on, bands, preamp) {
    Object.assign(this.o, { eqOn: on, eqBands: bands, preamp });
    const t = this.ctx.currentTime;
    const n0 = this.eq.length;
    while (this.eq.length < bands.length) this.eq.push(new Slot(this.ctx, FLAT));
    if (this.eq.length !== n0) this.link();
    this.eq.forEach((f, i) => bands[i] ? f.set(bands[i], on ? bands[i].gain : 0) : f.set(FLAT, 0));
    clearTimeout(this.trimTimer);
    if (this.eq.length > bands.length) this.trimTimer = setTimeout(() => { // removed bands have faded to flat: drop them
      const gone = this.eq.splice(this.o.eqBands.length);
      this.link(); gone.forEach(f => f.dispose());
    }, 200);
    this.headroom();
    this.regain();
  }
  setTone(on, bass, treble, bassFreq = this.o.bassFreq || 90, trebleFreq = this.o.trebleFreq || 9000) {
    Object.assign(this.o, { toneOn: on, bass, treble, bassFreq, trebleFreq });
    this.bass.set({ type: 'lowshelf', freq: bassFreq, q: 0.7 }, on ? bass : 0);
    this.treble.set({ type: 'highshelf', freq: trebleFreq, q: 0.7 }, on ? treble : 0);
    this.headroom();
    this.regain();
  }
  // EQ, tone and preamp boosts are offset before they happen, so a full-scale track never reaches the limiter however loud
  // the output is: loudness comes from the device volume, not from pushing the signal past 0 dBFS
  headroom() {
    this.preamp.gain.setTargetAtTime(dbToGain((this.o.eqOn ? this.o.preamp || 0 : 0) - this.boostDb()), this.ctx.currentTime, 0.02);
  }
  setBalance(v) { this.o.balance = v; this.balance.pan.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  setWidth(v) { this.o.width = v; if (!this.o.exclusive) this.port.postMessage({ type: 'width', value: v }); }
  // r: { on, size, damp, filter, fade, preDelay, preDelayMix, mix }
  setReverb(r) {
    this.o.reverb = r = { ...r };
    const t = this.ctx.currentTime;
    const irKey = [r.size, r.damp, r.fade].map(x => x.toFixed(3)).join();
    if (r.on && this.irKey !== irKey) { this.conv.buffer = this.makeIR(r); this.irKey = irKey; }
    this.preDelay.delayTime.setTargetAtTime(r.preDelay * 0.3, t, 0.02);
    this.preTap.gain.setTargetAtTime(r.preDelayMix * 0.6, t, 0.02);
    this.wetFilter.frequency.setTargetAtTime(800 + r.filter * r.filter * 19000, t, 0.02);
    // the convolver is expensive even when silent: only feed it while reverb is on
    if (r.on && !this.revLinked) { this.balance.connect(this.preDelay); this.revLinked = true; }
    if (!r.on && this.revLinked) { try { this.balance.disconnect(this.preDelay); } catch {} this.revLinked = false; }
    const m = r.on ? r.mix : 0;
    this.wet.gain.setTargetAtTime(m, t, 0.03);
    this.dry.gain.setTargetAtTime(1 - m * 0.45, t, 0.03);
  }
  makeIR({ size, damp, fade }) {
    const rate = this.ctx.sampleRate, len = Math.floor(rate * (0.25 + size * 5.5));
    const decay = 6.5 - fade * 5; // higher fade = longer, flatter tail
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const x = i / len;
        const n = (Math.random() * 2 - 1) * Math.pow(1 - x, decay);
        const k = 1 - Math.min(0.97, damp * x * 1.2); // high frequencies die faster
        lp += (n - lp) * k;
        d[i] = lp;
      }
    }
    return buf;
  }
  setLimiter(on) {
    this.o.limiter = on;
    this.volume.disconnect(); this.limiter.disconnect(); this.limPost.disconnect(); this.ceil.disconnect();
    if (on) this.volume.connect(this.limiter).connect(this.limPost).connect(this.ceil).connect(this.ctx.destination); else this.volume.connect(this.ctx.destination);
  }
  setVolume(v, fromDevice = false) {
    v = clamp(v, 0, 1, 0);
    this.o.volume = v;
    // exclusive mode bypasses Windows' software volume, so there only a real hardware control can stand in
    const dev = this.hwVol != null && (this.hwVol || !this.o.exclusive);
    const g = dev ? 1 : v * v;
    this.volume.gain.setTargetAtTime(g, this.ctx.currentTime, 0.015);
    if (this.o.exclusive) this.port.postMessage({ type: 'volume', value: g }); // < 1 scales samples: not bit-perfect
    if (dev && !fromDevice) api.send('hwvol:set', v);
  }
  async deviceLabel() {
    const d = this.o.device && (await navigator.mediaDevices.enumerateDevices()).find(d => d.kind === 'audiooutput' && d.deviceId === this.o.device);
    return d?.label || '';
  }
  async hwDevice() { api.send('hwvol:dev', await this.deviceLabel()); }
  // the device's volume is the truth: changes made with the keyboard, Windows or another app show up on the slider
  onHwVol(m) {
    const before = this.o.volume;
    this.hwVol = m.type === 'vol' ? !!m.hw : null;
    const v = m.type === 'vol' ? (m.muted ? 0 : m.v) : before;
    if (this.volume) this.setVolume(v, true); else this.o.volume = v; // the chain is not built yet: init() applies it
    if (Math.abs(v - before) > 0.004) this.emit('volume', v);
  }
  setCrossfade(sec) {
    this.o.crossfade = sec;
    this.port.postMessage({ type: 'autoXf', frames: Math.round(sec * this.ctx.sampleRate) });
  }
  setReplayGain(mode, rgPreamp, noRgPreamp, preventClip) {
    Object.assign(this.o, { rgMode: mode, rgPreamp, noRgPreamp, preventClip });
    this.regain();
  }
  regain() { for (const s of this.streams.values()) this.port.postMessage({ type: 'gain', id: s.id, gain: this.trackGain(s.track) }); }
  setTempoPitch(tempo, semitones) {
    tempo = clamp(tempo, 0.5, 2, 1); semitones = clamp(semitones, -12, 12, 0);
    if (tempo === this.o.tempo && semitones === this.o.semitones) return;
    Object.assign(this.o, { tempo, semitones });
    if (this.o.exclusive) return; // exclusive output ignores tempo/pitch: reloading would only cause a dropout
    if (this.cur) this.load(this.cur.entry, { start: this.position, play: this.playing });
  }
  async setOutput(device, sampleRate) {
    sampleRate = okRate(sampleRate);
    const changedRate = sampleRate !== (this.o.sampleRate || 0);
    Object.assign(this.o, { device, sampleRate });
    this.hwDevice();
    if (this.o.exclusive && !changedRate) return this.setExclusive(true); // reopens the helper on the new device
    if (!changedRate) return this.ctx.setSinkId(device || '').catch(e => this.emit('error', { message: 'Output device: ' + e.message }));
    const resume = this.cur && { entry: this.cur.entry, start: this.position, play: this.playing, quiet: true };
    this.stop();
    await this.ctx.close();
    this.irKey = null; this.revLinked = false;
    await this.init();
    if (resume) this.load(resume.entry, resume);
  }

  // exclusive mode skips Web Audio entirely: EQ, tone, reverb, limiter, tempo, ReplayGain, crossfade and visualizers are bypassed
  async setExclusive(on) {
    const resume = this.cur && { entry: this.cur.entry, start: this.position, play: this.playing, quiet: true };
    this.stop();
    this.o.exclusive = on;
    this.port = on ? this.xoPort : this.node.port;
    this.outFormat = null;
    this.xoRefused = new Set();
    if (on) { await this.xoConfig(); this.ctx.suspend(); }
    this.applyAll();
    if (resume) this.load(resume.entry, resume);
  }
  async xoConfig() {
    this.port.postMessage({ type: 'config', device: await this.deviceLabel() }); // the helper matches the endpoint by name
  }
  onXo(m) {
    if (!this.o.exclusive) return;
    if (m.type === 'format') { this.outFormat = m; this.emit('format', m); }
    else if (m.type === 'fail') this.emit('xofail', m);
    else if (m.type === 'refused') {
      // the device refused one rate: resample to another it may take, give up once every rate was refused
      const s = this.streams.get(m.id);
      if (!s) return; // stale refusal for a stream that is gone
      (this.xoRefused ||= new Set()).add(s.rate);
      if (!this.xoRate(s.track)) return this.emit('xofail', m);
      if (m.queued) {
        // only the queued next track: re-queue it at another rate, the current one keeps playing untouched
        this.streams.delete(s.id); api.send('dec:stop', s.id);
        if (this.next === s) this.next = null;
        this.prepareNext();
        if (!this.next) this.port.postMessage({ type: 'queue', id: null }); // nothing to replace it: let the current one end
        return;
      }
      const resume = this.cur && { entry: this.cur.entry, start: this.position, play: this.playing, quiet: true };
      this.stop();
      if (resume) this.load(resume.entry, resume);
    }
    else this.onWorklet(m);
  }
  // the source's own rate unless the device refused it: then the nearest standard rate not refused yet (higher first)
  xoRate(t) {
    const want = t.sampleRate || 48000, bad = this.xoRefused || new Set();
    if (!bad.has(want)) return want;
    const rates = [44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000].filter(r => !bad.has(r));
    return rates.find(r => r > want) || rates.at(-1) || 0;
  }
  now() { return this.o.exclusive ? performance.now() / 1000 : this.ctx.currentTime; }

  trackGain(t) {
    const o = this.o, rg = t.rg;
    if (o.rgMode === 'off' || o.exclusive) return 1;
    const useAlbum = o.rgMode === 'album' && rg?.ag != null;
    const db = rg ? (useAlbum ? rg.ag : rg.tg) : null;
    if (db == null) return dbToGain(clamp(o.noRgPreamp, -24, 24, 0));
    let gain = dbToGain(clamp(db, -24, 24, 0) + clamp(o.rgPreamp, -24, 24, 0));
    const peak = useAlbum ? rg.ap : rg.tp;
    if (o.preventClip && peak > 0) gain = Math.min(gain, 1 / peak); // EQ boosts are already offset by headroom()
    return gain;
  }
  // worst-case positive gain the EQ / tone / preamp can add downstream of the per-stream gain
  boostDb() {
    const o = this.o;
    const eq = o.eqOn ? (o.preamp || 0) + Math.max(0, ...(o.eqBands || []).map(b => b.gain || 0)) : 0;
    const tone = o.toneOn ? Math.max(0, o.bass || 0, o.treble || 0) : 0;
    return Math.max(0, eq + tone);
  }

  // ---------- streams ----------
  openStream(entry, start) {
    const id = nextId++;
    const t = entry.track;
    if (t.stream) start = 0;
    const xo = this.o.exclusive;
    // exclusive: the source's own rate and bit depth, no tempo/pitch
    const rate = xo ? this.xoRate(t) : this.ctx.sampleRate, tempo = xo ? 1 : clamp(this.o.tempo, 0.5, 2, 1), pitch = xo ? 1 : Math.pow(2, clamp(this.o.semitones, -12, 12, 0) / 12);
    const s = { id, entry, track: t, start, tempo, rate, frames: 0, decoded: false, xo };
    this.streams.set(id, s);
    this.port.postMessage({ type: 'open', id, gain: this.trackGain(t) });
    // CUE tracks are a slice of one big file
    const offset = t.cueStart || 0, length = t.cueEnd ? Math.max(0.1, t.cueEnd - t.cueStart - start) : null;
    api.send('dec:start', { id, file: t.file || t.path, start: offset + start, length, rate, tempo, pitch, bufferSec: 20, ...(xo && { exclusive: true, bits: t.bits || 24, srcBits: t.bits || 24, resample: rate !== (t.sampleRate || 48000) }) });
    return s;
  }
  closeStream(s) {
    if (!s) return;
    this.streams.delete(s.id);
    api.send('dec:stop', s.id);
    this.port.postMessage({ type: 'close', id: s.id });
  }
  retire(id) { // a stream the worklet finished with
    if (!this.streams.has(id)) return;
    this.streams.delete(id);
    api.send('dec:stop', id);
    if (this.outgoing?.id === id) this.outgoing = null;
  }

  onData(id, u8) {
    const st = this.streams.get(id);
    if (!st) return;
    st.bytes = (st.bytes || 0) + u8.byteLength;
    const aligned = u8.byteOffset % 4 === 0;
    const f = new Float32Array(aligned ? u8.buffer : u8.slice().buffer, aligned ? u8.byteOffset : 0, u8.byteLength >> 2);
    const copy = f.byteOffset || f.buffer.byteLength !== f.byteLength ? f.slice() : f;
    this.port.postMessage({ type: 'data', id, data: copy }, [copy.buffer]);
  }
  onDecEnd(id) {
    const s = this.streams.get(id);
    if (!s) return;
    s.decoded = true;
    if (!s.bytes && !s.xo && !s.track.stream) this.emit('error', { message: `Can't play ${s.track.title}: file is empty or truncated`, track: s.track });
    this.port.postMessage({ type: 'end', id });
    if (s === this.cur) this.prepareNext();
  }
  onDecError(id, msg) {
    const s = this.streams.get(id);
    if (!s) return;
    this.emit('error', { message: `Can't play ${s.track.title}: ${msg}`, track: s.track });
    s.decoded = true;
    this.port.postMessage({ type: 'end', id }); // empty stream: worklet moves on to the next one
    if (s === this.cur) this.prepareNext();
  }

  prepareNext() {
    if (this.next || !this.cur || this.xfading) return;
    const entry = this.getNext(this.cur.entry);
    if (!entry) return;
    this.next = this.openStream(entry, 0);
    const xf = this.allowXf ? this.allowXf(this.cur.entry, entry) : true;
    this.port.postMessage({ type: 'queue', id: this.next.id, xf });
  }
  invalidateNext() {
    if (this.xfading) return; // the queued stream is already audible; the next call after 'switch' re-plans
    if (this.next) { this.closeStream(this.next); this.next = null; }
    if (this.cur?.decoded) this.prepareNext();
  }

  onWorklet(m) {
    const s = this.streams.get(m.id);
    switch (m.type) {
      case 'pos':
        if (m.ack) api.send('dec:ack', m.id, m.ack);
        if (s) { s.frames = m.frames; s.at = this.now(); }
        break;
      case 'xfstart': // auto crossfade began: the UI follows the incoming track right away
        if (s && s === this.next) {
          this.xfading = true; this.outgoing = this.cur; this.cur = s; this.next = null;
          s.at = this.now();
          this.emit('track', { entry: s.entry, auto: true });
        }
        break;
      case 'switch': {
        this.retire(m.from);
        const announced = this.cur === s;
        this.xfading = false; this.outgoing = null;
        if (!s) { // worklet plays a stream we no longer know (e.g. after a device replug): resume the current entry, don't advance
          if (this.cur) this.load(this.cur.entry, { start: this.position, play: this.playing });
          break;
        }
        this.cur = s; if (this.next === s) this.next = null;
        s.at = this.now();
        if (!announced) this.emit('track', { entry: s.entry, auto: true });
        if (s.decoded) this.prepareNext();
        break;
      }
      case 'ended':
        this.retire(m.id);
        if (this.cur?.id === m.id) {
          // end/queue race: the worklet ran dry before the queued stream was handed over. Promote it ourselves.
          if (!this.next && !this.xfading) {
            const e = this.getNext(this.cur.entry);
            if (e) this.next = this.openStream(e, 0);
          }
          const n = this.next;
          if (n && this.streams.has(n.id)) {
            this.next = null; this.cur = n; n.at = this.now();
            this.port.postMessage({ type: 'play', id: n.id });
            this.emit('track', { entry: n.entry, auto: true });
            if (n.decoded) this.prepareNext();
            break;
          }
          this.cur = null; this.setPlaying(false); this.emit('ended');
        }
        break;
      case 'dropped':
        if (s && s !== this.cur) this.retire(m.id);
        break;
    }
  }

  // ---------- transport ----------
  load(entry, { start = 0, play = true, fade = false, quiet = false } = {}) {
    this.parked = false;
    clearTimeout(this.seekTimer); this.seekTimer = null; this.seekPos = null;
    // seek, tempo, output and resume reload the current entry: that is not a new track, so don't announce one
    const reload = quiet || (!!this.cur && this.cur.entry === entry);
    const sec = fade && this.playing && this.cur && !this.xfading && !this.o.exclusive ? (this.o.skipFade || 0) : 0;
    if (this.next) { this.closeStream(this.next); this.next = null; }
    const s = this.openStream(entry, start);
    if (sec > 0) {
      // manual crossfade: the incoming stream is "current" for UI/seek right away; the worklet retires the old one
      this.port.postMessage({ type: 'fadeTo', id: s.id, frames: Math.round(sec * this.ctx.sampleRate) });
      this.outgoing = this.cur; this.cur = s; this.xfading = true;
      s.at = this.now();
      if (!reload) this.emit('track', { entry, auto: false });
      return;
    }
    this.xfading = false;
    const old = [this.cur, this.outgoing];
    this.cur = s; this.outgoing = null; s.at = this.now();
    this.port.postMessage({ type: 'play', id: s.id });
    old.forEach(o => o && this.retire(o.id));
    this.setPlaying(play);
    if (!play && quiet && this.o.exclusive) { clearTimeout(this.parkTimer); this.parked = true; this.port.postMessage({ type: 'stop' }); } // restored while paused: don't hold the device
    if (play) this.declick(); // after setPlaying: it cancels scheduled gain values
    if (!reload) this.emit('track', { entry, auto: false });
  }
  declick() {
    const t = this.ctx.currentTime, len = this.o.seekFade ?? 0.03;
    this.fader.gain.cancelScheduledValues(t);
    this.fader.gain.setValueAtTime(0, t);
    this.fader.gain.linearRampToValueAtTime(1, t + Math.max(0.005, len));
  }
  setPlaying(on) {
    if (this.o.exclusive) return this.setPlayingExclusive(on);
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const t = this.ctx.currentTime;
    this.fader.gain.cancelScheduledValues(t);
    this.fader.gain.setValueAtTime(this.fader.gain.value, t);
    const len = this.o.fadePause ? 0.25 : 0.03;
    if (on) {
      this.port.postMessage({ type: 'playing', value: true });
      this.fader.gain.linearRampToValueAtTime(1, t + len);
    } else {
      this.fader.gain.linearRampToValueAtTime(0, t + len);
      clearTimeout(this.pauseTimer);
      this.pauseTimer = setTimeout(() => { if (!this.playing) this.port.postMessage({ type: 'playing', value: false }); }, len * 1000 + 20);
      // the whole DSP graph keeps running on silence: suspend it while paused for a while
      clearTimeout(this.suspendTimer);
      this.suspendTimer = setTimeout(() => { if (!this.playing && !this.keepAlive) this.ctx.suspend(); }, 5000);
    }
    this.commitPlaying(on);
  }
  commitPlaying(on) {
    this.playing = on;
    if (this.cur) this.cur.at = this.now(); // freeze interpolation base
    this.emit('state', { playing: on });
  }
  // exclusive: no fader, the helper pauses immediately. After a while paused the helper is closed so other apps
  // can use the device again; playing again reopens it at the same position.
  setPlayingExclusive(on) {
    clearTimeout(this.parkTimer);
    if (on && this.parked && this.cur) {
      this.parked = false;
      const start = this.position;
      this.playing = true; // load() keeps the play state
      return this.load(this.cur.entry, { start, play: true });
    }
    this.port.postMessage({ type: 'playing', value: on });
    if (!on) this.parkTimer = setTimeout(() => {
      if (this.playing || !this.cur || !this.o.exclusive) return;
      this.parked = true;
      this.port.postMessage({ type: 'stop' }); // releases the device; decoders are reopened on resume
    }, 10000);
    this.commitPlaying(on);
  }
  toggle() { if (this.cur) this.setPlaying(!this.playing); }
  seek(sec) {
    if (!this.cur || this.cur.track.stream) return;
    if (!Number.isFinite(+sec)) return;
    const d = this.cur.track.duration || Infinity;
    // latest wins: a burst of seeks opens one decoder, not one each
    this.seekPos = Math.max(0, Math.min(+sec, d - 0.05));
    this.seekTimer ||= setTimeout(() => {
      const start = this.seekPos;
      this.seekTimer = null; this.seekPos = null;
      if (this.cur && start != null) this.load(this.cur.entry, { start, play: this.playing });
    }, 50);
  }
  stop() {
    this.parked = false; clearTimeout(this.parkTimer);
    clearTimeout(this.seekTimer); this.seekTimer = null; this.seekPos = null;
    for (const id of this.streams.keys()) api.send('dec:stop', id);
    this.streams.clear();
    this.port.postMessage({ type: 'stop' });
    this.cur = this.next = this.outgoing = null;
    this.xfading = false;
    this.setPlaying(false);
  }
  setMono(on) { this.o.mono = on; if (!this.o.exclusive) this.port.postMessage({ type: 'mono', value: on }); }
  setGap(sec) { this.o.gap = sec; this.port.postMessage({ type: 'gap', frames: Math.round(sec * this.ctx.sampleRate) }); }

  get position() {
    const s = this.cur;
    if (!s) return 0;
    if (this.seekPos != null) return this.seekPos;
    const ctx = this.ctx;
    const latency = this.o.exclusive ? 0 : (ctx.outputLatency || 0) + (ctx.baseLatency || 0); // the helper reports frames actually played
    const live = this.playing && s.at != null ? Math.min(this.now() - s.at, 0.25) : 0;
    return Math.max(s.start, s.start + (s.frames / s.rate + live - (this.playing ? latency : 0)) * s.tempo);
  }
  get bitPerfect() { const f = this.outFormat; return !!f && this.o.volume >= 1 && f.rate === (this.track?.sampleRate || f.rate); }
  get track() { return this.cur?.track || null; }
  get entry() { return this.cur?.entry || null; }

  // combined magnitude response (dB) of the EQ bands and tone shelves, for drawing the EQ curve.
  // Preamp is a separate flat gain stage (as in ), so it isn't drawn into the curve.
  response(freqs) {
    const f = new Float32Array(freqs), mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
    const total = new Float32Array(freqs.length);
    // computed from target values, not the ramping AudioParams, so the curve tracks the sliders exactly
    const nodes = [];
    if (this.o.eqOn) nodes.push(...this.o.eqBands);
    if (this.o.toneOn) nodes.push({ type: 'lowshelf', freq: this.o.bassFreq || 90, gain: this.o.bass, q: 0.7 }, { type: 'highshelf', freq: this.o.trebleFreq || 9000, gain: this.o.treble, q: 0.7 });
    const probe = this.probe ||= new OfflineAudioContext(1, 1, this.ctx.sampleRate).createBiquadFilter(), fs = this.ctx.sampleRate;
    for (const b of nodes) {
      if (IIR_TYPES.has(b.type)) {
        const c = rbj(b.type, fs, b.freq, b.gain, b.q);
        for (let i = 0; i < f.length; i++) total[i] += iirDb(c, f[i], fs);
        continue;
      }
      probe.type = b.type; probe.frequency.value = b.freq; probe.Q.value = b.q || 0.71; probe.gain.value = b.gain;
      probe.getFrequencyResponse(f, mag, ph);
      for (let i = 0; i < mag.length; i++) total[i] += 20 * Math.log10(mag[i] || 1e-6);
    }
    return total;
  }
}
