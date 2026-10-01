import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from '../fir/errors.js';
import { MIGRATIONS } from './schema.js';

export type Db = DatabaseSync;

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

/** Repeatable: only applies revisions newer than PRAGMA user_version. */
export function migrate(db: DatabaseSync): void {
  db.exec(`PRAGMA journal_mode = ${process.env.FIRLAB_JOURNAL_MODE ?? 'DELETE'};`);
  db.exec('PRAGMA foreign_keys = ON;');
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const current = row.user_version;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version};`);
    } catch (err) {
      throw err;
    }
  }
}

export function closeDatabase(db: DatabaseSync): void {
  db.close();
}

/** Run a function in a transaction; rollback + rethrow on any error. */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    if ((err as NodeJS.ErrnoException)?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        String((err as Error)?.message).includes('UNIQUE constraint failed')) {
      throw new AppError('DUPLICATE_IDEMPOTENCY_KEY', 'idempotency key already used for this resource');
    }
    throw err;
  }
}

export interface Page {
  limit: number;
  offset: number;
}

export function parsePage(query: { limit?: unknown; offset?: unknown }): Page {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new AppError('INVALID_PAGINATION', `limit must be an integer in [1,500], got ${String(query.limit)}`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new AppError('INVALID_PAGINATION', `offset must be a non-negative integer, got ${String(query.offset)}`);
  }
  return { limit, offset };
}
