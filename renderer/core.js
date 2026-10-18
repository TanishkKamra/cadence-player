// Shared state, settings, persistence, library index and the play queue.
import { debounce, shuffleArr, splitNames, norm } from './util.js';

export const DEFAULTS = {
  volume: 0.8, lastVol: 0.8,
  // equalizer / DSP
  eqOn: true, eqMode: 'graphic', graphicBands: 10, graphic: Array(10).fill(0), params: [{ type: 'peaking', freq: 1000, gain: 0, q: 1 }], preamp: 0, eqPreset: 'Flat',
  toneOn: false, bass: 0, treble: 0, bassFreq: 90, trebleFreq: 9000, limiter: true, balance: 0, width: 1, mono: false,
  reverb: { on: false, preset: 'Scene', size: 0.245, damp: 0.412, filter: 0.705, fade: 0.503, preDelay: 0.121, preDelayMix: 0.425, mix: 0.45 },
  tempo: 1, semitones: 0, deviceEq: {}, userPresets: {},
  // crossfade, fade, gapless
  xfMode: 'none', crossfadeLen: 5, manualFade: 'none', shortFade: 0.4, fadePause: true, seekFade: 0.1, gap: 0,
  // replay gain / output
  rgMode: 'off', preventClip: true, rgPreamp: 0, noRgPreamp: 0, device: '', sampleRate: 0, exclusive: false,
  // library & lists
  songSort: { key: 'title', dir: 1 }, showTrackNo: 'off', filenameAsTitle: false, hideUnknown: false, ignoreShort: 6,
  splitArtists: true, listAction: 'play', noDuplicates: false, plInsert: 'end', longMin: 45, perTrackProgress: true,
  countPlayedPct: 50, grid: { albums: true, artists: true, albumArtists: true, genres: true, years: true, composers: true, folders: true, playlists: true },
  // queue & shuffle
  queueStart: 'after', queueEnd: 'return', shuffleMode: 'songsCats', shuffleRandom: 'full', noReshuffle: false,
  // player screen
  rating: 'thumbs', proButtons: 'category', prevRestarts: true, remaining: false, artAnim: true, marquee: true,
  // lyrics
  onlineLyrics: false, lyricsSize: 34, lyricsOffset: 0, lyricsSearchUrl: 'https://www.google.com/search?q=lyrics+%ARTIST%+%TITLE%',
  // look and feel
  theme: 'dark', blur: true, blurAmount: 70, bgIntensity: 1, bgSaturation: 1.5, bgGradient: 4, accentFromArt: true, accent: '#ff8a3d', animations: 'normal', windowMaterial: 'none',
  // visualizer
  vizDuration: 120, vizMode: 'milk', vizLiked: [], vizHidden: [], vizFadedOpacity: 0.5, vizKeepAwake: true, vizSpectrumStyle: 'rounded',
  // headset / desktop
  pauseOnDisconnect: true, resumeOnConnect: false, notifyTrack: false, mediaKeys: true,
  // album art
  downloadArt: false, artHiRes: true, artistImages: false,
  // misc
  hiddenCats: [], lbToken: '', scrobble: false, resume: true, imported: false, sideCollapsed: {}, sideCompact: false,
};
export const set = structuredClone(DEFAULTS);

