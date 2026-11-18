/**
 * Server-side LLM provider abstraction — the only platform module that talks
 * to a model provider.
 *
 * Why this exists
 * ---------------
 * Generation must never call a provider from the browser: that would expose the
 * API key to the client and make spend impossible to meter or bound. This module
 * owns credential resolution, the OpenAI-compatible wire request, timeouts,
 * bounded retries, response parsing and post-success usage recording. Callers
 * depend only on `LlmComplete` from `generation/contracts.ts`.
 *
 * Supported providers
 * -------------------
 *   openrouter        OPENROUTER_API_KEY (falls back to FLUTTERFORGE_LLM_API_KEY)
 *                     https://openrouter.ai/api/v1/chat/completions
 *   deepseek          DEEPSEEK_API_KEY (falls back to FLUTTERFORGE_LLM_API_KEY)
 *                     https://api.deepseek.com/chat/completions
 *   openai-compatible FLUTTERFORGE_LLM_API_KEY
 *                     FLUTTERFORGE_LLM_BASE_URL or OPENAI_BASE_URL, default
 *                     https://api.openai.com/v1/chat/completions
 *
 * Selection: `FLUTTERFORGE_LLM_PROVIDER` accepts `openrouter`, `deepseek` or
 * `openai`. When unset: openrouter if OPENROUTER_API_KEY is set, else deepseek
 * if DEEPSEEK_API_KEY is set, else openrouter. `FLUTTERFORGE_LLM_MODEL`
 * overrides the per-provider default. Construction NEVER throws and NEVER
 * performs network I/O; a missing key only makes `available` false.
 *
 * Failure semantics
 * -----------------
 * - Timeouts are 90s by default, clamped to [1s, 300s]. The timer aborts the
 *   in-flight fetch; the timed-out attempt is retryable. An abort we did not
 *   cause (a caller/fetch-level AbortError) is NOT retried.
 * - Retries: max 3 attempts by default, exponential backoff
 *   `300ms * 2^n` plus deterministic jitter derived from `now()`.
 *   408/409/425/429/5xx/network/timeout are retryable. 400/401/403/404/422
 *   (and every other non-retryable status) fail immediately. `Retry-After`
 *   seconds override the backoff and are capped at 10s.
 * - Malformed bodies, missing choices and empty content are LLM_BAD_RESPONSE
 *   and are never retried.
 * - Every error message includes the provider (and HTTP status where one
 *   exists) plus a ≤300 character body summary. `sk-...` tokens are redacted to
 *   `sk-***`, and the configured key is scrubbed defensively. Headers are never
 *   embedded in errors or logs.
 * - `usage.record` runs exactly once AFTER a successful parse. Metering errors
 *   are swallowed: a metering outage must never fail a generation.
 */
import type {
  LlmComplete,
  LlmCompletionRequest,
  LlmCompletionResult,
} from '../generation/contracts.js';

export type LlmProviderName = 'openrouter' | 'deepseek' | 'openai-compatible';

export interface UsageSink {
  record(input: {
    tenantId?: string;
    projectId?: string;
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    label?: string;
  }): Promise<void> | void;
}

export interface LlmProvider extends LlmComplete {
  readonly name: LlmProviderName;
  readonly model: string;
  readonly available: boolean;
  /** Alias for calling the provider directly; identical behavior. */
  readonly complete: LlmComplete;
}

export interface CreateLlmProviderOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  usage?: UsageSink;
  tenantId?: string;
  projectId?: string;
  /** Max attempts per request (default 3). */
  maxAttempts?: number;
}

export interface LlmProviderErrorOptions {
  code: string;
  status?: number;
  retryable?: boolean;
  model?: string;
  /** Internal backoff hint parsed from Retry-After (already capped at 10s). */
  retryAfterMs?: number;
  /** Configured credential to scrub from the message. Never stored. */
  secret?: string;
  cause?: unknown;
}

