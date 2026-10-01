import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Convolver,
} from "../src/convolver.ts";
import {
  complexResponse,
  design,
  frequencyResponse,
  sampledRipple,
  symmetryError,
  validateDesignParams,
  MAGNITUDE_NULL_THRESHOLD,
} from "../src/fir.ts";
import { generate } from "../src/signals.ts";
import { ApiError } from "../src/errors.ts";

test("rejects even taps, out-of-range cutoff and bad sample rates", () => {
  assert.throws(() => validateDesignParams({ sampleRate: 100, cutoff: 10, taps: 4, window: "rect", type: "lowpass" }), (e: unknown) => (e as ApiError).code === "EVEN_LENGTH");
  assert.throws(() => validateDesignParams({ sampleRate: 100, cutoff: 50, taps: 5, window: "rect", type: "lowpass" }), (e: unknown) => (e as ApiError).code === "CUTOFF_OUT_OF_RANGE");
  assert.throws(() => validateDesignParams({ sampleRate: 100, cutoff: 60, taps: 5, window: "rect", type: "lowpass" }), (e: unknown) => (e as ApiError).code === "CUTOFF_OUT_OF_RANGE");
  assert.throws(() => validateDesignParams({ sampleRate: 0, cutoff: 10, taps: 5, window: "rect", type: "lowpass" }));
});

test("cannot satisfy cutoff by secretly changing sampleRate", () => {
  // fc=90 invalid at fs=100; designing the "same" fc at a different fs is a
  // different design and still validated there.
  assert.throws(() => design({ sampleRate: 100, cutoff: 90, taps: 5, window: "rect", type: "lowpass" }));
  const c = design({ sampleRate: 1000, cutoff: 90, taps: 5, window: "rect", type: "lowpass" });
  assert.ok(c.every((x) => Number.isFinite(x)));
});

test("coefficients are symmetric (linear phase)", () => {
  for (const win of ["rect", "hann"] as const) {
    const c = design({ sampleRate: 8000, cutoff: 1200, taps: 33, window: win, type: "lowpass" });
    assert.ok(symmetryError(c) < 1e-15);
  }
});

test("lowpass has unity DC gain; highpass has unity Nyquist gain and ~zero at DC", () => {
  const lp = design({ sampleRate: 8000, cutoff: 1000, taps: 31, window: "hann", type: "lowpass" });
  const dc = complexResponse(lp, 0);
  assert.ok(Math.abs(Math.hypot(dc.re, dc.im) - 1) < 1e-12);

  const hp = design({ sampleRate: 8000, cutoff: 1000, taps: 31, window: "hann", type: "highpass" });
  const hpDc = complexResponse(hp, 0);
  assert.ok(Math.abs(hpDc.re) < 1e-9);
  const nyq = complexResponse(hp, Math.PI);
  assert.ok(Math.abs(Math.hypot(nyq.re, nyq.im) - 1) < 1e-9);
});

test("impulse response reproduces the coefficients", () => {
  const lp = design({ sampleRate: 8000, cutoff: 1000, taps: 7, window: "rect", type: "lowpass" });
  const imp = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const y = Convolver.fullConvolve(lp, imp);
  for (let i = 0; i < lp.length; i++) assert.ok(Math.abs((y[i] as number) - (lp[i] as number)) < 1e-15);
});

test("streamed chunked processing equals full convolution (incl. empty/tiny blocks and tail)", () => {
  const lp = design({ sampleRate: 8000, cutoff: 1000, taps: 11, window: "hann", type: "lowpass" });
  const input = generate({ kind: "noise", sampleRate: 8000, duration: 0.01, seed: 42 });
  const chunkSets: number[][] = [
    [1, 0, 5, 3, 0, 71], // zero-length blocks, tiny first block, uneven tail
    [40, 40],
    [input.length],
  ];
  for (const sizes of chunkSets) {
    const conv = new Convolver(lp);
    const streamed: number[] = [];
    let pos = 0;
    for (const size of sizes) {
      const block = input.slice(pos, pos + size);
      pos += size;
      const out = conv.process(block);
      assert.equal(out.length, block.length); // startup zero-padding: k in -> k out
      streamed.push(...out);
    }
    assert.equal(pos, input.length);
    const tail = conv.flush();
    assert.equal(tail.length, lp.length - 1);
    streamed.push(...tail);
    const ref = Convolver.fullConvolve(lp, input);
    assert.equal(streamed.length, input.length + lp.length - 1);
    for (let i = 0; i < ref.length; i++) {
      assert.ok(Math.abs((streamed[i] as number) - (ref[i] as number)) < 1e-14, `mismatch at ${i}`);
    }
  }
});

test("delay-line serialization resumes exactly like unbroken processing", () => {
  const lp = design({ sampleRate: 8000, cutoff: 900, taps: 9, window: "rect", type: "lowpass" });
  const input = generate({ kind: "noise", sampleRate: 8000, duration: 0.008, seed: 7 });
  const a = new Convolver(lp);
  const outA1 = a.process(input.slice(0, 30));
  // serialize + reconstruct (simulate process restart)
  const b = new Convolver(lp, structuredClone(a.state));
  const outA2 = a.process(input.slice(30));
  const outB2 = b.process(input.slice(30));
  assert.deepEqual(outB2, outA2);
  const ta = a.flush();
  const tb = b.flush();
  assert.deepEqual(tb, ta);
  const ref = Convolver.fullConvolve(lp, input);
  const streamed = [...outA1, ...outB2, ...tb];
  for (let i = 0; i < ref.length; i++) assert.ok(Math.abs((streamed[i] as number) - (ref[i] as number)) < 1e-14);
});

