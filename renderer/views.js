// Sidebar, navigation and library views.
import { h, $, icon, fmtTime, fmtLong, artUrl, splitNames, plural, fmtQualityShort, fmtQuality } from './util.js';
import { S, set, engine, hooks, smartList, plTracks as plTracksRaw, saveSettings, savePlaylists, dirOf, base, searchMatch, titleOf, artistOf, streamTrack, fileOf } from './core.js';
import { trackList, grid, azRail, letterOf, ROW_H, toast, menu, cta, observeReveals, dropdown } from './ui.js';
import { playList, enqueueUI, playlistMenu, newPlaylist, importPlaylists, addToPlaylist, addStream, playStream, openBookmark, trackMenu, downloadArt } from './actions.js';
import { lyricsView } from './lyricsview.js';
import { spring, fade, flip, motionOff } from './motion.js';
import { eqView } from './eq.js';
import { settingsView } from './settings.js';

export const CATS = [
  { id: 'songs', label: 'All Songs', icon: 'song', c: '#7d8ff0' },
  { id: 'folders', label: 'Folders', icon: 'folder', c: '#4f8fe8' },
  { id: 'hier', label: 'Folders Hierarchy', icon: 'hier', c: '#5b6ef0' },
  { id: 'albums', label: 'Albums', icon: 'album', c: '#5c5fc4' },
  { id: 'artists', label: 'Artists', icon: 'mic', c: '#6a6890' },
  { id: 'albumArtists', label: 'Album Artists', icon: 'artist', c: '#7a73a8' },
  { id: 'genres', label: 'Genres', icon: 'genre', c: '#80466e' },
  { id: 'years', label: 'Years', icon: 'calendar', c: '#3d98a8' },
  { id: 'composers', label: 'Composers', icon: 'pen', c: '#2f7d4f' },
  { id: 'playlists', label: 'Playlists', icon: 'playlist', c: '#8a5248' },
  { id: 'streams', label: 'Streams', icon: 'radio', c: '#4f9a6c' },
  { id: 'queue', label: 'Queue', icon: 'queue', c: '#7c7a3c' },
  { id: 'bookmarks', label: 'Bookmarks', icon: 'bookmark', c: '#4f6fe0' },
  { id: 'mostPlayed', label: 'Most Played', icon: 'top', c: '#a988d0' },
  { id: 'topRated', label: 'Top Rated', icon: 'thumbUp', c: '#4f7389' },
  { id: 'lowRated', label: 'Low Rated', icon: 'thumbDown', c: '#5d5b5b' },
  { id: 'recentlyPlayed', label: 'Recently Played', icon: 'recent', c: '#4e4cab' },
  { id: 'recentlyAdded', label: 'Recently Added', icon: 'plus', c: '#3f6b45' },
  { id: 'long', label: 'Long', icon: 'long', c: '#5a3fb0' },
];
const LIB = ['songs', 'folders', 'hier', 'albums', 'artists', 'albumArtists', 'genres', 'years', 'composers', 'playlists', 'streams'];
const SMART = ['queue', 'bookmarks', 'mostPlayed', 'topRated', 'lowRated', 'recentlyPlayed', 'recentlyAdded', 'long'];
// a bad store (wrong-typed or half-missing data) must not take rendering down
const arr = a => Array.isArray(a) ? a : [];
const plTracks = p => arr(p?.paths).length ? plTracksRaw({ ...p, paths: p.paths.filter(x => typeof x === 'string') }) : [];
const pls = () => arr(S.playlists).filter(p => p && typeof p === 'object');
export const catOf = id => CATS.find(c => c.id === id);
export const catIcon = (id, size) => { const c = catOf(id); return h('span', { class: 'cat', style: { '--c': c.c, ...(size ? { width: size + 'px', height: size + 'px' } : {}) } }, icon(c.icon)); };

// ---------- navigation ----------
export function go(name, arg, { replace = false } = {}) {
  if (name === 'hier' && !arg && arr(S.folders).length === 1) arg = S.folders[0];
  if (S.view && !replace && S.view.name === name && S.view.arg === arg) return; // already here: picking it again must not reload the page
  if (S.view && !replace) S.nav.push(S.view);
  if (S.nav.length > 60) S.nav.shift();
  S.view = { name, arg };
  render('nav');
}
export function back() { const v = S.nav.pop(); if (v) { S.view = v; render('back'); } }

let teardown = [];
export const onTeardown = fn => teardown.push(fn);
// mode: 'nav' (slide forward) | 'back' (slide back) | 'swap' (cross-fade, same page) | 'stay' (in-place update, no animation).
// Default: 'stay' when the page is unchanged, so data updates never look like a reload.
// Pages animate as live elements with springs (compositor-only transform/opacity): the new page is clickable at once,
// the old one fades out underneath with input disabled, and a click mid-motion just starts the next motion.
let lastKey = null, hero = null;
export function render(mode) {
  const key = S.view.name + '|' + S.view.arg;
  if (typeof mode !== 'string') mode = key === lastKey ? 'stay' : 'nav';
  lastKey = key;
  paint(mode);
}
// run a whole-window change (theme) as a quick cross-fade
export const crossfade = fn => (document.startViewTransition && !motionOff() ? document.startViewTransition(fn) : fn());
// a cover the user clicked morphs into the next page's header art
export function heroFrom(el) { hero = motionOff() ? null : { el, rect: el.getBoundingClientRect() }; }

