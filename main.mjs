import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, net, protocol, Notification, powerSaveBlocker, screen } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parseFile } from 'music-metadata';
import { Exclusive } from './exclusive.mjs';

const require = createRequire(import.meta.url);
const FFMPEG = (require('ffmpeg-static') || '').replace('app.asar', 'app.asar.unpacked');
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WASAPI = path.join(ROOT, 'native', 'cadence-wasapi.exe').replace('app.asar', 'app.asar.unpacked');
const DATA = app.getPath('userData');
const COVERS = path.join(DATA, 'covers');
const CACHE = path.join(DATA, 'cache');
fs.mkdirSync(COVERS, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.mp4', '.m4b', '.aac', '.ogg', '.oga', '.opus', '.spx', '.wav', '.wave', '.w64', '.aif', '.aiff', '.aifc', '.caf', '.wma', '.ape', '.wv', '.tta', '.mpc', '.dsf', '.dff', '.mka', '.webm', '.ac3', '.eac3', '.dts', '.amr', '.3gp', '.alac']);
const isAudio = f => AUDIO_EXT.has(path.extname(f).toLowerCase());
const on = (ch, fn) => ipcMain.on(ch, (...a) => { try { fn(...a); } catch (err) { console.error(ch, err.message); } }); // bad renderer args must never raise a modal error in main
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = v => typeof v === 'string' && v.length > 0 && v.length < 4096 && !v.includes('\0');
const strs = v => Array.isArray(v) && v.length < 1e5 && v.every(str);
const num = (v, lo, hi, d) => typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const under = (f, d) => { const r = path.relative(d, f); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
// UNC/device paths (\\host\share, //host, \\?\, \\.\) make Windows send NTLM credentials to the host: only allow them inside a library folder that is itself a share
const netPath = f => /^[\\/]{2}/.test(f);
const netOk = (f, folders = library.folders) => !netPath(f) || folders.some(d => netPath(d) && under(f, d));
const normFolder = f => path.resolve(/^[a-z]:$/i.test(f) ? f + '\\' : f);
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

// ---------- JSON stores (debounced atomic writes, flushed on quit) ----------
const pending = new Map();
let flushTimer;
const SHAPE = { settings: isObj, stats: isObj, state: isObj, window: isObj, 'window-theme': isObj, library: isObj, playlists: Array.isArray, streams: Array.isArray, bookmarks: Array.isArray };
function readJSON(name, fallback) {
  const f = path.join(DATA, name), ok = SHAPE[name.replace(/\.json$/, '')] || (() => true);
  for (const p of [f, f + '.bak']) {
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    try {
      const j = JSON.parse(text);
      if (ok(j)) { if (p !== f) try { fs.copyFileSync(p, f); } catch {} return j; } // recovered from the last good copy
    } catch {}
    if (p === f) try { fs.copyFileSync(f, f + '.bad'); } catch {} // keep the corrupt file instead of silently overwriting it later
  }
  return fallback;
}
function writeJSON(name, data) {
  pending.set(name, data);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 500);
}
function flush() {
  for (const [name, data] of pending) {
    const f = path.join(DATA, name);
    try {
      fs.writeFileSync(f + '.tmp', JSON.stringify(data));
      try { fs.copyFileSync(f, f + '.bak'); } catch {} // last good copy
      try { fs.renameSync(f + '.tmp', f); } catch { fs.copyFileSync(f + '.tmp', f); fs.rmSync(f + '.tmp', { force: true }); } // AV/indexer lock
      pending.delete(name);
    } catch (err) { console.error('save failed', name, err.message); }
  }
  if (pending.size) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 2000); }
}
const STORES = new Set(['settings', 'playlists', 'stats', 'state', 'streams', 'bookmarks']);
ipcMain.handle('store:get', (e, name) => STORES.has(name) ? readJSON(name + '.json', null) : null);
on('store:set', (e, name, data) => { if (STORES.has(name) && SHAPE[name](data)) writeJSON(name + '.json', data); });

// ---------- window ----------
let win;
const send = (ch, ...a) => win && !win.isDestroyed() && win.webContents.send(ch, ...a);

