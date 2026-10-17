// Equalizer screen: Equalizer / Tone & Volume / Reverb tabs.
import { h, icon, debounce, signed } from './util.js';
import { S, set, engine, saveSettings } from './core.js';
import { REVERBS, REVERB_PARAMS } from './engine.js';
import { menu, toast, prompt, dialog, knob, rangeInput, dropdown, pickerButton } from './ui.js';
import { render, onTeardown } from './views.js';

export const GRAPHIC_PRESETS = {
  'Flat': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'Bass Extreme': [9, 8, 6, 3, 0, 0, 0, 0, 0, 0],
  'Bass & Treble': [6, 5, 3, 1, 0, 0, 1, 3, 5, 6],
  'Treble': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  'Soft Bass': [4, 3, 2, 1, 0, 0, 0, 0, 0, 0],
  'Soft Treble': [0, 0, 0, 0, 0, 0, 1, 2, 3, 3],
  'Soft': [2, 1, 0, -1, -1, 0, 1, 2, 3, 4],
  'Vocal': [-2, -3, -2, 1, 3, 4, 3, 1, 0, -1],
  'Middle': [-2, -1, 1, 3, 4, 4, 3, 1, -1, -2],
  'Rock': [5, 4, 3, 1, -1, -1, 1, 3, 4, 5],
  'Pop': [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2],
  'Hip-Hop': [5, 4, 1, 3, -1, -1, 1, -1, 2, 3],
  'Dance': [6, 5, 2, 0, 0, -2, -2, 0, 4, 4],
  'Techno': [5, 4, 1, -1, -2, 0, 1, 4, 5, 5],
  'Electronic': [5, 4, 1, 0, -2, 2, 1, 1, 4, 5],
  'Classical': [4, 3, 2, 1, -1, -1, 0, 2, 3, 4],
  'Acoustic': [4, 4, 3, 1, 2, 1, 3, 3, 2, 1],
  'Live': [-2, 0, 2, 3, 3, 3, 2, 1, 1, 1],
  'Loudness': [6, 4, 0, 0, -2, 0, -1, -4, 5, 1],
  'Speaker (Loud)': [5, 4, 3, 1, 0, -1, 0, 2, 3, 3],
  'Tone - lows': [5, 4, 2, 0, 0, 0, 0, 0, 0, 0],
  'Tone - highs': [0, 0, 0, 0, 0, 0, 0, 2, 4, 5],
  'Tone - lows and highs': [5, 4, 2, 0, 0, 0, 0, 2, 4, 5],
};
export const PARAM_PRESETS = {
  'Soft Bass': [{ type: 'lowshelf', freq: 131, gain: 5.2, q: 0.97 }],
  'Punchy Bass': [{ type: 'peaking', freq: 62, gain: 5, q: 1.2 }, { type: 'peaking', freq: 250, gain: -1.5, q: 1 }],
  'Clarity': [{ type: 'peaking', freq: 300, gain: -1.5, q: 1 }, { type: 'peaking', freq: 3000, gain: 2.5, q: 1 }, { type: 'highshelf', freq: 10000, gain: 3, q: 0.7 }],
  'Voice': [{ type: 'highpass', freq: 90, gain: 0, q: 0.7 }, { type: 'peaking', freq: 200, gain: -2, q: 1 }, { type: 'peaking', freq: 2500, gain: 3, q: 1.2 }],
  'Bass & Treble': [{ type: 'lowshelf', freq: 100, gain: 5, q: 0.7 }, { type: 'highshelf', freq: 8000, gain: 4, q: 0.7 }],
  'Middle': [{ type: 'peaking', freq: 1000, gain: 4, q: 0.8 }],
};
const FILTER_TYPES = { peaking: 'Peak', lowshelf: 'Low shelf', highshelf: 'High shelf', lowpass: 'Low pass', highpass: 'High pass', notch: 'Notch' };
const BAND_COLORS = ['#ff8a3d', '#4cc9f0', '#b5e48c', '#f72585', '#ffd166', '#9d8df1', '#06d6a0', '#ef476f', '#90caf9', '#ffab91'];
const BAND_COUNTS = [5, 8, 10, 15, 20, 31];

