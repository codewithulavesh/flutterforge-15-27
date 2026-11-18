/**
 * Strict schema validation for agent JSON output — see below for the approach.
 * This header describes the intent; the walker below is the only implementation.
 */

export type SchemaNode =
  | { kind: 'string'; min?: number; max?: number; enum?: string[] }
  | { kind: 'number'; min?: number; max?: number; int?: boolean }
  | { kind: 'boolean' }
  | { kind: 'array'; items: SchemaNode; min?: number; max?: number }
  | { kind: 'elements'; items: Array<SchemaNode> } // fixed tuple
  | { kind: 'object'; shape: Record<string, SchemaNode> }
  | { kind: 'record'; values: SchemaNode }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'union'; options: SchemaNode[] };

export const s = {
  string: (min = 0, max = 10000): SchemaNode => ({ kind: 'string', min, max }),
  strEnum: (...values: string[]): SchemaNode => ({ kind: 'string', enum: values }),
  number: (min = -1e15, max = 1e15, int = false): SchemaNode => ({ kind: 'number', min, max, int }),
  int: (min = -1e9, max = 1e9): SchemaNode => ({ kind: 'number', min, max, int: true }),
  boolean: (): SchemaNode => ({ kind: 'boolean' }),
  array: (items: SchemaNode, min = 0, max = 100): SchemaNode => ({ kind: 'array', items, min, max }),
  strings: (min = 0, max = 200): SchemaNode => ({ kind: 'array', items: { kind: 'string' }, min, max }),
  strEnumArray: (values: string[], min = 0, max = 50): SchemaNode => ({ kind: 'array', items: { kind: 'string', enum: values }, min, max }),
  object: (shape: Record<string, SchemaNode>): SchemaNode => ({ kind: 'object', shape }),
  record: (values: SchemaNode = { kind: 'string' }): SchemaNode => ({ kind: 'record', values }),
  literal: (value: string | number | boolean): SchemaNode => ({ kind: 'literal', value }),
  union: (...options: SchemaNode[]): SchemaNode => ({ kind: 'union', options }),
};

