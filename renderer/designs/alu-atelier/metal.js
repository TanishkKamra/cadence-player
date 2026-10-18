// Alu Atelier: material layer. Everything here is on demand (pointer move, track change, state change); nothing loops while idle.
import { artUrl } from '../../util.js';

const root = document.documentElement;
const calm = () => document.body.classList.contains('anim-off') || matchMedia('(prefers-reduced-motion: reduce)').matches;
const css = (k, v) => root.style.setProperty(k, v);

/* ---------- baked textures: bead-blast grain + brushed streaks (canvas once, no live filters) ---------- */
function noiseTile(w, h, sx, sy, alpha, seed) {
  const s = document.createElement('canvas'); s.width = Math.max(1, Math.round(w / sx)); s.height = Math.max(1, Math.round(h / sy));
  const g = s.getContext('2d'), im = g.createImageData(s.width, s.height);
  let r = seed; const rnd = () => (r = (r * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < im.data.length; i += 4) { const v = rnd() < .5 ? 0 : 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = rnd() * alpha; }
  g.putImageData(im, 0, 0);
  const o = document.createElement('canvas'); o.width = w; o.height = h;
  const c = o.getContext('2d'); c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; c.drawImage(s, 0, 0, w, h);
  return o;
}
function bakeTextures() {
  const a = noiseTile(192, 192, 1, 1, 5, 7), b = noiseTile(192, 192, 2.4, 2.4, 6, 99);
  const g = document.createElement('canvas'); g.width = g.height = 192; const c = g.getContext('2d'); c.drawImage(a, 0, 0); c.drawImage(b, 0, 0);
  const br = noiseTile(256, 128, 60, 1, 34, 31); // long horizontal streaks
  css('--grain', `url(${g.toDataURL('image/png')})`);
  css('--brush', `url(${br.toDataURL('image/png')})`);
  const bs = document.createElement('canvas'); bs.width = 192; bs.height = 192; // brushed-plate tile: long streaks, very low alpha
  const bg = bs.getContext('2d'); bg.drawImage(noiseTile(192, 192, 140, 1, 12, 5), 0, 0);
  css('--plate-brush', `url(${bs.toDataURL('image/png')})`);
}

/* ---------- one key light (pointer nudges it; rAF only until it settles) ---------- */
let tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
function setLight(x, y) { css('--lx', x.toFixed(3)); css('--ly', y.toFixed(3)); css('--la', (-34 + x * 30 + y * 8).toFixed(2)); }
function tick() {
  raf = 0;
  cx += (tx - cx) * .2; cy += (ty - cy) * .2;
  const done = Math.abs(tx - cx) < .003 && Math.abs(ty - cy) < .003;
  if (done) { cx = tx; cy = ty; }
  setLight(cx, cy);
  if (!done) raf = requestAnimationFrame(tick);
}
function initLight() {
  setLight(0, 0);
  addEventListener('pointermove', e => {
    if (calm()) return;
    tx = e.clientX / innerWidth * 2 - 1; ty = e.clientY / innerHeight * 2 - 1;
    if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: true });
}

/* ---------- song -> dye / LED (anodising), colours glide via @property ---------- */
const lum = ([r, g, b]) => { const f = v => (v /= 255) <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
function rgb2hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0;
  if (d) { s = d / (1 - Math.abs(2 * l - 1)); h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360; }
  return [h, s, l];
}
const hsl = (h, s, l) => `hsl(${h.toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%)`;
function toRGB(h, s, l) { const a = s * Math.min(l, 1 - l), f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); }; return [f(0), f(8), f(4)].map(v => Math.round(v * 255)); }
let lastAcc = '', lastTheme = '';
function dye() {
  const th = document.body.dataset.theme;
  const acc = root.style.getPropertyValue('--accent').trim() || getComputedStyle(root).getPropertyValue('--accent').trim();
  if (acc === lastAcc && th === lastTheme) return; // the observer also fires for --lx/--ly writes: bail cheaply
  lastAcc = acc; lastTheme = th;
  const raw = acc.split(/\s+/).map(Number);
  if (raw.length !== 3 || raw.some(isNaN)) return;
  const [h, s0] = rgb2hsl(raw), light = th === 'light';
  const s = Math.min(.82, Math.max(.38, s0)), l = light ? .5 : .56;
  css('--dye', hsl(h, s, l)); css('--dye-hi', hsl(h, s, Math.min(.86, l + .2))); css('--dye-lo', hsl(h, Math.min(1, s + .08), l - .22));
  css('--led', hsl(h, Math.min(1, s + .12), .8));
  css('--dye-rgb', toRGB(h, s, l).join(' ')); css('--led-rgb', toRGB(h, Math.min(1, s + .12), .8).join(' '));
  const d = toRGB(h, s, l); // legend on dye: whichever of white / ink contrasts more
  css('--on-dye', (1.05 / (lum(d) + .05)) >= ((lum(d) + .05) / (lum([12, 14, 17]) + .05)) ? '#fff' : '#0c0e11');
}

