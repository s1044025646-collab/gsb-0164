import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../fir/errors.js';
import { Page, withTransaction } from './database.js';

export interface FilterRow {
  id: number;
  type: string;
  sample_rate: number;
  cutoff_hz: number;
  length: number;
  window: string;
  coefficients: string;
  dc_gain: number;
  nyquist_gain: number;
  created_at: string;
  idempotency_key: string | null;
}

export interface SignalRow {
  id: number;
  name: string;
  sample_rate: number;
  duration: number;
  kind: string;
  parameters_json: string;
  data: string;
  created_at: string;
  idempotency_key: string | null;
}

export type RunStatus = 'running' | 'paused' | 'flushed';

export interface RunRow {
  id: number;
  filter_id: number;
  signal_id: number | null;
  status: RunStatus;
  delay: string;
  samples_in: number;
  samples_out: number;
  outputs: string;
  created_at: string;
  updated_at: string;
}

export interface Clock {
 now(): Date;
}

function decode(s: string): number[] {
  return Array.from(JSON.parse(s) as number[]);
}
function encode(x: ArrayLike<number>): string {
  return JSON.stringify(Array.from(x));
}

export class Repository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  insertFilter(args: {
    type: string;
    sampleRate: number;
    cutoffHz: number;
    length: number;
    window: string;
    coefficients: Float64Array;
    dcGain: number;
    nyquistGain: number;
    idempotencyKey?: string;
  }): FilterRow {
    return withTransaction(this.db, () => {
      const ts = this.clock.now().toISOString();
      const info = this.db
        .prepare(
          `INSERT INTO filters(type, sample_rate, cutoff_hz, length, window, coefficients,
             dc_gain, nyquist_gain, created_at, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.type,
          args.sampleRate,
          args.cutoffHz,
          args.length,
          args.window,
          encode(args.coefficients),
          args.dcGain,
          args.nyquistGain,
          ts,
          args.idempotencyKey ?? null,
        );
      const id = Number(info.lastInsertRowid);
      this.db
        .prepare('INSERT INTO filter_versions(filter_id, version, coefficients, note, created_at) VALUES (?, 1, ?, ?, ?)')
        .run(id, encode(args.coefficients), 'initial design', ts);
      return this.getFilter(id)!;
    });
  }

  findFilterByIdempotencyKey(key: string): FilterRow | undefined {
    const row = this.db.prepare('SELECT * FROM filters WHERE idempotency_key = ?').get(key) as FilterRow | undefined;
    return row;
  }

  getFilter(id: number): FilterRow {
    const row = this.db.prepare('SELECT * FROM filters WHERE id = ?').get(id) as FilterRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', `filter ${id} not found`);
    return row;
  }

  listFilters(page: Page): { items: FilterRow[]; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) c FROM filters').get() as { c: number }).c;
    const items = this.db
      .prepare('SELECT * FROM filters ORDER BY id LIMIT ? OFFSET ?')
      .all(page.limit, page.offset) as unknown as FilterRow[];
    return { items, total };
  }

  listVersions(filterId: number, page: Page) {
    this.getFilter(filterId);
    const total = (
      this.db.prepare('SELECT COUNT(*) c FROM filter_versions WHERE filter_id = ?').get(filterId) as { c: number }
    ).c;
    const items = this.db
      .prepare('SELECT id, version, note, created_at FROM filter_versions WHERE filter_id = ? ORDER BY version LIMIT ? OFFSET ?')
      .all(filterId, page.limit, page.offset);
    return { items, total };
  }

  addVersion(filterId: number, coefficients: Float64Array, note: string): number {
    return withTransaction(this.db, () => {
      this.getFilter(filterId);
      const ts = this.clock.now().toISOString();
      const maxV = this.db.prepare('SELECT COALESCE(MAX(version),0) m FROM filter_versions WHERE filter_id = ?').get(filterId) as { m: number };
      const version = maxV.m + 1;
      this.db
        .prepare('INSERT INTO filter_versions(filter_id, version, coefficients, note, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(filterId, version, encode(coefficients), note, ts);
      this.db.prepare('UPDATE filters SET coefficients = ? WHERE id = ?').run(encode(coefficients), filterId);
      return version;
    });
  }

  insertSignal(args: {
    name: string;
    sampleRate: number;
    kind: string;
    parameters: unknown;
    data: Float64Array;
    idempotencyKey?: string;
  }): SignalRow {
    const ts = this.clock.now().toISOString();
    return withTransaction(this.db, () => {
      const info = this.db
        .prepare(
          `INSERT INTO signals(name, sample_rate, duration, kind, parameters_json, data, created_at, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.name,
          args.sampleRate,
          args.data.length,
          args.kind,
          JSON.stringify(args.parameters),
          encode(args.data),
          ts,
          args.idempotencyKey ?? null,
        );
      return this.getSignal(Number(info.lastInsertRowid));
    });
  }

  findSignalByIdempotencyKey(key: string): SignalRow | undefined {
    return this.db.prepare('SELECT * FROM signals WHERE idempotency_key = ?').get(key) as SignalRow | undefined;
  }

  getSignal(id: number): SignalRow {
    const row = this.db.prepare('SELECT * FROM signals WHERE id = ?').get(id) as SignalRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', `signal ${id} not found`);
    return row;
  }

  listSignals(page: Page): { items: SignalRow[]; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) c FROM signals').get() as { c: number }).c;
    const items = this.db
      .prepare('SELECT id, name, sample_rate, duration, kind, parameters_json, created_at FROM signals ORDER BY id LIMIT ? OFFSET ?')
      .all(page.limit, page.offset) as unknown as SignalRow[];
    return { items, total };
  }

  createRun(filterId: number, signalId: number | null): RunRow {
    return withTransaction(this.db, () => {
      const filter = this.getFilter(filterId);
      const n = decode(filter.coefficients).length;
      const ts = this.clock.now().toISOString();
      const info = this.db
        .prepare(
          `INSERT INTO runs(filter_id, signal_id, status, delay, samples_in, samples_out, outputs, created_at, updated_at)
           VALUES (?, ?, 'running', ?, 0, 0, '[]', ?, ?)`,
        )
        .run(filterId, signalId, encode(new Float64Array(n - 1)), ts, ts);
      const id = Number(info.lastInsertRowid);
      this.addEvent(id, 'created', { filterId, signalId });
      return this.getRun(id);
    });
  }

  getRun(id: number): RunRow {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', `run ${id} not found`);
    return row;
  }

  listRuns(page: Page): { items: RunRow[]; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) c FROM runs').get() as { c: number }).c;
    const items = this.db
      .prepare(
        `SELECT id, filter_id, signal_id, status, samples_in, samples_out, created_at, updated_at
         FROM runs ORDER BY id LIMIT ? OFFSET ?`,
      )
      .all(page.limit, page.offset) as unknown as RunRow[];
    return { items, total };
  }

  listEvents(runId: number, page: Page) {
    this.getRun(runId);
    const total = (
      this.db.prepare('SELECT COUNT(*) c FROM run_events WHERE run_id = ?').get(runId) as { c: number }
    ).c;
    const items = this.db
      .prepare('SELECT id, kind, detail_json, at FROM run_events WHERE run_id = ? ORDER BY id LIMIT ? OFFSET ?')
      .all(runId, page.limit, page.offset);
    return { items, total };
  }

  addEvent(runId: number, kind: string, detail: unknown): void {
    this.db
      .prepare('INSERT INTO run_events(run_id, kind, detail_json, at) VALUES (?, ?, ?, ?)')
      .run(runId, kind, JSON.stringify(detail), this.clock.now().toISOString());
  }

  /** Conditional status transition; throws if the run is not in `from`. */
  transitionRun(id: number, from: RunStatus | RunStatus[], to: RunStatus): void {
    const allowed = Array.isArray(from) ? from : [from];
    withTransaction(this.db, () => {
      const run = this.getRun(id);
      if (!allowed.includes(run.status)) {
        throw new AppError(
          run.status === 'flushed' ? 'RUN_FINISHED' : 'RUN_NOT_RUNNING',
          `run ${id} is '${run.status}', expected '${allowed.join('|')}' for transition to '${to}'`,
        );
      }
      const ts = this.clock.now().toISOString();
      this.db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?').run(to, ts, id);
      this.addEvent(id, 'status', { from: run.status, to });
    });
  }

  saveRunProgress(id: number, delay: Float64Array, produced: Float64Array, blockLength: number): RunRow {
    return withTransaction(this.db, () => {
      const run = this.getRun(id);
      const outputs = decode(run.outputs);
      for (const v of produced) outputs.push(v);
      this.db
        .prepare('UPDATE runs SET delay = ?, samples_in = ?, samples_out = ?, outputs = ?, updated_at = ? WHERE id = ?')
        .run(
          encode(delay),
          run.samples_in + blockLength,
          run.samples_out + produced.length,
          JSON.stringify(outputs),
          this.clock.now().toISOString(),
          id,
        );
      this.addEvent(id, 'block', { in: blockLength, out: produced.length });
      return this.getRun(id);
    });
  }

  appendTail(id: number, tail: Float64Array, zeroDelay: Float64Array): RunRow {
    return withTransaction(this.db, () => {
      const run = this.getRun(id);
      const outputs = decode(run.outputs);
      for (const v of tail) outputs.push(v);
      const ts = this.clock.now().toISOString();
      this.db
        .prepare(
          `UPDATE runs SET status='flushed', delay = ?, samples_out = ?, outputs = ?, updated_at = ? WHERE id = ?`,
        )
        .run(encode(zeroDelay), run.samples_out + tail.length, JSON.stringify(outputs), ts, id);
      this.addEvent(id, 'flush', { tail: tail.length });
      return this.getRun(id);
    });
  }

  recordExport(runId: number | null, path: string, kind: string): number {
    const info = this.db
      .prepare('INSERT INTO exports(run_id, path, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(runId, path, kind, this.clock.now().toISOString());
    return Number(info.lastInsertRowid);
  }
}

