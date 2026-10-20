// Two-Ink Proof (fusion-b). Song -> three flat print inks + a tinted stock, the Pour (ink slabs), registration settle, press thump, masthead furniture.
// Nothing here loops: every function fires on a cover load, a theme change, a play/pause flip or a DOM insertion.
// Colour-picking and the halftone raster descend from the Riso Print form (same author); the hue bins and dateline from Editorial Kinetic.
import { SPRING, motionOff } from '../../motion.js';

const root = document.documentElement;
const FALLBACK = [212, 330, 52]; // riso blue, fluorescent pink, yellow when the cover is grey or absent
const theme = () => document.body?.dataset.theme || 'dark';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- colour maths ----------
function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0;
  if (d) { s = d / (1 - Math.abs(2 * l - 1)); h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360; }
  return [h, s, l];
}
function fromHsl(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map(v => Math.round((v + m) * 255));
}
const lin = v => (v /= 255) <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
const lum = c => .2126 * lin(c[0]) + .7152 * lin(c[1]) + .0722 * lin(c[2]);
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const ON = [11, 10, 13]; // the one on-ink colour: near-black text on every ink fill
const hex = c => c.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
const trip = c => c.join(' ');

// up to three hues (24-bucket histogram, vivid mid-lights weigh most, picks >= 3 buckets apart)
function pickHues(img) {
  const N = 40, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, N, N);
  const d = g.getImageData(0, 0, N, N).data, B = 24, bins = new Array(B).fill(0);
  let total = 0;
  for (let i = 0; i < d.length; i += 4) {
    const [h, s, l] = toHsl([d[i], d[i + 1], d[i + 2]]);
    const w = s * Math.min(l, 1 - l) * 2;
    if (w < .05) continue;
    bins[Math.floor(h / 360 * B) % B] += w; total += w;
  }
  if (total < 8) return null;
  const sm = bins.map((_, i) => bins[i] + .5 * (bins[(i + 1) % B] + bins[(i + B - 1) % B]));
  const picks = [];
  for (let n = 0; n < 3; n++) {
    let bi = -1, best = 0;
    for (let i = 0; i < B; i++) {
      if (picks.some(p => Math.min((i - p + B) % B, (p - i + B) % B) < 3)) continue;
      if (sm[i] > best) { best = sm[i]; bi = i; }
    }
    if (bi < 0 || (n > 0 && best < sm[picks[0]] * (n === 1 ? .14 : .08))) break;
    picks.push(bi);
  }
  const H = i => (i + .5) / B * 360, hs = picks.map(H);
  if (hs.length < 2) hs.push(hs[0] + 150);
  if (hs.length < 3) hs.push(hs[0] + 75 + (hs[1] - hs[0] > 0 ? 160 : 0));
  return hs;
}

