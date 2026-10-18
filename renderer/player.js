// Player pane ("Player Screen"), seek bar, art transitions, visualizers, sleep timer, queue drawer, mini player.
import { h, $, icon, fmtTime, fmtLong, fmtQuality, isHiRes, artUrl, accentFrom } from './util.js';
import { S, set, engine, hooks, saveSettings, titleOf, artistOf, names, rating, removeFromList, moveInList } from './core.js';
import { menu, toast, ratingEl } from './ui.js';
import { togglePlay, next, prev, jumpCategory, setShuffle, cycleRepeat, rate, trackMenu, addBookmark, enqueueUI } from './actions.js';
import { go, back } from './views.js';
import { Viz } from './viz.js';
import { fade, spring } from './motion.js';
import { hasLocalLyrics } from './lyricsview.js';
import { audioInfo } from './eq.js';

export const P = {};

export function buildPlayer() {
  const pill = (name, title, onclick) => h('button', { class: 'pill-btn', title, 'aria-label': title, onclick }, icon(name));
  P.art = h('div', { class: 'np-art', title: 'Click: Now Playing view · Double-click: visualizer', onclick: e => { if (e.target.closest('.ov, canvas')) return; clearTimeout(P.artClick); P.artClick = setTimeout(() => S.view?.name === 'nowplaying' ? back() : go('nowplaying'), 230); }, ondblclick: () => { clearTimeout(P.artClick); openVizFull(); }, oncontextmenu: e => { if (engine.track) trackMenu(e, [engine.track], {}); } },
    h('div', { class: 'ph' }, icon('song')),
    P.rateBox = h('div', { class: 'ov l' }),
    h('div', { class: 'ov r' }, P.lyBtn = h('button', { class: 'ov-btn', title: 'Lyrics (L)', 'aria-label': 'Lyrics', onclick: () => S.view?.name === 'lyrics' ? back() : go('lyrics') }, icon('lyrics'))));
  P.title = h('div', { class: 'chip title' }, h('span', { class: 'mq' }, 'Nothing playing'));
  P.line2 = h('div', { class: 'chip line2', title: 'Go to artist', onclick: () => { const t = engine.track; if (t && !t.stream) go('artist', names(t.artist)[0]); } }, h('span', { class: 'mq' }, 'Pick something from your library'));
  P.meta = h('button', { class: 'chip meta', title: 'Audio info (Ctrl+I)', onclick: audioInfo });
  P.viz = pill('wave', 'Visualization (V)', toggleArtViz);
  P.timer = pill('timer', 'Sleep timer', e => sleepMenu(e));
  P.repeat = pill('repeat', 'Repeat (R)', cycleRepeat);
  P.shuffle = pill('shuffle', 'Shuffle (S)', () => setShuffle(!S.shuffle));
  P.play = h('button', { class: 't-btn l', title: 'Play/Pause (Space)', 'aria-label': 'Play or pause', onclick: () => togglePlay() }, icon('play'));
  P.prevCat = h('button', { class: 't-btn s', title: 'Previous album', 'aria-label': 'Previous album', onclick: () => jumpCategory(-1) }, icon('prevCat'));
  P.nextCat = h('button', { class: 't-btn s', title: 'Next album', 'aria-label': 'Next album', onclick: () => jumpCategory(1) }, icon('nextCat'));
  P.seek = buildSeek();
  P.elapsed = h('div', { class: 'chip', title: 'Elapsed' }, '0:00');
  P.total = h('button', { class: 'chip', title: 'Click to toggle remaining time', onclick: () => { set.remaining = !set.remaining; saveSettings(); } }, '0:00');
  P.ctx = h('button', { class: 'chip ctx', title: 'Show queue (Q)', onclick: () => toggleQueue() }, icon('queue', 'sm'), h('span'));
  P.volIc = h('button', { class: 'icon-btn', title: 'Mute (M)', 'aria-label': 'Mute', onclick: toggleMute }, icon('volume', 'sm'));
  P.vol = volumeSlider();
  P.eqBtn = h('button', { class: 'icon-btn', title: 'Equalizer (E)', 'aria-label': 'Equalizer', onclick: () => S.view?.name === 'eq' ? back() : go('eq') }, icon('eq', 'sm'));
  P.qBtn = h('button', { class: 'icon-btn', title: 'Queue (Q)', 'aria-label': 'Queue', onclick: () => toggleQueue() }, icon('queue', 'sm'));
  P.miniBtn = h('button', { class: 'icon-btn', title: 'Mini player (Ctrl+M)', 'aria-label': 'Mini player', onclick: () => setMini(true) }, icon('mini', 'sm'));
  P.fullBtn = h('button', { class: 'icon-btn', title: 'Full-screen visualizer (F)', 'aria-label': 'Full-screen visualizer', onclick: openVizFull }, icon('full', 'sm'));
  $('#player').replaceChildren(
    P.art,
    h('div', { class: 'chips' }, P.title, P.line2, P.meta),
    h('div', { class: 'np-row' }, h('div', { class: 'grp' }, P.viz, P.timer), h('div', { class: 'grp' }, P.repeat, P.shuffle)),
    h('div', { class: 'transport' }, P.prevCat,
      h('button', { class: 't-btn m', title: 'Previous (Ctrl+Left)', 'aria-label': 'Previous', onclick: prev }, icon('prev')),
      P.play,
      h('button', { class: 't-btn m', title: 'Next (Ctrl+Right)', 'aria-label': 'Next', onclick: next }, icon('next')),
      P.nextCat),
    h('div', { class: 'np-spacer' }),
    P.seek,
    h('div', { class: 'times' }, P.elapsed, P.ctx, P.total),
    h('div', { class: 'np-vol' }, P.volIc, P.vol, P.eqBtn, P.qBtn, P.miniBtn, P.fullBtn));
  // keep the art square but leave room for the controls on short windows
  new ResizeObserver(() => {
    const pane = $('#player'), avail = pane.clientHeight - 430;
    P.art.style.width = Math.max(150, Math.min(pane.clientWidth - 44, avail)) + 'px';
  }).observe($('#player'));
  buildMini();
  new ResizeObserver(() => { fitMarquee(P.title); fitMarquee(P.line2); }).observe(P.title.parentElement);
  engine.addEventListener('ended', () => { if (!engine.track && P.last) { S.ended = true; P.seekKey = null; P.elapsed.textContent = P.total.textContent = ''; updatePlayer(); } });
  document.addEventListener('cadence:volume', () => { P.vol.set(set.volume); updateVolIcon(); });
}

