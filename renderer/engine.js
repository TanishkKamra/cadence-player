// Audio engine: ffmpeg (main process) -> worklet PCM player -> 64-bit DSP worklet (dsp.js, the same code as the exclusive
// helper's native/dsp.cs) -> output device.
import { biquadCoef, biquadDb } from './dsp.js';

// crossfeed presets (bs2b's): on, corner Hz, how far below the direct sound the crossed bass sits (dB)
const XFEED = { bs2b: '1 700 4.5', cmoy: '1 700 6', meier: '1 650 9.5' };

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

    await ctx.audioWorklet.addModule('dsp.js');
    this.fader = ctx.createGain();
    // EQ, tone, balance, width, reverb, volume and the true-peak limiter: output 0 plays, output 1 (post-EQ, pre-volume) feeds
    // the visualizers. Volume sits before the limiter (like direct volume control)
    this.dsp = new AudioWorkletNode(ctx, 'cadence-dsp', { numberOfInputs: 1, numberOfOutputs: 2, outputChannelCount: [2, 2], channelCount: 2, channelCountMode: 'explicit' });
    this.dsp.port.onmessage = e => { if (e.data.latency != null) this.dspLatency = e.data.latency / ctx.sampleRate; };
    this.dspLatency = 0;
    this.tap = ctx.createGain();
    this.node.connect(this.fader).connect(this.dsp).connect(ctx.destination);
    this.dsp.connect(this.tap, 1);

    this.applyAll();
    this.emit('ready');
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
    this.setCrossfeed(o.crossfeed);
    this.setGap(o.gap || 0);
    this.setLimiter(o.limiter);
    this.setVolume(o.volume);
    this.setCrossfade(o.crossfade);
  }
  set(k, v) { this.o[k] = v; }
  // bands: [{ type: 'peaking'|'lowshelf'|'highshelf'|'lowpass'|'highpass'|'notch', freq, gain, q }]
  setEq(on, bands, preamp) {
    Object.assign(this.o, { eqOn: on, eqBands: bands, preamp });
    this.regain();
    this.syncDsp();
  }
  setTone(on, bass, treble, bassFreq = this.o.bassFreq || 90, trebleFreq = this.o.trebleFreq || 9000) {
    Object.assign(this.o, { toneOn: on, bass, treble, bassFreq, trebleFreq });
    this.regain();
    this.syncDsp();
  }
  setBalance(v) { this.o.balance = v; this.syncDsp(); }
  setWidth(v) { this.o.width = v; this.syncDsp(); }
  // r: { on, size, damp, filter, fade, preDelay, preDelayMix, mix }
  setReverb(r) { this.o.reverb = { ...r }; this.syncDsp(); }
  // ceiling: true-peak ceiling in dBTP (-1 or -0.3); guard: keep the true-peak stage on even when every other stage is off
  setLimiter(on, ceiling = this.o.ceiling ?? -1, guard = !!this.o.guard) { Object.assign(this.o, { limiter: on, ceiling, guard }); this.syncDsp(); }
  setVolume(v) {
    v = clamp(v, 0, 1, 0);
    // applied inside Cadence before the limiter, like direct volume control: below full volume the EQ boosts
    // have room to be heard as boosts; the limiter only steps in near the top of the slider
    this.o.volume = v;
    if (!this.o.exclusive) this.dsp.port.postMessage({ volume: v * v });
    if (this.o.exclusive) this.port.postMessage({ type: 'volume', value: v * v }); // < 100% scales samples: not bit-perfect
  }
  async deviceLabel() {
    const d = this.o.device && (await navigator.mediaDevices.enumerateDevices()).find(d => d.kind === 'audiooutput' && d.deviceId === this.o.device);
    return d?.label || '';
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
    if (this.o.exclusive && !changedRate) return this.setExclusive(true); // reopens the helper on the new device
    if (!changedRate) return this.ctx.setSinkId(device || '').catch(e => this.emit('error', { message: 'Output device: ' + e.message }));
    const resume = this.cur && { entry: this.cur.entry, start: this.position, play: this.playing, quiet: true };
    this.stop();
    await this.ctx.close();
    await this.init();
    if (resume) this.load(resume.entry, resume);
  }

  // exclusive mode skips Web Audio: the WASAPI helper runs the same EQ, tone, balance, width, reverb, limiter and ReplayGain
  // in 64-bit (native/dsp.cs) at the file's own rate. Tempo/pitch, crossfade and the visualizers are not available there.
  async setExclusive(on) {
    const resume = this.cur && { entry: this.cur.entry, start: this.position, play: this.playing, quiet: true };
    this.stop();
    this.o.exclusive = on;
    this.port = on ? this.xoPort : this.node.port;
    this.outFormat = null; this.xoState = null;
    this.xoRefused = new Set();
    if (on) { await this.xoConfig(); this.ctx.suspend(); }
    this.applyAll();
    if (resume) this.load(resume.entry, resume);
  }
  async xoConfig() {
    this.port.postMessage({ type: 'config', device: await this.deviceLabel() }); // the helper matches the endpoint by name
  }
  // the DSP settings to the exclusive helper or the shared-output worklet (both parse them as DspConfig); one message per task
  syncDsp() {
    if (this.dspQueued) return;
    this.dspQueued = true;
    queueMicrotask(() => {
      this.dspQueued = false;
      if (this.o.exclusive) this.port.postMessage({ type: 'dsp', text: this.dspText() });
      else this.dsp?.port.postMessage({ dsp: this.dspText() });
    });
  }
  dspText() {
    const o = this.o, r = o.reverb || {}, n = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
    return [
      `pre ${o.eqOn ? n(o.preamp) : 0}`,
      ...(o.eqOn ? o.eqBands || [] : []).map(b => `band ${b.type} ${n(b.freq, 1000)} ${n(b.gain)} ${n(b.q, 0.71)}`),
      `bass ${o.toneOn ? n(o.bass) : 0} ${n(o.bassFreq, 90)}`, `treble ${o.toneOn ? n(o.treble) : 0} ${n(o.trebleFreq, 9000)}`,
      `bal ${n(o.balance)}`, `width ${n(o.width, 1)}`, `mono ${o.mono ? 1 : 0}`, `xfeed ${XFEED[o.crossfeed] || '0 700 4.5'}`, `lim ${o.limiter ? 1 : 0}`, `ceil ${n(o.ceiling, -1)}`, `guard ${o.guard ? 1 : 0}`,
      `rev ${r.on ? 1 : 0} ${['size', 'damp', 'filter', 'fade', 'preDelay', 'preDelayMix', 'mix'].map(k => n(r[k])).join(' ')}`,
    ].join(';');
  }
  onXo(m) {
    if (!this.o.exclusive) return;
    if (m.type === 'format') { this.outFormat = m; this.emit('format', m); }
    else if (m.type === 'dsp') { this.xoState = m; this.emit('format', this.outFormat); }
    else if (m.type === 'uvol') { // the DAC volume was changed with the keys or in Windows: the slider follows
      const v = Math.sqrt(clamp(m.value, 0, 1, 0));
      if (Math.abs(v - this.o.volume) > 0.004) { this.o.volume = v; this.emit('volume', v); }
    }
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
    if (o.rgMode === 'off') return 1;
    const useAlbum = o.rgMode === 'album' && rg?.ag != null;
    const db = rg ? (useAlbum ? rg.ag : rg.tg) : null;
    if (db == null) return dbToGain(clamp(o.noRgPreamp, -24, 24, 0));
    let gain = dbToGain(clamp(db, -24, 24, 0) + clamp(o.rgPreamp, -24, 24, 0));
    const peak = useAlbum ? rg.ap : rg.tp;
    if (o.preventClip && peak > 0) gain = Math.min(gain, 1 / peak); // the track's own peak: EQ boosts are the limiter's job
    return gain;
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
  setMono(on) { this.o.mono = on; this.syncDsp(); }
  setCrossfeed(v) { this.o.crossfeed = v; this.syncDsp(); }
  setGap(sec) { this.o.gap = sec; this.port.postMessage({ type: 'gap', frames: Math.round(sec * this.ctx.sampleRate) }); }

  get position() {
    const s = this.cur;
    if (!s) return 0;
    if (this.seekPos != null) return this.seekPos;
    const ctx = this.ctx;
    const latency = this.o.exclusive ? 0 : (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + this.dspLatency; // the helper reports frames actually played
    const live = this.playing && s.at != null ? Math.min(this.now() - s.at, 0.25) : 0;
    return Math.max(s.start, s.start + (s.frames / s.rate + live - (this.playing ? latency : 0)) * s.tempo);
  }
  // untouched samples: native rate, every DSP stage neutral, ReplayGain off, and volume carried by the DAC (or at 100%)
  get bitPerfect() {
    const f = this.outFormat, t = this.track;
    return !!f && !!this.xoState && !this.xoState.active && f.rate === (t?.sampleRate || f.rate) && (!t || this.trackGain(t) === 1);
  }
  get track() { return this.cur?.track || null; }
  get entry() { return this.cur?.entry || null; }

  // combined magnitude response (dB) of the EQ bands and tone shelves, for drawing the EQ curve: the DSP's own coefficients,
  // from the target values, so the curve tracks the sliders exactly. Preamp is a separate flat gain stage (as in ).
  response(freqs) {
    const total = new Float32Array(freqs.length), fs = this.ctx.sampleRate, n = (v, d) => (Number.isFinite(+v) ? +v : d);
    const nodes = [];
    if (this.o.eqOn) nodes.push(...this.o.eqBands);
    if (this.o.toneOn) nodes.push({ type: 'lowshelf', freq: this.o.bassFreq || 90, gain: this.o.bass, q: 0.7 }, { type: 'highshelf', freq: this.o.trebleFreq || 9000, gain: this.o.treble, q: 0.7 });
    for (const b of nodes) {
      const k = biquadCoef(b.type, fs, n(b.freq, 1000), n(b.gain, 0), n(b.q, 0.71));
      for (let i = 0; i < freqs.length; i++) total[i] += biquadDb(k, freqs[i], fs);
    }
    return total;
  }
}
