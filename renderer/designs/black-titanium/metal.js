// BLACK TITANIUM REFERENCE (metal-b): light model, cover matcap, volume ring, Now Playing instrument.
// Nothing here runs while idle: pointer light is rAF-coalesced and stops with the pointer, the needle meter and the
// seconds hand only tick while a track plays on the Now Playing view, everything else is event driven.
import { h, $ } from '../../util.js';
import { artUrl } from '../../util.js';
import { setVolume } from '../../player.js';

const body = document.body;
body.classList.add('mt');
const motionOk = () => !body.classList.contains('anim-off') && !matchMedia('(prefers-reduced-motion: reduce)').matches;
const SVGNS = 'http://www.w3.org/2000/svg';

// shared SVG paint servers (chrome horizon for SVG knobs)
document.body.insertAdjacentHTML('afterbegin', `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <linearGradient id="m-chrome-v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f7faff"/><stop offset=".4" stop-color="#9aa5b4"/><stop offset=".49" stop-color="#2a3038"/><stop offset=".52" stop-color="#0f1215"/><stop offset=".7" stop-color="#5d6672"/><stop offset="1" stop-color="#d7dee8"/></linearGradient></defs></svg>`);

// knurling as an anti-aliased SVG (repeating-conic-gradient moires at this size)
{ const N = 36, pts = []; for (let i = 0; i < N; i++) { const a0 = i * 2 * Math.PI / N, a1 = a0 + Math.PI / N, f = a => `${(50 + 50 * Math.sin(a)).toFixed(2)},${(50 - 50 * Math.cos(a)).toFixed(2)}`; pts.push(`<path d="M50 50L${f(a0)}L${f(a1)}Z"/>`); }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><circle cx="50" cy="50" r="50" fill="#161a1f"/><g fill="#3a424b">${pts.join('')}</g><circle cx="50" cy="50" r="50" fill="none" stroke="#000" stroke-opacity=".5" stroke-width="3"/></svg>`;
  const blobVar = (n, s) => body.style.setProperty(n, `url(${URL.createObjectURL(new Blob([s], { type: 'image/svg+xml' }))})`);
  blobVar('--knurl', svg);
  // long data: URLs in inherited custom properties are re-substituted on every element per write; blob: URLs are short
  const cs = getComputedStyle(body);
  for (const n of ['--grain', '--brush']) { const m = /^\s*url\("?data:image\/svg\+xml,(.*?)"?\)\s*$/s.exec(cs.getPropertyValue(n)); if (m) { try { blobVar(n, decodeURIComponent(m[1])); } catch {} } } }

/* ---------- 1. the key light: one point light = the pointer. Each live part derives its own angle to it. ---------- */
const LIVE = '#sidebar, #player, .t-btn, .m-knob, .m-stage, .m-snail, .view-head .cat, .np-art, .brand-mark, .tb-btn.primary';
let rects = new Map(), scanT = 0, raf = 0, mx = 0, my = 0, lastScan = 0;
function scan() {
  rects.clear(); lastScan = performance.now();
  document.querySelectorAll(LIVE).forEach(el => { const r = el.getBoundingClientRect(); if (r.width && r.height) rects.set(el, r); });
}
function light() {
  raf = 0;
  for (const [el, r] of rects) {
    const dx = mx - (r.left + r.width / 2), dy = my - (r.top + r.height / 2);
    el.style.setProperty('--la', (Math.atan2(dx, -dy) * 180 / Math.PI).toFixed(1) + 'deg');
    el.style.setProperty('--px', Math.min(1, Math.max(0, (mx - r.left) / r.width)).toFixed(3));
    el.style.setProperty('--py', Math.min(1, Math.max(0, (my - r.top) / r.height)).toFixed(3));
  }
}
addEventListener('pointermove', e => {
  if (!motionOk()) return;
  mx = e.clientX; my = e.clientY;
  if (!rects.size || performance.now() - lastScan > 2500) scan();
  if (!raf) raf = requestAnimationFrame(light);
}, { passive: true });
const rescan = () => { clearTimeout(scanT); scanT = setTimeout(scan, 160); };
addEventListener('resize', rescan);

/* ---------- 2. cover -> matcap (once per track) -> --env, dip-crossfaded ---------- */
let envKey = '', envUrl = '', envVal = '';
// --env is set only on the parts that paint it (player bar + stage), never on body: a body write restyles the whole tree
const applyEnv = () => document.querySelectorAll('#player, .m-stage').forEach(e => e.style.setProperty('--env', envVal));
const predecode = a => { if (a) { const i = new Image(); i.src = artUrl(a, true); i.decode().catch(() => {}); } }; // big cover decoded off-thread before the stage paints it
async function buildEnv(art) {
  if (!art || art === envKey) return;
  envKey = art; await new Promise(r => setTimeout(r, 450)); // off the transition frames
  try {
    const img = new Image(); img.crossOrigin = 'anonymous'; img.src = artUrl(art); await img.decode();
    const S = 16, c = new OffscreenCanvas(S, S), g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, S, S);
    const d = g.getImageData(0, 0, S, S).data;
    const at = (u, v) => { // bilinear sample of the 16x16 blur
      const x = Math.min(S - 1.001, Math.max(0, u * (S - 1))), y = Math.min(S - 1.001, Math.max(0, v * (S - 1)));
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, o = (a, b) => (b * S + a) * 4, out = [0, 0, 0];
      for (let k = 0; k < 3; k++) out[k] = (d[o(x0, y0) + k] * (1 - fx) + d[o(x0 + 1, y0) + k] * fx) * (1 - fy) + (d[o(x0, y0 + 1) + k] * (1 - fx) + d[o(x0 + 1, y0 + 1) + k] * fx) * fy;
      return out;
    };
    const N = 128, oc = new OffscreenCanvas(N, N), og = oc.getContext('2d'), im = og.createImageData(N, N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const nx = (x + .5) / N * 2 - 1, ny = (y + .5) / N * 2 - 1, r2 = nx * nx + ny * ny, i = (y * N + x) * 4;
      if (r2 > 1) { im.data[i + 3] = 0; continue; }
      const nz = Math.sqrt(1 - r2), rx = 2 * nz * nx, ry = 2 * nz * ny; // reflected view vector
      const [r, gg, b] = at(.5 + rx * .5, .5 + ry * .5);
      const sky = Math.max(0, 1 - Math.abs(ny + .45) * 3.2) * 150; // softbox strip, upper part
      const gnd = ny > .25 ? 40 : 0;
      im.data[i] = Math.min(255, r * .85 + sky); im.data[i + 1] = Math.min(255, gg * .85 + sky); im.data[i + 2] = Math.min(255, b * .85 + sky); im.data[i + 3] = 255 - gnd;
    }
    og.putImageData(im, 0, 0);
    const blob = await oc.convertToBlob({ type: 'image/png' });
    const next = URL.createObjectURL(blob);
    body.classList.add('env-dip');
    setTimeout(() => {
      envVal = `url(${next})`; applyEnv();
      if (envUrl) URL.revokeObjectURL(envUrl);
      envUrl = next; body.classList.remove('env-dip');
    }, motionOk() ? 230 : 0);
  } catch (e) { envKey = ""; console.error("metal env", String(e)); }
}

/* ---------- 3. volume ring ---------- */
function buildVolume() {
  const row = $('.np-vol'); if (!row || row.querySelector('.m-vol')) return;
  const ring = h('i', { class: 'k-ring' }), chrome = h('i', { class: 'k-chrome' }), turn = h('i', { class: 'k-turn' }), spec = h('i', { class: 'k-spec' });
  const knob = h('div', { class: 'm-knob', role: 'slider', tabIndex: 0, 'aria-label': 'Volume', 'aria-valuemin': 0, 'aria-valuemax': 100 }, ring, chrome, turn, spec);
  const out = h('b', {}, '0');
  const lbl = h('div', { class: 'm-vol-lbl' }, h('span', {}, 'Volume'), out);
  const wrap = h('div', { class: 'm-vol' }, knob, lbl);
  row.insertBefore(wrap, row.children[1]);
  let v = 0, lastDet = -1;
  const paint = nv => {
    v = Math.min(1, Math.max(0, nv));
    knob.style.setProperty('--v', v.toFixed(4)); knob.style.setProperty('--rot', (v * 270 - 135).toFixed(1) + 'deg');
    knob.setAttribute('aria-valuenow', Math.round(v * 100)); out.textContent = Math.round(v * 100);
    const det = Math.round(v * 20);
    if (det !== lastDet) { if (lastDet >= 0 && motionOk()) { knob.classList.add('flick'); setTimeout(() => knob.classList.remove('flick'), 90); } lastDet = det; }
  };
  const apply = nv => { paint(nv); setVolume(v); };
  let drag = null, vel = 0, inertia = 0;
  knob.addEventListener('pointerdown', e => {
    cancelAnimationFrame(inertia); knob.setPointerCapture(e.pointerId); knob.classList.add('drag');
    drag = { y: e.clientY, v, t: performance.now(), lv: v }; vel = 0;
  });
  knob.addEventListener('pointermove', e => {
    if (!drag) return;
    const nv = drag.v + (drag.y - e.clientY) / 180, now = performance.now();
    vel = (nv - drag.lv) / Math.max(8, now - drag.t) * 1000; drag.lv = nv; drag.t = now;
    apply(nv);
  });
  const end = () => {
    if (!drag) return; drag = null; knob.classList.remove('drag');
    if (!motionOk() || Math.abs(vel) < .25) return;
    let last = performance.now();
    const step = t => { const dt = (t - last) / 1000; last = t; vel *= Math.exp(-5 * dt); apply(v + vel * dt); if (Math.abs(vel) > .02 && v > 0 && v < 1) inertia = requestAnimationFrame(step); };
    inertia = requestAnimationFrame(step);
  };
  knob.addEventListener('pointerup', end); knob.addEventListener('pointercancel', end);
  knob.addEventListener('wheel', e => { e.preventDefault(); apply(v - Math.sign(e.deltaY) * .05); }, { passive: false });
  knob.addEventListener('keydown', e => {
    const k = { ArrowUp: .05, ArrowRight: .05, ArrowDown: -.05, ArrowLeft: -.05, PageUp: .2, PageDown: -.2 }[e.key];
    if (k) { e.preventDefault(); e.stopPropagation(); apply(v + k); } else if (e.key === 'Home') { e.preventDefault(); apply(0); } else if (e.key === 'End') { e.preventDefault(); apply(1); }
  });
  const sync = () => { const r = $('.np-vol .range'); if (r) paint(+r.value); };
  document.addEventListener('cadence:volume', sync); document.addEventListener('cadence:volume-ui', sync);
  sync();
}

/* ---------- 4. Now Playing instrument: sunburst dial, applied indices, circular cover, snail sub-dial, needle meter ---------- */
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
let eng = null, an = null, buf = null, tickT = 0, needleRaf = 0, needleT = 0, nAng = -50, np = null;
const ndl = (db) => Math.max(-50, Math.min(50, -50 + (db + 40) / 43 * 100));
function meterSVG() {
  const s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('viewBox', '0 0 200 112'); s.setAttribute('aria-hidden', 'true');
  const P = (a, r) => [100 + Math.sin(a * Math.PI / 180) * r, 124 - Math.cos(a * Math.PI / 180) * r];
  let html = '';
  const arc = (a0, a1, r, cls) => { const [x0, y0] = P(a0, r), [x1, y1] = P(a1, r); return `<path class="scale ${cls || ''}" d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}"/>`; };
  html += arc(-50, 27, 84) + arc(27, 50, 84, 'red');
  const marks = [[-40, -50, '-40'], [-20, -22, '-20'], [-10, -2.5, '-10'], [-5, 14, '-5'], [0, 27, '0'], [3, 50, '+3']];
  marks.forEach(([db, a, t]) => { const [x0, y0] = P(a, 84), [x1, y1] = P(a, 74), [tx, ty] = P(a, 63); html += `<path class="scale ${db >= 0 ? 'red' : ''}" d="M${x0.toFixed(1)} ${y0.toFixed(1)} L${x1.toFixed(1)} ${y1.toFixed(1)}"/><text x="${tx.toFixed(1)}" y="${(ty + 3).toFixed(1)}" text-anchor="middle">${t}</text>`; });
  for (let a = -50; a <= 50; a += 5) { const [x0, y0] = P(a, 84), [x1, y1] = P(a, 79); html += `<path class="scale ${a > 27 ? 'red' : ''}" d="M${x0.toFixed(1)} ${y0.toFixed(1)} L${x1.toFixed(1)} ${y1.toFixed(1)}" style="opacity:.55"/>`; }
  html += `<text x="158" y="104" text-anchor="middle" style="letter-spacing:.2em;opacity:.8">dB</text>`;
  html += `<line class="needle" x1="100" y1="124" x2="100" y2="34"/><circle class="hub" cx="100" cy="124" r="9"/>`;
  s.innerHTML = html; return s;
}
function enhanceNP() {
  const left = $('.npv-left'); if (!left || left.querySelector('.m-stage')) return;
  const t = window.cadence?.engine?.track, art = t?.art && artUrl(t.art, true);
  const stage = h('div', { class: 'm-stage' });
  const idx = h('div', { class: 'm-idx' });
  for (let i = 0; i < 60; i++) { const q = h('i', { class: i % 5 === 0 ? 'q' : '' }); q.style.setProperty('--a', i * 6 + 'deg'); idx.append(q); }
  const cover = h('div', { class: 'm-cover' }); if (art) cover.style.backgroundImage = `url(${art})`;
  stage.append(h('i', { class: 'm-bezel' }), h('i', { class: 'm-dial' }), idx, h('i', { class: 'm-rim' }), cover, h('i', { class: 'm-env' }));
  left.insertBefore(stage, left.firstChild); if (envVal) stage.style.setProperty('--env', envVal);
  const snailT = h('span', { class: 't' }, '0:00'), hand = h('i', { class: 'hand' });
  const snail = h('div', { class: 'm-snail', 'aria-label': 'Elapsed time' }, hand, snailT, h('span', { class: 'cap' }, 'ELAPSED'));
  const meter = h('div', { class: 'm-meter', 'aria-hidden': 'true' }, meterSVG());
  const readout = h('div', { class: 'm-readout' }, meter, snail);
  left.append(readout);
  np = { idx, ticks: [...idx.children], snailT, hand, meter, needle: meter.querySelector('.needle'), lit: 0 };
  charge(true); startTick();
  rescan();
}
// one-off GPU shader warm-up: draw a tiny faint copy of the instrument at idle so the first Now Playing visit pays no compile/raster stall
let warmed = false;
function warm() {
  if (warmed || !motionOk()) return; warmed = true;
  const w = h('div', { 'aria-hidden': 'true', style: 'position:fixed;right:0;bottom:0;width:520px;height:700px;overflow:hidden;opacity:.02;pointer-events:none;z-index:-1' });
  const st = h('div', { class: 'm-stage', style: 'width:520px;min-width:0;margin:0' }, h('i', { class: 'm-bezel' }), h('i', { class: 'm-dial' }), h('i', { class: 'm-idx' }, h('i', { class: 'lit' })), h('i', { class: 'm-rim' }), h('div', { class: 'm-cover' }), h('i', { class: 'm-env' }));
  w.append(st, h('div', { class: 'm-snail', style: '' }), h('div', { class: 'm-meter', style: '' }, meterSVG()));
  const a = window.cadence?.engine?.track?.art; if (a) st.querySelector('.m-cover').style.backgroundImage = `url(${artUrl(a, true)})`;
  document.body.append(w); setTimeout(() => w.remove(), 1500);
}
function litCount() { const e = window.cadence?.engine, d = e?.track?.duration; return d ? Math.round(Math.min(1, e.position / d) * 60) : 0; }
let chargeT = 0, enhT = 0;
function charge(sweep) { // signature moment: the 60 indices power on clockwise in song colour, then retreat to the elapsed position
  if (!np) return;
  clearTimeout(chargeT);
  const n = litCount(), go = motionOk() && sweep, T = np.ticks;
  if (!go) { T.forEach((el, i) => { el.style.transitionDelay = '0ms'; el.classList.toggle('lit', i < n); }); np.lit = n; np.busy = false; return; }
  np.busy = true; np.idx.classList.add('chg');
  T.forEach((el, i) => { el.style.transitionDelay = i * 6 + 'ms'; el.classList.add('lit'); });
  chargeT = setTimeout(() => {
    if (!np) return;
    const m = litCount();
    T.forEach((el, i) => { el.style.transitionDelay = (59 - i) * 5 + 'ms'; el.classList.toggle('lit', i < m); });
    np.lit = m;
    chargeT = setTimeout(() => { if (np) { T.forEach(el => el.style.transitionDelay = '0ms'); np.busy = false; np.idx.classList.remove('chg'); } }, 60 * 5 + 300);
  }, 60 * 6 + 200);
}
function tick() {
  if (!np || !np.idx.isConnected) { np = null; clearInterval(tickT); tickT = 0; cancelAnimationFrame(needleRaf); clearTimeout(needleT); return; }
  const e = window.cadence?.engine; if (!e) return;
  const pos = e.position || 0, n = litCount();
  np.snailT.textContent = fmt(pos); np.hand.style.setProperty('--sec', (pos % 60) * 6 + 'deg');
  if (!np.busy && !np.frozen && n !== np.lit) { for (let i = 0; i < np.ticks.length; i++) np.ticks[i].classList.toggle('lit', i < n); np.lit = n; }
}
function startTick() { syncTick(); tick(); runNeedle(); }
function syncTick() { // the 2 Hz clock exists only while a track plays
  const play = !body.classList.contains('paused');
  if (play && !tickT && np) tickT = setInterval(() => { if (!document.hidden) tick(); }, 500);
  else if (!play && tickT) { clearInterval(tickT); tickT = 0; }
}
function runNeedle() {
  cancelAnimationFrame(needleRaf); clearTimeout(needleT);
  const e = window.cadence?.engine;
  if (!np || !e || body.classList.contains('paused') || !motionOk()) { if (np) np.needle.style.transform = 'rotate(-48deg)'; return; }
  try {
    if (!an && e.ctx && e.tap) { an = e.ctx.createAnalyser(); an.fftSize = 1024; e.tap.connect(an); buf = new Float32Array(an.fftSize); }
  } catch { an = null; }
  let tgt = -48, shown = 99;
  const step = t => {
        if (!np || !np.meter.isConnected || body.classList.contains('paused')) { if (np) np.needle.style.transform = 'rotate(-48deg)'; return; }
    if (an) { an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; const db = 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-6); tgt = ndl(db); }
    nAng += (tgt - nAng) * (tgt > nAng ? .35 : .06); // fast attack, slow release
    if (Math.abs(nAng - shown) > .05) { shown = nAng; np.needle.style.transform = `rotate(${nAng.toFixed(2)}deg)`; }
    needleT = setTimeout(() => { needleRaf = requestAnimationFrame(step); }, 33); // ~30 Hz via timer: no rAF spinning between needle frames
  };
  needleRaf = requestAnimationFrame(step);
}

