/**
 * Typed platform errors.
 *
 * Every failure that crosses a module boundary is a `PlatformError`: it carries
 * a stable machine code, an HTTP status, whether a retry can plausibly succeed,
 * and a payload that is safe to show a client. Internal details stay in
 * `cause` and are logged, never serialized to the wire.
 *
 * This is deliberately not an enum: plugins and domain modules extend the code
 * space (`GATE_*`, `WORKFLOW_*`, `SANDBOX_*`) without editing this file.
 */

export type ErrorSeverity = 'warning' | 'error' | 'critical';

export interface PlatformErrorOptions {
  code: string;
  message: string;
  statusCode?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
  /** When false the message is replaced by a generic one at the HTTP boundary. */
  expose?: boolean;
  severity?: ErrorSeverity;
}

export class PlatformError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly expose: boolean;
  readonly severity: ErrorSeverity;
  readonly occurredAt: string;

  constructor(options: PlatformErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PlatformError';
    this.code = options.code;
    this.statusCode = options.statusCode ?? 500;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.expose = options.expose ?? this.statusCode < 500;
    this.severity = options.severity ?? (this.statusCode >= 500 ? 'error' : 'warning');
    this.occurredAt = new Date().toISOString();
  }

  static is(error: unknown): error is PlatformError {
    return error instanceof PlatformError;
  }
}

export class ValidationError extends PlatformError {
  constructor(message: string, details?: Record<string, unknown>, code = 'VALIDATION_FAILED') {
    super({ code, message, statusCode: 400, details });
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends PlatformError {
  constructor(message = 'Authentication is required.', code = 'UNAUTHORIZED') {
    super({ code, message, statusCode: 401 });
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends PlatformError {
  constructor(message = 'You do not have permission to perform this action.', code = 'FORBIDDEN', details?: Record<string, unknown>) {
    super({ code, message, statusCode: 403, details });
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends PlatformError {
  constructor(resource: string, id?: string) {
    super({
      code: 'NOT_FOUND',
      message: id ? `${resource} "${id}" was not found.` : `${resource} was not found.`,
      statusCode: 404,
      details: id ? { resource, id } : { resource },
    });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends PlatformError {
  constructor(message: string, code = 'CONFLICT', details?: Record<string, unknown>) {
    super({ code, message, statusCode: 409, details });
    this.name = 'ConflictError';
  }
}

export class PreconditionFailedError extends PlatformError {
  constructor(message: string, code = 'PRECONDITION_FAILED', details?: Record<string, unknown>) {
    super({ code, message, statusCode: 412, details });
    this.name = 'PreconditionFailedError';
  }
}

export class RateLimitError extends PlatformError {
  constructor(retryAfterMs: number, details?: Record<string, unknown>) {
    super({
      code: 'RATE_LIMITED',
      message: 'Too many requests. Retry after the indicated delay.',
      statusCode: 429,
      retryable: true,
      details: { retryAfterMs, ...details },
    });
    this.name = 'RateLimitError';
  }
}

export class TimeoutError extends PlatformError {
  constructor(operation: string, timeoutMs: number, details?: Record<string, unknown>) {
    super({
      code: 'TIMEOUT',
      message: `${operation} exceeded its ${timeoutMs}ms deadline.`,
      statusCode: 504,
      retryable: true,
      details: { operation, timeoutMs, ...details },
    });
    this.name = 'TimeoutError';
  }
}

export class UnavailableError extends PlatformError {
  constructor(message: string, details?: Record<string, unknown>, code = 'UNAVAILABLE') {
    super({ code, message, statusCode: 503, retryable: true, details });
    this.name = 'UnavailableError';
  }
}

export class InternalError extends PlatformError {
  constructor(message = 'An internal error occurred.', cause?: unknown, details?: Record<string, unknown>) {
    super({ code: 'INTERNAL', message, statusCode: 500, expose: false, cause, details });
    this.name = 'InternalError';
  }
}

export class AbortedError extends PlatformError {
  constructor(message = 'The operation was cancelled.', details?: Record<string, unknown>) {
    super({ code: 'ABORTED', message, statusCode: 499, retryable: false, details });
    this.name = 'AbortedError';
  }
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

const SAFE_MESSAGE = 'An internal error occurred.';

export function toErrorBody(error: unknown, requestId?: string): ErrorBody {
  if (error instanceof PlatformError) {
    return {
      error: {
        code: error.code,
        message: error.expose ? error.message : SAFE_MESSAGE,
        ...(error.expose && error.details ? { details: error.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
  return {
    error: {
      code: 'INTERNAL',
      message: SAFE_MESSAGE,
      ...(requestId ? { requestId } : {}),
    },
  };
}

export function statusForError(error: unknown): number {
  if (error instanceof PlatformError) return error.statusCode;
  return 500;
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (error instanceof AbortedError) return true;
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  return name === 'AbortError' || code === 'ABORT_ERR' || (error instanceof DOMException && error.name === 'AbortError');
}

export function describeError(error: unknown): { name: string; message: string; code?: string; stack?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: 'NonError', message: typeof error === 'string' ? error : JSON.stringify(error) };
}

/** True when a retry is worth attempting for an arbitrary thrown value. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof PlatformError) return error.retryable;
  const code = (error as { code?: unknown })?.code;
  // Transient node errors. ENOSPC / EACCES / ENOENT are not transient.
  return code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'ETIMEDOUT'
    || code === 'EAI_AGAIN'
    || code === 'SQLITE_BUSY'
    || code === 'SQLITE_LOCKED'
    || code === 'ABORT_ERR';
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter?: boolean;
  signal?: AbortSignal;
  random?: () => number;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  retryable?: (error: unknown) => boolean;
}

/** Exponential backoff with full jitter, cancellation-aware. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts));
  const retryable = options.retryable ?? isRetryable;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) throw new AbortedError('Operation cancelled before retry.', { attempt });
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !retryable(error)) throw error;

      const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const factor = options.jitter === false ? 1 : 0.5 + (options.random ?? Math.random)() * 0.5;
      const delayMs = Math.max(1, Math.round(exponential * factor));
      options.onRetry?.(attempt, delayMs, error);
      await sleep(delayMs, options.signal);
    }
  }
  throw lastError;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AbortedError('Sleep cancelled.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError('Sleep cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
