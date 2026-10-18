// Reusable widgets: menus, dialogs, toasts, sliders, knobs, the virtual track list and card grids.
import { h, $, icon, fmtTime, fmtQuality, fmtQualityShort, isHiRes, artUrl, norm } from './util.js';
import { S, set, engine, rating, titleOf, artistOf, plTracks } from './core.js';
import { onTeardown, heroFrom } from './views.js';
import { motionOff } from './motion.js';
import { trackMenu, rate, playFrom, movePlaylistItem, removeFromPlaylist } from './actions.js';

// ---------- menus ----------
// opts.anchor: open below (or above) that element, at least as wide; opts.select: a value picker (no icon gutter)
export function menu(e, items, at, opts = {}) {
  closeMenus();
  const m = h('div', { class: 'menu' + (opts.select ? ' menu-select' : ''), role: opts.select ? 'listbox' : 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(h('hr')); continue; }
    if (it.header) { m.append(h('div', { class: 'mh' }, it.header)); continue; }
    m.append(h('button', {
      role: opts.select ? 'option' : 'menuitem', disabled: it.disabled, class: it.checked ? 'on' : '', 'aria-selected': opts.select ? String(!!it.checked) : null,
      onclick: ev => {
        ev.stopPropagation();
        if (it.sub) { const r = ev.currentTarget.getBoundingClientRect(); menu(null, it.sub(), { x: r.right + 4, y: r.top - 6 }); }
        else { closeMenus(); it.run(); }
      },
    }, it.icon ? icon(it.icon) : opts.select ? null : h('span', { class: 'ic' }), h('span', { class: 'ml' }, it.label),
      it.sub ? icon('right', 'sm chev') : it.checked ? icon('check', 'sm chev check') : null));
  }
  document.body.append(m);
  // a menu opened by clicking a button drops from that button; right-click menus open at the pointer
  let anchor = opts.anchor || (e?.type === 'click' && e.target?.closest?.('button:not(.menu button)')) || null;
  if (anchor && !anchor.getClientRects().length) anchor = null; // hidden anchor: fall back to the pointer
  if (anchor) { const aw = anchor.getBoundingClientRect().width; if (aw > m.getBoundingClientRect().width) m.style.minWidth = aw + 'px'; }
  const r = m.getBoundingClientRect(), w = r.width;
  let x, y;
  if (anchor) {
    const a = anchor.getBoundingClientRect();
    x = a.left + w > innerWidth - 8 ? a.right - w : a.left; y = a.bottom + 6;
    const up = y + r.height > innerHeight - 8 && a.top - r.height - 6 > 8;
    if (up) y = a.top - r.height - 6;
    m.style.transformOrigin = `${up ? 'bottom' : 'top'} ${x < a.left ? 'right' : 'left'}`;
  } else { x = at?.x ?? e?.clientX ?? innerWidth / 2; y = at?.y ?? e?.clientY ?? innerHeight / 2; }
  m.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  e?.preventDefault?.(); e?.stopPropagation?.();
  const first = m.querySelector('button.on:not([disabled])') || m.querySelector('button:not([disabled])');
  first?.focus({ preventScroll: true });
  first?.scrollIntoView({ block: 'nearest' });
  let typed = '', typedAt = 0;
  m.addEventListener('keydown', ev => {
    const btns = [...m.querySelectorAll('button:not([disabled])')], i = btns.indexOf(document.activeElement);
    const go = j => { ev.preventDefault(); btns[(j + btns.length) % btns.length]?.focus(); };
    if (ev.key === 'ArrowDown') go(i + 1);
    else if (ev.key === 'ArrowUp') go(i - 1);
    else if (ev.key === 'Home') go(0);
    else if (ev.key === 'End') go(btns.length - 1);
    else if (ev.key === 'Escape' || ev.key === 'Tab') { ev.preventDefault(); closeMenus(); opts.anchor?.focus(); }
    else if (ev.key.length === 1 && /\S/.test(ev.key)) { // type to jump
      typed = (performance.now() - typedAt > 700 ? '' : typed) + ev.key.toLowerCase(); typedAt = performance.now();
      const j = btns.findIndex(b => b.textContent.trim().toLowerCase().startsWith(typed));
      if (j >= 0) go(j);
    }
  });
  return m;
}

