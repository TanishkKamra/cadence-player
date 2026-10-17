// node test/exclusive.test.mjs — exclusive-output controller against a fake WASAPI helper
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Exclusive } from '../exclusive.mjs';

const ops = [], out = [], acks = {};
let proc;
const fake = () => {
  proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = b => { if (b.length === 1 || 'FXKVD'.includes(String.fromCharCode(b[0]))) ops.push(String.fromCharCode(b[0])); };
  proc.kill = () => {};
  return proc;
};
const xo = new Exclusive({ spawn: fake, send: m => out.push(m), ack: (id, n) => { acks[id] = (acks[id] || 0) + n; } });
const pos = f => proc.stdout.emit('data', `pos ${xo.epoch} ${f}\n`);
const pcm = frames => Buffer.alloc(frames * 8);
const last = t => out.filter(m => m.type === t).at(-1);

// track 1 at 1 kHz, 1000 frames; track 2 queued for gapless
xo.open(1, 1000, 24);
xo.msg({ type: 'playing', value: true });
xo.msg({ type: 'play', id: 1 });
assert.deepEqual(ops.slice(0, 4), ['V', 'R', 'X', 'F']);
xo.data(1, pcm(600)); xo.data(1, pcm(400)); xo.end(1);
assert.equal(xo.written, 1000);
assert.equal(acks[1], 8000);

xo.open(2, 1000, 24);
xo.data(2, pcm(500));
xo.msg({ type: 'queue', id: 2 });
assert.equal(xo.segs.length, 2); // rolled straight into track 2 (still within AHEAD_SEC)
assert.equal(xo.segs[1].start, 1000);

pos(400);
assert.deepEqual(last('pos'), { type: 'pos', id: 1, frames: 400 });
pos(1100);
assert.deepEqual(last('switch'), { type: 'switch', id: 2, from: 1 });
assert.deepEqual(last('pos'), { type: 'pos', id: 2, frames: 100 });

// stale epoch is ignored after a seek/flush
xo.open(3, 1000, 16);
xo.msg({ type: 'play', id: 3 });
proc.stdout.emit('data', `pos ${xo.epoch - 1} 99999\n`);
assert.equal(xo.played, 0);
xo.data(3, pcm(300)); xo.end(3);
pos(300);
assert.deepEqual(last('ended'), { type: 'ended', id: 3 });

// cancelling a next track already handed to the helper cuts it back out
xo.open(4, 1000, 24); xo.msg({ type: 'play', id: 4 }); xo.data(4, pcm(100)); xo.end(4);
xo.open(5, 1000, 24); xo.data(5, pcm(100)); xo.msg({ type: 'queue', id: 5 });
assert.equal(xo.segs.length, 2);
xo.msg({ type: 'close', id: 5 });
assert.equal(ops.at(-1), 'K');
assert.equal(xo.segs.length, 1);
assert.equal(xo.written, 100);

// a queued track's format refused: the helper keeps running, the segment is taken back, 'ended' waits for a replacement
xo.open(6, 1000, 24); xo.data(6, pcm(50)); xo.msg({ type: 'queue', id: 6 });
assert.equal(xo.segs.length, 2);
const helper = xo.proc;
proc.stdout.emit('data', 'refuse 6 the device refused this format in exclusive mode (1000 Hz, 24-bit)\n');
assert.deepEqual(last('refused'), { type: 'refused', id: 6, message: 'the device refused this format in exclusive mode (1000 Hz, 24-bit)', queued: true });
assert.equal(xo.proc, helper);
assert.equal(xo.segs.length, 1);
assert.equal(xo.written, 100);
const endedBefore = out.filter(m => m.type === 'ended').length;
pos(100);
assert.equal(out.filter(m => m.type === 'ended').length, endedBefore); // held while awaiting the re-queue
xo.open(7, 1000, 24); xo.data(7, pcm(50)); xo.msg({ type: 'queue', id: 7 });
assert.equal(xo.segs.length, 2); // replacement rolls in gaplessly
assert.equal(xo.segs[1].s.id, 7);

