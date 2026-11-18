/**
 * Shared typed contracts for the intelligent chat system.
 *
 * These types are intentionally transport-agnostic: the router, context
 * retrieval, streaming answer, and UI all speak the same vocabulary. Nothing
 * here is generated from a canned script — every event describes something
 * that actually happened (or a real failure that was observed).
 */

/* ── Intent ───────────────────────────────────────────────────────────────── */

/** Fine-grained assistant intent. Distinct from the legacy 'chat' | 'build'. */
export type AssistantIntent =
  | 'general'       // A. small talk / general question
  | 'explanation'   // B. Flutter / Dart concept explanation
  | 'project'       // C. question about THIS project
  | 'modify'        // D. change existing code
  | 'feature'       // E. implement a new feature / screen
  | 'debug'         // F. diagnose & fix an error
  | 'refactor'      // G. refactor / optimize existing code
  | 'architecture'; // H. project structure / design question

export interface IntentDecision {
  intent: AssistantIntent;
  /** 0..1. Drives whether a cheap local decision is trusted or an LLM is asked. */
  confidence: number;
  reason: string;
  /** Where the decision came from — useful for debugging and for tests. */
  source: 'classifier' | 'structural';
}

/** Intents that must invoke the real builder tools (not merely explain). */
export const BUILDER_INTENTS: ReadonlySet<AssistantIntent> = new Set<AssistantIntent>([
  'modify', 'feature', 'debug', 'refactor',
]);

/** Intents that need actual project files loaded into context. */
export const PROJECT_AWARE_INTENTS: ReadonlySet<AssistantIntent> = new Set<AssistantIntent>([
  'project', 'modify', 'feature', 'debug', 'refactor', 'architecture',
]);

/* ── Errors ───────────────────────────────────────────────────────────────── */

export type ChatErrorKind =
  | 'configuration' // missing/invalid API key, model not allowed
  | 'network'       // fetch failed / DNS / offline
  | 'provider'      // provider returned a real error (429, 5xx, 4xx)
  | 'empty'         // provider returned no content
  | 'timeout'       // request exceeded configured deadline
  | 'cancelled';    // user aborted — never reported as a provider failure

export interface ChatErrorDetails {
  kind: ChatErrorKind;
  message: string;
  status?: number;
  retryable: boolean;
}

export class ChatError extends Error implements ChatErrorDetails {
  readonly kind: ChatErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(details: ChatErrorDetails, cause?: unknown) {
    super(details.message);
    this.name = 'ChatError';
    this.kind = details.kind;
    this.status = details.status;
    this.retryable = details.retryable;
    this.cause = cause;
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof ChatError && error.kind === 'cancelled') return true;
  const name = (error as { name?: string } | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /aborted|cancelled|canceled/i.test(message);
}

/** Turn an unknown failure into a typed, UI-presentable ChatError. */
export function classifyChatError(error: unknown, signal?: AbortSignal): ChatError {
  if (error instanceof ChatError) return error;
  if (signal?.aborted || isAbortError(error)) {
    return new ChatError({ kind: 'cancelled', message: 'Generation stopped.', retryable: false }, error);
  }
  const status = (error as { status?: number } | null)?.status
    ?? (error as { response?: { status?: number } } | null)?.response?.status;
  const raw = error instanceof Error ? error.message : String(error ?? 'request failed');
  const message = raw.slice(0, 400);

  if (typeof status === 'number') {
    if (status === 401 || status === 402 || status === 403) {
      return new ChatError({
        kind: 'configuration',
        status,
        message: `The AI provider rejected the configured key (HTTP ${status}). Add or update your API key in Settings.`,
        retryable: false,
      }, error);
    }
    if (status === 404) {
      return new ChatError({
        kind: 'configuration', status, message: 'The configured model was not found. Choose another model in Settings.', retryable: false,
      }, error);
    }
    if (status === 429) {
      return new ChatError({ kind: 'provider', status, message: 'The AI provider is rate-limiting requests. Retry in a moment.', retryable: true }, error);
    }
    if (status >= 500) {
      return new ChatError({ kind: 'provider', status, message: `The AI provider is temporarily unavailable (HTTP ${status}).`, retryable: true }, error);
    }
    return new ChatError({ kind: 'provider', status, message: `The AI provider returned HTTP ${status}: ${message}`, retryable: false }, error);
  }

  if (/network|fetch|enotfound|econnreset|offline|failed to fetch/i.test(message)) {
    return new ChatError({ kind: 'network', message: 'Could not reach the AI provider. Check your connection and retry.', retryable: true }, error);
  }
  if (/timeout|timed out|deadline/i.test(message)) {
    return new ChatError({ kind: 'timeout', message: 'The AI request timed out. Retry with a faster model or a smaller request.', retryable: true }, error);
  }
  return new ChatError({ kind: 'provider', message: `The AI request failed: ${message}`, retryable: false }, error);
}

/* ── Typed answer result ──────────────────────────────────────────────────── */

export type ChatAnswerResult =
  | { ok: true; text: string; intent: AssistantIntent; model: string }
  | { ok: false; error: ChatErrorDetails; intent: AssistantIntent };

/* ── Structured runtime events ────────────────────────────────────────────── */

export type ChatEvent =
  | { type: 'message.started'; runId: string; intent?: AssistantIntent }
  | { type: 'message.delta'; runId: string; token: string }
  | { type: 'agent.thinking'; runId: string; detail?: string }
  | { type: 'tool.started'; runId: string; operationId: string; tool: string; input?: unknown }
  | { type: 'tool.completed'; runId: string; operationId: string; result: unknown }
  | { type: 'tool.failed'; runId: string; operationId: string; error: string }
  | { type: 'validation.completed'; runId: string; result: unknown }
  | { type: 'message.completed'; runId: string }
  | { type: 'message.failed'; runId: string; error: string | ChatErrorDetails }
  | { type: 'run.cancelled'; runId: string };

export type ChatEventSink = (event: ChatEvent) => void;