// a menu that drops from a button (chevron flips while it is open)
export function anchoredMenu(btn, items, opts = {}) {
  btn.classList.add('open');
  const m = menu(null, items, null, { ...opts, anchor: btn });
  new MutationObserver((_, o) => { if (!m.isConnected) { btn.classList.remove('open'); o.disconnect(); } }).observe(document.body, { childList: true });
  return m;
}
// a dropdown-looking button whose list is built on demand (preset pickers); el.setLabel() updates the text
export function pickerButton(text, items, cls = '') {
  const lbl = h('span', { class: 'dd-label' }, text);
  const el = h('button', { type: 'button', class: 'dropdown ' + cls, 'aria-haspopup': 'menu' }, lbl, icon('down', 'xs dd-chev'));
  el.addEventListener('click', e => { e.stopPropagation(); el.classList.contains('open') ? closeMenus() : anchoredMenu(el, items()); });
  el.setLabel = t => { lbl.textContent = t; };
  return el;
}
// App-styled replacement for <select>: a pill button that opens the app's own menu as a list of choices.
// options: [[value, label], ...]. el.value reads/sets the current value; el.setOptions() swaps the list.
export function dropdown({ value, options, onChange, label, cls = '' }) {
  let opts = options, cur = value;
  const text = h('span', { class: 'dd-label' });
  const el = h('button', { type: 'button', class: 'dropdown ' + cls, 'aria-haspopup': 'listbox', 'aria-label': label },
    text, icon('down', 'xs dd-chev'));
  const sync = () => { text.textContent = (opts.find(([v]) => String(v) === String(cur)) || opts[0] || [null, ''])[1]; };
  const open = () => anchoredMenu(el, opts.map(([v, l]) => ({ label: l, checked: String(v) === String(cur), run: () => { if (String(v) !== String(cur)) { cur = v; sync(); onChange?.(v); } } })), { select: true });
  el.addEventListener('click', e => { e.stopPropagation(); el.classList.contains('open') ? closeMenus() : open(); });
  el.addEventListener('keydown', e => { if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); } });
  el.setOptions = o => { opts = o; sync(); };
  Object.defineProperty(el, 'value', { get: () => cur, set: v => { cur = v; sync(); } });
  sync();
  return el;
}

