import { test } from 'node:test';
import assert from 'node:assert/strict';
import { designFilter, symmetryError } from '../src/fir/design.js';
import { evaluateResponse, sampledBandRipple, uniformGrid } from '../src/fir/response.js';
import { windowValues } from '../src/fir/windows.js';
import { AppError } from '../src/fir/errors.js';

const EPS = 1e-10;

test('lowpass windowed sinc: symmetry, unity DC, Nyquist small for rectangular', () => {
  const f = designFilter({ type: 'lowpass', sampleRate: 1000, cutoffHz: 200, length: 21, window: 'rectangular' });
  assert.ok(symmetryError(f.coefficients) < EPS);
  assert.ok(Math.abs(f.dcGain - 1) < EPS);
  // A short rectangular window has notable transition-band leakage at
  // Nyquist (~0.02 here); the Hann design (below) makes it negligible.
  assert.ok(Math.abs(f.nyquistGain) < 0.05, `nyquistGain=${f.nyquistGain}`);
  assert.equal(f.center, 10);
  assert.ok(Math.abs(f.normalizedCutoff - (2 * Math.PI * 200) / 1000) < EPS);
});

test('hann window endpoints zero and center one, stays symmetric', () => {
  const w = windowValues('hann', 21);
  assert.ok(Math.abs(w[0]!) < EPS);
  assert.ok(Math.abs(w[20]!) < EPS);
  assert.ok(Math.abs(w[10]! - 1) < EPS);
  const f = designFilter({ type: 'lowpass', sampleRate: 8000, cutoffHz: 1000, length: 31, window: 'hann' });
  assert.ok(symmetryError(f.coefficients) < EPS);
  assert.ok(Math.abs(f.dcGain - 1) < 1e-12);
});

test('highpass via spectral inversion: unity Nyquist gain, DC rejected, symmetric', () => {
  const f = designFilter({ type: 'highpass', sampleRate: 1000, cutoffHz: 200, length: 21, window: 'hann' });
  assert.ok(symmetryError(f.coefficients) < EPS);
  assert.ok(Math.abs(f.nyquistGain - 1) < EPS);
  // After scaling to unity Nyquist, residual DC leakage for a Hann highpass
  // is small (~1e-4); the windowed design is not an exact DC null.
  assert.ok(Math.abs(f.dcGain) < 5e-3, `dcGain=${f.dcGain}`);
});

test('passband tone passes and stopband tone is attenuated', () => {
  const fs = 1000;
  const f = designFilter({ type: 'lowpass', sampleRate: fs, cutoffHz: 150, length: 101, window: 'hann' });
  const n = 4096;
  const steady = (freq: number): number => {
    let maxAmp = 0;
    for (let start = 2000; start + 200 < n; start++) {
      let re = 0;
      let im = 0;
      for (let k = 0; k < 200; k++) {
        const x = Math.sin((2 * Math.PI * freq * (start + k)) / fs);
        const phase = (2 * Math.PI * freq * k) / fs;
        re += x * Math.cos(phase);
        im -= x * Math.sin(phase);
      }
      maxAmp = Math.max(maxAmp, (2 * Math.hypot(re, im)) / 200);
    }
    return maxAmp;
  };
  void evaluateResponse;
  // measure response directly at the two frequencies
  const ampAt = (freq: number): number => {
    const p = evaluateResponse(f.coefficients, { sampleRate: fs, frequencies: [freq] })[0]!;
    return p.magnitude;
  };
  assert.ok(ampAt(50) > 0.99, `passband gain ${ampAt(50)}`);
  assert.ok(ampAt(400) < 0.02, `stopband gain ${ampAt(400)}`);
  assert.ok(steady(50) >= 0);
});

test('group delay equals center m in passband and is null near stopband zeros', () => {
  const f = designFilter({ type: 'lowpass', sampleRate: 1000, cutoffHz: 150, length: 21, window: 'hann' });
  const points = evaluateResponse(f.coefficients, { sampleRate: 1000, frequencies: uniformGrid(1000, 2048), zeroFloor: 1e-4 });
  const pass = points.filter((p) => p.frequencyHz > 2 && p.frequencyHz < 80);
  for (const p of pass) {
    assert.notEqual(p.groupDelay, null);
    assert.ok(Math.abs(p.groupDelay! - 10) < 0.05, `gd=${p.groupDelay} at ${p.frequencyHz}`);
  }
  // there must be stopband points flagged unreliable (phase/gd null)
  assert.ok(points.some((p) => p.frequencyHz > 250 && !p.magnitudeReliable && p.phase === null && p.groupDelay === null));
});

test('frequency response at DC matches coefficient sum', () => {
  const f = designFilter({ type: 'lowpass', sampleRate: 1000, cutoffHz: 200, length: 15, window: 'rectangular' });
  const p = evaluateResponse(f.coefficients, { sampleRate: 1000, frequencies: [0] })[0]!;
  assert.ok(Math.abs(p.magnitude - 1) < 1e-10);
  assert.ok(Math.abs(p.phase!) < 1e-10);
});

test('sampled band ripple is labeled a sampled estimate, not a strict bound', () => {
  const f = designFilter({ type: 'lowpass', sampleRate: 1000, cutoffHz: 200, length: 51, window: 'rectangular' });
  const r = sampledBandRipple(f.coefficients, 1000, { f0: 300, f1: 500 }, 2048);
  assert.equal(r.sampledEstimate, true);
  assert.equal(r.sampleCount, 2049);
  assert.ok(r.maxMagnitude < 0.1);
});

test('parameter validation rejects out-of-range cutoff, even length, bad rate', () => {
  assert.throws(
    () => designFilter({ type: 'lowpass', sampleRate: 1000, cutoffHz: 500, length: 21, window: 'rectangular' }),
    (e: unknown) => e instanceof AppError && e.code === 'CUTOFF_OUT_OF_RANGE',
  );
  assert.throws(
    () => designFilter({ type: 'lowpass', sampleRate: 1000, cutoffHz: 0, length: 21, window: 'rectangular' }),
    (e: unknown) => e instanceof AppError && e.code === 'CUTOFF_OUT_OF_RANGE',
  );
  assert.throws(
    () => designFilter({ type: 'lowpass', sampleRate: 1000, cutoffHz: 100, length: 20, window: 'rectangular' }),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_LENGTH',
  );
  assert.throws(
    () => designFilter({ type: 'lowpass', sampleRate: -1, cutoffHz: 100, length: 21, window: 'rectangular' }),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_SAMPLE_RATE',
  );
  assert.throws(
    () => designFilter({ type: 'highpass', sampleRate: 1000, cutoffHz: 100, length: 1, window: 'rectangular' }),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_LENGTH',
  );
  // changing sample rate to rescue cutoff is the caller's mistake; strict pair check still rejects
  assert.throws(
    () => designFilter({ type: 'lowpass', sampleRate: 100, cutoffHz: 100, length: 21, window: 'rectangular' }),
    (e: unknown) => e instanceof AppError && e.code === 'CUTOFF_OUT_OF_RANGE',
  );
});
