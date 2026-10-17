// Synced / word-level lyrics view.
import { h, icon, fmtTime, artUrl, signed, fmtQualityShort } from './util.js';
import { S, set, engine, saveSettings, titleOf, artistOf } from './core.js';
import { parseLyrics, activeLine } from './lyrics.js';
import { back, onTeardown } from './views.js';

const cache = new Map(); // path -> { p, at, online, ok }; misses expire and are retried when online lookup is toggled
const MISS_TTL = 60000;
export const clearLyricsCache = () => cache.clear();
export function getLyrics(t) {
  let e = cache.get(t.path);
  if (e && e.online === set.onlineLyrics && (e.ok || Date.now() - e.at < MISS_TTL)) return e.p;
  e = { at: Date.now(), online: set.onlineLyrics, ok: false };
  e.p = api.invoke('lyrics:get', t, set.onlineLyrics)
    .then(r => { const p = r && parseLyrics(r); e.ok = !!p; e.at = Date.now(); return p ? { ...p, source: r.source } : null; })
    .catch(() => { e.at = Date.now(); return null; });
  cache.set(t.path, e);
  return e.p;
}
export const hasLocalLyrics = t => !!t && (!!t.lyrics || !!cache.get(t.path)?.ok);

// the last word of a line without an end marker: 1.5 x the line's median word length, 0.4-2.5 s
function lastWordLen(l) {
  const d = l.words.slice(1).map((w, k) => w.t - l.words[k].t).sort((a, b) => a - b);
  return Math.max(0.4, Math.min(2.5, 1.5 * (d.length ? d[d.length >> 1] : 0.4)));
}
export function lyricsView() {
  const v = h('section', { class: 'view lyrics-view' });
  const head = h('div', { class: 'ly-head' });
  const scroll = h('div', { class: 'ly-scroll', style: { '--ly-size': set.lyricsSize + 'px' } });
  v.append(head, scroll);
  let lines = [], lineEls = [], active = -2, userScrollAt = 0, track = null, raf, tm, synced = false;
  scroll.addEventListener('wheel', () => { userScrollAt = performance.now(); }, { passive: true });

  const offsetLbl = h('span', { class: 'offset' });
  const showOffset = () => { offsetLbl.textContent = signed(set.lyricsOffset, 1, ' s'); };
  const bump = d => { set.lyricsOffset = Math.round((set.lyricsOffset + d) * 10) / 10; showOffset(); saveSettings(); active = -2; };
  const size = d => { set.lyricsSize = Math.max(18, Math.min(72, set.lyricsSize + d)); scroll.style.setProperty('--ly-size', set.lyricsSize + 'px'); saveSettings(); };
  const searchWeb = () => api.send('shell:open', set.lyricsSearchUrl.replace('%ARTIST%', encodeURIComponent(track.artist || '')).replace('%TITLE%', encodeURIComponent(titleOf(track))));

  async function load() {
    track = engine.track;
    active = -2; lines = []; lineEls = []; synced = false;
    head.replaceChildren();
    scroll.replaceChildren();
    if (!track) { scroll.append(h('div', { class: 'empty' }, h('h2', {}, 'Nothing playing'))); return; }
    showOffset();
    head.append(track.art ? h('img', { src: artUrl(track.art), alt: '' }) : h('div', { class: 'ph' }, icon('song')),
      h('div', { class: 'ly-meta' }, h('div', { class: 't1' }, titleOf(track)), h('div', { class: 't2' }, [artistOf(track), track.album].filter(Boolean).join(' — ')),
        h('div', { class: 't3' }, track.stream ? 'Live stream' : [fmtTime(track.duration), fmtQualityShort(track)].filter(Boolean).join(' · '))),
      h('div', { class: 'tools' },
        h('div', { class: 'tool-group', role: 'group', 'aria-label': 'Lyrics timing' }, icon('offset', 'sm'),
          h('button', { class: 'icon-btn', title: 'Lyrics earlier (−0.1 s)', 'aria-label': 'Lyrics earlier', onclick: () => bump(-0.1) }, icon('minus', 'sm')), offsetLbl,
          h('button', { class: 'icon-btn', title: 'Lyrics later (+0.1 s)', 'aria-label': 'Lyrics later', onclick: () => bump(0.1) }, icon('plus', 'sm'))),
        h('div', { class: 'tool-group', role: 'group', 'aria-label': 'Text size' }, icon('textAa', 'sm'),
          h('button', { class: 'icon-btn', title: 'Smaller text', 'aria-label': 'Smaller text', onclick: () => size(-3) }, icon('minus', 'sm')),
          h('button', { class: 'icon-btn', title: 'Larger text', 'aria-label': 'Larger text', onclick: () => size(3) }, icon('plus', 'sm'))),
        h('button', { class: 'icon-btn', title: 'Search lyrics on the web', onclick: searchWeb }, icon('search', 'sm')),
        h('button', { class: 'icon-btn', title: 'Full screen (F11)', onclick: () => api.send('win:fullscreen') }, icon('full', 'sm')),
        h('button', { class: 'icon-btn', title: 'Close lyrics (L)', onclick: back }, icon('close', 'sm'))));
    scroll.append(h('div', { class: 'ly-loading' }, h('i'), h('i'), h('i')));
    const t = track;
    const ly = await getLyrics(t);
    if (t !== engine.track) return;
    scroll.replaceChildren();
    if (!ly) {
      scroll.append(h('div', { class: 'empty' }, h('h2', {}, 'No lyrics found'),
        h('div', {}, set.onlineLyrics ? 'No .lrc file, no lyrics tag and nothing on LRCLIB for this song.' : 'No .lrc file or lyrics tag. Online lookup is off in Settings.'),
        h('button', { class: 'tb-btn', onclick: searchWeb }, icon('search', 'sm'), 'Search the web')));
      return;
    }
    lines = ly.lines; synced = ly.synced;
    lineEls = lines.map(l => h('p', {
      class: 'ly-line' + (synced ? '' : ' plain') + (!l.text ? ' gap' : '') + (l.voice && l.voice !== 'v1' ? ' alt' : ''),
      onclick: () => { if (synced) { engine.seek(Math.max(0, l.t + set.lyricsOffset)); userScrollAt = 0; } },
    }, l.words ? l.words.map(w => h('span', { class: 'w' }, w.text)) : (l.text || '♪')));
    scroll.append(...lineEls, h('div', { class: 'ly-source' }, `${synced ? 'Synced' : 'Unsynced'} lyrics · ${ly.source}`));
  }
  function tick() {
    if (document.hidden || !engine.playing) tm = setTimeout(tick, 250); else raf = requestAnimationFrame(tick); // idle: no 60 fps loop
    if (engine.track !== track) { load(); return; }
    if (!synced || !lines.length) return;
    const pos = engine.position - set.lyricsOffset;
    const i = activeLine(lines, pos);
    if (i !== active) {
      lineEls[active]?.classList.remove('active');
      lineEls.forEach((el, k) => el.classList.toggle('past', k < i));
      active = i;
      const el = lineEls[i];
      if (el) {
        el.classList.add('active');
        if (performance.now() - userScrollAt > 3500) scroll.scrollTo({ top: el.offsetTop - scroll.clientHeight * 0.38, behavior: set.animations === 'off' ? 'auto' : 'smooth' });
      }
    }
    const l = lines[i];
    if (l?.words) lineEls[i].querySelectorAll('.w').forEach((w, k) => {
      const wt = l.words[k], nt = l.words[k + 1]?.t ?? l.end ?? Math.min(lines[i + 1]?.t ?? Infinity, wt.t + lastWordLen(l));
      // fill each word progressively across its duration
      w.style.setProperty('--fill', Math.max(0, Math.min(1, (pos - wt.t) / Math.max(0.05, nt - wt.t))) * 100 + '%');
      w.classList.toggle('sung', wt.t <= pos);
    });
  }
  load();
  tick();
  onTeardown(() => { cancelAnimationFrame(raf); clearTimeout(tm); });
  return v;
}
