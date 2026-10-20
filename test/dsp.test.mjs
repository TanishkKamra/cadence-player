// node test/dsp.test.mjs — renderer/dsp.js (shared output) against native/dsp.cs (exclusive output), and the worklet around it.
// Needs native/cadence-wasapi.exe (npm run build:native).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Dsp, parseConfig, brirFor } from '../renderer/dsp.js';

const exe = fileURLToPath(new URL('../native/cadence-wasapi.exe', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-dsp-'));
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// interleaved stereo test signal: tones across the band + noise, loud enough to be limited under boosts
function signal(rate, sec) {
  const n = Math.round(rate * sec), x = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const t = i / rate, m = 0.35 * Math.sin(2 * Math.PI * 55 * t) + 0.2 * Math.sin(2 * Math.PI * 440 * t) + 0.1 * Math.sin(2 * Math.PI * 3100 * t) + 0.05 * Math.sin(2 * Math.PI * 12000 * t);
    x[2 * i] = m + 0.15 * (rnd() - 0.5); x[2 * i + 1] = 0.8 * m + 0.15 * (rnd() - 0.5);
  }
  return x;
}
const brirs = {}, brir = rate => brirs[rate] ??= brirFor(fs.readFileSync(new URL('../renderer/brir.bin', import.meta.url)), rate);
// the same script as the native --process mode: [frame, 'cfg' | 'vol', value]
function runJs(rate, steps, x, chunk) {
  const d = new Dsp(rate), y = Float64Array.from(x), seg = new Float64Array(2 * chunk), frames = y.length / 2;
  let si = 0;
  if (steps.some(s => /spk 1/.test(s[2]))) d.setBrir(brir(rate));
  for (let at = 0; at < frames; at += chunk) {
    while (si < steps.length && steps[si][0] <= at) {
      const [, op, v] = steps[si++];
      if (op === 'cfg') { d.apply(parseConfig(v)); while (!d.ReverbReady && d.Cfg.RevOn) d.process(seg, 0); }
      else d.Volume = +v;
    }
    const n = Math.min(chunk, frames - at);
    seg.set(y.subarray(2 * at, 2 * at + 2 * n)); d.process(seg, n); y.set(seg.subarray(0, 2 * n), 2 * at);
  }
  return { y, d };
}
function runNative(rate, steps, x, chunk) {
  const s = path.join(tmp, 'script.txt'), i = path.join(tmp, 'in.f64'), o = path.join(tmp, 'out.f64');
  fs.writeFileSync(s, steps.map(([f, op, v]) => `${f} ${op} ${v}`).join('\n'));
  fs.writeFileSync(i, Buffer.from(x.buffer));
  const info = execFileSync(exe, ['--process', String(rate), s, i, o, String(chunk)], { encoding: 'utf8' }).trim().split(' ').map(Number);
  const b = fs.readFileSync(o);
  return { y: new Float64Array(b.buffer, b.byteOffset, b.length / 8), latency: info[0], limited: info[1], clamps: info[2] };
}

// G1.5: the same config and input give the same output, to 1e-9, through every stage and mid-stream change
const EQ = 'pre 2;band peaking 62 5 1.2;band peaking 1000 -4 0.9;band highshelf 8000 6 0.7;band lowpass 18000 0 0.71';
const scenarios = [
  ['neutral', [[0, 'cfg', 'lim 1']]],
  ['EQ boosts and cuts, limited', [[0, 'cfg', EQ + ';lim 1']]],
  ['tone, balance, width', [[0, 'cfg', 'bass 9 90;treble 6 9000;bal -0.4;width 1.6;lim 1;ceil -0.3']]],
  ['mid-stream changes and volume', [[0, 'cfg', 'lim 1'], [0, 'vol', 0.7], [12000, 'cfg', EQ + ';bass 4 120;lim 1'], [30000, 'vol', 1], [40000, 'cfg', 'pre -3;mono 1;band peaking 1000 8 1;lim 1'], [60000, 'cfg', 'lim 1;guard 1']]],
  ['crossfeed', [[0, 'cfg', 'xfeed 1 700 4.5;width 1.3;lim 1'], [30000, 'cfg', 'xfeed 1 650 9.5;bass 6 90;lim 1'], [60000, 'cfg', 'lim 1']]],
  ['virtual speakers', [[0, 'cfg', 'spk 1;lim 1'], [40000, 'cfg', 'spk 1;bass 6 90;xfeed 1 700 4.5;lim 1'], [70000, 'cfg', 'lim 1']]],
  ['reverb', [[0, 'cfg', 'pre 3;bass 6 90;rev 1 0.3 0.5 0.6 0.4 0.2 0.3 0.4;lim 1'], [50000, 'cfg', 'pre 3;bass 6 90;rev 1 0.3 0.5 0.6 0.4 0.5 0.6 0.2;lim 1']]],
];
// 88.2 kHz: the speaker responses are resampled (from the 96 kHz set) in both cores
for (const rate of [44100, 48000, 88200]) {
  const x = signal(rate, 2);
  for (const [name, steps] of rate === 88200 ? scenarios.filter(s => s[0] === 'virtual speakers') : scenarios) {
    const js = runJs(rate, steps, x, 128), nat = runNative(rate, steps, x, 128);
    let worst = 0;
    for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(js.y[i] - nat.y[i]));
    assert.equal(js.d.Latency, nat.latency, `${name} @ ${rate}: latency`);
    assert.ok(worst < 1e-9, `${name} @ ${rate}: native vs worklet differ by ${worst}`);
    assert.equal(js.d.Lim.Clamps, 0, `${name} @ ${rate}: last-resort clamp used`);
    console.log(`ok   ${name} @ ${rate}: native vs worklet ${worst.toExponential(1)} (limited ${js.d.Lim.Limited} / ${nat.limited} samples)`);
  }
}

// the AudioWorklet wrapper: Float32 in and out, neutral path bit-exact, tap output carries the post-EQ signal
{
  const procs = {}, SR = 48000;
  globalThis.sampleRate = SR;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: m => (this.sent ||= []).push(m), onmessage: null }; } };
  globalThis.registerProcessor = (n, c) => { procs[n] = c; };
  await import('../renderer/dsp.js?worklet');
  const p = new procs['cadence-dsp'](), n = SR, src = new Float32Array(n), out = new Float32Array(n), tapOut = new Float32Array(n);
  for (let i = 0; i < n; i++) src[i] = Math.fround(Math.round((rnd() - 0.5) * 2 * 8388607) / 8388608);
  p.port.onmessage({ data: { dsp: 'pre 0;bass 0 90;lim 1' } });
  for (let o = 0; o < n; o += 128) {
    const x = src.subarray(o, o + 128), l = new Float32Array(128), r = new Float32Array(128), tl = new Float32Array(128), tr = new Float32Array(128);
    p.process([[x, x]], [[l, r], [tl, tr]]);
    out.set(l, o); tapOut.set(tl, o);
  }
  const L = p.dsp.Latency;
  for (let i = L; i < n; i++) assert.equal(out[i], src[i - L], `worklet neutral path not bit-exact at ${i}`);
  for (let i = 0; i < n; i++) assert.equal(tapOut[i], src[i], 'tap carries the signal');
  assert.deepEqual(p.sent[0], { latency: L });
  console.log(`ok   worklet: 24-bit samples in Float32 pass bit-exact (latency ${L} frames), tap and latency message`);
}
fs.rmSync(tmp, { recursive: true, force: true });
