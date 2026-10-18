// Fusion C "Lit Chassis": song palette -> lamp + inks, the Pour, level knob, power-on warm-up, phosphor rings.
// Idle is still: the only loop is the rings canvas, and only while audio plays AND the window is visible AND Now Playing is open
// AND Settings > Live visuals is on (capped at one frame per 15.5 ms, i.e. at most 60 fps). Paused = one static paint.
import { set, engine } from '../../core.js';
import { setVolume, P, drawSeek } from '../../player.js';
import { motionOff } from '../../motion.js';

const root = document.documentElement, body = document.body, ink = document.getElementById('ink'), main = document.getElementById('main');
const $ = (s, r = document) => r.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); kids.forEach(c => e.append(c)); return e; };
const el = (tag, cls, ...kids) => { const e = document.createElement(tag); e.className = cls; kids.forEach(c => e.append(c)); return e; };

// ---------- colour maths ----------
const lum = ([r, g, b]) => { const f = c => (c /= 255) <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
function hsl([r, g, b]) { r /= 255; g /= 255; b /= 255; const M = Math.max(r, g, b), m = Math.min(r, g, b), l = (M + m) / 2; if (M === m) return [0, 0, l];
  const d = M - m, s = l > .5 ? d / (2 - M - m) : d / (M + m); const h = M === r ? (g - b) / d + (g < b ? 6 : 0) : M === g ? (b - r) / d + 2 : (r - g) / d + 4; return [h / 6, s, l]; }
function rgb(h, s, l) { const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q, f = t => { t = (t + 1) % 1; return Math.round(255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p)); }; return [f(h + 1 / 3), f(h), f(h - 1 / 3)]; }
const HOUSE = [255, 138, 61];

// Palette: weighted hue buckets (saturation x population) -> up to 3 inks >= ~60deg apart when possible, plus the average shadow.
function palette(img, fallback) {
  const inks = [];
  let shadow = [20, 20, 24];
  if (img) {
    const N = 48, c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, N, N);
    const d = g.getImageData(0, 0, N, N).data, B = new Map(); let dr = 0, dg = 0, db = 0, dn = 0;
    for (let i = 0; i < d.length; i += 4) {
      const px = [d[i], d[i + 1], d[i + 2]], [h, s, l] = hsl(px);
      if (l < .3) { dr += px[0]; dg += px[1]; db += px[2]; dn++; }
      if (l < .1 || l > .93 || s < .12) continue;
      const k = Math.round(h * 12) % 12, w = s * s * (1 - Math.abs(l - .5)) + .01, b = B.get(k) || { w: 0, h: 0, s: 0, l: 0 };
      b.w += w; b.h += (k === 0 && h > .5 ? h - 1 : h) * w; b.s += s * w; b.l += l * w; B.set(k, b);
    }
    const all = [...B.entries()].sort((a, b) => b[1].w - a[1].w), pick = [];
    for (const [k, b] of all) { if (pick.every(([k2]) => { const dk = Math.abs(k - k2); return Math.min(dk, 12 - dk) >= 2; })) pick.push([k, b]); if (pick.length === 3) break; }
    for (const [k, b] of all) { if (pick.length === 3) break; if (!pick.some(p => p[1] === b)) pick.push([k, b]); }
    for (const [, b] of pick) inks.push(rgb(((b.h / b.w) + 1) % 1, Math.min(.9, Math.max(.5, b.s / b.w * 1.1)), Math.min(.6, Math.max(.4, b.l / b.w))));
    if (dn > 20) shadow = [dr / dn, dg / dn, db / dn].map(Math.round);
  }
  if (!inks.length) inks.push(fallback || HOUSE); // grey / dull covers: house orange keeps the chassis lit
  const h0 = hsl(inks[0])[0];
  while (inks.length < 3) inks.push(rgb((h0 + (inks.length === 1 ? .12 : .56)) % 1, .55, .46)); // analogous / split-complement
  return { inks, shadow };
}

