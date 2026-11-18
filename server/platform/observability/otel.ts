/**
 * OTLP (OpenTelemetry Protocol) trace exporter — OTLP/JSON over HTTP.
 *
 * This module converts the platform's internal `SpanData` (see `./tracing.ts`)
 * into the OTLP JSON wire format and ships it to an OTLP collector's
 * `/v1/traces` endpoint. It is intentionally dependency-free (Node builtins
 * only) and is designed to be plugged into `Tracer` as a `SpanExporter`
 * without ever letting an export failure break the request path.
 *
 * Design guarantees:
 *
 * - `OtlpExporter.export()` never throws. Garbage input is dropped, counted in
 *   `failedExports` and logged through the injected `logger` (if any).
 * - Delivery is at-most-once per batch: after `maxRetries` retries a batch is
 *   dropped, `failedExports` is incremented by the number of spans in it and
 *   `lastError` describes the terminal failure. Spans are never re-queued.
 * - `flush()` / `dispose()` drain everything enqueued so far and resolve only
 *   when the batches have either been delivered or dropped. They never throw.
 *
 * Wire-format notes (OTLP/JSON mapping — protobuf JSON rules):
 *
 * - `traceId` / `spanId` / `parentSpanId` are hex strings.
 * - 64-bit integers (`intValue`, `startTimeUnixNano`, `endTimeUnixNano`,
 *   `timeUnixNano`) are encoded as decimal strings. Nanosecond timestamps are
 *   computed with BigInt from `ms * 1e6` so they stay exact beyond 2^53
 *   (Date.now() * 1e6 ≈ 1.7e18 which exceeds Number.MAX_SAFE_INTEGER).
 * - Fractional milliseconds are rounded to the nearest millisecond before the
 *   BigInt multiply.
 * - `status.code` uses short enum names (`UNSET` | `OK` | `ERROR`) as required
 *   by this platform's contract. `kind` uses the numeric SPAN_KIND enum
 *   (internal=1, server=2, client=3, producer=4, consumer=5).
 * - OTLP has no null attribute value: attributes with `null`/`undefined`
 *   values are skipped, and objects/arrays/functions are JSON-stringified into
 *   `stringValue`. Non-finite numbers become `stringValue` ("NaN"/"Infinity").
 * - A span without `endTimeMs` (never ended) is exported with
 *   `endTimeUnixNano === startTimeUnixNano` (zero-duration) instead of being
 *   dropped or stamped with a surprising wall-clock time.
 * - `deployment.environment` is only emitted when configured; `service.version`
 *   and `scope.version` default to `2.0.0`.
 */
import type { SpanData, SpanEvent } from './tracing.js';

/* -------------------------------------------------------------------------- */
/* OTLP JSON types                                                            */
/* -------------------------------------------------------------------------- */

/** OTLP AnyValue: exactly one of the typed fields is set. */
export interface OtlpAnyValue {
  stringValue?: string;
  /** int64 values are encoded as decimal strings in OTLP/JSON. */
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

/** OTLP Span.Event (a timestamped event on the span). */
export interface OtlpSpanEvent {
  timeUnixNano: string;
  name: string;
  attributes: OtlpKeyValue[];
}

export type OtlpSpanStatusCode = 'UNSET' | 'OK' | 'ERROR';

export interface OtlpSpanStatus {
  code: OtlpSpanStatusCode;
  message?: string;
}

/** Numeric SPAN_KIND enum from the OTLP proto. */
export const OTLP_SPAN_KINDS = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
} as const;

export type OtlpSpanKind = (typeof OTLP_SPAN_KINDS)[keyof typeof OTLP_SPAN_KINDS];

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events: OtlpSpanEvent[];
  status: OtlpSpanStatus;
}

export interface OtlpResource {
  attributes: OtlpKeyValue[];
}

export interface OtlpScope {
  name: string;
  version?: string;
}

export interface OtlpScopeSpans {
  scope: OtlpScope;
  spans: OtlpSpan[];
}

export interface OtlpResourceSpans {
  resource: OtlpResource;
  scopeSpans: OtlpScopeSpans[];
}

/** Body of the OTLP/JSON POST to `/v1/traces`. */
export interface OtlpTracesRequest {
  resourceSpans: OtlpResourceSpans[];
}

