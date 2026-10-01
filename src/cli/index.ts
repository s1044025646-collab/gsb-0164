#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../db/database.js';
import { Repository } from '../db/repository.js';
import { FilterService } from '../services/filterService.js';
import { RunService } from '../services/runService.js';
import { designFilter, symmetryError } from '../fir/design.js';
import { evaluateResponse, uniformGrid } from '../fir/response.js';
import { filterWhole } from '../fir/convolution.js';
import { impulse, multiTone, sine, step } from '../fir/signals.js';
import { isWindowType, WindowType } from '../fir/windows.js';
import { AppError } from '../fir/errors.js';
import { loadConfig } from '../config.js';

interface Args {
  command: string;
  flags: Map<string, string>;
  positionals: string[];
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, 'true');
      }
    } else {
      positionals.push(token);
    }
  }
  return { command: positionals[0] ?? 'help', flags, positionals: positionals.slice(1) };
}

function num(flags: Map<string, string>, key: string): number {
  const v = flags.get(key);
  if (v === undefined) throw new AppError('VALIDATION_ERROR', `--${key} is required`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new AppError('VALIDATION_ERROR', `--${key} must be a number, got ${v}`);
  return n;
}

function str(flags: Map<string, string>, key: string, fallback?: string): string {
  const v = flags.get(key);
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new AppError('VALIDATION_ERROR', `--${key} is required`);
  }
  return v;
}

