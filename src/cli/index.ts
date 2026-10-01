#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDb } from "../db.ts";
import {
  coefficientsOf,
  createDesign,
  createRun,
  createSignal,
  getDesign,
  getRun,
  processBlock,
  runFrequencyResponse,
} from "../services.ts";
import { design, frequencyResponse, sampledRipple, symmetryError } from "../fir.ts";
import { generate } from "../signals.ts";
import { Convolver } from "../convolver.ts";
import { exportDesignResponse, exportRun } from "../exporter.ts";
import { ApiError } from "../errors.ts";

const args = process.argv.slice(2);
const command = args.shift();
const DB_PATH = process.env.FIR_DB_PATH ?? "data/fir.sqlite";

function db() {
  const abs = resolve(DB_PATH);
  mkdirSync(dirname(abs), { recursive: true });
  return openDb(abs);
}

function flag(name: string, fallback?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return args[i + 1];
}

function num(name: string): number {
  const v = Number(flag(name));
  if (!Number.isFinite(v)) throw new ApiError("VALIDATION_ERROR", `--${name} is required and must be a number`);
  return v;
}

function statusLine(label: string, run: ReturnType<typeof getRun>): void {
  console.log(
    `${label}: run#${run.id} status=${run.status} processed=${run.processed_inputs} tailLen=${JSON.parse(run.tail).length} delayLen=${JSON.parse(run.delay).length}`
  );
}

function printCoeffs(c: number[], max = 12): void {
  const shown = c.slice(0, max);
  console.log(`  taps=${c.length} symmetryError=${symmetryError(c).toExponential(3)}`);
  console.log(`  coefficients[0..${shown.length - 1}]=`, shown.map((x) => x.toPrecision(8)).join(" "));
}

async function main(): Promise<void> {
  switch (command) {
    case "design": {
      const d = createDesign(db(), {
        type: (flag("type", "lowpass") as "lowpass" | "highpass"),
        sampleRate: num("fs"),
        cutoff: num("fc"),
        taps: num("taps"),
        window: (flag("window", "rect") as "rect" | "hann"),
        name: flag("name"),
      }, flag("idempotency-key"));
      console.log(`BEFORE: no design`);
      console.log(`AFTER:  design#${d.id} v${d.version} ${d.type} fs=${d.sample_rate} fc=${d.cutoff} taps=${d.taps} window=${d.window}`);
      printCoeffs(coefficientsOf(d));
      break;
    }
    case "show": {
      const d = getDesign(db(), num("id"));
      console.log(`design#${d.id} v${d.version} ${d.type} fs=${d.sample_rate} fc=${d.cutoff} taps=${d.taps} window=${d.window}`);
      printCoeffs(coefficientsOf(d), Number(flag("max", "64")));
      break;
    }
    case "response": {
      const res = runFrequencyResponse(db(), num("id"), Number(flag("bins", "17")));
      console.log(`design#${res.designId} frequency response (${res.bins.length} grid points, sampled estimate):`);
      for (const b of res.bins) {
        console.log(
          `  f=${b.f.toFixed(5).padStart(10)}  |H|=${b.magnitude.toExponential(8).padStart(13)}  phase=${
            b.phase === null ? "   null(unreliable)" : b.phase.toExponential(8)
          }  gd=${b.groupDelay === null ? "null" : b.groupDelay}`
        );
      }
      break;
    }
    case "filter": {
      // filter --design ID (--signal ID | --file path.json) [--chunks N] [--flush]
      const database = db();
      const designId = num("design");
      const signalId = flag("signal") ? num("signal") : null;
      const run = createRun(database, designId, signalId);
      let samples: number[];
      if (flag("file")) {
        samples = JSON.parse(readFileSync(resolve(flag("file") as string), "utf8")) as number[];
      } else if (flag("signal")) {
        const { getSignal } = await import("../services.ts");
        samples = JSON.parse(getSignal(database, num("signal")).samples) as number[];
      } else {
        throw new ApiError("VALIDATION_ERROR", "provide --signal ID or --file samples.json");
      }
      statusLine("BEFORE", run);
      const chunks = Number(flag("chunks", "1"));
      const size = Math.ceil(samples.length / chunks);
      const all: number[] = [];
      for (let i = 0; i < chunks; i++) {
        const block = samples.slice(i * size, (i + 1) * size);
        if (block.length === 0) continue; // empty blocks are legal but produce no output
        const r = processBlock(database, run.id, block, "process");
        all.push(...r.outputs);
      }
      let mid = getRun(database, run.id);
      statusLine("AFTER-PROCESS", mid);
      if (flag("flush") === "true" || flag("flush") === "1") {
        const r = processBlock(database, run.id, [], "flush");
        all.push(...r.outputs);
      }
      const final = getRun(database, run.id);
      statusLine("AFTER", final);
      console.log(`outputs=${all.length} first8=`, all.slice(0, 8).map((x) => x.toPrecision(6)).join(" "));
      if (flag("out")) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(resolve(flag("out") as string), JSON.stringify(all));
        console.log(`written ${flag("out")}`);
      }
      break;
    }
    case "pause": {
      const database = db();
      const before = getRun(database, num("run"));
      statusLine("BEFORE", before);
      processBlock(database, num("run"), [], "pause");
      statusLine("AFTER", getRun(database, num("run")));
      break;
    }
    case "resume": {
      const database = db();
      statusLine("BEFORE", getRun(database, num("run")));
      processBlock(database, num("run"), [], "resume");
      statusLine("AFTER", getRun(database, num("run")));
      break;
    }
    case "flush": {
      const database = db();
      statusLine("BEFORE", getRun(database, num("run")));
      const r = processBlock(database, num("run"), [], "flush");
      statusLine("AFTER", getRun(database, num("run")));
      console.log(`tail outputs (${r.outputs.length}):`, r.outputs.map((x) => x.toPrecision(6)).join(" "));
      break;
    }
    case "compare": {
      // compare --fs --fc --taps [--type lowpass]
      const fs2 = num("fs");
      const fc = num("fc");
      const taps = num("taps");
      const type = (flag("type", "lowpass") as "lowpass" | "highpass");
      for (const win of ["rect", "hann"] as const) {
        const c = design({ sampleRate: fs2, cutoff: fc, taps, window: win, type });
        const passEdge = type === "lowpass" ? Math.max(0, fc * 0.7) : Math.min(fs2 / 2 * 0.98, fc * 1.3);
        const bands = type === "lowpass" ? [{ low: 0, high: fc * 0.7 }] : [{ low: fc * 1.3, high: fs2 / 2 * 0.98 }];
        const r = sampledRipple(c, fs2, bands, 4096);
        console.log(`window=${win.padEnd(4)} sum=${c.reduce((a, b) => a + b, 0).toPrecision(8)} passbandRipple(sampled,<=${passEdge.toFixed(1)})=${r.ripple.toExponential(3)}`);
        console.log("  NOTE: ripple is a maximum over a finite frequency grid, not a continuous-domain bound.");
      }
      break;
    }
    case "export": {
      const database = db();
      if (flag("design")) {
        const p = exportDesignResponse(database, num("design"), flag("out") ?? "exports/response.csv");
        console.log(`exported frequency response to ${p}`);
      } else if (flag("run")) {
        const p = exportRun(database, num("run"), flag("out") ?? "exports/run.csv");
        console.log(`exported run tail to ${p}`);
      } else throw new ApiError("VALIDATION_ERROR", "export needs --design ID or --run ID");
      break;
    }
    case "demo": {
      await runDemo();
      break;
    }
    default:
      console.log(`fir-flow CLI
usage:
  fir design --fs 8000 --fc 1000 --taps 31 --window rect|hann --type lowpass|highpass
  fir show --id N
  fir response --id N [--bins 17]
  fir filter --design N --signal S [--chunks 3] [--flush 1] [--out path.json]
  fir filter --design N --file samples.json
  fir pause --run N | fir resume --run N | fir flush --run N
  fir compare --fs 8000 --fc 1000 --taps 31 [--type highpass]
  fir export --design N [--out exports/response.csv]
  fir demo`);
  }
}

