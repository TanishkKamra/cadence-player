import { ICONS as LIGHT } from './icons.js';
import { ICONS as REGULAR } from './icons-regular.js';
let P = LIGHT;
// some designs draw Phosphor Regular instead of Light; set once at startup, before anything is rendered
export const setIconWeight = w => { P = w === 'regular' ? REGULAR : LIGHT; };
// DOM helper: text children are always inserted as text nodes (tags/lyrics are untrusted).
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const k in props || {}) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const s in v) s.startsWith('--') ? el.style.setProperty(s, v[s]) : (el.style[s] = v[s]);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof el[k] !== 'object') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
export const $ = (s, root = document) => root.querySelector(s);

export const PATHS = LIGHT; // taskbar thumbnail buttons
export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 256 256');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'ic ' + cls);
  s.innerHTML = `<path d="${P[name]}"/>`;
  return s;
}

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, hh = Math.floor(sec / 3600);
  return (hh ? hh + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
export function fmtLong(sec) {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`;
}
export const codecName = t => (t.codec || '').replace(/^MPEG 1 Layer 3$/, 'MP3').replace(/^MPEG-4\/AAC.*/, 'AAC').split(' ')[0];
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export const signed = (x, digits = 1, unit = '') => (x > 0 ? '+' : '') + (+x).toFixed(digits) + unit;
export function fmtQuality(t) {
  const codec = codecName(t);
  const parts = [codec];
  if (t.lossless && t.bits) parts.push(`${t.bits}-bit`);
  if (t.sampleRate) parts.push(`${+(t.sampleRate / 1000).toFixed(1)} kHz`);
  if (!t.lossless && t.bitrate) parts.push(`${Math.round(t.bitrate / 1000)} kbps`);
  return parts.filter(Boolean).join(' · ');
}
// compact list form: "FLAC 24/96", "MP3 320"
export function fmtQualityShort(t) {
  const codec = codecName(t);
  if (t.lossless && t.bits && t.sampleRate) return `${codec} ${t.bits}/${+(t.sampleRate / 1000).toFixed(1)}`;
  return [codec, t.bitrate ? Math.round(t.bitrate / 1000) : null].filter(Boolean).join(' ');
}
export const isHiRes = t => t.lossless && (t.bits > 16 || t.sampleRate > 48000);
export const artUrl = (hash, big) => hash ? `app://covers/${hash}${big ? '' : '_s'}.jpg` : null;
export const norm = s => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const shuffleArr = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const KEEP = ['AC/DC', 'Tyler, The Creator', 'Earth, Wind & Fire', 'Crosby, Stills, Nash & Young', 'Emerson, Lake & Palmer', 'Simon & Garfunkel', 'Hall & Oates', 'Mumford & Sons'];
const KEEP_RE = new RegExp(KEEP.map(k => k.replace(/\W/g, '\\$&')).join('|'), 'gi');
// split "A, B & C feat. D" into artists; known names with a separator inside (AC/DC, Tyler, The Creator) stay whole
export const splitNames = s => {
  const kept = [];
  const t = (s || '').replace(KEEP_RE, m => (kept.push(m), `\0${kept.length - 1}\0`));
  return t.split(/\s*(?:,(?! the )|;|\/|&| feat\.? | ft\.? | x )\s*/i).map(x => x.trim().replace(/\0(\d+)\0/g, (_, i) => kept[i])).filter(Boolean);
};

// Dominant vivid colour of an image, nudged into a readable range for dark UI.
export function accentFrom(img) {
  const c = document.createElement('canvas');
  c.width = c.height = 40;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, 40, 40);
  const d = g.getImageData(0, 0, 40, 40).data;
  const bins = new Map();
  for (let i = 0; i < d.length; i += 4) {
    const [hh, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    if (l < 0.12 || l > 0.92) continue;
    const key = Math.round(hh * 24);
    const b = bins.get(key) || { w: 0, h: 0, s: 0 };
    const w = s * s + 0.02;
    b.w += w; b.h += hh * w; b.s += s * w;
    bins.set(key, b);
  }
  let best = null;
  for (const b of bins.values()) if (!best || b.w > best.w) best = b;
  if (!best) return null;
  const hue = best.h / best.w, sat = Math.min(0.85, Math.max(0.45, best.s / best.w));
  return hslToRgb(hue, sat, 0.64);
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const hh = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hh / 6, s, l];
}
function hslToRgb(hh, s, l) {
  const f = n => { const k = (n + hh * 12) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}
