/**
 * Complex frequency response, magnitude, (unwrapped) phase and passband group
 * delay of a length-N causal FIR, evaluated point by point.
 *
 * Reliability rule: where |H| is at or below `zeroFloor` (fraction of the
 * passband reference level), phase and group delay are reported as null.
 * At stopband zeros the phase is dominated by roundoff and group delay is
 * numerically meaningless; such values must never be presented as valid.
 */

export interface ResponsePoint {
  frequencyHz: number;
  normalizedFrequency: number;
  real: number;
  imaginary: number;
  magnitude: number;
  magnitudeDb: number;
  /** Unwrapped phase in radians, or null where magnitude is below the floor. */
  phase: number | null;
  /**
   * Group delay in samples, or null where magnitude is below the floor.
   * Validated against the symmetry-theoretic value m in the passband.
   */
  groupDelay: number | null;
  magnitudeReliable: boolean;
}

export interface EvaluateOptions {
  sampleRate: number;
  /** Frequencies in Hz, finite, 0 <= f <= fs/2. */
  frequencies: ArrayLike<number>;
  /** Fraction of peak magnitude below which phase/group delay are invalid. */
  zeroFloor?: number;
}

export function evaluateResponse(coeffs: ArrayLike<number>, options: EvaluateOptions): ResponsePoint[] {
  const { sampleRate, frequencies } = options;
  const zeroFloor = options.zeroFloor ?? 1e-3;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`invalid sampleRate ${sampleRate}`);
  }
  const points: ResponsePoint[] = [];
  let maxMag = 0;
  const raw: { re: number; im: number; f: number }[] = [];
  for (let p = 0; p < frequencies.length; p++) {
    const f = frequencies[p]!;
    if (!Number.isFinite(f) || f < 0 || f > sampleRate / 2 + 1e-12) {
      throw new Error(`frequency[${p}]=${f} outside [0, ${sampleRate / 2}]`);
    }
    const omega = (2 * Math.PI * f) / sampleRate;
    let re = 0;
    let im = 0;
    for (let n = 0; n < coeffs.length; n++) {
      const h = coeffs[n]!;
      const phase = omega * n;
      re += h * Math.cos(phase);
      im -= h * Math.sin(phase);
    }
    const mag = Math.hypot(re, im);
    maxMag = Math.max(maxMag, mag);
    raw.push({ re, im, f });
  }
  const ref = maxMag > 0 ? maxMag : 1;
  // Absolute floor protects deep stopband zeros even when the passband
  // reference magnitude is ~1 (normalized designs).
  const absFloor = Math.max(zeroFloor * ref, 1e-12);

  const wrapped: number[] = [];
  for (const r of raw) {
    points.push({
      frequencyHz: r.f,
      normalizedFrequency: (2 * r.f) / sampleRate,
      real: r.re,
      imaginary: r.im,
      magnitude: Math.hypot(r.re, r.im),
      magnitudeDb: 20 * Math.log10(Math.max(Math.hypot(r.re, r.im), Number.MIN_VALUE)),
      phase: null,
      groupDelay: null,
      magnitudeReliable: Math.hypot(r.re, r.im) > absFloor,
    });
    wrapped.push(Math.atan2(r.im, r.re));
  }

  const unwrapped = unwrap(wrapped);
  const center = (coeffs.length - 1) / 2;
  for (let p = 0; p < points.length; p++) {
    if (!points[p]!.magnitudeReliable) continue;
    points[p]!.phase = unwrapped[p]!;
    points[p]!.groupDelay = localGroupDelay(coeffs, sampleRate, raw[p]!.f, center, zeroFloor * ref);
  }
  return points;
}

/** Complex DFT of coeffs at frequency f. */
function dft(coeffs: ArrayLike<number>, sampleRate: number, f: number): { re: number; im: number; mag: number } {
  const omega = (2 * Math.PI * f) / sampleRate;
  let re = 0;
  let im = 0;
  for (let n = 0; n < coeffs.length; n++) {
    const h = coeffs[n]!;
    re += h * Math.cos(omega * n);
    im -= h * Math.sin(omega * n);
  }
  return { re, im, mag: Math.hypot(re, im) };
}

/**
 * Group delay via the local phase increment arg(H+ conj(H-)). The half-step
 * is chosen so m*domega <= 0.25 < pi, which avoids the 2*pi branch ambiguity
 * that coarse output grids cause. Both probe magnitudes must clear the floor;
 * otherwise the result is null (unreliable near zeros and at band edges).
 */
function localGroupDelay(
  coeffs: ArrayLike<number>,
  sampleRate: number,
  f: number,
  center: number,
  absFloor: number,
): number | null {
  const nyquist = sampleRate / 2;
  const deltaHz = Math.min(0.25 / Math.max(center, 1) / (2 * Math.PI) * sampleRate, f, nyquist - f);
  if (!(deltaHz > 0)) return null;
  const hp = dft(coeffs, sampleRate, f + deltaHz);
  const hm = dft(coeffs, sampleRate, f - deltaHz);
  if (hp.mag <= absFloor || hm.mag <= absFloor) return null;
  const domega = (4 * Math.PI * deltaHz) / sampleRate;
  // arg(H+ * conj(H-))
  const crossRe = hp.re * hm.re + hp.im * hm.im;
  const crossIm = hp.im * hm.re - hp.re * hm.im;
  return -Math.atan2(crossIm, crossRe) / domega;
}

/** Phase unwrapping on an ordered (monotonic frequency) grid. */
export function unwrap(phases: number[]): number[] {
  const out = phases.slice();
  for (let i = 1; i < out.length; i++) {
    let d = out[i]! - out[i - 1]!;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    out[i] = out[i - 1]! + d;
  }
  return out;
}

/** Uniform frequency grid 0..fs/2 inclusive, `bins+1` points. */
export function uniformGrid(sampleRate: number, bins: number): Float64Array {
  if (!Number.isInteger(bins) || bins < 1) throw new Error(`bins must be >= 1, got ${bins}`);
  const grid = new Float64Array(bins + 1);
  for (let i = 0; i <= bins; i++) grid[i] = (sampleRate / 2) * (i / bins);
  return grid;
}

/**
 * Maximum |H| over a frequency band, on a finite sampled grid.
 * This is a sampled estimate, NOT a rigorous upper bound over the
 * continuous frequency interval; callers must label it as such.
 */
export function sampledBandRipple(
  coeffs: ArrayLike<number>,
  sampleRate: number,
  band: { f0: number; f1: number },
  bins = 4096,
): { maxMagnitude: number; maxMagnitudeDb: number; sampleCount: number; sampledEstimate: true } {
  let maxMag = 0;
  let count = 0;
  for (let i = 0; i <= bins; i++) {
    const f = band.f0 + ((band.f1 - band.f0) * i) / bins;
    const omega = (2 * Math.PI * f) / sampleRate;
    let re = 0;
    let im = 0;
    for (let n = 0; n < coeffs.length; n++) {
      const h = coeffs[n]!;
      re += h * Math.cos(omega * n);
      im -= h * Math.sin(omega * n);
    }
    maxMag = Math.max(maxMag, Math.hypot(re, im));
    count++;
  }
  return {
    maxMagnitude: maxMag,
    maxMagnitudeDb: 20 * Math.log10(Math.max(maxMag, Number.MIN_VALUE)),
    sampleCount: count,
    sampledEstimate: true,
  };
}
