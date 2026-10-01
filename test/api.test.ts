import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { startServer, type ServerInfo } from "../src/server.ts";

const DB_PATH = "data/test-api.sqlite";
let server: ServerInfo;
let base: string;

before(async () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(DB_PATH + suffix, { force: true });
  server = await startServer(DB_PATH, "127.0.0.1");
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.close();
});

async function req(path: string, init?: RequestInit & { json?: unknown; idempotencyKey?: string }) {
  const headers = new Headers(init?.headers);
  let body: string | undefined;
  if (init?.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  if (init?.idempotencyKey) headers.set("idempotency-key", init.idempotencyKey);
  const res = await fetch(base + path, { ...init, headers, body });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : undefined) as any };
}

test("healthz", async () => {
  const r = await req("/healthz");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
});

test("design success then validation failures with explicit error codes", async () => {
  const ok = await req("/designs", {
    method: "POST",
    json: { sampleRate: 8000, cutoff: 1000, taps: 31, window: "hann", type: "lowpass" },
    idempotencyKey: "api-lp-1",
  });
  assert.equal(ok.status, 201);
  const designId: number = ok.json.id;
  assert.equal(ok.json!.type, "lowpass");

  const again = await req("/designs", {
    method: "POST",
    json: { sampleRate: 8000, cutoff: 1000, taps: 31, window: "hann", type: "lowpass" },
    idempotencyKey: "api-lp-1",
  });
  assert.equal(again.status, 201);
  assert.equal(again.json!.id, designId);

  const even = await req("/designs", { method: "POST", json: { sampleRate: 8000, cutoff: 1000, taps: 30, window: "hann", type: "lowpass" } });
  assert.equal(even.status, 400);
  assert.equal(even.json.error.code, "EVEN_LENGTH");

  const range = await req("/designs", { method: "POST", json: { sampleRate: 8000, cutoff: 4000, taps: 31, window: "hann", type: "lowpass" } });
  assert.equal(range.json.error.code, "CUTOFF_OUT_OF_RANGE");

  const badJson = await fetch(base + "/designs", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
  const badBody = await badJson.json();
  assert.equal(badBody.error.code, "BAD_JSON");
});

test("404 for missing resources", async () => {
  const r = await req("/designs/9999");
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "NOT_FOUND");
});

test("end-to-end streaming run over HTTP equals full convolution", async () => {
  const d = await req("/designs", {
    method: "POST",
    json: { sampleRate: 8000, cutoff: 900, taps: 15, window: "hann", type: "lowpass" },
  });
  const designId: number = d.json.id;
  const n = 100;
  const samples = Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 300 * (i / 8000)));
  const run = await req("/runs", { method: "POST", json: { designId } });
  assert.equal(run.status, 201);
  const runId = run.json.id;

  const b1 = await req(`/runs/${runId}/blocks`, { method: "POST", json: { samples: samples.slice(0, 30) } });
  assert.equal(b1.json.outputs.length, 30);
  await req(`/runs/${runId}/blocks`, { method: "POST", json: { action: "pause" } });
  const whilePaused = await req(`/runs/${runId}/blocks`, { method: "POST", json: { samples: [1] } });
  assert.equal(whilePaused.json.error.code, "INVALID_STATE_TRANSITION");
  await req(`/runs/${runId}/blocks`, { method: "POST", json: { action: "resume" } });
  const empty = await req(`/runs/${runId}/blocks`, { method: "POST", json: { samples: [] } });
  assert.deepEqual(empty.json.outputs, []);
  const b2 = await req(`/runs/${runId}/blocks`, { method: "POST", json: { samples: samples.slice(30) } });
  const tail = await req(`/runs/${runId}/blocks`, { method: "POST", json: { action: "flush" } });
  assert.equal(tail.json.outputs.length, 14);

  // independent direct-form convolution check on the client side
  const detail = (await req(`/designs/${designId}`)).json;
  const h: number[] = JSON.parse(detail.coefficients);
  const ref: number[] = new Array(n + h.length - 1).fill(0);
  for (let i = 0; i < h.length; i++) for (let j = 0; j < n; j++) ref[i + j] = (ref[i + j] as number) + (h[i] as number) * (samples[j] as number);
  const streamed: number[] = [...(b1.json.outputs as number[]), ...(b2.json.outputs as number[]), ...(tail.json.outputs as number[])];
  assert.equal(streamed.length, ref.length);
  for (let i = 0; i < ref.length; i++) assert.ok(Math.abs((streamed[i] as number) - (ref[i] as number)) < 1e-13);
});

test("frequency response endpoint reports null phase near the DC null for highpass", async () => {
  const d = await req("/designs", {
    method: "POST",
    json: { sampleRate: 8000, cutoff: 1500, taps: 31, window: "hann", type: "highpass" },
  });
  const r = await req(`/designs/${d.json.id}/response?bins=65`);
  assert.equal(r.status, 200);
  assert.equal(r.json.bins[0].phase, null);
  assert.equal(r.json.bins[0].groupDelay, null);
  assert.ok(Math.abs(r.json.bins.at(-1).magnitude - 1) < 1e-9);
});

test("pagination query validation", async () => {
  const r = await req("/designs?limit=99999");
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "INVALID_QUERY");
  const ok = await req("/designs?limit=2&offset=0");
  assert.equal(ok.json.limit, 2);
  assert.equal(typeof ok.json.total, "number");
});

test("method not allowed", async () => {
  const r = await req("/healthz", { method: "DELETE" });
  assert.equal(r.status, 405);
});
