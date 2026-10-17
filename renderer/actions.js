// User actions: playing, queueing, rating, playlists, tags, album art, bookmarks, deleting.
import { h, icon, fmtTime, fmtQuality, splitNames, plural } from './util.js';
import {
  S, set, engine, hooks, stat, liked, rating, saveStats, savePlaylists, saveBookmarks, saveStreams, setList, setShuffle as coreShuffle,
  enqueue as coreEnqueue, peekNext, prevEntry, albumKey, dirOf, fileOf, plTracks, names, titleOf, streamTrack,
} from './core.js';
import { menu, toast, dialog, prompt, confirm, refreshLists } from './ui.js';
import { go } from './views.js';

// ---------- playback ----------
export function playList(tracks, index, ctx = {}, opts = {}) {
  if (!tracks.length) return;
  const e = setList(tracks, index, ctx, opts);
  engine.load(e, { fade: true, start: resumePos(e.track) });
  hooks.queueChanged();
}
// list item click, honouring "List item action"
export function playFrom(tracks, i, ctx) {
  if (ctx?.queue && S.uq[i]) { // Queue view: play the clicked item, then the rest of the queue, then back to the list
    S.uq.splice(0, i); // commit() shifts the clicked entry itself
    S.fromQueue = true; engine.invalidateNext(); engine.load(S.uq[0], { fade: true }); hooks.queueChanged();
    return;
  }
  if (set.listAction === 'enqueue') return enqueueUI([tracks[i]]);
  // "no reshuffle": picking another song from the playing list keeps the current shuffle order
  if (S.shuffle && set.noReshuffle && S.ctx?.label === ctx?.label && S.list.length === tracks.length) {
    const e = S.list.find(x => x.track === tracks[i]);
    if (e) { S.li = S.list.indexOf(e); S.fromQueue = false; engine.load(e, { fade: true }); hooks.queueChanged(); return; }
  }
  playList(tracks, i, ctx);
}
const resumePos = t => (set.perTrackProgress && t.duration >= set.longMin * 60 && S.stats[t.path]?.pos > 5) ? S.stats[t.path].pos : 0;
export function next() {
  const e = peekNext(engine.entry, true);
  if (e) engine.load(e, { fade: true, play: true, start: resumePos(e.track) });
}
export function prev() {
  if (!engine.track) return;
  if (set.prevRestarts && engine.position > 3) { engine.seek(0); return; }
  const e = prevEntry();
  if (!e) return engine.seek(0);
  hooks.artDir = 'back';
  engine.load(e, { fade: true, play: true });
}
// <<< / >>> "category" buttons: previous / next album or folder in the playing list
export function jumpCategory(dir) {
  if (set.proButtons === 'seek' || (engine.track?.duration >= set.longMin * 60)) return engine.seek(engine.position + dir * 10);
  if (S.li < 0 || !S.list.length) return;
  const key = e => albumKey(e.track) + dirOf(e.track.path);
  let i = S.li;
  const curKey = key(S.list[i]);
  if (dir > 0) { while (i < S.list.length && key(S.list[i]) === curKey) i++; if (i >= S.list.length) i = 0; }
  else {
    while (i > 0 && key(S.list[i - 1]) === curKey) i--;
    if (i === S.li || engine.position < 3) { i = Math.max(0, i - 1); const k = key(S.list[i]); while (i > 0 && key(S.list[i - 1]) === k) i--; }
    hooks.artDir = 'back';
  }
  engine.load(S.list[i], { fade: true, play: true });
}
export function togglePlay() {
  if (!engine.track) {
    if (S.ended && S.list.length) { S.ended = false; S.li = 0; S.fromQueue = false; } // queue finished: start the list over
    const e = S.list[S.li] || S.uq[0];
    if (e) return engine.load(e);
    if (S.tracks.length) playList(S.tracks, 0, { label: 'All Songs', view: { name: 'songs' } });
    return;
  }
  engine.toggle();
}
export function setShuffle(on) { coreShuffle(on); hooks.queueChanged(); toast(on ? `Shuffle on · ${{ songsCats: 'songs and categories', cats: 'categories', songs: 'songs' }[set.shuffleMode]}` : 'Shuffle off'); }
export function cycleRepeat() {
  S.repeat = { off: 'all', all: 'one', one: 'off' }[S.repeat];
  engine.invalidateNext();
  hooks.queueChanged();
  toast({ off: 'Repeat off', all: 'Repeat list', one: 'Repeat this song' }[S.repeat]);
}
export function enqueueUI(tracks, playNext = false) {
  if (!tracks.length) return;
  coreEnqueue(tracks, { next: playNext });
  if (!engine.track) engine.load(S.uq[0]);
  else if (set.queueStart === 'now' && !playNext) engine.load(S.uq[0], { fade: true });
  hooks.queueChanged();
  const what = tracks.length === 1 ? `“${titleOf(tracks[0])}”` : `${tracks.length} songs`;
  toast(playNext ? `${what} will play next` : `Added ${what} to the queue`);
}

