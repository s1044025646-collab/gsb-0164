import type { DatabaseSync } from "node:sqlite";
import { Convolver } from "./convolver.ts";
import {
  checkIdempotency,
  paginate,
  recordIdempotency,
  withTransaction,
  type DesignRow,
  type RunRow,
  type RunStatus,
  type SignalRow,
} from "./db.ts";
import { ApiError, isFiniteNumber } from "./errors.ts";
import { design, frequencyResponse, validateDesignParams, type DesignParams, type WindowType } from "./fir.ts";
import { generate, type SignalSpec } from "./signals.ts";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function createDesign(
  db: DatabaseSync,
  params: Partial<DesignParams> & { name?: string },
  idempotencyKey: string | undefined,
  clock: Clock = systemClock
): DesignRow {
  const valid = validateDesignParams(params);
  return withTransaction(db, () => {
    const dup = checkIdempotency(db, idempotencyKey, "design");
    if (dup.existing) {
      const existing = getDesign(db, dup.existing.resourceId);
      if (
        existing.type === valid.type &&
        existing.sample_rate === valid.sampleRate &&
        existing.cutoff === valid.cutoff &&
        existing.taps === valid.taps &&
        existing.window === valid.window
      ) {
        return existing;
      }
      throw new ApiError(
        "DUPLICATE_IDEMPOTENCY_KEY",
        "idempotency key reused with different parameters",
        { previousId: dup.existing.resourceId }
      );
    }
    const coeffs = design(valid);
    const ts = clock.now().toISOString();
    const info = db
      .prepare(
        `INSERT INTO designs (name, type, sample_rate, cutoff, taps, window, coefficients, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(params.name ?? null, valid.type, valid.sampleRate, valid.cutoff, valid.taps, valid.window, JSON.stringify(coeffs), ts);
    const id = Number(info.lastInsertRowid);
    recordIdempotency(db, idempotencyKey, "design", id, ts);
    return getDesign(db, id);
  });
}

export function getDesign(db: DatabaseSync, id: number): DesignRow {
  const row = db.prepare("SELECT * FROM designs WHERE id = ?").get(id) as DesignRow | undefined;
  if (!row) throw new ApiError("NOT_FOUND", `design ${id} not found`);
  return row;
}

export function listDesigns(db: DatabaseSync, limit: number, offset: number) {
  const total = (db.prepare("SELECT COUNT(*) AS c FROM designs").get() as { c: number }).c;
  const items = db
    .prepare("SELECT * FROM designs ORDER BY id LIMIT ? OFFSET ?")
    .all(limit, offset) as unknown as DesignRow[];
  return paginate(items, total, limit, offset);
}

export function coefficientsOf(row: DesignRow): number[] {
  return JSON.parse(row.coefficients) as number[];
}

/** Create a new version of a design (same logical filter lineage, new parameters). */
export function createDesignVersion(
  db: DatabaseSync,
  parentId: number,
  params: Partial<DesignParams>,
  clock: Clock = systemClock
): DesignRow {
  const parent = getDesign(db, parentId);
  const valid = validateDesignParams({
    sampleRate: params.sampleRate ?? parent.sample_rate,
    cutoff: params.cutoff ?? parent.cutoff,
    taps: params.taps ?? parent.taps,
    window: params.window ?? (parent.window as WindowType),
    type: params.type ?? parent.type,
  });
  return withTransaction(db, () => {
    const coeffs = design(valid);
    const version = parent.version + 1;
    const ts = clock.now().toISOString();
    const info = db
      .prepare(
        `INSERT INTO designs (name, type, sample_rate, cutoff, taps, window, coefficients, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(parent.name, valid.type, valid.sampleRate, valid.cutoff, valid.taps, valid.window, JSON.stringify(coeffs), version, ts);
    return getDesign(db, Number(info.lastInsertRowid));
  });
}

export function createSignal(
  db: DatabaseSync,
  spec: SignalSpec & { name?: string; samples?: number[] },
  idempotencyKey: string | undefined,
  clock: Clock = systemClock
): SignalRow {
  const samples = spec.samples ?? generate(spec);
  for (const x of samples) {
    if (!isFiniteNumber(x)) throw new ApiError("INVALID_SAMPLE", "all samples must be finite");
  }
  if (!isFiniteNumber(spec.sampleRate) || spec.sampleRate <= 0) {
    throw new ApiError("VALIDATION_ERROR", "sampleRate must be positive");
  }
  return withTransaction(db, () => {
    const dup = checkIdempotency(db, idempotencyKey, "signal");
    if (dup.existing) return getSignal(db, dup.existing.resourceId);
    const ts = clock.now().toISOString();
    const info = db
      .prepare("INSERT INTO signals (name, sample_rate, kind, samples, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(spec.name ?? null, spec.sampleRate, spec.kind, JSON.stringify(samples), ts);
    const id = Number(info.lastInsertRowid);
    recordIdempotency(db, idempotencyKey, "signal", id, ts);
    return getSignal(db, id);
  });
}

export function getSignal(db: DatabaseSync, id: number): SignalRow {
  const row = db.prepare("SELECT * FROM signals WHERE id = ?").get(id) as SignalRow | undefined;
  if (!row) throw new ApiError("NOT_FOUND", `signal ${id} not found`);
  return row;
}

export function listSignals(db: DatabaseSync, limit: number, offset: number) {
  const total = (db.prepare("SELECT COUNT(*) AS c FROM signals").get() as { c: number }).c;
  const items = db
    .prepare("SELECT * FROM signals ORDER BY id LIMIT ? OFFSET ?")
    .all(limit, offset) as unknown as SignalRow[];
  return paginate(items, total, limit, offset);
}

export function createRun(
  db: DatabaseSync,
  designId: number,
  signalId: number | null,
  clock: Clock = systemClock
): RunRow {
  const d = getDesign(db, designId);
  let fs = d.sample_rate;
  if (signalId !== null) {
    const s = getSignal(db, signalId);
    if (s.sample_rate !== d.sample_rate) {
      throw new ApiError(
        "SAMPLE_RATE_MISMATCH",
        `design sampleRate ${d.sample_rate} does not match signal sampleRate ${s.sample_rate}`,
        { designSampleRate: d.sample_rate, signalSampleRate: s.sample_rate }
      );
    }
    fs = s.sample_rate;
  }
  const coeffs = coefficientsOf(d);
  const ts = clock.now().toISOString();
  const info = db
    .prepare(
      `INSERT INTO runs (design_id, signal_id, sample_rate, status, delay, processed_inputs, outputs, tail, created_at, updated_at)
       VALUES (?, ?, ?, 'created', ?, 0, '[]', '[]', ?, ?)`
    )
    .run(designId, signalId, fs, JSON.stringify(new Array(coeffs.length - 1).fill(0)), ts, ts);
  return getRun(db, Number(info.lastInsertRowid));
}

export function getRun(db: DatabaseSync, id: number): RunRow {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
  if (!row) throw new ApiError("NOT_FOUND", `run ${id} not found`);
  return row;
}

export function listRuns(db: DatabaseSync, limit: number, offset: number) {
  const total = (db.prepare("SELECT COUNT(*) AS c FROM runs").get() as { c: number }).c;
  const items = db
    .prepare("SELECT * FROM runs ORDER BY id LIMIT ? OFFSET ?")
    .all(limit, offset) as unknown as RunRow[];
  return paginate(items, total, limit, offset);
}

function loadConvolver(row: RunRow, coeffs: number[]): Convolver {
  return new Convolver(coeffs, {
    delay: JSON.parse(row.delay),
    pending: [],
    processedInputs: row.processed_inputs,
    outputsProduced: row.processed_inputs,
    flushed: row.status === "flushed",
  });
}

function saveRun(db: DatabaseSync, id: number, status: RunStatus, conv: Convolver, clock: Clock, tail: number[]): void {
  db.prepare(
    `UPDATE runs SET status = ?, delay = ?, processed_inputs = ?, tail = ?, updated_at = ? WHERE id = ?`
  ) .run(
    status,
    JSON.stringify(conv.state.delay),
    conv.state.processedInputs,
    JSON.stringify(tail),
    clock.now().toISOString(),
    id
  );
}

export interface ProcessResult {
  run: RunRow;
  outputs: number[];
}

/** Append a block of input samples to a run. The run may be paused/resumed;
 *  the delay line persists so continuation matches full-signal processing. */
export function processBlock(
  db: DatabaseSync,
  runId: number,
  samples: unknown,
  action: "process" | "pause" | "resume" | "flush",
  clock: Clock = systemClock
): ProcessResult {
  if (!Array.isArray(samples)) {
    throw new ApiError("VALIDATION_ERROR", "samples must be an array of finite numbers");
  }
  const nums = samples as number[];
  return withTransaction(db, () => {
    const run = getRun(db, runId);
    const designRow = getDesign(db, run.design_id);
    const coeffs = coefficientsOf(designRow);
    const conv = loadConvolver(run, coeffs);
    let outputs: number[] = [];
    let tail: number[] = JSON.parse(run.tail);
    let status: RunStatus = run.status;

    if (action === "resume") {
      if (run.status !== "paused") {
        throw new ApiError("INVALID_STATE_TRANSITION", `can only resume a paused run (status=${run.status})`);
      }
      status = "running";
    } else if (action === "pause") {
      if (run.status !== "running" && run.status !== "created") {
        throw new ApiError("INVALID_STATE_TRANSITION", `cannot pause run in status ${run.status}`);
      }
      status = "paused";
    } else if (action === "flush") {
      if (run.status === "flushed") {
        throw new ApiError("INVALID_STATE_TRANSITION", "run already flushed");
      }
      outputs = conv.flush();
      tail = outputs;
      status = "flushed";
    } else {
      if (run.status === "flushed") {
        throw new ApiError("INVALID_STATE_TRANSITION", "run already flushed");
      }
      if (run.status === "paused") {
        throw new ApiError(
          "INVALID_STATE_TRANSITION",
          "run is paused; resume before processing more samples"
        );
      }
      outputs = conv.process(nums);
      status = "running";
    }
    saveRun(db, runId, status, conv, clock, tail);
    return { run: getRun(db, runId), outputs };
  });
}

export function runFrequencyResponse(db: DatabaseSync, designId: number, bins: number) {
  const d = getDesign(db, designId);
  return {
    designId: d.id,
    sampleRate: d.sample_rate,
    bins: frequencyResponse(coefficientsOf(d), d.sample_rate, bins),
  };
}

