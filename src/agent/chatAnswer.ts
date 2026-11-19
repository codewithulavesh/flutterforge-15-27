import { callLLMTextStreaming, type LLMMessage } from './llmClient';
import { keyPool } from './keyPool';
import {
  type AssistantIntent,
  type ChatAnswerResult,
  type ChatEventSink,
  ChatError,
  classifyChatError,
  isAbortError,
} from './chatTypes';
import type { ProjectAwareness } from './chatContext';

export interface ChatAnswerOptions {
  projectName?: string;
  projectSummary?: string;
  projectContext?: ProjectAwareness;
  formattedContext?: string;
  history?: Array<{ role: string; content: string }>;
  historySummary?: string;
  apiKey?: string;
  model?: string;
  intent?: AssistantIntent;
  onProgress?: (message: string) => void;
  onToken?: (token: string) => void;
  onRetry?: (message: string) => void;
  onEvent?: ChatEventSink;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
}

export const FAST_CHAT_MODEL = 'nvidia/nemotron-3.5-lightning:free';

/**
 * Legacy local fallback helper — retained for backward compatibility with imports,
 * but NEVER used silently to mask normal AI responses or errors.
 */
export function localFallback(question: string, projectName: string): string {
  const trimmed = (question || '').trim();
  if (!trimmed) {
    return `I'm ready. Tell me what to build in ${projectName} — for example "add a settings screen with dark mode".`;
  }
  return `I can help you build "${projectName}". To change the app, describe the screen or feature you want — for example "add a settings screen" or "make the home list searchable". For a general question like "${trimmed.slice(0, 90)}", add an OpenRouter API key in Settings and I'll answer it directly.`;
}

/**
 * Resolves an API key from options, key pool, localStorage, or environment.
 */
function resolveApiKey(providedKey?: string): string {
  if (providedKey !== undefined) return providedKey.trim();
  try {
    const pooled = keyPool.getNextKey() || keyPool.getAllKeys()[0];
    if (pooled) return pooled;
  } catch {
    // continue
  }
  try {
    if (typeof localStorage !== 'undefined') {
      const stored =
        localStorage.getItem('openrouter_api_key') ||
        localStorage.getItem('openrouter_key') ||
        localStorage.getItem('ff_openrouter_key');
      if (stored?.trim()) return stored.trim();
    }
  } catch {
    // continue
  }
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_OPENROUTER_API_KEY) {
      return (import.meta.env.VITE_OPENROUTER_API_KEY as string).trim();
    }
  } catch {
    // continue
  }
  return '';
}

/**
 * Builds the intent-aware system instructions for FlutterForge chat.
 */
function buildSystemPrompt(
  projectName: string,
  options: ChatAnswerOptions,
  intent: AssistantIntent
): string {
  const sections: string[] = [
    "You are FlutterForge, an intelligent, context-aware Flutter and Dart engineering assistant.",
    `Current project: "${projectName}".`,
  ];

  if (options.formattedContext) {
    sections.push(options.formattedContext);
  } else if (options.projectSummary) {
    sections.push(`Project Summary: ${options.projectSummary}`);
  }

  if (options.historySummary) {
    sections.push(options.historySummary);
  }

  // Intent-tailored guidance
  switch (intent) {
    case 'explanation':
      sections.push(
        'The user is asking for an explanation of a Flutter or Dart concept.',
        'Explain concisely, clearly, and authoritatively in 2-4 focused paragraphs.',
        'Include short, accurate Dart code examples where helpful. Use Material 3 conventions.'
      );
      break;
    case 'project':
    case 'architecture':
      sections.push(
        'The user is asking about the structure, files, dependencies, or design of THIS project.',
        'Answer directly based on the provided project context (screens, state management, dependencies, routes).',
        'Cite specific filenames and packages present in this project.'
      );
      break;
    case 'debug':
      sections.push(
        'The user is inquiring about an error or bug.',
        'Analyze the compile/preview errors or issue described, identify the root cause, and explain the exact fix needed.'
      );
      break;
    case 'modify':
    case 'feature':
    case 'refactor':
      sections.push(
        'The user has asked for a code modification, new feature, or refactoring.',
        'Explain concisely what changes you recommend and how they should be applied.',
        'Note: FlutterForge builder tools execute verified code changes directly into files.'
      );
      break;
    case 'general':
    default:
      sections.push(
        'Answer directly in 2-3 short, actionable paragraphs.',
        'Be helpful, professional, and knowledgeable about Flutter.'
      );
      break;
  }

  return sections.filter(Boolean).join('\n\n');
}

/**
 * Execute a complete chat turn returning a typed ChatAnswerResult.
 *
 * Implements real streaming with onToken, structured runtime events (ChatEvent),
 * cancellation support, timeouts, empty-response detection, duplicate token prevention,
 * and retry with backoff.
 */