function volumeSlider() {
  const r = h('input', { type: 'range', class: 'range', min: 0, max: 1, step: 0.01, value: set.volume, 'aria-label': 'Volume' });
  const paint = () => r.style.setProperty('--p', r.value * 100 + '%');
  paint();
  r.addEventListener('input', () => setVolume(+r.value));
  r.addEventListener('wheel', e => { e.preventDefault(); setVolume(set.volume - Math.sign(e.deltaY) * 0.03); }, { passive: false });
  r.set = v => { r.value = v; paint(); };
  return r;
}
export function setVolume(v) {
  set.volume = Math.min(1, Math.max(0, v));
  engine.setVolume(set.volume); P.vol.set(set.volume); updateVolIcon(); saveSettings();
  document.dispatchEvent(new Event('cadence:volume-ui'));
}
function updateVolIcon() { P.volIc.replaceChildren(icon(set.volume ? 'volume' : 'mute', 'sm')); }
export function toggleMute() {
  if (set.volume) { set.lastVol = set.volume; setVolume(0); } else setVolume(set.lastVol || 0.8);
}

function buildSeek() {
  const canvas = h('canvas');
  const thumb = h('div', { class: 'thumb' });
  const tip = h('div', { class: 'hover-time' });
  const el = h('div', { class: 'seek', role: 'slider', 'aria-label': 'Seek', tabIndex: 0 }, h('div', { class: 'track' }, canvas), thumb, tip);
  const posAt = e => { const r = el.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  el.addEventListener('pointerdown', e => {
    const t = engine.track;
    if (!t || t.stream || !t.duration) return;
    el.setPointerCapture(e.pointerId);
    el.classList.add('drag');
    P.dragFrac = posAt(e);
    const mv = ev => { P.dragFrac = posAt(ev); };
    el.addEventListener('pointermove', mv);
    const end = () => { el.removeEventListener('pointermove', mv); el.classList.remove('drag'); P.dragFrac = null; el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', end); el.removeEventListener('lostpointercapture', end); };
    const up = ev => { const f = posAt(ev); end(); engine.seek(f * t.duration); };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  });
  el.addEventListener('pointermove', e => {
    const t = engine.track;
    if (!t?.duration) return;
    const f = posAt(e);
    tip.textContent = fmtTime(f * t.duration);
    tip.style.left = f * 100 + '%';
  });
  el.addEventListener('wheel', e => { if (engine.track) { e.preventDefault(); engine.seek(engine.position - Math.sign(e.deltaY) * 5); } }, { passive: false });
  el.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); engine.seek(engine.position + (e.key === 'ArrowRight' ? 5 : -5)); }
  });
  el.canvas = canvas; el.thumb = thumb;
  return el;
}
const accentRGB = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().split(/\s+/).join(',');
export function drawSeek(frac) {
  if (S.ended && !engine.track) frac = 1;
  const c = P.seek.canvas, dpr = devicePixelRatio, W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
  if (!W) return;
  // skip repaints that wouldn't change a single bar (a 4-minute song moves one bar every ~2 s)
  P.lastFrac = frac;
  const grow = P.wave ? Math.min(1, (performance.now() - (P.waveAt || 0)) / 520) : 0, k = 1 - (1 - grow) ** 3;
  seekAria(frac);
  const key = `${Math.floor(frac * W / (3 * dpr))}|${W}|${H}|${P.wave ? 1 : 0}|${k.toFixed(3)}|${document.documentElement.style.getPropertyValue('--accent')}|${document.documentElement.style.getPropertyValue('--seek-rest')}|${document.body.dataset.theme}`;
  if (key === P.seekKey) return;
  P.seekKey = key;
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  // a design may recolour the waveform (--seek-played / --seek-rest, "r g b") or paint it itself (P.seekPainter)
  const rs = getComputedStyle(document.documentElement), pl = rs.getPropertyValue('--seek-played').trim(), rt = rs.getPropertyValue('--seek-rest').trim();
  const peaks = P.wave, accent = pl ? pl.split(/\s+/).join(',') : accentRGB(), x = frac * W, rest = rt ? `rgb(${rt.split(/\s+/).join(',')})` : document.body.dataset.theme === 'light' ? 'rgba(0,0,0,0.26)' : 'rgba(255,255,255,0.22)';
  if (P.seekPainter) { P.seekPainter(g, W, H, dpr, peaks, x, k); P.seek.thumb.style.left = frac * 100 + '%'; return; }
  // bars rise out of a dotted baseline when the peaks arrive, so a track change never blinks the waveform away
  const n = Math.floor(W / (3 * dpr)), bw = 2 * dpr;
  for (let i = 0; i < n; i++) {
    const p = peaks?.length ? (peaks[Math.floor(i / n * peaks.length)] || 0) * k : 0;
    const hh = Math.max(2 * dpr, p * (H - 8 * dpr));
    const px = i * 3 * dpr;
    g.fillStyle = px < x ? `rgba(${accent},0.95)` : rest;
    g.fillRect(px, (H - hh) / 2, bw, hh);
  }
  P.seek.thumb.style.left = frac * 100 + '%';
}
// ~4 Hz cap for screen-reader chatter; a throttled value is flushed once the burst ends, so it never stays stale
function seekAria(frac) {
  const now = performance.now();
  clearTimeout(P.ariaTm);
  if (now - (P.ariaAt || 0) < 250) { P.ariaTm = setTimeout(() => seekAria(P.lastFrac), 260); return; }
  P.ariaAt = now;
  const s = P.seek, dur = engine.track?.duration;
  s.setAttribute('aria-valuemin', '0'); s.setAttribute('aria-valuemax', '100');
  s.setAttribute('aria-valuenow', Math.round(frac * 100));
  s.setAttribute('aria-valuetext', dur ? `${fmtTime(frac * dur)} of ${fmtTime(dur)}` : `${Math.round(frac * 100)}%`);
}