// refusal reported right when the previous track drained (position exactly at the boundary): still a queued refusal
xo.open(12, 1000, 24); xo.msg({ type: 'play', id: 12 }); xo.data(12, pcm(300)); xo.end(12);
xo.open(13, 1000, 24); xo.data(13, pcm(100)); xo.msg({ type: 'queue', id: 13 });
for (const p of [100, 200, 300]) pos(p);
assert.equal(out.filter(m => m.type === 'switch' && m.id === 13).length, 0); // not audible before its first frame
proc.stdout.emit('data', 'refuse 13 refused\n');
assert.equal(last('refused').queued, true);

// nothing to replace it with: queue(null) releases the held 'ended'
xo.open(8, 1000, 24); xo.msg({ type: 'play', id: 8 }); xo.data(8, pcm(100)); xo.end(8);
xo.open(9, 1000, 24); xo.data(9, pcm(10)); xo.msg({ type: 'queue', id: 9 });
proc.stdout.emit('data', 'refuse 9 refused\n');
pos(100);
assert.equal(out.filter(m => m.type === 'ended' && m.id === 8).length, 0); // held
xo.msg({ type: 'queue', id: null });
pos(100);
assert.equal(out.filter(m => m.type === 'ended' && m.id === 8).length, 1);

// a refusal of the first segment (nothing playing yet) is left to the engine to restart
xo.open(10, 1000, 24); xo.msg({ type: 'play', id: 10 });
proc.stdout.emit('data', 'refuse 10 refused\n');
assert.equal(last('refused').queued, false);

// decoder stopped for the stream being fed: its unsent PCM is dropped, the segment stays for position mapping
xo.open(11, 1000, 24); xo.msg({ type: 'play', id: 11 }); for (let k = 0; k < 10; k++) xo.data(11, pcm(500));
assert.ok(xo.streams.get(11).q.length > 0);
xo.forget(11);
assert.equal(xo.streams.get(11).q.length, 0);
assert.equal(xo.streams.get(11).ended, true);

// a real device failure kills the helper and surfaces as 'fail'
proc.stdout.emit('data', 'fail 11 the device was removed\n');
assert.equal(last('fail').id, 11);
assert.equal(xo.proc, null);

// #5 volume is sanitized before it reaches the helper
for (const [v, want] of [[NaN, 0], [5, 1], [-2, 0], [0.5, 0.5], [undefined, 0]]) { xo.msg({ type: 'volume', value: v }); assert.equal(xo.volume, want); }

// #6 a stale refusal for a stream that no longer exists is ignored
const nRefused = out.filter(m => m.type === 'refused').length;
proc.stdout.emit('data', 'refuse 999 refused\n');
assert.equal(out.filter(m => m.type === 'refused').length, nRefused);

// #29 helper death: respawned on the next play with backoff, gives up after repeated crashes, config resets
{
  let spawns = 0;
  const x2 = new Exclusive({ spawn: () => { spawns++; return fake(); }, send: m => out.push(m), ack() {} });
  x2.open(1, 1000, 24);
  x2.msg({ type: 'play', id: 1 });
  assert.equal(spawns, 1);
  proc.emit('exit', 1);
  assert.equal(last('fail').type, 'fail');
  x2.msg({ type: 'play', id: 1 }); // inside the backoff window: no respawn
  assert.equal(spawns, 1);
  x2.retryAt = 0; x2.msg({ type: 'play', id: 1 });
  assert.equal(spawns, 2);
  proc.emit('exit', 1); x2.retryAt = 0; x2.msg({ type: 'play', id: 1 });
  proc.emit('exit', 1); x2.retryAt = 0; x2.msg({ type: 'play', id: 1 }); // 3rd crash in a row: gives up
  assert.equal(spawns, 3);
  x2.msg({ type: 'config', device: 'other' }); x2.msg({ type: 'play', id: 1 });
  assert.equal(spawns, 4);
}

// malformed helper lines are dropped, not forwarded as NaN
{
  const n = out.length;
  for (const l of [`pos ${xo.epoch} abc`, 'open x 1 2 3', 'pos 1 2 3 junk-epoch-x']) proc.stdout.emit('data', l + String.fromCharCode(10));
  assert.ok(out.slice(n).every(m => m.type !== 'format' && !(m.type === 'pos' && !Number.isFinite(m.frames))));
}
console.log('exclusive tests passed');