// current drawn opacity/transform (including running animations), so a page can leave from wherever it is
function freeze(el) {
  const cs = getComputedStyle(el), f = { opacity: cs.opacity, transform: cs.transform };
  el.getAnimations().forEach(a => a.cancel());
  return f;
}
function leave(prev, mode) {
  const from = freeze(prev);
  prev.classList.add('leaving'); prev.inert = true;
  const x = mode === 'back' ? 1 : mode === 'nav' ? -1 : 0;
  const a = fade(prev, [from, { opacity: 0, transform: `translateX(${x * 22}px) scale(${x ? 0.985 : 1})` }], mode === 'swap' ? 140 : 210, { fill: 'forwards' });
  if (a) a.finished.then(() => prev.remove(), () => prev.remove()); else prev.remove();
}
function enter(el, mode, h0) {
  const art = h0 && el.querySelector('.view-head .art');
  if (art) {
    h0.el.style.visibility = 'hidden'; // the card's cover becomes the header art
    art.style.position = 'relative'; art.style.zIndex = '5';
    const a = flip(art, h0.rect, 'glide');
    const done = () => { art.style.zIndex = ''; art.style.position = ''; };
    if (a) a.finished.then(done, done); else done();
    fade(el, [{ opacity: 0 }, { opacity: 1 }], 220);
    return;
  }
  const x = mode === 'back' ? -1 : 1;
  spring(el, mode === 'swap'
    ? [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }]
    : [{ opacity: 0, transform: `translateX(${x * 42}px)` }, { opacity: 1, transform: 'none' }], 'smooth');
}

function paint(mode) {
  teardown.forEach(f => f()); teardown = [];
  const { name, arg } = S.view;
  const scrollKey = name + '|' + arg;
  const el = (VIEWS[name] || VIEWS.songs)(arg);
  const main = $('#main');
  const animate = mode !== 'stay' && !motionOff();
  const h0 = hero; hero = null;
  // entrances are driven from here, never by CSS (which would replay on every re-render)
  el.classList.add('stay');
  el.querySelectorAll('.reveal').forEach(n => n.classList.add('in'));
  main.querySelectorAll(':scope > .leaving').forEach(n => n.remove()); // at most one page fading out
  const prev = main.querySelector(':scope > .view');
  main.prepend(el);
  if (prev) { if (animate) leave(prev, mode); else prev.remove(); }
  if (S.view.scroll && S.view.scrollKey === scrollKey) { const sc = el.querySelector('.scroll, .vlist'); if (sc) sc.scrollTop = S.view.scroll; }
  // items below the fold keep their scroll-in reveal (hidden while off-screen, so nothing visibly flickers)
  if (animate) {
    el.querySelectorAll('.reveal').forEach(n => { const r = n.getBoundingClientRect(); if (r.top > innerHeight || r.bottom < 0) n.classList.remove('in'); });
    enter(el, mode, h0);
  }
  observeReveals(el);
  el.addEventListener('scroll', e => { if (e.target.matches?.('.scroll, .vlist')) { S.view.scroll = e.target.scrollTop; S.view.scrollKey = scrollKey; } }, { capture: true, passive: true });
  $('#nav-back').disabled = !S.nav.length;
  renderSidebar();
  hooks.refresh();
}

