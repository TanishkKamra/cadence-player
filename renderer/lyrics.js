// LRC / enhanced-LRC parser. Returns { synced, lines: [{ t, text, words: [{t,text}] | null, end? }] }.
const STAMP = /\[(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\]/g;
const LEAD = /^(?:\s*\[(?:\d+:)?\d+:\d+(?:\.\d+)?\])+/;
const WORD = /<(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)>/g;
const STRAY = /<\d{1,2}:[^>]*>?/g; // malformed word stamps left in the text
const TAGS = /^\s*\[(?:ti|ar|al|au|by|length|re|ve|la|tool|id|#)[^\]]*\]\s*$/i;
// [h:mm:ss] (first field non-zero), [mm:ss.xx]; [00:ss:xx] is the legacy hundredths form
const toSec = (a, m, s) => {
  if (a == null) return +m * 60 + parseFloat(s);
  if (+a > 0 || s.includes('.')) return +a * 3600 + +m * 60 + parseFloat(s);
  return +m + parseFloat('0.' + s);
};
const plainLines = arr => arr.map(l => ({ t: null, text: l, words: null }));

export function parseLyrics(res) {
  if (!res) return null;
  if (res.synced) {
    const ls = res.synced.filter(l => l.text != null && Number.isFinite(l.t)).map(l => ({ t: l.t, text: l.text.trim(), words: null }));
    return ls.length > 1 && ls.every(l => l.t === ls[0].t) ? { synced: false, lines: plainLines(ls.map(l => l.text)) } : { synced: true, lines: ls };
  }
  const text = (res.text || '').replace(/^﻿/, '');
  let offset = 0;
  const lines = [], rows = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
    if (off) { offset = +off[1] / 1000; continue; }
    const lead = raw.match(LEAD)?.[0];
    if (!lead) continue;
    const stamps = [...lead.matchAll(STAMP)].map(s => toSec(s[1], s[2], s[3])).filter(Number.isFinite);
    if (!stamps.length) continue;
    let body = raw.slice(lead.length);
    // Apple-style duet markers: "v1:", "v2:", "bg:"
    let voice = null;
    body = body.replace(/^\s*(v\d+|bg):\s*/i, (m, v) => { voice = v.toLowerCase(); return ''; });
    const t = stamps[0];
    let words = null, end = null;
    const tags = [...body.matchAll(WORD)];
    if (tags.length) {
      words = [];
      const first = body.slice(0, tags[0].index);
      if (first.trim()) words.push({ t, text: first });
      tags.forEach((m, i) => {
        const txt = body.slice(m.index + m[0].length, tags[i + 1]?.index ?? body.length), wt = toSec(m[1], m[2], m[3]);
        if (!txt.trim() && i === tags.length - 1) end = wt; // trailing <mm:ss> closes the last word
        else if (txt) words.push({ t: wt, text: txt });
      });
      for (const w of words) w.text = w.text.replace(STRAY, '');
      words = words.filter(w => w.text);
      body = words.map(w => w.text).join('');
      if (!words.length) words = null;
    } else body = body.replace(STRAY, '');
    rows.push({ t: Math.min(...stamps), text: body.trim() });
    for (const s of stamps) lines.push({ t: s, text: body.trim(), words, voice, end });
  }
  if (lines.length) {
    // every line at one time (or timestamps mostly non-increasing) is not a synced file
    const inc = rows.reduce((n, r, i) => n + (i && r.t > rows[i - 1].t ? 1 : 0), 0);
    if (rows.length > 1 && (rows.every(r => r.t === rows[0].t) || rows.length > 3 && inc < (rows.length - 1) * 0.2)) return { synced: false, lines: plainLines(rows.map(r => r.text)) };
    lines.sort((a, b) => a.t - b.t);
    if (offset) for (const l of lines) { l.t -= offset; if (l.end != null) l.end -= offset; l.words?.forEach(w => { w.t -= offset; }); }
    return { synced: true, lines };
  }
  if (/^\[instrumental:\s*true\s*\]/im.test(text)) return { synced: false, instrumental: true, lines: [{ t: null, text: '♪  Instrumental  ♪', words: null }] };
  const plain = text.split(/\r\n|\r|\n/).filter(l => !TAGS.test(l)).filter((l, i, a) => l.trim() || (i && a[i - 1].trim()));
  return plain.some(l => l.trim()) ? { synced: false, lines: plainLines(plain.map(l => l.trim())) } : null;
}

// index of the line active at time `pos` (binary search), -1 before the first line; the first of lines sharing a timestamp
export function activeLine(lines, pos) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  while (ans > 0 && lines[ans - 1].t === lines[ans].t) ans--;
  return ans;
}