// ---------- rating ----------
export function rate(t, r) {
  stat(t.path).rating = r;
  saveStats();
  refreshLists();
  hooks.refresh();
  if (['topRated', 'lowRated'].includes(S.view?.name)) hooks.render();
}

// ---------- track context menu ----------
export function trackMenu(e, tracks, { playlist, rows, index, list, ctx } = {}) {
  if (!tracks.length) return;
  const one = tracks.length === 1 ? tracks[0] : null;
  const local = tracks.filter(t => !t.stream);
  const del = local.filter(t => !t.cue);
  const album = one && S.albumMap.get(albumKey(one));
  const artist = one && names(one.artist)[0];
  menu(e, [
    { label: 'Play', icon: 'play', run: () => list && one ? playFrom(list, index, ctx) : playList(tracks, 0, ctx || { label: 'Selection' }) },
    { label: 'Play next', icon: 'next', run: () => enqueueUI(tracks, true) },
    { label: 'Add to queue', icon: 'queue', run: () => enqueueUI(tracks) },
    { label: 'Add to playlist', icon: 'playlist', sub: () => [
      { label: 'New playlist…', icon: 'plus', run: () => newPlaylist(tracks) },
      S.playlists.length ? '-' : null,
      ...S.playlists.map(p => ({ label: p.name, run: () => addToPlaylist(p, tracks) })),
    ] },
    '-',
    one ? { label: liked(one) ? 'Unlike' : 'Like', icon: 'thumbUp', run: () => rate(one, liked(one) ? 0 : 5) } : { label: 'Like all', icon: 'thumbUp', run: () => tracks.forEach(t => rate(t, 5)) },
    one ? { label: rating(one) && rating(one) <= 2 ? 'Remove dislike' : 'Dislike', icon: 'thumbDown', run: () => rate(one, rating(one) && rating(one) <= 2 ? 0 : 1) } : null,
    one && album ? { label: 'Album', icon: 'album', run: () => go('album', album.key) } : null,
    one && artist ? { label: 'Artist', icon: 'artist', run: () => go('artist', artist) } : null,
    one && !one.stream ? { label: 'Folder', icon: 'folder', run: () => go('folder', dirOf(one.path)) } : null,
    one && splitNames(one.genre)[0] ? { label: 'Genre', icon: 'genre', run: () => go('genre', splitNames(one.genre)[0]) } : null,
    one ? { label: 'Lyrics', icon: 'lyrics', run: () => { if (engine.track?.path !== one.path) { coreEnqueue([one], { next: true }); engine.load(S.uq[0], { fade: true }); hooks.queueChanged(); } go('lyrics'); } } : null,
    '-',
    local.length ? { label: local.length > 1 ? `Edit tags (${local.length})…` : 'Info / Tags…', icon: 'edit', run: () => editTags(local) } : null,
    local.length ? { label: 'Album art', icon: 'image', sub: () => [
      { label: 'Choose image…', icon: 'folder', run: () => pickArt(local) },
      { label: 'Download from the internet', icon: 'import', run: () => downloadArt(local) },
    ] } : null,
    one && !one.stream ? { label: 'Show in Explorer', icon: 'folder', run: () => api.send('shell:show', fileOf(one)) } : null,
    one && !one.stream && engine.track?.path === one.path ? { label: 'Add bookmark here', icon: 'bookmark', run: () => addBookmark() } : null,
    playlist ? '-' : null,
    playlist ? { label: 'Remove from playlist', icon: 'close', run: () => removeFromPlaylist(playlist, rows || tracks.map(t => list.indexOf(t))) } : null,
    one?.stream && S.streams.some(s => s.url === one.path) ? { label: 'Remove stream', icon: 'trash', run: () => { S.streams = S.streams.filter(s => s.url !== one.path); saveStreams(); hooks.render(); } } : null,
    del.length ? '-' : null,
    del.length ? { label: del.length > 1 ? `Delete ${del.length} files…` : 'Delete file…', icon: 'trash', run: () => deleteTracks(del) } : null,
  ]);
}

