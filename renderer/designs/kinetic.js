// Editorial Kinetic Type: lyric lines as typography that swells word by word in sync with the song.
// - every word is a fixed-width box (measured at the heaviest weight) so a weight morph never re-wraps the paragraph
// - the active line animates the variable font's wght axis per word (--p 0..1), lifts, and takes the song's spot colour
// - GSAP SplitText sets the active line's glyphs rising into place on entry (created on entry, reverted on exit: never 1000s of spans)
// - a marginal index numeral rides beside the active line (transform only)
import { motionOff } from '../motion.js';

const W_MIN = 500, W_MAX = 860;
// widths come from the real DOM at the heaviest weight (a canvas guess mis-sizes fallback-script glyphs): one forced layout for the whole page of lyrics
export function fit(scroll) {
  const ws = [...scroll.querySelectorAll('.ly-line.kin .w')];
  if (!ws.length) return;
  scroll.classList.add('measuring');
  const px = parseFloat(getComputedStyle(ws[0].parentNode).fontSize) || 54;
  const wd = ws.map(w => w.getBoundingClientRect().width);
  scroll.classList.remove('measuring');
  ws.forEach((w, i) => { w.style.width = (wd[i] / px + 0.02).toFixed(3) + 'em'; });
}
const SPLIT = () => window.gsap && window.SplitText;
if (window.gsap && window.SplitText) gsap.registerPlugin(SplitText);

// words of a line with their start/end seconds (word-level LRC when present, else spread over the line by glyph count)
function timing(l, nextT, words) {
  const end = Math.max(l.t + 0.6, Math.min(nextT ?? l.t + 4, l.end ?? Infinity, l.t + 7) - 0.12);
  if (l.words && l.words.length === words.length) return l.words.map((w, k) => [w.t, l.words[k + 1]?.t ?? end]);
  const wts = words.map(w => w.length + 1.5), tot = wts.reduce((a, b) => a + b, 0);
  let acc = 0;
  return words.map((w, k) => { const a = l.t + (end - l.t) * acc / tot; acc += wts[k]; return [a, l.t + (end - l.t) * acc / tot]; });
}

export function buildLine(l, synced, nextT, onclick, cls) {
  const el = document.createElement('p');
  el.className = 'ly-line kin' + cls + (/[^\x00-ɏ -⁯]/.test(l.text || '') ? ' nl' : '');
  if (onclick) el.addEventListener('click', onclick);
  if (!l.text) { el.textContent = '♪'; return el; }
  const words = l.text.split(/\s+/).filter(Boolean);
  const tm = synced ? timing(l, nextT, words) : null;
  el._tm = tm; el._ws = words.map((w, k) => {
    const s = document.createElement('span');
    s.className = 'w'; s.textContent = w;
    el.append(s);
    return s;
  });
  return el;
}

let mark, split = null;
export function ensureMark(scroll) {
  if (mark?.parentNode === scroll) return mark;
  mark = document.createElement('i');
  mark.className = 'ly-mark'; mark.setAttribute('aria-hidden', 'true');
  scroll.prepend(mark);
  return mark;
}

export function enter(el, index, total, scroll) {
  const m = ensureMark(scroll);
  m.textContent = String(index + 1).padStart(2, '0') + ' / ' + String(total).padStart(2, '0');
  const y = el.offsetTop + 6;
  if (motionOff() || !window.gsap) { m.style.transform = `translateY(${y}px)`; return; }
  gsap.to(m, { y, duration: 1.05, ease: 'expo.out', overwrite: true });
  if (!SPLIT() || el._ws == null) return;
  split?.revert();
  split = SplitText.create(el._ws, { type: 'chars', charsClass: 'ch' });
  gsap.fromTo(split.chars, { yPercent: 38, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.7, ease: 'expo.out', stagger: { each: 0.011, from: 'start' }, overwrite: true, clearProps: 'transform,opacity' });
}
export function leave(el) {
  split?.revert(); split = null;
  el._ws?.forEach(w => { if (w._p) { w._p = 0; w.style.setProperty('--p', '0'); } w.classList.remove('cur', 'sung'); });
}
// called every frame while playing: only words whose progress moved are touched
export function frame(el, pos) {
  if (!el._tm) return;
  const off = motionOff();
  el._ws.forEach((w, k) => {
    const [a, b] = el._tm[k];
    const raw = Math.max(0, Math.min(1, (pos - a) / Math.max(0.08, b - a)));
    const p = off ? (raw > 0 ? 1 : 0) : raw * raw * (3 - 2 * raw);
    if (Math.abs(p - (w._p ?? -1)) > 0.012 || (p === 1) !== (w._p === 1)) { w._p = p; w.style.setProperty('--p', p.toFixed(3)); }
    const cur = raw > 0 && raw < 1, sung = raw >= 1;
    if (w._cur !== cur) { w._cur = cur; w.classList.toggle('cur', cur); }
    if (w._sung !== sung) { w._sung = sung; w.classList.toggle('sung', sung); }
  });
}
// neighbours fade by distance, so the eye reads the line stack as a depth ramp
export function ramp(els, i, prev) {
  const set = (k, c) => els[k]?.classList.add(c);
  const clear = k => els[k]?.classList.remove('d1', 'd2', 'd3', 'pa');
  if (prev >= 0) for (let k = prev - 3; k <= prev + 3; k++) clear(k);
  for (let k = i - 3; k <= i + 3; k++) { if (k === i) continue; set(k, 'd' + Math.min(3, Math.abs(k - i))); if (k < i) set(k, 'pa'); }
}