// ---------- palette ----------
function litInk(h, dk) { // flat fluorescent ink bright enough that near-black text reaches 7:1 on it
  let l = dk ? .6 : .56, c = fromHsl(h, .95, l);
  for (let n = 0; n < 40 && contrast(c, ON) < 7.2; n++) { l += .012; c = fromHsl(h, .95, l); }
  return c;
}
function textInk(c, sheet, dk) { // same hue pushed until >= 4.6:1 on the sheet
  const [h, s] = toHsl(c);
  let l = toHsl(c)[2], o = c;
  for (let n = 0; n < 60 && contrast(o, sheet) < 4.6; n++) { l += dk ? .012 : -.012; o = fromHsl(h, s, clamp(l, .04, .97)); }
  return o;
}
function palette(hues) {
  const th = theme(), dk = th !== 'light';
  const hs = hues || FALLBACK, h0 = hs[0];
  const stock = th === 'black' ? [0, 0, 0] : dk ? fromHsl(h0, .34, .05) : fromHsl(h0, .26, .925);
  const sheet = th === 'black' ? [0, 0, 0] : dk ? fromHsl(h0, .3, .092) : fromHsl(h0, .3, .965);
  const hi = th === 'black' ? [14, 14, 14] : dk ? fromHsl(h0, .26, .145) : [255, 253, 247];
  const i1 = litInk(hs[0], dk), i2 = litInk(hs[1], dk), i3 = litInk(hs[2], dk);
  const t1 = textInk(i1, sheet, dk), t2 = textInk(i2, sheet, dk);
  const inkRgb = dk ? [244, 239, 226] : [24, 22, 28];
  // two-ink waveform: played = text-safe ink-a, unplayed = ink-b mixed 60% toward the sheet (still >= 3:1 on it)
  let rest = mix(t2, sheet, .35);
  for (let n = 0; n < 20 && contrast(rest, sheet) < 3.2; n++) rest = mix(rest, t2, .15);
  return { stock, sheet, hi, i1, i2, i3, t1, t2, inkRgb, rest };
}
const css = c => `rgb(${c.join(" ")})`;
function setInks(p) {
  const s = root.style;
  s.setProperty('--i1', trip(p.i1)); s.setProperty('--i2', trip(p.i2)); s.setProperty('--i3', trip(p.i3));
  s.setProperty('--i1t', trip(p.t1)); s.setProperty('--i2t', trip(p.t2));
  s.setProperty('--accent', trip(p.t1)); // legacy consumers (switches, EQ fills) read the text-safe ink
  s.setProperty('--seek-played', trip(p.t1)); s.setProperty('--seek-rest', trip(p.rest));
  s.setProperty('--ink-rgb', trip(p.inkRgb));
  document.querySelectorAll('.fb-swatch i').forEach((el, k) => { const c = [p.i1, p.i2, p.i3, p.stock][k]; if (!c) return; el.style.background = css(c); el.dataset.hex = hex(c); el.dataset.nm = ['Ink A', 'Ink B', 'Ink C', 'Stock'][k]; });
}
function setStock(p, instant) {
  const s = root.style;
  if (instant) root.classList.add('fb-nt');
  s.setProperty('--stock', css(p.stock)); s.setProperty('--sheet', css(p.sheet)); s.setProperty('--hi', css(p.hi));
  if (instant) setTimeout(() => root.classList.remove('fb-nt'), 60);
}

// ---------- halftone plates (hero cover only) ----------
function halftone(px, W, ang, cell, cover, rgb) {
  const S = 480, c = new OffscreenCanvas(S, S), g = c.getContext('2d');
  g.fillStyle = `rgb(${rgb.join(',')})`;
  const ca = Math.cos(ang), sa = Math.sin(ang), R = S * .75;
  g.beginPath();
  for (let u = -R; u < R; u += cell) for (let w = -R; w < R; w += cell) {
    const x = S / 2 + u * ca - w * sa, y = S / 2 + u * sa + w * ca;
    if (x < -cell || y < -cell || x > S + cell || y > S + cell) continue;
    const ix = Math.min(W - 1, Math.max(0, Math.floor(x / S * W))), iy = Math.min(W - 1, Math.max(0, Math.floor(y / S * W)));
    const a = cover(px[(iy * W + ix) * 4], px[(iy * W + ix) * 4 + 1], px[(iy * W + ix) * 4 + 2]);
    if (a < .04) continue;
    const r = cell * .5 * Math.sqrt(Math.min(1.25, a) * 1.27);
    g.moveTo(x + r, y); g.arc(x, y, r, 0, 6.2832);
  }
  g.fill();
  return c.convertToBlob({ type: 'image/png' }).then(b => URL.createObjectURL(b));
}
const idle = () => new Promise(r => requestIdleCallback(r, { timeout: 400 }));
async function plates(img, p, hues) {
  const W = 120, c = document.createElement('canvas');
  c.width = c.height = W;
  const g = c.getContext('2d', { willReadFrequently: true });
  const iw = img.naturalWidth || W, ih = img.naturalHeight || W, m = Math.min(iw, ih);
  g.drawImage(img, (iw - m) / 2, (ih - m) / 2, m, m, 0, 0, W, W);
  const px = g.getImageData(0, 0, W, W).data, [h1, h2] = hues || FALLBACK;
  const hd = (h, t) => Math.abs(((h - t + 540) % 360) - 180);
  const sim = (r, gg, b, t) => { const [h, s] = toHsl([r, gg, b]); return s < .12 ? .5 : Math.max(0, 1 - hd(h, t) / 110); };
  const dark = (r, g2, b) => 1 - (.2126 * r + .7152 * g2 + .0722 * b) / 255;
  await idle();
  const A = await halftone(px, W, .26, 9, (r, g2, b) => Math.pow(dark(r, g2, b), .8) * (.62 + .5 * sim(r, g2, b, h1)) * 1.15, p.i1);
  await idle();
  const B = await halftone(px, W, 1.31, 9, (r, g2, b) => Math.pow(dark(r, g2, b) * 1.05, 1.15) * (.55 + .6 * sim(r, g2, b, h2)) * 1.2 + .06, p.i2);
  return [A, B];
}

