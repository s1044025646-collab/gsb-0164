import { AppError } from './errors.js';

export type WindowType = 'rectangular' | 'hann';

export const WINDOW_TYPES: readonly WindowType[] = ['rectangular', 'hann'];

/**
 * Length-N analysis window w[n], n = 0 .. N-1, centered at m = (N-1)/2.
 *
 * - rectangular: w[n] = 1
 * - hann:        w[n] = 0.5 - 0.5*cos(2*pi*n/(N-1)),
 *                which is exactly 0 at n=0 and n=N-1 for N > 1 (periodic form is NOT used).
 *
 * For odd N the Hann window is symmetric around the integer center tap m,
 * keeping the overall filter symmetric (and therefore linear phase).
 */
export function windowValues(type: WindowType, length: number): Float64Array {
  if (!Number.isInteger(length) || length < 1) {
    throw new AppError('INVALID_LENGTH', `window length must be a positive integer, got ${length}`);
  }
  const w = new Float64Array(length);
  if (type === 'rectangular') {
    w.fill(1);
    return w;
  }
  if (type === 'hann') {
    if (length === 1) {
      w[0] = 1;
      return w;
    }
    const denom = length - 1;
    for (let n = 0; n < length; n++) {
      w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / denom);
    }
    return w;
  }
  throw new AppError('UNSUPPORTED_WINDOW', `unsupported window type: ${String(type)}`);
}

export function isWindowType(value: string): value is WindowType {
  return (WINDOW_TYPES as readonly string[]).includes(value);
}
