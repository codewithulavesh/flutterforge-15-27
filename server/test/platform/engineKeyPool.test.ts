import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredKeys, ServerKeyPool } from '../../platform/engine/keyPool.js';
import { resolveModelConfig } from '../../platform/engine/model.js';
const url = 'https://provider.example/v1/chat/completions';
const success = () => new Response('stream', { status: 200 });

test('server discovers and deduplicates list, legacy and numbered credentials', () => {
  const env = { OPENROUTER_API_KEYS: 'a,b', VITE_OPENROUTER_API_KEYS: 'b,c', OPENROUTER_API_KEY_2: 'd', DEEPSEEK_API_KEY: 'other' };
  assert.deepEqual(configuredKeys(env, 'openrouter', 'a'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(resolveModelConfig(env)?.apiKeys, ['a', 'b', 'c', 'd']);
});
test('successful requests rotate evenly without modifying successful streams', async () => {
  const seen: string[] = [];
  const request = new ServerKeyPool(['a', 'b']).fetch(async input => { seen.push((input as Request).headers.get('authorization')!); return success(); });
  for (let i = 0; i < 3; i++) assert.equal(await (await request(url)).text(), 'stream');
  assert.deepEqual(seen, ['Bearer a', 'Bearer b', 'Bearer a']);
});
test('429 retries another key with identical body and honors retry-after cooldown', async () => {
  let now = 1000;
  const seen: string[] = []; const bodies: string[] = [];
  const pool = new ServerKeyPool(['a', 'b'], () => now);
  const request = pool.fetch(async input => {
    const req = input as Request; const key = req.headers.get('authorization')!;
    seen.push(key); bodies.push(await req.text());
    return key === 'Bearer a' ? new Response('limited', { status: 429, headers: { 'retry-after': '10' } }) : success();
  });
  assert.equal((await request(url, { method: 'POST', body: '{"prompt":"hi"}' })).status, 200);
  assert.deepEqual(bodies, ['{"prompt":"hi"}', '{"prompt":"hi"}']);
  assert.deepEqual(pool.status(), { total: 2, available: 1 });
  await request(url); assert.deepEqual(seen, ['Bearer a', 'Bearer b', 'Bearer b']);
  now = 11001; assert.equal(pool.status().available, 2);
});
test('exhaustion is bounded, redacted and daily cooldown recovers at UTC reset', async () => {
  let now = 86400000 + 1000; let calls = 0;
  const pool = new ServerKeyPool(['private-a', 'private-b'], () => now);
  const request = pool.fetch(async () => { calls++; return new Response('free-models-per-day private-a', { status: 429 }); });
  const response = await request(url); assert.equal(response.status, 429);
  assert.doesNotMatch(await response.text(), /private-/); assert.equal(calls, 2);
  await request(url); assert.equal(calls, 2);
  now = 2 * 86400000; assert.equal(pool.status().available, 2);
});
test('invalid keys are disabled; cancellation and non-key errors are not rotated', async () => {
  const pool = new ServerKeyPool(['a', 'b']); let calls = 0;
  const request = pool.fetch(async () => { calls++; return new Response('', { status: calls === 1 ? 401 : 400 }); });
  assert.equal((await request(url)).status, 400); assert.equal(calls, 2); assert.equal(pool.status().available, 1);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(request(url, { signal: abort.signal }), { name: 'AbortError' }); assert.equal(calls, 2);
});
test('a failed successful-response stream is not replayed on a different credential', async () => {
  let calls = 0;
  const request = new ServerKeyPool(['a', 'b']).fetch(async () => { calls++; return new Response(new ReadableStream({ start(controller) { controller.error(new Error('broken stream')); } })); });
  const response = await request(url); await assert.rejects(response.text(), /broken stream/); assert.equal(calls, 1);
});