// App tooltips instead of the OS ones: any element with a title shows a styled tip after a short hover.
// The title moves to data-tip on first hover (keeping it as the accessible name), so the native tooltip never shows.
const tip = h('div', { class: 'tip', role: 'tooltip' });
let tipEl = null, tipT = 0, tipHidAt = 0;
const hideTip = () => { clearTimeout(tipT); tipEl = null; if (tip.classList.contains('on')) tipHidAt = performance.now(); tip.classList.remove('on'); };
function showTip(el) {
  if (!el.isConnected || !el.dataset.tip) return;
  // no tip that only repeats a label the user can already read in full
  const shown = el.innerText?.trim() || '';
  if (shown && shown.includes(el.dataset.tip) && el.scrollWidth <= el.clientWidth + 1) return;
  tip.textContent = el.dataset.tip;
  if (!tip.isConnected) document.body.append(tip);
  const a = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const side = !!el.closest('#sidebar');
  let x, y, below = false;
  if (side) { x = a.right + 10; y = a.top + a.height / 2 - t.height / 2; }
  else {
    x = a.left + a.width / 2 - t.width / 2; y = a.top - t.height - 8;
    if (y < 8) { y = a.bottom + 8; below = true; }
  }
  tip.style.left = Math.max(8, Math.min(x, innerWidth - t.width - 8)) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
  tip.classList.toggle('below', below);
  tip.classList.toggle('right', side);
  tip.classList.add('on');
}
document.addEventListener('pointerover', e => {
  const el = e.target.closest?.('[title], [data-tip]');
  if (!el || el === tipEl) return;
  if (el.hasAttribute('title')) {
    if (el.title) { el.dataset.tip = el.title; if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', el.title); }
    el.removeAttribute('title');
  }
  hideTip(); tipEl = el;
  if (el.dataset.tip) tipT = setTimeout(() => showTip(el), performance.now() - tipHidAt < 400 ? 40 : 420); // skimming between controls: instant
});
document.addEventListener('pointerout', e => { if (tipEl && !tipEl.contains(e.relatedTarget)) hideTip(); });
// keyboard focus shows the same tip (not on click focus); "(Alt+Left)" in the text becomes aria-keyshortcuts
document.addEventListener('focusin', e => {
  const el = e.target.closest?.('[title], [data-tip]');
  if (!el || !el.matches(':focus-visible')) return;
  if (el.hasAttribute('title')) {
    if (el.title) { el.dataset.tip = el.title; if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', el.title); }
    el.removeAttribute('title');
  }
  const k = el.dataset.tip?.match(/\(([^()]+)\)$/)?.[1];
  if (k && /^[A-Za-z0-9+\[\] ]+$/.test(k) && !el.hasAttribute('aria-keyshortcuts')) el.setAttribute('aria-keyshortcuts', k.replace(/\bLeft\b/, 'ArrowLeft').replace(/\bRight\b/, 'ArrowRight').replace(/\bUp\b/, 'ArrowUp').replace(/\bDown\b/, 'ArrowDown'));
  hideTip(); tipEl = el;
  if (el.dataset.tip) showTip(el);
});
document.addEventListener('focusout', e => { if (tipEl === e.target.closest?.('[title], [data-tip]')) hideTip(); });
for (const ev of ['pointerdown', 'wheel', 'keydown']) addEventListener(ev, hideTip, { capture: true, passive: true });
// ---------- scroll reveal: elements with .reveal fade up once as they enter the viewport ----------
const io = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
}, { rootMargin: '0px 0px -6% 0px' });
// call after inserting content that contains .reveal elements (views.render does this for every view)
export const observeReveals = root => root.querySelectorAll('.reveal:not(.in)').forEach(n => io.observe(n));
// pill CTA with the icon nested in its own circle (button-in-button)
export const cta = (label, ic, onclick, kind = '') => h('button', { class: 'cta ' + kind, onclick }, h('span', {}, label), h('span', { class: 'cta-ic' }, icon(ic)));

export function closeMenus() { document.querySelectorAll('.menu').forEach(m => m.remove()); }
addEventListener('pointerdown', e => { if (!e.target.closest('.menu')) closeMenus(); }, true);
addEventListener('blur', closeMenus);

let lastToast = { msg: '', at: 0 };
export function toast(msg, err, action) {
  // same failure reported twice (ffmpeg messages differ only by a memory address like "@ 0000021b…")
  const key = String(msg).replace(/\b(0x)?[0-9a-f]{8,16}\b/gi, '#');
  if (key === lastToast.key && performance.now() - lastToast.at < 1500) return;
  lastToast = { key, at: performance.now() };
  const t = h('div', { class: 'toast' + (err ? ' err' : ''), role: err ? 'alert' : null }, msg,
    action ? h('button', { class: 'toast-act', onclick: () => { action.run(); t.remove(); } }, action.label) : null);
  if (action) t.style.pointerEvents = 'auto';
  $('#toasts').append(t);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  setTimeout(() => { t.style.transition = 'opacity .22s ease-in, transform .3s cubic-bezier(.32,.72,0,1)'; t.style.opacity = 0; t.style.transform = 'translateY(6px)'; setTimeout(() => t.remove(), 300); }, err ? 6000 : action ? 6000 : 3200);
}

