import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/fir/errors.js';
import {
  concat,
  createStreamingState,
  filterWhole,
  flush,
  fullConvolution,
  processBlock,
} from '../src/fir/convolution.js';
import { designFilter } from '../src/fir/design.js';
import { impulse, multiTone, sine, step } from '../src/fir/signals.js';

const coeffs = new Float64Array([0.1, 0.6, 0.3]);

test('streaming equals full causal convolution for every chunking', () => {
  const x = new Float64Array([1, -2, 3, -0.5, 4, 2, -1, 0.5]);
  const ref = fullConvolution(x, coeffs);
  for (const chunk of [1, 2, 3, 5, x.length]) {
    const got = filterWhole(coeffs, x, chunk).full;
    assert.equal(got.length, x.length + coeffs.length - 1);
    for (let i = 0; i < ref.length; i++) assert.ok(Math.abs(got[i]! - ref[i]!) < 1e-12);
  }
});

test('startup zero padding: first output = h0*x0, no future samples', () => {
  const s = createStreamingState(coeffs);
  const y = processBlock(s, [2]);
  assert.ok(Math.abs(y[0]! - 0.2) < 1e-15);
});

test('flush emits exactly N-1 tail samples then rejects more input', () => {
  const s = createStreamingState(coeffs);
  processBlock(s, [1, 1]);
  const tail = flush(s);
  assert.equal(tail.length, 2);
  assert.throws(() => processBlock(s, [1]), (e: unknown) => e instanceof AppError && e.code === 'RUN_FINISHED');
  assert.throws(() => flush(s), (e: unknown) => e instanceof AppError && e.code === 'RUN_FINISHED');
});

test('empty block produces empty output and preserves state', () => {
  const s = createStreamingState(coeffs);
  processBlock(s, [5]);
  const empty = processBlock(s, []);
  assert.equal(empty.length, 0);
  const y = processBlock(s, [0]);
  // after [5, (empty), 0]: delay newest=0, then 5 => y = 0.1*0 + 0.6*5
  assert.ok(Math.abs(y[0]! - 3.0) < 1e-12);
});

test('impulse through filter returns the coefficients with the causal delay', () => {
  const f = designFilter({ type: 'lowpass', sampleRate: 1000, cutoffHz: 200, length: 11, window: 'hann' });
  const out = filterWhole(f.coefficients, impulse(1000, 40), 3).full;
  // impulse at sample 0 -> h[n] appears at output n
  for (let n = 0; n < f.coefficients.length; n++) {
    assert.ok(Math.abs(out[n]! - f.coefficients[n]!) < 1e-12);
  }
  for (let n = f.coefficients.length; n < out.length; n++) assert.ok(Math.abs(out[n]!) < 1e-12);
});

test('linearity: a*x + b*y maps to a*H(x) + b*H(y)', () => {
  const a = new Float64Array([1, 2, -1, 3]);
  const b = new Float64Array([0, -2, 4, 1]);
  const alpha = 1.7;
  const beta = -0.6;
  const mixed = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) mixed[i] = alpha * a[i]! + beta * b[i]!;
  const ha = filterWhole(coeffs, a).full;
  const hb = filterWhole(coeffs, b).full;
  const hm = filterWhole(coeffs, mixed).full;
  for (let i = 0; i < hm.length; i++) {
    assert.ok(Math.abs(hm[i]! - (alpha * ha[i]! + beta * hb[i]!)) < 1e-12);
  }
});

test('group delay: sinusoid is delayed by center m samples', () => {
  const fs = 1000;
  const f = designFilter({ type: 'lowpass', sampleRate: fs, cutoffHz: 200, length: 21, window: 'hann' });
  const x = sine(fs, 60, 500);
  const y = filterWhole(f.coefficients, x, 7).full;
  const m = f.center;
  let best = Infinity;
  for (let n = 60; n < 300; n++) {
    best = Math.min(best, Math.abs(y[n + m]! - x[n]!));
  }
  assert.ok(best < 0.02, `delayed sine mismatch ${best}`);
});

test('superposition fixture: pass+stop multitone attenuates only stop tone', () => {
  const fs = 1000;
  const f = designFilter({ type: 'lowpass', sampleRate: fs, cutoffHz: 150, length: 101, window: 'hann' });
  const x = multiTone(fs, 4096, [
    { frequencyHz: 50, amplitude: 1 },
    { frequencyHz: 400, amplitude: 1 },
  ]);
  const y = filterWhole(f.coefficients, x, 123).full;
  const ampAt = (data: ArrayLike<number>, freq: number): number => {
    let re = 0;
    let im = 0;
    const start = 2000;
    const win = 1024;
    for (let k = 0; k < win; k++) {
      const v = data[start + k] ?? 0;
      re += v * Math.cos((2 * Math.PI * freq * k) / fs);
      im -= v * Math.sin((2 * Math.PI * freq * k) / fs);
    }
    return (2 * Math.hypot(re, im)) / win;
  };
  assert.ok(ampAt(y, 50) > 0.98);
  assert.ok(ampAt(y, 400) < 0.02);
});

test('step response of highpass settles near zero (DC blocked)', () => {
  const f = designFilter({ type: 'highpass', sampleRate: 1000, cutoffHz: 100, length: 31, window: 'hann' });
  const y = filterWhole(f.coefficients, step(1000, 200), 16).full;
  let tailMean = 0;
  for (let i = 150; i < 200; i++) tailMean += Math.abs(y[i]!);
  tailMean /= 50;
  assert.ok(tailMean < 5e-3, `tailMean=${tailMean}`);
});

test('non-finite samples are rejected', () => {
  const s = createStreamingState(coeffs);
  assert.throws(() => processBlock(s, [1, NaN]), (e: unknown) => e instanceof AppError && e.code === 'NON_FINITE_SAMPLE');
  assert.throws(() => processBlock(s, [Infinity]), (e: unknown) => e instanceof AppError && e.code === 'NON_FINITE_SAMPLE');
});

test('concat helper joins arrays', () => {
  const c = concat([new Float64Array([1, 2]), new Float64Array([3])]);
  assert.deepEqual(Array.from(c), [1, 2, 3]);
});