/* ---------- 5. wiring ---------- */
function sweep() {
  const p = $('#player'); if (!p || !motionOk()) return;
  let s = p.querySelector(':scope > .sweep'); if (!s) { s = h('div', { class: 'sweep', 'aria-hidden': 'true' }); p.append(s); }
  s.classList.remove('go'); void s.offsetWidth; s.classList.add('go');
}
function init() {
  const c = window.cadence;
  if (!c || !c.engine) return setTimeout(init, 150);
  eng = c.engine; c.metal = { charge, sweep, frame(n) { clearTimeout(chargeT); clearInterval(tickT); tickT = 0; if (np) { np.frozen = true; np.busy = true; np.ticks.forEach((el, i) => { el.style.transitionDelay = "0ms"; el.classList.toggle("lit", i < n); }); } } }; // debug handle for the screenshot harness
  buildVolume();
  const onTrack = () => { const t = eng.track; predecode(t?.art); if (t?.art) { buildEnv(t.art); setTimeout(warm, 500); } setTimeout(() => { enhanceNP(); charge(true); }, 380); };
  eng.addEventListener('track', onTrack);
  let was = eng.playing;
  eng.addEventListener('state', () => { if (eng.playing !== was) { was = eng.playing; sweep(); setTimeout(() => { syncTick(); runNeedle(); tick(); }, 30); } });
  predecode(eng.track?.art); if (eng.track?.art) { buildEnv(eng.track.art); setTimeout(warm, 1500); }
  new MutationObserver(() => { clearTimeout(enhT); enhT = setTimeout(() => { enhanceNP(); rescan(); }, 260); }).observe($('#main'), { childList: true }); // after the view's own transition
  new MutationObserver(() => rescan()).observe($('#player'), { childList: true });
  enhanceNP(); scan();
}
init();