/** Config accepted by `serializeRequest` and by the exporter. */
export interface OtlpSerializeConfig {
  /** Defaults to '2.0.0'. Applied to both resource and scope. */
  serviceVersion?: string;
  /** Emitted as the `deployment.environment` resource attribute when set. */
  environment?: string;
}

/** Minimal logger contract injected by the host application. */
export interface OtlpLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface OtlpExporterOptions {
  /** Base collector endpoint, e.g. "https://otel.example.com:4318". `/v1/traces` is appended. */
  endpoint: string;
  /** Extra headers, e.g. auth. Merged over the default Content-Type. */
  headers?: Record<string, string>;
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  /** Injectable fetch implementation (defaults to globalThis.fetch). */
  fetchFn?: typeof fetch;
  /** Per-attempt timeout. Default 10_000 ms. */
  timeoutMs?: number;
  /** Spans per POST. Default 64. */
  maxBatch?: number;
  /** Retries after the initial attempt on 429/5xx/network/timeout. Default 2. */
  maxRetries?: number;
  logger?: OtlpLogger;
}

/* -------------------------------------------------------------------------- */
/* Conversion helpers                                                          */
/* -------------------------------------------------------------------------- */

const KIND_MAP: Record<string, number> = { ...OTLP_SPAN_KINDS };

function toFiniteMs(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** ms epoch → decimal string nanoseconds (exact via BigInt). */
function msToNanoString(ms: number): string {
  const safe = Number.isFinite(ms) ? ms : 0;
  return (BigInt(Math.round(safe)) * 1_000_000n).toString(10);
}

function kvString(key: string, value: string): OtlpKeyValue {
  return { key, value: { stringValue: value } };
}

function toOtlpValue(value: unknown): OtlpAnyValue | null {
  // OTLP AnyValue has no null representation — drop the attribute instead.
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string':
      return { stringValue: value };
    case 'boolean':
      return { boolValue: value };
    case 'number': {
      if (!Number.isFinite(value)) return { stringValue: String(value) };
      return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
    }
    case 'bigint':
      return { intValue: value.toString(10) };
    default:
      // Objects/arrays/functions: carry the JSON representation, or a String() fallback.
      try {
        const json = JSON.stringify(value);
        return { stringValue: json ?? String(value) };
      } catch {
        return { stringValue: String(value) };
      }
  }
}

function toOtlpAttributes(input: unknown): OtlpKeyValue[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const out: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const converted = toOtlpValue(value);
    if (converted) out.push({ key, value: converted });
  }
  return out;
}

function toOtlpEvent(event: unknown, fallbackMs: number): OtlpSpanEvent | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as SpanEvent;
  const atMs = toFiniteMs(e.at, fallbackMs);
  return {
    timeUnixNano: msToNanoString(atMs),
    name: typeof e.name === 'string' ? e.name : String(e.name ?? ''),
    attributes: toOtlpAttributes(e.attributes),
  };
}

function extractErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

function toOtlpStatus(status: unknown, error: unknown): OtlpSpanStatus {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  const code: OtlpSpanStatusCode = normalized === 'ok' ? 'OK' : normalized === 'error' ? 'ERROR' : 'UNSET';
  if (code === 'ERROR') {
    const message = extractErrorMessage(error);
    if (message) return { code, message };
  }
  return { code };
}

function kindOf(kind: unknown): number {
  return typeof kind === 'string' ? KIND_MAP[kind.trim().toLowerCase()] ?? OTLP_SPAN_KINDS.internal : OTLP_SPAN_KINDS.internal;
}

/**
 * Convert one internal span to its OTLP JSON representation.
 *
 * `serviceName` is used to backfill a missing `service.name` span attribute
 * (Tracer-created spans already carry one; hand-built spans may not). Spans
 * carrying `endTimeMs` get nanoseconds via exact BigInt math; unfinished spans
 * get `endTimeUnixNano === startTimeUnixNano`.
 */
