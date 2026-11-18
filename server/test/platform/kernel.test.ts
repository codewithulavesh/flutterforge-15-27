import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJson,
  contentHash,
  sha256Hex,
  timingSafeEqualString,
} from '../../platform/kernel/hash.js';
import { ulid, prefixedId, parseUlidTime, isPrefixedId } from '../../platform/kernel/ids.js';
import { ManualClock } from '../../platform/kernel/clock.js';
import { withRetry, PlatformError, toErrorBody, statusForError } from '../../platform/kernel/errors.js';
import { redact, redactText, memorySink, createLogger } from '../../platform/kernel/logger.js';

test('ulid is sortable and unique', () => {
  const a = ulid(1700000000000);
  const b = ulid(1700000000001);
  assert.equal(a.length, 26);
  assert.ok(a < b, 'later ULID sorts after earlier one');
  const generated = new Set(Array.from({ length: 5000 }, () => ulid(1700000000000 + Math.floor(Math.random() * 10))));
  assert.ok(generated.size > 4950, `expected high cardinality, got ${generated.size}`);
});

test('prefixedId carries the prefix and parses time', () => {
  const fresh = Date.now() + 100_000; // beyond the in-memory high-water mark
  const id = prefixedId('run', fresh);
  assert.ok(id.startsWith('run_'));
  assert.equal(isPrefixedId(id, 'run'), true);
  assert.equal(isPrefixedId(id, 'apv'), false);
  const time = parseUlidTime(id);
  assert.ok(time !== null && Math.abs(time - fresh) <= 1);
});

test('canonicalJson is stable regardless of key order', () => {
  const left = canonicalJson({ b: 2, a: { d: 4, c: 3 } });
  const right = canonicalJson({ a: { c: 3, d: 4 }, b: 2 });
  assert.equal(left, right);
  assert.equal(canonicalJson([1, 'two', null, true]), '[1,"two",null,true]');
  assert.throws(() => canonicalJson(Number.NaN));
  assert.equal(contentHash({ a: 1 }), sha256Hex('{"a":1}'));
  assert.equal(timingSafeEqualString('abc', 'abc'), true);
  assert.equal(timingSafeEqualString('abc', 'abd'), false);
  assert.equal(timingSafeEqualString('abc', 'abcd'), false);
});

test('redact removes secrets by key and by value, keeps structure', () => {
  const result = redact({
    password: 'hunter2',
    nested: { authorization: 'Bearer abc.def.ghi', note: 'ok' },
    file: 'use sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789abcd',
    list: ['AIza' + 'a'.repeat(35), 'normal'],
    triangle: { jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturebody123' },
  }) as any;
  assert.equal(result.password, '[REDACTED]');
  assert.equal(result.nested.authorization, '[REDACTED]');
  assert.equal(result.nested.note, 'ok');
  assert.equal(result.list[0], '[REDACTED]');
  assert.ok(!result.file.includes('abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!String(result.triangle.jwt).includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
});

test('redactText scrubs connection strings and bearer tokens', () => {
  const text = 'connecting to postgres://user:pass@example.com:5432/db with Bearer abcdefghijklmnop123456';
  const redacted = redactText(text);
  assert.ok(!redacted.includes('pass@example.com'));
  assert.ok(!redacted.includes('abcdefghijklmnop123456'));
});

test('logger emits JSON records through the sink without leaking secrets', () => {
  const records: any[] = [];
  const logger = createLogger({ level: 'info', sink: memorySink(records) });
  logger.info('hello %world', { apiKey: 'sk-test-secret-key-1234567890123', keep: 'visible' });
  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'info');
  assert.equal(records[0].keep, 'visible');
  assert.equal(records[0].apiKey, '[REDACTED]');
});

test('withRetry retries transient errors and respects attempts', async () => {
  let attempts = 0;
  const result = await withRetry(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('connection reset') as NodeJS.ErrnoException;
      error.code = 'ECONNRESET';
      throw error;
    }
    return 'ok';
  }, { attempts: 5, baseDelayMs: 1, maxDelayMs: 4, jitter: false });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);

  let permanent = 0;
  await assert.rejects(
    withRetry(async () => {
      permanent += 1;
      throw new PlatformError({ code: 'FATAL', message: 'nope' });
    }, { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitter: false }),
    /nope/,
  );
  assert.equal(permanent, 1, 'non-retryable errors fail immediately');
});

test('toErrorBody hides internals and carries request id', () => {
  assert.deepEqual(
    toErrorBody(new Error('database exploded with details'), 'req_test'),
    { error: { code: 'INTERNAL', message: 'An internal error occurred.', requestId: 'req_test' } },
  );
  assert.equal(statusForError(new Error('boom')), 500);
  const exposed = toErrorBody(new PlatformError({ code: 'GATE_VALIDATION_FAILED', message: 'blockers', statusCode: 422, details: { count: 3 } }), 'req_x');
  assert.equal(exposed.error.code, 'GATE_VALIDATION_FAILED');
  assert.equal(exposed.error.details?.count, 3);
});

test('ManualClock advances monotonically', () => {
  const clock = new ManualClock(1000);
  assert.equal(clock.now(), 1000);
  clock.advance(50);
  assert.equal(clock.now(), 1050);
  assert.throws(() => clock.advance(-1));
});
