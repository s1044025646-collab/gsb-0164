import { ApiError, isFiniteNumber } from "./errors.ts";

export type FilterType = "lowpass" | "highpass";
export type WindowType = "rect" | "hann";

export interface DesignParams {
  sampleRate: number;
  cutoff: number;
  taps: number;
  window: WindowType;
  type: FilterType;
}

export interface FrequencyBin {
  f: number;
  re: number;
  im: number;
  magnitude: number;
  phase: number | null;
  unwrappedPhase: number | null;
  groupDelay: number | null;
}

/** Magnitude below this threshold (linear) is treated as a spectral zero:
 *  phase and group delay there are numerically unreliable and reported null. */
export const MAGNITUDE_NULL_THRESHOLD = 1e-8;

export function validateDesignParams(p: Partial<DesignParams>): DesignParams {
  if (!isFiniteNumber(p.sampleRate) || p.sampleRate <= 0) {
    throw new ApiError("VALIDATION_ERROR", "sampleRate must be a positive finite number");
  }
  if (!isFiniteNumber(p.cutoff) || p.cutoff <= 0) {
    throw new ApiError("CUTOFF_OUT_OF_RANGE", "cutoff must be a positive finite number");
  }
  if (p.cutoff >= p.sampleRate / 2) {
    throw new ApiError(
      "CUTOFF_OUT_OF_RANGE",
      `cutoff must be strictly below Nyquist (${p.sampleRate / 2} Hz); changing sampleRate is not allowed`,
      { cutoff: p.cutoff, nyquist: p.sampleRate / 2 }
    );
  }
  if (typeof p.taps !== "number" || !Number.isInteger(p.taps) || p.taps < 1) {
    throw new ApiError("VALIDATION_ERROR", "taps must be a positive integer");
  }
  if (p.taps % 2 === 0) {
    throw new ApiError("EVEN_LENGTH", `taps must be odd, got ${p.taps}`);
  }
  if (p.window !== "rect" && p.window !== "hann") {
    throw new ApiError("VALIDATION_ERROR", "window must be 'rect' or 'hann'");
  }
  if (p.type !== "lowpass" && p.type !== "highpass") {
    throw new ApiError("VALIDATION_ERROR", "type must be 'lowpass' or 'highpass'");
  }
  return {
    sampleRate: p.sampleRate,
    cutoff: p.cutoff,
    taps: p.taps,
    window: p.window,
    type: p.type,
  };
}

export function windowValues(taps: number, window: WindowType): number[] {
  const m = (taps - 1) / 2;
  const w: number[] = new Array(taps);
  for (let n = 0; n < taps; n++) {
    if (window === "rect") {
      w[n] = 1;
    } else {
      w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (taps - 1));
    }
  }
  if (window === "hann" && taps === 1) w[0] = 1; // center-point limit
  void m;
  return w;
}

/**
 * Windowed-sinc low-pass, then optional spectral inversion for high-pass.
 *
 * Normalized cutoff: wc = 2*pi*fc/fs (rad/sample), fc strictly below fs/2.
 * Center point (n = M = (taps-1)/2): sinc(0) is taken as 1 (limit).
 * Gain normalization: the windowed prototype is divided by the sum of the
 * windowed impulse response, so the low-pass has exact unity gain at DC.
 * High-pass uses spectral inversion h_hp[n] = -h_lp[n] except h_hp[M] += 1;
 * normalization against h_lp means the high-pass has unity gain at Nyquist
 * (the point chosen after inversion), verified on the frequency grid.
 */
export function design(params: DesignParams): number[] {
  const { sampleRate, cutoff, taps, window, type } = validateDesignParams(params);
  const m = (taps - 1) / 2;
  const wc = (2 * Math.PI * cutoff) / sampleRate;
  const win = windowValues(taps, window);

  const lp: number[] = new Array(taps);
  for (let n = 0; n < taps; n++) {
    const k = n - m;
    const x = wc * k;
    const sinc = k === 0 ? 1 : Math.sin(x) / x; // center-point limit
    lp[n] = (wc / Math.PI) * sinc * (win[n] as number);
  }

  if (type === "lowpass") {
    const gain = lp.reduce((a, b) => a + b, 0);
    for (let n = 0; n < taps; n++) lp[n] = (lp[n] as number) / gain;
    return lp;
  }

  // Normalize the prototype on its DC gain BEFORE inversion.
  const lpGain = lp.reduce((a, b) => a + b, 0);
  const hp: number[] = new Array(taps);
  for (let n = 0; n < taps; n++) hp[n] = -(lp[n] as number) / lpGain;
  hp[m] = (hp[m] as number) + 1;
  // Gain normalization after spectral inversion: force unity gain at Nyquist
  // (the chosen high-pass reference point). H(pi) is real for real coeffs.
  let hNyq = 0;
  for (let n = 0; n < taps; n++) hNyq += (hp[n] as number) * (n % 2 === 0 ? 1 : -1);
  for (let n = 0; n < taps; n++) hp[n] = (hp[n] as number) / hNyq;
  return hp;
}

