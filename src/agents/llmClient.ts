/**
 * LLM Client — robust OpenRouter/OpenAI-compatible caller for all pipeline agents.
 * Features: multi-key pool rotation, automatic model failover, JSON & text modes, streaming.
 *
 * Hardening notes (production):
 *  - Per-call timeout (default 90s, clamped to [1s, 300s]) races the network call;
 *    the underlying request is aborted via a combined signal (caller signal + timeout
 *    controller, composed with AbortSignal.any when available).
 *  - Retries with exponential backoff + jitter (250ms base, 6s cap, max 3 attempts per
 *    (model, key) pair) for 429 / 408 / 5xx / network errors BEFORE moving on to the
 *    next key, then the next model. 401 / 402 / 403 mark the key failed and never retry
 *    it; 400 / 404 are not retried at all.
 *  - Request-size guard rejects oversized prompts before any network or metering work.
 *  - Credit metering happens ONLY after a confirmed non-streaming success and can never
 *    throw into the caller.
 *  - Error classes carry structured metadata (status, body summary, model, masked key
 *    hint, attempt counters). Raw API keys never appear in errors.
 */
import { keyPool } from '../agent/keyPool';
import { useCreditsStore } from '../stores/credits.store';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMCallOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json' | 'text';
  signal?: AbortSignal;
  onToken?: (token: string) => void;
  apiKey?: string;
  allowFallback?: boolean;
  /** Subscription metering — overridden by the pipeline where it knows the caller's tier. */
  creditWeight?: number;
  /** Human label recorded in the usage ledger (e.g. "Intake Agent", "Repair round"). */
  creditLabel?: string;
  /**
   * Per-call timeout in milliseconds. Defaults to 90_000. Values are clamped to
   * [1_000, 300_000]; non-finite input falls back to the default.
   */
  timeoutMs?: number;
  /**
   * Sleep seam used for retry backoff — injectable for tests.
   * Defaults to a setTimeout-based sleep.
   */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface LLMResponse {
  content: string;
  model: string;
  tokens: { prompt: number; completion: number };
}

const LLM_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_TIMEOUT_MS = 90_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_PAIR_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;
const RETRY_CAP_MS = 6_000;
const CHARS_PER_TOKEN = 4;
/** Hard request-size guard: estimated prompt tokens (chars / 4). */
const CONTEXT_GUARD_TOKENS = 120_000;

// Configured model from environment or fallback
const ENV_MODEL = (typeof import.meta !== 'undefined' ? (import.meta.env?.VITE_AGENT_MODEL as string) : '') || '';

/** Thrown when the user ran out of subscription credits before a call. */
export class CreditsExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreditsExhaustedError';
  }
}

/**
 * Thrown when a call exceeds `options.timeoutMs`. Carries the model and a masked
 * key hint plus the attempt number — never the raw key.
 */
export class LLMTimeoutError extends Error {
  public readonly model: string;
  public readonly keyHint: string;
  public readonly timeoutMs: number;
  public readonly attempt: number;
  public readonly maxAttempts: number;

  constructor(
    message: string,
    init: { model: string; keyHint: string; timeoutMs: number; attempt: number; maxAttempts: number },
  ) {
    super(message);
    this.name = 'LLMTimeoutError';
    this.model = init.model;
    this.keyHint = init.keyHint;
    this.timeoutMs = init.timeoutMs;
    this.attempt = init.attempt;
    this.maxAttempts = init.maxAttempts;
  }
}

/**
 * Thrown for non-2xx HTTP responses from the provider. Carries the HTTP `status`,
 * a truncated `bodySummary` of the raw response body, and masked key metadata —
 * never the raw key.
 */
export class LLMResponseError extends Error {
  public readonly status: number;
  public readonly bodySummary: string;
  public readonly model: string;
  public readonly keyHint: string;
  public readonly attempt: number;
  public readonly maxAttempts: number;

