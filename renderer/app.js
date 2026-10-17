// Boot, theming, OS integration, keyboard, phone import, backup.
import { Engine } from './engine.js';
import { h, $, icon, PATHS, debounce, fmtTime } from './util.js';
import {
  S, set, hooks, setEngine, engine, stat, saveSettings, saveStats, savePlaylists, saveState, flushAll, buildIndex, makeEntries,
  peekNext, commit, allowXf, skipFadeSec, titleOf, artistOf, base, DEFAULTS,
  cleanSettings, cleanPlaylists, cleanStats, cleanStreams, cleanBookmarks, cleanState,
} from './core.js';
import { toast, closeMenus, refreshLists } from './ui.js';
import { go, back, render, renderSidebar, scanPill } from './views.js';
import { buildPlayer, updatePlayer, updateButtons, drawSeek, sleepTick, toggleArtViz, openVizFull, toggleQueue, renderQueueDrawer, setMini, isMini, setVolume, toggleMute, P } from './player.js';
import { togglePlay, next, prev, setShuffle, cycleRepeat, playList, addBookmark, downloadArt, enqueueUI } from './actions.js';
import { eqBands, resampleGains, applyDevicePreset, audioInfo } from './eq.js';
import { applyFades } from './settings.js';

// ---------- hooks used by other modules ----------
hooks.render = render;
hooks.refresh = () => { updateButtons(); refreshLists(); };
hooks.queueChanged = () => { updateButtons(); renderQueueDrawer(); renderSidebar(); if (S.view?.name === 'queue') render(); };
hooks.toast = toast;

// ---------- theme ----------
// compact sidebar: the icon rail, chosen in the titlebar or forced by a narrow window
const narrow = matchMedia('(max-width: 1100px)');
let sideAnim = null;
function applySideCompact(animate) {
  const on = !!set.sideCompact || narrow.matches, app = $('#app'), b = document.body;
  if (b.classList.contains('side-compact') === on) return;
  const from = getComputedStyle(app).gridTemplateColumns;
  b.classList.toggle('side-compact', on);
  const t = $('#side-toggle'); t.setAttribute('aria-pressed', String(on)); t.title = on ? 'Expand sidebar' : 'Compact sidebar'; t.setAttribute('aria-label', t.title);
  const to = getComputedStyle(app).gridTemplateColumns;
  renderSidebar();
  sideAnim?.cancel(); // a quick second toggle restarts from where the column is now
  const a = sideAnim = animate && !b.classList.contains('anim-off') && !matchMedia('(prefers-reduced-motion: reduce)').matches
    && app.animate([{ gridTemplateColumns: from }, { gridTemplateColumns: to }], { duration: 420, easing: 'cubic-bezier(.32,.72,0,1)' });
  // the page is laid out once at its final width and only clipped while the column moves, so frames stay cheap
  const main = $('#main'), w = parseFloat(to.split(' ')[1]) - 4;
  if (a && w > 0) { main.style.setProperty('--freeze-w', w + 'px'); main.classList.add('freeze'); }
  const done = () => { if (sideAnim !== a) return; sideAnim = null; main.classList.remove('freeze'); }; // only the latest toggle unfreezes
  if (a) a.finished.then(() => { done(); renderSidebar(); }, done);
}
export function applyTheme() {
  const b = document.body, r = document.documentElement.style;
  const dark = set.theme === 'auto' ? matchMedia('(prefers-color-scheme: dark)').matches : set.theme !== 'light';
  b.dataset.theme = set.theme === 'auto' ? (dark ? 'dark' : 'light') : set.theme;
  b.classList.toggle('no-blur', !set.blur);
  b.classList.toggle('anim-off', set.animations === 'off');
  b.classList.toggle('anim-fast', set.animations === 'fast');
  b.classList.toggle('no-art-anim', !set.artAnim);
  r.setProperty('--bg-blur', set.blurAmount + 'px');
  r.setProperty('--bg-bright', (0.62 * set.bgIntensity).toFixed(3));
  r.setProperty('--bg-sat', set.bgSaturation);
  r.setProperty('--bg-grad', (set.bgGradient / 8).toFixed(3));
  const bg = getComputedStyle(b).getPropertyValue('--bg').trim();
  api.send('win:theme', { symbolColor: dark ? '#e8e8ee' : '#1b1b1f', bg });
  if (engine) import('./player.js').then(m => m.paintBackdrop());
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => set.theme === 'auto' && applyTheme());
export function applyAccentFromArt() {
  const img = P.art?.querySelector('img:not(.leave)');
  import('./player.js').then(m => m.applyAccent(img || null));
}
export function reindex() { buildIndex(S.all); render(); }