// clamp a rect onto a connected display's work area (saved bounds may belong to a monitor that is gone)
function fitBounds(b, minW = 960, minH = 620) {
  const areas = screen.getAllDisplays().map(d => d.workArea);
  const w = Math.round(num(b.width, minW, 16000, 1440)), h = Math.round(num(b.height, minH, 16000, 900));
  const x = typeof b.x === 'number' && Number.isFinite(b.x) ? Math.round(b.x) : null, y = typeof b.y === 'number' && Number.isFinite(b.y) ? Math.round(b.y) : null;
  const ov = a => x == null || y == null ? 0 : Math.max(0, Math.min(x + w, a.x + a.width) - Math.max(x, a.x)) * Math.max(0, Math.min(y + h, a.y + a.height) - Math.max(y, a.y));
  let wa = areas.find(a => ov(a) >= 100 * 50) ? areas.reduce((m, a) => ov(a) > ov(m) ? a : m) : null;
  if (!wa) { wa = screen.getPrimaryDisplay().workArea; return { width: Math.min(w, wa.width), height: Math.min(h, wa.height), x: wa.x + Math.max(0, Math.round((wa.width - Math.min(w, wa.width)) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - Math.min(h, wa.height)) / 2)) }; }
  const cw = Math.min(w, wa.width), ch = Math.min(h, wa.height);
  return { width: cw, height: ch, x: Math.min(Math.max(x, wa.x), wa.x + wa.width - cw), y: Math.min(Math.max(y, wa.y), wa.y + wa.height - ch) };
}
let fsSaved = null, mini = false, normal = null, maxed = false, crashes = [], unresponsiveTimer;
function createWindow() {
  const sb = readJSON('window.json', {}), wt0 = readJSON('window-theme.json', {});
  const b = fitBounds(sb); // only geometry is taken from window.json: no other BrowserWindow options can be injected
  const wt = { bg: /^#[0-9a-f]{6}$/i.test(wt0.bg) ? wt0.bg : '#050505', symbolColor: /^#[0-9a-f]{6}$/i.test(wt0.symbolColor) ? wt0.symbolColor : '#e8e8ee' }; // last theme: no dark flash in light mode
  maxed = sb.maximized === true; normal = b;
  win = new BrowserWindow({
    ...b, minWidth: 960, minHeight: 620, show: false,
    backgroundColor: wt.bg, title: 'Cadence', icon: path.join(ROOT, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: wt.symbolColor, height: 38 },
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  if (maxed) win.maximize();
  win.once('ready-to-show', () => win.show());
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const lock = (e, url) => { if (!url.startsWith('app://ui/')) e.preventDefault(); };
  wc.on('will-navigate', lock); wc.on('will-redirect', lock);
  wc.on('render-process-gone', (e, d) => {
    killDecoders(); releaseAwake(); flush();
    if (d.reason === 'clean-exit' || win.isDestroyed()) return;
    const now = Date.now();
    crashes = crashes.filter(t => now - t < 60000); crashes.push(now);
    if (crashes.length <= 3) wc.reload(); // state lives in the stores, so the page comes back where it was
    else dialog.showErrorBox('Cadence', 'The player window keeps crashing. Restart Cadence; your library and settings are safe.');
  });
  wc.on('unresponsive', () => { clearTimeout(unresponsiveTimer); unresponsiveTimer = setTimeout(() => { if (!win.isDestroyed()) wc.forcefullyCrashRenderer(); }, 15000); });
  wc.on('responsive', () => clearTimeout(unresponsiveTimer));
  wc.on('did-start-navigation', e => { if (e.isMainFrame && !e.isSameDocument) { killDecoders(); releaseAwake(); } });
  const track = () => { if (!mini && !win.isFullScreen() && !win.isMaximized() && !win.isMinimized()) normal = win.getBounds(); };
  win.on('resize', track); win.on('move', track);
  win.on('leave-full-screen', () => { if (fsSaved && !mini) { normal = fsSaved; if (!win.isMaximized()) win.setBounds(fitBounds(normal)); } });
  win.on('maximize', () => { if (!mini) maxed = true; });
  win.on('unmaximize', () => { if (!mini) maxed = false; });
  win.on('close', () => { writeJSON('window.json', { ...normal, maximized: maxed }); flush(); });
  win.loadURL('app://ui/index.html');
}
const refit = () => {
  if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
  const cur = win.getBounds(), f = fitBounds(cur, mini ? 300 : 960, mini ? 96 : 620);
  if (f.x !== cur.x || f.y !== cur.y || f.width !== cur.width || f.height !== cur.height) win.setBounds(f);
};
app.whenReady().then(() => { screen.on('display-removed', refit); screen.on('display-metrics-changed', refit); });

// playlists the user opened from Explorer / the command line may be read even when they're outside the library
const openedPlaylists = new Set();
const argFiles = (argv, cwd = process.cwd()) => {
  const files = argv.filter(a => typeof a === 'string' && !a.startsWith('-') && (isAudio(a) || /\.(m3u8?|pls)$/i.test(a))).map(a => path.resolve(cwd, a)).filter(a => fs.existsSync(a));
  files.filter(f => /\.(m3u8?|pls)$/i.test(f)).forEach(f => openedPlaylists.add(f));
  return files;
};

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', (e, argv, workingDirectory) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  const files = argFiles(argv, workingDirectory);
  if (files.length) send('open-files', files);
});

if (gotLock) app.whenReady().then(() => {
  if (!FFMPEG || !fs.existsSync(FFMPEG)) dialog.showErrorBox('Cadence', 'The bundled ffmpeg decoder is missing, so nothing can play. Reinstall Cadence.');
  const roots = new Map([['ui', path.join(ROOT, 'renderer')], ['covers', COVERS], ['mod', path.join(ROOT, 'node_modules')]]);
  protocol.handle('app', async req => {
    try {
      const u = new URL(req.url);
      const root = roots.get(u.host);
      const p = root && path.normalize(path.join(root, decodeURIComponent(u.pathname)));
      if (!p || !p.startsWith(root + path.sep)) return new Response('not found', { status: 404 });
      const r = await net.fetch(pathToFileURL(p).toString());
      if (u.host !== 'covers') return r;
      // covers are read back through <canvas> for the accent colour, so they must be CORS-clean
      const headers = new Headers(r.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'max-age=31536000, immutable');
      return new Response(r.body, { status: r.status, headers });
    } catch { return new Response('not found', { status: 404 }); }
  });
  createWindow();
  watchFolders();
  // incremental scan on startup picks up changes made while the app was closed
  if (library.folders.length) win.webContents.once('did-finish-load', () => setTimeout(() => scan(), 1500));
});
app.on('before-quit', () => { killDecoders(); flush(); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', flush);

ipcMain.handle('app:args', () => argFiles(process.argv));
on('win:progress', (e, value, mode) => win?.setProgressBar(num(value, -1, 1, -1), { mode: ['none', 'normal', 'indeterminate', 'error', 'paused'].includes(mode) ? mode : 'normal' }));
on('win:fullscreen', (e, on) => {
  if (!win) return;
  const want = typeof on === 'boolean' ? on : !win.isFullScreen();
  if (want && !win.isFullScreen()) fsSaved = normal;
  win.setFullScreen(want);
});
on('win:thumbar', (e, buttons) => {
  if (!Array.isArray(buttons)) return;
  win?.setThumbarButtons(buttons.slice(0, 7).filter(b => isObj(b) && typeof b.icon === 'string' && b.icon.startsWith('data:image/') && str(b.cmd)).map(b => ({
    tooltip: String(b.tooltip ?? '').slice(0, 100), icon: nativeImage.createFromDataURL(b.icon), click: () => send('cmd', b.cmd),
  })));
});
on('shell:show', (e, p) => { if (str(p) && path.isAbsolute(p)) shell.showItemInFolder(p); });
ipcMain.handle('dialog:openFiles', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Audio', extensions: [...AUDIO_EXT].map(x => x.slice(1)) }] });
  return r.canceled ? [] : r.filePaths;
});

// ---------- library ----------
let library = readJSON('library.json', null);
if (!isObj(library)) library = {};
library.folders = [...new Set((Array.isArray(library.folders) ? library.folders : []).filter(str).map(normFolder))];
for (const k of ['tracks', 'art', 'artists', 'hosts']) if (!isObj(library[k])) library[k] = {}; // art: user-chosen / downloaded covers (path -> hash); artists: name -> image hash ('' = looked up, nothing found); hosts: audio files replaced by CUE tracks
for (const [p, t] of Object.entries(library.tracks)) if (!isObj(t) || typeof t.path !== 'string') delete library.tracks[p];
if (!Array.isArray(library.filePlaylists)) delete library.filePlaylists;
// Deezer serves a grey silhouette for artists without a photo; never keep it
const DEEZER_PLACEHOLDER = new Set(['aa40d58203c229f79cdcba76b86cf4d2e34937dc']);
for (const k in library.artists) if (DEEZER_PLACEHOLDER.has(library.artists[k])) library.artists[k] = '';
const coverMemo = new Map();

// text sidecars (.lrc/.m3u/.cue): UTF-8/16 by BOM or NULs, else UTF-8 when valid, else windows-1252
function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  if (buf.length > 3 && buf[1] === 0 && buf[3] === 0) return buf.toString('utf16le');
  if (buf.length > 3 && buf[0] === 0 && buf[2] === 0) return new TextDecoder('utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}
const TMP_TAG = /\.cadence-tmp/i, activeTmp = new Set();
async function walk(dir, out, extra) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { if (extra) extra.unreadable.push(dir); return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('.') && !/^(\$recycle\.bin|system volume information)$/i.test(e.name)) await walk(p, out, extra); }
    else if (TMP_TAG.test(e.name)) { if (extra && !activeTmp.has(p)) fsp.stat(p).then(st => { if (Date.now() - st.mtimeMs > 6e5) fsp.rm(p, { force: true }); }).catch(() => {}); } // leftovers of an interrupted tag edit
    else if (isAudio(e.name)) out.push(p);
    else if (extra && /\.cue$/i.test(e.name)) extra.cues.push(p);
    else if (extra && /\.(m3u8?|pls)$/i.test(e.name)) extra.lists.push(p);
  }
  return out;
}

const reach = (f, ms = 3000) => Promise.race([fsp.access(f).then(() => true, () => false), new Promise(r => setTimeout(() => r(false), ms))]); // unreachable network shares must not stall startup

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

