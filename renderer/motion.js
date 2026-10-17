// Spring motion on live elements. Springs are simulated once and baked into CSS linear() easings,
// so every animation runs on the compositor (transform/opacity only) and the page stays clickable.
// Retargeting reads where an element visually is right now and springs from there: no snapshots, no jumps.

function bake(stiffness, damping, mass = 1) {
  const dt = 1 / 240, pts = [];
  let x = 0, v = 0, t = 0;
  while (t < 2.5) {
    v += ((-stiffness * (x - 1) - damping * v) / mass) * dt;
    x += v * dt; t += dt;
    pts.push(x);
    if (Math.abs(1 - x) < 5e-4 && Math.abs(v) < 5e-3) break;
  }
  const step = Math.max(1, Math.ceil(pts.length / 72));
  const samples = pts.filter((_, i) => i % step === 0).map(n => +n.toFixed(4));
  samples[samples.length - 1] = 1;
  return { easing: `linear(0, ${samples.join(', ')})`, duration: Math.round(t * 1000) };
}

export const SPRING = {
  smooth: bake(190, 26),  // pages: settles softly, no visible overshoot
  glide: bake(260, 24),   // sidebar pill, cover morph: a hint of overshoot, like it has mass
  snappy: bake(520, 30),  // press feedback
};
// expose to CSS so :active / hover transitions use the same physics
for (const [k, s] of Object.entries(SPRING)) {
  document.documentElement.style.setProperty(`--spring-${k}`, s.easing);
  document.documentElement.style.setProperty(`--spring-${k}-dur`, s.duration + 'ms');
}

const off = () => document.body.classList.contains('anim-off') || matchMedia('(prefers-reduced-motion: reduce)').matches;
const scale = () => (document.body.classList.contains('anim-fast') ? 0.6 : 1);
export const motionOff = off;

// animate el between keyframes with a spring (or a plain duration/easing); returns the Animation or null
export function spring(el, keyframes, kind = 'smooth', extra = {}) {
  if (off()) return null;
  const s = typeof kind === 'string' ? SPRING[kind] : kind;
  return el.animate(keyframes, { duration: s.duration * scale(), easing: s.easing, ...extra });
}
export function fade(el, keyframes, duration, extra = {}) {
  if (off()) return null;
  return el.animate(keyframes, { duration: duration * scale(), easing: 'cubic-bezier(.32,.72,0,1)', ...extra });
}

// Move el (already at its final layout spot) so it appears to travel from rect `from` to where it is now.
// `from` should be read with getBoundingClientRect() before the layout change: it includes any running
// animation, so a flip started mid-flight continues from exactly where the element was drawn.
export function flip(el, from, kind = 'glide') {
  el.getAnimations().forEach(a => a.cancel());
  const to = el.getBoundingClientRect();
  if (!from || !to.width || !to.height) return null;
  const dx = from.left - to.left, dy = from.top - to.top, sx = from.width / to.width, sy = from.height / to.height;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return null;
  return spring(el, [
    { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
    { transformOrigin: '0 0', transform: 'none' },
  ], kind);
}
