import { DatabaseSync } from "node:sqlite";
import { ApiError } from "./errors.ts";
import type { FilterType, WindowType } from "./fir.ts";

export interface DesignRow {
  id: number;
  name: string | null;
  type: FilterType;
  sample_rate: number;
  cutoff: number;
  taps: number;
  window: WindowType;
  coefficients: string;
  version: number;
  created_at: string;
}

export interface SignalRow {
  id: number;
  name: string | null;
  sample_rate: number;
  kind: string;
  samples: string;
  created_at: string;
}

export type RunStatus = "created" | "running" | "paused" | "flushed";

export interface RunRow {
  id: number;
  design_id: number;
  signal_id: number | null;
  sample_rate: number;
  status: RunStatus;
  delay: string;
  processed_inputs: number;
  outputs: string;
  tail: string;
  created_at: string;
  updated_at: string;
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

/** Idempotent migration: safe to run repeatedly on existing databases. */
export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS designs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      type TEXT NOT NULL CHECK (type IN ('lowpass','highpass')),
      sample_rate REAL NOT NULL CHECK (sample_rate > 0),
      cutoff REAL NOT NULL CHECK (cutoff > 0),
      taps INTEGER NOT NULL CHECK (taps > 0 AND taps % 2 = 1),
      window TEXT NOT NULL CHECK (window IN ('rect','hann')),
      coefficients TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      sample_rate REAL NOT NULL CHECK (sample_rate > 0),
      kind TEXT NOT NULL,
      samples TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id INTEGER NOT NULL REFERENCES designs(id),
      signal_id INTEGER REFERENCES signals(id),
      sample_rate REAL NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('created','running','paused','flushed')),
      delay TEXT NOT NULL,
      processed_inputs INTEGER NOT NULL DEFAULT 0,
      outputs TEXT NOT NULL DEFAULT '[]',
      tail TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY,
      resource TEXT NOT NULL,
      resource_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const inserted = db
    .prepare("INSERT OR IGNORE INTO schema_version (version) VALUES (1)")
    .run();
  void inserted;
}

export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  total: number;
  nextOffset: number | null;
}

export function parsePagination(query: URLSearchParams): { limit: number; offset: number } {
  const limitRaw = query.get("limit");
  const offsetRaw = query.get("offset");
  let limit = 50;
  let offset = 0;
  if (limitRaw !== null) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new ApiError("INVALID_QUERY", "limit must be an integer between 1 and 500");
    }
  }
  if (offsetRaw !== null) {
    offset = Number(offsetRaw);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ApiError("INVALID_QUERY", "offset must be a non-negative integer");
    }
  }
  return { limit, offset };
}

export function paginate<T>(items: T[], total: number, limit: number, offset: number): Page<T> {
  const nextOffset = offset + limit < total ? offset + limit : null;
  return { items, limit, offset, total, nextOffset };
}

/** Runs fn in a transaction; any thrown error rolls the whole thing back. */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function checkIdempotency(
  db: DatabaseSync,
  key: string | undefined,
  resource: string
): { existing: { resourceId: number } | null } {
  if (!key) return { existing: null };
  const row = db
    .prepare("SELECT resource_id AS resourceId FROM idempotency WHERE key = ? AND resource = ?")
    .get(key, resource) as { resourceId: number } | undefined;
  return { existing: row ? { resourceId: row.resourceId } : null };
}

export function recordIdempotency(
  db: DatabaseSync,
  key: string | undefined,
  resource: string,
  resourceId: number,
  now: string
): void {
  if (!key) return;
  db.prepare(
    "INSERT INTO idempotency (key, resource, resource_id, created_at) VALUES (?, ?, ?, ?)"
  ).run(key, resource, resourceId, now);
}