// ---------- playlists ----------
export async function newPlaylist(tracks = []) {
  const name = await prompt('New playlist', tracks.length === 1 ? tracks[0].album || '' : '', 'Playlist name');
  if (!name) return;
  const p = { id: 'p' + Date.now().toString(36), name, paths: tracks.map(t => t.path), created: Date.now() };
  S.playlists.push(p);
  savePlaylists(); hooks.render();
  toast(`Created “${name}”`);
  return p;
}
export function addToPlaylist(p, tracks) {
  let add = tracks.map(t => t.path);
  if (set.noDuplicates) { const have = new Set(p.paths); add = add.filter(x => !have.has(x)); }
  if (!add.length) return toast(`Already in ${p.name}`);
  if (set.plInsert === 'start') p.paths.unshift(...add);
  else if (set.plInsert === 'shuffled') for (const x of add) p.paths.splice(Math.floor(Math.random() * (p.paths.length + 1)), 0, x);
  else p.paths.push(...add);
  p.updated = Date.now();
  savePlaylists(); hooks.render();
  toast(`Added ${add.length === 1 ? '“' + titleOf(S.byPath.get(add[0]) || tracks[0]) + '”' : add.length + ' songs'} to ${p.name}`);
}
// indices are rows of the visible list; map them back to positions in p.paths (unresolved entries are hidden)
const visibleToRaw = p => { const map = []; p.paths.forEach((x, i) => { if (S.byPath.has(x) || /^https?:/.test(x)) map.push(i); }); return map; };
export function removeFromPlaylist(p, rows) {
  const map = visibleToRaw(p), drop = new Set(rows.map(r => map[r]).filter(i => i != null));
  p.paths = p.paths.filter((_, i) => !drop.has(i));
  savePlaylists(); hooks.render();
  toast(`Removed ${drop.size} ${drop.size === 1 ? 'song' : 'songs'}`);
}
export function movePlaylistItem(p, fromRow, toRow) {
  if (fromRow === toRow || isNaN(fromRow)) return;
  const map = visibleToRaw(p), from = map[fromRow], to = toRow === map.length ? p.paths.length : map[toRow];
  if (from == null || to == null) return;
  const [x] = p.paths.splice(from, 1);
  p.paths.splice(from < to ? to - 1 : to, 0, x);
  savePlaylists(); hooks.render();
}
export function playlistMenu(e, p) {
  menu(e, [
    { label: 'Play', icon: 'play', run: () => playList(plTracks(p), 0, { label: p.name, view: { name: 'playlist', arg: p.id } }) },
    { label: 'Shuffle', icon: 'shuffle', run: () => playList(plTracks(p), -1, { label: p.name }, { shuffle: true }) },
    { label: 'Add to queue', icon: 'queue', run: () => enqueueUI(plTracks(p)) },
    { label: 'Rename…', icon: 'edit', run: async () => { const n = await prompt('Rename playlist', p.name); if (n) { p.name = n; savePlaylists(); hooks.render(); } } },
    { label: 'Remove duplicates', icon: 'refresh', run: () => { const n = p.paths.length; p.paths = [...new Set(p.paths)]; savePlaylists(); hooks.render(); toast(`Removed ${n - p.paths.length} duplicates`); } },
    { label: 'Export as M3U8…', icon: 'export', run: async () => { if (await api.invoke('playlist:export', p.name, p.paths.map(x => S.byPath.get(x)?.file || x))) toast('Playlist exported'); } },
    '-',
    { label: 'Delete playlist…', icon: 'trash', run: async () => {
      if (await confirm('Delete playlist?', `“${p.name}” will be removed. Your music files are not touched.`, 'Delete', true)) {
        S.playlists = S.playlists.filter(x => x !== p); savePlaylists();
        if (S.view?.arg === p.id) go('playlists', null, { replace: true }); else hooks.render();
      }
    } },
  ]);
}
export async function importPlaylists() {
  const lists = await api.invoke('playlist:import');
  for (const l of lists) S.playlists.push({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: l.name, paths: l.paths, created: Date.now() });
  if (lists.length) { savePlaylists(); hooks.render(); toast(`Imported ${lists.length} playlist${lists.length > 1 ? 's' : ''}`); }
}

