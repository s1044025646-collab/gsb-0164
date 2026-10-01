/**
 * Reproducible end-to-end demo:
 *   1. design rectangular + Hann lowpass and compare them,
 *   2. build a passband+stopband multitone fixture,
 *   3. stream it in chunks with a pause and a simulated process restart
 *      (database closed and reopened; delay line restored),
 *   4. flush, cross-check against independent whole-signal convolution,
 *   5. exercise the HTTP API on an ephemeral loopback port,
 *   6. export results into ./tmp and stop the server.
 *
 * Run: npm run demo   (all files stay inside this project)
 */
import { rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase, closeDatabase } from '../src/db/database.js';
import { Repository } from '../src/db/repository.js';
import { FilterService } from '../src/services/filterService.js';
import { RunService } from '../src/services/runService.js';
import { designFilter } from '../src/fir/design.js';
import { fullConvolution } from '../src/fir/convolution.js';
import { multiTone, rms } from '../src/fir/signals.js';
import { createApiServer, listenLocal } from '../src/api/server.js';

const root = process.cwd();
const demoDir = resolve(root, 'tmp', 'demo');
if (existsSync(demoDir)) rmSync(demoDir, { recursive: true, force: true });
const dbPath = resolve(demoDir, 'demo.sqlite');
const fs = 8000;
const fc = 800;
const N = 63;

function log(label: string, value: string): void {
  console.log(`${label.padEnd(22)} ${value}`);
}

let db = openDatabase(dbPath);
let repo = new Repository(db);
let filterSvc = new FilterService(repo);
let runSvc = new RunService(repo);

for (const windowName of ['rectangular', 'hann'] as const) {
  const d = designFilter({ type: 'lowpass', sampleRate: fs, cutoffHz: fc, length: N, window: windowName });
  log(`window ${windowName}`, `DC=${d.dcGain.toExponential(2)} Nyquist=${d.nyquistGain.toExponential(2)}`);
}

const designed = filterSvc.design(
  { type: 'lowpass', sampleRate: fs, cutoffHz: fc, length: N, window: 'hann' },
  'demo-filter-v1',
);
const filterId = designed.filter.id;
log('filter id', String(filterId));

const signal = multiTone(fs, 4000, [
  { frequencyHz: 300, amplitude: 1 },
  { frequencyHz: 3000, amplitude: 1 },
]);
const signalRow = repo.insertSignal({
  name: 'pass300+stop3000',
  sampleRate: fs,
  kind: 'multitone',
  parameters: { pass: 300, stop: 3000 },
  data: signal,
  idempotencyKey: 'demo-signal-1',
});

let run = runSvc.create(filterId, signalRow.id);
runSvc.process(run.id, signal.subarray(0, 1000));
runSvc.pause(run.id);
runSvc.resume(run.id);
runSvc.process(run.id, signal.subarray(1000, 2500));
log('before restart', `run=${run.id} in=${repo.getRun(run.id).samples_in} status=${repo.getRun(run.id).status}`);

closeDatabase(db);
db = openDatabase(dbPath);
repo = new Repository(db);
filterSvc = new FilterService(repo);
runSvc = new RunService(repo);
runSvc.process(run.id, signal.subarray(2500));
const flushed = runSvc.flushRun(run.id);

const outputs = new Float64Array(JSON.parse(flushed.outputs) as number[]);
const reference = fullConvolution(signal, designed.designed.coefficients);
let maxDelta = 0;
for (let i = 0; i < reference.length; i++) maxDelta = Math.max(maxDelta, Math.abs(outputs[i]! - reference[i]!));
log('outputs vs whole conv', `len=${outputs.length}/${reference.length} maxDelta=${maxDelta.toExponential(3)}`);

const stopRmsBefore = rms(signal.subarray(2000, 3024));
const stopRmsAfter = rms(outputs.subarray(2000, 3024));
log('overall rms', `in=${stopRmsBefore.toFixed(4)} out(steady)=${stopRmsAfter.toFixed(4)}`);

const exportPath = resolve(demoDir, `run-${run.id}-outputs.json`);
writeFileSync(exportPath, JSON.stringify({ runId: run.id, length: outputs.length, outputs: Array.from(outputs) }));
repo.recordExport(run.id, exportPath, 'json');
log('exported', exportPath);

const server = createApiServer({ repo });
const port = await listenLocal(server, 0);
const base = `http://127.0.0.1:${port}`;
const health = await fetch(`${base}/health`).then((r) => r.json());
const list = (await fetch(`${base}/runs/${run.id}/outputs`).then((r) => r.json())) as {
  status: string;
  outputs: unknown[];
};
log('http health', JSON.stringify(health));
log('http outputs', `status=${list.status} count=${list.outputs.length}`);

await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
closeDatabase(db);
log('demo complete', 'server stopped, all data in tmp/demo');