// ---------- art + accent ----------
export function setArt(t) {
  const prevImgs = P.art.querySelectorAll('img');
  P.art.classList.toggle('back', hooks.artDir === 'back');
  hooks.artDir = 'fwd';
  prevImgs.forEach(i => { i.classList.remove('enter'); i.classList.add('leave'); setTimeout(() => i.remove(), 450); });
  P.art.querySelector('.ph').style.display = t?.art ? 'none' : '';
  if (t?.art) {
    const img = h('img', { src: artUrl(t.art, true), class: 'enter', alt: '', crossOrigin: 'anonymous' });
    img.addEventListener('load', () => { if (engine.track === t) applyAccent(img); }, { once: true });
    P.art.insertBefore(img, P.art.querySelector('.ov'));
  } else applyAccent(null);
  paintBackdrop(t);
  if (P.miniArt) P.miniArt.src = t?.art ? artUrl(t.art) : '';
}
// The window backdrop is blurred once per track into a small bitmap and then just scaled by the compositor.
// (A live CSS blur over the whole window gets recomputed every time anything on screen changes.)
export function paintBackdrop(t = engine?.track) {
  const layers = document.querySelectorAll('.bg-layer');
  const on = [...layers].find(l => l.classList.contains('on')), off = [...layers].find(l => l !== on) || layers[0];
  if (!t?.art) { on?.classList.remove('on'); return; }
  const light = document.body.dataset.theme === 'light';
  const filter = `blur(${Math.max(1, set.blurAmount * 0.16)}px) saturate(${set.bgSaturation}) brightness(${light ? 1.25 : 0.62 * set.bgIntensity})`;
  const key = t.art + filter;
  if (on?.dataset.key === key) return; // already showing exactly this backdrop
  const show = url => {
    off.style.backgroundImage = `url("${url}")`;
    off.dataset.key = key;
    off.classList.add('on');
    if (on && on !== off) on.classList.remove('on');
  };
  const cached = backdrops.get(key);
  if (cached) return show(cached);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (engine.track && engine.track !== t) return;
    const c = document.createElement('canvas'), N = 256;
    c.width = c.height = N;
    const g = c.getContext('2d');
    g.filter = filter;
    g.drawImage(img, -N * 0.15, -N * 0.15, N * 1.3, N * 1.3);
    const url = c.toDataURL('image/jpeg', 0.92);
    backdrops.set(key, url);
    if (backdrops.size > 24) backdrops.delete(backdrops.keys().next().value); // small LRU-ish cap
    show(url);
  };
  img.src = artUrl(t.art);
}
const backdrops = new Map(); // art + look -> blurred JPEG data URL
export function applyAccent(img) {
  let rgb = null;
  if (img && set.accentFromArt) try { rgb = accentFrom(img); } catch {}
  if (!rgb) { const hex = String(set.accent).replace('#', ''); rgb = /^[0-9a-f]{6}$/i.test(hex) ? [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) : [124, 140, 255]; }
  document.documentElement.style.setProperty('--accent', rgb.join(' '));
  window.dispatchEvent(new CustomEvent('cadence:art', { detail: { img, rgb } })); // designs repaint from the new cover
}

