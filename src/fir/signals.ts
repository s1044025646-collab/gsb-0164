import { AppError, assertFiniteVector } from './errors.js';

/**
 * Deterministic synthetic test signals. No randomness without an injected
 * seeded PRNG, so every demo and test is reproducible.
 */

export interface SignalMeta {
  name: string;
  sampleRate: number;
  durationSamples: number;
}

export function impulse(sampleRate: number, length: number, at = 0): Float64Array {
  validateSignalParams(sampleRate, length);
  if (at < 0 || at >= length) throw new AppError('VALIDATION_ERROR', `impulse index ${at} outside [0,${length})`);
  const x = new Float64Array(length);
  x[at] = 1;
  return x;
}

export function step(sampleRate: number, length: number, startAt = 0): Float64Array {
  validateSignalParams(sampleRate, length);
  if (startAt < 0 || startAt >= length) {
    throw new AppError('VALIDATION_ERROR', `step start ${startAt} outside [0,${length})`);
  }
  const x = new Float64Array(length);
  for (let i = startAt; i < length; i++) x[i] = 1;
  return x;
}

export function sine(sampleRate: number, frequencyHz: number, length: number, phase = 0): Float64Array {
  validateSignalParams(sampleRate, length);
  if (!Number.isFinite(frequencyHz) || frequencyHz < 0 || frequencyHz > sampleRate / 2) {
    throw new AppError('CUTOFF_OUT_OF_RANGE', `frequency ${frequencyHz} outside [0, ${sampleRate / 2}]`);
  }
  const x = new Float64Array(length);
  for (let n = 0; n < length; n++) {
    x[n] = Math.sin((2 * Math.PI * frequencyHz * n) / sampleRate + phase);
  }
  return x;
}

/** Multi-tone signal, e.g. one passband tone plus one stopband tone. */
export function multiTone(
  sampleRate: number,
  length: number,
  components: ReadonlyArray<{ frequencyHz: number; amplitude?: number; phase?: number }>,
): Float64Array {
  validateSignalParams(sampleRate, length);
  const x = new Float64Array(length).fill(0);
  for (const c of components) {
    const amp = c.amplitude ?? 1;
    const ph = c.phase ?? 0;
    if (!Number.isFinite(amp) || !Number.isFinite(ph)) {
      throw new AppError('NON_FINITE_SAMPLE', 'tone amplitude/phase must be finite');
    }
    if (!Number.isFinite(c.frequencyHz) || c.frequencyHz < 0 || c.frequencyHz > sampleRate / 2) {
      throw new AppError('CUTOFF_OUT_OF_RANGE', `tone frequency ${c.frequencyHz} outside [0, ${sampleRate / 2}]`);
    }
    for (let n = 0; n < length; n++) {
      x[n]! += amp * Math.sin((2 * Math.PI * c.frequencyHz! * n) / sampleRate + ph);
    }
  }
  assertFiniteVector(x, 'multiTone');
  return x;
}

/** Deterministic mulberry32 noise; pass a seed explicitly for reproducibility. */
export function seededNoise(sampleRate: number, length: number, seed: number, amplitude = 1): Float64Array {
  validateSignalParams(sampleRate, length);
  if (!Number.isFinite(seed)) throw new AppError('VALIDATION_ERROR', 'seed must be finite');
  let a = seed >>> 0;
  const rand = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const x = new Float64Array(length);
  for (let n = 0; n < length; n++) x[n] = amplitude * (2 * rand() - 1);
  return x;
}

function validateSignalParams(sampleRate: number, length: number): void {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new AppError('INVALID_SAMPLE_RATE', `sampleRate must be > 0, got ${sampleRate}`);
  }
  if (!Number.isInteger(length) || length < 0) {
    throw new AppError('INVALID_BLOCK', `length must be a non-negative integer, got ${length}`);
  }
}

export function rms(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(x.length, 1));
}
