// Designs: whole-app looks layered over styles.css. Only the active one is loaded, at startup;
// switching reloads the window (playback resumes where it was).
export const DESIGNS = {
  classic: { label: 'Classic' },
  'black-titanium': { label: 'Black Titanium', body: ['mt'], css: ['black-titanium/metal.css'], js: ['black-titanium/metal.js'] },
  'alu-atelier': { label: 'Alu Atelier', body: ['mt'], css: ['alu-atelier/metal.css'], js: ['alu-atelier/metal.js'], init: 'initMetal' },
  'cinema-press': { label: 'Cinema Press', body: ['wi', 'press'], css: ['cinema-press/cinema.css', 'cinema-press/press.css'], js: ['cinema-press/cinema.js', 'cinema-press/press.js'], gsap: true, ink: true, icons: 'regular' },
  'two-ink': { label: 'Two-Ink Proof', body: ['fb'], css: ['two-ink/fusion-b.css'], js: ['two-ink/fusion-b.js'], gsap: true, icons: 'regular' },
  'lit-chassis': { label: 'Lit Chassis', body: ['fc'], css: ['lit-chassis/fusion.css'], js: ['lit-chassis/fusion.js'], ink: true },
};
export const designOf = key => DESIGNS[key] || DESIGNS.classic;

const base = new URL('./', import.meta.url);
const load = (tag, attrs) => new Promise(res => {
  const el = Object.assign(document.createElement(tag), attrs);
  el.onload = el.onerror = res; // a missing file must not block startup
  document.head.append(el);
});

// before the first render: classes, icon weight and stylesheets (awaited, so the window never shows the wrong look)
export async function applyDesignStyles(key) {
  const d = designOf(key);
  document.body.classList.add(...(d.body || []));
  document.body.dataset.design = DESIGNS[key] ? key : 'classic';
  if (d.ink) document.getElementById('bg')?.before(Object.assign(document.createElement('div'), { id: 'ink', ariaHidden: 'true', innerHTML: '<div class="ink-l"></div>' }));
  await Promise.all((d.css || []).map(f => load('link', { rel: 'stylesheet', href: new URL(f, base).href })));
  return d;
}

// after the player and the first view exist: the design's scripts (they hook into that DOM)
export async function startDesign(key, cadence) {
  const d = designOf(key);
  if (d.gsap) for (const f of ['gsap.min.js', 'SplitText.min.js']) await load('script', { src: `app://mod/gsap/dist/${f}` });
  for (const f of d.js || []) {
    const m = await import(new URL(f, base).href);
    if (d.init) m[d.init]?.(cadence);
  }
}
