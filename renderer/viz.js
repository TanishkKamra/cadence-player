// Visualizer: Milkdrop presets (butterchurn, WebGL) or rounded spectrum bars, rendered into any canvas.
let libs;
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src));
    document.head.append(s);
  });
}
async function loadLibs() {
  libs ||= (async () => {
    await loadScript('app://mod/butterchurn/lib/butterchurn.min.js');
    await loadScript('app://mod/butterchurn-presets/lib/butterchurnPresets.min.js');
    await loadScript('app://mod/butterchurn-presets/lib/butterchurnPresetsExtra.min.js').catch(() => {});
    const unwrap = m => m?.default || m;
    const bc = unwrap(window.butterchurn);
    const presets = {};
    for (const m of [window.butterchurnPresets, window.butterchurnPresetsExtra]) {
      const p = unwrap(m);
      if (p?.getPresets) Object.assign(presets, p.getPresets());
    }
    return { bc, presets, names: Object.keys(presets).sort() };
  })();
  return libs;
}

export class Viz {
  constructor(engine, canvas, opts = {}) {
    this.engine = engine; this.canvas = canvas;
    this.mode = opts.mode || 'milk';
    this.duration = opts.duration ?? 120;
    this.hidden = opts.hidden || [];
    this.onPreset = opts.onPreset || (() => {});
    this.running = false;
    this.history = [];
    this.peaks = [];
    this.gen = 0;
  }

  async start() {
    const gen = ++this.gen;
    this.running = true;
    this.fit();
    this.ro?.disconnect();
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(this.canvas);
    if (this.mode === 'milk') await this.startMilk(gen);
    else this.startBars();
    if (gen !== this.gen) return;
    const loop = () => {
      if (gen !== this.gen) return;
      if (!this.running) return;
      if (document.hidden || !this.engine.playing) this.tm = setTimeout(loop, 250); else this.raf = requestAnimationFrame(loop); // idle: throttle
      if (document.hidden) return;
      if (this.mode === 'milk' && this.vis) {
        this.vis.render();
        if (this.duration && performance.now() - this.presetAt > this.duration * 1000) this.next();
      } else if (this.mode === 'bars') this.drawBars();
    };
    loop();
  }

  stop() {
    this.running = false;
    this.gen++;
    cancelAnimationFrame(this.raf); clearTimeout(this.tm);
    this.ro?.disconnect();
    try { if (this.analyser) this.engine.tap.disconnect(this.analyser); } catch {}
    try { if (this.vis) this.vis.disconnectAudio?.(this.engine.tap); } catch {}
    this.vis = null;
  }

  fit() {
    const r = this.canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio, 2);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      this.vis?.setRendererSize(w, h);
    }
  }

  async startMilk(gen) {
    const { bc, presets, names } = await loadLibs();
    if (!this.running || gen !== this.gen) return;
    this.lib = { presets, names };
    this.vis = bc.createVisualizer(this.engine.ctx, this.canvas, { width: this.canvas.width, height: this.canvas.height, pixelRatio: 1, textureRatio: 1 });
    this.vis.connectAudio(this.engine.tap);
    this.random(0);
  }

  load(name, blend = 2.7) {
    if (!this.vis || !this.lib) return;
    this.vis.loadPreset(this.lib.presets[name], blend);
    this.current = name;
    this.presetAt = performance.now();
    this.onPreset(name);
  }
  random(blend = 2.7) {
    const hidden = new Set(this.hidden || []);
    const n = this.lib.names.filter(x => !hidden.has(x)).length ? this.lib.names.filter(x => !hidden.has(x)) : this.lib.names;
    let pick;
    do pick = n[Math.floor(Math.random() * n.length)]; while (n.length > 1 && pick === this.current);
    if (this.current) this.history.push(this.current);
    this.load(pick, blend);
  }
  next() { if (this.lib) this.random(); }
  prev() { if (this.history.length) this.load(this.history.pop()); }

  startBars() {
    const a = this.analyser = this.engine.ctx.createAnalyser();
    a.fftSize = 8192; a.smoothingTimeConstant = 0.72; a.minDecibels = -88; a.maxDecibels = -18;
    this.engine.tap.connect(a);
    this.fft = new Uint8Array(a.frequencyBinCount);
    this.g = this.canvas.getContext('2d');
  }

  drawBars() {
    const c = this.canvas, g = this.g, W = c.width, H = c.height;
    if (!g) return;
    this.analyser.getByteFrequencyData(this.fft);
    g.clearRect(0, 0, W, H);
    const n = Math.max(24, Math.min(72, Math.floor(W / 18))), rate = this.engine.ctx.sampleRate, bins = this.fft.length;
    const lo = Math.log(30), hi = Math.log(16000);
    const gap = W / n * 0.28, bw = W / n - gap;
    let accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().split(/\s+/).map(Number);
    if (accent.length !== 3 || !accent.every(n => n >= 0 && n <= 255)) accent = [124, 140, 255];
    const grad = g.createLinearGradient(0, H, 0, 0);
    grad.addColorStop(0, `rgba(${accent.join(',')},0.95)`);
    grad.addColorStop(1, 'rgba(255,255,255,0.95)');
    g.fillStyle = grad;
    for (let i = 0; i < n; i++) {
      const f0 = Math.exp(lo + (hi - lo) * i / n), f1 = Math.exp(lo + (hi - lo) * (i + 1) / n);
      const b0 = Math.floor(f0 / (rate / 2) * bins), b1 = Math.max(b0 + 1, Math.floor(f1 / (rate / 2) * bins));
      let v = 0;
      for (let b = b0; b < b1 && b < bins; b++) v = Math.max(v, this.fft[b]);
      const h = Math.max(bw, (v / 255) ** 1.4 * H * 0.92);
      const x = i * (bw + gap) + gap / 2;
      g.beginPath(); g.roundRect(x, H - h, bw, h, bw / 2); g.fill();
      const p = this.peaks[i] = Math.max(h, (this.peaks[i] || 0) - H * 0.006);
      g.globalAlpha = 0.6;
      g.beginPath(); g.roundRect(x, H - p - bw * 1.4, bw, bw * 0.8, bw / 2); g.fill();
      g.globalAlpha = 1;
    }
  }
}