let cur = null; // last palette, so a theme switch re-derives without a pour
function derive(pal, theme) {
  const [a, b, c] = pal.inks, light = theme === 'light', blk = theme === 'black';
  const hh = hsl(mix(a, pal.shadow, .5))[0];
  const deep = light ? rgb(hh, .3, .93) : blk ? rgb(hh, .5, .03) : rgb(hh, .38, .075);
  const worst = light ? mix(deep, a, .22) : mix(deep, a, .28);
  let [ah, as] = hsl(a), al = light ? .32 : .66, acc = rgb(ah, Math.min(.95, as + .1), al), n = 0;
  while (contrast(acc, worst) < 4.6 && n++ < 40) { al += light ? -.02 : .02; acc = rgb(ah, Math.min(.95, as + .1), Math.min(.95, Math.max(.1, al))); }
  // lamp: accent re-lit for fills/glow (dark: L .66, S .62-.95); in light it stays the AA-dark accent
  const lamp = light ? acc : rgb(ah, Math.max(.62, Math.min(.95, as + .1)), .66);
  const onLamp = contrast([0, 0, 0], lamp) >= contrast([255, 255, 255], lamp) ? [8, 8, 10] : [255, 255, 255];
  // ring colours must glow on the chassis: lift each ink
  const ringc = [lamp, ...[b, c].map(x => { const [h, s] = hsl(x); return light ? rgb(h, Math.max(.6, s), .38) : rgb(h, Math.max(.6, Math.min(.95, s)), .64); })];
  return { a, b, c, deep, acc, lamp, onLamp, ringc };
}
function apply(p) {
  const put = (k, v) => root.style.setProperty(k, v.join(' '));
  put('--ink-a', p.a); put('--ink-b', p.b); put('--ink-c', p.c); put('--deep', p.deep); put('--accent', p.acc); put('--lamp', p.lamp); { const [h, sa] = hsl(p.a); put('--lcd', rgb(h, Math.max(.62, Math.min(.95, sa + .1)), .66)); } put('--on-lamp', p.onLamp);
  window.fcRings = p.ringc; fcDraw();
}

// ---------- the Pour ----------
const fieldCss = (p, light) => `radial-gradient(52% 64% at 90% 22%, rgb(${p.a.join(' ')} / ${light ? .5 : .74}), transparent 72%),
  radial-gradient(58% 56% at 2% 100%, rgb(${p.b.join(' ')} / ${light ? .42 : .64}), transparent 72%),
  radial-gradient(50% 46% at 34% 0%, rgb(${p.c.join(' ')} / ${light ? .36 : .5}), transparent 70%), linear-gradient(rgb(var(--deep)), rgb(var(--deep)))`;
let seq = 0;
window.addEventListener('cadence:art', e => {
  const { img, rgb: base } = e.detail, my = ++seq, theme = body.dataset.theme;
  let pal; try { pal = palette(img, base); } catch (x) { console.error('fc palette', x.message); return; }
  cur = pal;
  const p = derive(pal, theme); apply(p);
  const layer = document.createElement('div'); layer.className = 'ink-l';
  layer.style.backgroundImage = fieldCss(p, theme === 'light');
  const old = [...ink.children], first = !ink.dataset.has; ink.dataset.has = 1;
  const art = $('#player .np-art'), r = art ? art.getBoundingClientRect() : { left: innerWidth * .8, top: 300, width: 0, height: 0 };
  const ox = r.left + r.width / 2, oy = r.top + r.height / 2;
  layer.style.setProperty('--ox', ox + 'px'); layer.style.setProperty('--oy', oy + 'px');
  ink.append(layer);
  const done = () => old.forEach(o => o.remove());
  if (first || motionOff() || my !== seq) { layer.style.setProperty('--r', '300vmax'); return done(); }
  layer.classList.add('pouring');
  const reach = Math.hypot(Math.max(ox, innerWidth - ox), Math.max(oy, innerHeight - oy)) + 220;
  const dur = Math.round(2000 * (body.classList.contains('anim-fast') ? .6 : 1)); // ink spreads on a long ease (a spring is front-loaded: the mask would be done in 600 ms)
  const a = layer.animate([{ '--r': '0px' }, { '--r': reach + 'px' }], { duration: dur, easing: 'cubic-bezier(.42,0,.18,1)', fill: 'forwards' });
  a.finished.then(() => { layer.classList.remove('pouring'); layer.style.setProperty('--r', '300vmax'); a.cancel(); done(); }, () => {});
});
// a theme switch re-derives the chassis from the same palette (no pour)
new MutationObserver(() => {
  if (!cur) return;
  const p = derive(cur, body.dataset.theme); apply(p);
  const l = ink.lastElementChild; if (l) l.style.backgroundImage = fieldCss(p, body.dataset.theme === 'light');
}).observe(body, { attributes: true, attributeFilter: ['data-theme'] });