/** A provider call that failed in a typed, key-safe way. */
export class LlmProviderError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly model?: string;
  readonly retryAfterMs?: number;

  constructor(message: string, options: LlmProviderErrorOptions) {
    super(redactSecrets(message, options.secret), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LlmProviderError';
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.model = options.model;
    this.retryAfterMs = options.retryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// Constants and configuration
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 90_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 4096;
const RETRY_BASE_DELAY_MS = 300;
const RETRY_MAX_DELAY_MS = 30_000;
const RETRY_AFTER_CAP_MS = 10_000;
const MAX_BODY_SUMMARY_CHARS = 300;

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

const DEFAULT_MODELS: Readonly<Record<LlmProviderName, string>> = {
  openrouter: 'nvidia/nemotron-3.5-lightning:free',
  deepseek: 'deepseek-chat',
  'openai-compatible': 'gpt-4o-mini',
};

interface ProviderRuntime {
  readonly name: LlmProviderName;
  readonly model: string;
  readonly endpoint: string;
  readonly secret: string;
  readonly maxAttempts: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly fetchImpl: typeof fetch;
}

interface ParsedCompletion {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

interface AttemptResult {
  payload: unknown;
  status: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function resolveProviderName(env: NodeJS.ProcessEnv): LlmProviderName {
  const requested = readEnv(env, 'FLUTTERFORGE_LLM_PROVIDER')?.toLowerCase();
  if (requested === 'openrouter') return 'openrouter';
  if (requested === 'deepseek') return 'deepseek';
  if (requested === 'openai' || requested === 'openai-compatible') return 'openai-compatible';

  // Auto: prefer a native OpenRouter key, then DeepSeek, else OpenRouter.
  if (readEnv(env, 'OPENROUTER_API_KEY')) return 'openrouter';
  if (readEnv(env, 'DEEPSEEK_API_KEY')) return 'deepseek';
  return 'openrouter';
}

function resolveSecret(name: LlmProviderName, env: NodeJS.ProcessEnv): string | undefined {
  const generic = readEnv(env, 'FLUTTERFORGE_LLM_API_KEY');
  if (name === 'openrouter') return readEnv(env, 'OPENROUTER_API_KEY') ?? generic;
  if (name === 'deepseek') return readEnv(env, 'DEEPSEEK_API_KEY') ?? generic;
  return generic;
}

/** Accepts either a full chat-completions URL or an OpenAI-style base URL. */
function toChatCompletionsUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '');
  if (trimmed === '') return OPENAI_ENDPOINT;
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function resolveEndpoint(name: LlmProviderName, env: NodeJS.ProcessEnv): string {
  if (name === 'openrouter') return OPENROUTER_ENDPOINT;
  if (name === 'deepseek') return DEEPSEEK_ENDPOINT;
  const configured = readEnv(env, 'FLUTTERFORGE_LLM_BASE_URL') ?? readEnv(env, 'OPENAI_BASE_URL');
  return configured === undefined ? OPENAI_ENDPOINT : toChatCompletionsUrl(configured);
}

function resolveModel(name: LlmProviderName, env: NodeJS.ProcessEnv): string {
  return readEnv(env, 'FLUTTERFORGE_LLM_MODEL') ?? DEFAULT_MODELS[name];
}

function resolveMaxAttempts(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_ATTEMPTS;
  return Math.max(1, Math.floor(value));
}

function resolveTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

function buildRequestBody(model: string, request: LlmCompletionRequest): Record<string, unknown> {
  const temperature = typeof request.temperature === 'number' && Number.isFinite(request.temperature)
    ? request.temperature
    : DEFAULT_TEMPERATURE;
  const maxTokens = typeof request.maxTokens === 'number' && Number.isFinite(request.maxTokens) && request.maxTokens > 0
    ? Math.floor(request.maxTokens)
    : DEFAULT_MAX_TOKENS;
  return {
    model,
    messages: [
      { role: 'system', content: typeof request.system === 'string' ? request.system : '' },
      { role: 'user', content: typeof request.user === 'string' ? request.user : '' },
    ],
    temperature,
    max_tokens: maxTokens,
    ...(request.json ? { response_format: { type: 'json_object' } } : {}),
  };
}

function buildHeaders(name: LlmProviderName, secret: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
  };
  if (name === 'openrouter') {
    headers['HTTP-Referer'] = 'https://flutterforge.app';
    headers['X-Title'] = 'FlutterForge';
  }
  return headers;
}

function redactSecrets(text: string, secret?: string): string {
  let redacted = text.replace(/sk-[A-Za-z0-9._-]+/g, 'sk-***');
  if (secret !== undefined && secret.length > 0) {
    redacted = redacted.split(secret).join('sk-***');
  }
  return redacted;
}

function summarizeText(text: string, secret?: string): string {
  const compact = redactSecrets(text, secret).replace(/\s+/g, ' ').trim();
  if (compact === '') return '';
  return compact.length <= MAX_BODY_SUMMARY_CHARS
    ? compact
    : `${compact.slice(0, MAX_BODY_SUMMARY_CHARS - 1)}…`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function summarizePayload(payload: unknown, secret?: string): string {
  return summarizeText(typeof payload === 'string' ? payload : safeJson(payload), secret);
}

function describeUnknown(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  return name === 'AbortError' || code === 'ABORT_ERR';
}

function isRetryableStatus(status: number): boolean {
  return status === 408
    || status === 409
    || status === 425
    || status === 429
    || (status >= 500 && status <= 599);
}

function tokenCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    try {
      const value = (getter as (headerName: string) => unknown).call(headers, name);
      if (typeof value === 'string') return value;
    } catch {
      // Fall through to plain-object lookup.
    }
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== target) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  }
  return undefined;
}

