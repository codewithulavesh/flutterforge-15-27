/**
 * Structured JSON-L logging with mandatory redaction.
 *
 * Two rules make this safe for an AI platform:
 *  1. Secrets are removed by shape (patterns) and by key name before the
 *     record is formatted. A logger can therefore be handed an arbitrary
 *     object without leaking provider keys into files or stdout.
 *  2. Every record carries correlation identifiers (request, trace, span,
 *     tenant, run) so distributed traces can be reconstructed from logs.
 */
import { describeError } from './errors.js';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export interface LogRecord {
  time: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  bindings?: Record<string, unknown>;
  /** Prefix appended to every message, useful for subsystems. */
  name?: string;
}

export interface Logger {
  level: LogLevel;
  child(bindings: Record<string, unknown>): Logger;
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, error?: unknown, fields?: Record<string, unknown>): void;
  fatal(msg: string, error?: unknown, fields?: Record<string, unknown>): void;
  isLevelEnabled(level: LogLevel): boolean;
}

const SECRET_KEY_PATTERN = /(pass(word|phrase)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|session[-_]?id|client[-_]?secret|access[-_]?key|refresh[-_]?token|raw[-_]?key)/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,                       // OpenAI / OpenRouter style
  /\bsk-or-v1-[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                        // Google API key
  /\bAKIA[0-9A-Z]{16}\b/g,                             // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                   // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,                 // Slack tokens
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+/gi, // connection strings w/ creds
];

export const REDACTED = '[REDACTED]';

/** Replace known secret shapes inside free text. */
export function redactText(input: string): string {
  let output = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  return output;
}

/**
 * Deep-redact an object. Bounded in depth and entry count so a hostile or
 * accidental huge payload cannot stall the event loop.
 */
export function redact(value: unknown, options: { depth?: number; maxEntries?: number } = {}): unknown {
  const maxDepth = options.depth ?? 8;
  const maxEntries = options.maxEntries ?? 200;

  const walk = (current: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (depth > maxDepth) return '[Truncated]';
    if (typeof current === 'string') return redactText(current.length > 4000 ? `${current.slice(0, 4000)}…` : current);
    if (current === null || typeof current === 'number' || typeof current === 'boolean') return current;
    if (typeof current === 'bigint') return current.toString();
    if (typeof current === 'undefined') return undefined;
    if (current instanceof Error) return describeError(current);
    if (current instanceof Date) return current.toISOString();
    if (Buffer.isBuffer(current)) return `[Buffer ${current.length}B]`;
    if (typeof current !== 'object') return String(current);

    const object = current as object;
    if (seen.has(object)) return '[Circular]';
    seen.add(object);
    try {
      if (Array.isArray(object)) {
        const slice = object.slice(0, maxEntries);
        const mapped = slice.map((item) => walk(item, depth + 1, seen));
        if (object.length > maxEntries) mapped.push(`[+${object.length - maxEntries} more]`);
        return mapped;
      }
      const record = object as Record<string, unknown>;
      const keys = Object.keys(record);
      const result: Record<string, unknown> = {};
      let count = 0;
      for (const key of keys) {
        if (count >= maxEntries) {
          result['_truncated'] = `${keys.length - maxEntries} keys omitted`;
          break;
        }
        result[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : walk(record[key], depth + 1, seen);
        count += 1;
      }
      return result;
    } finally {
      seen.delete(object);
    }
  };

  return walk(value, 0, new WeakSet());
}

export function jsonLineSink(record: LogRecord): void {
  // stdout is reserved for application logs; stdout consumers parse one JSON
  // object per line. Never throw from a logging sink.
  try {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } catch {
    /* logging must never crash the process */
  }
}

export function memorySink(target: LogRecord[] = []): LogSink {
  return (record) => {
    target.push(record);
    if (target.length > 5000) target.splice(0, target.length - 5000);
  };
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? jsonLineSink;
  const bindings = options.bindings ?? {};
  const prefix = options.name;

  const emit = (entryLevel: LogLevel, msg: string, fields: Record<string, unknown> = {}): void => {
    if (LEVEL_WEIGHT[entryLevel] < LEVEL_WEIGHT[level]) return;
    const record: LogRecord = {
      time: new Date().toISOString(),
      level: entryLevel,
      msg: redactText(prefix ? `${prefix}: ${msg}` : msg),
      ...(redact(bindings) as Record<string, unknown>),
      ...(redact(fields) as Record<string, unknown>),
    };
    sink(record);
  };

  const logger: Logger = {
    level,
    isLevelEnabled: (candidate) => LEVEL_WEIGHT[candidate] >= LEVEL_WEIGHT[level],
    child: (extra) => createLogger({ level, sink, bindings: { ...bindings, ...extra }, name: prefix }),
    trace: (msg, fields) => emit('trace', msg, fields),
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, error, fields) => emit('error', msg, { ...fields, err: error === undefined ? undefined : describeError(error) }),
    fatal: (msg, error, fields) => emit('fatal', msg, { ...fields, err: error === undefined ? undefined : describeError(error) }),
  };
  return logger;
}

/** Logger used before configuration is loaded. */
export const silentLogger: Logger = createLogger({ level: 'fatal', sink: () => undefined });