export function spanToOtlp(span: SpanData, serviceName: string): OtlpSpan {
  const source = (span ?? {}) as SpanData;
  const startMs = toFiniteMs(source.startTimeMs, 0);
  const endMs = toFiniteMs(source.endTimeMs, startMs);

  const attributes = toOtlpAttributes(source.attributes);
  const hasServiceName =
    source.attributes && typeof source.attributes === 'object' && Object.prototype.hasOwnProperty.call(source.attributes, 'service.name');
  if (!hasServiceName && typeof serviceName === 'string' && serviceName.length > 0) {
    attributes.push(kvString('service.name', serviceName));
  }

  const events: OtlpSpanEvent[] = [];
  if (Array.isArray(source.events)) {
    for (const event of source.events) {
      const converted = toOtlpEvent(event, startMs);
      if (converted) events.push(converted);
    }
  }

  const otlp: OtlpSpan = {
    traceId: String(source.traceId ?? ''),
    spanId: String(source.spanId ?? ''),
    ...(typeof source.parentSpanId === 'string' && source.parentSpanId.length > 0 ? { parentSpanId: source.parentSpanId } : {}),
    name: typeof source.name === 'string' ? source.name : String(source.name ?? ''),
    kind: kindOf(source.kind),
    startTimeUnixNano: msToNanoString(startMs),
    endTimeUnixNano: msToNanoString(endMs),
    attributes,
    events,
    status: toOtlpStatus(source.status, source.error),
  };
  return otlp;
}

/* -------------------------------------------------------------------------- */
/* Request serialization                                                       */
/* -------------------------------------------------------------------------- */

function effectiveServiceVersion(config?: OtlpSerializeConfig): string {
  const version = config?.serviceVersion;
  return typeof version === 'string' && version.trim().length > 0 ? version : '2.0.0';
}

function buildOtlpRequest(serviceName: string, spans: OtlpSpan[], config?: OtlpSerializeConfig): OtlpTracesRequest {
  const serviceVersion = effectiveServiceVersion(config);
  const resourceAttributes: OtlpKeyValue[] = [
    kvString('service.name', serviceName),
    kvString('service.version', serviceVersion),
    kvString('telemetry.sdk.name', 'flutterforge'),
  ];
  const environment = typeof config?.environment === 'string' && config.environment.trim().length > 0 ? config.environment : undefined;
  if (environment) resourceAttributes.push(kvString('deployment.environment', environment));

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [
          {
            scope: { name: 'flutterforge', version: serviceVersion },
            spans,
          },
        ],
      },
    ],
  };
}

/**
 * Serialize spans into the OTLP/JSON request body for `/v1/traces`.
 *
 * Strict: the first span that fails conversion throws. (The exporter's send
 * path converts per-span with error isolation instead — it never throws.)
 */
export function serializeRequest(
  serviceName: string,
  spans: readonly SpanData[],
  config: OtlpSerializeConfig = {},
): OtlpTracesRequest {
  const otlpSpans = (Array.isArray(spans) ? spans : []).map((span) => spanToOtlp(span, serviceName));
  return buildOtlpRequest(serviceName, otlpSpans, config);
}

/* -------------------------------------------------------------------------- */
/* Endpoint configuration helper                                               */
/* -------------------------------------------------------------------------- */

/**
 * True when an OTLP endpoint is configured: one of
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` parses
 * as a URL with an http:// or https:// scheme and a non-empty host. Never throws.
 */
