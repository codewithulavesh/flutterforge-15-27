import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLlmProvider,
  LlmProviderError,
  type LlmProvider,
} from '../../platform/ai/index.js';

const SECRET = 'sk-or-v1-test-secret-key-123456';

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

type FetchHandler = (call: CapturedCall, index: number) => Response | Promise<Response>;

function makeFetch(handler: FetchHandler) {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: CapturedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    headers,
    json: async () => payload,
    text: async () => text,
  } as unknown as Response;
}

function textResponse(
  text: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    headers,
    json: async () => {
      throw new SyntaxError('no json body');
    },
    text: async () => text,
  } as unknown as Response;
}

function completionResponse(
  content = 'generated text',
  model = 'response-model',
  promptTokens = 11,
  completionTokens = 7,
): Response {
  return jsonResponse({
    model,
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  });
}

function providerError(code: string, extra?: (error: LlmProviderError) => void) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof LlmProviderError, `expected LlmProviderError, got ${String(error)}`);
    assert.equal(error.code, code);
    extra?.(error);
    return true;
  };
}

function create(options: Parameters<typeof createLlmProvider>[0] = {}): LlmProvider {
  return createLlmProvider(options);
}

/* ------------------------------------------------------------------ */
/* Availability and configuration                                      */
/* ------------------------------------------------------------------ */

test('unavailable provider reports available=false and throws LLM_UNAVAILABLE without fetching', async () => {
  const { calls, fetchImpl } = makeFetch(() => completionResponse());
  const provider = create({ env: {}, fetchImpl });

  assert.equal(provider.available, false);
  assert.equal(provider.name, 'openrouter');
  assert.equal(provider.model, 'nvidia/nemotron-3.5-lightning:free');

  await assert.rejects(
    () => provider.complete({ system: 's', user: 'u' }),
    providerError('LLM_UNAVAILABLE', (error) => {
      assert.equal(error.retryable, false);
      assert.match(error.message, /openrouter/);
    }),
  );
  assert.equal(calls.length, 0);
});

test('auto-selects deepseek from DEEPSEEK_API_KEY and uses its endpoint/model', async () => {
  const { calls, fetchImpl } = makeFetch(() => completionResponse('deepseek answer', 'deepseek-chat'));
  const provider = create({
    env: { DEEPSEEK_API_KEY: 'sk-ds-test-key' },
    fetchImpl,
  });

  assert.equal(provider.name, 'deepseek');
  assert.equal(provider.model, 'deepseek-chat');
  assert.equal(provider.available, true);

  // `LlmProvider extends LlmComplete`: the provider is directly callable and
  // `.complete` is an alias for the same operation.
  assert.equal(provider.complete, provider);
  const result = await provider({ system: 's', user: 'u' });
  assert.equal(result.text, 'deepseek answer');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(JSON.parse(calls[0].body).model, 'deepseek-chat');
  // OpenRouter-only attribution headers must not leak to other providers.
  assert.equal(calls[0].headers['HTTP-Referer'], undefined);
  assert.equal(calls[0].headers['X-Title'], undefined);
});

test('openai provider uses the generic key, custom base URL and model override', async () => {
  const { calls, fetchImpl } = makeFetch(() => completionResponse());
  const provider = create({
    env: {
      FLUTTERFORGE_LLM_PROVIDER: 'openai',
      FLUTTERFORGE_LLM_API_KEY: 'sk-generic-test-key',
      FLUTTERFORGE_LLM_BASE_URL: 'https://llm.example.test/v1/chat/completions',
      FLUTTERFORGE_LLM_MODEL: 'custom-model',
    },
    fetchImpl,
  });

  assert.equal(provider.name, 'openai-compatible');
  assert.equal(provider.model, 'custom-model');
  assert.equal(provider.available, true);

  await provider.complete({ system: 's', user: 'u' });
  assert.equal(calls[0].url, 'https://llm.example.test/v1/chat/completions');
  assert.equal(JSON.parse(calls[0].body).model, 'custom-model');
});

test('OPENAI_BASE_URL is treated as a base URL and expanded to /chat/completions', async () => {
  const { calls, fetchImpl } = makeFetch(() => completionResponse());
  const provider = create({
    env: {
      FLUTTERFORGE_LLM_PROVIDER: 'openai',
      FLUTTERFORGE_LLM_API_KEY: 'sk-generic-test-key',
      OPENAI_BASE_URL: 'https://openai-compatible.example.test/v1/',
      FLUTTERFORGE_LLM_MODEL: 'house-model',
    },
    fetchImpl,
  });

  await provider.complete({ system: 's', user: 'u' });
  assert.equal(calls[0].url, 'https://openai-compatible.example.test/v1/chat/completions');
});

/* ------------------------------------------------------------------ */
/* Successful calls and metering                                       */
/* ------------------------------------------------------------------ */

