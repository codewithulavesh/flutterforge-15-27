/**
 * Hashing and canonical serialization.
 *
 * `canonicalJson` is the single source of truth for hashing structured
 * records: key order, undefined handling and number representation are all
 * fixed so an audit chain or an idempotency key computed on one machine
 * verifies on another.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Base64Url(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function hmacSha256Hex(secret: string | Buffer, value: string | Buffer): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Deterministic JSON: sorted object keys, no whitespace, explicit nulls. */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set(), 0);
}

function serialize(value: unknown, seen: Set<object>, depth: number): string {
  if (depth > 64) throw new TypeError('canonicalJson exceeded the maximum nesting depth.');
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    if (!Number.isFinite(value as number)) throw new TypeError('canonicalJson cannot encode non-finite numbers.');
    return JSON.stringify(value);
  }
  if (type === 'bigint') return JSON.stringify((value as bigint).toString());
  if (type === 'undefined') return 'null';
  if (type === 'object') {
    const object = value as object;
    if (seen.has(object)) throw new TypeError('canonicalJson cannot encode cyclic structures.');
    seen.add(object);
    try {
      if (Array.isArray(object)) {
        return `[${object.map((item) => serialize(item, seen, depth + 1)).join(',')}]`;
      }
      if (object instanceof Date) return JSON.stringify(object.toISOString());
      if (Buffer.isBuffer(object)) return JSON.stringify(object.toString('base64'));
      const record = object as Record<string, unknown>;
      const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key], seen, depth + 1)}`).join(',')}}`;
    } finally {
      seen.delete(object);
    }
  }
  throw new TypeError(`canonicalJson cannot encode a value of type ${type}.`);
}

/** Stable content hash for structured data. */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
