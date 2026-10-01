import { ApiError, isFiniteNumber } from "./errors.ts";

export interface SyntheticSignal {
  kind: "impulse" | "step" | "sine" | "noise" | "sum";
  sampleRate: number;
  samples: number[];
}

export interface SignalSpec {
  kind: "impulse" | "step" | "sine" | "noise";
  sampleRate: number;
  duration?: number;
  frequency?: number;
  amplitude?: number;
  phase?: number;
  seed?: number;
}

export function validateSampleRate(sampleRate: unknown): asserts sampleRate is number {
  if (!isFiniteNumber(sampleRate) || (sampleRate as number) <= 0) {
    throw new ApiError("VALIDATION_ERROR", "sampleRate must be a positive finite number");
  }
}

export function generate(spec: SignalSpec): number[] {
  validateSampleRate(spec.sampleRate);
  const fs = spec.sampleRate;
  const amp = spec.amplitude ?? 1;
  if (!isFiniteNumber(amp)) throw new ApiError("VALIDATION_ERROR", "amplitude must be finite");

  if (spec.kind === "impulse") {
    const n = sampleCount(spec.duration, fs, 1);
    const out = new Array<number>(n).fill(0);
    out[0] = amp;
    return out;
  }
  if (spec.kind === "step") {
    const n = sampleCount(spec.duration, fs, 1);
    return new Array<number>(n).fill(amp);
  }
  if (spec.kind === "sine") {
    if (!isFiniteNumber(spec.frequency) || (spec.frequency as number) < 0) {
      throw new ApiError("VALIDATION_ERROR", "frequency must be a finite non-negative number");
    }
    if ((spec.frequency as number) >= fs / 2) {
      throw new ApiError(
        "CUTOFF_OUT_OF_RANGE",
        "sine frequency must be below Nyquist"
      );
    }
    const n = sampleCount(spec.duration, fs, fs);
    const phase = spec.phase ?? 0;
    const out: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = amp * Math.sin(2 * Math.PI * (spec.frequency as number) * (i / fs) + phase);
    }
    return out;
  }
  // noise: deterministic mulberry32 PRNG so runs with the same seed repeat
  const n = sampleCount(spec.duration, fs, fs);
  const rng = mulberry32(spec.seed ?? 12345);
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * (2 * rng() - 1);
  return out;
}

function sampleCount(duration: number | undefined, fs: number, fallback: number): number {
  if (duration === undefined) return Math.ceil(fallback);
  if (!isFiniteNumber(duration) || duration <= 0) {
    throw new ApiError("VALIDATION_ERROR", "duration must be a positive finite number (seconds)");
  }
  return Math.max(1, Math.round(duration * fs));
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