// ---------- level knob (replaces the volume range): 41 ticks light to the level, detent every 5 ----------
const ticksG = svg('g');
for (let i = 0; i < 41; i++) {
  const a = (-135 + 270 * i / 40) * Math.PI / 180, big = i % 5 === 0, r0 = 47, r1 = big ? 39 : 42.5;
  ticksG.append(svg('line', { x1: 50 + r0 * Math.sin(a), y1: 50 - r0 * Math.cos(a), x2: 50 + r1 * Math.sin(a), y2: 50 - r1 * Math.cos(a), class: 'k-t' + (big ? ' big' : ''), 'data-i': i, style: `--i:${i}` }));
}
const cap = el('div', 'fc-knob-cap', el('i', 'fc-knob-dot'));
const knob = el('div', 'fc-knob'); knob.tabIndex = 0;
knob.setAttribute('role', 'slider'); knob.setAttribute('aria-label', 'Volume'); knob.setAttribute('aria-valuemin', '0'); knob.setAttribute('aria-valuemax', '100');
knob.append(svg('svg', { viewBox: '0 0 100 100', class: 'fc-ticks', 'aria-hidden': 'true' }, ticksG), cap);
const read = el('div', 'fc-read'); read.textContent = 'LVL 00';
const knobWrap = el('div', 'fc-knob-wrap', knob, read);
let kv = -1;
function paintKnob(v = set.volume) {
  if (v === kv) return; kv = v;
  read.textContent = 'LVL ' + String(Math.round(v * 100)).padStart(2, '0');
  cap.style.transform = `rotate(${-135 + 270 * v}deg)`;
  const lit = Math.round(v * 40);
  ticksG.querySelectorAll('.k-t').forEach(t => t.classList.toggle('on', +t.dataset.i <= lit && v > 0));
  knob.setAttribute('aria-valuenow', Math.round(v * 100));
}
let drag = null;
knob.addEventListener('pointerdown', e => { knob.setPointerCapture(e.pointerId); drag = { y: e.clientY, v: set.volume }; knob.classList.add('drag'); });
knob.addEventListener('pointermove', e => { if (drag) setVolume(drag.v + (drag.y - e.clientY) / 160); });
const endDrag = () => { drag = null; knob.classList.remove('drag'); };
knob.addEventListener('pointerup', endDrag); knob.addEventListener('pointercancel', endDrag);
knob.addEventListener('wheel', e => { e.preventDefault(); setVolume(set.volume - Math.sign(e.deltaY) * 0.03); }, { passive: false });
knob.addEventListener('dblclick', () => setVolume(0.8));
knob.addEventListener('keydown', e => {
  const d = { ArrowUp: .02, ArrowRight: .02, ArrowDown: -.02, ArrowLeft: -.02, PageUp: .1, PageDown: -.1 }[e.key];
  if (d != null) { e.preventDefault(); setVolume(set.volume + d); } else if (e.key === 'Home') setVolume(0); else if (e.key === 'End') setVolume(1);
});
document.addEventListener('cadence:volume', () => paintKnob());
document.addEventListener('cadence:volume-ui', () => paintKnob());

