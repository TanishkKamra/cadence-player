// Cinema Press: the glue. (1) Now Playing title is fitted so its longest word always fits the column at display size.
// (2) On every track change the titles rise letter by letter (GSAP SplitText, reverted when done: no span soup left behind).
// Everything is event driven (mutation observers); no timers, no rAF loops while idle.
import { motionOff } from '../../motion.js';

const main = document.getElementById('main'), player = document.getElementById('player');
const G = () => window.gsap && window.SplitText;
if (G()) gsap.registerPlugin(SplitText);

// ---- fit the Now Playing title ----
let lastW = 0;
function fitTitle(t) {
  const w = t.parentElement.clientWidth;
  if (Math.abs(w - lastW) < 3 && t.style.getPropertyValue('--tsz')) return; // resize ticks with no real width change cost a full text layout each
  lastW = w;
  let s = Math.min(112, Math.max(56, w * .26));
  const ok = () => t.scrollWidth <= t.clientWidth + 1 && t.getBoundingClientRect().height <= s * .88 * 3.3;
  t.style.setProperty('--tsz', s + 'px');
  for (let n = 0; n < 8 && !ok() && s > 30; n++) { s = Math.max(30, s * Math.min(.92, t.clientWidth / Math.max(1, t.scrollWidth))); t.style.setProperty('--tsz', s + 'px'); }
}

// ---- letters rise ----
const last = new WeakMap();
function rise(el, delay = 0) {
  if (window.__still) return; // screenshot harness: hidden windows do not tick
  if (!el || motionOff() || !G()) return;
  const txt = el.textContent;
  if (!txt) return;
  last.set(el, txt);
  let sp;
  try { sp = SplitText.create(el, { type: 'words,chars', charsClass: 'ch', wordsClass: 'sw' }); } catch { return; }
  const dur = document.body.classList.contains('anim-fast') ? .6 : 1;
  // WAAPI (compositor) instead of gsap: gsap rewrote inline styles on every glyph every frame (style recalc + text relayout)
  const ease = 'cubic-bezier(.16,1,.3,1)';
  const an = sp.chars.map((c, k) => c.animate([{ transform: 'translateY(55%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 900 * dur, delay: delay * 1000 + k * 22 * dur, easing: ease, fill: 'backwards' }));
  Promise.all(an.map(a => a.finished)).then(() => { if (sp.chars[0]?.isConnected) sp.revert(); }, () => {});
}

window.addEventListener('press:title', e => rise(e.detail.el, .1));

new MutationObserver(() => {
  const t = main.querySelector('.npv-title');
  if (!t || t.dataset.fit) return;
  t.dataset.fit = 1;
  (document.fonts?.ready || Promise.resolve()).then(() => { fitTitle(t); rise(t, .05); });
  new ResizeObserver(() => fitTitle(t)).observe(t.parentElement);
}).observe(main, { childList: true, subtree: true });