// ---------- library ----------
async function loadLibrary() {
  const lib = await api.invoke('library:get');
  S.folders = lib.folders;
  S.filePlaylists = lib.filePlaylists || [];
  S.artistImages = lib.artists || {};
  buildIndex(lib.tracks);
  // queue entries keep pointing at fresh track objects after a rescan
  for (const e of [...S.list, ...S.uq, ...(S.order || [])]) e.track = S.byPath.get(e.track.path) || e.track;
  renderSidebar();
}

// push every engine-relevant setting (and output device / exclusive mode) from `set` into the live engine
export async function syncEngine() {
  const o = engine.o;
  const outChanged = (set.device || '') !== (o.device || '') || (set.sampleRate || 0) !== (o.sampleRate || 0);
  Object.assign(o, {
    eqOn: set.eqOn, eqBands: eqBands(), preamp: set.preamp, toneOn: set.toneOn, bass: set.bass, treble: set.treble, bassFreq: set.bassFreq, trebleFreq: set.trebleFreq,
    limiter: set.limiter, reverb: set.reverb, rgMode: set.rgMode, mono: set.mono, width: set.width, balance: set.balance, volume: set.volume, gap: set.gap,
  });
  if (outChanged) await engine.setOutput(set.device, set.sampleRate);
  if (!!set.exclusive !== !!o.exclusive) { engine.xoFallback = false; await engine.setExclusive(!!set.exclusive); }
  engine.applyAll();
  applyFades(); applyTheme();
  engine.setReplayGain(set.rgMode, set.rgPreamp, set.noRgPreamp, set.preventClip);
}

// ---------- phone import ----------
export async function importPhone(manual) {
  const pa = await api.invoke('import:phone');
  if (!pa) { if (manual) toast('No phone export found in the import folder', true); return; }
  const byName = new Map(S.all.map(t => [base(t.path).toLowerCase(), t]));
  const parts = [];
  if (pa.data) {
    let pl = 0, miss = 0;
    for (const p of pa.data.playlists) {
      const paths = [];
      for (const f of p.files) { const t = byName.get(f.name.toLowerCase()); t ? paths.push(t.path) : miss++; }
      const existing = S.playlists.find(x => x.name === p.name);
      if (existing) { if (manual) existing.paths = paths; else continue; }
      else S.playlists.push({ id: 'p' + Math.random().toString(36).slice(2, 9), name: p.name, paths, created: p.created || Date.now() });
      pl++;
    }
    let st = 0;
    for (const f of pa.data.files) {
      const t = byName.get(f.name.toLowerCase());
      if (!t) continue;
      const s = stat(t.path);
      s.plays = Math.max(s.plays || 0, f.plays);
      s.last = Math.max(s.last || 0, f.lastPlayed);
      if (f.rating && !s.rating) s.rating = f.rating;
      if (f.added) s.added = f.added;
      st++;
    }
    savePlaylists(); saveStats();
    parts.push(`${pl} playlists`, `stats for ${st} songs`);
    if (miss) parts.push(`${miss} playlist entr${miss === 1 ? 'y' : 'ies'} not on this PC`);
  }
  if (pa.settings) {
    const c = pa.settings;
    Object.assign(set, {
      eqOn: c.eq.on, eqMode: c.eq.mode, preamp: c.eq.preamp, eqPreset: c.eq.mode === 'parametric' ? c.eq.preset + ' (phone)' : c.eq.preset,
      ...(c.eq.mode === 'parametric' ? { params: c.eq.bands } : { graphic: resampleGains(c.eq.bands, set.graphicBands) }),
      toneOn: c.tone.on, bass: c.tone.bass, treble: c.tone.treble, limiter: c.limiter,
      xfMode: c.crossfade.autoAdvance, crossfadeLen: c.crossfade.length, manualFade: c.crossfade.manual,
      shortFade: c.crossfade.shortManual, fadePause: c.crossfade.fadePlayPause, seekFade: c.crossfade.seekFade ?? 0.1,
      rgMode: c.replayGain.mode === 'off' ? 'off' : c.replayGain.source,
      vizDuration: c.visualization.presetDuration, vizSpectrumStyle: c.visualization.eqSpectrum || 'rounded',
      blur: c.background.blur, bgSaturation: c.background.saturation ?? 1.5, bgIntensity: c.background.intensity ?? 1,
      lyricsOffset: c.lyrics.offsetMs / 1000, countPlayedPct: c.library.countAsPlayedPct, ignoreShort: c.library.ignoreShorterThan ?? 6,
      rating: c.player.rating === 'thumbs' ? 'thumbs' : 'stars',
      ...(c.reverb ? { reverb: { ...set.reverb, ...c.reverb } } : {}),
      ...(c.queue ? { queueStart: c.queue.start, queueEnd: c.queue.end } : {}),
      ...(c.shuffle ? { shuffleMode: c.shuffle.mode, noReshuffle: c.shuffle.noReshuffle } : {}),
      ...(c.headset ? { pauseOnDisconnect: c.headset.pauseOnDisconnect, resumeOnConnect: c.headset.resumeOnConnect } : {}),
    });
    if (c.eq.mode === 'parametric') set.userPresets[c.eq.preset + ' (phone)'] = { mode: 'parametric', params: c.eq.bands, preamp: c.eq.preamp };
    saveSettings();
    await syncEngine();
    parts.push(`EQ “${c.eq.preset}” and audio settings`);
  }
  set.imported = true; saveSettings();
  render();
  toast('Imported from phone: ' + parts.join(', '));
}

