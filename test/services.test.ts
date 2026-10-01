import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { migrate, openDb, withTransaction } from "../src/db.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  coefficientsOf,
  createDesign,
  createDesignVersion,
  createRun,
  createSignal,
  getRun,
  listDesigns,
  processBlock,
} from "../src/services.ts";
import { Convolver } from "../src/convolver.ts";
import { ApiError } from "../src/errors.ts";
import { generate } from "../src/signals.ts";

const DB_PATH = "data/test-services.sqlite";
let db: DatabaseSync;

before(() => {
  rmSync(DB_PATH, { force: true });
  rmSync(DB_PATH + "-wal", { force: true });
  rmSync(DB_PATH + "-shm", { force: true });
  db = openDb(DB_PATH);
});

after(() => {
  db.close();
});

test("migration is repeatable", () => {
  assert.doesNotThrow(() => migrate(db));
  assert.doesNotThrow(() => migrate(db));
});

test("idempotent design creation returns the same row on repeat submit", () => {
  const p = { sampleRate: 8000, cutoff: 900, taps: 21, window: "hann" as const, type: "lowpass" as const };
  const d1 = createDesign(db, p, "key-1");
  const d2 = createDesign(db, p, "key-1");
  assert.equal(d1.id, d2.id);
  const d3 = createDesign(db, p, undefined);
  assert.notEqual(d3.id, d1.id);
  assert.throws(
    () => createDesign(db, { ...p, cutoff: 1000 }, "key-1"),
    (e: unknown) => (e as ApiError).code === "DUPLICATE_IDEMPOTENCY_KEY"
  );
});

test("design versions increment on the lineage", () => {
  const d1 = createDesign(db, { sampleRate: 8000, cutoff: 900, taps: 21, window: "hann", type: "lowpass", name: "v" }, "ver-1");
  const d2 = createDesignVersion(db, d1.id, { cutoff: 1200 });
  assert.equal(d2.version, 2);
  assert.equal(d2.name, "v");
});

test("mismatched sample rates between design and signal are rejected", () => {
  const d = createDesign(db, { sampleRate: 8000, cutoff: 800, taps: 11, window: "rect", type: "lowpass" }, "fs-d");
  const s = createSignal(db, { kind: "sine", sampleRate: 4000, frequency: 300, duration: 0.01 }, "fs-s");
  assert.throws(() => createRun(db, d.id, s.id), (e: unknown) => (e as ApiError).code === "SAMPLE_RATE_MISMATCH");
});

test("pagination metadata is correct", () => {
  for (let i = 0; i < 5; i++) {
    createDesign(db, { sampleRate: 8000, cutoff: 500 + i, taps: 5, window: "rect", type: "lowpass" }, `page-${i}`);
  }
  const page1 = listDesigns(db, 3, 0);
  assert.equal(page1.items.length, 3);
  assert.equal(page1.nextOffset, 3);
  const page2 = listDesigns(db, 3, 3);
  assert.equal(page2.items.length, Math.min(3, page1.total - 3));
});

test("pause/resume with persisted delay line matches full convolution across restart boundary", () => {
  const d = createDesign(db, { sampleRate: 8000, cutoff: 700, taps: 15, window: "hann", type: "lowpass" }, "run-d");
  const samples = generate({ kind: "noise", sampleRate: 8000, duration: 0.01, seed: 99 });
  const run = createRun(db, d.id, null);
  const cut = 37;
  const r1 = processBlock(db, run.id, samples.slice(0, cut), "process");
  processBlock(db, run.id, [], "pause");
  assert.equal(getRun(db, run.id).status, "paused");
  // processing while paused is rejected
  assert.throws(() => processBlock(db, run.id, [1, 2, 3], "process"), (e: unknown) => (e as ApiError).code === "INVALID_STATE_TRANSITION");
  processBlock(db, run.id, [], "resume");
  const r2 = processBlock(db, run.id, samples.slice(cut), "process");
  const r3 = processBlock(db, run.id, [], "flush");
  assert.equal(getRun(db, run.id).status, "flushed");
  // double flush rejected
  assert.throws(() => processBlock(db, run.id, [], "flush"), (e: unknown) => (e as ApiError).code === "INVALID_STATE_TRANSITION");
  const streamed = [...r1.outputs, ...r2.outputs, ...r3.outputs];
  const ref = Convolver.fullConvolve(coefficientsOf(d), samples);
  assert.equal(streamed.length, ref.length);
  for (let i = 0; i < ref.length; i++) {
    assert.ok(Math.abs((streamed[i] as number) - (ref[i] as number)) < 1e-14);
  }
});

test("run state survives closing and reopening the database", () => {
  const d = createDesign(db, { sampleRate: 8000, cutoff: 700, taps: 9, window: "rect", type: "lowpass" }, "persist-d");
  const samples = generate({ kind: "sine", sampleRate: 8000, frequency: 250, duration: 0.01 });
  const run = createRun(db, d.id, null);
  processBlock(db, run.id, samples.slice(0, 20), "process");
  processBlock(db, run.id, [], "pause");
  db.close();
  db = openDb(DB_PATH);
  const row = getRun(db, run.id);
  assert.equal(row.status, "paused");
  assert.equal(row.processed_inputs, 20);
  processBlock(db, run.id, [], "resume");
  const rest = processBlock(db, run.id, samples.slice(20), "process");
  const tail = processBlock(db, run.id, [], "flush");
  // first 20 outputs must be reconstructed by full convolution for comparison
  const ref = Convolver.fullConvolve(coefficientsOf(d), samples);
  const conv = new Convolver(coefficientsOf(d));
  const first = conv.process(samples.slice(0, 20));
  const streamed = [...first, ...rest.outputs, ...tail.outputs];
  assert.equal(streamed.length, ref.length);
  for (let i = 0; i < ref.length; i++) {
    assert.ok(Math.abs((streamed[i] as number) - (ref[i] as number)) < 1e-14);
  }
});

test("transaction rolls back when an error occurs mid-way", () => {
  const before = (db.prepare("SELECT COUNT(*) AS c FROM designs").get() as { c: number }).c;
  assert.throws(() =>
    withTransaction(db, () => {
      db.prepare(
        "INSERT INTO designs (name,type,sample_rate,cutoff,taps,window,coefficients,version,created_at) VALUES ('x','lowpass',8000,500,5,'rect','[]',1,'t')"
      ).run();
      throw new Error("boom");
    }), /boom/);
  const after = (db.prepare("SELECT COUNT(*) AS c FROM designs").get() as { c: number }).c;
  assert.equal(after, before);
});