export const graphicFreqs = n => Array.from({ length: n }, (_, i) => { const f = 31 * Math.pow(16000 / 31, i / (n - 1)); return f < 1000 ? Math.round(f) : Math.round(f / 100) * 100; });
// resample a gain curve onto another band layout (log-frequency interpolation)
export function resampleGains(gains, n) {
  if (gains.length === n) return [...gains];
  const from = graphicFreqs(gains.length).map(Math.log), to = graphicFreqs(n).map(Math.log);
  return to.map(x => {
    let i = from.findIndex(f => f >= x);
    if (i <= 0) return gains[i < 0 ? gains.length - 1 : 0];
    const t = (x - from[i - 1]) / (from[i] - from[i - 1]);
    return Math.round((gains[i - 1] * (1 - t) + gains[i] * t) * 10) / 10;
  });
}
export function eqBands() {
  return set.eqMode === 'graphic'
    ? graphicFreqs(set.graphicBands).map((f, i) => ({ type: 'peaking', freq: f, gain: set.graphic[i] || 0, q: set.graphicBands > 15 ? 2.5 : set.graphicBands > 10 ? 2 : 1.41 }))
    : set.params;
}
export function applyEq() { engine.setEq(set.eqOn, eqBands(), set.preamp); saveSettings(); }
export function applyTone() { engine.setTone(set.toneOn, set.bass, set.treble, set.bassFreq, set.trebleFreq); saveSettings(); }
export function loadPreset(name, p) {
  if (!p || typeof p !== 'object') return;
  set.eqMode = p.mode;
  if (p.graphic) set.graphic = resampleGains(p.graphic, set.graphicBands);
  if (p.params) set.params = structuredClone(p.params);
  set.preamp = p.preamp || 0;
  set.eqPreset = name;
  set.eqOn = true;
  applyEq();
}
// presets bound to an output device are applied when that device becomes active
export function applyDevicePreset() {
  const name = set.deviceEq[set.device || 'default'];
  const p = name && (Object.hasOwn(set.userPresets, name) && set.userPresets[name] || (Object.hasOwn(GRAPHIC_PRESETS, name) && { mode: 'graphic', graphic: GRAPHIC_PRESETS[name] }) || (Object.hasOwn(PARAM_PRESETS, name) && { mode: 'parametric', params: PARAM_PRESETS[name] }));
  if (p && set.eqPreset !== name) { loadPreset(name, p); toast(`Equalizer: “${name}” for this output`); }
}

const fmtF = f => f >= 1000 ? +(f / 1000).toFixed(f % 1000 ? 1 : 0) + 'k' : String(Math.round(f));
const fmtDb = x => signed(x, 1, ' dB');
let tab = 'eq';

export function eqView() {
  const v = h('section', { class: 'view eq-view' });
  const content = h('div', { class: 'eq-wrap' });
  const tabs = h('div', { class: 'eq-tabs', role: 'tablist' }, ...[['eq', 'eq', 'Equalizer'], ['tone', 'knobIc', 'Tone & Volume'], ['reverb', 'reverbIc', 'Reverb']].map(([id, ic, label]) =>
    h('button', { class: tab === id ? 'on' : '', role: 'tab', 'aria-selected': String(tab === id), title: label, onclick: () => { tab = id; render('swap'); } }, icon(ic), h('span', {}, label))));
  v.append(h('div', { class: 'eq-top-bar' }, tabs), h('div', { class: 'scroll' }, content));
  if (tab === 'eq') eqTab(content);
  else if (tab === 'tone') toneTab(content);
  else reverbTab(content);
  return v;
}

function tgBtn(label, key, apply, after) {
  const b = h('button', { class: 'toggle-btn' + (set[key] ? ' on' : ''), 'aria-pressed': String(!!set[key]), onclick: () => { set[key] = !set[key]; b.classList.toggle('on', set[key]); b.setAttribute('aria-pressed', String(set[key])); apply(); after?.(); } }, label);
  return b;
}