const marquee = (chip, text) => {
  chip.querySelector('.mq').textContent = text;
  requestAnimationFrame(() => fitMarquee(chip));
};
// only text wider than the pane scrolls (the chip itself is sized to its text); re-run when the pane resizes
function fitMarquee(chip) {
  const span = chip.querySelector('.mq');
  const over = span.scrollWidth + 8 - chip.parentElement.clientWidth;
  const scroll = set.marquee && over > 6;
  if (scroll) { chip.style.setProperty('--mq', -over + 'px'); chip.style.setProperty('--mq-t', Math.max(6, over / 25) + 's'); }
  chip.classList.toggle('scrolling', scroll);
}
export function updatePlayer() {
  if (engine.track) P.last = engine.track, S.ended = false;
  const t = engine.track || (S.ended ? P.last : null); // after the queue ends keep showing the last song
  // cover, backdrop and waveform belong to the song: a refresh for the same song (radio title change) keeps them
  const changed = t !== P.shown || t?.art !== P.shownArt;
  P.shown = t; P.shownArt = t?.art;
  if (changed) setArt(t);
  // track change: title, artist and format rise out of a mask one after another, behind the cover
  const press = document.body.classList.contains('press'); // Cinema Press raises the title letter by letter itself
  if (changed && t && set.artAnim) [...(press ? [] : [P.title]), P.line2, P.meta].forEach((c, i) => fade(c, [
    { opacity: 0, transform: 'translateY(60%)', clipPath: 'inset(0 0 60% 0)' }, { opacity: 1, transform: 'none', clipPath: 'inset(0 0 0 0)' }], 620, { delay: 90 + i * 60, fill: 'backwards' }));
  marquee(P.title, t ? (P.streamTitle && t.stream ? P.streamTitle : titleOf(t)) : 'Nothing playing');
  if (press && changed && t && set.artAnim) window.dispatchEvent(new CustomEvent('press:title', { detail: { el: P.title.querySelector('.mq') } }));
  marquee(P.line2, t ? [artistOf(t), t.stream ? t.title : t.album].filter(Boolean).join(' — ') : 'Pick something from your library');
  P.meta.textContent = t ? (t.stream ? 'Live stream' : `${fmtQuality(t)} · ${fmtTime(t.duration)}`) : '';
  P.meta.classList.toggle('hires', !!t && isHiRes(t));
  P.meta.style.display = t ? '' : 'none';
  document.title = t ? `${titleOf(t)} – ${artistOf(t)} · Cadence` : 'Cadence';
  if (changed) P.wave = null, P.seekKey = null;
  if (changed && t && !t.stream) api.invoke('waveform', t).then(w => {
    if (engine.track !== t) return;
    P.wave = w; P.seekKey = null; P.waveAt = performance.now();
    const rise = () => { drawSeek(P.lastFrac ?? 0); if (P.wave === w && performance.now() - P.waveAt < 560) requestAnimationFrame(rise); };
    requestAnimationFrame(rise);
  });
  if (P.miniTitle) { P.miniTitle.textContent = t ? titleOf(t) : 'Nothing playing'; P.miniSub.textContent = t ? artistOf(t) : ''; }
  updateButtons();
}
export function updateButtons() {
  if (!P.play) return;
  const playing = !!engine?.playing;
  if (P.playShown !== playing) { // swap the glyph only on a real change, with a small spring so it morphs instead of blinking
    P.playShown = playing;
    P.play.replaceChildren(icon(playing ? 'pause' : 'play'));
    spring(P.play.firstChild, [{ opacity: 0, transform: 'scale(.55) rotate(-25deg)' }, { opacity: 1, transform: 'none' }], 'snappy');
  }
  if (P.miniPlay) P.miniPlay.replaceChildren(icon(playing ? 'pause' : 'play'));
  P.repeat.replaceChildren(icon(S.repeat === 'one' ? 'repeatOne' : 'repeat'));
  P.repeat.classList.toggle('on', S.repeat !== 'off');
  P.repeat.setAttribute('aria-pressed', String(S.repeat !== 'off'));
  P.shuffle.classList.toggle('on', S.shuffle);
  P.shuffle.setAttribute('aria-pressed', String(S.shuffle));
  const t = engine?.track;
  const long = t && t.duration >= set.longMin * 60;
  const seekPro = set.proButtons === 'seek' || long;
  P.prevCat.replaceChildren(icon(seekPro ? 'back10' : 'prevCat')); P.prevCat.title = seekPro ? 'Back 10 s' : 'Previous album'; P.prevCat.setAttribute('aria-label', P.prevCat.title);
  P.nextCat.replaceChildren(icon(seekPro ? 'fwd10' : 'nextCat')); P.nextCat.title = seekPro ? 'Forward 10 s' : 'Next album'; P.nextCat.setAttribute('aria-label', P.nextCat.title);
  // rating overlay on the cover
  P.rateBox.replaceChildren();
  if (t && !t.stream) {
    if (set.rating === 'stars') P.rateBox.append(ratingEl(t, 'ov-stars'));
    else {
      const r = rating(t);
      P.rateBox.append(
        h('button', { class: 'ov-btn' + (r >= 4 ? ' on' : ''), title: 'Like', 'aria-pressed': String(r >= 4), onclick: () => rate(t, r >= 4 ? 0 : 5) }, icon('thumbUp')),
        h('button', { class: 'ov-btn' + (r > 0 && r <= 2 ? ' on' : ''), title: 'Dislike', 'aria-pressed': String(r > 0 && r <= 2), onclick: () => rate(t, r > 0 && r <= 2 ? 0 : 1) }, icon('thumbDown')));
    }
  }
  P.lyBtn.classList.toggle('on', S.view?.name === 'lyrics');
  P.lyBtn.classList.toggle('has', hasLocalLyrics(t));
  P.eqBtn.classList.toggle('on', S.view?.name === 'eq');
  P.qBtn.classList.toggle('on', !!drawer);
  P.viz.classList.toggle('on', !!artViz);
  P.timer.classList.toggle('on', !!S.sleep);
  P.timer.querySelector('.badge')?.remove();
  if (S.sleep) P.timer.append(h('span', { class: 'badge' }, S.sleep.endOfTrack ? '♪' : Math.max(1, Math.ceil((S.sleep.at - Date.now()) / 60000))));
  const pos = S.fromQueue ? 'Queue' : S.li >= 0 ? `${S.li + 1} / ${S.list.length}` : '';
  P.ctx.lastChild.textContent = t ? [S.fromQueue ? null : S.ctx.label, pos, S.uq.length ? `+${S.uq.length} queued` : null].filter(Boolean).join(' · ') : 'Queue empty';
  document.body.classList.toggle('paused', !playing);
}

