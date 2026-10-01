import { AppError } from './errors.js';
import { WindowType, windowValues } from './windows.js';

export type FilterType = 'lowpass' | 'highpass';

export interface DesignParams {
  type: FilterType;
  sampleRate: number;
  cutoffHz: number;
  length: number;
  window: WindowType;
}

export interface DesignedFilter {
  params: DesignParams;
  coefficients: Float64Array;
  center: number;
  normalizedCutoff: number;
  dcGain: number;
  nyquistGain: number;
  dcScale: number;
  nyquistScale: number;
}

/**
 * Validate parameters exactly. Sample rate is never adjusted to make the
 * cutoff legal: the submitted (sampleRate, cutoffHz) pair must satisfy
 * 0 < cutoffHz < sampleRate/2 (strict Nyquist, no DC/Nyquist edge filter).
 */
export function validateParams(params: DesignParams): void {
  const { type, sampleRate, cutoffHz, length } = params;
  if (type !== 'lowpass' && type !== 'highpass') {
    throw new AppError('UNSUPPORTED_FILTER_TYPE', `type must be lowpass|highpass, got ${String(type)}`);
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new AppError('INVALID_SAMPLE_RATE', `sampleRate must be > 0 Hz, got ${sampleRate}`);
  }
  if (!Number.isInteger(length) || length <= 0) {
    throw new AppError('INVALID_LENGTH', `length must be a positive integer, got ${length}`);
  }
  if (length % 2 === 0) {
    throw new AppError('INVALID_LENGTH', `length must be odd, got even ${length}`);
  }
  if (type === 'highpass' && length < 3) {
    throw new AppError('INVALID_LENGTH', `highpass requires length >= 3, got ${length}`);
  }
  if (!Number.isFinite(cutoffHz) || cutoffHz <= 0 || cutoffHz >= sampleRate / 2) {
    throw new AppError(
      'CUTOFF_OUT_OF_RANGE',
      `cutoffHz must satisfy 0 < cutoff < sampleRate/2 ` +
        `(sampleRate=${sampleRate}, nyquist=${sampleRate / 2}, got ${cutoffHz})`,
      { cutoffHz, sampleRate, nyquist: sampleRate / 2 },
    );
  }
}

/**
 * Windowed-sinc FIR design.
 *
 * Normalized cutoff: omega_c = 2*pi*fc/fs, ideal impulse response
 *   h_lp[n] = sin(omega_c (n-m)) / (pi (n-m)),  h_lp[m] = omega_c/pi,
 * with m = (N-1)/2 the center tap (fractional-sinc limit handled explicitly).
 *
 * Highpass via spectral inversion:
 *   h_hp[n] = -h_lp[n] (n != m), h_hp[m] = 1 - h_lp[m].
 *
 * Gain normalization:
 *   lowpass  -> H(0)     = sum h  scaled to exactly 1 (unity DC gain);
 *   highpass -> H(pi)    = sum (-1)^n h scaled to exactly 1 (unity Nyquist gain;
 *               m is an integer for odd N, so the delayed delta lands at +1).
 * Returns scale = post/pre for auditability.
 */
export function designFilter(params: DesignParams): DesignedFilter {
  validateParams(params);
  const { type, sampleRate, cutoffHz, length, window } = params;
  const center = (length - 1) / 2;
  const omegaC = (2 * Math.PI * cutoffHz) / sampleRate;
  const win = windowValues(window, length);

  const lp = new Float64Array(length);
  for (let n = 0; n < length; n++) {
    const k = n - center;
    const sinc = k === 0 ? omegaC / Math.PI : Math.sin(omegaC * k) / (Math.PI * k);
    lp[n] = sinc * win[n]!;
  }

  let coeffs = lp;
  if (type === 'highpass') {
    coeffs = new Float64Array(length);
    for (let n = 0; n < length; n++) {
      coeffs[n] = n === center ? 1 - lp[n]! : -lp[n]!;
    }
  }

  let sum = 0;
  let altSum = 0;
  for (let n = 0; n < length; n++) {
    sum += coeffs[n]!;
    altSum += (n % 2 === 0 ? 1 : -1) * coeffs[n]!;
  }

  const dcGainRaw = sum;
  const nyquistGainRaw = altSum;
  let scale: number;
  if (type === 'lowpass') {
    if (dcGainRaw === 0 || !Number.isFinite(dcGainRaw)) {
      throw new AppError('VALIDATION_ERROR', 'lowpass DC gain before normalization is zero; cannot normalize');
    }
    scale = 1 / dcGainRaw;
  } else {
    if (nyquistGainRaw === 0 || !Number.isFinite(nyquistGainRaw)) {
      throw new AppError('VALIDATION_ERROR', 'highpass Nyquist gain before normalization is zero; cannot normalize');
    }
    scale = 1 / nyquistGainRaw;
  }
  for (let n = 0; n < length; n++) coeffs[n] = coeffs[n]! * scale;

  let dcGain = 0;
  let nyquistGain = 0;
  for (let n = 0; n < length; n++) {
    dcGain += coeffs[n]!;
    nyquistGain += (n % 2 === 0 ? 1 : -1) * coeffs[n]!;
  }

  return {
    params,
    coefficients: coeffs,
    center,
    normalizedCutoff: omegaC,
    dcGain,
    nyquistGain,
    dcScale: 1 / dcGainRaw,
    nyquistScale: 1 / nyquistGainRaw,
  };
}

/** Maximum absolute deviation from symmetry h[n] == h[N-1-n]. */
export function symmetryError(coeffs: ArrayLike<number>): number {
  const n = coeffs.length;
  let err = 0;
  for (let i = 0; i < Math.floor(n / 2); i++) {
    err = Math.max(err, Math.abs(coeffs[i]! - coeffs[n - 1 - i]!));
  }
  return err;
}