// ---------- backup ----------
export async function exportBackup() {
  if (await api.invoke('backup:export', { settings: { ...set, lbToken: undefined }, playlists: S.playlists, stats: S.stats, streams: S.streams, bookmarks: S.bookmarks })) toast('Backup saved');
}
export async function importBackup() {
  const b = await api.invoke('backup:import').catch(() => null);
  const obj = v => v && typeof v === 'object' && !Array.isArray(v);
  if (!obj(b) || (b.settings != null && !obj(b.settings)) || !['settings', 'playlists', 'stats', 'streams', 'bookmarks'].some(k => k in b)
    || ['playlists', 'streams', 'bookmarks'].some(k => b[k] != null && !Array.isArray(b[k])) || (b.stats != null && !obj(b.stats))) return toast('That file is not a Cadence backup', true);
  const lbToken = set.lbToken;
  Object.assign(set, cleanSettings(b.settings), { lbToken });
  if (b.playlists) S.playlists = cleanPlaylists(b.playlists);
  if (b.stats) S.stats = cleanStats(b.stats);
  if (b.streams) S.streams = cleanStreams(b.streams);
  if (b.bookmarks) S.bookmarks = cleanBookmarks(b.bookmarks);
  saveSettings(); savePlaylists(); saveStats();
  api.send('store:set', 'streams', S.streams); api.send('store:set', 'bookmarks', S.bookmarks);
  await syncEngine(); render();
  toast('Backup restored');
}

// ---------- OS integration ----------
const silent = (() => {
  // 10 s of near-silent audio keeps Chromium's media session (Windows media overlay / media keys) active while Web Audio plays
  const n = 80000, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  const a = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
  a.loop = true; a.volume = 0.0001;
  return a;
})();
export function syncMediaKeys() {
  if (set.mediaKeys && engine.playing) silent.play().catch(() => {}); else silent.pause();
  if (set.mediaKeys) updateMediaSession(); else navigator.mediaSession.metadata = null;
}
// Media Session only accepts http/https/data/blob artwork, so covers are handed over as blob URLs
let artBlob = { art: null, url: null };
function artworkUrl(art) {
  if (artBlob.art !== art) {
    const prev = artBlob.url; // one shared request per cover; free the old one once Windows has had time to load it
    artBlob = { art, url: fetch(`app://covers/${art}.jpg`).then(r => r.blob()).then(b => URL.createObjectURL(b)) };
    prev?.then(u => setTimeout(() => URL.revokeObjectURL(u), 10000), () => {});
  }
  return artBlob.url;
}
async function updateMediaSession() {
  const t = engine.track;
  if (!t || !set.mediaKeys) return;
  const src = t.art ? await artworkUrl(t.art).catch(() => '') : '';
  if (t !== engine.track) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: P.streamTitle && t.stream ? P.streamTitle : titleOf(t), artist: artistOf(t), album: t.album || '',
    artwork: src ? [{ src, sizes: '1400x1400', type: 'image/jpeg' }] : [],
  });
}
function initMediaSession() {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => engine.setPlaying(true));
  ms.setActionHandler('pause', () => engine.setPlaying(false));
  ms.setActionHandler('stop', () => engine.setPlaying(false));
  ms.setActionHandler('nexttrack', next);
  ms.setActionHandler('previoustrack', prev);
  ms.setActionHandler('seekto', d => engine.seek(d.seekTime));
  ms.setActionHandler('seekforward', () => engine.seek(engine.position + 10));
  ms.setActionHandler('seekbackward', () => engine.seek(engine.position - 10));
}
const thumbIcons = {};
function thumbIcon(name) {
  if (!thumbIcons[name]) {
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const g = c.getContext('2d'); g.scale(32 / 256, 32 / 256); g.fillStyle = '#fff'; g.fill(new Path2D(PATHS[name]));
    thumbIcons[name] = c.toDataURL('image/png');
  }
  return thumbIcons[name];
}
let lastThumb = '';
function sendThumbar() {
  const key = String(!!engine?.playing);
  if (key === lastThumb) return;
  lastThumb = key;
  api.send('win:thumbar', [
    { tooltip: 'Previous', icon: thumbIcon('prev'), cmd: 'prev' },
    { tooltip: engine.playing ? 'Pause' : 'Play', icon: thumbIcon(engine.playing ? 'pause' : 'play'), cmd: 'toggle' },
    { tooltip: 'Next', icon: thumbIcon('next'), cmd: 'next' },
  ]);
}