export interface ValidationSuccess<T = unknown> {
  ok: true;
  value: T;
  /** Warnings: coerced values worth knowing about, but non-fatal. */
  warnings: string[];
}
export interface ValidationFailure {
  ok: false;
  errors: string[];
}
export type ValidationResult<T = unknown> = ValidationSuccess<T> | ValidationFailure;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 || value === 0 ? Boolean(value) : undefined;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'on'].includes(normalized)) return true;
    if (['false', 'no', 'n', '0', 'off'].includes(normalized)) return false;
  }
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim().replace(/,/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function coerce(node: SchemaNode, value: unknown): unknown {
  if (node.kind === 'array' && !Array.isArray(value) && value != null) return [value];
  if (node.kind === 'boolean' && typeof value === 'string') return toBoolean(value) ?? value;
  if (node.kind === 'number' && typeof value === 'string') return toNumber(value) ?? value;
  if (node.kind === 'string' && typeof value === 'number') return String(value);
  return value;
}

function walkCoerced(
  node: SchemaNode,
  input: unknown,
  path: string,
  warnings: string[],
): { value: unknown; errors: string[] } {
  const errors: string[] = [];
  const push = (message: string) => errors.push(`${path}: ${message}`);

  const coerceHere = coerce(node, input);

  switch (node.kind) {
    case 'string': {
      const v = typeof coerceHere === 'string' ? coerceHere.trim() : String(coerceHere ?? '');
      if (typeof coerceHere !== 'string' && coerceHere !== undefined) warnings.push(`${path}: coerced ${typeof coerceHere} to string`);
      if (node.min !== undefined && v.length < node.min) push(`string shorter than ${node.min} chars (got ${v.length})`);
      if (node.max !== undefined && v.length > node.max) push(`string longer than ${node.max} chars (got ${v.length})`);
      if (node.enum) {
        const match = node.enum.find((e) => e.toLowerCase() === v.toLowerCase());
        if (match) return { value: match, errors };
        push(`expected one of [${node.enum.join(', ')}], got "${v}"`);
      }
      return { value: v, errors };
    }
    case 'number': {
      const num = toNumber(coerceHere);
      if (num === undefined) { push(`expected number, got ${typeof input}`); return { value: input, errors }; }
      if (typeof coerceHere === 'string') warnings.push(`${path}: coerced numeric string to number`);
      if (node.int && !Number.isInteger(num)) push(`expected integer, got ${num}`);
      if (node.min !== undefined && num < node.min!) push(`below minimum ${node.min} (got ${num})`);
      if (node.max !== undefined && num > node.max!) push(`above maximum ${node.max} (got ${num})`);
      return { value: num, errors };
    }
    case 'boolean': {
      const bool = toBoolean(coerceHere);
      if (bool === undefined) { push(`expected boolean, got ${typeof input}`); return { value: input, errors }; }
      if (typeof coerceHere === 'string') warnings.push(`${path}: coerced "${coerceHere}" to boolean`);
      return { value: bool, errors };
    }
    case 'array': {
      const arr = Array.isArray(coerceHere) ? coerceHere : [coerceHere];
      if (!Array.isArray(coerceHere) && coerceHere != null) warnings.push(`${path}: wrapped single value in an array`);
      if (arr.length < (node.min ?? 0)) push(`expected at least ${node.min} items, got ${arr.length}`);
      if (node.max !== undefined && arr.length > node.max) push(`expected at most ${node.max} items, got ${arr.length}`);
      const items = arr.map((item, i) => walkCoerced(node.items, item, `${path}[${i}]`, warnings));
      return { value: items.map((r) => r.value), errors: [...errors, ...items.flatMap((r) => r.errors)] };
    }
    case 'elements': {
      const arr = Array.isArray(coerceHere) ? coerceHere : [coerceHere];
      if (arr.length !== node.items.length) push(`expected tuple of length ${node.items.length}, got ${arr.length}`);
      const items = node.items.map((child, i) => walkCoerced(child, arr[i], `${path}[${i}]`, warnings));
      return { value: items.map((r) => r.value), errors: [...errors, ...items.flatMap((r) => r.errors)] };
    }
    case 'object': {
      if (!isPlainObject(coerceHere)) { push(`expected object, got ${Array.isArray(coerceHere) ? 'array' : typeof coerceHere}`); return { value: input, errors }; }
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.shape)) {
        if (key in coerceHere) {
          const res = walkCoerced(child, (coerceHere as Record<string, unknown>)[key], `${path}.${key}`, warnings);
          out[key] = res.value;
          errors.push(...res.errors);
        } else {
          errors.push(`${path}.${key}: missing required key`);
        }
      }
      return { value: out, errors };
    }
    case 'record': {
      if (!isPlainObject(coerceHere)) { push(`expected record, got ${typeof coerceHere}`); return { value: input, errors }; }
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(coerceHere as Record<string, unknown>)) {
        const res = walkCoerced(node.values, child, `${path}.${key}`, warnings);
        out[key] = res.value;
        errors.push(...res.errors);
      }
      return { value: out, errors };
    }
    case 'literal': {
      if (coerceHere !== node.value) push(`expected ${JSON.stringify(node.value)}, got ${JSON.stringify(coerceHere)}`);
      return { value: coerceHere, errors };
    }
    case 'union': {
      for (const option of node.options) {
        const res = walkCoerced(option, coerceHere, path, warnings);
        if (res.errors.length === 0) return res;
      }
      push('does not match any allowed shape');
      return { value: input, errors };
    }
  }
}

/** Validate unknown JSON against a schema. Returns ok:true with the coerced value. */
export function validate<T>(node: SchemaNode, input: unknown): ValidationResult<T> {
  const warnings: string[] = [];
  const combined = walkCoerced(node, input, '$', warnings);
  if (combined.errors.length > 0) return { ok: false, errors: combined.errors };
  return { ok: true, value: combined.value as T, warnings };
}

export function assertValid<T>(node: SchemaNode, input: unknown, schemaName = 'output'): T {
  const result = validate<T>(node, input);
  if (!result.ok) {
    throw new Error(
      `${schemaName} failed schema validation (${result.errors.length} problem${result.errors.length === 1 ? '' : 's'}):\n- ${result.errors.slice(0, 6).join('\n- ')}`,
    );
  }
  return result.value;
}
