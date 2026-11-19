/**
 * Tests for the hardened OpenRouter LLM client.
 *
 * Strategy: global fetch is stubbed with vi.fn; the key pool and credits store
 * are module-mocked so no real network, env keys, or ledger writes ever happen.
 * Backoff is observed through an injected `sleepFn` (the client's sleep seam),
 * which keeps the suite deterministic without fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentSchemaError,
  AGENT_MODELS,
  AGENT_ROLES,
  callLLM,
  callLLMJsonStrict,
  callLLMText,
  ContextTooLargeError,
  extractJsonObject,
  LLMResponseError,
  LLMTimeoutError,
  parseFilesFromLLMOutput,
  type LLMMessage,
} from './llmClient';
import { validate, s } from './schema';

const mocks = vi.hoisted(() => ({
  getNextKey: vi.fn(),
  getAllKeys: vi.fn(),
  markSuccess: vi.fn(),
  markFailure: vi.fn(),
  spend: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('../agent/keyPool', () => ({
  keyPool: {
    getNextKey: mocks.getNextKey,
    getAllKeys: mocks.getAllKeys,
    markSuccess: mocks.markSuccess,
    markFailure: mocks.markFailure,
  },
}));

vi.mock('../stores/credits.store', () => ({
  useCreditsStore: {
    getState: () => ({
      wallet: null,
      events: [],
      loading: false,
      error: null,
      spending: false,
      refresh: mocks.refresh,
      loadEvents: vi.fn(async () => {}),
      spend: mocks.spend,
      creditPlan: vi.fn(async () => ({ ok: true })),
    }),
  },
}));

const MESSAGES: LLMMessage[] = [{ role: 'user', content: 'Say hello' }];
const NO_FALLBACK = { model: 'test/model', allowFallback: false } as const;

function instantSleep() {
  return vi.fn(async (_ms: number) => {});
}

function okResponse(
  content: string,
  usage: { prompt_tokens: number; completion_tokens: number } = { prompt_tokens: 321, completion_tokens: 123 },
  model = 'mock/model-from-api',
): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], model, usage }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  // .env.local ships real VITE_OPENROUTER_API_KEY* values into import.meta.env —
  // blank them so candidate-key selection is fully deterministic.
  vi.stubEnv('VITE_OPENROUTER_API_KEY', '');
  vi.stubEnv('VITE_OPENROUTER_API_KEYS', '');
  mocks.getNextKey.mockReset().mockReturnValue('mock-key');
  mocks.getAllKeys.mockReset().mockReturnValue([]);
  mocks.markSuccess.mockReset();
  mocks.markFailure.mockReset();
  mocks.spend.mockReset().mockResolvedValue({ ok: true, balance: 42 });
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('callLLM — retry policy', () => {
  it('retries 429 with exponential backoff and succeeds on the 3rd attempt', async () => {
    const sleepFn = instantSleep();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, 'Rate limit exceeded'))
      .mockResolvedValueOnce(errorResponse(429, 'Rate limit exceeded'))
      .mockResolvedValueOnce(okResponse('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await callLLM(MESSAGES, { ...NO_FALLBACK, sleepFn });

    expect(response.content).toBe('{"ok":true}');
    expect(response.model).toBe('mock/model-from-api');
    expect(response.tokens).toEqual({ prompt: 321, completion: 123 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    const [first, second] = sleepFn.mock.calls.map((call) => call[0]);
    // 250ms base and 500ms second step, ±25% jitter.
    expect(first).toBeGreaterThanOrEqual(187);
    expect(first).toBeLessThanOrEqual(313);
    expect(second).toBeGreaterThanOrEqual(375);
    expect(second).toBeLessThanOrEqual(625);
    expect(second).toBeGreaterThan(first);
    // Metering happens exactly once, only after the confirmed success.
    expect(mocks.spend).toHaveBeenCalledTimes(1);
    expect(mocks.markSuccess).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx responses as well', async () => {
    const sleepFn = instantSleep();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(500, 'upstream exploded'))
      .mockResolvedValueOnce(okResponse('recovered'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await callLLM(MESSAGES, { ...NO_FALLBACK, sleepFn });
    expect(response.content).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  it('gives up after 3 attempts on persistent 429, never meters, marks the key failed', async () => {
    const sleepFn = instantSleep();
    const fetchMock = vi.fn().mockImplementation(async () => errorResponse(429, 'Rate limit exceeded'));
    vi.stubGlobal('fetch', fetchMock);

    const failure = await callLLM(MESSAGES, { ...NO_FALLBACK, sleepFn }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(LLMResponseError);
    expect((failure as LLMResponseError).status).toBe(429);
    expect((failure as LLMResponseError).message).toContain('429');
    expect((failure as LLMResponseError).message).toContain('after 3 attempts');
    // Never leaks the raw key into error messages.
    expect((failure as LLMResponseError).message).not.toContain('mock-key');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mocks.spend).not.toHaveBeenCalled();
    expect(mocks.markFailure).toHaveBeenCalledTimes(1);
    expect(String(mocks.markFailure.mock.calls[0][1])).toContain('429');
    expect(String(mocks.markFailure.mock.calls[0][1])).not.toContain('mock-key');
  });

  it('401 → markFailure, NO retries with the same key, moves to the next key', async () => {
    mocks.getAllKeys.mockReturnValue(['sk-second-key-abcdef123456']);
    const sleepFn = instantSleep();
    const fetchMock = vi.fn().mockImplementation(async () => errorResponse(401, 'Invalid API key'));
    vi.stubGlobal('fetch', fetchMock);

    const failure = await callLLM(MESSAGES, { ...NO_FALLBACK, sleepFn }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(LLMResponseError);
    expect((failure as LLMResponseError).status).toBe(401);
    // One attempt per key — no same-key retries.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.markFailure).toHaveBeenCalledTimes(2);
    expect(mocks.markFailure.mock.calls.map((c) => c[0])).toEqual(['mock-key', 'sk-second-key-abcdef123456']);
    expect(String(mocks.markFailure.mock.calls[0][1])).not.toContain('mock-key');
    expect(String(mocks.markFailure.mock.calls[1][1])).not.toContain('sk-second-key-abcdef123456');
    expect(sleepFn).not.toHaveBeenCalled();
    expect(mocks.spend).not.toHaveBeenCalled();
  });

  it('402 → immediate failure, meterLlmCall NOT called', async () => {
    const sleepFn = instantSleep();
    const fetchMock = vi.fn().mockImplementation(async () => errorResponse(402, 'Insufficient credits'));
    vi.stubGlobal('fetch', fetchMock);

    const failure = await callLLM(MESSAGES, { ...NO_FALLBACK, sleepFn }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(LLMResponseError);
    expect((failure as LLMResponseError).status).toBe(402);
    expect((failure as LLMResponseError).bodySummary).toContain('Insufficient credits');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.markFailure).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
    expect(mocks.spend).not.toHaveBeenCalled();
  });

  it('400 → no retry at all, key not marked failed (model problem, not key problem)', async () => {
    const sleepFn = instantSleep();
    const fetchMock = vi.fn().mockImplementation(async () => errorResponse(400, 'Bad request'));
    vi.stubGlobal('fetch', fetchMock);

    const failure = await callLLM(MESSAGES, { ...NO_FALLBACK, sleepFn }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(LLMResponseError);
    expect((failure as LLMResponseError).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.markFailure).not.toHaveBeenCalled();
    expect(sleepFn).not.toHaveBeenCalled();
    expect(mocks.spend).not.toHaveBeenCalled();
  });

  it('404 → no retry at all, key not marked failed', async () => {
    const sleepFn = instantSleep();
    const fetchMock = vi.fn().mockImplementation(async () => errorResponse(404, 'Model not found'));
    vi.stubGlobal('fetch', fetchMock);

    const failure = await callLLM(MESSAGES, { ...NO_FALLBACK, sleepFn }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(LLMResponseError);
    expect((failure as LLMResponseError).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.markFailure).not.toHaveBeenCalled();
    expect(sleepFn).not.toHaveBeenCalled();
  });
});

describe('callLLM — timeout', () => {
  it('throws LLMTimeoutError when fetch never resolves (1s budget = clamp floor)', async () => {
    const sleepFn = instantSleep();
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);

    const failure = await callLLM(MESSAGES, { ...NO_FALLBACK, timeoutMs: 1_000, sleepFn }).catch(
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(LLMTimeoutError);
    expect((failure as LLMTimeoutError).name).toBe('LLMTimeoutError');
    expect((failure as LLMTimeoutError).timeoutMs).toBe(1_000);
    expect((failure as LLMTimeoutError).message).toContain('test/model');
    expect((failure as LLMTimeoutError).message).not.toContain('mock-key');
    // Retried up to the per-(model, key) attempt cap, then gave up.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mocks.spend).not.toHaveBeenCalled();
  });

  it('streaming path aborts the underlying request on timeout', async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_input: unknown, init?: { signal?: AbortSignal }) => {
      capturedSignal = init?.signal;
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);

    const failure = await callLLM(MESSAGES, {
      ...NO_FALLBACK,
      timeoutMs: 1_000, // clamp floor
      onToken: () => {},
    }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(LLMTimeoutError);
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
    expect(mocks.spend).not.toHaveBeenCalled();
  });

  it('clamping: a timeoutMs below the 1s floor is raised, not trusted', async () => {
    // 5ms would spin the CPU — the client clamps to 1_000ms. The fetch resolves
    // immediately here, so the clamp never delays this test.
    const fetchMock = vi.fn().mockResolvedValue(okResponse('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const response = await callLLM(MESSAGES, { ...NO_FALLBACK, timeoutMs: 5 });
    expect(response.content).toBe('ok');
  });
});

describe('callLLM — request-size guard', () => {
  it('rejects prompts whose estimate exceeds 120k tokens before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const big = 'x'.repeat(480_000); // (480_000 + len("user")) / 4 = 120_001 tokens

    const failure = await callLLM([{ role: 'user', content: big }], { ...NO_FALLBACK }).catch(
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(ContextTooLargeError);
    expect((failure as ContextTooLargeError).estimatedTokens).toBe(120_001);
    expect((failure as ContextTooLargeError).limit).toBe(120_000);
    expect((failure as ContextTooLargeError).message).toContain('120001');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty messages array before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const failure = await callLLM([], { ...NO_FALLBACK }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ContextTooLargeError);
    expect((failure as ContextTooLargeError).message).toMatch(/empty/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('callLLM — happy path & metering invariant', () => {
  it('returns content, maps token usage, and meters exactly once (non-streaming)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('hello world', { prompt_tokens: 512, completion_tokens: 256 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await callLLM(MESSAGES, NO_FALLBACK);
    expect(response.content).toBe('hello world');
    expect(response.model).toBe('mock/model-from-api'); // provider-reported model wins
    expect(response.tokens).toEqual({ prompt: 512, completion: 256 });
    expect(mocks.spend).toHaveBeenCalledTimes(1);
    const [weight, kind] = mocks.spend.mock.calls[0] as [number, string];
    expect(weight).toBe(1);
    expect(kind).toBe('llm_call');
    expect(mocks.markSuccess).toHaveBeenCalledWith('mock-key');
  });

  it('metering never throws into the caller — spend rejection is swallowed', async () => {
    mocks.spend.mockRejectedValue(new Error('ledger unavailable'));
    const fetchMock = vi.fn().mockResolvedValue(okResponse('still works'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await callLLM(MESSAGES, NO_FALLBACK);
    expect(response.content).toBe('still works');
  });

  it('streaming success does NOT meter (no usage payload on SSE)', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' +
      'data: [DONE]\n\n';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const tokens: string[] = [];
    const text = await callLLMText(MESSAGES, {
      ...NO_FALLBACK,
      onToken: (t) => tokens.push(t),
    });
    expect(text).toBe('hello');
    expect(tokens).toEqual(['he', 'llo']);
    expect(mocks.spend).not.toHaveBeenCalled();
  });
});

describe('parseFilesFromLLMOutput', () => {
  it('round-trips a fenced multi-file answer', () => {
    const raw = [
      '// FILE: lib/main.dart',
      '```dart',
      'void main() {',
      "  runApp(const MyApp());",
      '}',
      '```',
      '',
      '// FILE: pubspec.yaml',
      '```yaml',
      'name: demo_app',
      'dependencies:',
      '  flutter:',
      '    sdk: flutter',
      '```',
    ].join('\n');

    const files = parseFilesFromLLMOutput(raw);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      path: 'lib/main.dart',
      language: 'dart',
    });
    expect(files[0].content).toContain('runApp');
    expect(files[1]).toMatchObject({ path: 'pubspec.yaml', language: 'yaml' });
    expect(files[1].content).toContain('demo_app');
  });
});

describe('extractJsonObject', () => {
  it('parses fenced JSON', () => {
    expect(extractJsonObject('```json\n{"a": 1, "b": {"c": 2}}\n```')).toEqual({ a: 1, b: { c: 2 } });
  });

  it('parses JSON preceded by leading prose', () => {
    expect(extractJsonObject('Here is the object you asked for:\n{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses nested braces with trailing prose', () => {
    const raw = '{"a": {"b": {"c": [1, 2, {"d": true}]}}, "e": "f"} — done, hope that helps!';
    expect(extractJsonObject(raw)).toEqual({ a: { b: { c: [1, 2, { d: true }] } }, e: 'f' });
  });

  it('throws a descriptive error when no JSON object is present', () => {
    expect(() => extractJsonObject('no json here at all')).toThrow(/Failed to parse LLM JSON output/);
  });
});

describe('callLLMJsonStrict', () => {
  it('throws AgentSchemaError when both the attempt and the corrective retry are invalid', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => okResponse('definitely not json'));
    vi.stubGlobal('fetch', fetchMock);

    const promise = callLLMJsonStrict(
      MESSAGES,
      (data) => validate(s.object({ appName: s.string(1) }), data),
      NO_FALLBACK,
    );
    await expect(promise).rejects.toBeInstanceOf(AgentSchemaError);
    await expect(promise).rejects.toMatchObject({ name: 'AgentSchemaError' });
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + exactly one corrective round-trip
    // Each of those was a confirmed HTTP-200 non-streaming response → metered.
    expect(mocks.spend).toHaveBeenCalledTimes(2);
  });
});

describe('exports & configuration sanity', () => {
  it('keeps the public model tiers intact', () => {
    expect(AGENT_MODELS.frontier.length).toBeGreaterThan(0);
    expect(AGENT_MODELS.economy.length).toBeGreaterThan(0);
    expect(AGENT_ROLES['frontend-builder']).toBe('frontier');
  });
});
