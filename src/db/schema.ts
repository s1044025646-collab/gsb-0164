/**
 * Idempotent migrations. Every statement uses IF NOT EXISTS / CREATE OR REPLACE
 * so running migrations repeatedly (including on an existing database) is safe.
 * User-version tracks applied revisions.
 */

export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS filters (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  type             TEXT NOT NULL CHECK (type IN ('lowpass','highpass')),
  sample_rate      REAL NOT NULL CHECK (sample_rate > 0),
  cutoff_hz        REAL NOT NULL,
  length           INTEGER NOT NULL CHECK (length > 0 AND length % 2 = 1),
  window           TEXT NOT NULL CHECK (window IN ('rectangular','hann')),
  coefficients     TEXT NOT NULL,
  dc_gain          REAL NOT NULL,
  nyquist_gain     REAL NOT NULL,
  created_at       TEXT NOT NULL,
  idempotency_key  TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS filter_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  filter_id    INTEGER NOT NULL REFERENCES filters(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  coefficients TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (filter_id, version)
);

CREATE TABLE IF NOT EXISTS signals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  sample_rate     REAL NOT NULL CHECK (sample_rate > 0),
  duration        INTEGER NOT NULL CHECK (duration >= 0),
  kind            TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  data            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  idempotency_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  filter_id    INTEGER NOT NULL REFERENCES filters(id) ON DELETE CASCADE,
  signal_id    INTEGER REFERENCES signals(id) ON DELETE SET NULL,
  status       TEXT NOT NULL CHECK (status IN ('running','paused','flushed')),
  delay        TEXT NOT NULL,
  samples_in   INTEGER NOT NULL DEFAULT 0,
  samples_out  INTEGER NOT NULL DEFAULT 0,
  outputs      TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  path        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_filters_created ON filters(created_at);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);
`,
  },
];
