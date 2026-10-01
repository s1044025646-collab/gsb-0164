import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { ApiError, type ErrorCode } from "./errors.ts";
import { parsePagination } from "./db.ts";
import {
  coefficientsOf,
  createDesign,
  createRun,
  createSignal,
  getDesign,
  getRun,
  getSignal,
  listDesigns,
  listRuns,
  listSignals,
  processBlock,
  runFrequencyResponse,
} from "./services.ts";
import type { DatabaseSync } from "node:sqlite";

interface JsonResponse {
  status: number;
  body: unknown;
}

export function createHandler(db: DatabaseSync) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      const result = await route(db, method, url, req);
      sendJson(res, result.status, result.body);
    } catch (err) {
      if (err instanceof SyntaxError) {
        sendError(res, 400, "BAD_JSON", err.message);
        return;
      }
      if (err instanceof ApiError) {
        const httpStatus = httpStatusFor(err.code);
        sendError(res, httpStatus, err.code, err.message, err.details);
        return;
      }
      sendError(res, 500, "VALIDATION_ERROR", (err as Error).message);
    }
  };
}

function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "METHOD_NOT_ALLOWED":
      return 405;
    case "DUPLICATE_IDEMPOTENCY_KEY":
      return 409;
    case "INVALID_STATE_TRANSITION":
      return 409;
    default:
      return 400;
  }
}

async function route(
  db: DatabaseSync,
  method: string,
  url: URL,
  req: IncomingMessage
): Promise<JsonResponse> {
  const parts = url.pathname.split("/").filter(Boolean);
  const idem = req.headers["idempotency-key"];
  const idempotencyKey = Array.isArray(idem) ? idem[0] : idem;

  // /healthz
  if (parts.length === 1 && parts[0] === "healthz") {
    if (method !== "GET") throw new ApiError("METHOD_NOT_ALLOWED", "only GET supported");
    return { status: 200, body: { ok: true } };
  }

  // /designs, /designs/:id, /designs/:id/response
  if (parts[0] === "designs") {
    if (parts.length === 1) {
      if (method === "POST") {
        const body = await readJson(req);
        return { status: 201, body: createDesign(db, body, idempotencyKey) };
      }
      if (method === "GET") {
        const { limit, offset } = parsePagination(url.searchParams);
        return { status: 200, body: listDesigns(db, limit, offset) };
      }
      throw new ApiError("METHOD_NOT_ALLOWED", `method ${method} not allowed on /designs`);
    }
    const id = parseId(parts[1]);
    if (parts.length === 2) {
      if (method !== "GET") throw new ApiError("METHOD_NOT_ALLOWED", "only GET supported");
      return { status: 200, body: getDesign(db, id) };
    }
    if (parts.length === 3 && parts[2] === "response") {
      if (method !== "GET") throw new ApiError("METHOD_NOT_ALLOWED", "only GET supported");
      const bins = Number(url.searchParams.get("bins") ?? "257");
      return { status: 200, body: runFrequencyResponse(db, id, bins) };
    }
    throw new ApiError("NOT_FOUND", "unknown designs sub-path");
  }

  // /signals
  if (parts[0] === "signals") {
    if (parts.length === 1) {
      if (method === "POST") {
        const body = await readJson(req);
        return { status: 201, body: createSignal(db, body, idempotencyKey) };
      }
      if (method === "GET") {
        const { limit, offset } = parsePagination(url.searchParams);
        return { status: 200, body: listSignals(db, limit, offset) };
      }
      throw new ApiError("METHOD_NOT_ALLOWED", `method ${method} not allowed`);
    }
    if (parts.length === 2) {
      if (method !== "GET") throw new ApiError("METHOD_NOT_ALLOWED", "only GET supported");
      return { status: 200, body: getSignal(db, parseId(parts[1])) };
    }
  }

  // /runs, /runs/:id, /runs/:id/blocks
  if (parts[0] === "runs") {
    if (parts.length === 1) {
      if (method === "POST") {
        const body = (await readJson(req)) as { designId: number; signalId?: number | null };
        return {
          status: 201,
          body: createRun(db, requireInt(body.designId, "designId"), body.signalId ?? null),
        };
      }
      if (method === "GET") {
        const { limit, offset } = parsePagination(url.searchParams);
        return { status: 200, body: listRuns(db, limit, offset) };
      }
      throw new ApiError("METHOD_NOT_ALLOWED", `method ${method} not allowed`);
    }
    const id = parseId(parts[1]);
    if (parts.length === 2) {
      if (method !== "GET") throw new ApiError("METHOD_NOT_ALLOWED", "only GET supported");
      const run = getRun(db, id);
      const d = getDesign(db, run.design_id);
      return {
        status: 200,
        body: { ...run, coefficients: coefficientsOf(d) },
      };
    }
    if (parts.length === 3 && parts[2] === "blocks") {
      if (method !== "POST") throw new ApiError("METHOD_NOT_ALLOWED", "only POST supported");
      const body = (await readJson(req)) as { samples?: unknown; action?: string };
      const result = processBlock(
        db,
        id,
        body.samples ?? [],
        (body.action as "process" | "pause" | "resume" | "flush") ?? "process"
      );
      return { status: 200, body: result };
    }
  }

  throw new ApiError("NOT_FOUND", `no route for ${method} ${url.pathname}`);
}

function parseId(segment: string | undefined): number {
  const id = Number(segment);
  if (!Number.isInteger(id) || id < 1) {
    throw new ApiError("VALIDATION_ERROR", "id must be a positive integer");
  }
  return id;
}

function requireInt(value: unknown, name: string): number {
  if (!Number.isInteger(value)) {
    throw new ApiError("VALIDATION_ERROR", `${name} must be an integer`);
  }
  return value as number;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown
): void {
  sendJson(res, status, { error: { code, message, details: details ?? null } });
}
