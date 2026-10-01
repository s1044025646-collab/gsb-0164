import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { coefficientsOf, getDesign } from "./services.ts";
import { frequencyResponse } from "./fir.ts";
import { getRun } from "./services.ts";

export function exportDesignResponse(db: DatabaseSync, designId: number, outPath: string, bins = 513): string {
  const d = getDesign(db, designId);
  const grid = frequencyResponse(coefficientsOf(d), d.sample_rate, bins);
  const lines = ["frequency_hz,real,imag,magnitude_db,phase_rad,group_delay_samples"];
  for (const b of grid) {
    lines.push(
      [
        b.f.toFixed(12),
        b.re.toExponential(12),
        b.im.toExponential(12),
        (20 * Math.log10(Math.max(b.magnitude, 1e-300))).toFixed(8),
        b.phase === null ? "" : b.phase.toExponential(12),
        b.groupDelay === null ? "" : String(b.groupDelay),
      ].join(",")
    );
  }
  const abs = resolve(outPath);
  writeFileSync(abs, lines.join("\n") + "\n", "utf8");
  return abs;
}

export function exportRun(db: DatabaseSync, runId: number, outPath: string): string {
  const run = getRun(db, runId);
  const tail = JSON.parse(run.tail) as number[];
  const lines = ["index,output"];
  tail.forEach((y, i) => lines.push(`${i},${y.toExponential(15)}`));
  const abs = resolve(outPath);
  writeFileSync(abs, lines.join("\n") + "\n", "utf8");
  return abs;
}