// ---------- phosphor rings (Now Playing) ----------
const M = 180, polar = new Float32Array(M + 1);
let lastIn = 0; for (const ev of ['pointermove', 'keydown', 'wheel', 'pointerdown']) addEventListener(ev, () => { lastIn = performance.now(); }, { passive: true });
let an, anL, anR, buf, bl, br, tapped = false, raf = 0, lastT = 0, drawIn = 1, drawAt = 0, agc = .25, amp = 0, geo = null;
function tap() {
  if (tapped || !engine?.ctx || !engine.tap) return !!an;
  tapped = true;
  const sp = engine.ctx.createChannelSplitter(2);
  an = engine.ctx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0;
  anL = engine.ctx.createAnalyser(); anR = engine.ctx.createAnalyser(); anL.fftSize = anR.fftSize = 1024;
  engine.tap.connect(an); engine.tap.connect(sp); sp.connect(anL, 0); sp.connect(anR, 1);
  buf = new Float32Array(2048); bl = new Float32Array(1024); br = new Float32Array(1024);
  return true;
}
const live = () => !!(engine?.playing && !document.hidden && set.liveVisuals !== false && !motionOff() && $('.fc-rings'));
function fold(b) { // rising zero crossing keeps the figure stable; mirror-symmetric so it closes like a cymatic figure
  let s0 = 1; for (let i = 1; i < 512; i++) if (b[i - 1] < 0 && b[i] >= 0) { s0 = i; break; }
  const span = Math.min(1500, b.length - s0), step = span / (M / 2); let pk = 0;
  for (let k = 0; k <= M / 2; k++) {
    const i0 = s0 + Math.floor(k * step); let a = 0; const n = Math.max(1, Math.floor(step));
    for (let j = 0; j < n; j++) a += b[Math.min(b.length - 1, i0 + j)];
    const v = a / n; polar[k] = v; polar[M - k] = v; pk = Math.max(pk, Math.abs(v));
  }
  agc = Math.max(agc * .996, pk, .02); polar[M] = polar[0]; return agc;
}
function foldWave() { // paused: the same figure folded from the track's waveform peaks (or a calm figure)
  const w = P.wave;
  for (let k = 0; k <= M / 2; k++) {
    const v = w?.length ? ((w[Math.floor(k / (M / 2) * (w.length - 1))] || 0) - .42) * (k % 2 ? 1 : .8) : Math.sin(k / (M / 2) * Math.PI * 2 * 2.5) * .14;
    polar[k] = v; polar[M - k] = v;
  }
  polar[M] = polar[0];
}
const fit = c => { const d = Math.min(2, devicePixelRatio || 1), w = Math.round(c.clientWidth * d), h = Math.round(c.clientHeight * d); if (!w || !h) return null; if (c.width !== w || c.height !== h) { c.width = w; c.height = h; geo = null; } return { w, h, d }; };
function paintRings(stat) {
  const c = $('.fc-rings'); if (!c) return;
  const sz = fit(c); if (!sz) return;
  const { w, h, d } = sz, g = c.getContext('2d'), cols = window.fcRings || [HOUSE, [150, 120, 255], [80, 200, 220]];
  if (!geo) {
    const a = c.parentElement.querySelector('.npv-art')?.getBoundingClientRect(), cr = c.getBoundingClientRect(), s = w / cr.width;
    geo = a && a.width ? { cx: (a.left + a.width / 2 - cr.left) * s, cy: (a.top + a.height / 2 - cr.top) * s, R: a.width / 2 * s } : { cx: w * .3, cy: h * .45, R: Math.min(w, h) * .15 };
  }
  const { cx, cy, R } = geo;
  g.globalCompositeOperation = 'destination-out'; g.fillStyle = `rgba(0,0,0,${stat ? 1 : .2})`; g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'lighter';
  let gain = .5;
  if (stat) foldWave(); else gain = .34 / fold(buf);
  // R = half the cover width. Rings start just outside the cover edge (behind its corners) and step outward; they shrink to fit the room.
  const room = Math.min(cx, w - cx, cy, h - cy) - 6 * d, fitK = Math.max(.92, Math.min(1, room / (R * 1.72))), di = drawIn;
  const k = R * (.12 + amp * .16) * fitK;
  const ring = (rad, ka, col, lw, rot, alpha) => {
    const n = Math.max(2, Math.round(M * di)); g.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = i / M * Math.PI * 2 + rot - Math.PI / 2, r = (rad + polar[i % (M + 1)] * gain * ka) * (.86 + .14 * di), px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
      i ? g.lineTo(px, py) : g.moveTo(px, py);
    }
    if (di >= 1) g.closePath();
    g.strokeStyle = `rgba(${col.join(',')},${alpha * Math.min(1, di * 1.6)})`; g.lineWidth = lw * 1.25 * d; g.shadowColor = `rgba(${col.join(',')},1)`; g.shadowBlur = 12 * d; g.lineJoin = 'round'; g.stroke();
  };
  const r0 = R * 1.17 * fitK;
  ring(r0, k, cols[0], 1.8, 0, .95); ring(r0 + R * .15 * fitK, k * .8, cols[1], 1.3, Math.PI / M * 3, .7); ring(r0 + R * .3 * fitK, k * .6, cols[2], 1.1, Math.PI / M * 6, .55);
  g.shadowBlur = 0; g.globalCompositeOperation = 'source-over';
  paintScope(stat);
}
function paintScope(stat) {
  const c = $('.fc-lr'); if (!c) return;
  const sz = fit(c); if (!sz) return;
  const { w, h, d } = sz, g = c.getContext('2d'), col = (window.fcRings || [HOUSE])[0];
  g.clearRect(0, 0, w, h);
  g.strokeStyle = 'rgba(128,128,128,.28)'; g.lineWidth = d; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke();
  g.beginPath(); g.strokeStyle = `rgba(${col.join(',')},.85)`; g.lineWidth = 1.2 * d; g.shadowColor = `rgba(${col.join(',')},1)`; g.shadowBlur = 7 * d;
  if (!stat && anL) { const sc = w * .3 / Math.max(.15, agc); for (let i = 0; i < 1024; i += 2) { const px = w / 2 + (bl[i] - br[i]) * sc * .7, py = h / 2 - (bl[i] + br[i]) * sc * .7; i ? g.lineTo(px, py) : g.moveTo(px, py); } }
  else for (let i = 0; i <= 90; i++) { const t = i / 90 * Math.PI * 2; g.lineTo(w / 2 + Math.sin(t * 2) * w * .17, h / 2 - Math.sin(t * 3 + .6) * h * .17); }
  g.stroke(); g.shadowBlur = 0;
}
function tick(t) {
  raf = 0;
  if (!live()) { amp = 0; fcDraw(); return; }
  raf = requestAnimationFrame(tick);
  if (t - lastT < (t - lastIn > 8000 ? 48 : 24)) return; lastT = t; // 40 fps; 20 fps once the user has been idle 8 s
  if (demo) synth(t);
  else if (tap()) {
    an.getFloatTimeDomainData(buf); anL.getFloatTimeDomainData(bl); anR.getFloatTimeDomainData(br);
  }
  if (buf) { let s = 0; for (let i = 0; i < buf.length; i += 4) s += buf[i] * buf[i]; const l = Math.min(1, Math.sqrt(s / (buf.length / 4)) * 2.6); amp += (Math.max(l, .08) - amp) * (l > amp ? .5 : .12); }
  if (drawIn < 1) { drawIn = Math.min(1, (t - drawAt) / 1100); drawIn = 1 - (1 - drawIn) ** 3; }
  paintRings(false);
}
// test harness only: a hidden window never fires rAF and the harness is muted, so screenshots drive tick() with a synthetic stereo signal
let demo = false, stepT = 0;
function synth(t) { if (!buf) { buf = new Float32Array(2048); bl = new Float32Array(1024); br = new Float32Array(1024); } const p = t / 1000; for (let i = 0; i < 2048; i++) buf[i] = .5 * Math.sin(i / 2048 * 6.28 * 3 + p * 4) * Math.sin(i / 2048 * 6.28 * 7 + p) + .25 * Math.sin(i / 2048 * 6.28 * 11 - p * 2); for (let i = 0; i < 1024; i++) { bl[i] = .5 * Math.sin(i / 1024 * 6.28 * 5 + p * 3); br[i] = .5 * Math.sin(i / 1024 * 6.28 * 7 + p * 2 + 1); } }
const kick = () => { if (!raf && live()) { lastT = 0; raf = requestAnimationFrame(tick); } };
function fcDraw() { if (!raf) { drawIn = 1; paintRings(true); } }
// the rings canvas is injected whenever Now Playing renders
function mountRings() {
  const npv = $('.npv', main);
  if (!npv || $('.fc-rings', npv)) return;
  npv.prepend(el('canvas', 'fc-rings'));
  npv.append(el('div', 'fc-lrwell', el('canvas', 'fc-lr'), el('span', 'fc-lbl', 'L/R')));
  geo = null;
  requestAnimationFrame(() => { fcDraw(); kick(); });
}
new MutationObserver(mountRings).observe(main, { childList: true });
new ResizeObserver(() => { geo = null; if (!raf) fcDraw(); }).observe(main);
document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
document.addEventListener('fc:live', () => { if (!live()) fcDraw(); kick(); });
window.fcDraw = fcDraw;