export function isOtlpEndpointConfigured(env: Record<string, string | undefined> = process.env): boolean {
  try {
    const raw = env?.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env?.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
    const endpoint = typeof raw === 'string' ? raw.trim() : '';
    if (!endpoint) return false;
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.host.length > 0;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Exporter                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BATCH = 64;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_MS = 100;
const RETRY_CAP_MS = 5_000;
const RETRY_AFTER_CAP_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function clampInt(value: unknown, fallback: number, min: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : NaN;
  if (Number.isNaN(n) || n < min) return fallback;
  return n;
}

/** Minimal validity check used by export(); conversion sanitizes the rest. */
function isSpanLike(value: unknown): value is SpanData {
  if (!value || typeof value !== 'object') return false;
  const v = value as { traceId?: unknown; spanId?: unknown };
  return typeof v.traceId === 'string' && typeof v.spanId === 'string';
}

function extractStatus(response: unknown): number | null {
  if (!response || typeof response !== 'object') return null;
  const status = (response as { status?: unknown }).status;
  if (typeof status === 'number' && Number.isFinite(status)) return status;
  if (typeof status === 'string' && status.trim().length > 0) {
    const parsed = Number(status);
    if (Number.isFinite(parsed)) return parsed;
  }
  const ok = (response as { ok?: unknown }).ok;
  if (typeof ok === 'boolean') return ok ? 200 : null;
  return null;
}

async function readBodySnippet(response: unknown, max = 300): Promise<string | undefined> {
  try {
    const text = (response as { text?: unknown })?.text;
    if (typeof text !== 'function') return undefined;
    const raw = await (text as () => Promise<string>).call(response);
    if (typeof raw !== 'string' || raw.length === 0) return undefined;
    return raw.slice(0, max);
  } catch {
    return undefined;
  }
}

/** Parse Retry-After (delta-seconds or HTTP-date); capped, best-effort. */
function retryAfterMs(response: unknown): number | null {
  try {
    const headers = (response as { headers?: unknown })?.headers as
      | { get?: (name: string) => string | null }
      | Record<string, string>
      | undefined;
    let raw: string | null | undefined;
    if (headers && typeof (headers as { get?: unknown }).get === 'function') {
      raw = (headers as { get: (name: string) => string | null }).get('retry-after');
    } else if (headers && typeof headers === 'object') {
      const record = headers as Record<string, string>;
      raw = record['retry-after'] ?? record['Retry-After'];
    }
    if (!raw) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(RETRY_AFTER_CAP_MS, seconds * 1000));
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, Math.min(RETRY_AFTER_CAP_MS, date - Date.now()));
    return null;
  } catch {
    return null;
  }
}

function tracesUrl(endpoint: string): string {
  return `${endpoint.trim().replace(/\/+$/, '')}/v1/traces`;
}

class OtlpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtlpTimeoutError';
  }
}

/**
 * Batching OTLP/HTTP trace exporter.
 *
 * `export()` enqueues spans synchronously and returns immediately; batches of
 * `maxBatch` (default 64) are POSTed to `<endpoint>/v1/traces` as OTLP/JSON.
 * When the queue reaches `maxBatch` a background drain starts; `flush()`
 * (and its alias `dispose()`) drains everything pending and awaits delivery.
 *
 * Failure semantics:
 *
 * - Per attempt, a request is bounded by `timeoutMs` (default 10s) via its own
 *   AbortController, and additionally raced against the timer so a fetch that
 *   never settles cannot hang the drain.
 * - 429, 5xx, network errors and timeouts are retried up to `maxRetries`
 *   (default 2) with exponential backoff and full jitter; a `Retry-After`
 *   header on a 429 is honoured (capped at 30s) instead of the backoff delay.
 * - Any other 4xx fails fast (no retry).
 * - A batch that exhausts retries (or is rejected) is dropped: `failedExports`
 *   increases by the number of spans lost, `lastError` describes the terminal
 *   failure, and a warning is logged. Callers are never thrown into.
 *
 * `failedExports` counts spans that could not be delivered (conversion
 * failures, enqueue-time garbage, retry-exhausted batches, batches rejected
 * with 4xx, plus spans rejected via a 2xx `partialSuccess`). `lastError` holds
 * the most recent failure message; it is intentionally sticky (not cleared by
 * a later success) so an operator probing after recovery still sees it.
 */
export class OtlpExporter {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly environment?: string;

  /** Total spans dropped because they could not be delivered. */
  failedExports = 0;
  /** Most recent failure message, or null if no failure has been observed yet. */
  lastError: string | null = null;

  private readonly endpoint: string;
  private readonly headers?: Record<string, string>;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBatch: number;
  private readonly maxRetries: number;
  private readonly logger?: OtlpLogger;
  private readonly pending: SpanData[] = [];
  /** Serializes all send activity; never rejects. */
  private chain: Promise<void> = Promise.resolve();

