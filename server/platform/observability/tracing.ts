/**
 * W3C-trace-context compatible tracing.
 *
 * Spans are exported through a pluggable sink: a memory exporter for tests,
 * a JSON-lines exporter for operators, and later an OTLP exporter without
 * touching instrumentation sites. Active spans travel in AsyncLocalStorage so
 * unrelated concurrent requests never steal each other's parent.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export type SpanStatus = 'unset' | 'ok' | 'error';

export interface SpanEvent {
  name: string;
  at: number;
  attributes?: Record<string, unknown>;
}

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 'internal' | 'server' | 'client' | 'producer' | 'consumer';
  startTimeMs: number;
  endTimeMs?: number;
  durationMs?: number;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  error?: { name: string; message: string; stack?: string };
}

export interface SpanExporter {
  export(spans: readonly SpanData[]): void;
}

export interface TracerOptions {
  serviceName: string;
  enabled?: boolean;
  sampleRatio?: number;
  exporter?: SpanExporter;
  now?: () => number;
  random?: () => number;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function isValidHex(value: string): boolean {
  return value.length > 0 && /^[0-9a-f]+$/.test(value);
}

export interface ParsedTraceparent {
  version: string;
  traceId: string;
  parentSpanId: string;
  flags: number;
}

export function parseTraceparent(header: string | undefined): ParsedTraceparent | null {
  if (!header || header.length > 128) return null;
  const match = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!match) return null;
  const [, version, traceId, parentSpanId, flags] = match;
  if (version === 'ff') return null;
  if (!isValidHex(traceId) || /^0+$/.test(traceId)) return null;
  if (!isValidHex(parentSpanId) || /^0+$/.test(parentSpanId)) return null;
  return { version, traceId, parentSpanId, flags: Number.parseInt(flags, 16) };
}

export function formatTraceparent(traceId: string, spanId: string, sampled: boolean): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

export class Span {
  readonly data: SpanData;
  private ended = false;

  constructor(data: SpanData) {
    this.data = data;
  }

  get traceId(): string {
    return this.data.traceId;
  }

  get spanId(): string {
    return this.data.spanId;
  }

  setAttribute(key: string, value: unknown): this {
    if (!this.ended && value !== undefined) this.data.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Record<string, unknown>): this {
    for (const [key, value] of Object.entries(attributes)) this.setAttribute(key, value);
    return this;
  }

  addEvent(name: string, attributes?: Record<string, unknown>): this {
    if (!this.ended) this.data.events.push({ name, at: Date.now(), ...(attributes ? { attributes } : {}) });
    return this;
  }

  setStatus(status: SpanStatus): this {
    if (!this.ended) this.data.status = status;
    return this;
  }

  recordError(error: unknown): this {
    if (this.ended) return this;
    this.data.status = 'error';
    if (error instanceof Error) {
      this.data.error = { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
      const code = (error as unknown as { code?: unknown }).code;
      if (typeof code === 'string') {
        this.data.attributes['error.code'] = code;
      }
    } else {
      this.data.error = { name: 'NonError', message: typeof error === 'string' ? error : JSON.stringify(error) };
    }
    return this;
  }

  /** Idempotent; safe to call from a finally block after an explicit end. */
  end(): SpanData {
    if (this.ended) return this.data;
    this.ended = true;
    this.data.endTimeMs = Date.now();
    this.data.durationMs = Math.max(0, this.data.endTimeMs - this.data.startTimeMs);
    return this.data;
  }

  get isEnded(): boolean {
    return this.ended;
  }
}

export class Tracer {
  readonly serviceName: string;
  private readonly enabled: boolean;
  private readonly sampleRatio: number;
  private readonly exporter?: SpanExporter;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly storage = new AsyncLocalStorage<Span>();
  private readonly buffer: SpanData[] = [];
  private readonly exported: SpanData[] = [];

  constructor(options: TracerOptions) {
    this.serviceName = options.serviceName;
    this.enabled = options.enabled ?? true;
    this.sampleRatio = Math.min(1, Math.max(0, options.sampleRatio ?? 1));
    this.exporter = options.exporter;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  activeSpan(): Span | undefined {
    return this.storage.getStore();
  }

  /** Start a span as a child of the active span, or of the given traceparent. */
  startSpan(name: string, options: { kind?: SpanData['kind']; traceparent?: string; attributes?: Record<string, unknown>; forceSample?: boolean } = {}): Span {
    const incoming = parseTraceparent(options.traceparent);
    const parent = this.activeSpan();
    const parentData = parent && !parent.isEnded ? parent.data : undefined;
    const traceId = incoming?.traceId ?? parentData?.traceId ?? randomHex(16);
    const parentSpanId = incoming?.parentSpanId ?? parentData?.spanId;
    const sampled = options.forceSample === true
      || Boolean(incoming && (incoming.flags & 1) === 1)
      || this.random() < this.sampleRatio;
    const span = new Span({
      traceId,
      spanId: randomHex(8),
      ...(parentSpanId && isValidHex(parentSpanId) ? { parentSpanId } : {}),
      name,
      kind: options.kind ?? 'internal',
      startTimeMs: this.now(),
      status: 'unset',
      attributes: {
        'service.name': this.serviceName,
        ...(sampled ? {} : { 'sampling.dropped': true }),
        ...(options.attributes ?? {}),
      },
      events: [],
    });
    return span;
  }

  /** Run `fn` inside the span's async context and always close it. */
  async withSpan<T>(span: Span, fn: () => Promise<T> | T): Promise<T> {
    try {
      return await this.storage.run(span, async () => fn());
    } catch (error) {
      span.recordError(error);
      throw error;
    } finally {
      this.finish(span);
    }
  }

  startActiveSpan<T>(name: string, fn: (span: Span) => Promise<T> | T, options: Parameters<Tracer['startSpan']>[1] = {}): Promise<T> {
    const span = this.startSpan(name, options);
    return this.withSpan(span, () => fn(span));
  }

  finish(span: Span): void {
    const data = span.end();
    if (!this.enabled) return;
    this.buffer.push(data);
    if (this.buffer.length >= 64) this.flush();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    for (const span of batch) {
      this.exported.push(span);
      if (this.exported.length > 2000) this.exported.shift();
    }
    try {
      this.exporter?.export(batch);
    } catch {
      /* tracing must never break the request path */
    }
  }

  spans(): readonly SpanData[] {
    return this.exported;
  }

  reset(): void {
    this.buffer.length = 0;
    this.exported.length = 0;
  }
}

export function memoryExporter(target: SpanData[] = []): SpanExporter {
  return {
    export: (spans) => {
      target.push(...spans);
      if (target.length > 5000) target.splice(0, target.length - 5000);
    },
  };
}

export function jsonLineExporter(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): SpanExporter {
  return {
    export: (spans) => {
      for (const span of spans) write(JSON.stringify({ type: 'span', ...span }));
    },
  };
}
