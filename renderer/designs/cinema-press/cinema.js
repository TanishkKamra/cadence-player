// Wet Ink Cinema: song palette -> CSS roles, plus the "ink pour" reveal on track change.
// Idle = static layers. Only the pour animates (~1.3 s), then the old layer is removed.
import { SPRING, motionOff } from '../../motion.js';

const root = document.documentElement, ink = document.getElementById('ink');
const lum = ([r, g, b]) => { const f = c => (c /= 255) <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
function hsl([r, g, b]) { r /= 255; g /= 255; b /= 255; const M = Math.max(r, g, b), m = Math.min(r, g, b), l = (M + m) / 2; if (M === m) return [0, 0, l];
  const d = M - m, s = l > .5 ? d / (2 - M - m) : d / (M + m); const h = M === r ? (g - b) / d + (g < b ? 6 : 0) : M === g ? (b - r) / d + 2 : (r - g) / d + 4; return [h / 6, s, l]; }
function rgb(h, s, l) { const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q, f = t => { t = (t + 1) % 1; return Math.round(255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p)); }; return [f(h + 1 / 3), f(h), f(h - 1 / 3)]; }

// Palette: weighted hue buckets (saturation x population) -> up to 3 distinct inks, plus the average shadow.
function palette(img) {
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
  const top = [...B.values()].sort((a, b) => b.w - a.w).slice(0, 3);
  const inks = top.map(b => rgb(((b.h / b.w) + 1) % 1, Math.min(.9, Math.max(.5, b.s / b.w * 1.1)), Math.min(.6, Math.max(.4, b.l / b.w))));
  while (inks.length < 3) inks.push(inks[0] ? rgb((hsl(inks[0])[0] + .08 * (inks.length)) % 1, .55, .45) : [110, 120, 255]);
  const shadow = dn > 20 ? [dr / dn, dg / dn, db / dn].map(Math.round) : [20, 20, 24];
  return { inks, shadow };
}

function apply(pal, light) {
  const [a, b, c] = pal.inks;
  // deep: the "film base" every scrim is cut from. Dark theme: <= ~11% L so white text always passes AA. Light: pale paper tinted by the ink.
  const hh = hsl(mix(a, pal.shadow, .5))[0];
  const black = document.body.dataset.theme === 'black';
  const deep = light ? rgb(hh, .35, .93) : black ? rgb(hh, .3, .032) : rgb(hh, .45, .075);
  // accent for text/lines: lift lightness until >= 4.5:1 against the worst case (deep with 28% of the brightest ink bled in)
  const worst = light ? mix(deep, a, .22) : mix(deep, a, .28);
  let [ah, as] = hsl(a), al = light ? .32 : .66, acc = rgb(ah, Math.min(.95, as + .1), al), n = 0;
  while (contrast(acc, worst) < 4.6 && n++ < 40) { al += light ? -.02 : .02; acc = rgb(ah, Math.min(.95, as + .1), Math.min(.95, Math.max(.1, al))); }
  const set = (k, v) => root.style.setProperty(k, v.join(' '));
  set('--ink-a', a); set('--ink-b', b); set('--ink-c', c); set('--deep', deep); set('--accent', acc);
  return { a: a.join(' '), b: b.join(' '), c: c.join(' '), deep: deep.join(' ') };
}

const fieldCss = p => `radial-gradient(48% 62% at 90% 24%, rgb(${p.a} / .55), transparent 72%),
  radial-gradient(55% 55% at 4% 100%, rgb(${p.b} / .5), transparent 72%),
  radial-gradient(50% 45% at 30% 0%, rgb(${p.c} / .4), transparent 70%)`;

let seq = 0, url = null, lastImg = null;
new MutationObserver(() => lastImg && window.dispatchEvent(new CustomEvent('cadence:art', { detail: { img: lastImg, noPour: true } }))).observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
function soft(img) { // one-shot blurred cover bitmap: the texture the ink carries
  const c = document.createElement('canvas'); c.width = c.height = 96; const g = c.getContext('2d');
  g.filter = 'blur(7px) saturate(1.5)'; g.drawImage(img, -14, -14, 124, 124);
  return c.toDataURL('image/jpeg', .85);
}

window.addEventListener('cadence:art', async e => {
  const { img } = e.detail; if (img) lastImg = img; const my = ++seq, light = document.body.dataset.theme === 'light';
  let pal; if (!img) { return; }
  try { pal = palette(img); } catch (x) { console.error("wi palette", x.message); return; }
  let p, bmp; try { p = apply(pal, light); bmp = soft(img); } catch (x) { console.error('wi apply', x.message); return; }
  if (my !== seq) return;
  const layer = document.createElement('div'); layer.className = 'ink-l';
  const sh = light ? .5 : document.body.dataset.theme === 'black' ? .86 : .42;
  layer.style.backgroundImage = `linear-gradient(rgb(${p.deep} / ${sh}), rgb(${p.deep} / ${sh})), ${fieldCss(p)}, url('${bmp}')`;
  layer.style.backgroundSize = 'cover, 100% 100%, 100% 100%, 100% 100%, cover';
  const old = [...ink.children], first = !ink.dataset.has; ink.dataset.has = 1;
  const art = document.querySelector('#player .np-art'), r = art ? art.getBoundingClientRect() : { left: innerWidth * .8, top: 300, width: 0, height: 0 };
  const ox = r.left + r.width / 2, oy = r.top + r.height / 2;
  layer.style.setProperty('--ox', ox + 'px'); layer.style.setProperty('--oy', oy + 'px');
  ink.append(layer);
  const done = () => { old.forEach(o => o.remove());  };
  if (first || e.detail.noPour || motionOff()) { layer.style.setProperty('--r', '300vmax'); return done(); }
  // pour: three drops (offset centres, staggered) bloom with a soft ink edge; spring from Motion-baked physics
  layer.classList.add('pouring');
  const reach = Math.hypot(Math.max(ox, innerWidth - ox), Math.max(oy, innerHeight - oy)) + 220;
  const s = SPRING.smooth, dur = Math.round(s.duration * 3.3 * (document.body.classList.contains('anim-fast') ? .6 : 1));
  const a = layer.animate([{ '--r': '0px' }, { '--r': reach + 'px' }], { duration: dur, easing: s.easing, fill: 'forwards' });
  a.finished.then(() => { layer.classList.remove('pouring'); layer.style.setProperty('--r', '300vmax'); a.cancel(); done(); }, () => {});
});

// Eyebrow for headers that have none: the sidebar section the page belongs to (Library / Smart lists / ...)
const main = document.getElementById('main');
const eyebrow = () => main.querySelectorAll('.view-title:not([data-k])').forEach(t => {
  t.dataset.k = 1; if (t.querySelector('.kicker')) return;
  const it = document.querySelector('#sidebar .side-item.active'); let k = it ? 'Library' : 'Cadence'; const h1 = t.querySelector('h1')?.textContent; if (h1 === 'Settings') k = 'Preferences';
  for (let n = k === 'Preferences' ? null : it; n; n = n.previousElementSibling) if (n.classList.contains('side-h')) { k = n.textContent.trim() || k; break; }
  const e = document.createElement('div'); e.className = 'kicker'; e.textContent = k; t.prepend(e);
});
new MutationObserver(eyebrow).observe(main, { childList: true, subtree: true });
