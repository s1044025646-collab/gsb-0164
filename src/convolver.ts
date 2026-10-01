import { ApiError, isFiniteNumber } from "./errors.ts";

export interface ConvolverState {
  /** delay line: length taps-1, holds the most recent past input samples,
   *  delay[0] is x[n-1] (newest), delay[L-1] is x[n-(taps-1)] (oldest). */
  delay: number[];
  /** input samples accepted but not yet flushed (excludes samples in delay). */
  pending: number[];
  processedInputs: number;
  outputsProduced: number;
  flushed: boolean;
}

/**
 * Causal streaming convolution.
 *
 * Fixed rules (identical to full-signal processing, sample by sample):
 *  - startup zero-padding is implicit: before any input arrives the delay line
 *    contains zeros, so the first output is y[0] = h[0]*x[0].
 *  - each input block of length k produces exactly k outputs immediately.
 *  - after all inputs, flush() emits the remaining taps-1 tail outputs by
 *    feeding zeros, giving total output length = N + taps - 1.
 *  - no centered/future-sample convolution is used anywhere.
 */
export class Convolver {
  readonly coeffs: number[];
  state: ConvolverState;

  constructor(coeffs: number[], state?: ConvolverState) {
    this.coeffs = coeffs;
    if (state) {
      this.state = state;
    } else {
      this.state = {
        delay: new Array(Math.max(0, coeffs.length - 1)).fill(0),
        pending: [],
        processedInputs: 0,
        outputsProduced: 0,
        flushed: false,
      };
    }
  }

  validateSamples(samples: number[]): void {
    for (const x of samples) {
      if (!isFiniteNumber(x)) {
        throw new ApiError(
          "INVALID_SAMPLE",
          "all samples must be finite numbers (no NaN/Infinity)"
        );
      }
    }
  }

  /** Process one block; returns exactly samples.length outputs. */
  process(samples: number[]): number[] {
    if (this.state.flushed) {
      throw new ApiError("INVALID_STATE_TRANSITION", "convolver already flushed; create a new run");
    }
    this.validateSamples(samples);
    const h = this.coeffs;
    const delay = this.state.delay;
    const out: number[] = new Array(samples.length);
    for (let b = 0; b < samples.length; b++) {
      const x = samples[b] as number;
      let y = (h[0] as number) * x;
      for (let j = 1; j < h.length; j++) {
        y += (h[j] as number) * (delay[j - 1] as number);
      }
      // shift delay line right, insert newest at front
      for (let j = delay.length - 1; j > 0; j--) {
        delay[j] = delay[j - 1] as number;
      }
      if (delay.length > 0) delay[0] = x;
      out[b] = y;
    }
    this.state.processedInputs += samples.length;
    this.state.outputsProduced += samples.length;
    return out;
  }

  /** Emit the taps-1 zero-input tail outputs. Idempotent-ish: allowed once. */
  flush(): number[] {
    if (this.state.flushed) {
      throw new ApiError("INVALID_STATE_TRANSITION", "convolver already flushed");
    }
    const tail = this.process(new Array(this.coeffs.length - 1).fill(0));
    this.state.flushed = true;
    this.state.outputsProduced += 0; // tail already counted by process()
    return tail;
  }

  static fullConvolve(coeffs: number[], input: number[]): number[] {
    for (const x of input) {
      if (!isFiniteNumber(x)) {
        throw new ApiError("INVALID_SAMPLE", "all samples must be finite numbers");
      }
    }
    const n = input.length + coeffs.length - 1;
    const out = new Array<number>(Math.max(0, n)).fill(0);
    for (let i = 0; i < coeffs.length; i++) {
      for (let j = 0; j < input.length; j++) {
        out[i + j] = (out[i + j] as number) + (coeffs[i] as number) * (input[j] as number);
      }
    }
    return out;
  }
}
