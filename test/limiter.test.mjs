// node test/limiter.test.mjs — the multiband look-ahead limiter in renderer/worklet.js, run outside the browser
import assert from 'node:assert/strict';
import fs from 'node:fs';

const procs = {}, SR = 48000;
const src = fs.readFileSync(new URL('../renderer/worklet.js', import.meta.url), 'utf8');
new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor', 'currentTime', 'currentFrame', src)(
  SR, class { constructor() { this.port = { postMessage() {}, onmessage: null }; } }, (n, c) => { procs[n] = c; }, 0, 0);

const run = (signal, boost = null, block = 128) => {
  const p = new procs['cadence-limiter'](), out = new Float32Array(signal.length);
  if (boost) p.port.onmessage({ data: { boost } });
  for (let o = 0; o < signal.length; o += block) {
    const x = signal.subarray(o, o + block), yl = new Float32Array(x.length), yr = new Float32Array(x.length);
    p.process([[x, x]], [[yl, yr]]);
    out.set(yl, o);
  }
  return { out, L: p.L };
};
// amplitude of the f Hz component of y[a..b)
const amp = (y, f, a, b) => {
  let s = 0, c = 0;
  for (let i = a; i < b; i++) { const w = 2 * Math.PI * f * i / SR; s += y[i] * Math.sin(w); c += y[i] * Math.cos(w); }
  return 2 * Math.hypot(s, c) / (b - a);
};
const ceil = Math.pow(10, -0.3 / 20), n = SR * 2;
const sine = (f, a, i) => a * Math.sin(2 * Math.PI * f * i / SR);

// quiet audio passes untouched (the bands add back to the input), only delayed by the look-ahead
const quiet = Float32Array.from({ length: n }, (_, i) => sine(60, 0.3, i) + sine(1000, 0.2, i) + sine(8000, 0.1, i));
{ const { out, L } = run(quiet); for (let i = 2 * L + 4800; i < n; i++) assert.ok(Math.abs(out[i] - quiet[i - 2 * L]) < 1e-5, 'quiet sample ' + i); }

// a hot bass under a quiet vocal-range tone: the bass is brought down, the 3 kHz tone keeps its level
const mix = Float32Array.from({ length: n }, (_, i) => sine(60, 2, i) + sine(3000, 0.3, i));
{
  const { out, L } = run(mix);
  let max = 0; for (const v of out) max = Math.max(max, Math.abs(v));
  assert.ok(max <= ceil + 1e-7, 'peak ' + max);
  const a = SR, b = n - 1;
  const tone = amp(out, 3000, a, b), bass = amp(out, 60, a, b);
  assert.ok(Math.abs(tone - 0.3) < 0.01, '3 kHz tone kept at ' + tone.toFixed(3));
  assert.ok(bass < 0.75, '60 Hz bass limited to ' + bass.toFixed(3));
}

// a hot treble over a quiet bass: the treble is brought down, the bass keeps its level
const mix2 = Float32Array.from({ length: n }, (_, i) => sine(80, 0.3, i) + sine(6000, 1.5, i));
{
  const { out } = run(mix2);
  const bass = amp(out, 80, SR, n - 1), hi = amp(out, 6000, SR, n - 1);
  assert.ok(Math.abs(bass - 0.3) < 0.01, '80 Hz bass kept at ' + bass.toFixed(3));
  assert.ok(hi < 0.7, '6 kHz limited to ' + hi.toFixed(3));
}

// 12 dB too hot everywhere: never above the ceiling and hardly ever held flat against it (eased, not clipped)
const hot = Float32Array.from({ length: n }, (_, i) => (sine(55, 2, i) + sine(440, 1.5, i) + sine(5000, 0.8, i)) * (i % 24000 < 12000 ? 1 : 0.1));
{
  const { out } = run(hot);
  let max = 0, flat = 0;
  for (let i = 1; i < n; i++) { max = Math.max(max, Math.abs(out[i])); if (Math.abs(out[i]) >= ceil - 1e-7 && Math.abs(out[i - 1]) >= ceil - 1e-7) flat++; }
  assert.ok(max <= ceil + 1e-7, 'peak ' + max);
  assert.ok(flat < n * 0.002, 'clipped run of ' + flat + ' samples');
}
// the EQ boosted the bass +12 dB: told about the boost, the limiter lets the boosted bass keep more of its level (it takes the
// cut from the bass bands as a group) and never takes the vocal-range tone below -3 dB
const boosted = Float32Array.from({ length: n }, (_, i) => sine(60, 1.6, i) + sine(3000, 0.4, i));
{
  const aware = run(boosted, [4, 4, 4, 2, 1, 1, 1, 1, 1, 1]).out, blind = run(boosted).out;
  const bassAware = amp(aware, 60, SR, n - 1), bassBlind = amp(blind, 60, SR, n - 1), tone = amp(aware, 3000, SR, n - 1);
  assert.ok(bassAware > bassBlind, `boosted bass ${bassAware.toFixed(3)} with the boost known, ${bassBlind.toFixed(3)} without`);
  assert.ok(tone > 0.4 * Math.pow(10, -3 / 20), '3 kHz tone kept at ' + tone.toFixed(3));
  let max = 0; for (const v of aware) max = Math.max(max, Math.abs(v));
  assert.ok(max <= ceil + 1e-7, 'peak ' + max);
}
console.log('limiter ok');
