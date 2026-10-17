// node test/queue.test.mjs — queue: user Queue plays first, then the list continues
import assert from 'node:assert/strict';
import { S, set, setList, enqueue, peekNext, commit, prevEntry, setShuffle, removeFromList, allowXf } from '../renderer/core.js';

const tr = n => ({ path: `C:\\m\\${n}.flac`, title: n, album: n < 'c' ? 'A' : 'B', artist: 'x', duration: 100 });
const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(tr);

const first = setList([a, b, c], 0, { label: 'L' });
commit(first);
assert.equal(peekNext(first).track, b);

// "play next" jumps ahead of the list, then the list resumes where it was
const [q] = enqueue([d], { next: true });
assert.equal(peekNext(first), q);
commit(q);
assert.equal(S.fromQueue, true);
assert.equal(peekNext(q).track, b);
const nb = peekNext(q); commit(nb);
assert.equal(S.li, 1);
assert.equal(prevEntry().track, a);

// end of list: stop unless repeating (manual next wraps)
const nc = peekNext(nb); commit(nc);
assert.equal(peekNext(nc), null);
assert.equal(peekNext(nc, true).track, a);
S.repeat = 'all'; assert.equal(peekNext(nc).track, a);
S.repeat = 'one'; assert.equal(peekNext(nc), nc);
S.repeat = 'off';

// shuffle keeps the playing entry first and restores order when turned off
setShuffle(true);
assert.equal(S.list[S.li], nc);
assert.equal(S.list.length, 3);
setShuffle(false);
assert.deepEqual(S.list.map(e => e.track.title), ['a', 'b', 'c']);
assert.equal(S.list[S.li], nc);

// the playing entry can't be removed; others can
assert.equal(removeFromList(nc), false);
assert.equal(removeFromList(S.list[0]), true);
assert.equal(S.list[S.li], nc);

// crossfade policy
set.xfMode = 'nongapless';
assert.equal(allowXf({ track: a }, { track: b }), false); // same album: keep gapless
assert.equal(allowXf({ track: b }, { track: c }), true);
set.xfMode = 'none';
console.log('queue ok');

// bad saved data is clamped, not trusted
import { cleanSettings, cleanPlaylists, cleanStats, DEFAULTS } from '../renderer/core.js';
const bad = cleanSettings(JSON.parse('{"volume":9,"theme":"x","graphic":"no","params":[1],"userPresets":{"__proto__":{"a":1},"ok":{}},"reverb":"old","bass":null}'));
assert.equal(bad.volume, 1); assert.equal(bad.theme, DEFAULTS.theme); assert.equal(bad.graphic.length, 10); assert.equal(bad.bass, 0);
assert.equal(bad.reverb.on, false); assert.deepEqual(Object.keys(bad.userPresets), ['ok']); assert.equal({}.a, undefined);
assert.deepEqual(cleanPlaylists({}), []); assert.equal(cleanPlaylists([{ paths: 5 }, 3])[0].paths.length, 0);
assert.deepEqual(cleanStats([1]), {});