// ---------- sleep timer ----------
export function sleepMenu(e) {
  const setT = (min, endOfTrack) => { S.sleep = endOfTrack ? { endOfTrack: true } : { at: Date.now() + min * 60000, min }; updateButtons(); toast(endOfTrack ? 'Will stop after this song' : `Sleep timer: ${min} min`); };
  menu(e, [
    { header: S.sleep ? (S.sleep.endOfTrack ? 'Stops after this song' : `Stops in ${Math.ceil((S.sleep.at - Date.now()) / 60000)} min`) : 'Sleep timer' },
    ...[5, 10, 15, 30, 45, 60, 90, 120].map(m => ({ label: `${m} minutes`, run: () => setT(m) })),
    { label: 'End of current song', run: () => setT(0, true) },
    S.sleep && !S.sleep.endOfTrack ? { label: 'Add 10 minutes', icon: 'plus', run: () => { S.sleep.at += 600000; updateButtons(); } } : null,
    S.sleep ? '-' : null,
    S.sleep ? { label: 'Cancel timer', icon: 'close', run: () => { S.sleep = null; engine.setVolume(set.volume); updateButtons(); toast('Sleep timer off'); } } : null,
  ]);
}
export function sleepTick() {
  if (!S.sleep?.at) return;
  const left = S.sleep.at - Date.now();
  if (left <= 0) {
    engine.setPlaying(false);
    engine.setVolume(set.volume);
    S.sleep = null;
    updateButtons();
    toast('Sleep timer: paused');
  } else if (left < 15000) engine.setVolume(set.volume * left / 15000); // fade out over the last 15 s
}