// headphones / output device plugged or unplugged
let outputs = null, autoPaused = false;
async function watchDevices() {
  const list = async () => (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
  const sig = ds => ds.map(d => d.deviceId + d.label).sort().join('|');
  const defaultLabel = ds => ds.find(d => d.deviceId === 'default')?.label || '';
  outputs = await list();
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    const now = await list();
    if (sig(now) === sig(outputs)) return;
    const lost = set.device ? !now.some(d => d.deviceId === set.device) : defaultLabel(now) !== defaultLabel(outputs) && now.length < outputs.length;
    const gained = now.length > outputs.length;
    const added = now.filter(d => !outputs.some(o => o.deviceId === d.deviceId));
    outputs = now;
    if (lost && set.pauseOnDisconnect && engine.playing) { autoPaused = true; engine.setPlaying(false); toast('Output disconnected: paused'); }
    else if (gained && autoPaused && set.resumeOnConnect && !engine.playing && engine.track && (!set.device || added.some(d => d.deviceId === set.device))) { autoPaused = false; engine.setPlaying(true); toast('Output connected: resumed'); }
    if (gained || lost) applyDevicePreset();
    if (gained && set.exclusive && engine.xoFallback) { dispatchEvent(new Event('cadence:xo-reset')); engine.xoFallback = false; engine.setExclusive(true); } // 'restored' is announced when the device really opens
  });
}

// several open requests close together (one per file from Explorer) are merged into one list
let pending = null;
function openFiles(paths, playNow = true) {
  if (pending) { pending.paths.push(...paths); return; }
  pending = { paths: [...paths] };
  setTimeout(() => { const p = pending.paths; pending = null; openNow(p, playNow); }, 150);
}
async function openNow(paths, playNow) {
  const flat = [];
  for (const p of new Set(paths)) {
    if (!/\.(m3u8?|pls)$/i.test(p)) { flat.push(p); continue; }
    const r = await api.invoke('playlist:readFile', p).catch(() => null);
    if (r?.paths) flat.push(...r.paths.filter(x => typeof x === 'string'));
  }
  const info = await api.invoke('track:info', [...new Set(flat)]);
  const at = t => { const i = flat.indexOf(t.path); return i < 0 ? flat.indexOf(t.file) : i; };
  const tracks = [...info].sort((a, b) => at(a) - at(b)); // the first file of the batch plays first
  if (!tracks.length) return toast('No playable audio in what you opened', true);
  // files from a separate launch a moment after the last open join the list instead of replacing it
  const append = Date.now() - lastOpen < 3000 && S.list.length;
  lastOpen = Date.now();
  if (playNow && !append) playList(tracks, 0, { label: tracks.length === 1 ? titleOf(tracks[0]) : 'Opened files' });
  else enqueueUI(tracks);
}
let lastOpen = 0;

