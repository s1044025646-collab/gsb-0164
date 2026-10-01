import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { Repository } from '../db/repository.js';
import { RunService } from '../services/runService.js';
import { FilterService } from '../services/filterService.js';
import { AppError } from '../fir/errors.js';
import { designFilter } from '../fir/design.js';
import { evaluateResponse, sampledBandRipple, uniformGrid } from '../fir/response.js';
import { isWindowType } from '../fir/windows.js';
import { parsePage } from '../db/database.js';

export interface ApiDeps {
  repo: Repository;
}

interface Json {
  [key: string]: unknown;
}

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_LENGTH: 400,
  INVALID_SAMPLE_RATE: 400,
  CUTOFF_OUT_OF_RANGE: 400,
  UNSUPPORTED_WINDOW: 400,
  UNSUPPORTED_FILTER_TYPE: 400,
  NON_FINITE_SAMPLE: 400,
  SAMPLE_RATE_MISMATCH: 409,
  INVALID_BLOCK: 400,
  RUN_NOT_RUNNING: 409,
  RUN_ALREADY_RUNNING: 409,
  RUN_FINISHED: 409,
  NOT_FOUND: 404,
  DUPLICATE_IDEMPOTENCY_KEY: 409,
  INVALID_PAGINATION: 400,
  VALIDATION_ERROR: 400,
};