  constructor(options: OtlpExporterOptions) {
    const opts = (options ?? {}) as OtlpExporterOptions;
    this.serviceName = typeof opts.serviceName === 'string' && opts.serviceName.trim().length > 0 ? opts.serviceName : 'unknown_service';
    this.endpoint = typeof opts.endpoint === 'string' ? opts.endpoint.trim() : '';
    this.headers = opts.headers && typeof opts.headers === 'object' ? { ...opts.headers } : undefined;
    this.serviceVersion = effectiveServiceVersion(opts);
    this.environment = typeof opts.environment === 'string' && opts.environment.trim().length > 0 ? opts.environment : undefined;
    this.fetchFn = typeof opts.fetchFn === 'function' ? opts.fetchFn : (globalThis.fetch?.bind(globalThis) as typeof fetch);
    this.timeoutMs = clampInt(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 1);
    this.maxBatch = clampInt(opts.maxBatch, DEFAULT_MAX_BATCH, 1);
    this.maxRetries = clampInt(opts.maxRetries, DEFAULT_MAX_RETRIES, 0);
    this.logger = opts.logger;
  }

  /** Number of spans currently waiting to be sent. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Queue spans for export. Synchronous, never throws. When the queue reaches
   * `maxBatch` a background drain is kicked off; use `flush()` to await
   * delivery (e.g. during shutdown).
   */
  export(spans: readonly SpanData[]): void {
    try {
      if (spans === null || spans === undefined) {
        this.failedExports += 1;
        this.lastError = 'export called with null/undefined spans';
        this.warn('otel.export.invalid_input', { reason: this.lastError });
        return;
      }
      const list: readonly unknown[] = Array.isArray(spans) ? spans : [spans as unknown];
      let dropped = 0;
      for (const item of list) {
        if (isSpanLike(item)) {
          this.pending.push(item);
        } else {
          dropped += 1;
        }
      }
      if (dropped > 0) {
        this.failedExports += dropped;
        this.lastError = `dropped ${dropped} span(s) with missing traceId/spanId`;
        this.warn('otel.export.invalid_input', { dropped, reason: this.lastError });
      }
      if (this.pending.length >= this.maxBatch) void this.scheduleDrain();
    } catch (error) {
      // Belt and braces: the request path must never see an export failure.
      this.failedExports += 1;
      this.lastError = toErrorMessage(error);
      this.warn('otel.export.enqueue_failed', { error: this.lastError });
    }
  }

  /** Drain all pending spans. Never throws; resolves when done or dropped. */
  async flush(): Promise<void> {
    return this.scheduleDrain();
  }

  /** Alias for `flush()` — graceful-shutdown hook. */
  async dispose(): Promise<void> {
    return this.flush();
  }

  private scheduleDrain(): Promise<void> {
    const run = this.chain.then(() => this.drain());
    // Keep the internal chain alive regardless of what drain() does.
    this.chain = run.catch(() => {});
    return run;
  }

  private async drain(): Promise<void> {
     
    while (true) {
      const batch = this.pending.splice(0, this.maxBatch);
      if (batch.length === 0) return;
      // sendBatch never throws; defensive catch keeps drain() total.
      try {
        await this.sendBatch(batch);
      } catch (error) {
        this.failedExports += batch.length;
        this.lastError = toErrorMessage(error);
        this.warn('otel.export.batch_failed', { batchSize: batch.length, error: this.lastError });
      }
    }
  }

  private async sendBatch(batch: readonly SpanData[]): Promise<void> {
    // Convert per-span so one malformed span cannot sink the whole batch.
    const converted: OtlpSpan[] = [];
    let conversionFailures = 0;
    for (const raw of batch) {
      try {
        converted.push(spanToOtlp(raw, this.serviceName));
      } catch (error) {
        conversionFailures += 1;
        this.lastError = toErrorMessage(error);
      }
    }
    if (conversionFailures > 0) {
      this.failedExports += conversionFailures;
      this.warn('otel.export.span_conversion_failed', { failed: conversionFailures, batchSize: batch.length, error: this.lastError });
    }
    if (converted.length === 0) return;

    if (!this.endpoint) {
      this.failedExports += converted.length;
      this.lastError = 'OTLP endpoint is not configured';
      this.warn('otel.export.not_configured', { batchSize: converted.length });
      return;
    }

    let body: string;
    try {
      const request = buildOtlpRequest(
        this.serviceName,
        converted,
        { serviceVersion: this.serviceVersion, environment: this.environment },
      );
      body = JSON.stringify(request);
    } catch (error) {
      this.failedExports += converted.length;
      this.lastError = toErrorMessage(error);
      this.warn('otel.export.serialize_failed', { batchSize: converted.length, error: this.lastError });
      return;
    }

    const url = tracesUrl(this.endpoint);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...this.headers };
    const attempts = this.maxRetries + 1;
    let lastFailure = 'unknown error';