  constructor(
    message: string,
    init: {
      status: number;
      bodySummary: string;
      model: string;
      keyHint: string;
      attempt?: number;
      maxAttempts?: number;
    },
  ) {
    super(message);
    this.name = 'LLMResponseError';
    this.status = init.status;
    this.bodySummary = init.bodySummary;
    this.model = init.model;
    this.keyHint = init.keyHint;
    this.attempt = init.attempt ?? 1;
    this.maxAttempts = init.maxAttempts ?? MAX_PAIR_ATTEMPTS;
  }
}

/** Thrown when the prompt estimate exceeds the request-size guard (before any fetch). */
export class ContextTooLargeError extends Error {
  public readonly estimatedTokens: number;
  public readonly limit: number;

  constructor(message: string, estimatedTokens: number, limit: number = CONTEXT_GUARD_TOKENS) {
    super(message);
    this.name = 'ContextTooLargeError';
    this.estimatedTokens = estimatedTokens;
    this.limit = limit;
  }
}

function defaultCreditWeight(modelId?: string | null): number {
  if (!modelId) return 1;
  const id = modelId.toLowerCase();
  if (/ultra|70b|deepseek-chat|qwen/.test(id)) return 4;
  return 1;
}

/**
 * Subscription gate for LLM calls — every model call burns credits.
 * Pre-check (fail closed) then charge after a successful call (fail open on
 * infra errors so a flaky Supabase connection can't strand the user).
 */
async function assertCreditsFor(options: LLMCallOptions): Promise<void> {
  try {
    const store = useCreditsStore.getState();
    const weight = options.creditWeight ?? defaultCreditWeight(options.model);
    if (!store.wallet) await store.refresh();
    const balance = useCreditsStore.getState().wallet?.balance;
    if (typeof balance === 'number' && balance < weight) {
      throw new CreditsExhaustedError(
        `Insufficient credits — you need ${weight} credit${weight === 1 ? '' : 's'}, you have ${balance}. Upgrade to keep generating.`,
      );
    }
  } catch (cause) {
    if (cause instanceof CreditsExhaustedError) throw cause;
    // Infra errors are non-fatal — don't block the pipeline on them.
    console.warn('[credits] gate unavailable, allowing call:', cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * Records the usage ledger entry for one successful non-streaming call.
 * Must NEVER throw into the caller — every failure mode is swallowed and logged.
 */
async function meterLlmCall(model: string, label: string, configuredWeight?: number): Promise<void> {
  try {
    const weight = configuredWeight ?? defaultCreditWeight(model);
    const store = useCreditsStore.getState();
    const result = await store.spend(weight, 'llm_call', label, model);
    if (!result.ok) {
      console.warn('[credits] deduction refused:', result.error);
    }
  } catch (cause) {
    // Metering problems must never break the user's build.
    console.warn('[credits] metering failed:', cause instanceof Error ? cause.message : String(cause));
  }
}

// Model tiers ordered by reliability and quality
export const AGENT_MODELS = {
  frontier: [
    ...(ENV_MODEL ? [ENV_MODEL] : []),
    'nvidia/nemotron-3.5-lightning:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'deepseek/deepseek-chat:free',
    'google/gemini-2.0-flash-001',
    'google/gemini-2.0-flash-exp:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
  ],
  economy: [
    ...(ENV_MODEL ? [ENV_MODEL] : []),
    'nvidia/nemotron-3.5-lightning:free',
    'meta-llama/llama-3.1-8b-instruct:free',
    'google/gemini-2.0-flash-lite-001',
    'deepseek/deepseek-chat:free',
  ],
};

export const AGENT_ROLES = {
  'intake': 'frontier',
  'ux-research': 'frontier',
  'design-system': 'economy',
  'architecture': 'frontier',
  'data-model': 'economy',
  'feature-planner': 'frontier',
  'data-models': 'economy',
  'code-gen': 'economy',
  'frontend-builder': 'frontier',
  'backend-api': 'economy',
  'integration': 'economy',
  'qa-validation': 'economy',
  'repair': 'economy',
  'edit': 'economy',
} as const;

export type AgentId = keyof typeof AGENT_ROLES;

/** The primary model assigned to an agent (its own tier). Tier fallback
 *  (its tier, then the other) is applied by getCandidateModels(). */
export function agentModelFor(agent: AgentId): string {
  return AGENT_MODELS[AGENT_ROLES[agent]][0];
}

function getCandidateKeys(explicitKey?: string): string[] {
  const keys: string[] = [];
  if (explicitKey?.trim()) keys.push(explicitKey.trim());

  const pooledKey = keyPool.getNextKey();
  if (pooledKey) keys.push(pooledKey);

  for (const k of keyPool.getAllKeys()) {
    if (!keys.includes(k)) keys.push(k);
  }

  // Local storage fallback
  try {
    if (typeof localStorage !== 'undefined') {
      const stored =
        localStorage.getItem('openrouter_api_key') ||
        localStorage.getItem('openrouter_key') ||
        localStorage.getItem('ff_openrouter_key');
      if (stored && !keys.includes(stored.trim())) keys.push(stored.trim());
    }
  } catch {
    // ignore
  }

  // Environment fallback
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env) {
      const single = import.meta.env.VITE_OPENROUTER_API_KEY as string | undefined;
      if (single && !keys.includes(single.trim())) keys.push(single.trim());
    }
  } catch {
    // ignore
  }

  return keys.filter(Boolean);
}

/**
 * Deterministic candidate model list: requested model first (when given and
 * well-formed), then frontier tier, then economy tier — de-duplicated, stable
 * order, frozen before returning.
 */
function getCandidateModels(requestedModel?: string, allowFallback = true): readonly string[] {
  const models: string[] = [];
  if (requestedModel?.trim()) {
    models.push(requestedModel.trim());
    if (!allowFallback) return Object.freeze(models);
  }
  for (const m of AGENT_MODELS.frontier) {
    if (!models.includes(m)) models.push(m);
  }
  for (const m of AGENT_MODELS.economy) {
    if (!models.includes(m)) models.push(m);
  }
  return Object.freeze(models);
}

function resolveTimeoutMs(timeoutMs?: number): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(timeoutMs)));
}