function parseRetryAfterMs(headers: unknown): number | undefined {
  const raw = readHeader(headers, 'retry-after');
  if (raw === undefined) return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(RETRY_AFTER_CAP_MS, Math.floor(seconds * 1000));
}

function backoffDelayMs(retryIndex: number, now: () => number): number {
  const base = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** retryIndex);
  const current = now();
  const fraction = Number.isFinite(current) ? (Math.abs(Math.floor(current)) % 1000) / 1000 : 0;
  const jitter = Math.floor(base * 0.25 * fraction);
  return Math.max(1, base + jitter);
}

async function readResponseBody(response: Response): Promise<string> {
  const candidate = response as unknown as { text?: () => Promise<string>; json?: () => Promise<unknown> };
  if (typeof candidate.text === 'function') {
    try {
      return String(await candidate.text());
    } catch {
      // Fall through to json().
    }
  }
  if (typeof candidate.json === 'function') {
    try {
      const payload = await candidate.json();
      return typeof payload === 'string' ? payload : safeJson(payload);
    } catch {
      // No usable body.
    }
  }
  return '';
}

async function readJsonPayload(response: Response): Promise<unknown> {
  const candidate = response as unknown as { json?: () => Promise<unknown>; text?: () => Promise<string> };
  if (typeof candidate.json === 'function') return candidate.json();
  if (typeof candidate.text === 'function') {
    const text = await candidate.text();
    return JSON.parse(text);
  }
  throw new Error('response has neither json() nor text()');
}

// ---------------------------------------------------------------------------
// Error construction
// ---------------------------------------------------------------------------

function timeoutError(runtime: ProviderRuntime, timeoutMs: number, retryable: boolean): LlmProviderError {
  return new LlmProviderError(
    `${runtime.name} request timed out after ${timeoutMs}ms (model ${runtime.model}).`,
    {
      code: 'LLM_TIMEOUT',
      retryable,
      model: runtime.model,
      secret: runtime.secret,
    },
  );
}

function badResponse(
  runtime: ProviderRuntime,
  status: number,
  reason: string,
  payload?: unknown,
): LlmProviderError {
  const summary = payload === undefined ? '' : summarizePayload(payload, runtime.secret);
  return new LlmProviderError(
    `${runtime.name} HTTP ${status}: ${reason}${summary === '' ? '' : ` Body: ${summary}`}`,
    {
      code: 'LLM_BAD_RESPONSE',
      status,
      retryable: false,
      model: runtime.model,
      secret: runtime.secret,
    },
  );
}