// ---------- Equalizer tab ----------
function eqTab(content) {
  const curve = h('canvas', { 'aria-label': 'Equalizer frequency response' });
  const curveBox = h('div', { class: 'eq-curve' }, curve);
  const presetBtn = pickerButton(set.eqPreset || 'Custom', () => presetItems(), 'preset-btn');
  const markCustom = () => { if (set.eqPreset !== 'Custom') { set.eqPreset = 'Custom'; presetBtn.setLabel('Custom'); } };
  const out = h('button', { class: 'eq-info', title: 'Audio info', onclick: audioInfo }, outLabel());
  const updOut = () => { out.textContent = outLabel(); };
  engine.addEventListener('format', updOut);
  onTeardown(() => engine.removeEventListener('format', updOut));
  const seg = h('div', { class: 'seg' }, ...['graphic', 'parametric'].map(m => h('button', { class: set.eqMode === m ? 'on' : '', onclick: () => { set.eqMode = m; markCustom(); applyEq(); render('swap'); } }, m === 'graphic' ? 'Graphic' : 'Parametric')));
  const bandsSel = set.eqMode === 'graphic' ? dropdown({ label: 'Number of bands', value: set.graphicBands, options: BAND_COUNTS.map(n => [n, `${n} bands`]),
    onChange: n => { set.graphic = resampleGains(set.graphic, n); set.graphicBands = n; applyEq(); render('swap'); } }) : null;

  function presetItems() {
    const builtIn = set.eqMode === 'graphic' ? GRAPHIC_PRESETS : PARAM_PRESETS;
    const user = Object.entries(set.userPresets);
    const dev = set.device || 'default';
    return [
      { header: set.eqMode === 'graphic' ? 'Graphic presets' : 'Parametric presets' },
      ...Object.keys(builtIn).map(n => ({ label: n, checked: set.eqPreset === n, run: () => { loadPreset(n, set.eqMode === 'graphic' ? { mode: 'graphic', graphic: builtIn[n] } : { mode: 'parametric', params: builtIn[n] }); render(); } })),
      user.length ? { header: 'Your presets' } : null,
      ...user.map(([n, p]) => ({ label: n + (p.mode === 'parametric' ? ' · P' : ''), checked: set.eqPreset === n, run: () => { loadPreset(n, p); render(); } })),
      '-',
      { label: 'AutoEq headphone profiles…', icon: 'headphones', run: autoEqDialog },
      { label: 'Save current as preset…', icon: 'save', run: async () => {
        const n = await prompt('Preset name', set.eqPreset !== 'Custom' ? set.eqPreset : '');
        if (!n) return;
        if (['__proto__', 'constructor', 'prototype'].includes(n.trim())) return toast('That preset name is reserved', true);
        set.userPresets[n] = { mode: set.eqMode, graphic: [...set.graphic], params: structuredClone(set.params), preamp: set.preamp };
        set.eqPreset = n; presetBtn.setLabel(n); saveSettings(); toast(`Saved preset “${n}”`);
      } },
      set.eqPreset && set.eqPreset !== 'Custom' ? { label: set.deviceEq[dev] === set.eqPreset ? `Unbind “${set.eqPreset}” from this output` : `Bind “${set.eqPreset}” to this output`, icon: 'headphones', run: () => {
        if (set.deviceEq[dev] === set.eqPreset) delete set.deviceEq[dev]; else set.deviceEq[dev] = set.eqPreset;
        saveSettings(); toast(set.deviceEq[dev] ? 'Preset bound: it loads whenever this output is selected' : 'Preset unbound');
      } } : null,
      Object.hasOwn(set.userPresets, set.eqPreset) ? { label: `Delete “${set.eqPreset}”`, icon: 'trash', run: () => { delete set.userPresets[set.eqPreset]; markCustom(); saveSettings(); } } : null,
      { label: 'Reset to flat', icon: 'refresh', run: () => { loadPreset('Flat', { mode: set.eqMode, graphic: Array(set.graphicBands).fill(0), params: [], preamp: 0 }); render(); } },
    ];
  }

  // live spectrum ("Equalizer screen spectrum") drawn under the response curve
  const an = engine.ctx.createAnalyser();
  an.fftSize = 8192; an.smoothingTimeConstant = 0.8; an.minDecibels = -95; an.maxDecibels = -20;
  engine.tap.connect(an);
  const fft = new Uint8Array(an.frequencyBinCount);
  onTeardown(() => { try { engine.tap.disconnect(an); } catch {} });

  function drawCurve() {
    const dpr = devicePixelRatio, W = Math.round(curve.clientWidth * dpr), H = Math.round(curve.clientHeight * dpr);
    if (!W) return;
    if (curve.width !== W || curve.height !== H) { curve.width = W; curve.height = H; }
    const g = curve.getContext('2d');
    g.clearRect(0, 0, W, H);
    const lo = Math.log10(20), hi = Math.log10(20000), dbMax = 15;
    const fx = f => (Math.log10(f) - lo) / (hi - lo) * W, dy = db => H / 2 - db / dbMax * (H / 2 - 12 * dpr);
    const rgb = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().split(/\s+/).map(Number);
    const accent = (rgb.length === 3 && rgb.every(n => Number.isFinite(n) && n >= 0 && n <= 255) ? rgb : [124, 140, 255]).join(','); // bad accent: fall back, never throw
    const ink = document.body.dataset.theme === 'light' ? '0,0,0' : '255,255,255';
    if (set.vizSpectrumStyle !== 'off' && engine.playing) {
      an.getByteFrequencyData(fft);
      const rate = engine.ctx.sampleRate, n = Math.floor(W / (6 * dpr)), bw = 4 * dpr;
      g.fillStyle = `rgba(${ink},0.08)`;
      for (let i = 0; i < n; i++) {
        const f0 = Math.pow(10, lo + (hi - lo) * i / n), f1 = Math.pow(10, lo + (hi - lo) * (i + 1) / n);
        let m = 0;
        for (let b = Math.floor(f0 / (rate / 2) * fft.length); b <= Math.floor(f1 / (rate / 2) * fft.length) && b < fft.length; b++) m = Math.max(m, fft[b]);
        const hh = (m / 255) * H * 0.9;
        g.beginPath(); set.vizSpectrumStyle === 'rounded' ? g.roundRect(i * 6 * dpr, H - hh, bw, hh, bw / 2) : g.rect(i * 6 * dpr, H - hh, bw, hh); g.fill();
      }
    }
    g.strokeStyle = `rgba(${ink},0.07)`; g.lineWidth = dpr; g.font = `${10 * dpr}px Segoe UI`; g.fillStyle = `rgba(${ink},0.35)`;
    for (const f of [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) { g.beginPath(); g.moveTo(fx(f), 0); g.lineTo(fx(f), H); g.stroke(); g.fillText(fmtF(f), fx(f) + 3 * dpr, H - 5 * dpr); }
    for (const db of [-12, -6, 0, 6, 12]) { g.beginPath(); g.moveTo(0, dy(db)); g.lineTo(W, dy(db)); g.stroke(); g.fillText((db > 0 ? '+' : '') + db, 4 * dpr, dy(db) + 12 * dpr); }
    const N = 256, freqs = Array.from({ length: N }, (_, i) => Math.pow(10, lo + (hi - lo) * i / (N - 1)));
    const resp = engine.response(freqs);
    g.beginPath();
    resp.forEach((db, i) => { const x = fx(freqs[i]), y = dy(Math.max(-dbMax, Math.min(dbMax, db))); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.strokeStyle = `rgb(${accent})`; g.lineWidth = 2.5 * dpr; g.shadowColor = `rgba(${accent},0.6)`; g.shadowBlur = 10 * dpr; g.stroke(); g.shadowBlur = 0;
    g.lineTo(W, dy(0)); g.lineTo(0, dy(0)); g.closePath();
    const grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, `rgba(${accent},0.28)`); grad.addColorStop(1, `rgba(${accent},0.02)`);
    g.fillStyle = grad; g.fill();
    if (set.eqMode === 'parametric') set.params.forEach((b, i) => {
      g.beginPath(); g.arc(fx(b.freq), dy(['lowpass', 'highpass', 'notch'].includes(b.type) ? 0 : b.gain), 7 * dpr, 0, Math.PI * 2);
      g.fillStyle = BAND_COLORS[i % BAND_COLORS.length]; g.fill(); g.strokeStyle = '#000'; g.lineWidth = 2 * dpr; g.stroke();
    });
    curve.map = { fx, dy, W, H, lo, hi, dbMax, dpr };
  }
  // drag parametric points: x = frequency, y = gain, wheel = Q; double-click adds a band
  const hitBand = (e, r) => {
    const m = curve.map, b = curve.getBoundingClientRect();
    const px = (e.clientX - b.left) * m.dpr, py = (e.clientY - b.top) * m.dpr;
    return set.params.findIndex(x => Math.hypot(m.fx(x.freq) - px, m.dy(['lowpass', 'highpass', 'notch'].includes(x.type) ? 0 : x.gain) - py) < r * m.dpr);
  };
  curve.addEventListener('pointerdown', e => {
    if (set.eqMode !== 'parametric' || !curve.map) return;
    const i = hitBand(e, 14);
    if (i < 0) return;
    const m = curve.map, r = curve.getBoundingClientRect();
    curve.setPointerCapture(e.pointerId);
    const mv = ev => {
      const x = (ev.clientX - r.left) * m.dpr, y = (ev.clientY - r.top) * m.dpr, b = set.params[i];
      b.freq = Math.round(Math.min(20000, Math.max(20, Math.pow(10, m.lo + x / m.W * (m.hi - m.lo)))));
      if (!['lowpass', 'highpass', 'notch'].includes(b.type)) b.gain = Math.round(Math.max(-15, Math.min(15, (m.H / 2 - y) / (m.H / 2 - 12 * m.dpr) * m.dbMax)) * 10) / 10;
      markCustom(); applyEq(); syncCards();
    };
    curve.addEventListener('pointermove', mv);
    const end = () => { curve.removeEventListener('pointermove', mv); curve.removeEventListener('pointerup', end); curve.removeEventListener('pointercancel', end); };
    curve.addEventListener('pointerup', end);
    curve.addEventListener('pointercancel', end);
  });
  curve.addEventListener('dblclick', e => {
    if (set.eqMode !== 'parametric' || !curve.map || hitBand(e, 14) >= 0) return;
    const m = curve.map, r = curve.getBoundingClientRect();
    const x = (e.clientX - r.left) * m.dpr, y = (e.clientY - r.top) * m.dpr;
    set.params.push({ type: 'peaking', freq: Math.round(Math.min(20000, Math.max(20, Math.pow(10, m.lo + x / m.W * (m.hi - m.lo))))), gain: Math.round(Math.max(-15, Math.min(15, (m.H / 2 - y) / (m.H / 2 - 12 * m.dpr) * m.dbMax)) * 10) / 10, q: 1 });
    markCustom(); applyEq(); syncCards();
  });
  curve.addEventListener('wheel', e => {
    if (set.eqMode !== 'parametric' || !curve.map) return;
    const i = hitBand(e, 22);
    if (i < 0) return;
    e.preventDefault();
    const b = set.params[i];
    b.q = Math.round(Math.max(0.1, Math.min(12, b.q * (e.deltaY < 0 ? 1.1 : 0.9))) * 100) / 100;
    markCustom(); applyEq(); syncCards();
  }, { passive: false });

  const body = h('div', { class: 'eq-body' });
  let syncCards = () => {};
  if (set.eqMode === 'graphic') {
    const freqs = graphicFreqs(set.graphicBands);
    const vs = (val, onIn, label) => { const s = h('input', { type: 'range', class: 'vslider', min: -15, max: 15, step: 0.1, value: val, 'aria-label': label }); s.addEventListener('input', () => onIn(+s.value)); return s; };
    const fv = set.graphicBands > 15 ? x => signed(x, 1) : fmtDb;
    const pre = h('span', { class: 'val' }, fmtDb(set.preamp));
    body.append(h('div', { class: 'eq-sliders' + (set.graphicBands > 15 ? ' dense' : '') },
      h('div', { class: 'eq-band pre' }, pre, vs(set.preamp, x => { set.preamp = x; pre.textContent = fmtDb(x); markCustom(); applyEq(); }, 'Preamp'), h('span', { class: 'lbl' }, 'Preamp')),
      ...freqs.map((f, i) => {
        const val = h('span', { class: 'val' }, fv(set.graphic[i] || 0));
        const s = vs(set.graphic[i] || 0, x => { set.graphic[i] = x; val.textContent = fv(x); markCustom(); applyEq(); }, fmtF(f) + ' Hz');
        s.addEventListener('dblclick', () => { set.graphic[i] = 0; s.value = 0; val.textContent = fv(0); markCustom(); applyEq(); });
        return h('div', { class: 'eq-band' }, val, s, h('span', { class: 'lbl' }, fmtF(f)));
      })));
  } else {
    const cards = h('div', { class: 'pbands' });
    let firstCards = true; // only the first build fades in: rebuilt cards are never re-observed by the reveal observer
    const renderCards = () => {
      const reveal = firstCards ? ' reveal' : ''; firstCards = false;
      cards.replaceChildren(...set.params.map((b, i) => {
        const row = (label, min, max, step, val, fmt, onIn, log) => {
          const toS = x => log ? Math.log10(x) : x, fromS = x => log ? Math.round(Math.pow(10, x)) : x;
          const o = h('output', {}, fmt(val));
          const r = rangeInput({ min: toS(min), max: toS(max), step: log ? 0.001 : step, value: toS(val), label, onInput: x => { const y = fromS(x); o.textContent = fmt(y); onIn(y); } });
          return h('label', {}, label, r, o);
        };
        const typeSel = dropdown({ label: 'Filter type', cls: 'sm', value: b.type, options: Object.entries(FILTER_TYPES), onChange: v => { b.type = v; markCustom(); applyEq(); } });
        return h('div', { class: 'pband' + reveal, style: { '--bc': BAND_COLORS[i % BAND_COLORS.length], '--i': String(i) } },
          h('div', { class: 'ph' }, h('b', {}, `Band ${i + 1}`), typeSel, h('button', { class: 'icon-btn', title: 'Remove band', 'aria-label': 'Remove band', onclick: () => { set.params.splice(i, 1); markCustom(); applyEq(); renderCards(); } }, icon('close', 'sm'))),
          row('Freq', 20, 20000, 1, b.freq, x => x >= 1000 ? (x / 1000).toFixed(2) + ' kHz' : x + ' Hz', x => { b.freq = x; markCustom(); applyEq(); }, true),
          row('Gain', -15, 15, 0.1, b.gain, fmtDb, x => { b.gain = x; markCustom(); applyEq(); }),
          row('Q', 0.1, 12, 0.01, b.q, x => (+x).toFixed(2), x => { b.q = x; markCustom(); applyEq(); }));
      }), h('button', { class: 'pband add', onclick: () => { set.params.push({ type: 'peaking', freq: 1000, gain: 0, q: 1 }); markCustom(); applyEq(); renderCards(); } }, icon('plus', 'lg'), 'Add band'));
    };
    syncCards = debounce(renderCards, 120);
    renderCards();
    body.append(h('div', { class: 'knobs' }, knob({ label: 'Preamp', min: -15, max: 15, value: set.preamp, fmt: fmtDb, onInput: x => { set.preamp = x; markCustom(); applyEq(); } }),
      h('div', { class: 'hint' }, 'Drag points on the curve to move a band, scroll over a point to change its width (Q), double-click the curve to add a band.')), cards);
  }
  content.append(
    h('div', { class: 'toolbar flush' }, tgBtn('Equ', 'eqOn', applyEq), tgBtn('Tone', 'toneOn', applyTone), tgBtn('Limit', 'limiter', () => { engine.setLimiter(set.limiter); saveSettings(); }), seg, bandsSel, h('span', { class: 'tb-spacer' }), presetBtn),
    curveBox, out, body);
  let raf, tm;
  const loop = () => {
    if (document.hidden || !engine.playing) tm = setTimeout(loop, 250); else raf = requestAnimationFrame(loop); // idle: no 60 fps loop
    if (!document.hidden) drawCurve();
  };
  loop();
  onTeardown(() => { cancelAnimationFrame(raf); clearTimeout(tm); });
}

// ---------- Tone & Volume tab ----------
function toneTab(content) {
  const k = (label, key, min, max, fmt, apply, def = 0, step = 0.1, size, origin) => knob({ label, min, max, step, value: set[key], def, fmt, size, origin, onInput: x => { set[key] = x; apply(); } });
  const applyTP = debounce(() => engine.setTempoPitch(set.tempo, set.semitones), 250);
  const tempoK = k('Tempo', 'tempo', 0.5, 2, x => x.toFixed(2) + '×', () => { saveSettings(); applyTP(); }, 1, 0.01, 120, 1);
  const bassK = k('Bass', 'bass', -15, 15, fmtDb, applyTone), trebleK = k('Treble', 'treble', -15, 15, fmtDb, applyTone);
  bassK.setOff(!set.toneOn); trebleK.setOff(!set.toneOn);
  const toneOn = tgBtn('Tone', 'toneOn', applyTone, () => { bassK.setOff(!set.toneOn); trebleK.setOff(!set.toneOn); });
  const monoBtn = tgBtn('Mono', 'mono', () => { engine.setMono(set.mono); saveSettings(); });
  const volK = knob({ label: 'Volume', min: 0, max: 100, step: 1, value: Math.round(set.volume * 100), def: 80, size: 132, fmt: x => x + '%', onInput: x => { set.volume = x / 100; engine.setVolume(set.volume); saveSettings(); document.dispatchEvent(new Event('cadence:volume')); } });
  content.append(
    h('div', { class: 'fx-grid' },
      h('div', { class: 'fx-card reveal' }, h('h3', {}, 'Tone', toneOn), h('div', { class: 'knobs' }, bassK, trebleK,
        k('Bass freq', 'bassFreq', 40, 400, x => Math.round(x) + ' Hz', applyTone, 90, 1),
        k('Treble freq', 'trebleFreq', 2000, 16000, x => (x / 1000).toFixed(1) + ' kHz', applyTone, 9000, 100))),
      h('div', { class: 'fx-card reveal' }, h('h3', {}, 'Stereo', monoBtn), h('div', { class: 'knobs' },
        k('Balance', 'balance', -1, 1, x => x === 0 ? 'Center' : (x < 0 ? 'L ' : 'R ') + Math.round(Math.abs(x) * 100), () => { engine.setBalance(set.balance); saveSettings(); }, 0, 0.01),
        k('Stereo Expand', 'width', 1, 2.5, x => Math.round((x - 1) / 1.5 * 100) + '%', () => { engine.setWidth(set.width); saveSettings(); }, 1, 0.01))),
      h('div', { class: 'fx-card reveal' }, h('h3', {}, 'Tempo', h('div', { class: 'row-btns' },
        h('button', { class: 'tb-btn', onclick: () => { set.tempo = Math.max(0.5, +(set.tempo - 0.05).toFixed(2)); tempoK.set(set.tempo); saveSettings(); applyTP(); } }, '−'),
        h('button', { class: 'tb-btn', onclick: () => { set.tempo = Math.min(2, +(set.tempo + 0.05).toFixed(2)); tempoK.set(set.tempo); saveSettings(); applyTP(); } }, '+'),
        h('button', { class: 'tb-btn', onclick: () => { set.tempo = 1; set.semitones = 0; saveSettings(); applyTP(); render(); } }, 'Reset'))),
        h('div', { class: 'knobs' }, tempoK, k('Pitch', 'semitones', -12, 12, x => (x > 0 ? '+' : '') + x + ' st', () => { saveSettings(); applyTP(); }, 0, 1))),
      h('div', { class: 'fx-card reveal' }, h('h3', {}, 'Volume'), h('div', { class: 'knobs center' }, volK))));
}

// ---------- Reverb tab ----------
function reverbTab(content) {
  const r = set.reverb;
  const apply = () => { engine.setReverb(r); saveSettings(); };
  const onBtn = h('button', { class: 'toggle-btn' + (r.on ? ' on' : ''), 'aria-pressed': String(r.on), onclick: () => { r.on = !r.on; onBtn.classList.toggle('on', r.on); apply(); } }, 'Reverb');
  const labels = { size: 'Size', damp: 'Damp', filter: 'Filter', fade: 'Fade', preDelay: 'Pre-Delay', preDelayMix: 'Pre-Delay Mix', mix: 'Mix' };
  const knobs = REVERB_PARAMS.map(p => knob({ label: labels[p], min: 0, max: 1, step: 0.01, value: r[p], def: REVERBS.Scene[p], fmt: x => x.toFixed(2), size: p === 'mix' ? 120 : 92, onInput: x => { r[p] = x; r.preset = 'Custom'; presetBtn.setLabel('Custom'); apply(); } }));
  const presetBtn = pickerButton(r.preset || 'Custom', () => [
    ...Object.keys(REVERBS).map(n => ({ label: n, checked: r.preset === n, run: () => { Object.assign(r, REVERBS[n], { preset: n, on: true }); apply(); render(); } })),
    ...Object.keys(set.userReverbs || {}).length ? [{ header: 'Your presets' }, ...Object.entries(set.userReverbs).map(([n, p]) => ({ label: n, checked: r.preset === n, run: () => { Object.assign(r, p, { preset: n, on: true }); apply(); render(); } }))] : [],
  ], 'preset-btn');
  const save = h('button', { class: 'tb-btn', onclick: async () => { const n = await prompt('Reverb preset name', r.preset !== 'Custom' ? r.preset : ''); if (!n) return; (set.userReverbs ||= {})[n] = Object.fromEntries(REVERB_PARAMS.map(p => [p, r[p]])); r.preset = n; presetBtn.setLabel(n); saveSettings(); toast(`Saved reverb “${n}”`); } }, 'Save');
  const reset = h('button', { class: 'tb-btn', onclick: () => { Object.assign(r, REVERBS.Scene, { preset: 'Scene' }); apply(); render(); } }, 'Reset');
  content.append(h('div', { class: 'toolbar flush' }, onBtn, h('span', { class: 'tb-spacer' }), presetBtn, save, reset),
    h('div', { class: 'fx-card reverb' + (r.on ? '' : ' dim') }, h('div', { class: 'knobs grid3' }, ...knobs.slice(0, 6)), h('div', { class: 'knobs center' }, knobs[6])));
}

// ---------- audio info ----------
function outLabel() {
  const f = engine.outFormat;
  if (!engine.o.exclusive) return `Output · ${engine.ctx.sampleRate / 1000} kHz · 32-bit float`;
  return f ? `Exclusive · ${f.rate / 1000} kHz · ${f.bits}-bit${engine.bitPerfect ? ' · bit-perfect' : ''}` : 'Exclusive output';
}

export function audioInfo() {
  const t = engine.track, c = engine.ctx, o = engine.o;
  const rows = [
    ['Source', t ? `${t.stream ? 'Internet stream' : t.codec}${t.bits ? ' · ' + t.bits + '-bit' : ''}${t.sampleRate ? ' · ' + t.sampleRate / 1000 + ' kHz' : ''}${t.channels ? ' · ' + t.channels + ' ch' : ''}${t.bitrate ? ' · ' + Math.round(t.bitrate / 1000) + ' kbps' : ''}` : 'Nothing playing'],
    ['Decoder', 'ffmpeg → 32-bit float PCM'],
    ['Resampler', t?.sampleRate && t.sampleRate !== c.sampleRate ? `${t.sampleRate / 1000} → ${c.sampleRate / 1000} kHz (64-tap windowed sinc)` : 'Not needed (rates match)'],
    ['Tempo / pitch', `${(o.tempo || 1).toFixed(2)}× · ${o.semitones || 0} semitones`],
    ['ReplayGain', o.rgMode === 'off' ? 'Off' : `${o.rgMode} gain${o.preventClip ? ', clip-safe' : ''}`],
    ['Equalizer', o.eqOn ? `${set.eqMode === 'graphic' ? set.graphicBands + '-band graphic' : set.params.length + '-band parametric'} · preset “${set.eqPreset}” · preamp ${fmtDb(o.preamp)}` : 'Off'],
    ['Tone', o.toneOn ? `bass ${fmtDb(o.bass)} @ ${o.bassFreq} Hz · treble ${fmtDb(o.treble)} @ ${o.trebleFreq} Hz` : 'Off'],
    ['Stereo', `${o.mono ? 'Mono' : 'Stereo'} · balance ${o.balance || 0} · expand ${Math.round(((o.width || 1) - 1) / 1.5 * 100)}%`],
    ['Reverb', o.reverb?.on ? `${set.reverb.preset} · mix ${set.reverb.mix.toFixed(2)}` : 'Off'],
    ['Limiter', o.limiter ? 'On (−1 dBFS, 20:1)' : 'Off'],
    ['Crossfade', set.xfMode === 'none' ? 'Off (gapless)' : `${set.xfMode} · ${set.crossfadeLen} s`],
    ['Output', `Web Audio · ${c.sampleRate / 1000} kHz · 32-bit float · ${set.device ? 'selected device' : 'system default device'}`],
    ['Latency', `${Math.round(((c.baseLatency || 0) + (c.outputLatency || 0)) * 1000)} ms output`],
  ];
  const f = engine.outFormat;
  if (o.exclusive) rows.splice(1, rows.length - 1,
    ['Decoder', 'ffmpeg → 32-bit integer PCM at the source rate'],
    ['Output', f ? `WASAPI exclusive · ${f.rate / 1000} kHz · ${f.bits}-bit in ${f.container}-bit · ${set.device ? 'selected device' : 'system default device'}` : 'WASAPI exclusive · not open yet'],
    ['Bit-perfect', engine.bitPerfect ? 'Yes' : !f || !t?.sampleRate ? '—' : f.rate !== t.sampleRate ? `No: the device refused ${t.sampleRate / 1000} kHz, resampled to ${f.rate / 1000} kHz` : `No: volume ${Math.round(o.volume * 100)}% scales samples (100% = bit-perfect)`],
    ['DSP', 'Bypassed (EQ, tone, reverb, limiter, tempo, ReplayGain, crossfade)']);
  dialog('Audio info', h('table', {}, ...rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v)))), [{ label: 'Close', primary: true, id: 1 }], true);
}