/** Masked, non-reversible attempt identifier — never contains the raw key. */
function maskKeyHint(key: string | undefined): string {
  if (!key) return 'no-key';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return `key:**** (${trimmed.length} chars)`;
  return `key:${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

/** chars / 4 — rough but safe token estimate for the request-size guard. */
function estimatePromptTokens(messages: LLMMessage[] | undefined): number {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    chars += (m?.role?.length ?? 0) + (m?.content?.length ?? 0);
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function backoffDelayMs(retryIndex: number): number {
  const raw = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** retryIndex);
  // ±25% jitter — deterministic cap, randomized spread.
  const jittered = raw * (0.75 + Math.random() * 0.5);
  return Math.max(1, Math.round(jittered));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Don't keep a Node process alive solely for a backoff timer.
    const maybeUnref = (timer as unknown as { unref?: unknown }).unref;
    if (typeof maybeUnref === 'function') (maybeUnref as () => void).call(timer);
  });
}

function unrefTimer(timer: unknown): void {
  const maybeUnref = (timer as { unref?: unknown } | null)?.unref;
  if (typeof maybeUnref === 'function') (maybeUnref as () => void).call(timer);
}

function isUserAbort(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return error.name === 'AbortError' || msg.includes('abort') || msg.includes('cancel');
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function isAuthOrPaymentStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403;
}

/**
 * Combine caller-provided abort signal(s) with the timeout controller's signal.
 * Uses AbortSignal.any when available, otherwise a manual fan-in controller.
 */
function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const provided = signals.filter((s): s is AbortSignal => Boolean(s));
  if (provided.length === 0) return undefined;
  if (provided.length === 1) return provided[0];
  const anySignal = (AbortSignal as unknown as { any?: (list: AbortSignal[]) => AbortSignal }).any;
  if (typeof anySignal === 'function') {
    try {
      return anySignal(provided);
    } catch {
      // Fall through to manual fan-in below.
    }
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const s of provided) {
    if (s.aborted) {
      controller.abort();
      return controller.signal;
    }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

/**
 * Runs `task` against a hard timeout. The timeout aborts the internal controller
 * (which the task should combine into its fetch signal) AND rejects with
 * `makeError` — whichever settles first wins, so even a fetch that ignores
 * abort signals still loses the race on time.
 */
async function withTimeout<T>(
  task: (timeoutSignal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  makeError: () => LLMTimeoutError,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(makeError());
    }, timeoutMs);
    unrefTimer(timer);
    task(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
}

function parseApiErrorMessage(errText: string, statusText?: string): string {
  const raw = (errText || statusText || '').trim();
  if (!raw) return 'HTTP error';
  try {
    const json = JSON.parse(raw) as { error?: { message?: string }; message?: string };
    if (typeof json?.error?.message === 'string' && json.error.message) return json.error.message;
    if (typeof json?.message === 'string' && json.message) return json.message;
    return raw;
  } catch {
    return raw;
  }
}

function makeResponseError(
  status: number,
  errText: string,
  statusText: string | undefined,
  model: string,
  keyHint: string,
  attempt: number,
  maxAttempts: number,
): LLMResponseError {
  const parsed = parseApiErrorMessage(errText, statusText);
  const bodySummary = (errText || statusText || '').slice(0, 300);
  return new LLMResponseError(
    `LLM call failed [${status}]: ${parsed.slice(0, 300)} (model=${model}, key=${keyHint}, attempt ${attempt}/${maxAttempts})`,
    { status, bodySummary, model, keyHint, attempt, maxAttempts },
  );
}

function tagAttempt(error: Error, model: string, keyHint: string, attempt: number): Error {
  // Errors that already carry attempt context pass through untouched — instanceof
  // relationships (LLMTimeoutError / LLMResponseError) are preserved.
  if (error instanceof LLMTimeoutError || error instanceof LLMResponseError) return error;
  if (error.message.includes('(model=')) return error;
  const tagged = new Error(`${error.message} (model=${model}, key=${keyHint}, attempt ${attempt}/${MAX_PAIR_ATTEMPTS})`);
  tagged.name = error.name;
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') (tagged as { status?: number }).status = status;
  return tagged;
}

/** Final wrap: fold the across-call attempt counter into the thrown error message. */
function withAttemptSummary(error: Error, totalAttempts: number): Error {
  const suffix = ` (after ${totalAttempts} attempt${totalAttempts === 1 ? '' : 's'})`;
  if (error instanceof LLMTimeoutError) {
    return new LLMTimeoutError(`${error.message}${suffix}`, {
      model: error.model,
      keyHint: error.keyHint,
      timeoutMs: error.timeoutMs,
      attempt: error.attempt,
      maxAttempts: error.maxAttempts,
    });
  }
  if (error instanceof LLMResponseError) {
    return new LLMResponseError(`${error.message}${suffix}`, {
      status: error.status,
      bodySummary: error.bodySummary,
      model: error.model,
      keyHint: error.keyHint,
      attempt: error.attempt,
      maxAttempts: error.maxAttempts,
    });
  }
  const wrapped = new Error(`${error.message}${suffix}`);
  wrapped.name = error.name;
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') (wrapped as { status?: number }).status = status;
  return wrapped;
}

interface StreamContext {
  model: string;
  keyHint: string;
}

/**
 * Streaming completions with SSE.
 * Non-2xx responses throw LLMResponseError before any token is emitted.
 */
async function callLLMStreaming(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  onToken: (token: string) => void,
  signal?: AbortSignal,
  context?: StreamContext,
): Promise<string> {
  const streamBody = { ...body, stream: true };
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(streamBody),
    signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText ?? '');
    throw makeResponseError(
      res.status,
      errText,
      res.statusText,
      context?.model ?? 'unknown',
      context?.keyHint ?? 'no-key',
      1,
      1,
    );
  }
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error(`No response body for streaming (model=${context?.model ?? 'unknown'}, key=${context?.keyHint ?? 'no-key'})`);
  }
  const decoder = new TextDecoder();
  let fullContent = '';
  let buffer = '';
  let lastToken = '';
  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error('LLM streaming cancelled by user');
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return fullContent;
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
          };
          const token = parsed.choices?.[0]?.delta?.content ?? '';
          if (token) {
            if (token !== lastToken || token.length <= 20) {
              lastToken = token;
              fullContent += token;
              onToken(token);
            }
          }
        } catch {
          // skip malformed chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return fullContent;
}

/**
 * Primary LLM caller with automatic key pool rotation and model failover.
 *
 * Ordering is deterministic: same model, same key (up to MAX_PAIR_ATTEMPTS with
 * backoff), then next key, then next model. Attempts are counted and reported in
 * the thrown error's message.
 */
export async function callLLM(
  messages: LLMMessage[],
  options: LLMCallOptions = {}
): Promise<LLMResponse> {
  const sleep = options.sleepFn ?? defaultSleep;
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const candidateKeys = getCandidateKeys(options.apiKey);
  const candidateModels = getCandidateModels(options.model, options.allowFallback ?? true);
  const maxTokens = options.maxTokens ?? 6000;
  const temperature = options.temperature ?? 0.25;

  // Request-size guard — before any network or metering work.
  if (!Array.isArray(messages) || messages.length === 0) {
    const est = estimatePromptTokens(messages);
    throw new ContextTooLargeError(
      `LLM prompt is empty — nothing to send (estimated ~${est} tokens from 0 messages). Provide at least one message.`,
      est,
    );
  }
  const estimatedTokens = estimatePromptTokens(messages);
  if (estimatedTokens > CONTEXT_GUARD_TOKENS) {
    throw new ContextTooLargeError(
      `Estimated prompt size ~${estimatedTokens} tokens exceeds the ${CONTEXT_GUARD_TOKENS}-token request guard (chars/4). Trim the prompt or context window before calling the model.`,
      estimatedTokens,
    );
  }

  let lastError: Error | null = null;
  let totalAttempts = 0;

  // Try each model candidate
  for (const model of candidateModels) {
    // For each model, try available keys with rotation
    const keysToTry = candidateKeys.length > 0 ? candidateKeys : [''];

    keyLoop: for (const key of keysToTry) {
      const trimmedKey = key.trim();
      const keyHint = maskKeyHint(trimmedKey);

      for (let attempt = 1; attempt <= MAX_PAIR_ATTEMPTS; attempt++) {
        totalAttempts += 1;

        const body: Record<string, unknown> = {
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
        };

        if (options.responseFormat === 'json') {
          body.response_format = { type: 'json_object' };
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://flutterforge.studio',
          'X-Title': 'FlutterForge',
        };
        if (trimmedKey) {
          headers['Authorization'] = `Bearer ${trimmedKey}`;
        }

        const makeTimeoutError = () =>
          new LLMTimeoutError(
            `LLM request timed out after ${timeoutMs}ms (model=${model}, key=${keyHint}, attempt ${attempt}/${MAX_PAIR_ATTEMPTS})`,
            { model, keyHint, timeoutMs, attempt, maxAttempts: MAX_PAIR_ATTEMPTS },
          );

        try {
          if (options.onToken) {
            const onToken = options.onToken;
            // Streaming calls get exactly one attempt per (model, key) pair: tokens may
            // already have been emitted to the caller, so silently retrying could
            // duplicate output. They are also never metered (no usage payload on SSE).
            const content = await withTimeout(
              (timeoutSignal) =>
                callLLMStreaming(
                  LLM_ENDPOINT,
                  headers,
                  body,
                  onToken,
                  combineSignals([options.signal, timeoutSignal]),
                  { model, keyHint },
                ),
              timeoutMs,
              makeTimeoutError,
            );
            if (trimmedKey) keyPool.markSuccess(trimmedKey);
            return { content, model, tokens: { prompt: 0, completion: 0 } };
          }

          const res = await withTimeout(
            (timeoutSignal) =>
              fetch(LLM_ENDPOINT, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: combineSignals([options.signal, timeoutSignal]),
              }),
            timeoutMs,
            makeTimeoutError,
          );

          if (!res.ok) {
            const errText = await res.text().catch(() => res.statusText ?? '');
            const error = makeResponseError(res.status, errText, res.statusText, model, keyHint, attempt, MAX_PAIR_ATTEMPTS);

            if (isRetryableStatus(res.status)) {
              // 429 / 408 / 5xx — back off and retry the same (model, key) pair before
              // moving on to the next key.
              if (attempt < MAX_PAIR_ATTEMPTS) {
                await sleep(backoffDelayMs(attempt - 1));
                continue;
              }
              if (trimmedKey) keyPool.markFailure(trimmedKey, error.message);
              lastError = error;
              break; // next key
            }

            if (isAuthOrPaymentStatus(res.status)) {
              // 401 / 402 / 403 — never retry the same key; mark it and move on.
              if (trimmedKey) keyPool.markFailure(trimmedKey, error.message);
              lastError = error;
              break; // next key
            }

            // 400 / 404 and any other non-retryable status — never retried; skip
            // remaining keys for this model and go straight to the next model.
            lastError = error;
            break keyLoop;
          }

          let data: {
            choices?: Array<{ message?: { content?: string } }>;
            model?: string;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          try {
            data = (await res.json()) as typeof data;
          } catch (jsonErr) {
            const reason = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
            // Malformed body (gateway junk) — treated as a retryable network-class failure.
            throw new Error(`LLM response was not valid JSON (model=${model}, key=${keyHint}, attempt ${attempt}/${MAX_PAIR_ATTEMPTS}): ${reason}`);
          }

          const content = data.choices?.[0]?.message?.content ?? '';
          const modelUsed = data.model || model;
          if (trimmedKey) keyPool.markSuccess(trimmedKey);

          // Metering ONLY after a confirmed non-streaming success. Fire-and-forget:
          // meterLlmCall swallows every failure mode, so a broken ledger can never
          // break the pipeline.
          void meterLlmCall(modelUsed, options.creditLabel ?? 'llm_call', options.creditWeight);

          return {
            content,
            model: modelUsed,
            tokens: {
              prompt: data.usage?.prompt_tokens ?? 0,
              completion: data.usage?.completion_tokens ?? 0,
            },
          };
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));

          if (isUserAbort(error)) {
            // Caller cancelled — never retried, never marked.
            throw error;
          }

          const tagged = tagAttempt(error, model, keyHint, attempt);

          if (options.onToken) {
            // Streaming: no automatic retry (tokens may already have been emitted).
            if (trimmedKey) keyPool.markFailure(trimmedKey, error.message);
            lastError = tagged;
            break; // next key
          }

          if (attempt < MAX_PAIR_ATTEMPTS) {
            await sleep(backoffDelayMs(attempt - 1));
            continue; // retry the same (model, key) pair after backoff
          }
          if (trimmedKey) keyPool.markFailure(trimmedKey, error.message);
          lastError = tagged;
          break; // next key
        }
      }
    }
  }

  throw withAttemptSummary(
    lastError ?? new Error('All LLM models and keys failed. Please check your OpenRouter API key.'),
    totalAttempts,
  );
}

/** Extract a JSON object from LLM output (fence-tolerant, brace-tolerant). */
export function extractJsonObject(raw: string): unknown {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // fall through
      }
    }
    throw new Error(`Failed to parse LLM JSON output. Raw: ${raw.slice(0, 300)}`);
  }
}

/**
 * Calls LLM and parses the response as JSON.
 * Strips markdown code fences if present.
 */
export async function callLLMJson<T>(
  messages: LLMMessage[],
  options: LLMCallOptions = {}
): Promise<T> {
  const response = await callLLM(messages, { ...options, responseFormat: 'json' });
  return extractJsonObject(response.content) as T;
}

export class AgentSchemaError extends Error {
  public readonly errors: string[];

  constructor(message: string, errors: string[] = []) {
    super(message);
    this.name = 'AgentSchemaError';
    this.errors = errors;
  }
}

/**
 * Strict JSON call: validates the response against `validateSchema`. On any
 * failure (unparseable body or schema violations) performs ONE corrective
 * round-trip that feeds the exact violations back to the model. If the retry
 * is still invalid, throws AgentSchemaError — callers decide how to degrade.
 */
export async function callLLMJsonStrict<T>(
  messages: LLMMessage[],
  validateSchema: (data: unknown) => import('./schema').ValidationResult<T>,
  options: LLMCallOptions & { schemaName?: string } = {}
): Promise<T> {
  const attempt = async (msgs: LLMMessage[]): Promise<unknown> => {
    const response = await callLLM(msgs, { ...options, responseFormat: 'json' });
    return extractJsonObject(response.content);
  };

  const schemaName = options.schemaName ?? 'output';
  let check: import('./schema').ValidationResult<T>;
  try {
    check = validateSchema(await attempt(messages));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check = { ok: false, errors: [message] };
  }

  if (check.ok) return check.value;

  const failed = check as { ok: false; errors: string[] };
  const feedback = [
    ...messages,
    {
      role: 'assistant' as const,
      content: `(previous output was rejected: ${failed.errors.length} problem(s))
${failed.errors.slice(0, 8).join('\n')}`,
    },
    {
      role: 'user' as const,
      content: `Your previous output failed schema validation with these exact problems:
${failed.errors.slice(0, 20).map((e) => `- ${e}`).join('\n')}

Return ONLY the corrected JSON object. Do not add commentary, do not wrap in prose.`,
    },
  ];

  try {
    const retryCheck = validateSchema(await attempt(feedback));
    if (retryCheck.ok) return retryCheck.value;
    const failedRetry = retryCheck as { ok: false; errors: string[] };
    throw new AgentSchemaError(`${schemaName} failed schema validation after corrective retry`, failedRetry.errors);
  } catch (err) {
    if (err instanceof AgentSchemaError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AgentSchemaError(`${schemaName} failed schema validation after corrective retry: ${message}`, [message]);
  }
}

/**
 * Calls LLM for plain code/text generation (no JSON parsing).
 * Good for agents that emit multi-file Dart/YAML code blocks.
 */
export async function callLLMText(
  messages: LLMMessage[],
  options: LLMCallOptions = {}
): Promise<string> {
  const response = await callLLM(messages, { ...options, responseFormat: 'text' });
  return response.content;
}

/**
 * Retry wrapper — tries frontier models in sequence, falls back to economy.
 * (Kept for pipeline compatibility: callLLM already rotates keys and fails over
 * across model tiers; this wrapper preserves the historical call-site contract.)
 */
export async function callLLMWithFallback<T>(
  messages: LLMMessage[],
  parseMode: 'json' | 'text',
  options: LLMCallOptions = {}
): Promise<string> {
  const response = await callLLM(messages, { ...options, responseFormat: parseMode });
  return response.content;
}

export interface ParsedFile {
  path: string;
  content: string;
  language: string;
}

export function parseFilesFromLLMOutput(raw: string): ParsedFile[] {
  const files: ParsedFile[] = [];

  // Pattern 1: // FILE: path\n```lang\ncode\n```
  const pattern1 = /\/\/\s*FILE:\s*([^\n]+)\n```(\w+)?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern1.exec(raw)) !== null) {
    files.push({
      path: match[1].trim(),
      language: match[2]?.trim() || 'dart',
      content: match[3].trim(),
    });
  }
  if (files.length > 0) return files;

  // Pattern 2: ### path\n```lang\ncode\n```
  const pattern2 = /###\s+([^\n]+\.(?:dart|yaml|json|md))\n```(\w+)?\n([\s\S]*?)```/g;
  while ((match = pattern2.exec(raw)) !== null) {
    files.push({
      path: match[1].trim(),
      language: match[2]?.trim() || 'dart',
      content: match[3].trim(),
    });
  }
  if (files.length > 0) return files;

  // Pattern 3: **path**\n```lang\ncode\n```
  const pattern3 = /\*\*([^*]+\.(?:dart|yaml|json))\*\*\n```(\w+)?\n([\s\S]*?)```/g;
  while ((match = pattern3.exec(raw)) !== null) {
    files.push({
      path: match[1].trim(),
      language: match[2]?.trim() || 'dart',
      content: match[3].trim(),
    });
  }

  return files;
}

export async function callLLMTextStreaming(
  messages: LLMMessage[],
  onToken: (token: string) => void,
  options: LLMCallOptions = {}
): Promise<string> {
  return callLLMText(messages, { ...options, onToken });
}