test("linearity: superposition holds for the streaming filter", () => {
  const lp = design({ sampleRate: 8000, cutoff: 1500, taps: 5, window: "hann", type: "lowpass" });
  const x1 = generate({ kind: "noise", sampleRate: 8000, duration: 0.005, seed: 1 });
  const x2 = generate({ kind: "sine", sampleRate: 8000, frequency: 400, duration: 0.005 });
  const y1 = Convolver.fullConvolve(lp, x1);
  const y2 = Convolver.fullConvolve(lp, x2);
  const ys = Convolver.fullConvolve(lp, x1.map((x, i) => 2 * x + 3 * (x2[i] as number)));
  for (let i = 0; i < ys.length; i++) {
    assert.ok(Math.abs((ys[i] as number) - (2 * (y1[i] as number) + 3 * (y2[i] as number))) < 1e-13);
  }
});

test("passband sinusoid is passed, stopband sinusoid attenuated (group delay offset)", () => {
  const lp = design({ sampleRate: 8000, cutoff: 500, taps: 63, window: "hann", type: "lowpass" });
  const groupDelay = (lp.length - 1) / 2;
  const pb = generate({ kind: "sine", sampleRate: 8000, frequency: 100, duration: 0.05 });
  const sb = generate({ kind: "sine", sampleRate: 8000, frequency: 2000, duration: 0.05 });
  const ypb = Convolver.fullConvolve(lp, pb);
  const ysb = Convolver.fullConvolve(lp, sb);
  // compare steady-state amplitudes around the center, aligning group delay
  let pbMax = 0;
  let sbMax = 0;
  for (let i = pb.length / 2; i < pb.length - 5; i++) {
    pbMax = Math.max(pbMax, Math.abs(ypb[i + groupDelay] as number));
    sbMax = Math.max(sbMax, Math.abs(ysb[i + groupDelay] as number));
  }
  assert.ok(pbMax > 0.9, `passband amplitude ${pbMax}`);
  assert.ok(sbMax < 0.02, `stopband amplitude ${sbMax}`);
});

test("step response settles to unity for lowpass (DC preservation)", () => {
  const lp = design({ sampleRate: 8000, cutoff: 1000, taps: 31, window: "rect", type: "lowpass" });
  const step = new Array(200).fill(1);
  const y = Convolver.fullConvolve(lp, step);
  assert.ok(Math.abs((y[100] as number) - 1) < 1e-12);
});

test("frequency response nulls phase/group delay near spectral zeros of highpass", () => {
  const hp = design({ sampleRate: 8000, cutoff: 1000, taps: 31, window: "hann", type: "highpass" });
  const grid = frequencyResponse(hp, 8000, 4096);
  for (const bin of grid) {
    if (bin.magnitude < MAGNITUDE_NULL_THRESHOLD) {
      assert.equal(bin.phase, null);
      assert.equal(bin.groupDelay, null);
      assert.equal(bin.unwrappedPhase, null);
    } else {
      assert.equal(bin.groupDelay, 15);
    }
  }
  // DC bin must be a null
  assert.ok(grid[0]!.magnitude < MAGNITUDE_NULL_THRESHOLD);
});

test("sampled ripple is explicitly a sampled estimate", () => {
  const lp = design({ sampleRate: 8000, cutoff: 1000, taps: 31, window: "hann", type: "lowpass" });
  const r = sampledRipple(lp, 8000, [{ low: 0, high: 700 }], 4096);
  assert.ok(r.ripple >= 0);
});

test("non-finite samples are rejected", () => {
  const lp = design({ sampleRate: 8000, cutoff: 1000, taps: 5, window: "rect", type: "lowpass" });
  assert.throws(() => new Convolver(lp).process([1, NaN, 2]), (e: unknown) => (e as ApiError).code === "INVALID_SAMPLE");
  assert.throws(() => Convolver.fullConvolve(lp, [1, Infinity]), (e: unknown) => (e as ApiError).code === "INVALID_SAMPLE");
});

test("Hann beats rectangular stopband attenuation for this spec", () => {
  const rect = design({ sampleRate: 8000, cutoff: 1000, taps: 63, window: "rect", type: "lowpass" });
  const hann = design({ sampleRate: 8000, cutoff: 1000, taps: 63, window: "hann", type: "lowpass" });
  const worst = (c: number[]) => {
    let m = 0;
    for (let i = 0; i < 4096; i++) {
      const f = (4000 * i) / 4095;
      if (f < 1500) continue;
      const { re, im } = complexResponse(c, (2 * Math.PI * f) / 8000);
      m = Math.max(m, Math.hypot(re, im));
    }
    return m;
  };
  assert.ok(worst(hann) < worst(rect));
});
