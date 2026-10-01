import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'node:http';
import { closeDatabase, openDatabase } from '../src/db/database.js';
import { Repository } from '../src/db/repository.js';
import { createApiServer, listenLocal } from '../src/api/server.js';

let base: string;
let server: Server;
let db: ReturnType<typeof openDatabase>;

const dir = mkdtempSync(join(tmpdir(), 'firlab-api-'));

test.before(async () => {
  db = openDatabase(join(dir, 'api.sqlite'));
  server = createApiServer({ repo: new Repository(db) });
  const port = await listenLocal(server, 0);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeDatabase(db);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('health and validation errors use explicit codes', async () => {
  const ok = await call('GET', '/health');
  assert.equal(ok.status, 200);

  const even = await call('POST', '/filters', {
    type: 'lowpass',
    sampleRate: 1000,
    cutoffHz: 200,
    length: 20,
    window: 'rectangular',
  });
  assert.equal(even.status, 400);
  assert.equal(even.json.error.code, 'INVALID_LENGTH');

  const range = await call('POST', '/filters', {
    type: 'lowpass',
    sampleRate: 1000,
    cutoffHz: 500,
    length: 21,
    window: 'rectangular',
  });
  assert.equal(range.json.error.code, 'CUTOFF_OUT_OF_RANGE');
});

test('design, fetch coefficients, response with nulls near zeros, idempotency', async () => {
  const body = {
    type: 'lowpass',
    sampleRate: 1000,
    cutoffHz: 200,
    length: 101,
    window: 'hann',
    idempotencyKey: 'api-key-1',
  };
  const a = await call('POST', '/filters', body);
  assert.equal(a.status, 201);
  assert.equal(a.json.coefficients.length, 101);
  const b = await call('POST', '/filters', body);
  assert.equal(b.json.id, a.json.id);
  assert.equal(b.json.replayed, true);

  const resp = await call('GET', `/filters/${a.json.id}/response?bins=2048`);
  assert.equal(resp.status, 200);
  assert.equal(resp.json.points.length, 2049);
  assert.ok(resp.json.points.some((p: any) => p.phase === null && p.groupDelay === null));

  const ripple = await call('GET', `/filters/${a.json.id}/ripple?f0=300&f1=450&bins=1024`);
  assert.equal(ripple.json.sampledEstimate, true);
  assert.match(ripple.json.note, /not a continuous-frequency rigorous upper bound/);
});

test('streaming run lifecycle over HTTP incl. pause/resume/flush and mismatch', async () => {
  const design = await call('POST', '/filters', {
    type: 'lowpass',
    sampleRate: 1000,
    cutoffHz: 150,
    length: 11,
    window: 'hann',
  });
  const fid = design.json.id;

  const sig = await call('POST', '/signals', {
    name: 'tone',
    sampleRate: 1000,
    kind: 'upload',
    data: [1, 2, 3, 4],
    idempotencyKey: 'sig-1',
  });
  assert.equal(sig.status, 201);
  const sigAgain = await call('POST', '/signals', {
    name: 'tone',
    sampleRate: 1000,
    data: [1, 2, 3, 4],
    idempotencyKey: 'sig-1',
  });
  assert.equal(sigAgain.json.replayed, true);

  const wrong = await call('POST', '/signals', { name: 'w', sampleRate: 2000, kind: 'upload', data: [1] });
  const mismatch = await call('POST', '/runs', { filterId: fid, signalId: wrong.json.id });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.json.error.code, 'SAMPLE_RATE_MISMATCH');

  const run = await call('POST', '/runs', { filterId: fid });
  const rid = run.json.id;
  const p1 = await call('POST', `/runs/${rid}/process`, { block: [1, 0, 0] });
  assert.equal(p1.json.samples_in, 3);
  await call('POST', `/runs/${rid}/pause`);
  const blocked = await call('POST', `/runs/${rid}/process`, { block: [1] });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error.code, 'RUN_NOT_RUNNING');
  await call('POST', `/runs/${rid}/resume`);
  await call('POST', `/runs/${rid}/process`, { block: [0, 0] });
  const flushed = await call('POST', `/runs/${rid}/flush`);
  assert.equal(flushed.json.status, 'flushed');
  assert.equal(flushed.json.samples_out, 5 + 10);
  const again = await call('POST', `/runs/${rid}/process`, { block: [1] });
  assert.equal(again.json.error.code, 'RUN_FINISHED');

  const outputs = await call('GET', `/runs/${rid}/outputs`);
  assert.equal(outputs.json.outputs.length, 15);

  const events = await call('GET', `/runs/${rid}/events?limit=3&offset=0`);
  assert.equal(events.json.items.length, 3);
  assert.equal(events.json.total > 3, true);
});

test('non-finite block rejected with NON_FINITE_SAMPLE', async () => {
  const design = await call('POST', '/filters', {
    type: 'highpass',
    sampleRate: 8000,
    cutoffHz: 1000,
    length: 15,
    window: 'rectangular',
  });
  const run = await call('POST', '/runs', { filterId: design.json.id });
  const bad = await call('POST', `/runs/${run.json.id}/process`, { block: [1, 'x'] });
  assert.equal(bad.json.error.code, 'NON_FINITE_SAMPLE');
});

test('pagination metadata and invalid pagination code', async () => {
  const list = await call('GET', '/filters?limit=1&offset=0');
  assert.equal(list.status, 200);
  assert.equal(list.json.limit, 1);
  const bad = await call('GET', '/filters?limit=0');
  assert.equal(bad.json.error.code, 'INVALID_PAGINATION');
});

test('server binds only loopback (address is 127.0.0.1)', () => {
  const addr = server.address();
  assert.equal(typeof addr, 'object');
  assert.equal((addr as { address: string }).address, '127.0.0.1');
});
