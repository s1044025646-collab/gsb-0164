import { AppError, assertFiniteVector } from './errors.js';

/**
 * Causal FIR streaming filter with a persistent delay line.
 *
 * Convention (fixed, used everywhere and tested):
 *   - Startup: the delay line is initialized to N-1 zeros, so the first
 *     output aligns causally with the first input (zero-padded startup).
 *   - processBlock(x): emits exactly x.length outputs. No future samples are
 *     used; this is a causal delay-line update, NOT a centered convolution.
 *   - flush(): emits the N-1 remaining outputs after the input stream ends,
 *     then the run is finished. Output length for M inputs is M+N-1.
 *   - A run that is finished rejects further blocks (RUN_FINISHED).
 */

export interface StreamingState {
  coefficients: number[];
  /** delay[j] = x at j+1 samples in the past; delay[0] is the newest sample. */
  delay: number[];
  samplesIn: number;
  samplesOut: number;
  running: boolean;
}

export function createStreamingState(coefficients: ArrayLike<number>): StreamingState {
  assertFiniteVector(coefficients, 'coefficients');
  const h: number[] = [];
  for (let i = 0; i < coefficients.length; i++) h.push(coefficients[i]!);
  return {
    coefficients: h,
    delay: new Array(h.length - 1).fill(0),
    samplesIn: 0,
    samplesOut: 0,
    running: true,
  };
}

function tick(state: StreamingState, x: number): number {
  const h = state.coefficients;
  // y = h0*x + h1*x_-1 + ... + h[N-1]*x_-(N-1)
  let y = h[0]! * x;
  for (let j = 1; j < h.length; j++) y += h[j]! * state.delay[j - 1]!;
  // shift history: oldest drops off
  for (let j = h.length - 2; j >= 1; j--) state.delay[j] = state.delay[j - 1]!;
  state.delay[0] = x;
  return y;
}

export function processBlock(state: StreamingState, block: ArrayLike<number>): Float64Array {
  if (!state.running) throw new AppError('RUN_FINISHED', 'run has been flushed; open a new run');
  assertFiniteVector(block, 'block');
  const out = new Float64Array(block.length);
  for (let i = 0; i < block.length; i++) {
    out[i] = tick(state, block[i]!);
  }
  state.samplesIn += block.length;
  state.samplesOut += block.length;
  return out;
}

/** Emit the N-1 trailing outputs after feeding N-1 zeros. Idempotent only once. */
export function flush(state: StreamingState): Float64Array {
  if (!state.running) throw new AppError('RUN_FINISHED', 'run already flushed');
  const tail = state.coefficients.length - 1;
  const out = new Float64Array(tail);
  for (let i = 0; i < tail; i++) out[i] = tick(state, 0);
  state.samplesOut += tail;
  state.running = false;
  return out;
}

/**
 * Whole-signal reference: zero-padded causal convolution of x and h.
 * Length is x.length + h.length - 1. Independent implementation used to
 * cross-check the streaming path sample by sample.
 */
export function fullConvolution(x: ArrayLike<number>, h: ArrayLike<number>): Float64Array {
  assertFiniteVector(x, 'x');
  assertFiniteVector(h, 'h');
  const out = new Float64Array(x.length + h.length - 1);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    if (xi === 0) continue;
    for (let j = 0; j < h.length; j++) out[i + j]! += xi * h[j]!;
  }
  return out;
}

/** Convenience: filter a whole signal through the streaming state machine. */
export function filterWhole(
  coefficients: ArrayLike<number>,
  signal: Float64Array | number[],
  chunkSize?: number,
): { body: Float64Array; tail: Float64Array; full: Float64Array } {
  const state = createStreamingState(coefficients);
  const parts: Float64Array[] = [];
  if (chunkSize === undefined) {
    parts.push(processBlock(state, signal));
  } else {
    const arr = signal instanceof Float64Array ? signal : new Float64Array(signal);
    for (let i = 0; i < arr.length; i += chunkSize) {
      parts.push(processBlock(state, arr.subarray(i, Math.min(i + chunkSize, arr.length))));
    }
  }
  const body = concat(parts);
  const tail = flush(state);
  return { body, tail, full: concat([body, tail]) };
}

export function concat(arrays: ArrayLike<number>[]): Float64Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Float64Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a as ArrayLike<number>, off);
    off += a.length;
  }
  return out;
}
