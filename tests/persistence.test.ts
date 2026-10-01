import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase } from '../src/db/database.js';
import { Clock, Repository } from '../src/db/repository.js';
import { FilterService } from '../src/services/filterService.js';
import { RunService } from '../src/services/runService.js';
import { designFilter } from '../src/fir/design.js';
import { filterWhole, fullConvolution } from '../src/fir/convolution.js';
import { AppError } from '../src/fir/errors.js';

function makeEnv(): { dir: string; dbPath: string; clock: { t: number } & Clock } {
  const dir = mkdtempSync(join(tmpdir(), 'firlab-'));
  after(() => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  });
  const clock = {
    t: 0,
    now(): Date {
      this.t += 1;
      return new Date(Date.UTC(2026, 0, 1, 0, 0, this.t));
    },
  };
  return { dir, dbPath: join(dir, 'test.sqlite'), clock };
}

const params = { type: 'lowpass' as const, sampleRate: 1000, cutoffHz: 200, length: 15, window: 'hann' as const };

test('migrations are repeatable on an existing database', () => {
  const { dbPath } = makeEnv();
  const db1 = openDatabase(dbPath);
  closeDatabase(db1);
  const db2 = openDatabase(dbPath);
  const row = db2.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.ok(row.user_version >= 1);
  closeDatabase(db2);
});

test('design is idempotent on repeated submission key', () => {
  const { dbPath, clock } = makeEnv();
  const db = openDatabase(dbPath);
  after(() => closeDatabase(db));
  const svc = new FilterService(new Repository(db, clock));
  const a = svc.design(params, 'key-123').filter;
  const b = svc.design(params, 'key-123');
  assert.equal(b.filter.id, a.id);
  assert.equal(b.replayed, true);
});

test('sample-rate mismatch is rejected and sample rate is not silently changed', () => {
  const { dbPath, clock } = makeEnv();
  const db = openDatabase(dbPath);
  after(() => closeDatabase(db));
  const repo = new Repository(db, clock);
  const filterSvc = new FilterService(repo);
  const runs = new RunService(repo);
  const { filter } = filterSvc.design(params);
  const signal = repo.insertSignal({
    name: 'wrong',
    sampleRate: 2000,
    kind: 'impulse',
    parameters: {},
    data: new Float64Array([1, 2, 3]),
  });
  assert.throws(
    () => runs.create(filter.id, signal.id),
    (e: unknown) => e instanceof AppError && e.code === 'SAMPLE_RATE_MISMATCH',
  );
  assert.equal(repo.getFilter(filter.id).sample_rate, 1000);
});

test('pause/resume and restarted delay line match whole-signal sample for sample', () => {
  const { dbPath, clock } = makeEnv();
  const designed = designFilter(params);
  const signal = new Float64Array(Array.from({ length: 73 }, (_, i) => Math.sin(i / 3) + 0.2 * (i % 5)));

  let db = openDatabase(dbPath);
  let repo = new Repository(db, clock);
  let runs = new RunService(repo);
  let filters = new FilterService(repo);
  const { filter } = filters.design(params);
  const runId = runs.create(filter.id, null).id;

  runs.process(runId, signal.subarray(0, 20));
  runs.pause(runId);
  assert.equal(repo.getRun(runId).status, 'paused');
  // processing while paused is refused
  assert.throws(() => runs.process(runId, signal.subarray(20, 25)), (e: unknown) => e instanceof AppError && e.code === 'RUN_NOT_RUNNING');
  runs.resume(runId);

  // simulate process restart: close and reopen the database, rebuild services
  closeDatabase(db);
  db = openDatabase(dbPath);
  repo = new Repository(db, clock);
  runs = new RunService(repo);

  for (let i = 20; i < signal.length; i += 11) {
    runs.process(runId, signal.subarray(i, Math.min(i + 11, signal.length)));
  }
  const flushed = runs.flushRun(runId);
  const got = new Float64Array(JSON.parse(flushed.outputs) as number[]);
  const expected = fullConvolution(signal, designed.coefficients);
  assert.equal(got.length, expected.length);
  for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(got[i]! - expected[i]!) < 1e-11);

  // restart once more: flushed status persists
  closeDatabase(db);
  db = openDatabase(dbPath);
  const repo2 = new Repository(db, clock);
  assert.equal(repo2.getRun(runId).status, 'flushed');
  closeDatabase(db);
});

test('chunk boundary across restart coincides with whole filtering', () => {
  const { dbPath, clock } = makeEnv();
  const designed = designFilter(params);
  const signal = new Float64Array(130).fill(0.5);
  let db = openDatabase(dbPath);
  let repo = new Repository(db, clock);
  let runs = new RunService(new Repository(db, clock));
  const filters = new FilterService(repo);
  const runId = filters.design(params).filter.id;
  const id = runs.create(runId, null).id;
  runs.process(id, signal.subarray(0, 1));
  closeDatabase(db);
  db = openDatabase(dbPath);
  runs = new RunService(new Repository(db, clock));
  runs.process(id, signal.subarray(1, 130));
  const flushed = runs.flushRun(id);
  const got = new Float64Array(JSON.parse(flushed.outputs) as number[]);
  const expected = filterWhole(designed.coefficients, signal).full;
  for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(got[i]! - expected[i]!) < 1e-11);
  closeDatabase(db);
});

test('failed processing rolls back: run counters unchanged after non-finite block', () => {
  const { dbPath, clock } = makeEnv();
  const db = openDatabase(dbPath);
  after(() => closeDatabase(db));
  const repo = new Repository(db, clock);
  const filters = new FilterService(repo);
  const runs = new RunService(repo);
  const id = runs.create(filters.design(params).filter.id, null).id;
  runs.process(id, [1, 2, 3]);
  const before = repo.getRun(id);
  assert.throws(() => runs.process(id, [1, NaN]), (e: unknown) => e instanceof AppError && e.code === 'NON_FINITE_SAMPLE');
  const afterRow = repo.getRun(id);
  assert.equal(afterRow.samples_in, before.samples_in);
  assert.equal(afterRow.samples_out, before.samples_out);
  assert.equal(afterRow.outputs, before.outputs);
});

test('pagination enforces bounds and pages through rows', () => {
  const { dbPath, clock } = makeEnv();
  const db = openDatabase(dbPath);
  after(() => closeDatabase(db));
  const repo = new Repository(db, clock);
  for (let i = 0; i < 5; i++) {
    repo.insertFilter({
      type: 'lowpass',
      sampleRate: 1000,
      cutoffHz: 100 + i,
      length: 11,
      window: 'rectangular',
      coefficients: new Float64Array([1]),
      dcGain: 1,
      nyquistGain: 0,
    });
  }
  const page1 = repo.listFilters({ limit: 2, offset: 0 });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.total, 5);
  const page3 = repo.listFilters({ limit: 2, offset: 4 });
  assert.equal(page3.items.length, 1);
});
