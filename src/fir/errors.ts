export type ErrorCode =
  | 'INVALID_LENGTH'
  | 'INVALID_SAMPLE_RATE'
  | 'CUTOFF_OUT_OF_RANGE'
  | 'UNSUPPORTED_WINDOW'
  | 'UNSUPPORTED_FILTER_TYPE'
  | 'NON_FINITE_SAMPLE'
  | 'SAMPLE_RATE_MISMATCH'
  | 'INVALID_BLOCK'
  | 'RUN_NOT_RUNNING'
  | 'RUN_ALREADY_RUNNING'
  | 'RUN_FINISHED'
  | 'NOT_FOUND'
  | 'DUPLICATE_IDEMPOTENCY_KEY'
  | 'INVALID_PAGINATION'
  | 'VALIDATION_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function assertFiniteVector(samples: ArrayLike<number>, label = 'samples'): void {
  if (!Array.isArray(samples) && !(samples instanceof Float64Array)) {
    throw new AppError('NON_FINITE_SAMPLE', `${label} must be an array of numbers`);
  }
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i]!;
      if (!Number.isFinite(value)) {
      throw new AppError(
        'NON_FINITE_SAMPLE',
        `${label}[${i}] is not finite (got ${String(value)})`,
        { index: i, value: String(value) },
      );
    }
  }
}