function imgDims(b) {
  try {
    if (b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
    if (b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m === 0xff) { i++; continue; }
        if (m === 0 || m === 1 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch {}
  return null;
}
function shrinkImage(data) {
  return new Promise(resolve => {
    const chunks = [];
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0', '-vf', 'scale=1400:-2', '-frames:v', '1', '-q:v', '2', '-f', 'mjpeg', 'pipe:1'], { windowsHide: true });
    const t = setTimeout(() => p.kill(), 30000);
    p.stdout.on('data', b => chunks.push(b));
    p.stdin.on('error', () => {});
    p.on('error', () => resolve(null));
    p.on('close', () => { clearTimeout(t); const out = Buffer.concat(chunks); resolve(out.length ? out : null); });
    p.stdin.end(data);
  });
}
// Writes full-size + 320px thumbnail once per unique image; returns the hash used in app://covers/<hash>[_s].jpg
async function saveCover(data) {
  const hash = sha1(data);
  if (coverMemo.has(hash)) return coverMemo.get(hash);
  const p = (async () => {
    const full = path.join(COVERS, hash + '.jpg');
    if (!fs.existsSync(full)) {
      data = Buffer.from(data);
      const dims = imgDims(data);
      if (dims && dims[0] * dims[1] > 3e7) data = await shrinkImage(data); // never decode a 12k x 12k bitmap in the main process
      if (!data) return null;
      const img = nativeImage.createFromBuffer(data);
      if (img.isEmpty()) return null; // format nativeImage can't decode (e.g. webp)
      const size = img.getSize();
      await fsp.writeFile(full, size.width > 1400 ? img.resize({ width: 1400, quality: 'best' }).toJPEG(92) : img.toJPEG(94));
      await fsp.writeFile(path.join(COVERS, hash + '_s.jpg'), img.resize({ width: 320, quality: 'good' }).toJPEG(86));
    }
    return hash;
  })().catch(() => null);
  coverMemo.set(hash, p);
  return p;
}

let dirCoverMemo = new Map(); // reset at every scan so a cover.jpg added later is noticed
function folderCover(dir) {
  if (!dirCoverMemo.has(dir)) dirCoverMemo.set(dir, (async () => {
    try {
      const names = await fsp.readdir(dir);
      const hit = names.find(n => /^(cover|folder|front|album|artwork)\.(jpe?g|png)$/i.test(n));
      return hit ? await saveCover(await fsp.readFile(path.join(dir, hit))) : null;
    } catch { dirCoverMemo.delete(dir); return null; }
  })());
  return dirCoverMemo.get(dir);
}

// RIFF INFO and old ID3 tags often hold UTF-8 bytes decoded as latin1: undo that when the round trip is clean UTF-8
const unmoji = s => { if (!/[\x80-\xff]/.test(s) || /[^\x00-\xff]/.test(s)) return s; const r = Buffer.from(s, 'latin1').toString('utf8'); return r.includes('\ufffd') ? s : r; };
const cap = (s, n = 500) => typeof s === 'string' ? unmoji(s).slice(0, n) : '';
async function readTrack(file, st, prev) {
  const t = {
    path: file, mtime: st.mtimeMs, size: st.size, added: prev?.added ?? Math.round(Math.min(st.birthtimeMs || Infinity, st.mtimeMs)),
    title: path.basename(file, path.extname(file)), artist: '', album: '', albumArtist: '', genre: '', composer: '',
    year: 0, track: 0, disc: 0, duration: 0, codec: path.extname(file).slice(1).toUpperCase(), container: '',
    bitrate: 0, sampleRate: 0, bits: 0, channels: 0, lossless: false, rg: null, art: null, lyrics: false,
  };
  let parsedCodec;
  try {
    const m = await parseFile(file);
    const c = m.common, f = m.format;
    parsedCodec = f.codec;
    Object.assign(t, {
      title: cap(c.title) || t.title,
      artist: cap(c.artist) || cap((c.artists || []).join(', ')),
      album: cap(c.album), albumArtist: cap(c.albumartist),
      genre: cap((c.genre || []).join(', ')), composer: cap((c.composer || []).join(', ')),
      year: c.year || 0, track: c.track?.no || 0, disc: c.disk?.no || null,
      duration: f.duration || 0, codec: f.codec || t.codec, container: f.container || '',
      bitrate: f.bitrate || 0, sampleRate: f.sampleRate || 0, bits: f.bitsPerSample || 0,
      channels: f.numberOfChannels || 0, lossless: !!f.lossless,
      lyrics: !!c.lyrics?.length,
    });
    const g = (k) => Number.isFinite(c[k]?.dB) ? num(c[k].dB, -40, 40) : null;
    const pk = (k) => Number.isFinite(c[k]?.ratio) ? num(c[k].ratio, 0, 16) : null;
    if (c.replaygain_track_gain || c.replaygain_album_gain)
      t.rg = { tg: g('replaygain_track_gain'), tp: pk('replaygain_track_peak'), ag: g('replaygain_album_gain'), ap: pk('replaygain_album_peak') };
    const pic = c.picture?.find(p => /front/i.test(p.type || '')) || c.picture?.[0];
    if (pic) t.art = await saveCover(pic.data);
  } catch { /* unreadable tags (e.g. wrong extension, fragmented MP4): fall back to ffmpeg below */ }
  if (!t.duration) { Object.assign(t, await probe(file, t)); if (!t.duration) t.retry = (prev?.retry || 0) + 1; } // locked / half-copied file: scan() reads it again later
  else if (!parsedCodec) { const p = await probe(file, t); if (p.codec) Object.assign(t, { codec: p.codec, lossless: p.lossless }); }
  // untagged files named "Title - Artist.ext"
  if (!t.artist && t.title === path.basename(file, path.extname(file)) && t.title.includes(' - ')) {
    const i = t.title.indexOf(' - ');
    Object.assign(t, { artist: t.title.slice(i + 3).trim(), title: t.title.slice(0, i).trim() });
  }
  if (library.art[file]) t.art = library.art[file];
  else if (!t.art) { t.art = await folderCover(path.dirname(file)); if (t.art) t.fart = true; }
  return t;
}

// ffmpeg's own demuxers sniff content, so this works for mislabelled files the tag parser rejects
function probe(file, t) {
  return new Promise(resolve => {
    let err = '';
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true });
    p.stderr.on('data', b => { err += b; });
    p.on('error', () => resolve({}));
    p.on('close', () => {
      const out = {};
      const d = err.match(/Duration: (\d+):(\d+):([\d.]+)/);
      if (d) out.duration = +d[1] * 3600 + +d[2] * 60 + +d[3];
      const a = err.match(/Audio: (\w+)[^,]*, (\d+) Hz, ([^,]+)(?:, ([^,\n]+))?(?:, (\d+) kb\/s)?/);
      if (a) {
        out.codec = a[1].toUpperCase();
        out.sampleRate = +a[2];
        out.channels = /stereo/.test(a[3]) ? 2 : /mono/.test(a[3]) ? 1 : parseInt(a[3]) || 2;
        if (a[5]) out.bitrate = +a[5] * 1000;
        out.lossless = /^(flac|alac|wavpack|ape|tta|pcm|truehd|mlp)/i.test(a[1]);
      }
      const meta = k => err.match(new RegExp(`^\\s{4}${k}\\s*: (.+)$`, 'mi'))?.[1].trim();
      if (!t.artist && meta('artist')) out.artist = cap(meta('artist'));
      if (meta('title') && t.title === path.basename(file, path.extname(file))) out.title = cap(meta('title'));
      if (!t.album && meta('album')) out.album = cap(meta('album'));
      resolve(out);
    });
  });
}

let scanning = null, rescanQueued = false, retryTimer;
function scan(full = false) {
  if (scanning) { rescanQueued = rescanQueued || true; return scanning; }
  scanning = (async () => {
    send('library:progress', { phase: 'listing' });
    dirCoverMemo = new Map();
    const files = [], extra = { cues: [], lists: [], unreadable: [] };
    for (const f of library.folders) { if (await reach(f)) await walk(f, files, extra); else extra.unreadable.push(f); }
    const old = full ? {} : library.tracks, hosts = full ? {} : library.hosts, keep = library.tracks, tracks = {}, todo = [];
    // a root that can't be read (unplugged drive, offline share) keeps its previous entries instead of vanishing
    for (const [p, t] of Object.entries(keep)) if (extra.unreadable.some(d => under(t.file || p, d))) tracks[p] = t;
    for (const [p, t] of Object.entries(library.hosts)) if (extra.unreadable.some(d => under(p, d))) hosts[p] = t;
    for (const f of files) {
      let st;
      try { st = await fsp.stat(f); } catch { continue; }
      const o = old[f] || hosts[f];
      if (o && o.mtime === st.mtimeMs && o.size === st.size && !(o.retry < 5 && !o.duration)) tracks[f] = o;
      else todo.push([f, st]);
    }
    let done = 0;
    await pool(todo, 6, async ([f, st]) => {
      tracks[f] = await readTrack(f, st, keep[f] || library.hosts[f]);
      if (++done % 20 === 0 || done === todo.length) send('library:progress', { phase: 'reading', done, total: todo.length });
    });
    // covers added or changed in a folder after the first scan
    for (const t of Object.values(tracks)) if (!t.cue && (!t.art || t.fart) && !library.art[t.path]) {
      const c = await folderCover(path.dirname(t.path));
      if (c) Object.assign(t, { art: c, fart: true }); else if (t.fart) Object.assign(t, { art: null, fart: false });
    }
    // CUE sheets: virtual tracks replace the big image file they describe. Several sheets for one image: the one named like the image wins, then alphabetical.
    const byLower = new Map(Object.keys(tracks).filter(k => !tracks[k].cue).map(k => [k.toLowerCase(), tracks[k]]));
    const stem = f => path.join(path.dirname(f), path.basename(f, path.extname(f))).toLowerCase();
    const claimed = new Map(), newHosts = {}, cueTracks = [];
    for (const cue of extra.cues.sort((x, y) => x.localeCompare(y))) {
      try {
        for (const vt of await readCue(cue, byLower)) {
          const k = vt.file.toLowerCase(), owner = claimed.get(k);
          if (owner && owner !== cue) {
            if (!(stem(cue) === stem(vt.file) && stem(owner) !== stem(vt.file))) continue;
            for (let i = cueTracks.length; i--;) if (cueTracks[i].cue === owner && cueTracks[i].file.toLowerCase() === k) cueTracks.splice(i, 1);
          }
          claimed.set(k, cue);
          cueTracks.push(vt);
        }
      } catch {}
    }
    for (const vt of cueTracks) {
      const host = byLower.get(vt.file.toLowerCase());
      if (host) newHosts[host.path] = host;
      tracks[vt.path] = { ...vt, added: keep[vt.path]?.added ?? vt.added };
    }
    for (const h of Object.values(newHosts)) delete tracks[h.path];
    for (const [p, h] of Object.entries(hosts)) if (!newHosts[p] && extra.unreadable.some(d => under(p, d))) newHosts[p] = h;
    library.hosts = newHosts;
    library.tracks = tracks;
    library.filePlaylists = extra.lists;
    writeJSON('library.json', library);
    send('library:progress', { phase: 'done', total: Object.keys(tracks).length });
    send('library:changed');
    clearTimeout(retryTimer);
    if (Object.values(tracks).some(t => t.retry < 5 && !t.duration)) retryTimer = setTimeout(() => scan(), 30000);
  })().finally(() => {
    scanning = null;
    if (rescanQueued) { const f = rescanQueued === 'full'; rescanQueued = false; scan(f); }
  });
  return scanning;
}

const cueTime = s => { const m = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(s || ''); return m && +m[2] < 60 && +m[3] < 75 ? +m[1] * 60 + +m[2] + +m[3] / 75 : NaN; };
async function readCue(cuePath, byLower) {
  const text = decodeText(await fsp.readFile(cuePath));
  const dir = path.dirname(cuePath);
  const out = [];
  let file = null, album = '', albumArtist = '', genre = '', year = 0, cur = null;
  const unq = v => v.trim().replace(/^"(.*)"$/, '$1');
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'FILE') { file = path.join(dir, unq(v.replace(/\s+\S+$/, ''))); cur = null; }
    else if (k === 'REM') { const r = v.match(/^(GENRE|DATE)\s+(.*)$/); if (r) { if (r[1] === 'GENRE') genre = cap(unq(r[2])); else year = parseInt(unq(r[2])) || 0; } }
    else if (k === 'TITLE') { if (cur) cur.title = cap(unq(v)); else album = cap(unq(v)); }
    else if (k === 'PERFORMER') { if (cur) cur.artist = cap(unq(v)); else albumArtist = cap(unq(v)); }
    else if (k === 'TRACK') { cur = { no: parseInt(v) || out.length + 1, file }; out.push(cur); }
    else if (k === 'INDEX' && cur && /^01\s/.test(v)) { const t = cueTime(v.split(/\s+/)[1]); if (Number.isFinite(t)) cur.start = t; }
  }
  const res = [];
  out.forEach((c, i) => {
    const host = byLower.get(c.file.toLowerCase());
    if (!host || c.start == null) return;
    const next = out.slice(i + 1).find(x => x.file === c.file && x.start != null);
    const end = next ? next.start : host.duration;
    if (!(end > c.start) || c.start > host.duration + 1) return; // INDEX past the end of the image / out of order
    res.push({
      ...host, path: `${c.file}#${c.no}`, file: c.file, cue: cuePath, cueStart: c.start, cueEnd: end, retry: undefined,
      title: c.title || `Track ${c.no}`, artist: c.artist || albumArtist || host.artist, album: album || host.album,
      albumArtist: albumArtist || host.albumArtist, genre: genre || host.genre, year: year || host.year,
      track: c.no, duration: Math.max(0, end - c.start), rg: null,
    });
  });
  return res;
}