// ---------- sidebar ----------
export const scanPill = h('div', { class: 'scan-pill', style: { display: 'none' } }, h('span', {}, 'Scanning'), h('span', { class: 'bar' }, h('i', { style: { width: '0%' } })));
export const plArt = p => { for (const x of arr(p?.paths)) { const t = S.byPath.get(x); if (t?.art) return t.art; } return null; };
// one persistent highlight that springs between items (from wherever it is drawn, so it retargets mid-glide)
const pill = h('i', { class: 'side-pill', 'aria-hidden': 'true' });
function placePill(sb, from) {
  const act = sb.querySelector('.side-item.active');
  sb.prepend(pill);
  if (!act) { pill.style.opacity = '0'; return; }
  Object.assign(pill.style, { opacity: '', top: act.offsetTop + 'px', left: act.offsetLeft + 'px', width: act.offsetWidth + 'px', height: act.offsetHeight + 'px' });
  if (from) flip(pill, from, 'glide');
}
// any change in the sidebar's size (window resize, zoom, rail toggle) re-seats the highlight on the active item
let pillWatch = null;
export function renderSidebar() {
  const sb = $('#sidebar');
  if (!pillWatch) (pillWatch = new ResizeObserver(() => { if (pill.isConnected && pill.style.opacity !== '0') placePill(sb, null); })).observe(sb);
  const from = pill.isConnected && pill.style.opacity !== '0' ? pill.getBoundingClientRect() : null;
  const counts = {
    songs: arr(S.tracks).length, albums: arr(S.albums).length, artists: arr(S.artists).length, albumArtists: arr(S.albumArtists).length, genres: arr(S.genres).length,
    years: arr(S.years).length, composers: arr(S.composers).length, playlists: pls().length + arr(S.filePlaylists).length, folders: S.dirs?.size || 0,
    queue: arr(S.uq).length, streams: arr(S.streams).length, bookmarks: arr(S.bookmarks).length,
  };
  const item = id => {
    const c = catOf(id);
    return h('button', { class: 'side-item' + (S.view?.name === id ? ' active' : ''), onclick: () => go(id), title: c.label,
      oncontextmenu: e => menu(e, [{ label: `Hide “${c.label}”`, icon: 'close', run: () => { set.hiddenCats = [...arr(set.hiddenCats), id]; saveSettings(); renderSidebar(); toast(`${c.label} hidden. Restore it in Settings → Lists.`); } }]) },
      catIcon(id), h('span', { class: 'lbl' }, c.label), counts[id] != null ? h('span', { class: 'count' }, counts[id] || '') : null);
  };
  const section = (key, title, items, extra) => {
    const collapsed = !!set.sideCollapsed?.[key];
    return [h('div', { class: 'side-h' }, h('button', { class: 'side-h-btn', 'aria-expanded': String(!collapsed), onclick: () => { (set.sideCollapsed ||= {})[key] = !collapsed; saveSettings(); renderSidebar(); } }, icon(collapsed ? 'right' : 'down', 'xs'), title), extra || null),
      ...(collapsed ? [] : items)];
  };
  sb.replaceChildren(
    ...section('lib', 'Library', LIB.filter(id => !arr(set.hiddenCats).includes(id)).map(item)),
    ...section('smart', 'Smart lists', SMART.filter(id => !arr(set.hiddenCats).includes(id)).map(item)),
    ...section('pl', 'Playlists', pls().map(p => h('button', {
      class: 'side-item' + (S.view?.name === 'playlist' && S.view.arg === p.id ? ' active' : ''), onclick: () => go('playlist', p.id), title: p.name,
      oncontextmenu: e => playlistMenu(e, p),
      ondragover: e => { if (e.dataTransfer.types.includes('text/cadence-paths')) { e.preventDefault(); e.currentTarget.classList.add('drop'); } },
      ondragleave: e => e.currentTarget.classList.remove('drop'),
      ondrop: e => { e.currentTarget.classList.remove('drop'); const paths = JSON.parse(e.dataTransfer.getData('text/cadence-paths') || '[]'); addToPlaylist(p, paths.map(x => S.byPath.get(x)).filter(Boolean)); },
    }, plArt(p) ? h('img', { class: 'thumb', src: artUrl(plArt(p)), loading: 'lazy', alt: '' }) : h('span', { class: 'cat', style: { '--c': '#8a5248', width: '28px', height: '28px' } }, icon('playlist', 'sm')),
      h('span', { class: 'lbl' }, String(p.name ?? '')), h('span', { class: 'count' }, arr(p.paths).length))),
      h('button', { class: 'side-add', title: 'New playlist', 'aria-label': 'New playlist', onclick: () => newPlaylist() }, icon('plus', 'sm'))),
    h('div', { class: 'side-sep' }),
    h('button', { class: 'side-item' + (S.view?.name === 'eq' ? ' active' : ''), onclick: () => go('eq'), title: 'Equalizer' }, h('span', { class: 'cat', style: { '--c': '#d97b3c' } }, icon('eq')), h('span', { class: 'lbl' }, 'Equalizer')),
    h('button', { class: 'side-item' + (S.view?.name === 'settings' ? ' active' : ''), onclick: () => go('settings'), title: 'Settings' }, h('span', { class: 'cat', style: { '--c': '#8b8b94' } }, icon('settings')), h('span', { class: 'lbl' }, 'Settings')),
    scanPill,
  );
  placePill(sb, from);
}