const openDlg = new Map();
export function dialog(title, body, actions, wide) {
  if (openDlg.has(title)) return openDlg.get(title); // never stack a second copy
  const p = new Promise(resolve => {
    const prev = document.activeElement; // restore focus on close
    const close = v => { document.removeEventListener('keydown', onKey, true); scrim.remove(); openDlg.delete(title); if (prev?.isConnected) prev.focus(); resolve(v); };
    const last0 = actions.at(-1);
    const box = h('div', { class: 'dialog' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' }, h('h2', {}, title), body,
      h('div', { class: 'actions' }, ...actions.map(a => h('button', { class: 'tb-btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), onclick: () => close(a.value ? a.value() : a.id) }, a.label))));
    const scrim = h('div', { class: 'scrim', onpointerdown: e => { if (e.target === scrim) close(null); } }, box);
    // document level, so Escape and Tab keep working after focus drops to the body (clicking text) and no shortcut leaks behind
    const onKey = e => {
      if (scrim !== [...document.querySelectorAll('.scrim')].at(-1)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === 'Tab') {
        const f = [...box.querySelectorAll('button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(x => x.offsetParent);
        const i = f.indexOf(document.activeElement);
        if (!f.length || !box.contains(document.activeElement)) { e.preventDefault(); (f[0] || box).focus(); }
        else if (e.shiftKey ? i === 0 : i === f.length - 1) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
      } else if (e.key === 'Enter' && last0.primary && e.target.tagName === 'INPUT') close(last0.value ? last0.value() : last0.id);
    };
    document.addEventListener('keydown', onKey, true);
    $('#overlay-root').append(scrim);
    (box.querySelector('input,textarea') || (last0.danger ? box.querySelector('.actions button') : box.querySelector('.primary')) || box).focus();
  });
  openDlg.set(title, p);
  return p;
}
export async function prompt(title, value = '', placeholder = '') {
  const input = h('input', { type: 'text', value, placeholder });
  return (await dialog(title, input, [{ label: 'Cancel', id: null }, { label: 'OK', primary: true, value: () => input.value.trim() }])) || null;
}
export const confirm = (title, text, label = 'OK', danger) =>
  dialog(title, h('div', { class: 'dlg-text' }, text), [{ label: 'Cancel', id: null }, { label, primary: true, danger, id: 1 }]);

// ---------- inputs ----------
export function rangeInput({ min, max, step, value, onInput, onChange, cls = '', label }) {
  const r = h('input', { type: 'range', class: 'range ' + cls, min, max, step, value, 'aria-label': label });
  const paint = () => { const f = (r.value - min) / (max - min); r.style.setProperty('--p', (f * 100) + '%'); r.style.setProperty('--pn', f.toFixed(4)); }
  paint();
  r.addEventListener('input', () => { paint(); onInput(+r.value); });
  if (onChange) r.addEventListener('change', () => onChange(+r.value));
  r.set = v => { r.value = v; paint(); };
  return r;
}
export const toggle = (on, onChange, label) => {
  const s = h('button', { class: 'switch' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(on), 'aria-label': label });
  s.addEventListener('click', () => { on = !on; s.classList.toggle('on', on); s.setAttribute('aria-checked', String(on)); onChange(on); });
  return s;
};

// rotary knob: drag up/down, wheel, arrow keys, double-click resets
export function knob({ label, min, max, step = 0.1, value, def = 0, fmt = v => v.toFixed(1), onInput, off = false, size = 84, origin }) {
  const A0 = -135, A1 = 135, R = 34, C = 42;
  const pt = a => { const r = (a - 90) * Math.PI / 180; return [C + R * Math.cos(r), C + R * Math.sin(r)]; };
  const arcPath = (a, b) => { const [x0, y0] = pt(a), [x1, y1] = pt(b); return `M${x0} ${y0} A${R} ${R} 0 ${b - a > 180 ? 1 : 0} 1 ${x1} ${y1}`; };
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 84 84');
  const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.append(e); return e; };
  mk('path', { class: 'k-track', d: arcPath(A0, A1) });
  const arc = mk('path', { class: 'k-arc' });
  mk('circle', { class: 'k-body', cx: C, cy: C, r: 26 });
  const dot = mk('circle', { class: 'k-dot', r: 3.2 });
  const val = h('span', { class: 'k-val' });
  const dial = h('div', { class: 'dial', tabIndex: 0, role: 'slider', 'aria-label': label, 'aria-valuemin': min, 'aria-valuemax': max, style: { width: size + 'px', height: size + 'px' } }, svg);
  const el = h('div', { class: 'knob' + (off ? ' off' : '') }, dial, h('span', { class: 'k-lbl' }, label), val);
  let v = value;
  const zeroA = A0 + (A1 - A0) * ((Math.min(Math.max(origin ?? 0, min), max) - min) / (max - min));
  const draw = () => {
    const a = A0 + (A1 - A0) * (v - min) / (max - min);
    arc.setAttribute('d', a >= zeroA ? arcPath(zeroA, Math.max(a, zeroA + 0.01)) : arcPath(a, zeroA));
    const r = (a - 90) * Math.PI / 180;
    dot.setAttribute('cx', C + 17 * Math.cos(r)); dot.setAttribute('cy', C + 17 * Math.sin(r));
    dial.style.setProperty('--kr', a.toFixed(1) + 'deg'); // metal designs turn the knob cap
    val.textContent = fmt(v);
    dial.setAttribute('aria-valuenow', v); dial.setAttribute('aria-valuetext', val.textContent);
  };
  const setV = nv => { nv = +(Math.round(Math.min(max, Math.max(min, nv)) / step) * step).toFixed(4); if (nv !== v) { v = nv; draw(); onInput(v); } };
  dial.addEventListener('pointerdown', e => {
    dial.setPointerCapture(e.pointerId);
    const y0 = e.clientY, v0 = v;
    const mv = ev => setV(v0 + (y0 - ev.clientY) / 160 * (max - min) * (ev.shiftKey ? 0.2 : 1));
    dial.addEventListener('pointermove', mv);
    dial.addEventListener('pointerup', () => dial.removeEventListener('pointermove', mv), { once: true });
  });
  dial.addEventListener('wheel', e => { e.preventDefault(); setV(v - Math.sign(e.deltaY) * step * (e.shiftKey ? 1 : 5)); }, { passive: false });
  dial.addEventListener('keydown', e => {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (d) { e.preventDefault(); e.stopPropagation(); setV(v + d * step * (e.shiftKey ? 10 : 1)); }
  });
  dial.addEventListener('dblclick', () => setV(def));
  draw();
  el.set = nv => { v = nv; draw(); };
  el.setOff = o => el.classList.toggle('off', o);
  return el;
}

// ---------- rating widget ----------
export function ratingEl(t, cls = '') {
  const r = rating(t);
  if (set.rating === 'stars') {
    const box = h('span', { class: 'stars ' + cls, title: 'Rating' });
    for (let i = 1; i <= 5; i++) box.append(h('button', { class: 'star' + (i <= r ? ' on' : ''), 'aria-label': `${i} stars`, onclick: e => { e.stopPropagation(); rate(t, r === i ? 0 : i); } }, '★'));
    return box;
  }
  return h('button', { class: 'like ' + cls + (r >= 4 ? ' on' : ''), title: r >= 4 ? 'Unlike' : 'Like', 'aria-pressed': String(r >= 4), onclick: e => { e.stopPropagation(); rate(t, r >= 4 ? 0 : 5); } }, icon('thumbUp', 'sm'));
}

// ---------- track list (virtualised) ----------
export const ROW_H = 56;
let vlN = 0;
export function trackList(tracks, { ctx, numbered = 'index', playlist = null, sortable = false, az = false, sortBtn, inline = false } = {}) {
  const sel = new Set();
  let anchor = -1;
  const filtered = () => playlist && tracks.length !== plTracks(playlist).length; // rows no longer match the playlist
  const uid = 'vl' + (++vlN) + '-';
  const wrap = h('div', { class: 'vlist' + (inline ? ' inline' : ''), role: 'listbox', 'aria-label': 'Songs', 'aria-multiselectable': 'true' });
  const inner = h('div', { class: 'vinner', style: { height: tracks.length * ROW_H + 'px' } });
  wrap.append(inner);
  let first = -1, last = -1;
  const selected = () => [...sel].sort((a, b) => a - b).map(i => tracks[i]);
  // tag numbers only when they identify rows; clashing tags fall back to list position
  const showNo = (set.showTrackNo !== 'off' || numbered === 'track') && new Set(tracks.map(t => `${t.disc || 1}:${t.track}`)).size === tracks.length ? 'track' : 'index';

  const rowFor = (t, i) => {
    const isCur = t.path === engine?.track?.path;
    const no = showNo === 'track' && t.track ? t.track : i + 1;
    const num = isCur ? h('span', { class: 'eq-bars' }, h('i'), h('i'), h('i')) : h('span', { class: 'n' }, no);
    const r = h('div', {
      class: 'row' + (sel.has(i) ? ' sel' : '') + (isCur ? ' playing' : ''), style: { top: i * ROW_H + 'px' }, dataset: { i }, draggable: true, role: 'option', id: uid + i, 'aria-selected': String(sel.has(i)),
      ondblclick: () => playFrom(tracks, i, ctx),
      onclick: e => { if (e.target.closest('.num') && !e.shiftKey && !e.ctrlKey) return playFrom(tracks, i, ctx); select(i, e); },
      oncontextmenu: e => openMenu(e, i),
      ondragstart: e => {
        ensureSel(i);
        e.dataTransfer.setData('text/cadence-paths', JSON.stringify(selected().map(x => x.path)));
        e.dataTransfer.effectAllowed = 'copyMove';
        if (playlist && !filtered()) e.dataTransfer.setData('text/cadence-index', String(i));
      },
      ondragover: e => { if (playlist && e.dataTransfer.types.includes('text/cadence-index')) { e.preventDefault(); r.classList.add('drop-above'); } },
      ondragleave: () => r.classList.remove('drop-above'),
      ondrop: e => { r.classList.remove('drop-above'); if (playlist && !filtered()) movePlaylistItem(playlist, +e.dataTransfer.getData('text/cadence-index'), i); },
    },
      h('span', { class: 'num', title: 'Play' }, num, h('span', { class: 'pl' }, icon('play', 'sm'))),
      t.art ? h('img', { class: 'thumb', src: artUrl(t.art), loading: 'lazy', decoding: 'async', alt: '' }) : h('span', { class: 'thumb ph' }, icon(t.stream ? 'radio' : 'song', 'sm')),
      h('div', { class: 'main' }, h('div', { class: 'title' }, titleOf(t)), h('div', { class: 'artist' }, artistOf(t))),
      h('div', { class: 'album' }, t.album),
      h('div', { class: 'quality' + (isHiRes(t) ? ' hires' : ''), title: t.stream ? '' : fmtQuality(t) }, t.stream ? 'Stream' : fmtQualityShort(t)),
      h('div', { class: 'dur' }, t.stream ? 'LIVE' : fmtTime(t.duration)),
      ratingEl(t),
      h('button', { class: 'more', title: 'More', 'aria-label': 'More actions', onclick: e => { e.stopPropagation(); openMenu(e, i); } }, icon('more', 'sm')),
    );
    return r;
  };
  const scroller = () => inline ? wrap.closest('.scroll') : wrap;
  let built = new Map(); // index -> row element of the last draw
  const draw = force => {
    const sc = scroller();
    if (!sc) return;
    const off = topOf();
    const top = sc.scrollTop - off, hh = sc.clientHeight || 800;
    const a = Math.max(0, Math.floor(top / ROW_H) - 8), b = Math.min(tracks.length, Math.ceil((top + hh) / ROW_H) + 8);
    if (!force && a === first && b === last) return;
    first = a; last = b;
    // rows still in view are reused (fast scrolls and A-Z glides only build the ones coming in); a forced draw rebuilds all
    const keep = force ? new Map() : built, rows = [];
    built = new Map();
    for (let i = a; i < b; i++) { const r = keep.get(i) || rowFor(tracks[i], i); built.set(i, r); rows.push(r); }
    inner.replaceChildren(...rows);
  };
  const select = (i, e) => {
    if (e.shiftKey && anchor >= 0) { sel.clear(); for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) sel.add(k); }
    else if (e.ctrlKey) { sel.has(i) ? sel.delete(i) : sel.add(i); anchor = i; }
    else { sel.clear(); sel.add(i); anchor = i; }
    for (const r of inner.children) { r.classList.toggle('sel', sel.has(+r.dataset.i)); r.setAttribute('aria-selected', String(sel.has(+r.dataset.i))); } // no row rebuild
    if (i != null) wrap.setAttribute('aria-activedescendant', uid + i); // arrows move a cursor, not DOM focus
  };
  const ensureSel = i => { if (!sel.has(i)) select(i, {}); };
  const openMenu = (e, i) => { ensureSel(i); trackMenu(e, selected(), { playlist: filtered() ? null : playlist, rows: [...sel].sort((a, b) => a - b), index: i, list: tracks, ctx }); };
  const topOf = () => { if (!inline) return 0; const sc = scroller(); return sc ? wrap.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop : 0; };
  let sc0, ro;
  const stop = () => { sc0?.removeEventListener('scroll', onScroll); ro?.disconnect(); };
  const onScroll = () => wrap.isConnected ? draw() : stop();
  requestAnimationFrame(() => {
    sc0 = scroller();
    sc0?.addEventListener('scroll', onScroll, { passive: true });
    ro = new ResizeObserver(() => wrap.isConnected ? draw(true) : stop());
    ro.observe(sc0 || wrap);
    onTeardown(stop);
    draw(true);
    if (!inline && S.view?.name !== 'songs' && !wrap.closest('.view')?.querySelector('.tb-filter')?.value) {
      const ci = tracks.findIndex(t => t.path === engine?.track?.path);
      if (ci > 8) wrap.scrollTop = Math.max(0, ci * ROW_H - wrap.clientHeight / 2);
    }
  });
  wrap.tabIndex = 0;
  wrap.addEventListener('keydown', e => {
    if (e.key === 'Enter' && sel.size) playFrom(tracks, Math.min(...sel), ctx);
    if (e.key === 'a' && e.ctrlKey) { e.preventDefault(); tracks.forEach((_, i) => sel.add(i)); draw(true); }
    if (e.key === 'Delete' && playlist && sel.size) { if (filtered()) toast('Clear the filter to remove songs'); else removeFromPlaylist(playlist, [...sel]); }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && tracks.length) {
      e.preventDefault(); e.stopPropagation();
      const i = Math.max(0, Math.min(tracks.length - 1, (anchor < 0 ? -1 : anchor) + (e.key === 'ArrowDown' ? 1 : -1)));
      select(i, e.shiftKey ? { shiftKey: true } : {});
      const sc = scroller(), y = topOf() + i * ROW_H;
      if (y < sc.scrollTop) sc.scrollTop = y; else if (y + ROW_H > sc.scrollTop + sc.clientHeight) sc.scrollTop = y + ROW_H - sc.clientHeight;
    }
  });
  wrap.refresh = () => draw(true);
  wrap.scrollToIndex = i => { scroller().scrollTop = topOf() + i * ROW_H; };

  const sb = sortBtn || ((l) => h('span', {}, l));
  const head = h('div', { class: 'list-head' + (inline ? ' inline' : ''), role: 'row' }, h('span', { class: 'num' }, '#'), h('span'),
    sb('Title', 'title'), h('span', { class: 'c-album' }, sb('Album', 'album')), h('span', { class: 'c-q' }, 'Quality'), h('span', { class: 'r' }, sb('Time', 'duration')), h('span'), h('span'));
  if (inline) { inner.style.position = 'relative'; return h('div', { class: 'inline-list' }, head, wrap); }
  const box = h('div', { class: 'list-box' }, head, wrap);
  if (az) box.append(azRail(letter => { const i = tracks.findIndex(t => letterOf(titleOf(t)) === letter); if (i >= 0) glideTo(scroller(), topOf() + i * ROW_H); }, new Set(tracks.map(t => letterOf(titleOf(t))))));
  box.list = wrap;
  return box;
}
export function refreshLists() { document.querySelectorAll('.vlist').forEach(v => v.refresh?.()); }

export const letterOf = s => { const c = norm(s).trim()[0] || '#'; return /[a-z]/.test(c) ? c.toUpperCase() : /[0-9]/.test(c) ? '0' : '#'; };
// scroll that chases a moving target (the A–Z scrub): every frame it closes a share of the remaining distance, so the
// list glides and simply re-aims when the target changes mid-flight; a wheel turn hands control back at once
const glides = new WeakMap();
export function glideTo(el, top) {
  if (!el) return;
  top = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
  if (motionOff()) { el.scrollTop = top; return; }
  const cur = glides.get(el);
  if (cur) { cur.top = top; return; }
  const g = { top, last: performance.now() };
  glides.set(el, g);
  el.addEventListener('wheel', () => glides.delete(el), { once: true, passive: true });
  const step = now => {
    if (glides.get(el) !== g) return;
    const dt = Math.min(64, now - g.last), d = g.top - el.scrollTop;
    g.last = now;
    if (Math.abs(d) < 1) { el.scrollTop = g.top; glides.delete(el); return; }
    const move = d * (1 - Math.exp(-dt / 100)); // ~100 ms time constant: quick, never a jump
    el.scrollTop += Math.abs(move) < 1 ? Math.sign(d) : move;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function azRail(onPick, has) { // has: optional Set of letters with items; others render disabled
  const btns = ['0', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'].map(l => has && !has.has(l)
    ? h('button', { class: 'empty', 'aria-disabled': 'true', tabindex: '-1' }, l)
    : h('button', { onclick: e => { if (!e.detail) onPick(l); } }, l)); // pointer picks happen on press/drag below; keyboard Enter/Space still clicks
  const rail = h('div', { class: 'az', 'aria-label': 'Jump to letter' }, ...btns);
  // press and drag along the rail: the nearest letter under the pointer is picked as it changes
  let cur = null;
  const pickAt = y => {
    let best = null, d = Infinity;
    for (const b of btns) {
      if (b.classList.contains('empty')) continue;
      const r = b.getBoundingClientRect(), dd = Math.abs(y - (r.top + r.height / 2));
      if (dd < d) { d = dd; best = b; }
    }
    if (best && best !== cur) { cur?.classList.remove('on'); cur = best; cur.classList.add('on'); onPick(best.textContent, true); }
  };
  const end = () => { rail.classList.remove('scrub'); cur?.classList.remove('on'); cur = null; };
  rail.addEventListener('pointerdown', e => {
    if (e.button !== 0) return; // primary button (the OS already maps swapped mouse buttons), pen or touch
    e.preventDefault();
    rail.setPointerCapture(e.pointerId);
    rail.classList.add('scrub');
    pickAt(e.clientY);
  });
  rail.addEventListener('pointermove', e => { if (rail.hasPointerCapture(e.pointerId)) pickAt(e.clientY); });
  rail.addEventListener('pointerup', end);
  rail.addEventListener('pointercancel', end);
  return rail;
}

// ---------- card grid / category list ----------
export function grid(items, { round = false, sub = () => '', open, play, menu: onMenu, ph = 'album', asList = false }) {
  const row = asList
    ? (it, i) => h('div', { class: 'cat-row reveal', style: { '--i': String(i % 12) }, dataset: { letter: letterOf(it.name) }, onclick: e => { const a = e.currentTarget.querySelector('img, .ph'); if (a) heroFrom(a); open(it); }, oncontextmenu: e => onMenu?.(e, it) },
      it.art ? h('img', { src: artUrl(it.art), loading: 'lazy', decoding: 'async', alt: '', class: round ? 'round' : '' }) : h('span', { class: 'ph' + (round ? ' round' : '') }, icon(ph, 'sm')),
      h('div', { class: 'main' }, h('div', { class: 't1' }, it.name), h('div', { class: 't2' }, sub(it))),
      h('button', { class: 'icon-btn', title: 'Play', onclick: e => { e.stopPropagation(); play(it); } }, icon('play', 'sm')))
    : (it, i) => h('div', { class: 'card reveal' + (round ? ' round' : ''), style: { '--i': String(i % 12) }, dataset: { letter: letterOf(it.name) } },
      h('button', { class: 'cover', onclick: e => { heroFrom(e.currentTarget); open(it); }, oncontextmenu: e => onMenu?.(e, it), 'aria-label': it.name },
        it.art ? h('img', { src: artUrl(it.art), loading: 'lazy', decoding: 'async', alt: '' }) : h('div', { class: 'ph' }, icon(ph)),
        h('span', { class: 'play-fab', title: 'Play', role: 'button', onclick: e => { e.stopPropagation(); play(it); } }, icon('play'))),
      h('div', { class: 't1', title: it.name }, it.name), h('div', { class: 't2' }, sub(it)));
  // first screenful now; the rest streams in during idle time, so a page of hundreds of covers opens within one frame
  const FIRST = 36;
  const box = h('div', { class: asList ? 'cat-list' : 'grid' }, ...items.slice(0, FIRST).map(row));
  let i = FIRST;
  const more = dl => {
    if (!box.isConnected) return; // page left before it finished
    const frag = document.createDocumentFragment();
    do for (const end = Math.min(items.length, i + 12); i < end; i++) frag.append(row(items[i], i)); // always one batch, even on timeout
    while (i < items.length && dl.timeRemaining() > 3);
    box.append(frag);
    observeReveals(box);
    if (i < items.length) requestIdleCallback(more, { timeout: 100 });
  };
  if (items.length > FIRST) requestIdleCallback(more, { timeout: 100 });
  return box;
}