/** Check symmetry of a linear-phase (type I) coefficient set. */
export function symmetryError(coeffs: number[]): number {
  let err = 0;
  const m = (coeffs.length - 1) / 2;
  for (let n = 0; n < m; n++) {
    err = Math.max(err, Math.abs((coeffs[n] as number) - (coeffs[coeffs.length - 1 - n] as number)));
  }
  return err;
}

/** Complex frequency response evaluated at angular frequency w via H(e^jw) = sum h[n] e^-jwn. */
export function complexResponse(coeffs: number[], w: number): { re: number; im: number } {
  let re = 0;
  let im = 0;
  for (let n = 0; n < coeffs.length; n++) {
    const h = coeffs[n] as number;
    re += h * Math.cos(w * n);
    im -= h * Math.sin(w * n);
  }
  return { re, im };
}

/**
 * Frequency response on a grid of `bins` points over [0, fs/2].
 * Group delay is the constant linear-phase delay (taps-1)/2 samples ONLY
 * where magnitude is above MAGNITUDE_NULL_THRESHOLD; near spectral zeros the
 * wrapped phase and delay are unreliable and are reported as null.
 */
export function frequencyResponse(coeffs: number[], sampleRate: number, bins = 257): FrequencyBin[] {
  if (bins < 2) throw new ApiError("VALIDATION_ERROR", "bins must be >= 2");
  const m = (coeffs.length - 1) / 2;
  const out: FrequencyBin[] = [];
  let prevUnwrapped: number | null = null;
  for (let i = 0; i < bins; i++) {
    const f = (sampleRate / 2) * (i / (bins - 1));
    const w = (2 * Math.PI * f) / sampleRate;
    const { re, im } = complexResponse(coeffs, w);
    const magnitude = Math.hypot(re, im);
    let phase: number | null = null;
    let unwrapped: number | null = null;
    let groupDelay: number | null = null;
    if (magnitude >= MAGNITUDE_NULL_THRESHOLD) {
      phase = Math.atan2(im, re);
      if (prevUnwrapped === null) {
        unwrapped = phase;
      } else {
        const prev: number = prevUnwrapped;
        let d: number = phase - wrapTo(prev);
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        unwrapped = prev + d;
      }
      groupDelay = m; // constant for symmetric type-I FIR in the passband
      prevUnwrapped = unwrapped;
    } else {
      prevUnwrapped = null;
    }
    out.push({ f, re, im, magnitude, phase, unwrappedPhase: unwrapped, groupDelay });
  }
  return out;
}

function wrapTo(x: number): number {
  return x - 2 * Math.PI * Math.round(x / (2 * Math.PI));
}

/** Maximum passband/stopband ripple on a sampled grid (sampled estimate, NOT a
 *  strict continuous-frequency upper bound). */
export function sampledRipple(
  coeffs: number[],
  sampleRate: number,
  bands: { low: number; high: number }[],
  bins = 4096
): { ripple: number; frequencies: number[] } {
  let maxDev = 0;
  const freqs: number[] = [];
  for (let i = 0; i < bins; i++) {
    const f = (sampleRate / 2) * (i / (bins - 1));
    const inBand = bands.some((b) => f >= b.low && f <= b.high);
    if (!inBand) continue;
    const w = (2 * Math.PI * f) / sampleRate;
    const { re, im } = complexResponse(coeffs, w);
    const dev = Math.abs(Math.hypot(re, im) - 1);
    if (dev > maxDev) {
      maxDev = dev;
      freqs.length = 0;
      freqs.push(f);
    } else if (dev === maxDev) {
      freqs.push(f);
    }
  }
  return { ripple: maxDev, frequencies: freqs };
}