// ---------- the Pour ----------
let pourEls = null, pourAnims = [], cur = null, token = 0;
const cache = new Map();
function slabs() {
  if (pourEls?.[0].isConnected) return pourEls;
  const bg = document.getElementById('bg');
  const wrap = document.createElement('div');
  wrap.className = 'fb-pour'; wrap.setAttribute('aria-hidden', 'true');
  pourEls = [0, 1, 2].map(() => wrap.appendChild(document.createElement('i')));
  bg.append(wrap);
  return pourEls;
}
function endPour(p) {
  pourAnims.forEach(a => { try { a.cancel(); } catch {} });
  pourAnims = [];
  if (pourEls) pourEls[0].parentNode.classList.remove('on');
  if (p) setStock(p, true);
}
let pendingStock = null;
function pour(p) {
  if (pendingStock) endPour(pendingStock); // rapid skip: land the previous sheet, start the next from there
  const [a, b, c] = slabs();
  a.style.background = css(p.i1); b.style.background = css(p.i2); c.style.background = css(p.stock);
  a.parentNode.classList.add('on');
  const k = document.body.classList.contains('anim-fast') ? .6 : 1, e = SPRING.smooth.easing;
  pendingStock = p;
  pourAnims = [a, b, c].map((el, i) => el.animate([{ transform: 'translateX(-101%)' }, { transform: 'translateX(0)' }],
    { duration: 920 * k, delay: i * 95 * k, easing: 'cubic-bezier(.19,1,.22,1)', fill: 'both' }));
  setTimeout(() => setStock(p, false), 380 * k); // sheets and keys re-tint under the sweep
  pourAnims[2].finished.then(() => { if (pendingStock === p) { pendingStock = null; endPour(p); } }).catch(() => {});
}

// registration settle: every --rx/--ry reader (hard shadows, title under-print, cover plates) springs from misregistered
export function print(force) {
  if (window.fb?.hold && !force) return;
  if (motionOff()) return;
  root.style.setProperty('--settle-k', document.body.classList.contains('anim-fast') ? .45 : 1);
  root.classList.remove('printing');
  void root.offsetWidth;
  root.classList.add('printing');
  clearTimeout(print.tm);
  print.tm = setTimeout(() => { if (!window.fb?.freeze) root.classList.remove('printing'); }, 1500);
}