function printRun(label: string, run: { id: number; status: string; samples_in: number; samples_out: number }): void {
  console.log(
    `[${label}] run #${run.id} status=${run.status} samplesIn=${run.samples_in} samplesOut=${run.samples_out}`,
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const repo = new Repository(db);
  const filters = new FilterService(repo);
  const runs = new RunService(repo);

  try {
    switch (args.command) {
      case 'design': {
        const type = str(args.flags, 'type') as 'lowpass' | 'highpass';
        if (type !== 'lowpass' && type !== 'highpass') throw new AppError('UNSUPPORTED_FILTER_TYPE', type);
        const windowName = str(args.flags, 'window', 'rectangular');
        if (!isWindowType(windowName)) throw new AppError('UNSUPPORTED_WINDOW', windowName);
        const params = {
          type,
          sampleRate: num(args.flags, 'sample-rate'),
          cutoffHz: num(args.flags, 'cutoff'),
          length: num(args.flags, 'length'),
          window: windowName as WindowType,
        };
        const key = args.flags.get('idempotency-key');
        const result = filters.design(params, key);
        const f = result.designed;
        console.log(
          `designed ${type} N=${params.length} fc=${params.cutoffHz}Hz fs=${params.sampleRate}Hz ` +
            `window=${windowName} omega_c=${f.normalizedCutoff.toFixed(6)} center=${f.center} id=${result.filter.id}` +
            (result.replayed ? ' (idempotent replay)' : ''),
        );
        console.log(
          `gain check: DC=${f.dcGain.toExponential(3)} Nyquist=${f.nyquistGain.toExponential(3)} ` +
            `symmetryErr=${symmetryError(f.coefficients).toExponential(3)}`,
        );
        break;
      }

      case 'show': {
        const id = num(args.flags, 'id');
        const row = repo.getFilter(id);
        const coeffs = JSON.parse(row.coefficients) as number[];
        console.log(`filter #${id}: ${row.type} fs=${row.sample_rate} fc=${row.cutoff_hz} N=${row.length} window=${row.window}`);
        console.log(coeffs.map((c, i) => `  h[${i}] = ${c.toPrecision(10)}`).join('\n'));
        break;
      }

      case 'response': {
        const id = num(args.flags, 'id');
        const row = repo.getFilter(id);
        const coeffs = new Float64Array(JSON.parse(row.coefficients) as number[]);
        const bins = args.flags.has('bins') ? Number(args.flags.get('bins')) : 16;
        const points = evaluateResponse(coeffs, { sampleRate: row.sample_rate, frequencies: uniformGrid(row.sample_rate, bins) });
        console.log('f(Hz)        |H|        phase(rad)   groupDelay(samples)');
        for (const p of points) {
          console.log(
            `${p.frequencyHz.toFixed(2).padStart(9)}  ${p.magnitude.toFixed(6).padStart(10)}  ` +
              `${p.phase === null ? '   n/a   ' : p.phase.toFixed(5).padStart(10)}  ` +
              `${p.groupDelay === null ? 'n/a (|H|~0)' : p.groupDelay.toFixed(5)}`,
          );
        }
        break;
      }

      case 'compare-windows': {
        const common = {
          type: str(args.flags, 'type', 'lowpass') as 'lowpass' | 'highpass',
          sampleRate: num(args.flags, 'sample-rate'),
          cutoffHz: num(args.flags, 'cutoff'),
          length: num(args.flags, 'length'),
        };
        for (const windowName of ['rectangular', 'hann'] as const) {
          const designed = designFilter({ ...common, window: windowName });
          console.log(
            `${windowName.padEnd(12)} DC=${designed.dcGain.toExponential(2)} ` +
              `Nyquist=${designed.nyquistGain.toExponential(2)} sum|coeff|=${sumAbs(designed.coefficients).toFixed(5)}`,
          );
        }
        break;
      }

      case 'filter-signal': {
        const filterId = num(args.flags, 'filter-id');
        const kind = str(args.flags, 'kind', 'impulse');
        const length = num(args.flags, 'length');
        const chunk = args.flags.has('chunk') ? Number(args.flags.get('chunk')) : length;
        const fs = repo.getFilter(filterId).sample_rate;
        let signal: Float64Array;
        if (kind === 'impulse') signal = impulse(fs, length);
        else if (kind === 'step') signal = step(fs, length);
        else if (kind === 'tone') signal = sine(fs, num(args.flags, 'frequency'), length);
        else if (kind === 'multitone') {
          const fPass = num(args.flags, 'pass-frequency');
          const fStop = num(args.flags, 'stop-frequency');
          signal = multiTone(fs, length, [
            { frequencyHz: fPass, amplitude: 1 },
            { frequencyHz: fStop, amplitude: 1 },
          ]);
        } else throw new AppError('VALIDATION_ERROR', `unknown signal kind ${kind}`);

        const filterRow = repo.getFilter(filterId);
        const coeffs = new Float64Array(JSON.parse(filterRow.coefficients) as number[]);
        const run = runs.create(filterId, null);
        printRun('before   ', { ...run, samples_in: 0, samples_out: 0 });
        let after = run;
        for (let i = 0; i < signal.length; i += chunk) {
          after = runs.process(run.id, signal.subarray(i, Math.min(i + chunk, signal.length)));
          printRun('processed', after);
        }
        const flushed = runs.flushRun(run.id);
        printRun('flushed  ', flushed);

        const ref = filterWhole(coeffs, signal).full;
        const got = new Float64Array(JSON.parse(flushed.outputs) as number[]);
        let err = 0;
        for (let i = 0; i < ref.length; i++) err = Math.max(err, Math.abs((got[i] ?? NaN) - ref[i]!));
        console.log(`output length=${got.length} expected=${ref.length} maxDeltaVsWhole=${err.toExponential(3)}`);
        break;
      }

      case 'pause-demo': {
        const filterId = num(args.flags, 'filter-id');
        const length = num(args.flags, 'length');
        const chunk = Number(args.flags.get('chunk') ?? '8');
        const fs = repo.getFilter(filterId).sample_rate;
        const signal = impulse(fs, length);
        const run = runs.create(filterId, null);
        printRun('start    ', run);
        runs.process(run.id, signal.subarray(0, chunk));
        printRun('block1   ', repo.getRun(run.id));
        runs.pause(run.id);
        printRun('paused   ', repo.getRun(run.id));
        runs.resume(run.id);
        printRun('resumed  ', repo.getRun(run.id));
        runs.process(run.id, signal.subarray(chunk));
        printRun('block2   ', repo.getRun(run.id));
        printRun('done     ', runs.flushRun(run.id));
        break;
      }

      case 'export': {
        const runId = num(args.flags, 'run-id');
        const out = resolve(config.tmpDir, args.flags.get('out') ?? `run-${runId}.json`);
        const { outputs, run } = runs.outputs(runId);
        const payload = JSON.stringify({ runId, status: run.status, outputs }, null, 2);
        writeFileSync(out, payload);
        repo.recordExport(runId, out, 'json');
        console.log(`exported ${outputs.length} samples -> ${out}`);
        break;
      }

      case 'list': {
        const what = args.positionals[0] ?? 'filters';
        const limit = Number(args.flags.get('limit') ?? '20');
        const offset = Number(args.flags.get('offset') ?? '0');
        if (what === 'filters') console.table(repo.listFilters({ limit, offset }).items);
        else if (what === 'signals') console.table(repo.listSignals({ limit, offset }).items);
        else if (what === 'runs') console.table(repo.listRuns({ limit, offset }).items);
        else throw new AppError('VALIDATION_ERROR', `unknown entity ${what}`);
        break;
      }

      case 'help':
      default:
        console.log(HELP);
        break;
    }
    return 0;
  } catch (err) {
    if (err instanceof AppError) {
      console.error(`error [${err.code}]: ${err.message}`);
      return 2;
    }
    throw err;
  } finally {
    db.close();
  }
}

function sumAbs(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += Math.abs(x[i]!);
  return s;
}

const HELP = `fir-lab CLI
  design --type lowpass|highpass --sample-rate FS --cutoff FC --length N --window rectangular|hann [--idempotency-key K]
  show --id ID
  response --id ID [--bins B]
  compare-windows --type lowpass|highpass --sample-rate FS --cutoff FC --length N
  filter-signal --filter-id ID --kind impulse|step|tone|multitone --length L [--frequency F] [--pass-frequency F] [--stop-frequency F] [--chunk C]
  pause-demo --filter-id ID --length L [--chunk C]
  export --run-id ID [--out NAME]
  list filters|signals|runs [--limit N] [--offset N]
  help`;

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
