import assert from 'node:assert/strict';
import { rbj, iirDb } from '../renderer/engine.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
for (const fs of [44100, 48000, 96000, 192000]) {
  // shelf: exactly g/2 dB at the corner, g at the far end, 0 dB at the other end (Q only shapes the transition)
  for (const q of [0.5, 0.97, 2]) {
    const lo = rbj('lowshelf', fs, 131, 5.2, q), hi = rbj('highshelf', fs, 9000, -4, q);
    near(iirDb(lo, 131, fs), 2.6, 0.01, `lowshelf corner ${fs}/${q}`);
    near(iirDb(lo, 10, fs), 5.2, 0.15, `lowshelf dc ${fs}/${q}`);
    near(iirDb(lo, 15000, fs), 0, 0.15, `lowshelf hf ${fs}/${q}`);
    near(iirDb(hi, 9000, fs), -2, 0.01, `highshelf corner ${fs}/${q}`);
  }
  // LP/HP: Q is linear, so the corner sits at 20log10(Q)
  near(iirDb(rbj('lowpass', fs, 1000, 0, 2), 1000, fs), 20 * Math.log10(2), 0.01, 'lowpass corner');
  near(iirDb(rbj('highpass', fs, 1000, 0, 0.71), 1000, fs), 20 * Math.log10(0.71), 0.01, 'highpass corner');
  // stable: poles inside the unit circle even at very low freq
  const { a } = rbj('lowshelf', fs, 10, 12, 0.7);
  assert.ok(Math.abs(a[2]) < 1 && Math.abs(a[1]) < 1 + a[2], `stable ${fs}`);
}
// Q matters for shelves now: different Q, different curve below the corner
assert.notEqual(iirDb(rbj('lowshelf', 48000, 131, 5.2, 0.5), 300, 48000).toFixed(2), iirDb(rbj('lowshelf', 48000, 131, 5.2, 2), 300, 48000).toFixed(2));
console.log('eq ok');

// Slot: 500 rapid IIR-type updates rebuild nothing (one worklet node, coefficients by message) and cost almost no time
{
  const { Slot } = await import('../renderer/engine.js');
  const links = new Set(); let live = 0, posts = 0;
  const param = { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} };
  const node = kind => {
    const n = { kind, id: Math.random(), gain: param, frequency: param, Q: param, port: { postMessage() { posts++; } } };
    n.connect = d => { links.add(n.id + '>' + d.id); return d; };
    n.disconnect = d => { for (const l of [...links]) if (d ? l === n.id + '>' + d.id : l.startsWith(n.id + '>')) links.delete(l); };
    if (kind !== 'gain') live++;
    return n;
  };
  const ctx = { sampleRate: 48000, currentTime: 0, createGain: () => node('gain'), createBiquadFilter: () => node('bq') };
  const s = new Slot(ctx, { type: 'lowshelf', freq: 100, q: 0.7 }, 0, () => node('iir'));
  const t0 = performance.now();
  for (let i = 0; i < 500; i++) { s.set({ type: 'lowshelf', freq: 100 + i, q: 0.7 }, 3 + (i % 7)); await new Promise(r => setTimeout(r, 2)); }
  const ms = performance.now() - t0;
  assert.equal(live, 1, 'no nodes built per update'); assert.ok(posts > 10);
  // switching between worklet and native types crossfades, then the old branch is disconnected (no leak after many switches)
  for (let i = 0; i < 100; i++) { s.set({ type: i % 2 ? 'lowshelf' : 'peaking', freq: 200, q: 1 }, 2); await new Promise(r => setTimeout(r, 20)); }
  await new Promise(r => setTimeout(r, 300));
  assert.equal(s.dying.size, 0); assert.equal(links.size, 3, 'input>f, f>g, g>output only');
  s.dispose(); assert.equal(links.size, 0);
  console.log('slot ok, posts:', posts, 'nodes built:', live);
}