function parseCompletion(
  payload: unknown,
  runtime: ProviderRuntime,
  status: number,
): ParsedCompletion {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw badResponse(runtime, status, 'response JSON was not an object.', payload);
  }
  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw badResponse(runtime, status, 'response contained no choices.', payload);
  }
  const first = choices[0];
  const message = first && typeof first === 'object' && !Array.isArray(first)
    ? (first as Record<string, unknown>).message
    : undefined;
  const content = message && typeof message === 'object' && !Array.isArray(message)
    ? (message as Record<string, unknown>).content
    : undefined;
  if (typeof content !== 'string' || content.trim() === '') {
    throw badResponse(runtime, status, 'choices[0].message.content was empty or not a string.', payload);
  }
  const usage = record.usage && typeof record.usage === 'object' && !Array.isArray(record.usage)
    ? record.usage as Record<string, unknown>
    : {};
  const responseModel = typeof record.model === 'string' && record.model.trim() !== ''
    ? record.model.trim()
    : runtime.model;

  return {
    text: content,
    model: responseModel,
    promptTokens: tokenCount(usage.prompt_tokens),
    completionTokens: tokenCount(usage.completion_tokens),
  };
}

// ---------------------------------------------------------------------------
// One attempt + retry loop
// ---------------------------------------------------------------------------