// ---------- visualizers ----------
let artViz = null, fullViz = null;
export function toggleArtViz() {
  if (artViz) { artViz.stop(); artViz.canvas.remove(); artViz = null; updateButtons(); return; }
  const c = h('canvas', { class: 'viz', title: 'Click: next preset · Double-click: full screen' });
  P.art.insertBefore(c, P.art.querySelector('.ov'));
  artViz = new Viz(engine, c, { mode: set.vizMode, duration: set.vizDuration, hidden: set.vizHidden });
  artViz.start().catch(err => { toast('Visualizer failed: ' + err.message, true); toggleArtViz(); });
  c.addEventListener('click', () => artViz.next());
  updateButtons();
}
export function openVizFull() {
  if (fullViz) return;
  let canvas = h('canvas');
  const name = h('button', { class: 'name', title: 'Browse presets', onclick: () => presetBrowser() });
  const t = engine.track;
  let mode = set.vizMode;
  const likeBtn = h('button', { class: 'tb-btn', title: 'Like preset', onclick: () => {
    const n = fullViz.current; if (!n) return;
    set.vizLiked = set.vizLiked.includes(n) ? set.vizLiked.filter(x => x !== n) : [...set.vizLiked, n]; saveSettings(); syncLike();
  } }, icon('thumbUp', 'sm'));
  const hideBtn = h('button', { class: 'tb-btn', title: 'Hide this preset', onclick: () => {
    const n = fullViz.current; if (!n) return;
    set.vizHidden = [...new Set([...set.vizHidden, n])]; saveSettings(); fullViz.next(); toast('Preset hidden');
  } }, icon('thumbDown', 'sm'));
  const syncLike = () => likeBtn.classList.toggle('on', set.vizLiked.includes(fullViz?.current));
  const playBtn = h('button', { class: 't-btn m', 'aria-label': 'Play or pause', onclick: togglePlay }, icon(engine.playing ? 'pause' : 'play'));
  const ui = h('div', { class: 'viz-ui' },
    t?.art ? h('img', { src: artUrl(t.art), alt: '' }) : null,
    h('div', { class: 'viz-meta' }, h('div', { class: 't1' }, t ? titleOf(t) : 'Nothing playing'), h('div', { class: 't2' }, t ? `${artistOf(t)}${t.album ? ' — ' + t.album : ''}` : '')),
    h('div', { class: 'ctl' },
      h('button', { class: 't-btn s', 'aria-label': 'Previous', onclick: prev }, icon('prev')), playBtn,
      h('button', { class: 't-btn s', 'aria-label': 'Next', onclick: next }, icon('next'))));
  const top = h('div', { class: 'viz-top' },
    h('button', { class: 'tb-btn', title: 'Previous preset', onclick: () => fullViz.prev() }, icon('prev', 'sm')),
    h('button', { class: 'tb-btn', title: 'Next preset (N)', onclick: () => fullViz.next() }, icon('next', 'sm')),
    likeBtn, hideBtn,
    h('button', { class: 'tb-btn', onclick: () => { mode = mode === 'milk' ? 'bars' : 'milk'; set.vizMode = mode; saveSettings(); restart(); } }, 'Mode'),
    name,
    h('button', { class: 'tb-btn', title: 'Close (Esc)', onclick: close }, icon('close', 'sm')));
  const el = h('div', { class: 'viz-full' }, canvas, top, ui);
  el.style.setProperty('--faded', set.vizFadedOpacity);
  document.body.append(el);
  api.send('win:fullscreen', true);
  if (set.vizKeepAwake) api.send('power:keepAwake', true);
  let idleT;
  const wake = () => { el.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => el.classList.add('idle'), 2500); };
  el.addEventListener('pointermove', wake); wake();
  const onState = () => playBtn.replaceChildren(icon(engine.playing ? 'pause' : 'play'));
  engine.addEventListener('state', onState);
  const t1 = ui.querySelector('.t1'), t2 = ui.querySelector('.t2');
  const onTrack = () => {
    const t = engine.track;
    t1.textContent = t ? titleOf(t) : 'Nothing playing';
    t2.textContent = t ? `${artistOf(t)}${t.album ? ' — ' + t.album : ''}` : '';
    const img = ui.querySelector(':scope > img');
    if (t?.art) { if (img) img.src = artUrl(t.art); else ui.prepend(h('img', { src: artUrl(t.art), alt: '' })); }
    else img?.remove();
  };
  engine.addEventListener('track', onTrack);
  function restart() {
    fullViz?.stop();
    const fresh = h('canvas');
    canvas.replaceWith(fresh); canvas = fresh;
    canvas.addEventListener('click', () => fullViz.next());
    fullViz = new Viz(engine, canvas, { mode, duration: set.vizDuration, hidden: set.vizHidden, onPreset: n => { name.textContent = n; syncLike(); } });
    if (mode === 'bars') name.textContent = 'Spectrum';
    fullViz.start().catch(err => toast('Visualizer failed: ' + err.message, true));
  }
  function presetBrowser() {
    if (!fullViz?.lib) return;
    const q = h('input', { type: 'search', placeholder: `Search ${fullViz.lib.names.length} presets`, class: 'pb-search' });
    const list = h('div', { class: 'pb-list' });
    const draw = () => {
      const w = q.value.toLowerCase();
      const names = fullViz.lib.names.filter(n => !w || n.toLowerCase().includes(w)).sort((a, b) => set.vizLiked.includes(b) - set.vizLiked.includes(a)).slice(0, 300);
      list.replaceChildren(...names.map(n => h('button', { class: 'pb-row' + (n === fullViz.current ? ' cur' : '') + (set.vizHidden.includes(n) ? ' hidden' : ''), onclick: () => { fullViz.load(n); draw(); } }, set.vizLiked.includes(n) ? '♥ ' : '', n)));
    };
    q.addEventListener('input', draw);
    const panel = h('div', { class: 'pb-panel' }, h('div', { class: 'pb-h' }, q, h('button', { class: 'tb-btn', onclick: () => panel.remove() }, icon('close', 'sm'))), list);
    el.append(panel);
    draw(); q.focus();
  }
  function close() {
    fullViz?.stop(); fullViz = null;
    el.remove();
    engine.removeEventListener('state', onState);
    engine.removeEventListener('track', onTrack);
    api.send('win:fullscreen', false);
    api.send('power:keepAwake', false);
    removeEventListener('keydown', key, true);
  }
  const key = e => {
    if (e.target.closest?.('input')) return;
    if (e.key === 'Escape') { e.stopPropagation(); const pb = el.querySelector('.pb-panel'); pb ? pb.remove() : close(); }
    else if (e.key === 'n' || e.key === 'N') { e.stopPropagation(); fullViz.next(); }
  };
  addEventListener('keydown', key, true);
  restart();
}