// ---------- engraved kicker: "CH 04 / LIBRARY" above every page title (the channel you are on) ----------
const kick2 = () => main.querySelectorAll('.view-title:not([data-k])').forEach(t => {
  t.dataset.k = 1; if (t.querySelector('.kicker')) return;
  const items = [...document.querySelectorAll('#sidebar .side-item')], it = document.querySelector('#sidebar .side-item.active');
  let sec = 'Cadence'; for (let n = it; n; n = n.previousElementSibling) if (n.classList.contains('side-h')) { sec = n.textContent.trim() || sec; break; }
  if (it?.querySelector('.lbl')?.textContent.trim() === 'Settings') sec = 'System';
  const here = it && it.querySelector('.lbl')?.textContent.trim() === t.querySelector('h1')?.textContent.trim(); // Settings / detail pages are not channels
  const e = el('div', 'kicker'); e.textContent = here ? `CH ${String(items.indexOf(it) + 1).padStart(2, '0')} / ${sec}` : 'Cadence'; t.prepend(e);
});
new MutationObserver(kick2).observe(main, { childList: true, subtree: true });

// ---------- play state: key travel, lamp, ring draw-in ----------
let wasPlaying = false;
function sync() {
  const pl = !!engine?.playing;
  body.classList.toggle('fc-on', pl);
  if (pl && !wasPlaying) { drawIn = motionOff() ? 1 : 0; drawAt = performance.now(); }
  if (pl !== wasPlaying && !motionOff()) { body.classList.remove('fc-hit'); void body.offsetWidth; body.classList.add('fc-hit'); setTimeout(() => body.classList.remove('fc-hit'), 850); }
  wasPlaying = pl; tap(); kick(); if (!pl) fcDraw();
}
// ---------- power-on warm-up (1.2 s) ----------
function warmUp() {
  if (motionOff()) return;
  body.classList.add('fc-warm');
  setTimeout(() => body.classList.remove('fc-warm'), Math.round(1250 * (body.classList.contains('anim-fast') ? .6 : 1)));
}
function boot() {
  const pl = $('#player');
  if (!engine || !pl || !$('.np-vol', pl) || !P.vol) return requestAnimationFrame(boot);
  const vol = $('.np-vol', pl);
  vol.insertBefore(knobWrap, P.vol); vol.classList.add('fc-vol');
  paintKnob(); warmUp();
  for (const ev of ['state', 'track']) engine.addEventListener(ev, sync);
  sync();
}
window.fusion = { rms: () => { if (!an) return -1; const b = new Float32Array(1024); an.getFloatTimeDomainData(b); let q = 0; for (const v of b) q += v * v; return Math.sqrt(q / b.length); }, seek: () => { P.seekKey = null; drawSeek(P.lastFrac ?? 0); }, wave: () => P.wave?.length || 0, demo: v => { demo = v; }, rewind: () => { drawIn = 0; drawAt = 0; stepT = 0; }, step: (n = 1, ms = 16) => { for (let i = 0; i < n; i++) { raf = 0; stepT += ms; tick(stepT); } }, warmUp, knob: v => { kv = -1; paintKnob(v); }, kick, live };
// mini player: mirror the elapsed time into a dot-matrix LCD (updates only when the main time chip text changes)
function mountMini() {
  const mm = $('#mini .mini-main'), tc = $('.times .chip:not(.ctx)'); if (!mm || !tc) return requestAnimationFrame(mountMini);
  const lcd = el('div', 'fc-mt'); lcd.textContent = tc.textContent; mm.insertBefore(lcd, $('.mini-seek', mm));
  new MutationObserver(() => { lcd.textContent = tc.textContent; }).observe(tc, { childList: true, characterData: true, subtree: true });
}
mountMini();
boot();