/* ---------- env: the cover becomes a blurred studio reflection for every chrome part ---------- */
function paintEnv(img) {
  const N = 160, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d');
  g.fillStyle = '#7d848e'; g.fillRect(0, 0, N, N);
  if (img) { g.filter = 'blur(9px) saturate(1.25)'; g.drawImage(img, -N * .2, -N * .2, N * 1.4, N * 1.4); g.filter = 'none'; }
  const v = (stops, w) => { const q = g.createLinearGradient(0, 0, 0, N); stops.forEach(([o, col]) => q.addColorStop(o, col)); g.fillStyle = q; g.fillRect(0, 0, N, N); };
  // sky softbox, razor horizon, dim ground with a bounce light
  v([[0, 'rgba(255,255,255,.80)'], [.14, 'rgba(255,255,255,.62)'], [.34, 'rgba(235,240,248,.22)'], [.47, 'rgba(10,12,16,.30)'], [.5, 'rgba(6,8,10,.72)'], [.54, 'rgba(8,10,12,.52)'], [.78, 'rgba(10,12,16,.30)'], [1, 'rgba(230,235,245,.40)']]);
  const s = g.createLinearGradient(0, 0, N, 0); // vertical strip light
  s.addColorStop(0, 'rgba(255,255,255,0)'); s.addColorStop(.2, 'rgba(255,255,255,.0)'); s.addColorStop(.26, 'rgba(255,255,255,.55)'); s.addColorStop(.33, 'rgba(255,255,255,0)'); s.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = s; g.fillRect(0, 0, N, N * .48);
  return c;
}
let envCur = null, envRaf = 0;
/* cross-fade old -> new studio reflection over 650 ms (finite rAF, only on track change) */
function envFrom(img) {
  const next = paintEnv(img);
  cancelAnimationFrame(envRaf);
  const put = c => css('--env', `url(${c.toDataURL('image/jpeg', .88)})`);
  if (!envCur || calm()) { envCur = next; put(next); return; }
  const from = envCur, mix = document.createElement('canvas'); mix.width = mix.height = from.width; const g = mix.getContext('2d');
  const k = document.body.classList.contains('anim-fast') ? 330 : 650, t0 = performance.now();
  const step = now => {
    const t = Math.min(1, (now - t0) / k), e = t * t * (3 - 2 * t);
    g.globalAlpha = 1; g.drawImage(from, 0, 0); g.globalAlpha = e; g.drawImage(next, 0, 0);
    put(mix);
    if (t < 1) envRaf = requestAnimationFrame(step); else envCur = next;
  };
  envRaf = requestAnimationFrame(step);
}
function loadEnv(art) {
  if (!art) return envFrom(null);
  const im = new Image(); im.crossOrigin = 'anonymous';
  im.onload = () => envFrom(im); im.onerror = () => envFrom(null);
  im.src = artUrl(art);
}

/* ---------- light sweep: one finite diagonal specular glide across a plate (compositor transform) ---------- */
function sweep(sel, ms = 600) {
  if (calm()) return;
  const host = document.querySelector(sel); if (!host) return;
  const r = host.getBoundingClientRect(); if (!r.width) return;
  let el = host.querySelector(':scope > .m-sweep');
  if (!el) { el = document.createElement('i'); el.className = 'm-sweep'; el.setAttribute('aria-hidden', 'true'); host.append(el); }
  const k = document.body.classList.contains('anim-fast') ? .6 : 1;
  el.animate([{ transform: 'translateX(-130%) skewX(-20deg)', opacity: 0 }, { opacity: 1, offset: .25 }, { opacity: 1, offset: .65 }, { transform: 'translateX(230%) skewX(-20deg)', opacity: 0 }], { duration: ms * k, easing: 'cubic-bezier(.45,.05,.3,1)' });
}

/* ---------- detent flick on range inputs ---------- */
function initDetents() {
  addEventListener('input', e => {
    const t = e.target; if (!(t instanceof HTMLInputElement) || t.type !== 'range') return;
    const d = Math.round((t.value - t.min) / ((t.max - t.min) || 1) * 20);
    if (t._d === d) return; t._d = d;
    t.classList.add('flick'); clearTimeout(t._f); t._f = setTimeout(() => t.classList.remove('flick'), 110);
  }, true);
}

export function initMetal(cad) {
  if (cad) cad.metal = { sweep, dye };
  bakeTextures(); initLight(); initDetents();
  const re = () => { dye(); };
  new MutationObserver(re).observe(root, { attributes: true, attributeFilter: ['style'] });
  new MutationObserver(re).observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
  re(); envFrom(null);
  const eng = cad?.engine;
  if (eng) {
    eng.addEventListener('track', e => { loadEnv(e.detail?.entry?.track?.art); sweep('#player', 520); });
    let was = null;
    eng.addEventListener('state', () => { if (was !== null && was !== eng.playing) sweep('#player', 600); was = eng.playing; });
    if (eng.track?.art) loadEnv(eng.track.art);
  }
}