let watchers = [], watchTimer, watchGen = 0, rearmTimer;
async function watchFolders() {
  const gen = ++watchGen;
  watchers.forEach(w => { try { w.close(); } catch {} });
  watchers = [];
  const ok = await Promise.all(library.folders.map(f => reach(f)));
  if (gen !== watchGen) return; // a newer call owns the watchers
  watchers = library.folders.filter((f, i) => ok[i]).map(f => {
    try {
      const w = fs.watch(f, { recursive: true }, (ev, name) => {
        if (!name || /^(\$recycle\.bin|system volume information)(\|$)/i.test(name) || TMP_TAG.test(name) || !(isAudio(name) || /\.(lrc|cue|m3u8?|pls|jpe?g|png)$/i.test(name))) return;
        clearTimeout(watchTimer);
        watchTimer = setTimeout(() => scan(), 4000);
      });
      w.on('error', () => { try { w.close(); } catch {} clearTimeout(rearmTimer); rearmTimer = setTimeout(watchFolders, 30000); }); // folder removed / drive unplugged: try again later
      return w;
    } catch { return null; }
  }).filter(Boolean);
  if (watchers.length < ok.filter(Boolean).length) { clearTimeout(rearmTimer); rearmTimer = setTimeout(watchFolders, 30000); }
}

ipcMain.handle('library:get', () => ({ folders: library.folders, tracks: Object.values(library.tracks), filePlaylists: library.filePlaylists || [], artists: library.artists }));
ipcMain.handle('library:addFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'] });
  if (r.canceled) return library.folders;
  library.folders = [...new Set([...library.folders, ...r.filePaths.filter(str).map(normFolder)])];
  watchFolders();
  scan();
  return library.folders;
});
ipcMain.handle('library:removeFolder', (e, folder) => {
  if (!str(folder)) return library.folders;
  const n = normFolder(folder);
  library.folders = library.folders.filter(f => f !== n && f !== folder);
  watchFolders();
  scan();
  return library.folders;
});
ipcMain.handle('library:rescan', (e, full) => { if (scanning && full) rescanQueued = 'full'; return scan(full === true); });