// quantised dot-matrix seek strip (player.js calls P.seekPainter when a design sets it). Columns are 5px, peaks snap to whole dot rows, played dots are the lamp.
function drawDots(g, W, H, dpr, peaks, x, k) {
  const light = false, lamp = (getComputedStyle(document.documentElement).getPropertyValue('--lcd') || '255 160 60').trim().split(/\s+/).join(',');
  const pitch = 5 * dpr, rows = Math.max(3, Math.floor(H / pitch) | 1), cols = Math.floor(W / pitch), r = 1.15 * dpr, mid = (rows - 1) / 2;
  const ghost = light ? 'rgba(0,0,0,0.09)' : 'rgba(255,255,255,0.075)', off = light ? 'rgba(0,0,0,0.42)' : 'rgba(255,255,255,0.36)';
  const pc = Math.floor(x / pitch);
  for (let c = 0; c < cols; c++) {
    const p = peaks?.length ? (peaks[Math.floor(c / cols * peaks.length)] || 0) * k : 0;
    const lit = Math.max(1, Math.round(Math.pow(p, 1.7) * (mid + 1))); // dots lit above and below the centre line (power curve spreads loud masters)
    const px = c * pitch + pitch / 2;
    for (let j = 0; j < rows; j++) {
      const on = Math.abs(j - mid) < lit && (peaks?.length || j === mid);
      g.fillStyle = c === pc ? `rgba(${lamp},1)` : on ? (c < pc ? `rgba(${lamp},0.92)` : off) : ghost;
      g.beginPath(); g.arc(px, H / 2 + (j - mid) * pitch, c === pc ? r * 1.25 : r, 0, 6.2832); g.fill();
    }
  }
}
P.seekPainter = drawDots;