// plates live in a style rule, not an inherited custom property (a root write would re-substitute the blob URL on every element)
let htEl = null;
function htStyle(u) {
  htEl ||= document.head.appendChild(document.createElement('style'));
  htEl.textContent = u ? `body.fb.has-ht :is(.np-art,.fb-art)::before{background-image:url("${u[0]}")}body.fb.has-ht :is(.np-art,.fb-art)::after{background-image:url("${u[1]}")}` : '';
}
async function onArt(img, force) {
  const my = ++token;
  let hues = null, key = null;
  if (img) {
    key = img.currentSrc || img.src;
    if (cache.has(key)) hues = cache.get(key).hues;
    else { try { hues = pickHues(img); } catch {} cache.set(key, { hues, urls: null, th: null }); if (cache.size > 30) { const f = cache.keys().next().value; (cache.get(f).urls || []).forEach(u => URL.revokeObjectURL(u)); cache.delete(f); } }
  }
  const p = palette(hues), first = !cur, same = cur && cur.key === key && !force;
  cur = { key, hues, img, p };
  setInks(p);
  document.body.classList.toggle('has-ht', !!img);
  if (same) return;
  if (first || motionOff()) { endPour(null); pendingStock = null; setStock(p, true); }
  else { pour(p); print(); }
  if (!img) { htStyle(); return; }
  const e = cache.get(key);
  if (!e.urls || e.th !== theme()) { await new Promise(r => setTimeout(() => requestIdleCallback(r, { timeout: 600 }), first || motionOff() ? 0 : 1000)); if (my !== token) return; try { e.urls = await plates(img, p, hues); e.th = theme(); } catch { return; } }
  if (my !== token) return;
  htStyle(e.urls);
}
window.addEventListener('cadence:art', e => onArt(e.detail.img));
new MutationObserver(() => { if (cur) onArt(cur.img, true); }).observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
onArt(null);
// the hidden screenshot window cannot judge motion: expose a hook for the harness
window.fb = { calmMs: 7000, print: () => print(true), hold: false, freeze: false, palette, contrast, pickHues, onArt };
// ---------- calm: idle 7s -> html.calm dims the loud slabs to tints; any input restores them (one timeout, no loop) ----------
let calmT = 0, lastWake = 0;
const calm = on => root.classList.toggle("calm", on);
function wake() {
  const n = performance.now();
  if (!root.classList.contains("calm") && n - lastWake < 400) return;
  lastWake = n; calm(false); clearTimeout(calmT);
  calmT = setTimeout(() => calm(true), window.fb?.calmMs ?? 7000);
}
["pointermove", "pointerdown", "keydown", "wheel"].forEach(t => addEventListener(t, wake, { passive: true, capture: true }));
wake();
window.fb.calm = calm;

// ---------- press thump: play/pause flips (mouse, Space, media keys) press the big key ----------
let wasPaused = null;
new MutationObserver(() => {
  const p = document.body.classList.contains('paused');
  if (wasPaused === null) { wasPaused = p; return; }
  if (p === wasPaused) return;
  wasPaused = p;
  const k = document.querySelector('#player .t-btn.l');
  if (!k || motionOff() || document.activeElement === k) return;
  k.animate([{ transform: 'none' }, { transform: 'translate(3px,3px)', offset: .22 }, { transform: 'none' }], { duration: 360, easing: SPRING.snappy.easing });
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ---------- masthead dateline on page headers ----------
function dress(h1) {
  const n = h1.textContent.length;
  h1.dataset.len = n > 34 ? 'xl' : n > 20 ? 'l' : n > 11 ? 'm' : 's';
  const head = h1.closest('.view-head');
  if (!head || head.querySelector('.fb-folio')) return;
  const items = [...document.querySelectorAll('#sidebar .side-item')], i = items.findIndex(x => x.classList.contains('active'));
  const f = document.createElement('div');
  f.className = 'fb-folio'; f.setAttribute('aria-hidden', 'true');
  f.innerHTML = `<b>No. ${i < 0 ? '--' : String(i + 1).padStart(2, '0')}</b><span>${new Date().toLocaleDateString('en', { weekday: 'long', day: 'numeric', month: 'long' })}</span><span class="r">Cadence / proof sheet</span>`;
  head.prepend(f);
}
const main = document.getElementById('main');
new MutationObserver(() => {
  document.querySelectorAll('.view-head h1:not([data-len])').forEach(dress);
  const sw = document.querySelector('.fb-swatch i:not([data-hex])');
  if (sw && cur) setInks(cur.p);
}).observe(main, { childList: true, subtree: true });