// Tracks that are not (yet) part of the library: opened files, dropped folders, playlist entries
ipcMain.handle('track:info', async (e, paths) => {
  if (!strs(paths)) return [];
  const files = [];
  for (const p of paths) {
    if (!netOk(p)) continue;
    try {
      const st = await fsp.stat(p);
      if (st.isDirectory()) files.push(...(await walk(p, [])).sort());
      else if (isAudio(p)) files.push(p);
    } catch {}
  }
  const out = [];
  for (const f of files) {
    if (library.tracks[f]) { out.push(library.tracks[f]); continue; }
    try { out.push(await readTrack(f, await fsp.stat(f))); } catch {}
  }
  return out;
});

// ---------- phone migration data (import/phone-*.json, captured from the phone over adb) ----------
ipcMain.handle('import:phone', () => {
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'import', f), 'utf8')); } catch { return null; } };
  const data = read('phone-export.json'), settings = read('phone-settings.json');
  return data || settings ? { data, settings } : null;
});

// ---------- playlists (m3u8) ----------
const plEntry = (dir, l) => {
  if (isUrl(l)) return l;
  let f;
  if (/^file:/i.test(l)) try { f = fileURLToPath(l); } catch {}
  f ??= path.resolve(dir, l);
  return netOk(f) ? f : null;
};
async function parsePlaylist(file) {
  const text = decodeText(await fsp.readFile(file)), dir = path.dirname(file);
  const entries = /\.pls$/i.test(file)
    ? [...text.matchAll(/^File\d+=(.*)$/gmi)].map(m => m[1].trim())
    : text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  return { name: path.basename(file, path.extname(file)), paths: entries.filter(Boolean).map(l => plEntry(dir, l)).filter(Boolean) };
}
ipcMain.handle('playlist:import', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Playlist', extensions: ['m3u', 'm3u8', 'pls'] }] });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(parsePlaylist));
});
ipcMain.handle('playlist:export', async (e, name, paths) => {
  if (typeof name !== 'string' || !Array.isArray(paths) || !paths.every(p => typeof p === 'string')) return false;
  const r = await dialog.showSaveDialog(win, { defaultPath: name.replace(/[\/:*?"<>|]/g, '_').slice(0, 120) + '.m3u8', filters: [{ name: 'Playlist', extensions: ['m3u8'] }] });
  if (r.canceled) return false;
  await fsp.writeFile(r.filePath, '#EXTM3U\n' + paths.join('\n') + '\n', 'utf8');
  return true;
});

// ---------- decoder: ffmpeg -> f32le stereo PCM streamed to the renderer with flow control ----------
const decoders = new Map();
const isUrl = f => /^https?:\/\//i.test(f);
// local files only (plus http(s) for internet radio): never let the renderer point ffmpeg at other protocols
const playable = f => typeof f === 'string' && (isUrl(f) || (path.isAbsolute(f) && !/^[a-z]{2,}:/i.test(f) && netOk(f)));
function killDecoders() { for (const d of decoders.values()) d.proc.kill(); decoders.clear(); xo?.msg({ type: 'stop' }); }
const safeSend = (wc, ...a) => { if (!wc.isDestroyed()) wc.send(...a); };

function atempoChain(t) {
  const out = [];
  while (t > 2) { out.push('atempo=2'); t /= 2; }
  while (t < 0.5) { out.push('atempo=0.5'); t /= 0.5; }
  if (Math.abs(t - 1) > 1e-4) out.push(`atempo=${t.toFixed(5)}`);
  return out;
}

// exclusive mode: s32le at the source rate goes to the WASAPI helper instead of the renderer (see exclusive.mjs)
let xo = null;
on('xo:msg', (e, m) => {
  if (!isObj(m)) return;
  xo ||= new Exclusive({ spawn: dev => spawn(WASAPI, [dev], { windowsHide: true }), send: msg => safeSend(e.sender, 'xo:msg', msg), ack });
  xo.msg(m);
});

on('dec:start', (e, a) => {
  if (!isObj(a)) return;
  const { id, file, exclusive, resample } = a;
  if (!(typeof id === 'string' || Number.isFinite(id))) return;
  if (!playable(file)) return safeSend(e.sender, 'dec:error', id, 'unsupported location');
  // every number ends up inside an ffmpeg argument or filter string: clamp them
  const rate = Math.round(num(a.rate, 8000, 384000, 48000)), start = num(a.start, 0, 1e6, 0), length = a.length ? num(a.length, 0.001, 1e6, null) : null;
  const tempo = num(a.tempo, 0.1, 10, 1), pitch = num(a.pitch, 0.25, 4, 1), bufferSec = num(a.bufferSec, 1, 120, 20), bits = a.bits >= 8 ? num(a.bits, 8, 32, undefined) : a.bits ? 24 : undefined; // DSD reports 1 bit: it is decoded as 24-bit PCM
  const srcBits = num(a.srcBits, 1, 64, 24);
  const ua = typeof a.ua === 'string' ? a.ua.replace(/[^\x20-\x7e]/g, '').slice(0, 200) : '';
  const url = isUrl(file);
  const prev = decoders.get(id);
  if (prev) { decoders.delete(id); prev.proc.kill(); } // same id restarted: don't leak the old ffmpeg
  if (exclusive) xo?.open(id, rate, bits);
  // resample to the output rate first, then pitch (asetrate) + tempo compensation so duration only follows `tempo`
  const af = [`aresample=${rate}:filter_size=64:cutoff=0.98`];
  if (Math.abs(pitch - 1) > 1e-4) af.push(`asetrate=${Math.round(rate * pitch)}`, `aresample=${rate}:filter_size=64`);
  af.push(...atempoChain(tempo / pitch));
  // 16-bit device fed from a deeper source: TPDF dither at the 16-bit step (the s16 result widens to s32 exactly)
  const xaf = [...(resample ? [af[0]] : []), ...(exclusive && bits && bits <= 16 && bits < srcBits ? ['aresample=osf=s16:dither_method=triangular'] : [])];
  const args = ['-hide_banner', '-loglevel', url ? 'info' : 'error', '-nostdin',
    ...(url ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-user_agent', ua || 'Cadence/0.1', '-icy', '1'] : []),
    ...(start > 0 ? ['-ss', start.toFixed(3)] : []),
    ...(length ? ['-t', length.toFixed(3)] : []),
    '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn', ...(exclusive ? (xaf.length ? ['-af', xaf.join(',')] : []) : ['-af', af.join(',')]),
    '-f', exclusive ? 's32le' : 'f32le', '-ac', '2', '-ar', String(rate), 'pipe:1'];
  const proc = spawn(FFMPEG, args, { windowsHide: true });
  const d = { proc, sent: 0, acked: 0, limit: rate * 8 * bufferSec, paused: false, rest: null, err: '', title: '' };
  decoders.set(id, d);
  proc.stdout.on('data', buf => {
    if (d.rest) { buf = Buffer.concat([d.rest, buf]); d.rest = null; }
    const n = buf.length - (buf.length % 8);
    if (n < buf.length) d.rest = buf.subarray(n);
    if (!n) return;
    if (exclusive) xo?.data(id, buf.subarray(0, n)); else safeSend(e.sender, 'dec:data', id, buf.subarray(0, n));
    d.sent += n;
    if (d.sent - d.acked > d.limit) { proc.stdout.pause(); d.paused = true; }
  });
  proc.stderr.on('data', b => {
    d.err = (d.err + b).slice(-4000);
    if (!url) return;
    // ICY "now playing" titles from internet radio
    const m = String(b).match(/StreamTitle\s*:\s*(.*)/) || String(b).match(/icy-name\s*:\s*(.*)/);
    if (m && m[1].trim() && m[1].trim() !== d.title) { d.title = m[1].trim(); safeSend(e.sender, 'dec:meta', id, d.title); }
  });
  proc.on('close', code => {
    if (decoders.get(id) !== d) return;
    decoders.delete(id);
    if (exclusive) xo?.end(id);
    if (code && !d.sent) safeSend(e.sender, 'dec:error', id, d.err.trim().split('\n').pop() || `ffmpeg exited ${code}`);
    else safeSend(e.sender, 'dec:end', id);
  });
  proc.on('error', err => safeSend(e.sender, 'dec:error', id, err.message));
});
function ack(id, bytes) {
  const d = decoders.get(id);
  if (!d) return;
  d.acked += bytes;
  if (d.paused && d.sent - d.acked < d.limit / 2) { d.paused = false; d.proc.stdout.resume(); }
}
on('dec:ack', (e, id, bytes) => ack(id, num(bytes, 0, 1e9, 0)));
on('dec:stop', (e, id) => {
  const d = decoders.get(id);
  if (d) { decoders.delete(id); d.proc.kill(); }
  xo?.forget(id);
});
on('dec:reset', killDecoders);

// ---------- waveform (peaks for the seek bar) ----------
const waveJobs = new Map(); // identical requests share one ffmpeg run
ipcMain.handle('waveform', (e, t, bins = 600) => {
  if (!isObj(t)) return null;
  bins = Math.round(num(bins, 8, 4000, 600));
  const file = t.file || t.path;
  if (!playable(file) || isUrl(file)) return null;
  const cs = t.cueStart != null ? num(t.cueStart, 0, 1e6, 0) : null, cl = cs != null ? num(t.cueEnd - cs, 0.01, 1e6, 1e6) : null;
  const id = [file, cs, cl, bins].join('|');
  if (!waveJobs.has(id)) waveJobs.set(id, waveform(file, String(t.path), cs, cl, bins).catch(() => null).finally(() => waveJobs.delete(id)));
  return waveJobs.get(id);
});
async function waveform(file, tpath, cs, cl, bins) {
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  const key = path.join(CACHE, 'w_' + sha1(tpath + st.mtimeMs + bins) + '.json');
  try { return JSON.parse(await fsp.readFile(key, 'utf8')); } catch {}
  const range = cs != null ? ['-ss', String(cs), '-t', String(cl)] : [];
  const peaks = await new Promise(resolve => {
    const blocks = []; let cur = 0, n = 0, rest = null;
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...range, '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '4000', '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    const timer = setTimeout(() => p.kill(), 120000); // a hung network read must not pin the job forever
    p.stdout.on('data', buf => {
      if (rest) { buf = Buffer.concat([rest, buf]); rest = null; }
      const len = buf.length - (buf.length % 4);
      if (len < buf.length) rest = buf.subarray(len);
      for (let i = 0; i < len; i += 4) {
        const v = Math.abs(buf.readFloatLE(i));
        if (v > cur) cur = v;
        if (++n === 200) { blocks.push(cur); cur = 0; n = 0; }
      }
    });
    p.on('close', () => {
      clearTimeout(timer);
      if (!blocks.length) return resolve(null);
      const out = new Array(bins).fill(0);
      for (let i = 0; i < blocks.length; i++) { const b = Math.floor(i * bins / blocks.length); if (blocks[i] > out[b]) out[b] = blocks[i]; }
      const max = out.reduce((m, v) => v > m ? v : m, 0) || 1;
      resolve(out.map(v => +(v / max).toFixed(3)));
    });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
  });
  if (peaks) fsp.writeFile(key, JSON.stringify(peaks)).catch(() => {});
  return peaks;
}

// ---------- lyrics: .lrc sidecar > embedded tag > lrclib.net ----------
ipcMain.handle('lyrics:get', async (e, t, online) => {
  if (!isObj(t)) return null;
  const file = t.file || t.path;
  if (!playable(file)) return null;
  if (isUrl(file)) t = { ...t, path: '' };
  const base = file.slice(0, -path.extname(file).length);
  if (isUrl(file) || t.cue) { /* no sidecar/tag for streams and CUE tracks: go straight online */ } else {
  for (const ext of ['.lrc', '.LRC'])
    try { const text = decodeText(await fsp.readFile(base + ext)); if (text.trim() && !text.includes('\0')) return { source: 'LRC file', text }; } catch {}
  try {
    const m = await parseFile(typeof t.path === 'string' && netOk(t.path) ? t.path : file, { skipCovers: true });
    // Prefer the raw tag value: it keeps enhanced (word-level) LRC timing that the parsed form drops
    for (const tag of Object.values(m.native).flat())
      if (/^(LYRICS|UNSYNCEDLYRICS|©lyr)$/i.test(tag.id) && typeof tag.value === 'string' && tag.value.trim())
        return { source: 'Embedded', text: tag.value };
    const ly = m.common.lyrics?.[0];
    if (ly?.syncText?.length && ly.timeStampFormat === 2)
      return { source: 'Embedded', synced: ly.syncText.map(s => ({ t: (s.timestamp ?? 0) / 1000, text: s.text })) };
    if (ly) return { source: 'Embedded', text: typeof ly === 'string' ? ly : ly.text };
  } catch {}
  }
  if (!online || t.stream || typeof t.title !== 'string' || !t.title) return null;
  const key = path.join(CACHE, 'l_' + sha1([t.artist, t.title, t.album].join('|').toLowerCase()) + '.json');
  try {
    const c = JSON.parse(await fsp.readFile(key, 'utf8'));
    if (c.text || Date.now() - c.at < 864e5) return c.text ? { source: 'LRCLIB', text: c.text } : null;
  } catch {}
  const headers = { 'User-Agent': 'Cadence/0.1 (desktop music player)' };
  const q = new URLSearchParams({ track_name: t.title, artist_name: (t.artist || '').split(/,|&| feat\.? /i)[0].trim() });
  let text = null, outage = false;
  const opt = { headers, signal: AbortSignal.timeout(10000) };
  try {
    const g = new URLSearchParams(q);
    if (t.album) g.set('album_name', t.album);
    if (t.duration) g.set('duration', String(Math.round(t.duration)));
    let r = await net.fetch('https://lrclib.net/api/get?' + g, opt);
    if (r.ok) { const j = await r.json(); text = j.syncedLyrics || j.plainLyrics || null; }
    else if (r.status !== 404) outage = true; // 429 / 5xx: the service is down, not a genuine miss
    if (!text) {
      r = await net.fetch('https://lrclib.net/api/search?' + q, { headers, signal: AbortSignal.timeout(10000) });
      if (!r.ok) outage = true;
      else {
        const list = await r.json();
        if (!Array.isArray(list)) throw new Error('bad reply');
        const best = list.find(x => x.syncedLyrics && (!t.duration || Math.abs(x.duration - t.duration) < 4)) || list.find(x => x.syncedLyrics) || list[0];
        text = best ? (best.syncedLyrics || best.plainLyrics) : null;
      }
    }
  } catch { return null; } // offline: don't cache the miss
  if (!text && outage) return null;
  fsp.writeFile(key, JSON.stringify({ text, at: Date.now() })).catch(() => {});
  return text ? { source: 'LRCLIB', text } : null;
});

// ---------- tag editor: ffmpeg stream-copies audio + art and rewrites tags; original is only replaced after verification ----------
const runFfmpeg = args => new Promise((resolve, reject) => {
  let err = '';
  const p = spawn(FFMPEG, args, { windowsHide: true });
  p.stderr.on('data', b => { err = (err + b).slice(-3000); });
  p.on('error', reject);
  p.on('close', code => code ? reject(new Error(err.trim().split('\n').pop() || 'ffmpeg failed')) : resolve(err));
});
const TAG_KEYS = { title: 'title', artist: 'artist', album: 'album', albumArtist: 'album_artist', genre: 'genre', year: 'date', track: 'track', disc: 'disc', composer: 'composer', comment: 'comment' };
// only real, non-CUE library tracks may be modified or trashed (no arbitrary paths, no UNC unless a library folder is UNC)
const libTrack = f => { const t = typeof f === 'string' && f.length < 4096 ? library.tracks[f] : null; return t && !t.cue && library.folders.some(d => under(f, d)) ? t : null; };
const tagLocks = new Map(); // edits of one file run one after another
ipcMain.handle('tags:write', (e, file, tags) => {
  if (!libTrack(file)) throw new Error('Only tracks inside your library folders can be tagged');
  if (!isObj(tags)) throw new Error('Invalid tags');
  const run = (tagLocks.get(file) || Promise.resolve()).catch(() => {}).then(() => writeTags(file, tags));
  tagLocks.set(file, run);
  run.catch(() => {}).then(() => { if (tagLocks.get(file) === run) tagLocks.delete(file); });
  return run;
});
async function replaceFile(tmp, file) {
  for (let i = 0; ; i++) {
    try { return await fsp.rename(tmp, file); } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      if (i >= 8) throw new Error('Cannot save the tags: the file is in use (is it playing?) or locked by another program. Stop playback of it and try again.');
      await sleepMs(400);
    }
  }
}
async function writeTags(file, tags) {
  const ext = path.extname(file);
  const tmp = path.join(path.dirname(file), `.cadence-tmp-${crypto.randomBytes(5).toString('hex')}${ext}`); // short name: long file names would overflow MAX_PATH
  activeTmp.add(tmp);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0', '-c', 'copy', '-map_metadata', '0'];
  // mislabelled files (e.g. MP3 data in a .flac): write the container that matches the real codec
  const real = (await probe(file, {})).codec;
  const fmt = { MP3: 'mp3', FLAC: 'flac', AAC: 'ipod', ALAC: 'ipod', OPUS: 'ogg', VORBIS: 'ogg' }[real];
  const extFmt = { '.mp3': 'mp3', '.flac': 'flac', '.m4a': 'ipod', '.mp4': 'ipod', '.ogg': 'ogg', '.opus': 'ogg', '.oga': 'ogg' }[ext.toLowerCase()];
  if (fmt && fmt !== extFmt) args.push('-f', fmt);
  if (fmt === 'mp3' || /\.mp3$/i.test(ext)) args.push('-id3v2_version', '3');
  let total = 0;
  for (const [k, v0] of Object.entries(tags)) if (TAG_KEYS[k]) {
    const v = String(v0 ?? '').replace(/\u0000/g, '').slice(0, Math.max(0, Math.min(8000, 24000 - total))); // the whole command line is limited to 32 KB
    total += v.length;
    args.push('-metadata', `${TAG_KEYS[k]}=${v}`);
    if ((fmt || extFmt) === 'ogg') args.push('-metadata:s:a:0', `${TAG_KEYS[k]}=${v}`); // Ogg/Opus keep tags per stream, which win over the global ones
  }
  if (fmt === 'mp3' && 'year' in tags) args.push('-metadata', `TYER=${String(tags.year ?? '').slice(0, 16)}`); // ID3v2.3 year frame
  args.push(tmp);
  let ro = false;
  try {
    await runFfmpeg(args);
    const [a, b] = await Promise.all([probe(file, {}), probe(tmp, {})]);
    if (!b.duration || Math.abs((a.duration || 0) - b.duration) > 0.5) throw new Error('verification failed: output duration differs');
    ro = !((await fsp.stat(file)).mode & 0o200);
    if (ro) await fsp.chmod(file, 0o666);
    await replaceFile(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  } finally {
    activeTmp.delete(tmp);
    if (ro) await fsp.chmod(file, 0o444).catch(() => {});
  }
  const st = await fsp.stat(file);
  const t = await readTrack(file, st, library.tracks[file]);
  if (library.tracks[file]) { library.tracks[file] = t; writeJSON('library.json', library); send('library:changed'); }
  return t;
}

// ---------- delete to Recycle Bin ----------
ipcMain.handle('file:trash', async (e, paths) => {
  if (!strs(paths)) return [];
  const done = [];
  for (const p of paths) {
    if (!libTrack(p)) continue; // CUE virtual tracks share the album image; anything outside the library is off limits
    try { await shell.trashItem(p); done.push(p); delete library.tracks[p]; } catch {}
  }
  writeJSON('library.json', library);
  send('library:changed');
  return done;
});

// ---------- album art: pick a file, download from iTunes, clear cache ----------
function setArt(paths, hash) {
  for (const p of paths) {
    library.art[p] = hash;
    if (library.tracks[p]) library.tracks[p].art = hash;
  }
  writeJSON('library.json', library);
  send('library:changed');
  return hash;
}
ipcMain.handle('art:pick', async (e, paths) => {
  if (!strs(paths)) return null;
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'bmp'] }] });
  if (r.canceled) return null;
  const hash = await saveCover(await fsp.readFile(r.filePaths[0]));
  return hash ? setArt(paths, hash) : null;
});
ipcMain.handle('art:fetch', async (e, o) => {
  if (!isObj(o) || !strs(o.paths)) return null;
  const { paths, hires = true } = o, artist = typeof o.artist === 'string' ? o.artist : '', album = typeof o.album === 'string' ? o.album : '', title = typeof o.title === 'string' ? o.title : '';
  const term = [artist, album || title].filter(Boolean).join(' ');
  if (!term.trim()) return null;
  const r = await net.fetch('https://itunes.apple.com/search?' + new URLSearchParams({ term, entity: album ? 'album' : 'song', limit: '5' }));
  if (!r.ok) return null;
  const { results = [] } = await r.json();
  const norm = s => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const hit = results.find(x => norm(x.collectionName).includes(norm(album)) || norm(album).includes(norm(x.collectionName))) || results[0];
  if (!hit?.artworkUrl100) return null;
  const img = await net.fetch(hit.artworkUrl100.replace('100x100bb', hires ? '1400x1400bb' : '600x600bb'));
  if (!img.ok) return null;
  const hash = await saveCover(Buffer.from(await img.arrayBuffer()));
  return hash ? setArt(paths, hash) : null;
});
ipcMain.handle('art:cleanup', async () => {
  await scanning?.catch(() => {}); // a scan in progress is still writing covers that no track references yet
  const used = new Set([...Object.values(library.tracks).map(t => t.art), ...Object.values(library.artists || {}), ...Object.values(library.art || {})].filter(Boolean));
  let removed = 0;
  coverMemo.clear();
  for (const f of await fsp.readdir(COVERS)) {
    const hash = f.replace(/(_s)?\.jpg$/, '');
    if (!used.has(hash) && Date.now() - (await fsp.stat(path.join(COVERS, f)).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > 120000) { await fsp.rm(path.join(COVERS, f), { force: true }); removed++; }
  }
  coverMemo.clear();
  return removed;
});

// ---------- file playlists found in music folders (.m3u/.m3u8/.pls) ----------
ipcMain.handle('playlist:readFile', async (e, file) => (str(file) && ((library.filePlaylists || []).includes(file) || openedPlaylists.has(file))) ? parsePlaylist(file) : null);

// ---------- AutoEq headphone profiles (github.com/jaakkopasanen/AutoEq) ----------
const AUTOEQ = 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/';
ipcMain.handle('autoeq:index', async () => {
  const key = path.join(CACHE, 'autoeq-index.json');
  try {
    const c = JSON.parse(await fsp.readFile(key, 'utf8'));
    if (Date.now() - c.at < 7 * 864e5) return c.list;
  } catch {}
  const r = await net.fetch(AUTOEQ + 'INDEX.md');
  if (!r.ok) throw new Error('AutoEq index unavailable');
  const list = [...(await r.text()).matchAll(/^- \[(.+?)\]\(\.\/(.+?)\) by (.+)$/gm)].map(m => ({ name: m[1], path: m[2], source: m[3] }));
  fsp.writeFile(key, JSON.stringify({ at: Date.now(), list })).catch(() => {});
  return list;
});
ipcMain.handle('autoeq:get', async (e, item) => {
  if (!isObj(item) || !str(item.path) || !str(item.name) || item.path.split('/').includes('..')) throw new Error('Profile not found');
  const r = await net.fetch(AUTOEQ + item.path + '/' + encodeURIComponent(item.name + ' ParametricEQ.txt'));
  if (!r.ok) throw new Error('Profile not found');
  const text = await r.text();
  const map = { PK: 'peaking', LSC: 'lowshelf', HSC: 'highshelf', LS: 'lowshelf', HS: 'highshelf', LP: 'lowpass', HP: 'highpass', NO: 'notch' };
  const preamp = parseFloat(text.match(/Preamp:\s*(-?[\d.]+)/)?.[1] || '0');
  const bands = [...text.matchAll(/Filter \d+: ON (\w+) Fc ([\d.]+) Hz(?: Gain (-?[\d.]+) dB)?(?: Q ([\d.]+))?/g)]
    .filter(m => map[m[1]]).map(m => ({ type: map[m[1]], freq: +m[2], gain: +(m[3] || 0), q: +(m[4] || 0.71) }));
  return { preamp, bands };
});

// ---------- backup / restore ----------
ipcMain.handle('backup:export', async (e, data) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: `Cadence backup ${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'Cadence backup', extensions: ['json'] }] });
  if (r.canceled) return false;
  if (!isObj(data)) return false;
  await fsp.writeFile(r.filePath, JSON.stringify({ app: 'Cadence', version: 1, at: Date.now(), ...data }, null, 1));
  return true;
});
ipcMain.handle('backup:import', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Cadence backup', extensions: ['json'] }] });
  if (r.canceled) return null;
  try {
    if ((await fsp.stat(r.filePaths[0])).size > 64e6) return null;
    const j = JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8'));
    if (!isObj(j) || j.app !== 'Cadence') return null;
    const out = { app: 'Cadence' }; // only well-typed known sections go back to the renderer
    for (const k of ['settings', 'stats']) if (isObj(j[k])) out[k] = j[k];
    for (const k of ['playlists', 'streams', 'bookmarks']) if (Array.isArray(j[k])) out[k] = j[k];
    return out;
  } catch { return null; }
});

// ---------- desktop integration ----------
on('notify', (e, o) => {
  if (!Notification.isSupported() || !isObj(o)) return;
  const { title, body, art } = o;
  const icon = /^[0-9a-f]{40}$/.test(art) ? nativeImage.createFromPath(path.join(COVERS, art + '_s.jpg')) : undefined;
  const n = new Notification({ title: String(title ?? '').slice(0, 200), body: String(body ?? '').slice(0, 500), icon, silent: true });
  n.on('click', () => { win?.show(); win?.focus(); });
  n.show();
});
let blocker = null;
function releaseAwake() { if (blocker != null) { powerSaveBlocker.stop(blocker); blocker = null; } } // the reloaded page asks again if it still wants it
on('power:keepAwake', (e, on) => {
  if (on === true && blocker == null) blocker = powerSaveBlocker.start('prevent-display-sleep');
  if (on !== true) releaseAwake();
});
on('win:mini', (e, on) => {
  if (!win || typeof on !== 'boolean' || on === mini) return;
  mini = on; // normal / maxed keep describing the real window while mini or fullscreen toggles
  if (on) {
    if (win.isFullScreen()) win.setFullScreen(false);
    if (win.isMaximized()) win.unmaximize();
    win.setMinimumSize(300, 96);
    const wa = screen.getDisplayMatching(win.getBounds()).workArea, cur = win.getBounds();
    win.setBounds({ ...cur, width: 420, height: 132, x: Math.min(Math.max(cur.x, wa.x), wa.x + wa.width - 420), y: Math.min(Math.max(cur.y, wa.y), wa.y + wa.height - 132) });
    win.setAlwaysOnTop(true, 'floating');
    win.setTitleBarOverlay?.({ height: 30 });
  } else {
    win.setAlwaysOnTop(false);
    win.setMinimumSize(960, 620);
    if (normal) win.setBounds(fitBounds(normal));
    if (maxed) win.maximize();
    win.setTitleBarOverlay?.({ height: 38 });
  }
});
// the window's own background shows in freshly exposed areas while a fast resize waits for the page to repaint
// the layout holds down to 640 CSS px: page zoom (Ctrl +) may not squeeze it further
on('win:fitzoom', (e, cssWidth) => {
  const w = num(cssWidth, 1, 1e5, 0), wc = win?.webContents;
  if (wc && w && w < 640) wc.setZoomFactor(Math.max(0.25, wc.getZoomFactor() * w / 640));
});
on('win:theme', (e, o) => {
  if (!isObj(o)) return;
  const { bg } = o, symbolColor = /^#[0-9a-f]{6}$/i.test(o.symbolColor || '') ? o.symbolColor : '#e8e8ee';
  win?.setTitleBarOverlay?.({ symbolColor });
  if (/^#[0-9a-f]{6}$/i.test(bg || '')) { win?.setBackgroundColor(bg); writeJSON('window-theme.json', { bg, symbolColor }); }
});
on('shell:open', (e, url) => { if (typeof url === 'string' && url.length < 2048 && /^https:\/\//.test(url)) shell.openExternal(url); });

// ---------- scrobbling: ListenBrainz (token-based, no app secret needed) ----------
ipcMain.handle('scrobble:listenbrainz', async (e, token, type, t, listenedAt) => {
  if (!str(token) || !['single', 'playing_now', 'import'].includes(type) || !isObj(t) || typeof t.title !== 'string') return false;
  listenedAt = num(listenedAt, 0, 4e12, Date.now());
  const payload = [{
    ...(type === 'single' ? { listened_at: Math.floor(listenedAt / 1000) } : {}),
    track_metadata: { artist_name: t.artist || 'Unknown artist', track_name: t.title, release_name: t.album || undefined, additional_info: { media_player: 'Cadence', duration_ms: Math.round((t.duration || 0) * 1000) } },
  }];
  const r = await net.fetch('https://api.listenbrainz.org/1/submit-listens', {
    method: 'POST', headers: { Authorization: 'Token ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ listen_type: type, payload }),
  });
  return r.ok;
});

// ---------- artist images (Deezer public search API, no key) ----------
ipcMain.handle('art:artists', async (e, names, force) => {
  if (!strs(names)) return library.artists;
  let changed = 0;
  for (const name of names) {
    if (!force && name in library.artists) continue;
    try {
      const r = await net.fetch('https://api.deezer.com/search/artist?' + new URLSearchParams({ q: name, limit: '3' }));
      const j = r.ok ? await r.json() : null;
      const norm = s => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      const hit = j?.data?.find(a => norm(a.name) === norm(name)) || null;
      const url = hit?.picture_xl || hit?.picture_big;
      if (!url || /\/artist\/\/|images\/artist\/\/|d41d8cd98f00b204e9800998ecf8427e|764febc84ac95d8bf15dbb26d41d0b81/.test(url)) { library.artists[name] = ''; continue; }
      const img = await net.fetch(url);
      const data = img.ok ? Buffer.from(await img.arrayBuffer()) : null;
      library.artists[name] = data && !DEEZER_PLACEHOLDER.has(sha1(data)) ? (await saveCover(data)) || '' : '';
      changed++;
    } catch { /* offline: try again next time */ }
  }
  writeJSON('library.json', library);
  return library.artists;
});