export function createApiServer(deps: ApiDeps): Server {
  const { repo } = deps;
  const runService = new RunService(repo);
  const filterService = new FilterService(repo);

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => sendError(res, err));
  });
  return server;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/health') {
      return json(res, 200, { status: 'ok' });
    }

    if (method === 'POST' && path === '/filters') {
      const body = await readJson(req);
      const type = body.type as string;
      if (type !== 'lowpass' && type !== 'highpass') {
        throw new AppError('UNSUPPORTED_FILTER_TYPE', `type must be lowpass|highpass`);
      }
      if (!isWindowType(String(body.window))) throw new AppError('UNSUPPORTED_WINDOW', `window must be rectangular|hann`);
      const params = {
        type: type as 'lowpass' | 'highpass',
        sampleRate: Number(body.sampleRate),
        cutoffHz: Number(body.cutoffHz),
        length: Number(body.length),
        window: String(body.window) as 'rectangular' | 'hann',
      };
      const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;
      const result = filterService.design(params, key);
      return json(res, 201, {
        ...result.filter,
        coefficients: Array.from(result.designed.coefficients),
        replayed: result.replayed,
      });
    }

    const filterMatch = path.match(/^\/filters\/(\d+)$/);
    if (method === 'GET' && filterMatch) {
      return json(res, 200, repo.getFilter(Number(filterMatch[1])));
    }
    if (method === 'GET' && path === '/filters') {
      const page = parsePage({ limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') });
      return json(res, 200, paginate(repo.listFilters(page), url, page, '/filters'));
    }

    const versionsMatch = path.match(/^\/filters\/(\d+)\/versions$/);
    if (method === 'GET' && versionsMatch) {
      const page = parsePage({ limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') });
      return json(res, 200, paginate(repo.listVersions(Number(versionsMatch[1]), page), url, page, path));
    }

    const responseMatch = path.match(/^\/filters\/(\d+)\/response$/);
    if (method === 'GET' && responseMatch) {
      const filter = repo.getFilter(Number(responseMatch[1]));
      const coeffs = new Float64Array(JSON.parse(filter.coefficients) as number[]);
      const bins = Number(url.searchParams.get('bins') ?? '512');
      if (!Number.isInteger(bins) || bins < 1 || bins > 65536) {
        throw new AppError('VALIDATION_ERROR', 'bins must be integer in [1,65536]');
      }
      const points = evaluateResponse(coeffs, {
        sampleRate: filter.sample_rate,
        frequencies: uniformGrid(filter.sample_rate, bins),
      });
      return json(res, 200, { filterId: filter.id, points });
    }

    const rippleMatch = path.match(/^\/filters\/(\d+)\/ripple$/);
    if (method === 'GET' && rippleMatch) {
      const filter = repo.getFilter(Number(rippleMatch[1]));
      const coeffs = new Float64Array(JSON.parse(filter.coefficients) as number[]);
      const f0 = Number(url.searchParams.get('f0'));
      const f1 = Number(url.searchParams.get('f1'));
      if (![f0, f1].every(Number.isFinite) || f0 < 0 || f1 <= f0 || f1 > filter.sample_rate / 2) {
        throw new AppError('VALIDATION_ERROR', 'require 0 <= f0 < f1 <= fs/2');
      }
      const bins = Number(url.searchParams.get('bins') ?? '4096');
      const result = sampledBandRipple(coeffs, filter.sample_rate, { f0, f1 }, bins);
      return json(res, 200, {
        ...result,
        note: 'sampled estimate over a finite grid; not a continuous-frequency rigorous upper bound',
      });
    }

    if (method === 'POST' && path === '/signals') {
      const body = await readJson(req);
      const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;
      if (key) {
        const existing = repo.findSignalByIdempotencyKey(key);
        if (existing) return json(res, 200, { ...existing, data: JSON.parse(existing.data), replayed: true });
      }
      const data = body.data;
      if (!Array.isArray(data) || !data.every((v) => typeof v === 'number' && Number.isFinite(v))) {
        throw new AppError('NON_FINITE_SAMPLE', 'data must be an array of finite numbers');
      }
      const signal = repo.insertSignal({
        name: String(body.name ?? 'signal'),
        sampleRate: Number(body.sampleRate),
        kind: String(body.kind ?? 'upload'),
        parameters: body.parameters ?? {},
        data: new Float64Array(data as number[]),
        idempotencyKey: key,
      });
      return json(res, 201, { id: signal.id, name: signal.name, duration: signal.duration, replayed: false });
    }
    if (method === 'GET' && path === '/signals') {
      const page = parsePage({ limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') });
      return json(res, 200, paginate(repo.listSignals(page), url, page, '/signals'));
    }
    const signalMatch = path.match(/^\/signals\/(\d+)$/);
    if (method === 'GET' && signalMatch) {
      const signal = repo.getSignal(Number(signalMatch[1]));
      return json(res, 200, { ...signal, data: JSON.parse(signal.data) });
    }

    if (method === 'POST' && path === '/runs') {
      const body = await readJson(req);
      const run = runService.create(Number(body.filterId), body.signalId == null ? null : Number(body.signalId));
      return json(res, 201, run);
    }
    if (method === 'GET' && path === '/runs') {
      const page = parsePage({ limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') });
      return json(res, 200, paginate(repo.listRuns(page), url, page, '/runs'));
    }
    const runMatch = path.match(/^\/runs\/(\d+)$/);
    if (method === 'GET' && runMatch) return json(res, 200, repo.getRun(Number(runMatch[1])));

    const runEvents = path.match(/^\/runs\/(\d+)\/events$/);
    if (method === 'GET' && runEvents) {
      const page = parsePage({ limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') });
      return json(res, 200, paginate(repo.listEvents(Number(runEvents[1]), page), url, page, path));
    }
    const runOutputs = path.match(/^\/runs\/(\d+)\/outputs$/);
    if (method === 'GET' && runOutputs) {
      const { outputs, run } = runService.outputs(Number(runOutputs[1]));
      return json(res, 200, { runId: run.id, status: run.status, outputs });
    }
    const runProcess = path.match(/^\/runs\/(\d+)\/process$/);
    if (method === 'POST' && runProcess) {
      const body = await readJson(req);
      if (!Array.isArray(body.block) || !body.block.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))) {
        throw new AppError('NON_FINITE_SAMPLE', 'block must be an array of finite numbers');
      }
      const run = runService.process(Number(runProcess[1]), new Float64Array(body.block as number[]));
      return json(res, 200, run);
    }
    const runPause = path.match(/^\/runs\/(\d+)\/pause$/);
    if (method === 'POST' && runPause) return json(res, 200, runService.pause(Number(runPause[1])));
    const runResume = path.match(/^\/runs\/(\d+)\/resume$/);
    if (method === 'POST' && runResume) return json(res, 200, runService.resume(Number(runResume[1])));
    const runFlush = path.match(/^\/runs\/(\d+)\/flush$/);
    if (method === 'POST' && runFlush) return json(res, 200, runService.flushRun(Number(runFlush[1])));

    json(res, 404, { error: { code: 'NOT_FOUND', message: `no route for ${method} ${path}` } });
  }
}

function paginate<T>(
  result: { items: T[]; total: number },
  url: URL,
  page: { limit: number; offset: number },
  basePath: string,
): Json {
  const nextOffset = page.offset + page.limit;
  return {
    items: result.items as unknown as Json[],
    total: result.total,
    limit: page.limit,
    offset: page.offset,
    next:
      nextOffset < result.total
        ? `${basePath}?limit=${page.limit}&offset=${nextOffset}`
        : null,
  };
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new AppError('VALIDATION_ERROR', 'request body must be a JSON object');
    }
    return parsed as Json;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('VALIDATION_ERROR', 'invalid JSON body');
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof AppError) {
    json(res, STATUS_BY_CODE[err.code] ?? 500, { error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  json(res, 500, { error: { code: 'INTERNAL_ERROR', message } });
}

/** Bind to 127.0.0.1 only, on an ephemeral OS-assigned port (port 0). */
export async function listenLocal(server: Server, preferredPort = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(preferredPort, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}