test('success returns text/model/usage and records usage exactly once with token counts', async () => {
  const { calls, fetchImpl } = makeFetch(() => completionResponse('hello world', 'response-model', 11, 7));
  const recorded: Array<Record<string, unknown>> = [];
  const provider = create({
    env: { OPENROUTER_API_KEY: SECRET },
    fetchImpl,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    usage: {
      record: (input) => {
        recorded.push(input as unknown as Record<string, unknown>);
      },
    },
  });

  const result = await provider.complete({
    system: 'system prompt',
    user: 'user prompt',
    label: 'generation.spec',
  });

  assert.deepEqual(result, {
    text: 'hello world',
    model: 'response-model',
    usage: { promptTokens: 11, completionTokens: 7 },
  });

  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    provider: 'openrouter',
    model: 'response-model',
    promptTokens: 11,
    completionTokens: 7,
    label: 'generation.spec',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.equal(calls[0].headers['HTTP-Referer'], 'https://flutterforge.app');
  assert.equal(calls[0].headers['X-Title'], 'FlutterForge');

  const body = JSON.parse(calls[0].body);
  assert.equal(body.model, 'nvidia/nemotron-3.5-lightning:free');
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'user prompt' },
  ]);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.response_format, undefined);
});

test('json mode sets response_format and explicit generation options are forwarded', async () => {
  const { calls, fetchImpl } = makeFetch(() => completionResponse('{"ok":true}'));
  const provider = create({ env: { OPENROUTER_API_KEY: SECRET }, fetchImpl });

  await provider.complete({
    system: 's',
    user: 'u',
    json: true,
    temperature: 0.7,
    maxTokens: 512,
  });

  const body = JSON.parse(calls[0].body);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.temperature, 0.7);
  assert.equal(body.max_tokens, 512);
});

test('usage sink failures never fail generation (sync and async throws)', async () => {
  const { fetchImpl } = makeFetch(() => completionResponse('survives'));

  const syncThrower = create({
    env: { OPENROUTER_API_KEY: SECRET },
    fetchImpl,
    usage: {
      record: () => {
        throw new Error('metering store offline');
      },
    },
  });
  assert.equal((await syncThrower.complete({ system: 's', user: 'u' })).text, 'survives');

  const asyncThrower = create({
    env: { OPENROUTER_API_KEY: SECRET },
    fetchImpl,
    usage: {
      record: async () => {
        throw new Error('metering store offline');
      },
    },
  });
  assert.equal((await asyncThrower.complete({ system: 's', user: 'u' })).text, 'survives');
});

/* ------------------------------------------------------------------ */
/* Retries, timeouts and errors                                        */
/* ------------------------------------------------------------------ */

