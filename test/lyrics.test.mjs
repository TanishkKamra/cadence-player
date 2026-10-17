// node test/lyrics.test.mjs
import assert from 'node:assert/strict';
import { parseLyrics, activeLine } from '../renderer/lyrics.js';

const lrc = parseLyrics({ text: '[ti:X]\n[offset:+500]\n[00:01.00]one\n[00:03.50][00:10.00]two\n[00:05.00]v2: <00:05.00>a <00:05.40>b<00:06.00>' });
assert.equal(lrc.synced, true);
assert.deepEqual(lrc.lines.map(l => [l.t, l.text]), [[0.5, 'one'], [3, 'two'], [4.5, 'a b'], [9.5, 'two']]);
assert.equal(lrc.lines[2].voice, 'v2');
assert.deepEqual(lrc.lines[2].words.map(w => w.t), [4.5, 4.9]);
assert.equal(activeLine(lrc.lines, 0.2), -1);
assert.equal(activeLine(lrc.lines, 4.6), 2);

assert.equal(parseLyrics({ text: '[ar:Y]\n[instrumental:true]' }).instrumental, true);
const plain = parseLyrics({ text: '[ar:Y]\nhello\n\nworld' });
assert.equal(plain.synced, false);
assert.deepEqual(plain.lines.map(l => l.text), ['hello', '', 'world']);
assert.equal(parseLyrics({ text: '' }), null);
assert.equal(parseLyrics({ synced: [{ t: 1, text: ' x ' }] }).lines[0].text, 'x');

// ties: first line of a shared timestamp is active
assert.equal(activeLine([{ t: 1 }, { t: 1 }, { t: 1 }, { t: 5 }], 2), 0);
// all-equal stamps are not synced
const flat = parseLyrics({ text: '[00:00.00]a\n[00:00.00]b\n[00:00.00]c' });
assert.equal(flat.synced, false);
assert.deepEqual(flat.lines.map(l => l.text), ['a', 'b', 'c']);
assert.equal(parseLyrics({ synced: [{ t: 0, text: 'a' }, { t: 0, text: 'b' }] }).synced, false);
// BOM before [offset:], CR-only and CRLF line endings
const bom = parseLyrics({ text: '﻿[offset:+500]\r[00:01.00]a\r[00:02.00]b\r' });
assert.deepEqual(bom.lines.map(l => [l.t, l.text]), [[0.5, 'a'], [1.5, 'b']]);
assert.equal(parseLyrics({ text: '[00:01.00]a\r\n[00:02.00]b\r\n' }).lines.length, 2);
// [h:mm:ss] and legacy [mm:ss:xx]
assert.equal(parseLyrics({ text: '[1:02:03.50]a' }).lines[0].t, 3723.5);
assert.equal(parseLyrics({ text: '[00:01:50]a' }).lines[0].t, 1.5);
// word tags: trailing <t> is the line end; malformed tags stay text and never throw
const w = parseLyrics({ text: '[00:01.00]<00:01.00>a <00:01.50>b<00:02.00>' }).lines[0];
assert.equal(w.end, 2); assert.deepEqual(w.words.map(x => x.text), ['a ', 'b']);
assert.equal(parseLyrics({ text: '[00:01.00]<00:01.00>a <00:xx>b <00:02.00' }).lines[0].text, 'a b');
// [Intro:] style headers stay as plain text; ID tags are dropped; mid-line [12:30] is not a stamp
assert.deepEqual(parseLyrics({ text: '[ti:T]\n[Intro: X]\nhello' }).lines.map(l => l.text), ['[Intro: X]', 'hello']);
assert.equal(parseLyrics({ text: '[00:01.00]at [12:30] ok' }).lines.length, 1);
console.log('lyrics ok');
const bad = parseLyrics({ text: '[00:01.00]<00:05.00>a <00:xx>b c' }).lines[0];
assert.equal(bad.text, 'a b c'); assert.equal(bad.words.length, 1);
assert.equal(parseLyrics({ text: '[00:01.00]x <00:xx>y' }).lines[0].text, 'x y');
console.log('lyrics ok 2');