// ---------- tag editor ----------
const FIELDS = [['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['albumArtist', 'Album artist'], ['genre', 'Genre'], ['year', 'Year'], ['track', 'Track'], ['disc', 'Disc'], ['composer', 'Composer'], ['comment', 'Comment']];
export async function editTags(tracks) {
  const one = tracks.length === 1 ? tracks[0] : null;
  const common = k => { const v = tracks.map(t => t[k] ?? ''); return v.every(x => String(x) === String(v[0])) ? v[0] : null; };
  const inputs = {};
  const form = h('div', { class: 'tag-form' }, ...FIELDS.filter(([k]) => !(tracks.length > 1 && ['title', 'track'].includes(k))).map(([k, l]) => {
    const v = common(k);
    // WAV's RIFF INFO chunk has no fields for these: offering them would silently lose the edit
    const noWav = ['albumArtist', 'disc', 'composer'].includes(k) && tracks.some(t => /\.wav$/i.test(t.file || t.path));
    inputs[k] = h('input', { type: 'text', value: v == null ? '' : (v === 0 ? '' : String(v)), placeholder: noWav ? 'Not supported in WAV files' : v == null ? '(keep different values)' : '', disabled: noWav });
    inputs[k].dataset.orig = inputs[k].value;
    return h('label', {}, h('span', {}, l), inputs[k]);
  }));
  const info = one ? h('div', { class: 'tag-info' }, `${fmtQuality(one)} · ${fmtTime(one.duration)} · ${(one.size / 1048576).toFixed(1)} MB · ${plural(S.stats[one.path]?.plays || 0, 'play')}`, h('div', { class: 'path' }, fileOf(one))) : null;
  const res = await dialog(one ? 'Info / Tags' : `Edit tags · ${tracks.length} files`, h('div', {}, info, form), [{ label: 'Cancel', id: null }, { label: 'Save', primary: true, id: 1 }], true);
  if (!res) return;
  const changes = {};
  for (const [k, el] of Object.entries(inputs)) if (el.value !== el.dataset.orig && !(el.value === '' && el.placeholder)) changes[k] = el.value;
  if (!Object.keys(changes).length) return;
  let ok = 0;
  for (const t of tracks) {
    if (t.cue) continue;
    try { await api.invoke('tags:write', t.path, changes); ok++; } catch (err) { toast(`Couldn’t tag ${titleOf(t)}: ${err.message}`, true); }
  }
  if (ok) toast(`Saved tags for ${ok} file${ok > 1 ? 's' : ''}`);
}

// ---------- album art ----------
export async function pickArt(tracks) {
  const albumTracks = expandAlbum(tracks);
  if (await api.invoke('art:pick', albumTracks.map(t => t.path))) toast('Album art updated');
}
export async function downloadArt(tracks, quiet) {
  const groups = new Map();
  for (const t of expandAlbum(tracks)) { const k = albumKey(t); (groups.get(k) || groups.set(k, []).get(k)).push(t); }
  let got = 0;
  for (const g of groups.values()) {
    const t = g[0];
    try { if (await api.invoke('art:fetch', { artist: names(t.artist)[0] || t.albumArtist, album: t.album, title: t.title, paths: g.map(x => x.path), hires: set.artHiRes })) got++; } catch {}
  }
  if (!quiet) toast(got ? `Downloaded art for ${got} album${got > 1 ? 's' : ''}` : 'No album art found', !got);
  return got;
}
const expandAlbum = tracks => { const keys = new Set(tracks.map(albumKey)); return S.tracks.filter(t => keys.has(albumKey(t)) && tracks.some(x => dirOf(x.path) === dirOf(t.path))); };

// ---------- delete ----------
export async function deleteTracks(tracks) {
  const what = tracks.length === 1 ? `“${titleOf(tracks[0])}”` : `${tracks.length} files`;
  if (!await confirm('Move to Recycle Bin?', `${what} will be moved to the Recycle Bin and removed from your library and playlists. You can restore from the Recycle Bin.`, 'Delete', true)) return;
  const done = new Set(await api.invoke('file:trash', tracks.map(t => t.path)));
  for (const p of S.playlists) p.paths = p.paths.filter(x => !done.has(x));
  savePlaylists();
  toast(`Moved ${done.size} file${done.size === 1 ? '' : 's'} to the Recycle Bin`);
}

// ---------- bookmarks ----------
export async function addBookmark() {
  const t = engine.track;
  if (!t || t.stream) return;
  const pos = engine.position;
  const label = await prompt('Bookmark', `${titleOf(t)} @ ${fmtTime(pos)}`);
  if (!label) return;
  S.bookmarks.push({ path: t.path, pos, label, created: Date.now() });
  saveBookmarks();
  toast('Bookmark added');
}
export function openBookmark(b) {
  const t = S.byPath.get(b.path);
  if (!t) return toast('That song is no longer in your library', true);
  const e = setList([t], 0, { label: 'Bookmark' });
  engine.load(e, { start: b.pos, fade: true });
  hooks.queueChanged();
}

// ---------- streams ----------
export async function addStream() {
  const url = h('input', { type: 'text', placeholder: 'https://… (stream URL, .m3u or .pls)' });
  const name = h('input', { type: 'text', placeholder: 'Name (optional)' });
  const r = await dialog('Add internet radio stream', h('div', { class: 'tag-form' }, h('label', {}, h('span', {}, 'URL'), url), h('label', {}, h('span', {}, 'Name'), name)),
    [{ label: 'Cancel', id: null }, { label: 'Add', primary: true, id: 1 }]);
  if (!r) return;
  const u = url.value.trim();
  if (!/^https?:\/\//i.test(u)) return toast('Stream URLs must start with http:// or https://', true);
  S.streams.push({ url: u, name: name.value.trim() || u.replace(/^https?:\/\//, ''), added: Date.now() });
  saveStreams(); hooks.render();
}
export const playStream = s => playList(S.streams.map(streamTrack), S.streams.indexOf(s), { label: 'Streams', view: { name: 'streams' } });