// ---------- building blocks ----------
function viewHead({ cat, art, round, kicker, title, sub }) {
  // a soft wash of the collection's own cover sits behind the header (static, one small image)
  return h('div', { class: 'view-head' + (art ? ' washed' : ''), style: art ? { '--head-art': `url("${artUrl(art)}")` } : null },
    cat ? catIcon(cat, 72) : art !== undefined ? (art ? h('img', { class: 'art' + (round ? ' round' : ''), src: artUrl(art, true), alt: '' }) : h('div', { class: 'art ph' + (round ? ' round' : '') }, icon(round ? 'artist' : 'album', 'lg'))) : null,
    h('div', { class: 'view-title' }, kicker ? h('div', { class: 'kicker' }, kicker) : null, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null));
}
// header buttons: shuffle, play, filter (search in list), queue, plus extras
function toolbar(tracks, ctx, { extra = [], onFilter } = {}) {
  const filter = onFilter ? h('input', { type: 'search', class: 'tb-filter', placeholder: 'Filter…', 'aria-label': 'Filter this list', oninput: e => onFilter(e.target.value) }) : null;
  if (!tracks().length) return h('div', { class: 'toolbar' }, ...extra);
  return h('div', { class: 'toolbar' },
    cta('Play', 'play', () => playList(tracks(), 0, ctx), 'primary'),
    cta('Shuffle', 'shuffle', () => playList(tracks(), -1, ctx, { shuffle: true })),
    onFilter ? h('button', { class: 'tb-btn', title: 'Filter', 'aria-label': 'Filter', onclick: e => { filter.classList.toggle('open'); if (filter.classList.contains('open')) filter.focus(); else { filter.value = ''; onFilter(''); } } }, icon('search')) : null,
    filter,
    h('button', { class: 'tb-btn', title: 'Add all to queue', onclick: () => enqueueUI(tracks()) }, icon('queue'), 'Queue'),
    ...extra);
}
export const songsN = n => plural(n, 'song');
const countLine = tracks => `${songsN(tracks.length)} · ${fmtLong(tracks.reduce((s, t) => s + (t.duration || 0), 0))}`;
function emptyLib() {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-art' }, icon('song', 'xl')), h('h2', {}, 'Your library is empty'), h('div', {}, 'Add a music folder to get started. Cadence watches it for new music.'),
    cta('Add music folder', 'arrowUpRight', () => go('settings'), 'accent'));
}
function emptyBox(title, text, action) { return h('div', { class: 'empty' }, h('h2', {}, title), text ? h('div', {}, text) : null, action || null); }

// a track-list view with header, toolbar, live filter
function listView(head, getTracks, ctx, opts = {}) {
  let tracks = getTracks();
  const box = h('div', { class: 'list-slot' });
  const draw = q => {
    const shown = q ? tracks.filter(t => searchMatch(q)(`${titleOf(t)} ${t.artist} ${t.album}`)) : tracks;
    box.replaceChildren(shown.length ? trackList(shown, { ctx, ...opts }) : h('div', { class: 'scroll' }, emptyBox(q ? 'No matches' : 'Nothing here yet', q ? '' : opts.emptyText)));
  };
  draw('');
  return h('section', { class: 'view' }, viewHead(head), toolbar(() => tracks, ctx, { extra: opts.extra, onFilter: draw }), box);
}
function gridView(cat, title, items, opts) {
  const asList = set.grid[cat] === false;
  const scroll = h('div', { class: 'scroll' });
  const draw = q => {
    const shown = q ? items.filter(i => searchMatch(q)(i.name + ' ' + (opts.sub?.(i) || ''))) : items;
    scroll.replaceChildren(shown.length ? grid(shown, { ...opts, asList, menu: (e, it) => trackMenu(e, it.tracks, {}) }) : (items.length ? emptyBox('No matches') : opts.empty || emptyLib()), ...(opts.after || []));
    observeReveals(scroll); // filtering rebuilds the cards after render() observed the first set
  };
  draw('');
  const viewBtn = h('button', { class: 'tb-btn', title: asList ? 'Grid view' : 'List view', onclick: () => { set.grid[cat] = asList; saveSettings(); render('swap'); } }, icon(asList ? 'grid' : 'lyrics'));
  const v = h('section', { class: 'view' }, viewHead({ cat, title, sub: plural(items.length, 'item') }),
    toolbar(() => items.flatMap(i => i.tracks), { label: title, view: { name: cat } }, { onFilter: draw, extra: [h('span', { class: 'tb-spacer' }), ...(opts.extra || []), viewBtn] }), scroll);
  if (opts.az && items.length > 20) v.append(azRail((l, drag) => scroll.querySelector(`[data-letter="${l}"]`)?.scrollIntoView({ block: 'start', behavior: drag ? 'auto' : 'smooth' }),
    new Set(items.map(i => letterOf(i.name)))));
  return v;
}
export function sortedSongs() {
  const { key, dir } = set.songSort;
  const st = t => S.stats[t.path] || {};
  const val = { title: t => titleOf(t), artist: t => t.artist, album: t => t.album, duration: t => t.duration, added: t => st(t).added || t.added, year: t => t.year, plays: t => st(t).plays || 0, rating: t => st(t).rating || 0, path: t => t.path }[key] || (t => t.title);
  return [...S.tracks].sort((a, b) => {
    const x = val(a) ?? '', y = val(b) ?? '';
    return dir * (typeof x === 'string' ? x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true }) : x - y);
  });
}
function sortBtn(label, key) {
  const s = set.songSort;
  return h('button', { class: s.key === key ? 'sorted' : '', onclick: () => { set.songSort = { key, dir: s.key === key ? -s.dir : 1 }; saveSettings(); render('swap'); } }, label + (s.key === key ? (s.dir > 0 ? ' ↑' : ' ↓') : ''));
}
const noSep = d => d.replace(/[\\/]+$/, '') || d; // a drive root (D:\\) keeps a trailing separator that its tracks' folder keys (D:) lack
const under = (t, d) => { d = noSep(d); return t.path.startsWith(d + '\\') || t.path.startsWith(d + '/'); };
const tracksUnder = d => S.tracks.filter(t => under(t, d));
const firstArtUnder = d => S.tracks.find(t => t.art && under(t, d))?.art || null;
const playCat = it => playList(it.tracks, 0, { label: it.name });