// ---------- AutoEq ----------
async function autoEqDialog() {
  const input = h('input', { type: 'text', placeholder: 'Search 8,000+ headphones and IEMs…' });
  const list = h('div', { class: 'aeq-list' }, h('div', { class: 'hint' }, 'Loading AutoEq index…'));
  let index = [];
  const draw = () => {
    const q = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = (q.length ? index.filter(x => q.every(w => (x.name + ' ' + x.source).toLowerCase().includes(w))) : index).slice(0, 150);
    list.replaceChildren(...(hits.length ? hits.map(x =>h('button', { class: 'aeq-row', onclick: async () => {
      try {
        const p = await api.invoke('autoeq:get', x);
        loadPreset(`AutoEq: ${x.name}`, { mode: 'parametric', params: p.bands, preamp: p.preamp });
        set.userPresets[`AutoEq: ${x.name}`] = { mode: 'parametric', params: p.bands, preamp: p.preamp };
        saveSettings();
        document.querySelector('.scrim')?.remove();
        toast(`Loaded AutoEq profile for ${x.name}`);
        render();
      } catch (err) { toast('AutoEq: ' + err.message, true); }
    } }, h('b', {}, x.name), h('span', {}, x.source))) : [h('div', { class: 'hint' }, 'No matches')]));
  };
  input.addEventListener('input', debounce(draw, 120));
  api.invoke('autoeq:index').then(ix => { index = ix; draw(); }).catch(() => list.replaceChildren(h('div', { class: 'hint' }, 'Couldn’t reach the AutoEq database. Check your connection.')));
  dialog('AutoEq headphone profiles', h('div', {}, input, list, h('div', { class: 'hint' }, 'Profiles from the open-source AutoEq project correct each headphone toward a neutral target. Loaded profiles are saved to “Your presets”.')), [{ label: 'Close', id: null }], true);
}