// ---------- keyboard ----------
addEventListener('keydown', e => {
  const t = e.target, typing = t.closest?.('input[type=text], input[type=search], input[type=password], select, textarea');
  const range = t.matches?.('input[type=range]'), ctl = t.closest?.('button, [role=switch], [role=option], [role=menuitem], [role=listbox], select, a[href], summary');
  if ($('.scrim')) return; // dialogs own the keyboard (see dialog() in ui.js)
  if (e.key === 'Escape') {
    closeMenus();
    if (document.querySelector('.drawer')) toggleQueue(false);
    else if (document.activeElement === $('#search')) { $('#search').value = ''; $('#search').blur(); if (S.view.name === 'search') back(); }
    return;
  }
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'f') { e.preventDefault(); if (isMini()) setMini(false); $('#search').focus(); $('#search').select(); return; }
  if (e.ctrlKey && e.key === ',') { e.preventDefault(); go('settings'); return; }
  if (e.ctrlKey && k === 'm') { e.preventDefault(); setMini(!isMini()); return; }
  if (e.ctrlKey && k === 'i') { e.preventDefault(); audioInfo(); return; }
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); back(); return; }
  if (typing || $('.menu') || (range && e.key.startsWith('Arrow') && !e.ctrlKey) || ((e.key === ' ' || e.key === 'Enter') && ctl)) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight' && e.ctrlKey) next();
  else if (e.key === 'ArrowLeft' && e.ctrlKey) prev();
  else if (e.key === 'ArrowRight' && !e.target.closest?.('.vlist, .dial')) engine.seek(engine.position + (e.shiftKey ? 30 : 5));
  else if (e.key === 'ArrowLeft' && !e.target.closest?.('.vlist, .dial')) engine.seek(engine.position - (e.shiftKey ? 30 : 5));
  else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.target.closest?.('.vlist, .dial, .menu')) { e.preventDefault(); setVolume(set.volume + (e.key === 'ArrowUp' ? 0.05 : -0.05)); }
  else if (e.ctrlKey || e.altKey || e.metaKey) return;
  else if (k === 'l') S.view?.name === 'lyrics' ? back() : go('lyrics');
  else if (k === 'p') S.view?.name === 'nowplaying' ? back() : go('nowplaying');
  else if (k === 'e') S.view?.name === 'eq' ? back() : go('eq');
  else if (k === 'q') toggleQueue();
  else if (k === 'v') toggleArtViz();
  else if (k === 'f') openVizFull();
  else if (k === 's') setShuffle(!S.shuffle);
  else if (k === 'r') cycleRepeat();
  else if (k === 'm') toggleMute();
  else if (k === 'b') addBookmark();
  else if (e.key === 'F11') api.send('win:fullscreen');
});
addEventListener('mouseup', e => { if (e.button === 3) back(); });
// a slider left focused after a drag would keep Space and the arrows to itself
addEventListener('pointerup', e => { if (e.target.matches?.('input[type=range]')) setTimeout(() => e.target.blur(), 0); });