export async function executeChatTurn(
  question: string,
  options: ChatAnswerOptions = {}
): Promise<ChatAnswerResult> {
  const projectName = options.projectName || 'this project';
  const intent: AssistantIntent = options.intent || 'general';
  const model = options.model || FAST_CHAT_MODEL;
  const runId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // 1. Validate API Key
  const apiKey = resolveApiKey(options.apiKey);
  if (!apiKey) {
    const errorDetails = {
      kind: 'configuration' as const,
      message: 'No OpenRouter API key found. Please configure your API key in Settings.',
      retryable: false,
    };
    options.onEvent?.({
      type: 'message.failed',
      runId,
      error: errorDetails,
    });
    return { ok: false, error: errorDetails, intent };
  }

  // 2. Build Messages
  const systemPrompt = buildSystemPrompt(projectName, options, intent);
  const validatedHistory: LLMMessage[] = (options.history || [])
    .filter((item) => item && typeof item.content === 'string' && item.content.trim())
    .map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: item.content.trim(),
    }));

  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    ...validatedHistory,
    { role: 'user', content: question.trim() },
  ];

  // 3. Setup Events & Signals
  options.onProgress?.('Thinking…');
  options.onEvent?.({ type: 'message.started', runId, intent });
  options.onEvent?.({ type: 'agent.thinking', runId, detail: 'Thinking…' });

  const maxRetries = options.maxRetries ?? 2;
  const timeoutMs = options.timeoutMs ?? 45000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options.signal?.aborted) {
      options.onEvent?.({ type: 'run.cancelled', runId });
      return {
        ok: false,
        error: { kind: 'cancelled', message: 'Generation stopped.', retryable: false },
        intent,
      };
    }

    try {
      // Create timeout signal combined with caller signal
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = options.signal
        ? (AbortSignal.any ? AbortSignal.any([options.signal, timeoutSignal]) : options.signal)
        : timeoutSignal;

      let fullText = '';
      let lastToken = '';

      // Stream with duplicate token prevention
      const streamedText = await callLLMTextStreaming(
        messages,
        (token: string) => {
          if (!token) return;
          // Prevent identical consecutive duplicate token bursts
          if (token === lastToken && token.length > 20) return;
          lastToken = token;
          fullText += token;
          options.onToken?.(token);
          options.onEvent?.({ type: 'message.delta', runId, token });
        },
        {
          model,
          apiKey,
          temperature: 0.35,
          maxTokens: 1200,
          signal: combinedSignal,
          allowFallback: false,
        }
      );

      const reply = (fullText || streamedText).trim();

      // Detect empty response
      if (!reply) {
        throw new ChatError({
          kind: 'empty',
          message: 'The model returned an empty response. Please retry.',
          retryable: true,
        });
      }

      options.onEvent?.({ type: 'message.completed', runId });
      return {
        ok: true,
        text: reply,
        intent,
        model,
      };
    } catch (err) {
      // Aborted / Cancelled check
      if (options.signal?.aborted || isAbortError(err)) {
        options.onEvent?.({ type: 'run.cancelled', runId });
        return {
          ok: false,
          error: { kind: 'cancelled', message: 'Generation stopped.', retryable: false },
          intent,
        };
      }

      const classified = classifyChatError(err, options.signal);

      // Check if retryable and attempts remain
      if (classified.retryable && attempt < maxRetries) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 4000);
        options.onRetry?.(`Connection issue (${classified.message}). Retrying in ${Math.round(backoffMs / 1000)}s…`);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      // Final failure
      options.onEvent?.({ type: 'message.failed', runId, error: classified });
      return {
        ok: false,
        error: {
          kind: classified.kind,
          message: classified.message,
          status: classified.status,
          retryable: classified.retryable,
        },
        intent,
      };
    }
  }

  // Exceeded retries
  const timeoutError = {
    kind: 'timeout' as const,
    message: 'The model did not respond in time. Please try again with a faster model.',
    retryable: true,
  };
  options.onEvent?.({ type: 'message.failed', runId, error: timeoutError });
  return { ok: false, error: timeoutError, intent };
}

/**
 * Answer a general (non-build) chat question.
 *
 * Upgraded implementation:
 * - Eliminates silent fallback to canned text for missing keys, errors, or empty responses.
 * - Streams tokens progressively via `onToken`.
 * - Throws a typed `ChatError` on failure so UI displays actionable error states.
 * - Preserves AbortSignal cancellation semantics.
 */
export async function answerGeneralQuestion(
  question: string,
  options: ChatAnswerOptions = {}
): Promise<string> {
  const result = await executeChatTurn(question, options);

  if (result.ok) {
    return result.text;
  }

  throw new ChatError(result.error);
}
