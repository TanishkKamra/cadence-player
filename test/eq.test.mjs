import assert from 'node:assert/strict';
import { biquadCoef, biquadDb } from '../renderer/dsp.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
for (const fs of [44100, 48000, 96000, 192000]) {
  // shelf: exactly g/2 dB at the corner, g at the far end, 0 dB at the other end (Q only shapes the transition)
  for (const q of [0.5, 0.97, 2]) {
    const lo = biquadCoef('lowshelf', fs, 131, 5.2, q), hi = biquadCoef('highshelf', fs, 9000, -4, q);
    near(biquadDb(lo, 131, fs), 2.6, 0.01, `lowshelf corner ${fs}/${q}`);
    near(biquadDb(lo, 10, fs), 5.2, 0.15, `lowshelf dc ${fs}/${q}`);
    near(biquadDb(lo, 15000, fs), 0, 0.15, `lowshelf hf ${fs}/${q}`);
    near(biquadDb(hi, 9000, fs), -2, 0.01, `highshelf corner ${fs}/${q}`);
  }
  // LP/HP: Q is linear, so the corner sits at 20log10(Q)
  near(biquadDb(biquadCoef('lowpass', fs, 1000, 0, 2), 1000, fs), 20 * Math.log10(2), 0.01, 'lowpass corner');
  near(biquadDb(biquadCoef('highpass', fs, 1000, 0, 0.71), 1000, fs), 20 * Math.log10(0.71), 0.01, 'highpass corner');
  // peaking: the full gain at the centre
  near(biquadDb(biquadCoef('peaking', fs, 1000, 6, 1), 1000, fs), 6, 1e-9, 'peaking centre');
  // stable: poles inside the unit circle even at very low freq
  const [, , , a1, a2] = biquadCoef('lowshelf', fs, 10, 12, 0.7);
  assert.ok(Math.abs(a2) < 1 && Math.abs(a1) < 1 + a2, `stable ${fs}`);
}
// Q matters for shelves: different Q, different curve below the corner
assert.notEqual(biquadDb(biquadCoef('lowshelf', 48000, 131, 5.2, 0.5), 300, 48000).toFixed(2), biquadDb(biquadCoef('lowshelf', 48000, 131, 5.2, 2), 300, 48000).toFixed(2));
// a flat gain band is the exact identity (so a flat EQ stays bit-exact)
assert.deepEqual(biquadCoef('peaking', 48000, 1000, 0, 1), [1, 0, 0, 0, 0]);
console.log('eq ok');