// ---------- boot ----------
async function boot() {
  api.send('dec:reset');
  const raw = await api.invoke('store:get', 'settings');
  if (raw && typeof raw === 'object' && raw.crossfadeOn !== undefined) { raw.xfMode = raw.crossfadeOn ? 'all' : 'none'; delete raw.crossfadeOn; }
  Object.assign(set, cleanSettings(raw)); // typed and clamped; settings from 0.1 (string reverb) fall back to defaults
  S.stats = cleanStats(await api.invoke('store:get', 'stats'));
  S.playlists = cleanPlaylists(await api.invoke('store:get', 'playlists'));
  S.streams = cleanStreams(await api.invoke('store:get', 'streams'));
  S.bookmarks = cleanBookmarks(await api.invoke('store:get', 'bookmarks'));
  const state = set.resume ? cleanState(await api.invoke('store:get', 'state')) : null;
  applyTheme();
  if (api.beta) $('.brand').append(h('span', { class: 'brand-tag' }, 'Beta'));

  const eng = new Engine({
    sampleRate: set.sampleRate || 0, device: set.device, volume: set.volume, exclusive: !!set.exclusive,
    eqOn: set.eqOn, eqBands: eqBands(), preamp: set.preamp, toneOn: set.toneOn, bass: set.bass, treble: set.treble, bassFreq: set.bassFreq, trebleFreq: set.trebleFreq,
    balance: set.balance, width: set.width, mono: set.mono, reverb: set.reverb, limiter: set.limiter, gap: set.gap,
    crossfade: set.xfMode === 'none' ? 0 : set.crossfadeLen, skipFade: skipFadeSec(), fadePause: set.fadePause, seekFade: set.seekFade,
    rgMode: set.rgMode, rgPreamp: set.rgPreamp, noRgPreamp: set.noRgPreamp, preventClip: set.preventClip,
    tempo: set.tempo, semitones: set.semitones,
  });
  setEngine(eng);
  await eng.init();
  window.cadence = { engine: eng, S, set, playList, go, back, toggleQueue, toggleArtViz, setMini }; // devtools handle
  eng.allowXf = allowXf;
  eng.getNext = cur => S.sleep?.endOfTrack ? null : peekNext(cur, false);

  const nearEnd = (t, p) => p > t.duration - 1 ? 0 : p;
  let lastTrack = null;
  eng.addEventListener('track', e => {
    const { entry, auto } = e.detail;
    // remember where a long track was left
    if (lastTrack && lastTrack !== entry.track && set.perTrackProgress && lastTrack.duration >= set.longMin * 60) { stat(lastTrack.path).pos = auto ? 0 : nearEnd(lastTrack, eng.lastPos || 0); saveStats(); }
    lastTrack = entry.track;
    commit(entry);
    S.counted = false;
    P.streamTitle = null;
    updatePlayer();
    refreshLists();
    renderQueueDrawer();
    updateMediaSession();
    if (S.view?.name === 'nowplaying') render('swap');
    if (auto && S.sleep?.endOfTrack) { eng.setPlaying(false); S.sleep = null; toast('Sleep timer: stopped after the song'); }
    if (set.notifyTrack && !document.hasFocus()) api.send('notify', { title: titleOf(entry.track), body: [artistOf(entry.track), entry.track.album].filter(Boolean).join(' — '), art: entry.track.art });
    if (set.scrobble && set.lbToken && !entry.track.stream) api.invoke('scrobble:listenbrainz', set.lbToken, 'playing_now', entry.track).catch(() => {});
  });
  eng.addEventListener('state', () => {
    updateButtons(); sendThumbar(); // rows don't depend on play state (paused bars come from body.paused)
    navigator.mediaSession.playbackState = eng.playing ? 'playing' : 'paused';
    if (eng.playing) autoPaused = false;
    syncMediaKeys();
  });
  eng.addEventListener('ended', () => { if (lastTrack && set.perTrackProgress) { stat(lastTrack.path).pos = 0; saveStats(); } if (S.sleep?.endOfTrack) { S.sleep = null; toast('Sleep timer: stopped after the song'); } updateButtons(); });
  eng.addEventListener('error', e => toast(e.detail.message, true));
  // exclusive output failed (device busy, unplugged, refused every rate): shared mode for now, but keep the
  // preference — it is retried when an output device (re)appears and on the next launch
  // retried after 3 s, 10 s, 30 s, then at each track start, until the helper gives up for good
  let xoTry = 0, xoTimer = 0, xoGaveUp = false, xoToasted = false;
  const xoRetry = () => { clearTimeout(xoTimer); if (set.exclusive && eng.xoFallback && !xoGaveUp) { eng.xoFallback = false; eng.setExclusive(true); } };
  eng.addEventListener('xofail', e => {
    eng.xoFallback = true;
    clearTimeout(xoTimer);
    if (/keeps stopping/.test(e.detail.message || '')) {
      if (!xoGaveUp) toast('Exclusive output keeps failing: using shared mode. Turn Exclusive output off and on in Settings to try again.', true);
      xoGaveUp = true;
    } else {
      if (!xoToasted) toast(`Exclusive output unavailable: ${e.detail.message}. Playing in shared mode until it's back.`, true);
      xoToasted = true; // retries during the same outage stay quiet
      if (xoTry < 3) xoTimer = setTimeout(xoRetry, [3000, 10000, 30000][xoTry++]);
    }
    eng.setExclusive(false).then(() => { if (S.view?.name === 'settings') render(); });
  });
  addEventListener('cadence:xo-reset', () => { xoTry = 0; xoGaveUp = false; });
  eng.addEventListener('track', () => { if (eng.xoFallback && xoTry >= 3) xoRetry(); });
  // the helper opened the device (format reported): the outage is over
  eng.addEventListener('format', () => { if (xoToasted && set.exclusive) { xoToasted = false; toast('Exclusive output restored'); } });
  api.on('dec:meta', (id, title) => { if (eng.cur?.id === id) { P.streamTitle = title; updatePlayer(); updateMediaSession(); } });

  buildPlayer();
  initMediaSession();
  applyFades();
  await loadLibrary();

  // restore last session
  if (state?.list?.length || state?.uq?.length) {
    const ok = p => S.byPath.has(p) || /^https?:/.test(p);
    const mk = paths => makeEntries((paths || []).filter(ok).map(p => S.byPath.get(p) || { path: p, file: p, stream: true, title: p, artist: 'Internet radio', duration: 0 }));
    S.list = mk(state.list);
    S.uq = mk(state.uq);
    S.order = state.order ? state.order.map(i => S.list[i]).filter(Boolean) : null;
    if (S.order && S.order.length !== S.list.length) S.order = null;
    S.shuffle = !!state.shuffle; S.repeat = state.repeat || 'off'; S.ctx = state.ctx || {};
    S.fromQueue = false;
    // find the song that was playing by path, not by the saved index (missing files shift indices)
    let cur = state.cur ? S.list.find(e => e.track.path === state.cur) : null;
    if (!cur && state.list?.[state.li]) cur = S.list.find(e => e.track.path === state.list[state.li]);
    S.li = cur ? S.list.indexOf(cur) : Math.min(Math.max(0, state.li || 0), S.list.length - 1);
    const e = cur || S.list[S.li];
    if (e) eng.load(e, { start: e.track.path === state.cur ? state.pos || 0 : 0, play: false });
  }
  S.view = { name: 'songs' };
  render();
  updatePlayer();
  sendThumbar();
  watchDevices();

  $('#nav-back').append(icon('back', 'sm'));
  $('#nav-back').addEventListener('click', back);
  $('#side-toggle').append(icon('sidebar', 'sm'));
  $('#side-toggle').addEventListener('click', () => { set.sideCompact = !set.sideCompact; saveSettings(); applySideCompact(true); });
  narrow.addEventListener('change', () => applySideCompact(true));
  applySideCompact(false);
  $('.search-ic').append(icon('search', 'sm'));
  $('#search').addEventListener('input', debounce(e => {
    const q = e.target.value.trim();
    if (q) { if (S.view.name === 'search') { S.view.arg = q; render('stay'); } else go('search', q); }
    else if (S.view.name === 'search') back();
  }, 180));

  api.on('library:progress', p => {
    scanPill.style.display = p.phase === 'done' ? 'none' : '';
    scanPill.firstChild.textContent = p.phase === 'listing' ? 'Finding music…' : `Reading tags ${p.done}/${p.total}`;
    scanPill.querySelector('i').style.width = p.total ? (p.done / p.total * 100) + '%' : '8%';
  });
  let downloading = false;
  api.on('library:changed', async () => {
    const before = S.tracks.length;
    await loadLibrary();
    if (!['lyrics', 'eq', 'settings'].includes(S.view.name)) render();
    // first run with an empty profile: bring phone data over automatically
    if (!set.imported && S.tracks.length && !S.playlists.length && !Object.keys(S.stats).length) importPhone(false);
    else if (S.tracks.length !== before) toast(`Library updated: ${S.tracks.length} songs`);
    fetchArtistImages();
    if (set.downloadArt && !downloading) {
      const missing = S.albums.filter(a => !a.art).flatMap(a => a.tracks);
      if (missing.length) { downloading = true; downloadArt(missing, true).finally(() => { downloading = false; }); }
    }
  });
  fetchArtistImages();
  api.on('cmd', c => ({ prev, next, toggle: togglePlay })[c]?.());
  api.on('open-files', files => openFiles(files));
  const args = await api.invoke('app:args');
  if (args.length) openFiles(args);
  if (!set.imported && S.tracks.length && !S.playlists.length && !Object.keys(S.stats).length) importPhone(false);

  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => {
    if (e.dataTransfer.types.includes('text/cadence-paths') || e.dataTransfer.types.includes('text/q')) return;
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
    if (paths.length) openFiles(paths, !e.shiftKey);
  });

  // per-frame UI: seek bar, times, play counting, sleep timer, taskbar progress
  let lastSave = 0, lastSec = 0, lastTimeKey = '';
  // UI clock: a 250 ms timer (an always-on requestAnimationFrame loop keeps the GPU compositing 60 fps);
  // smooth rAF updates only while the seek bar is being dragged
  const frame = () => {
    const now = performance.now();
    // after the queue ends the last song stays on screen at its end, not 0:00
    const ended = !eng.track && S.ended && P.last;
    const t = eng.track || (ended ? P.last : null), pos = ended ? P.last.duration || 0 : eng.position, dur = t?.duration || 0;
    eng.lastPos = pos;
    const frac = P.dragFrac ?? (dur ? Math.min(1, pos / dur) : 0);
    if (!isMini()) drawSeek(frac);
    else P.miniSeek.firstChild.style.width = frac * 100 + '%';
    const shown = P.dragFrac != null ? P.dragFrac * dur : pos;
    // time labels change once a second: only touch the DOM when the displayed second (or mode) changes
    const key = `${Math.floor(shown)}|${Math.floor(dur)}|${set.remaining}|${!!t?.stream}`;
    if (key !== lastTimeKey) {
      lastTimeKey = key;
      P.elapsed.textContent = fmtTime(shown);
      P.total.textContent = t?.stream ? 'LIVE' : set.remaining ? '-' + fmtTime(dur - shown) : fmtTime(dur);
    }
    if (t && !S.counted && eng.playing && dur && pos >= dur * set.countPlayedPct / 100) {
      S.counted = true;
      const s = stat(t.path); s.plays = (s.plays || 0) + 1; s.last = Date.now(); saveStats();
      if (set.scrobble && set.lbToken) api.invoke('scrobble:listenbrainz', set.lbToken, 'single', t, Date.now() - pos * 1000).catch(() => {});
    }
    if (now - lastSec > 1000) {
      lastSec = now;
      api.send('win:progress', t && dur ? frac : -1, eng.playing ? 'normal' : 'paused');
      sleepTick();
      if (S.sleep) updateButtons();
      if (t && dur && eng.playing && set.mediaKeys) navigator.mediaSession.setPositionState?.({ duration: dur, position: Math.min(Math.max(0, pos), dur), playbackRate: eng.o.tempo || 1 });
    }
    if (now - lastSave > 5000) {
      lastSave = now;
      if (S.list.length || S.uq.length) saveState();
      if (t && set.perTrackProgress && dur >= set.longMin * 60 && eng.playing) { stat(t.path).pos = nearEnd(t, pos); saveStats(); }
    }
  };
  setInterval(frame, 250);
  const fitZoom = () => { if (innerWidth < 640) api.send('win:fitzoom', innerWidth); };
  addEventListener('resize', fitZoom); fitZoom();
  P.seek.addEventListener('pointerdown', () => { const drag = () => { frame(); if (P.dragFrac != null) requestAnimationFrame(drag); }; requestAnimationFrame(drag); });
  addEventListener('beforeunload', () => {
    const t = eng.track;
    if (t && set.perTrackProgress && t.duration >= set.longMin * 60) stat(t.path).pos = nearEnd(t, eng.position);
    flushAll();
  });
}
// artist photos are fetched in small batches in the background
let fetchingArtists = false;
export async function fetchArtistImages() {
  if (!set.artistImages || fetchingArtists) return;
  const missing = [...new Set([...S.artists, ...S.albumArtists].map(a => a.name))].filter(n => n !== 'Unknown artist' && !(n in S.artistImages));
  if (!missing.length) return;
  fetchingArtists = true;
  try {
    for (let i = 0; i < missing.length; i += 12) {
      S.artistImages = await api.invoke('art:artists', missing.slice(i, i + 12));
      buildIndex(S.all);
      if (['artists', 'albumArtists', 'artist', 'albumArtist'].includes(S.view?.name)) render();
    }
  } catch {} finally { fetchingArtists = false; }
}

boot().catch(err => {
  console.error(err);
  const reset = () => { api.invoke('store:get', 'settings').then(o => {
    const keep = {}; // EQ presets, device EQ, theme and accent survive a reset
    if (o && typeof o === 'object') for (const k of ['userPresets', 'userReverbs', 'deviceEq', 'theme', 'accent']) if (k in o) keep[k] = o[k];
    api.send('store:set', 'settings', { ...structuredClone(DEFAULTS), ...cleanSettings({ ...DEFAULTS, ...keep }) });
  }).catch(() => api.send('store:set', 'settings', structuredClone(DEFAULTS)));
  api.send('store:set', 'state', {}); setTimeout(() => location.reload(), 600); };
  document.body.append(h('div', { class: 'fatal', role: 'alert' },
    h('h2', {}, 'Cadence couldn’t start'), h('p', {}, 'Saved data may be damaged. Resetting settings keeps your library, playlists and statistics.'),
    h('button', { class: 'tb-btn primary', onclick: reset }, 'Reset settings and restart'), ' ', h('button', { class: 'tb-btn', onclick: () => location.reload() }, 'Try again'),
    h('pre', {}, String(err.stack || err))));
});
