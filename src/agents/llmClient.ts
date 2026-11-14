/**
 * LLM Client — robust OpenRouter/OpenAI-compatible caller for all pipeline agents.
 * Features: multi-key pool rotation, automatic model failover, JSON & text modes, streaming.
 */
import { keyPool } from '../agent/keyPool';

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
}

export interface LLMResponse {
  content: string;
  model: string;
  tokens: { prompt: number; completion: number };
}

// Configured model from environment or fallback
const ENV_MODEL = (typeof import.meta !== 'undefined' ? (import.meta.env?.VITE_AGENT_MODEL as string) : '') || '';

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

function getCandidateModels(requestedModel?: string): string[] {
  const models: string[] = [];
  if (requestedModel?.trim()) models.push(requestedModel.trim());
  for (const m of AGENT_MODELS.frontier) {
    if (!models.includes(m)) models.push(m);
  }
  for (const m of AGENT_MODELS.economy) {
    if (!models.includes(m)) models.push(m);
  }
  return models;
}

/**
 * Streaming completions with SSE.
 */
async function callLLMStreaming(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  onToken: (token: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const streamBody = { ...body, stream: true };
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(streamBody),
    signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`LLM call failed [${res.status}]: ${errText.slice(0, 200)}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body for streaming');
  const decoder = new TextDecoder();
  let fullContent = '';
  let buffer = '';
  try {
    while (true) {
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
            fullContent += token;
            onToken(token);
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
 */
export async function callLLM(
  messages: LLMMessage[],
  options: LLMCallOptions = {}
): Promise<LLMResponse> {
  const candidateKeys = getCandidateKeys(options.apiKey);
  const candidateModels = getCandidateModels(options.model);
  const maxTokens = options.maxTokens ?? 6000;
  const temperature = options.temperature ?? 0.25;

  let lastError: Error | null = null;

  // Try each model candidate
  for (const model of candidateModels) {
    // For each model, try available keys with rotation
    const keysToTry = candidateKeys.length > 0 ? candidateKeys : [''];

    for (let i = 0; i < keysToTry.length; i++) {
      const key = keysToTry[i];

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
      if (key) {
        headers['Authorization'] = `Bearer ${key}`;
      }

      try {
        if (options.onToken) {
          const content = await callLLMStreaming(
            'https://openrouter.ai/api/v1/chat/completions',
            headers,
            body,
            options.onToken,
            options.signal
          );
          if (key) keyPool.markSuccess(key);
          return { content, model, tokens: { prompt: 0, completion: 0 } };
        }

        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: options.signal,
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => res.statusText);
          const errorMsg = `LLM call failed [${res.status}]: ${errText.slice(0, 200)}`;

          // If rate limited or auth issue, mark key failed and try next key
          if (res.status === 429 || res.status === 401 || res.status === 402 || res.status >= 500) {
            if (key) keyPool.markFailure(key, errorMsg);
            lastError = new Error(errorMsg);
            continue; // try next key
          }

          // If bad model (404/400), break key loop to try next model
          lastError = new Error(errorMsg);
          break;
        }

        const data = (await res.json()) as {
          choices: Array<{ message: { content: string } }>;
          model: string;
          usage?: { prompt_tokens: number; completion_tokens: number };
        };

        const content = data.choices?.[0]?.message?.content ?? '';
        if (key) keyPool.markSuccess(key);

        return {
          content,
          model: data.model || model,
          tokens: {
            prompt: data.usage?.prompt_tokens ?? 0,
            completion: data.usage?.completion_tokens ?? 0,
          },
        };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError' || error.message.includes('abort') || error.message.includes('cancel')) {
          throw error;
        }
        if (key) keyPool.markFailure(key, error.message);
        lastError = error;
      }
    }
  }

  throw lastError ?? new Error('All LLM models and keys failed. Please check your OpenRouter API key.');
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