// ---------- queue drawer: Now playing · Queue · Next from the list ----------
let drawer = null;
export function toggleQueue(force) {
  const open = force ?? !drawer;
  if (!open && drawer) { const d = drawer; drawer = null; d.classList.add('closing'); document.body.classList.remove('drawer-open'); setTimeout(() => d.remove(), 220); updateButtons(); return; }
  if (open && !drawer) {
    document.body.classList.add('drawer-open');
    drawer = h('div', { class: 'drawer', role: 'dialog', 'aria-label': 'Queue' });
    document.body.append(drawer);
    renderQueueDrawer();
    updateButtons();
  }
}
export function renderQueueDrawer() {
  if (!drawer) return;
  const list = h('div', { class: 'qlist' });
  const row = (e, { cur, played, onRemove, onPlay, drag }) => {
    const t = e.track;
    const r = h('div', {
      class: 'qrow' + (cur ? ' cur' : '') + (played ? ' played' : ''), draggable: !!drag,
      ondblclick: onPlay, oncontextmenu: ev => trackMenu(ev, [t], {}),
    }, h('span', { class: 'grip' }, drag ? icon('drag', 'sm') : cur ? h('span', { class: 'eq-bars' }, h('i'), h('i'), h('i')) : null),
      t.art ? h('img', { src: artUrl(t.art), loading: 'lazy', alt: '' }) : h('span', { class: 'thumb' }),
      h('div', { class: 'qmain' }, h('div', { class: 't1' }, titleOf(t)), h('div', { class: 't2' }, artistOf(t))),
      h('span', { class: 'd' }, t.stream ? 'LIVE' : fmtTime(t.duration)),
      onRemove ? h('button', { class: 'x', title: 'Remove', 'aria-label': 'Remove', onclick: onRemove }, icon('close', 'sm')) : h('span'));
    if (drag) {
      r.addEventListener('dragstart', ev => { ev.dataTransfer.setData('text/q', JSON.stringify(drag)); ev.dataTransfer.effectAllowed = 'move'; r.classList.add('dragging'); });
      r.addEventListener('dragend', () => r.classList.remove('dragging'));
      r.addEventListener('dragover', ev => { if (ev.dataTransfer.types.includes('text/q')) { ev.preventDefault(); r.classList.add('drop-above'); } });
      r.addEventListener('dragleave', () => r.classList.remove('drop-above'));
      r.addEventListener('drop', ev => {
        ev.preventDefault(); r.classList.remove('drop-above');
        const from = JSON.parse(ev.dataTransfer.getData('text/q'));
        if (from.sec !== drag.sec) return;
        if (drag.sec === 'uq') { const [m] = S.uq.splice(from.i, 1); S.uq.splice(from.i < drag.i ? drag.i - 1 : drag.i, 0, m); engine.invalidateNext(); }
        else moveInList(from.i, drag.i);
        hooks.queueChanged();
      });
    }
    return r;
  };
  const cur = engine.entry;
  const section = (title, sub) => h('div', { class: 'q-sec' }, h('span', {}, title), sub ? h('span', { class: 'sub' }, sub) : null);
  if (cur) list.append(section('Now playing'), row(cur, { cur: true }));
  if (S.uq.length) {
    list.append(section('Queue', `${S.uq.length} · then back to ${S.ctx.label || 'the list'}`));
    S.uq.forEach((e, i) => list.append(row(e, { drag: { sec: 'uq', i }, onPlay: () => engine.load(e, { fade: true }), onRemove: () => { S.uq.splice(i, 1); engine.invalidateNext(); hooks.queueChanged(); } })));
  }
  const start = S.fromQueue ? S.li + 1 : S.li + 1;
  const rest = S.list.slice(Math.max(0, start), start + 300);
  if (rest.length) {
    list.append(section(`Next from ${S.ctx.label || 'the list'}`, `${S.list.length - start} songs`));
    rest.forEach((e, k) => list.append(row(e, { drag: { sec: 'list', i: start + k }, onPlay: () => engine.load(e, { fade: true }), onRemove: () => { removeFromList(e); hooks.queueChanged(); } })));
  }
  if (!cur && !S.uq.length && !rest.length) list.append(h('div', { class: 'empty small' }, 'Nothing queued'));
  const remaining = S.uq.reduce((s, e) => s + (e.track.duration || 0), 0) + S.list.slice(start).reduce((s, e) => s + (e.track.duration || 0), 0);
  drawer.replaceChildren(
    h('div', { class: 'drawer-h' }, h('h2', {}, 'Queue'), h('span', { class: 'sub' }, fmtLong(remaining) + ' left'),
      h('button', { class: 'icon-btn', title: 'Clear queue', 'aria-label': 'Clear queue', onclick: () => { S.uq = []; engine.invalidateNext(); hooks.queueChanged(); } }, icon('trash', 'sm')),
      h('button', { class: 'icon-btn', title: 'Close (Q)', 'aria-label': 'Close', onclick: () => toggleQueue(false) }, icon('close', 'sm'))),
    list);
}

// ---------- mini player ----------
function buildMini() {
  P.miniArt = h('img', { alt: '' });
  P.miniTitle = h('div', { class: 't1' });
  P.miniSub = h('div', { class: 't2' });
  P.miniPlay = h('button', { class: 't-btn s', 'aria-label': 'Play or pause', onclick: togglePlay }, icon('play'));
  P.mini = h('div', { id: 'mini' }, P.miniArt, h('div', { class: 'mini-main' }, P.miniTitle, P.miniSub, P.miniSeek = h('div', { class: 'mini-seek' }, h('i'))),
    h('div', { class: 'mini-ctl' },
      h('button', { class: 'icon-btn', 'aria-label': 'Previous', onclick: prev }, icon('prev', 'sm')), P.miniPlay,
      h('button', { class: 'icon-btn', 'aria-label': 'Next', onclick: next }, icon('next', 'sm')),
      h('button', { class: 'icon-btn', title: 'Back to full player (Ctrl+M)', 'aria-label': 'Expand', onclick: () => setMini(false) }, icon('full', 'sm'))));
  document.body.append(P.mini);
}
export function setMini(on) {
  document.body.classList.toggle('mini', on);
  api.send('win:mini', on);
}
export const isMini = () => document.body.classList.contains('mini');