test('429 then success retries, honours Retry-After and sleeps between attempts', async () => {
  const { calls, fetchImpl } = makeFetch((_, index) => index === 0
    ? textResponse('{"error":{"message":"rate limited"}}', 429, { 'retry-after': '2' })
    : completionResponse('after retry'));
  const sleeps: number[] = [];
  const provider = create({
    env: { OPENROUTER_API_KEY: SECRET },
    fetchImpl,
    maxAttempts: 3,
    now: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const result = await provider.complete({ system: 's', user: 'u' });
  assert.equal(result.text, 'after retry');
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
});

test('429 without Retry-After uses 300ms exponential backoff with deterministic jitter', async () => {
  const { fetchImpl } = makeFetch((_, index) => index === 0
    ? textResponse('rate limited', 429)
    : completionResponse('recovered'));
  const sleeps: number[] = [];
  const provider = create({
    env: { OPENROUTER_API_KEY: SECRET },
    fetchImpl,
    maxAttempts: 3,
    now: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal((await provider.complete({ system: 's', user: 'u' })).text, 'recovered');
  assert.deepEqual(sleeps, [300]);
});

test('Retry-After delays are capped at 10 seconds', async () => {
  const { fetchImpl } = makeFetch((_, index) => index === 0
    ? textResponse('rate limited', 429, { 'retry-after': '9999' })
    : completionResponse('recovered'));
  const sleeps: number[] = [];
  const provider = create({
    env: { OPENROUTER_API_KEY: SECRET },
    fetchImpl,
    maxAttempts: 3,
    now: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal((await provider.complete({ system: 's', user: 'u' })).text, 'recovered');
  assert.deepEqual(sleeps, [10_000]);
});

test('exhausting maxAttempts throws the last retryable provider error', async () => {
  const { calls, fetchImpl } = makeFetch(() => textResponse('upstream exploded', 500));
  const sleeps: number[] = [];
  const provider = create({
    env: { OPENROUTER_API_KEY: SECRET },
    fetchImpl,
    maxAttempts: 3,
    now: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  await assert.rejects(
    () => provider.complete({ system: 's', user: 'u' }),
    providerError('LLM_UNAVAILABLE', (error) => {
      assert.equal(error.status, 500);
      assert.equal(error.retryable, true);
      assert.match(error.message, /openrouter/);
      assert.match(error.message, /500/);
    }),
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [300, 600]);
});

test('network failures are retried', async () => {
  const { calls, fetchImpl } = makeFetch((_, index) => {
    if (index === 0) return Promise.reject(new TypeError('fetch failed'));
    return completionResponse('network recovered');
  });
  const sleeps: number[] = [];
  const provider = create({
    env: { OPENROUTER_API_KEY: SECRET },
    fetchImpl,
    maxAttempts: 3,
    now: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const result = await provider.complete({ system: 's', user: 'u' });
  assert.equal(result.text, 'network recovered');
  assert.equal(calls.length, 2);
  assert.equal(sleeps.length, 1);
});

test('401 does not retry, is not retryable and redacts the API key', async () => {
  const { calls, fetchImpl } = makeFetch(() => textResponse(
    `{"error":{"message":"invalid key ${SECRET}"}}`,
    401,
  ));
  const sleeps: number[] = [];
  const provider = create({
    env: { OPENROUTER_API_KEY: SECRET },
    fetchImpl,
    maxAttempts: 3,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  await assert.rejects(
    () => provider.complete({ system: 's', user: 'u' }),
    providerError('LLM_BAD_REQUEST', (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.retryable, false);
      assert.match(error.message, /openrouter/);
      assert.match(error.message, /401/);
      assert.ok(error.message.includes('sk-***'), error.message);
      assert.ok(!error.message.includes(SECRET), error.message);
    }),
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('timeout path aborts a hanging fetch and throws LLM_TIMEOUT', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, fetchImpl } = makeFetch(() => new Promise<Response>(() => {}));
  const provider = create({
    env: { OPENROUTER_API_KEY: SECRET },
    fetchImpl,
    maxAttempts: 1,
  });

  // The contract clamps small timeouts up to 1s; advance the mocked clock
  // instead of waiting on a real timer.
  const pending = provider.complete({ system: 's', user: 'u', timeoutMs: 5 });
  const assertion = assert.rejects(
    pending,
    providerError('LLM_TIMEOUT', (error) => {
      assert.equal(error.retryable, true);
      assert.match(error.message, /openrouter/);
    }),
  );
  t.mock.timers.tick(1000);
  await assertion;
  assert.equal(calls.length, 1);
});

test('malformed JSON and empty choices throw LLM_BAD_RESPONSE', async () => {
  const malformedJsonFetch = makeFetch(() => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {},
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
    text: async () => '<html>not json</html>',
  } as unknown as Response));
  const malformed = create({
    env: { OPENROUTER_API_KEY: SECRET },
    fetchImpl: malformedJsonFetch.fetchImpl,
  });
  await assert.rejects(
    () => malformed.complete({ system: 's', user: 'u' }),
    providerError('LLM_BAD_RESPONSE', (error) => {
      assert.equal(error.retryable, false);
      assert.match(error.message, /openrouter/);
      assert.match(error.message, /200/);
    }),
  );

  const emptyChoicesFetch = makeFetch(() => jsonResponse({ model: 'm', choices: [] }));
  const emptyChoices = create({
    env: { OPENROUTER_API_KEY: SECRET },
    fetchImpl: emptyChoicesFetch.fetchImpl,
  });
  await assert.rejects(
    () => emptyChoices.complete({ system: 's', user: 'u' }),
    providerError('LLM_BAD_RESPONSE', (error) => {
      assert.equal(error.retryable, false);
      assert.match(error.message, /no choices/);
    }),
  );

  const emptyContentFetch = makeFetch(() => jsonResponse({
    choices: [{ message: { content: '   ' } }],
  }));
  const emptyContent = create({
    env: { OPENROUTER_API_KEY: SECRET },
    fetchImpl: emptyContentFetch.fetchImpl,
  });
  await assert.rejects(
    () => emptyContent.complete({ system: 's', user: 'u' }),
    providerError('LLM_BAD_RESPONSE', (error) => {
      assert.match(error.message, /content was empty/);
    }),
  );
});

test('error bodies are capped at 300 characters and never expose the key', async () => {
  const longBody = `${SECRET} ${'x'.repeat(500)}`;
  const { fetchImpl } = makeFetch(() => textResponse(longBody, 503));
  const provider = create({
    env: { OPENROUTER_API_KEY: SECRET },
    fetchImpl,
    maxAttempts: 1,
  });

  await assert.rejects(
    () => provider.complete({ system: 's', user: 'u' }),
    providerError('LLM_UNAVAILABLE', (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.retryable, true);
      assert.match(error.message, /openrouter/);
      assert.match(error.message, /503/);
      assert.ok(error.message.includes('sk-***'), error.message);
      assert.ok(!error.message.includes(SECRET), error.message);
      // Prefix + short body summary, never the full 500-character body.
      assert.ok(error.message.length < 360, `message too long: ${error.message.length}`);
    }),
  );
});
