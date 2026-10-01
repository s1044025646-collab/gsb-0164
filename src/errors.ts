export type ErrorCode =
  | "VALIDATION_ERROR"
  | "EVEN_LENGTH"
  | "CUTOFF_OUT_OF_RANGE"
  | "INVALID_SAMPLE"
  | "SAMPLE_RATE_MISMATCH"
  | "NOT_FOUND"
  | "INVALID_STATE_TRANSITION"
  | "DUPLICATE_IDEMPOTENCY_KEY"
  | "BAD_JSON"
  | "METHOD_NOT_ALLOWED"
  | "INVALID_QUERY";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

export function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