    for (let attempt = 0; attempt < attempts; attempt++) {
      let response: unknown = null;
      try {
        response = await this.fetchWithTimeout(url, { method: 'POST', headers, body }, this.timeoutMs);
      } catch (error) {
        // Network failure or timeout — retryable.
        lastFailure = toErrorMessage(error);
        this.lastError = lastFailure;
        if (attempt < attempts - 1) await sleep(this.retryDelay(attempt, null));
        continue;
      }

      const status = extractStatus(response);

      if (status !== null && status >= 200 && status < 300) {
        await this.notePartialSuccess(response);
        return;
      }

      const snippet = await readBodySnippet(response);
      const detail = snippet ? `: ${snippet}` : '';

      if (status === 429 || (status !== null && status >= 500 && status < 600) || status === null) {
        // Retryable: rate limited, server error, or an unusable response.
        lastFailure = status === null
          ? `OTLP export failed: unusable response${detail}`
          : `OTLP export failed with status ${status}${detail}`;
        this.lastError = lastFailure;
        if (attempt < attempts - 1) {
          const retryAfter = status === 429 ? retryAfterMs(response) : null;
          await sleep(retryAfter ?? this.retryDelay(attempt, null));
          continue;
        }
        break; // retries exhausted
      }

      // Fail fast on other 4xx — retrying will not help.
      lastFailure = `OTLP export rejected with status ${status}${detail}`;
      this.lastError = lastFailure;
      this.failedExports += converted.length;
      this.warn('otel.export.rejected', { status, batchSize: converted.length, error: snippet ?? lastFailure });
      return;
    }

    this.failedExports += converted.length;
    this.lastError = lastFailure;
    this.warn('otel.export.failed', { batchSize: converted.length, attempts, error: lastFailure });
  }

  /** Full-jitter exponential backoff: random in [0, min(cap, base * 2^attempt)). */
  private retryDelay(attempt: number, overrideMs: number | null): number {
    if (overrideMs !== null && Number.isFinite(overrideMs)) return Math.max(0, Math.min(RETRY_AFTER_CAP_MS, overrideMs));
    const nominal = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
    return Math.floor(Math.random() * nominal);
  }

  /**
   * Race fetch against an independent timer so a fetch implementation that
   * never settles (or ignores AbortSignal) still loses after `timeoutMs`.
   */
  private async fetchWithTimeout(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timerPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new OtlpTimeoutError(`OTLP export timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    // Silence late rejections of a fetch that lost the race.
    timerPromise.catch(() => {});
    try {
      const fetchPromise = Promise.resolve().then(() => this.fetchFn(url, { ...init, signal: controller.signal } as RequestInit));
      fetchPromise.catch(() => {});
      return await Promise.race([fetchPromise, timerPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Honour a 2xx `partialSuccess` (rejected spans count) when present. */
  private async notePartialSuccess(response: unknown): Promise<void> {
    try {
      const snippet = await readBodySnippet(response, 4096);
      if (!snippet) return;
      const parsed = JSON.parse(snippet) as { partialSuccess?: { rejectedSpans?: unknown; errorMessage?: unknown } } | null;
      const rejected = Number(parsed?.partialSuccess?.rejectedSpans ?? 0);
      if (!Number.isFinite(rejected) || rejected <= 0) return;
      this.failedExports += rejected;
      const errorMessage = typeof parsed?.partialSuccess?.errorMessage === 'string' ? parsed.partialSuccess.errorMessage : undefined;
      this.lastError = `collector rejected ${rejected} span(s)${errorMessage ? `: ${errorMessage}` : ''}`;
      this.warn('otel.export.partial_success', { rejectedSpans: rejected, errorMessage });
    } catch {
      // Partial-success introspection is best-effort only.
    }
  }

  private warn(message: string, fields?: Record<string, unknown>): void {
    try {
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn(message, fields);
        return;
      }
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(`[otel] ${message}`, fields ?? '');
      }
    } catch {
      // Logging must never throw into the caller either.
    }
  }
}