/** Repeatable end-to-end demo using the project-local database and seeded noise. */
async function runDemo(): Promise<void> {
  process.env.FIR_DB_PATH = "data/demo.sqlite";
  const database = db();
  const lp = createDesign(database, { type: "lowpass", sampleRate: 8000, cutoff: 800, taps: 31, window: "hann", name: "demo-lp" }, "demo-lp-v1");
  console.log(`1) designed lowpass #${lp.id}: dc gain check`);
  const sig = createSignal(
    database,
    { kind: "sine", sampleRate: 8000, frequency: 300, duration: 0.02, amplitude: 1, name: "passband-300Hz" },
    "demo-sig-300"
  );
  const run = createRun(database, lp.id, sig.id);
  const samples = JSON.parse(sig.samples) as number[];
  const half = Math.floor(samples.length / 2);
  const r1 = processBlock(database, run.id, samples.slice(0, half), "process");
  processBlock(database, run.id, [], "pause");
  console.log("2) processed first half then PAUSED; delay line persisted");
  processBlock(database, run.id, [], "resume");
  const r2 = processBlock(database, run.id, samples.slice(half), "process");
  const r3 = processBlock(database, run.id, [], "flush");
  console.log(`3) RESUMED, processed rest, flushed ${r3.outputs.length} tail samples`);
  const streamed = [...r1.outputs, ...r2.outputs, ...r3.outputs];
  const reference = Convolver.fullConvolve(coefficientsOf(lp), samples);
  let maxErr = 0;
  for (let i = 0; i < reference.length; i++) {
    maxErr = Math.max(maxErr, Math.abs((streamed[i] as number) - (reference[i] as number)));
  }
  console.log(`4) streamed vs full-convolution max abs error: ${maxErr.toExponential(3)} (len ${streamed.length} vs ${reference.length})`);
  const hp = createDesign(database, { type: "highpass", sampleRate: 8000, cutoff: 2000, taps: 31, window: "hann" }, undefined);
  const grid = frequencyResponse(coefficientsOf(hp), 8000, 3);
  console.log(`5) highpass #${hp.id}: |H(0)|=${grid[0]!.magnitude.toExponential(3)} |H(Nyq)|=${grid[2]!.magnitude.toFixed(6)}`);
  console.log("demo complete; database at data/demo.sqlite (delete data/demo.sqlite* to reset)");
}

main().catch((err: unknown) => {
  if (err instanceof ApiError) {
    console.error(`ERROR [${err.code}] ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details));
  } else {
    console.error(err);
  }
  process.exit(1);
});

