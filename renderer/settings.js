// Settings screen (grouped like settings tree) with search.
import { h, icon, signed } from './util.js';
import { S, set, engine, saveSettings, saveStats, skipFadeSec, allowXf, DEFAULTS } from './core.js';
import { toggle, rangeInput, toast, confirm, dropdown } from './ui.js';
import { render, crossfade } from './views.js';
import { clearLyricsCache } from './lyricsview.js';
import { applyDevicePreset } from './eq.js';
import { applyTheme, applyAccentFromArt, importPhone, exportBackup, importBackup, reindex, fetchArtistImages, syncEngine, syncMediaKeys } from './app.js';
import { downloadArt } from './actions.js';

let query = '';
export function applyFades() {
  engine.setCrossfade(set.xfMode === 'none' ? 0 : set.crossfadeLen);
  Object.assign(engine.o, { skipFade: skipFadeSec(), fadePause: set.fadePause, seekFade: set.seekFade });
  engine.allowXf = allowXf;
  engine.setGap(set.gap);
}
const applyRg = () => engine.setReplayGain(set.rgMode, set.rgPreamp, set.noRgPreamp, set.preventClip);

export function settingsView() {
  const row = (title, desc, ctl) => {
    const r = h('div', { class: 'set-row', dataset: { q: (title + ' ' + (desc || '')).toLowerCase() } },
      h('div', { class: 'txt' }, h('b', {}, title), desc ? h('span', {}, desc) : null), h('div', { class: 'ctl' }, ctl));
    // controls are built labelled with their setting key: the row title is the accessible name
    r.querySelectorAll('[aria-label]').forEach(c => { if (Object.hasOwn(set, c.getAttribute('aria-label'))) c.setAttribute('aria-label', title); });
    return r;
  };
  const sw = (key, after = () => {}) => toggle(!!set[key], v => { set[key] = v; saveSettings(); after(v); }, key);
  const sel = (key, opts, after = () => {}) => dropdown({ label: key, value: set[key], options: opts, onChange: v => { set[key] = v; saveSettings(); after(v); } });
  const slider = (key, min, max, step, fmt, after = () => {}, commit) => {
    const o = h('output', {}, fmt(set[key]));
    return [rangeInput({ min, max, step, value: set[key], label: key, onInput: v => { set[key] = v; o.textContent = fmt(v); saveSettings(); after(v); }, onChange: commit }), o];
  };
  // in-app colour choice instead of the OS colour dialog; a custom colour already in use stays as the first swatch
  const ACCENTS = ['#ff8a3d', '#ff5d73', '#e85fd0', '#a77bff', '#6c8cff', '#3fb6ff', '#2fd3c0', '#4fd27a', '#c6e05a', '#ffd24a', '#e8e4dc'];
  const accentSwatches = () => {
    const wrap = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Accent colour' });
    const draw = () => wrap.replaceChildren(...[...new Set([set.accent.toLowerCase(), ...ACCENTS])].map(c => h('button', {
      class: 'swatch' + (set.accent.toLowerCase() === c ? ' on' : ''), style: { '--c': c }, role: 'radio', 'aria-checked': String(set.accent.toLowerCase() === c), 'aria-label': c,
      onclick: () => { set.accent = c; saveSettings(); applyAccentFromArt(); draw(); } })));
    draw();
    return wrap;
  };
  const btn = (label, run, ic) => h('button', { class: 'tb-btn', onclick: run }, ic ? icon(ic, 'sm') : null, label);
  let gi = 0;
  const group = (title, ...rows) => h('div', { class: 'set-group reveal', style: { '--i': String(gi++ % 6) }, dataset: { title: title.toLowerCase() } }, h('h2', {}, title), ...rows);

  const devSel = dropdown({ label: 'Output device', value: set.device, options: [['', 'System default']], onChange: v => { set.device = v; saveSettings(); engine.setOutput(set.device, set.sampleRate).then(applyDevicePreset); } });
  navigator.mediaDevices.enumerateDevices().then(ds => devSel.setOptions([['', 'System default'],
    ...ds.filter(d => d.kind === 'audiooutput' && !['default', 'communications'].includes(d.deviceId)).map(d => [d.deviceId, d.label || 'Output ' + d.deviceId.slice(0, 6)])]));
  const folders = h('div');
  const drawFolders = () => folders.replaceChildren(...S.folders.map(f => h('div', { class: 'folder-row' }, icon('folder', 'sm'), h('span', { class: 'p' }, f),
    h('button', { class: 'icon-btn', title: 'Remove folder', 'aria-label': 'Remove folder', onclick: async () => { S.folders = await api.invoke('library:removeFolder', f); drawFolders(); } }, icon('close', 'sm')))),
    ...(S.folders.length ? [] : [h('div', { class: 'folder-row muted' }, 'No music folders yet')]));
  drawFolders();

  const search = h('input', { type: 'search', class: 'set-search', placeholder: 'Search settings', value: query, 'aria-label': 'Search settings' });
  const body = h('div', { class: 'settings' },
    group('Library',
      folders,
      row('Music folders', 'Folders are watched: new, changed and removed files are picked up automatically.', btn('Add folder', async () => { S.folders = await api.invoke('library:addFolder'); drawFolders(); }, 'plus')),
      row('Rescan', `${S.tracks.length} songs, ${S.albums.length} albums. Full rescan re-reads every tag.`, [btn('Rescan', () => api.invoke('library:rescan', false)), btn('Full rescan', () => api.invoke('library:rescan', true))]),
      row('Ignore short tracks', 'Hide notification sounds and other clips shorter than this.', slider('ignoreShort', 0, 60, 1, v => v ? v + ' s' : 'Off', () => {}, reindex)),
      row('Split multiple artists', 'Treat “A, B & C feat. D” as separate artists in Artists.', sw('splitArtists', reindex)),
      row('Count as played after', 'How much of a song must play before its play count goes up.', slider('countPlayedPct', 10, 100, 5, v => v + '%')),
      row('Long tracks', 'Tracks this long go to “Long”, remember their position, and the <<< >>> buttons seek ±10 s.', slider('longMin', 10, 120, 5, v => v + ' min')),
      row('Remember position of long tracks', 'Resume podcasts, mixes and audiobooks where you left off.', sw('perTrackProgress')),
      row('Import from phone', 'Playlists, play counts, likes, EQ and audio settings captured from your phone.', btn('Import', () => importPhone(true), 'import')),
      row('Reset statistics', 'Clear play counts and last-played dates (ratings are kept).', btn('Reset', async () => {
        if (!await confirm('Reset statistics?', 'Play counts and last played dates for every song will be cleared.', 'Reset', true)) return;
        for (const s of Object.values(S.stats)) { s.plays = 0; s.last = 0; delete s.pos; }
        saveStats(); toast('Statistics reset');
      }))),
    group('Lists',
      row('List item action', 'What clicking a song in a list does.', sel('listAction', [['play', 'Play'], ['enqueue', 'Add to queue']])),
      row('Show track number', null, sel('showTrackNo', [['off', 'List position'], ['track', 'Track number tag']], () => render())),
      row('Filename as title', 'Always show the file name instead of the title tag.', sw('filenameAsTitle', () => render())),
      row('Hide “Unknown artist”', null, sw('hideUnknown', () => render())),
      row('Rating type', null, sel('rating', [['thumbs', 'Like / unlike thumbs'], ['stars', '5 stars']], () => render())),
      row('Playlist insert position', null, sel('plInsert', [['end', 'Add to end'], ['start', 'Insert at start'], ['shuffled', 'Shuffled']])),
      row('Don’t add duplicates to playlists', null, sw('noDuplicates')),
      row('Visible categories', set.hiddenCats.length ? `${set.hiddenCats.length} hidden. Right-click a category in the sidebar to hide it.` : 'Right-click a category in the sidebar to hide it.', btn('Show all', () => { set.hiddenCats = []; saveSettings(); render(); }))),
    group('Queue and shuffle',
      row('Start playing the queue', 'queue: queued songs play, then the current list continues.', sel('queueStart', [['after', 'After the current song'], ['now', 'Immediately']])),
      row('When the queue ends', null, sel('queueEnd', [['return', 'Return to the previous list'], ['stay', 'Repeat the queue']])),
      row('Shuffle mode', 'For lists made of several albums or folders.', sel('shuffleMode', [['songsCats', 'Shuffle songs and categories'], ['cats', 'Shuffle categories (keep album order)'], ['songs', 'Shuffle songs']])),
      row('Shuffle randomization', '“Less random” favours songs you have played less.', sel('shuffleRandom', [['full', 'Full random'], ['less', 'Less random']])),
      row('No reshuffle', 'Picking another song from the playing list keeps the current shuffle order.', sw('noReshuffle'))),
    group('Crossfade, fade and gapless',
      row('Gapless playback', 'Always on: the next song is decoded ahead and stitched sample-accurately.', h('span', { class: 'muted' }, 'On')),
      row('Auto-advance fading', 'Crossfade when the song changes by itself.', sel('xfMode', [['none', 'No fading'], ['nongapless', 'Between different albums only'], ['all', 'All songs'], ['shuffled', 'Shuffled songs only']], applyFades)),
      row('Crossfade length', null, slider('crossfadeLen', 1, 12, 0.5, v => v.toFixed(1) + ' s', applyFades)),
      row('Manual track change fading', 'When you skip songs yourself.', sel('manualFade', [['none', 'No fading'], ['short', 'Short crossfade'], ['full', 'Crossfade']], applyFades)),
      row('Short crossfade length', null, slider('shortFade', 0.1, 2, 0.1, v => Math.round(v * 1000) + ' ms', applyFades)),
      row('Fade play / pause', null, sw('fadePause', applyFades)),
      row('Seek fade length', null, slider('seekFade', 0, 0.5, 0.01, v => Math.round(v * 1000) + ' ms', applyFades)),
      row('Silence between tracks', 'Adds a pause between songs. Ignored while crossfading.', slider('gap', 0, 5, 0.1, v => v ? v.toFixed(1) + ' s' : 'None', applyFades))),
    group('Audio',
      row('Output device', null, devSel),
      row('Exclusive output (bit-perfect)', "WASAPI exclusive at each file's own sample rate and bit depth, bypassing the Windows mixer. EQ, tone, balance, reverb, limiter and ReplayGain run in 64-bit with dither; the volume drives the DAC's own hardware volume, with headroom for EQ boosts made up on the DAC. All flat = bit-perfect at any volume. Tempo, crossfade and visualizers are off. Other apps can't use the device meanwhile.", sw('exclusive', v => { dispatchEvent(new Event('cadence:xo-reset')); engine.xoFallback = false; engine.setExclusive(v); })),
      row('Output sample rate', 'Auto follows the device. Everything is resampled once in ffmpeg with the SoX very-high-quality resampler.', sel('sampleRate', [[0, 'Auto (device)'], [44100, '44.1 kHz'], [48000, '48 kHz'], [88200, '88.2 kHz'], [96000, '96 kHz'], [176400, '176.4 kHz'], [192000, '192 kHz']], () => engine.setOutput(set.device, set.sampleRate))),
      row('Replay Gain', null, sel('rgMode', [['off', "Don't apply"], ['track', 'Track gain'], ['album', 'Album gain']], applyRg)),
      row('Prevent clipping using peak', null, sw('preventClip', applyRg)),
      row('RG preamp', null, slider('rgPreamp', -15, 15, 0.5, v => (v > 0 ? '+' : '') + v + ' dB', applyRg)),
      row('Preamp for songs without RG', null, slider('noRgPreamp', -15, 15, 0.5, v => (v > 0 ? '+' : '') + v + ' dB', applyRg)),
      row('Limiter', 'Catches peaks after EQ and preamp boosts.', sw('limiter', v => engine.setLimiter(v)))),
    group('Headphones and devices',
      row('Pause when headphones disconnect', 'Pauses when the active output device disappears.', sw('pauseOnDisconnect')),
      row('Resume when headphones connect', null, sw('resumeOnConnect')),
      row('Media keys and Windows media overlay', 'Play/pause/next keys on keyboards and headsets, and the Windows volume flyout.', sw('mediaKeys', syncMediaKeys))),
    group('Lyrics',
      row('Look up lyrics online', 'When there is no .lrc file or lyrics tag, search LRCLIB (sends artist, title and album to lrclib.net).', sw('onlineLyrics', clearLyricsCache)),
      row('Lyrics size', null, slider('lyricsSize', 18, 72, 1, v => v + ' px')),
      row('Lyrics time offset', 'Positive values make lyrics appear later.', slider('lyricsOffset', -5, 5, 0.1, v => signed(v, 1, ' s'))),
      row('Lyrics search URL', 'Used by “Search the web”. %ARTIST% and %TITLE% are replaced.', (() => { const i = h('input', { type: 'text', class: 'set-text', value: set.lyricsSearchUrl }); i.addEventListener('change', () => { if (/^https:\/\//.test(i.value)) { set.lyricsSearchUrl = i.value; saveSettings(); } else toast('Use an https:// address', true); }); return i; })())),
    group('Look and feel',
      row('Theme', null, sel('theme', [['dark', 'Dark'], ['black', 'Black (OLED)'], ['light', 'Light'], ['auto', 'Follow Windows']], () => crossfade(applyTheme))),
      row('Animations', null, sel('animations', [['normal', 'Normal'], ['fast', 'Fast'], ['off', 'Off']], applyTheme)),
      row('Window material', 'Windows 11 backdrop behind the glass: Mica tints with your wallpaper, Acrylic lets the desktop show through.', sel('windowMaterial', [['none', 'None'], ['mica', 'Mica'], ['acrylic', 'Acrylic']], () => crossfade(applyTheme))),
      row('Album art animation', 'Slide the cover on track change.', sw('artAnim', applyTheme)),
      row('Scroll long titles', null, sw('marquee', applyTheme)),
      row('<<< >>> buttons', 'Jump between albums/folders, or seek ±10 seconds.', sel('proButtons', [['category', 'Previous / next album'], ['seek', '−10 / +10 seconds']])),
      row('<< restarts the song first', 'First press rewinds to the start, second press goes to the previous song.', sw('prevRestarts')),
      row('Accent colour from album art', null, sw('accentFromArt', applyAccentFromArt)),
      row('Accent colour', 'Used when the option above is off or the cover has no clear colour.', accentSwatches())),
    group('Background',
      row('Blurred background', 'Album art behind the whole window.', sw('blur', applyTheme)),
      row('Blur', null, slider('blurAmount', 10, 140, 5, v => v + ' px', applyTheme)),
      row('Intensity', null, slider('bgIntensity', 0.2, 1.4, 0.05, v => Math.round(v * 100) + '%', applyTheme)),
      row('Saturation', null, slider('bgSaturation', 0.5, 2.5, 0.05, v => Math.round(v * 100) + '%', applyTheme)),
      row('Gradient', 'Darkening toward the bottom for readable text.', slider('bgGradient', 0, 8, 1, v => v ? String(v) : 'None', applyTheme))),
    group('Album art',
      row('Download missing album art', 'Search the iTunes catalogue for albums without a cover after each scan.', sw('downloadArt')),
      row('High resolution', 'Download 1400 px covers instead of 600 px.', sw('artHiRes')),
      row('Download artist images', 'Photos for Artists and Album Artists from Deezer (sends artist names to deezer.com).', sw('artistImages', v => { reindex(); if (v) fetchArtistImages(); })),
      row('Find missing art now', `${S.albums.filter(a => !a.art).length} albums have no cover.`, btn('Download', async () => { toast('Looking for missing album art…'); await downloadArt(S.albums.filter(a => !a.art).flatMap(a => a.tracks)); })),
      row('Delete unused covers', 'Free disk space taken by covers no song uses anymore.', btn('Clean up', async () => toast(`Removed ${await api.invoke('art:cleanup')} cached images`)))),
    group('Visualization',
      row('Default mode', null, sel('vizMode', [['milk', 'Milkdrop presets'], ['bars', 'Spectrum bars']])),
      row('Preset duration', 'Milkdrop presets change automatically after this long.', slider('vizDuration', 10, 300, 5, v => v + ' s')),
      row('Equalizer screen spectrum', null, sel('vizSpectrumStyle', [['rounded', 'Rounded'], ['classic', 'Classic'], ['off', 'Disabled']])),
      row('Faded controls opacity', 'How visible controls stay over the full-screen visualizer.', slider('vizFadedOpacity', 0, 1, 0.05, v => Math.round(v * 100) + '%')),
      row('Keep screen on', 'While the full-screen visualizer is open.', sw('vizKeepAwake')),
      row('Reset hidden presets', `${set.vizHidden.length} presets hidden, ${set.vizLiked.length} liked.`, btn('Reset', () => { set.vizHidden = []; saveSettings(); toast('Hidden presets restored'); }))),
    group('Notifications and scrobbling',
      row('Track change notification', 'Show a Windows notification when the song changes while Cadence is in the background.', sw('notifyTrack')),
      row('Scrobble to ListenBrainz', 'Submit what you listen to. Get a user token at listenbrainz.org/settings.', sw('scrobble')),
      row('ListenBrainz token', null, (() => { const i = h('input', { type: 'password', class: 'set-text', value: set.lbToken, placeholder: 'User token', 'aria-label': 'ListenBrainz token' }); i.addEventListener('change', () => { set.lbToken = i.value.trim(); saveSettings(); }); return i; })())),
    group('Backup',
      row('Export settings and data', 'Settings, EQ presets, playlists, ratings, play counts, streams and bookmarks.', btn('Export', exportBackup, 'export')),
      row('Import settings and data', null, btn('Import', importBackup, 'import')),
      row('Restore default settings', 'Your library, playlists and statistics are kept.', btn('Restore', async () => {
        if (!await confirm('Restore default settings?', 'Every setting goes back to its default. Library, playlists and statistics are kept.', 'Restore', true)) return;
        const keep = { imported: true, volume: set.volume, userPresets: set.userPresets };
        Object.keys(set).forEach(k => delete set[k]);
        Object.assign(set, structuredClone(DEFAULTS), keep);
        saveSettings(); await syncEngine(); render();
      }))),
    group('Startup',
      row('Resume where you left off', 'Restore the queue and position on launch.', sw('resume'))),
    group('Keyboard shortcuts',
      h('div', { class: 'kbd-grid' }, ...[
        ['Space', 'Play / pause'], ['Ctrl + → / ←', 'Next / previous song'], ['→ / ←', 'Seek 5 s (Shift: 30 s)'], ['↑ / ↓', 'Volume'],
        ['Ctrl + F', 'Search'], ['L', 'Lyrics'], ['P', 'Now Playing view'], ['E', 'Equalizer'], ['Q', 'Queue'], ['V', 'Visualizer on cover'], ['F', 'Full-screen visualizer'],
        ['S', 'Shuffle'], ['R', 'Repeat'], ['M', 'Mute'], ['Ctrl + M', 'Mini player'], ['B', 'Add bookmark'], ['Ctrl + I', 'Audio info'], ['Alt + ←', 'Back'], ['Ctrl + ,', 'Settings'],
      ].flatMap(([k, d]) => [h('span', {}, h('kbd', {}, k)), h('span', {}, d)]))),
    group('About',
      row('Cadence 0.2', 'Audio: ffmpeg decoder → AudioWorklet (gapless, crossfade, ReplayGain) → Web Audio DSP. Visualizer: butterchurn (Milkdrop). Lyrics: LRC, tags, LRCLIB. Headphone EQ: AutoEq.', null)));

  const filter = () => {
    query = search.value.trim().toLowerCase();
    body.querySelectorAll('.set-group').forEach(g => {
      let any = false;
      g.querySelectorAll('.set-row').forEach(r => { const hit = !query || r.dataset.q.includes(query) || g.dataset.title.includes(query); r.hidden = !hit; any ||= hit; });
      g.hidden = !any && !!query;
    });
  };
  search.addEventListener('input', filter);
  filter();
  return h('section', { class: 'view' },
    h('div', { class: 'view-head' }, h('span', { class: 'cat', style: { '--c': '#8b8b94', width: '72px', height: '72px' } }, icon('settings', 'lg')), h('div', { class: 'view-title' }, h('h1', {}, 'Settings')), h('span', { class: 'tb-spacer' }), search),
    h('div', { class: 'scroll' }, body));
}