// ---------- validation of anything read from disk / a backup ----------
const BAD = new Set(['__proto__', 'constructor', 'prototype']);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const fin = (v, d) => Number.isFinite(v) ? v : d;
const RANGE = {
  volume: [0, 1], lastVol: [0, 1], preamp: [-15, 15], bass: [-15, 15], treble: [-15, 15], balance: [-1, 1], width: [0, 4], tempo: [0.25, 4], semitones: [-24, 24],
  crossfadeLen: [1, 12], shortFade: [0.1, 2], seekFade: [0, 0.5], gap: [0, 5], rgPreamp: [-15, 15], noRgPreamp: [-15, 15], ignoreShort: [0, 60], countPlayedPct: [1, 100],
  longMin: [1, 600], lyricsSize: [10, 120], lyricsOffset: [-30, 30], blurAmount: [0, 200], bgIntensity: [0, 2], bgSaturation: [0, 4], bgGradient: [0, 8],
  vizDuration: [5, 600], vizFadedOpacity: [0, 1], bassFreq: [20, 2000], trebleFreq: [1000, 20000], graphicBands: [3, 31], sampleRate: [0, 384000],
};
const ENUM = {
  theme: ['dark', 'black', 'light', 'auto'], animations: ['normal', 'fast', 'off'], windowMaterial: ['none', 'mica', 'acrylic'], eqMode: ['graphic', 'parametric'], xfMode: ['none', 'nongapless', 'all', 'shuffled'],
  manualFade: ['none', 'short', 'full'], rgMode: ['off', 'track', 'album'], rating: ['thumbs', 'stars'], queueStart: ['after', 'now'], queueEnd: ['return', 'stay'],
  plInsert: ['end', 'start', 'shuffled'], showTrackNo: ['off', 'track'], shuffleMode: ['songsCats', 'cats', 'songs'], shuffleRandom: ['full', 'less'],
  proButtons: ['category', 'seek'], vizMode: ['milk', 'bars'], vizSpectrumStyle: ['rounded', 'classic', 'off'], listAction: ['play', 'enqueue'],
};
const PTYPES = ['peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'notch', 'bandpass', 'allpass'];
function coerce(v, d, key) {
  if (Array.isArray(d)) return Array.isArray(v) ? v.slice(0, 5000) : structuredClone(d);
  if (isObj(d)) {
    if (!isObj(v)) return structuredClone(d);
    const out = {};
    if (!Object.keys(d).length) { for (const k of Object.keys(v)) if (!BAD.has(k)) out[k] = v[k]; return out; } // open map
    for (const k of Object.keys(d)) out[k] = coerce(v[k], d[k], k);
    return out;
  }
  if (typeof d === 'number') { const [lo, hi] = RANGE[key] || [-Infinity, Infinity]; return Math.min(hi, Math.max(lo, fin(v, d))); }
  if (typeof d === 'boolean') return typeof v === 'boolean' ? v : d;
  if (typeof d === 'string') {
    if (typeof v !== 'string') return d;
    if (ENUM[key] && !ENUM[key].includes(v)) return d;
    if (key === 'accent' && !/^#[0-9a-f]{6}$/i.test(v)) return d;
    if (key === 'lyricsSearchUrl' && !/^https:\/\//.test(v)) return d;
    return v;
  }
  return v;
}
// settings from disk or a backup: every key typed and clamped like DEFAULTS, unknown keys kept (minus prototype keys)
export function cleanSettings(raw) {
  raw = isObj(raw) ? raw : {};
  const out = coerce(raw, DEFAULTS);
  if (typeof raw.reverb === 'string') out.reverb = structuredClone(DEFAULTS.reverb);
  for (const k of Object.keys(raw)) if (!(k in DEFAULTS) && !BAD.has(k)) out[k] = raw[k];
  if ('userReverbs' in out) out.userReverbs = coerce(out.userReverbs, {});
  if (typeof raw.sampleRate !== 'number' || raw.sampleRate < 0) out.sampleRate = 0;
  out.graphic = out.graphic.map(g => Math.min(15, Math.max(-15, fin(g, 0))));
  if (!out.graphic.length) out.graphic = Array(10).fill(0);
  out.graphicBands = out.graphic.length;
  out.params = out.params.filter(isObj).map(p => ({ ...p, type: PTYPES.includes(p.type) ? p.type : 'peaking', freq: Math.min(24000, Math.max(10, fin(p.freq, 1000))), gain: Math.min(30, Math.max(-30, fin(p.gain, 0))), q: Math.min(30, Math.max(0.1, fin(p.q, 1))) }));
  if (!out.params.length) out.params = structuredClone(DEFAULTS.params);
  for (const k of ['vizLiked', 'vizHidden', 'hiddenCats']) out[k] = out[k].filter(x => typeof x === 'string');
  // userPresets map names to preset objects; deviceEq maps output ids to preset NAMES (strings)
  for (const n in out.userPresets) if (!isObj(out.userPresets[n])) delete out.userPresets[n];
  for (const n in out.deviceEq) if (typeof out.deviceEq[n] !== 'string' || !out.deviceEq[n]) delete out.deviceEq[n];
  return out;
}
const str = (v, d = '') => typeof v === 'string' ? v : d;
export const cleanPlaylists = a => (Array.isArray(a) ? a : []).filter(isObj).map((p, i) => ({
  ...p, id: str(p.id) || 'p' + i + Math.random().toString(36).slice(2, 7), name: str(p.name) || 'Playlist', paths: (Array.isArray(p.paths) ? p.paths : []).filter(x => typeof x === 'string'), created: fin(p.created, 0),
}));
export const cleanStats = o => {
  const out = {};
  if (isObj(o)) for (const k of Object.keys(o)) if (!BAD.has(k) && isObj(o[k])) { const s = o[k]; out[k] = { ...s, plays: Math.max(0, fin(s.plays, 0)), last: fin(s.last, 0), rating: Math.min(5, Math.max(0, fin(s.rating, 0))) }; if ('pos' in s) out[k].pos = Math.max(0, fin(s.pos, 0)); }
  return out;
};
export const cleanStreams = a => (Array.isArray(a) ? a : []).filter(s => isObj(s) && /^https?:\/\//.test(str(s.url))).map(s => ({ ...s, url: s.url, name: str(s.name) || s.url, added: fin(s.added, 0) }));
export const cleanBookmarks = a => (Array.isArray(a) ? a : []).filter(b => isObj(b) && typeof b.path === 'string').map(b => ({ ...b, pos: Math.max(0, fin(b.pos, 0)), label: str(b.label), created: fin(b.created, 0) }));
const strs = a => (Array.isArray(a) ? a : []).filter(x => typeof x === 'string');
export const cleanState = s => isObj(s) ? {
  ...s, list: strs(s.list), uq: strs(s.uq), order: Array.isArray(s.order) && s.order.every(Number.isInteger) ? s.order : null, li: fin(s.li, 0), pos: Math.max(0, fin(s.pos, 0)),
  cur: str(s.cur) || null, repeat: ['off', 'all', 'one'].includes(s.repeat) ? s.repeat : 'off', ctx: isObj(s.ctx) ? s.ctx : {},
} : null;

export const S = {
  tracks: [], all: [], byPath: new Map(), folders: [], filePlaylists: [],
  albums: [], albumMap: new Map(), artists: [], artistMap: new Map(), albumArtists: [], albumArtistMap: new Map(),
  genres: [], genreMap: new Map(), years: [], yearMap: new Map(), composers: [], composerMap: new Map(), dirs: new Map(),
  playlists: [], stats: {}, streams: [], bookmarks: [], artistImages: {},
  // queue model: `list` is the playing category, `uq` the user Queue played before returning to it
  list: [], li: -1, order: null, uq: [], fromQueue: false, ctx: { label: '', view: null },
  shuffle: false, repeat: 'off',
  nav: [], view: null, counted: false, sleep: null,
};
export const hooks = { render() {}, refresh() {}, queueChanged() {}, toast() {} };
export let engine = null;
export const setEngine = e => { engine = e; };

let uidc = 0;
export const uid = () => ++uidc;
export const base = p => p.split(/[\\/]/).pop().replace(/#\d+$/, '');
export const dirOf = p => { const f = p.replace(/#\d+$/, ''); return f.slice(0, Math.max(f.lastIndexOf('\\'), f.lastIndexOf('/'))); };
export const fileOf = t => t.file || t.path;
export const stat = p => S.stats[p] ||= { plays: 0, last: 0, rating: 0 };
export const rating = t => S.stats[t.path]?.rating || 0;
export const liked = t => rating(t) >= 4;

// ---------- persistence ----------
const flushable = (fn, ms) => { const d = debounce(fn, ms); d.flush = fn; return d; };
export const saveSettings = flushable(() => api.send('store:set', 'settings', set), 300);
export const saveStats = flushable(() => api.send('store:set', 'stats', S.stats), 1000);
export const savePlaylists = () => api.send('store:set', 'playlists', S.playlists);
export const saveStreams = () => api.send('store:set', 'streams', S.streams);
export const saveBookmarks = () => api.send('store:set', 'bookmarks', S.bookmarks);
let lastState = '';
export function saveState() {
  const idx = e => S.list.indexOf(e);
  const state = {
    list: S.list.map(e => e.track.path), li: S.li, uq: S.uq.map(e => e.track.path),
    cur: engine?.track?.path || null, fromQueue: S.fromQueue, pos: Math.round(engine?.position || 0),
    order: S.order ? S.order.map(idx) : null, shuffle: S.shuffle, repeat: S.repeat, ctx: { label: S.ctx.label },
  };
  const json = JSON.stringify(state);
  if (json === lastState) return; // paused / idle: nothing to write
  lastState = json;
  api.send('store:set', 'state', state);
}
export function flushAll() { saveSettings.flush(); saveStats.flush(); saveState(); }

// ---------- display helpers ----------
export const titleOf = t => (set.filenameAsTitle && !t.stream ? base(t.path).replace(/\.[^.]+$/, '') : t.title) || 'Untitled';
export const artistOf = t => t.artist || (set.hideUnknown ? '' : 'Unknown artist');
export const names = s => set.splitArtists ? splitNames(s) : (s ? [s.trim()] : []);

// ---------- library index ----------
export function buildIndex(all) {
  S.all = all;
  const tracks = all.filter(t => !(t.duration && t.duration < set.ignoreShort));
  S.tracks = tracks.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }));
  S.byPath = new Map(all.map(t => [t.path, t]));
  const group = (keyFn, make) => {
    const m = new Map();
    for (const t of tracks) for (const k of [].concat(keyFn(t)).filter(Boolean)) {
      let g = m.get(k);
      if (!g) m.set(k, g = make(k, t));
      g.tracks.push(t);
      if (!g.art && t.art) g.art = t.art;
    }
    return m;
  };
  const byDisc = (a, b) => (a.disc - b.disc) || (a.track - b.track) || a.title.localeCompare(b.title);
  S.albumMap = group(albumKey, (k, t) => ({ key: k, name: t.album || 'Unknown album', artist: t.albumArtist || names(t.artist)[0] || 'Unknown artist', year: t.year, art: null, tracks: [] }));
  for (const a of S.albumMap.values()) { a.tracks.sort(byDisc); a.year = Math.max(...a.tracks.map(t => t.year || 0)); }
  S.artistMap = group(t => names(t.artist).length ? names(t.artist) : ['Unknown artist'], k => ({ key: k, name: k, art: null, tracks: [] }));
  S.albumArtistMap = group(t => t.albumArtist || names(t.artist)[0] || 'Unknown artist', k => ({ key: k, name: k, art: null, tracks: [] }));
  applyArtistImages();
  S.genreMap = group(t => (t.genre || '').split(/[;,/]/).map(x => x.trim()), k => ({ key: k, name: k, art: null, tracks: [] }));
  S.yearMap = group(t => t.year ? String(t.year) : null, k => ({ key: k, name: k, art: null, tracks: [] }));
  S.composerMap = group(t => splitNames(t.composer), k => ({ key: k, name: k, art: null, tracks: [] }));
  S.dirs = group(t => dirOf(t.path), k => ({ key: k, name: base(k), art: null, tracks: [] }));
  for (const d of S.dirs.values()) d.tracks.sort((a, b) => (a.cue && b.cue ? a.track - b.track : base(a.path).localeCompare(base(b.path), undefined, { numeric: true })));
  const byName = (a, b) => sortName(a.name).localeCompare(sortName(b.name), undefined, { sensitivity: 'base', numeric: true });
  S.albums = [...S.albumMap.values()].sort(byName);
  S.artists = [...S.artistMap.values()].sort(byName);
  S.albumArtists = [...S.albumArtistMap.values()].sort(byName);
  S.genres = [...S.genreMap.values()].sort(byName);
  S.years = [...S.yearMap.values()].sort((a, b) => b.name - a.name);
  S.composers = [...S.composerMap.values()].sort(byName);
}
// downloaded artist photos replace the album-art fallback on artist cards
export function applyArtistImages() {
  if (!set.artistImages) return;
  for (const m of [S.artistMap, S.albumArtistMap, S.composerMap]) for (const a of m.values()) { const img = S.artistImages[a.name]; if (img) { a.albumArt ||= a.art; a.art = img; } }
}
export const albumKey = t => (t.albumArtist || names(t.artist)[0] || '') + '\u0000' + (t.album || 'Unknown album');
const sortName = s => s.replace(/^(the|a|an)\s+/i, '');

export function smartList(id) {
  const st = t => S.stats[t.path] || {};
  switch (id) {
    case 'mostPlayed': return S.tracks.filter(t => st(t).plays > 0).sort((a, b) => st(b).plays - st(a).plays).slice(0, 200);
    case 'topRated': return S.tracks.filter(t => st(t).rating >= 4).sort((a, b) => st(b).rating - st(a).rating);
    case 'lowRated': return S.tracks.filter(t => st(t).rating > 0 && st(t).rating <= 2);
    case 'recentlyPlayed': return S.tracks.filter(t => st(t).last > 0).sort((a, b) => st(b).last - st(a).last).slice(0, 200);
    case 'recentlyAdded': return [...S.tracks].sort((a, b) => (st(b).added || b.added) - (st(a).added || a.added)).slice(0, 200);
    case 'long': return S.tracks.filter(t => t.duration >= set.longMin * 60);
  }
  return [];
}
export const plTracks = p => p.paths.map(x => S.byPath.get(x) || (/^https?:/.test(x) ? streamTrack({ url: x, name: x }) : null)).filter(Boolean);
export const streamTrack = s => ({ path: s.url, file: s.url, stream: true, title: s.name || s.url, artist: s.genre || 'Internet radio', album: '', duration: 0, art: s.art || null, codec: 'STREAM', lossless: false });

// ---------- shuffle ----------
// "less random" weights each item by how rarely it was played (Efraimidis–Spirakis weighted shuffle)
function weightedShuffle(items, weight) {
  if (set.shuffleRandom !== 'less') return shuffleArr(items);
  return items.map(x => [Math.pow(Math.random(), 1 / weight(x)), x]).sort((a, b) => b[0] - a[0]).map(p => p[1]);
}
export function shuffled(entries) {
  const w = e => 1 / (1 + (S.stats[e.track.path]?.plays || 0));
  if (set.shuffleMode === 'songs') return weightedShuffle([...entries], w);
  // group consecutive entries by album/folder, then shuffle categories (and, by default, songs inside them)
  const groups = [];
  for (const e of entries) {
    const k = albumKey(e.track) + dirOf(e.track.path);
    const g = groups.find(x => x.k === k);
    g ? g.items.push(e) : groups.push({ k, items: [e] });
  }
  if (groups.length < 2) return weightedShuffle([...entries], w);
  const order = weightedShuffle(groups, g => g.items.reduce((s, e) => s + w(e), 0) / g.items.length);
  return order.flatMap(g => set.shuffleMode === 'cats' ? g.items : weightedShuffle([...g.items], w));
}

// ---------- queue ----------
export const makeEntries = tracks => tracks.map(t => ({ uid: uid(), track: t }));
export const current = () => engine?.entry || null;

// what plays after `cur` (peek only; the 'track' event commits it)
export function peekNext(cur, manual) {
  if (!manual && S.repeat === 'one' && cur) return cur;
  if (S.uq.length && !(S.uq[0] === cur)) return S.uq[0];
  if (S.uq.length > 1 && S.uq[0] === cur) return S.uq[1];
  // after the Queue runs out: return to the category (or keep repeating the Queue)
  let i = S.list.indexOf(cur);
  if (i < 0) i = S.li;
  if (S.fromQueue && set.queueEnd === 'stay' && S.uqHistory?.length) return manual || S.repeat === 'all' ? S.uqHistory[0] : null;
  const n = S.fromQueue ? (S.li >= 0 ? S.li + 1 : 0) : i + 1;
  if (n < S.list.length) return S.list[n];
  if (S.repeat === 'all' || manual) return S.list[0] || null;
  return null;
}
// the engine started playing `entry`: update list/queue positions
export function commit(entry) {
  if (S.uq[0] === entry) {
    S.uq.shift();
    (S.uqHistory ||= []).push(entry);
    S.fromQueue = true;
  } else {
    const i = S.list.indexOf(entry);
    if (i >= 0) { S.li = i; S.fromQueue = false; S.uqHistory = []; }
  }
}
export function prevEntry() {
  if (S.fromQueue) return S.list[S.li] || S.list[0] || null;
  if (S.li > 0) return S.list[S.li - 1];
  return S.repeat === 'all' ? S.list.at(-1) : S.list[0] || null;
}
export function setList(tracks, index, ctx, { shuffle } = {}) {
  if (shuffle) S.shuffle = true;
  let list = makeEntries(tracks);
  let start = index < 0 ? Math.floor(Math.random() * list.length) : index;
  S.order = null;
  if (S.shuffle) {
    S.order = list;
    const first = index < 0 ? null : list[start];
    const rest = shuffled(list.filter(e => e !== first));
    list = first ? [first, ...rest] : rest;
    start = 0;
  }
  S.list = list; S.li = start; S.ctx = ctx || {}; S.fromQueue = false;
  return list[start];
}
export function setShuffle(on) {
  S.shuffle = on;
  const cur = S.list[S.li];
  if (on) {
    S.order = [...S.list];
    const rest = shuffled(S.list.filter(e => e !== cur));
    S.list = cur ? [cur, ...rest] : rest;
    S.li = cur ? 0 : -1;
  } else if (S.order) {
    S.list = S.order; S.order = null;
    S.li = cur ? S.list.indexOf(cur) : S.li;
  }
  engine?.invalidateNext();
}
export function enqueue(tracks, { next = false } = {}) {
  const add = makeEntries(tracks);
  if (next) S.uq.unshift(...add); else S.uq.push(...add);
  engine?.invalidateNext();
  return add;
}
export function removeFromList(entry) {
  const i = S.list.indexOf(entry);
  if (i < 0 || i === S.li && !S.fromQueue) return false;
  S.list.splice(i, 1);
  if (i < S.li || (i === S.li && S.fromQueue)) S.li--;
  if (S.order) S.order = S.order.filter(x => x !== entry);
  engine?.invalidateNext();
  return true;
}
export function moveInList(from, to) {
  const cur = S.list[S.li];
  const [m] = S.list.splice(from, 1);
  S.list.splice(from < to ? to - 1 : to, 0, m);
  S.li = S.list.indexOf(cur);
  engine?.invalidateNext();
}
// crossfade policy per transition (: no fading / non-gapless only / all songs / shuffled songs)
export function allowXf(a, b) {
  switch (set.xfMode) {
    case 'all': return true;
    case 'shuffled': return S.shuffle;
    case 'nongapless': return !a || !b || albumKey(a.track) !== albumKey(b.track) || dirOf(a.track.path) !== dirOf(b.track.path);
    default: return false;
  }
}
export const skipFadeSec = () => ({ none: 0, short: set.shortFade, full: set.crossfadeLen }[set.manualFade] || 0);
export const searchMatch = q => { const w = norm(q).split(/\s+/).filter(Boolean); return s => { const n = norm(s); return w.every(x => n.includes(x)); }; };