// ---------- views ----------
export const VIEWS = {
  songs() {
    const sortSel = dropdown({ label: 'Sort', value: set.songSort.key,
      options: [['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['added', 'Date added'], ['duration', 'Duration'], ['year', 'Year'], ['plays', 'Play count'], ['rating', 'Rating'], ['path', 'File name']].map(([k, l]) => [k, 'Sort: ' + l]),
      onChange: k => { set.songSort = { key: k, dir: ['added', 'plays', 'year', 'rating'].includes(k) ? -1 : 1 }; saveSettings(); render('swap'); } });
    if (!S.tracks.length) return h('section', { class: 'view' }, viewHead({ cat: 'songs', title: 'All Songs' }), h('div', { class: 'scroll' }, emptyLib()));
    const tracks = sortedSongs();
    return listView({ cat: 'songs', title: 'All Songs', sub: countLine(tracks) }, () => tracks, { label: 'All Songs', view: { name: 'songs' } },
      { sortBtn, az: set.songSort.key === 'title', extra: [h('span', { class: 'tb-spacer' }), sortSel] });
  },
  albums: () => gridView('albums', 'Albums', S.albums, { sub: a => [a.artist, a.year || null].filter(Boolean).join(' · '), open: a => go('album', a.key), play: a => playList(a.tracks, 0, { label: a.name, view: { name: 'album', arg: a.key } }), az: true,
    extra: [h('button', { class: 'tb-btn', title: 'Download missing album art', onclick: async () => { toast('Looking for missing album art…'); await downloadArt(S.albums.filter(a => !a.art).flatMap(a => a.tracks)); } }, icon('image'))] }),
  artists: () => gridView('artists', 'Artists', S.artists, { round: true, ph: 'artist', sub: a => songsN(a.tracks.length), open: a => go('artist', a.key), play: playCat, az: true }),
  albumArtists: () => gridView('albumArtists', 'Album Artists', S.albumArtists, { round: true, ph: 'artist', sub: a => songsN(a.tracks.length), open: a => go('albumArtist', a.key), play: playCat, az: true }),
  genres: () => gridView('genres', 'Genres', S.genres, { ph: 'genre', sub: a => songsN(a.tracks.length), open: a => go('genre', a.key), play: playCat, az: true }),
  years: () => gridView('years', 'Years', S.years, { ph: 'calendar', sub: a => songsN(a.tracks.length), open: a => go('year', a.key), play: playCat }),
  composers: () => gridView('composers', 'Composers', S.composers, { round: true, ph: 'pen', sub: a => songsN(a.tracks.length), open: a => go('composer', a.key), play: playCat, az: true }),
  folders: () => gridView('folders', 'Folders', [...S.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)), { ph: 'folder', sub: d => `${songsN(d.tracks.length)} · ${dirOf(d.key)}`, open: d => go('folder', d.key), play: playCat, az: true }),

  album(key) {
    const a = S.albumMap.get(key);
    if (!a) return VIEWS.albums();
    const ctx = { label: a.name, view: { name: 'album', arg: key } };
    const q = a.tracks[0];
    const mixed = a.tracks.some(t => fmtQualityShort(t) !== fmtQualityShort(q));
    return listView({ art: a.art, kicker: 'Album', title: a.name, sub: [a.artist, a.year || null, countLine(a.tracks), mixed ? 'Mixed quality' : q?.codec ? `${q.codec}${q.bits ? ' ' + q.bits + '-bit' : ''}${q.sampleRate ? ' / ' + q.sampleRate / 1000 + ' kHz' : ''}` : null].filter(Boolean).join(' · ') }, () => a.tracks, ctx,
      { numbered: 'track', extra: [h('span', { class: 'tb-spacer' }), h('button', { class: 'tb-btn', title: 'Album actions', onclick: e => trackMenu(e, a.tracks, { ctx }) }, icon('more'))] });
  },
  artist(key, map = S.artistMap, kicker = 'Artist') {
    const a = map.get(key);
    if (!a) return VIEWS.artists();
    const set_ = new Set(a.tracks);
    const albums = S.albums.filter(al => al.tracks.some(t => set_.has(t)));
    const ctx = { label: a.name, view: { name: 'artist', arg: key } };
    const scroll = h('div', { class: 'scroll' },
      h('div', { class: 'section-h' }, h('h2', {}, 'Albums'), h('span', { class: 'sub' }, albums.length)),
      grid(albums, { sub: al => al.year || al.artist, open: al => go('album', al.key), play: al => playList(al.tracks, 0, { label: al.name }), menu: (e, it) => trackMenu(e, it.tracks, {}) }),
      h('div', { class: 'section-h' }, h('h2', {}, 'Songs'), h('span', { class: 'sub' }, a.tracks.length)));
    scroll.append(trackList(a.tracks, { ctx, inline: true }));
    return h('section', { class: 'view' }, viewHead({ art: a.art, round: true, kicker, title: a.name, sub: `${plural(albums.length, 'album')} · ${countLine(a.tracks)}` }), toolbar(() => a.tracks, ctx), scroll);
  },
  albumArtist: key => VIEWS.artist(key, S.albumArtistMap, 'Album artist'),
  genre: key => catList(S.genreMap.get(key), 'genres', 'Genre', 'genre', VIEWS.genres),
  year: key => catList(S.yearMap.get(key), 'years', 'Year', 'year', VIEWS.years),
  composer: key => catList(S.composerMap.get(key), 'composers', 'Composer', 'composer', VIEWS.composers),
  folder(key) {
    const d = S.dirs.get(key);
    if (!d) return VIEWS.folders();
    return listView({ cat: 'folders', kicker: dirOf(key), title: d.name, sub: countLine(d.tracks) }, () => d.tracks, { label: d.name, view: { name: 'folder', arg: key } },
      { extra: [h('span', { class: 'tb-spacer' }), h('button', { class: 'tb-btn', title: 'Open in Explorer', onclick: () => api.send('shell:show', fileOf(d.tracks[0])) }, icon('folder'))] });
  },
  hier(dir) {
    const roots = arr(S.folders);
    if (!dir) {
      return gridView('hier', 'Folders Hierarchy', roots.map(r => ({ name: base(r) || r, key: r, art: firstArtUnder(r), tracks: tracksUnder(r) })), { ph: 'folder', sub: r => r.key, open: r => go('hier', r.key), play: playCat });
    }
    const isRoot = roots.some(r => noSep(r) === noSep(dir));
    const sep = dir.includes('\\') || /^[a-z]:[\\/]?$/i.test(dir) ? '\\' : '/';
    dir = noSep(dir);
    const subs = new Map();
    for (const k of S.dirs.keys()) if (k.startsWith(dir + sep)) { const rest = k.slice(dir.length + 1).split(/[\\/]/)[0]; subs.set(rest, dir + sep + rest); }
    const here = S.dirs.get(dir)?.tracks || [];
    const all = tracksUnder(dir);
    const ctx = { label: base(dir), view: { name: 'hier', arg: dir } };
    const scroll = h('div', { class: 'scroll' });
    if (subs.size) scroll.append(h('div', { class: 'section-h' }, h('h2', {}, 'Folders')), grid([...subs].map(([n, p]) => ({ name: n, key: p, art: firstArtUnder(p), tracks: tracksUnder(p) })), { ph: 'folder', sub: s => songsN(s.tracks.length), open: s => go('hier', s.key), play: playCat, menu: (e, it) => trackMenu(e, it.tracks, {}) }));
    if (here.length) scroll.append(h('div', { class: 'section-h' }, h('h2', {}, 'Files'), h('span', { class: 'sub' }, here.length)), trackList(here, { ctx, inline: true }));
    if (!subs.size && !here.length) scroll.append(emptyBox('Empty folder'));
    const up = isRoot ? null : dirOf(dir);
    return h('section', { class: 'view' }, viewHead({ cat: 'hier', kicker: dirOf(dir), title: base(dir), sub: [subs.size ? plural(subs.size, 'folder') : null, countLine(all)].filter(Boolean).join(' · ') }),
      toolbar(() => all, ctx, { extra: [h('span', { class: 'tb-spacer' }), up ? h('button', { class: 'tb-btn', title: 'Up one folder', onclick: () => go('hier', up) }, icon('back'), 'Up') : null] }), scroll);
  },
  playlists() {
    const items = pls().map(p => ({ name: String(p.name ?? ''), key: p.id, art: plArt(p), tracks: plTracks(p) }));
    return gridView('playlists', 'Playlists', items, {
      after: arr(S.filePlaylists).length ? [h('div', { class: 'section-h' }, h('h2', {}, 'In your music folders'), h('span', { class: 'sub' }, S.filePlaylists.length)),
        h('div', { class: 'cat-list' }, ...S.filePlaylists.map(f => h('div', { class: 'cat-row', onclick: () => go('filePlaylist', f) },
          h('span', { class: 'ph' }, icon('file', 'sm')), h('div', { class: 'main' }, h('div', { class: 't1' }, base(f).replace(/\.[^.]+$/, '')), h('div', { class: 't2' }, dirOf(f))))))] : [],
      ph: 'playlist', sub: p => songsN(p.tracks.length), open: p => go('playlist', p.key), play: p => playList(p.tracks, 0, { label: p.name, view: { name: 'playlist', arg: p.key } }),
      empty: emptyBox('No playlists yet', 'Create one, import .m3u files, or import your phone playlists from Settings.'),
      extra: [h('button', { class: 'tb-btn', onclick: () => newPlaylist() }, icon('plus'), 'New'), h('button', { class: 'tb-btn', onclick: importPlaylists }, icon('import'), 'Import')],
    });
  },
  playlist(id) {
    const p = pls().find(x => x.id === id);
    if (!p) return VIEWS.playlists();
    const ctx = { label: p.name, view: { name: 'playlist', arg: id } };
    const tracks = plTracks(p);
    const missing = arr(p.paths).length - tracks.length;
    return listView({ art: plArt(p), kicker: 'Playlist', title: p.name, sub: countLine(tracks) + (missing ? ` · ${missing} not found` : '') }, () => plTracks(p), ctx, {
      playlist: p, emptyText: 'Right-click songs anywhere and choose "Add to playlist", or drag them onto the playlist in the sidebar.',
      extra: [h('span', { class: 'tb-spacer' }), h('button', { class: 'tb-btn', title: 'Playlist options', onclick: e => playlistMenu(e, p) }, icon('more'))],
    });
  },
  filePlaylist(file) {
    const v = h('section', { class: 'view' }, viewHead({ cat: 'playlists', kicker: 'Playlist file', title: base(file).replace(/\.[^.]+$/, ''), sub: dirOf(file) }));
    api.invoke('playlist:readFile', file).then(r => {
      if (!r) return;
      const tracks = r.paths.map(p => S.byPath.get(p) || (/^https?:/.test(p) ? streamTrack({ url: p, name: p }) : null)).filter(Boolean);
      const ctx = { label: r.name, view: { name: 'filePlaylist', arg: file } };
      v.append(toolbar(() => tracks, ctx, { extra: [h('button', { class: 'tb-btn', onclick: () => { (S.playlists = pls()).push({ id: 'p' + Date.now().toString(36), name: r.name, paths: tracks.map(t => t.path), created: Date.now() }); savePlaylists(); render(); toast(`Copied “${r.name}” to your playlists`); } }, icon('save'), 'Save as playlist')] }),
        tracks.length ? trackList(tracks, { ctx }) : h('div', { class: 'scroll' }, emptyBox('No playable entries')));
    });
    return v;
  },
  queue() {
    const tracks = S.uq.map(e => e.track);
    return listView({ cat: 'queue', title: 'Queue', sub: S.uq.length ? `${countLine(tracks)} · then back to ${S.ctx.label || 'your list'}` : 'Empty. “Add to queue” and “Play next” put songs here; they play before the current list continues.' },
      () => tracks, { label: 'Queue', queue: true }, { extra: [h('span', { class: 'tb-spacer' }), h('button', { class: 'tb-btn', onclick: () => { S.uq = []; engine.invalidateNext(); hooks.queueChanged(); render(); } }, icon('trash'), 'Clear')] });
  },
  streams() {
    if (!S.streams.length) return h('section', { class: 'view' }, viewHead({ cat: 'streams', title: 'Streams', sub: 'Internet radio' }),
      h('div', { class: 'scroll' }, emptyBox('No radio stations yet', 'Add a station by its URL: MP3, AAC, Ogg, Opus and HLS streams, or .m3u and .pls links.', cta('Add stream', 'plus', addStream, 'primary'))));
    const tracks = S.streams.map(streamTrack);
    return listView({ cat: 'streams', title: 'Streams', sub: plural(S.streams.length, 'internet radio station') }, () => tracks, { label: 'Streams', view: { name: 'streams' } },
      { emptyText: 'Add an internet radio URL (MP3/AAC/Ogg/Opus/HLS streams, .m3u and .pls links).', extra: [h('span', { class: 'tb-spacer' }), cta('Add stream', 'plus', addStream, 'primary')] });
  },
  bookmarks() {
    const scroll = h('div', { class: 'scroll' });
    const rows = [...S.bookmarks].sort((a, b) => b.created - a.created).map(b => {
      const t = S.byPath.get(b.path);
      return h('div', { class: 'cat-row reveal', onclick: () => openBookmark(b), oncontextmenu: e => menu(e, [{ label: 'Delete bookmark', icon: 'trash', run: () => { S.bookmarks = S.bookmarks.filter(x => x !== b); api.send('store:set', 'bookmarks', S.bookmarks); render(); } }]) },
        t?.art ? h('img', { src: artUrl(t.art), alt: '' }) : h('span', { class: 'ph' }, icon('bookmark', 'sm')),
        h('div', { class: 'main' }, h('div', { class: 't1' }, b.label), h('div', { class: 't2' }, `${t ? titleOf(t) + ' · ' + artistOf(t) : 'Missing song'} · ${fmtTime(b.pos)}`)),
        h('span', { class: 't2' }, new Date(b.created).toLocaleDateString()));
    });
    scroll.append(rows.length ? h('div', { class: 'cat-list' }, ...rows) : emptyBox('No bookmarks', 'While a song plays, use its menu → “Add bookmark here” to save the position.'));
    return h('section', { class: 'view' }, viewHead({ cat: 'bookmarks', title: 'Bookmarks', sub: plural(S.bookmarks.length, 'saved position') }), scroll);
  },
  mostPlayed: () => smartView('mostPlayed'), topRated: () => smartView('topRated'), lowRated: () => smartView('lowRated'),
  recentlyPlayed: () => smartView('recentlyPlayed'), recentlyAdded: () => smartView('recentlyAdded'), long: () => smartView('long'),

  search(q) {
    const hit = searchMatch(q);
    const songs = S.tracks.filter(t => hit(`${titleOf(t)} ${t.artist} ${t.album} ${t.albumArtist} ${t.genre} ${t.composer}`)); // trackList is virtualized: show and play every match
    const allAlbums = S.albums.filter(a => hit(`${a.name} ${a.artist}`)), allArtists = S.artists.filter(a => hit(a.name));
    const showAll = S.view?.showAll === q, albums = showAll ? allAlbums : allAlbums.slice(0, 18), artists = showAll ? allArtists : allArtists.slice(0, 18);
    const more = allAlbums.length > albums.length || allArtists.length > artists.length ? h('button', { class: 'tb-btn', onclick: () => { S.view.showAll = q; render('stay'); } }, `Show all ${allArtists.length} artists and ${allAlbums.length} albums`) : null;
    const pl = pls().filter(p => hit(String(p.name ?? '')));
    const ctx = { label: `Search “${q}”`, view: { name: 'search', arg: q } };
    const scroll = h('div', { class: 'scroll' });
    if (artists.length) scroll.append(h('div', { class: 'section-h' }, h('h2', {}, 'Artists')), grid(artists, { round: true, ph: 'artist', sub: a => songsN(a.tracks.length), open: a => go('artist', a.key), play: playCat }));
    if (albums.length) scroll.append(h('div', { class: 'section-h' }, h('h2', {}, 'Albums')), grid(albums, { sub: a => a.artist, open: a => go('album', a.key), play: playCat }));
    if (pl.length) scroll.append(h('div', { class: 'section-h' }, h('h2', {}, 'Playlists')), grid(pl.map(p => ({ name: p.name, key: p.id, art: plArt(p), tracks: plTracks(p) })), { ph: 'playlist', sub: p => songsN(p.tracks.length), open: p => go('playlist', p.key), play: playCat }));
    if (songs.length) scroll.append(h('div', { class: 'section-h' }, h('h2', {}, 'Songs'), h('span', { class: 'sub' }, songs.length)), trackList(songs, { ctx, inline: true }));
    if (!songs.length && !albums.length && !artists.length && !pl.length) scroll.append(emptyBox('No results', 'Try a different spelling or fewer words.'));
    return h('section', { class: 'view' }, viewHead({ kicker: 'Search', title: q, sub: [songs.length && plural(songs.length, 'song'), allAlbums.length && plural(allAlbums.length, 'album'), allArtists.length && plural(allArtists.length, 'artist')].filter(Boolean).join(' · ') || 'No results' }),
      toolbar(() => songs, ctx, { extra: more ? [more] : [] }), scroll);
  },
  lyrics: () => lyricsView(),
  nowplaying() {
    const t = engine.track;
    const left = h('div', { class: 'npv-left' },
      t?.art ? h('img', { class: 'npv-art', src: artUrl(t.art, true), alt: '' }) : h('div', { class: 'npv-art ph' }, icon('song', 'xl')),
      h('div', { class: 'npv-title' }, t ? titleOf(t) : 'Nothing playing'),
      h('div', { class: 'npv-sub' }, t ? [artistOf(t), t.album].filter(Boolean).join(' — ') : ''),
      t ? h('div', { class: 'npv-q' }, t.stream ? 'Live stream' : fmtQuality(t)) : null);
    // the glow is a real element, not ::before: pseudo-element loops here run on the main thread every frame
    const v = h('section', { class: 'view npv' }, h('div', { class: 'npv-glow', 'aria-hidden': 'true' }), left, lyricsView());
    return v;
  },
  eq: () => eqView(),
  settings: () => settingsView(),
};
function catList(g, cat, kicker, name, fallback) {
  if (!g) return fallback();
  return listView({ cat, kicker, title: g.name, sub: countLine(g.tracks) }, () => g.tracks, { label: g.name, view: { name, arg: g.key } });
}
function smartView(id) {
  const c = catOf(id), tracks = smartList(id);
  return listView({ cat: id, title: c.label, sub: countLine(tracks) }, () => tracks, { label: c.label, view: { name: id } },
    { emptyText: id === 'long' ? `Tracks of ${set.longMin} minutes or longer show up here.` : 'Play some music and this list fills itself.' });
}