async function performAttempt(
  runtime: ProviderRuntime,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<AttemptResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();

  try {
    let response: Response;
    try {
      const fetchPromise = Promise.resolve(runtime.fetchImpl(runtime.endpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      }));
      // A late rejection after the timeout wins the race must not surface as an
      // unhandled rejection.
      fetchPromise.catch(() => {});
      const abortPromise = new Promise<never>((_, reject) => {
        const onAbort = () => reject(timeoutError(runtime, timeoutMs, timedOut));
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      abortPromise.catch(() => {});
      response = await Promise.race([fetchPromise, abortPromise]);
    } catch (error) {
      if (error instanceof LlmProviderError) throw error;
      if (timedOut) throw timeoutError(runtime, timeoutMs, true);
      if (isAbortError(error)) throw timeoutError(runtime, timeoutMs, false);
      throw new LlmProviderError(
        `${runtime.name} network error: ${summarizeText(describeUnknown(error), runtime.secret) || 'request failed'}`,
        {
          code: 'LLM_NETWORK',
          retryable: true,
          model: runtime.model,
          secret: runtime.secret,
          cause: error,
        },
      );
    }

    const status = response && typeof response === 'object' && typeof response.status === 'number'
      && Number.isFinite(response.status)
      ? response.status
      : undefined;
    if (status === undefined) {
      throw new LlmProviderError(
        `${runtime.name} returned a malformed HTTP response.`,
        {
          code: 'LLM_BAD_RESPONSE',
          retryable: false,
          model: runtime.model,
          secret: runtime.secret,
        },
      );
    }
    const ok = typeof response.ok === 'boolean' ? response.ok : status >= 200 && status < 300;

    if (!ok) {
      const bodyText = await readResponseBody(response);
      const summary = summarizeText(bodyText, runtime.secret)
        || summarizeText(typeof response.statusText === 'string' ? response.statusText : '', runtime.secret)
        || 'no response body';
      const retryable = isRetryableStatus(status);
      const code = status === 429
        ? 'LLM_RATE_LIMITED'
        : retryable ? 'LLM_UNAVAILABLE' : 'LLM_BAD_REQUEST';
      throw new LlmProviderError(
        `${runtime.name} HTTP ${status}: ${summary}`,
        {
          code,
          status,
          retryable,
          model: runtime.model,
          secret: runtime.secret,
          retryAfterMs: retryable ? parseRetryAfterMs(response.headers) : undefined,
        },
      );
    }

    try {
      return { payload: await readJsonPayload(response), status };
    } catch (error) {
      throw new LlmProviderError(
        `${runtime.name} HTTP ${status}: unreadable response body: ${summarizeText(describeUnknown(error), runtime.secret)}`,
        {
          code: 'LLM_BAD_RESPONSE',
          status,
          retryable: false,
          model: runtime.model,
          secret: runtime.secret,
          cause: error,
        },
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

async function requestWithRetry(
  runtime: ProviderRuntime,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<AttemptResult> {
  let lastError: LlmProviderError | undefined;
  for (let attempt = 0; attempt < runtime.maxAttempts; attempt += 1) {
    try {
      return await performAttempt(runtime, body, headers, timeoutMs);
    } catch (error) {
      const normalized = error instanceof LlmProviderError
        ? error
        : new LlmProviderError(
          `${runtime.name} request failed: ${summarizeText(describeUnknown(error), runtime.secret)}`,
          {
            code: 'LLM_NETWORK',
            retryable: true,
            model: runtime.model,
            secret: runtime.secret,
            cause: error,
          },
        );
      lastError = normalized;
      if (!normalized.retryable || attempt >= runtime.maxAttempts - 1) throw normalized;

      const delayMs = normalized.retryAfterMs !== undefined
        ? Math.max(0, normalized.retryAfterMs)
        : backoffDelayMs(attempt, runtime.now);
      await runtime.sleep(delayMs);
    }
  }
  // The loop always returns or throws; this is unreachable defence in depth.
  throw lastError ?? new LlmProviderError(
    `${runtime.name} request failed without an error.`,
    { code: 'LLM_UNAVAILABLE', retryable: false, model: runtime.model, secret: runtime.secret },
  );
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createLlmProvider(options: CreateLlmProviderOptions = {}): LlmProvider {
  const env = options.env ?? process.env;
  const name = resolveProviderName(env);
  const model = resolveModel(name, env);
  const secret = resolveSecret(name, env);
  const endpoint = resolveEndpoint(name, env);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxAttempts = resolveMaxAttempts(options.maxAttempts);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const usage = options.usage;
  const tenantId = options.tenantId;
  const projectId = options.projectId;
  const available = secret !== undefined && typeof fetchImpl === 'function';

  const runtime: ProviderRuntime | undefined = available
    ? {
      name,
      model,
      endpoint,
      secret: secret as string,
      maxAttempts,
      now,
      sleep,
      fetchImpl,
    }
    : undefined;

  const complete: LlmComplete = async (request: LlmCompletionRequest): Promise<LlmCompletionResult> => {
    if (!runtime) {
      const keyVariable = name === 'openrouter'
        ? 'OPENROUTER_API_KEY'
        : name === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'FLUTTERFORGE_LLM_API_KEY';
      const hint = name === 'openai-compatible'
        ? keyVariable
        : `${keyVariable} or FLUTTERFORGE_LLM_API_KEY`;
      const reason = secret !== undefined
        ? 'no fetch implementation is available in this runtime'
        : `no API key is configured (set ${hint})`;
      throw new LlmProviderError(
        `${name} is unavailable: ${reason}.`,
        { code: 'LLM_UNAVAILABLE', retryable: false, model },
      );
    }
    if (!request || typeof request !== 'object') {
      throw new LlmProviderError(
        `${name} received an invalid completion request.`,
        { code: 'LLM_BAD_REQUEST', retryable: false, model },
      );
    }

    const timeoutMs = resolveTimeoutMs(request.timeoutMs);
    const body = JSON.stringify(buildRequestBody(model, request));
    const headers = buildHeaders(name, runtime.secret);
    const attempt = await requestWithRetry(runtime, body, headers, timeoutMs);
    const parsed = parseCompletion(attempt.payload, runtime, attempt.status);

    if (usage) {
      const input: Parameters<UsageSink['record']>[0] = {
        provider: name,
        model: parsed.model,
        promptTokens: parsed.promptTokens,
        completionTokens: parsed.completionTokens,
      };
      if (tenantId !== undefined) input.tenantId = tenantId;
      if (projectId !== undefined) input.projectId = projectId;
      if (request.label !== undefined) input.label = request.label;
      try {
        await usage.record(input);
      } catch {
        // Metering must never fail generation. The sink owns its own reporting.
      }
    }

    return {
      text: parsed.text,
      model: parsed.model,
      usage: {
        promptTokens: parsed.promptTokens,
        completionTokens: parsed.completionTokens,
      },
    };
  };

  const provider = complete as unknown as LlmProvider;
  Object.defineProperties(provider, {
    name: { value: name, enumerable: true },
    model: { value: model, enumerable: true },
    available: { value: available, enumerable: true },
    complete: { value: complete, enumerable: true },
  });
  return Object.freeze(provider);
}
