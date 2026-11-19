/**
 * LangChain model adapter for the single engineer.
 *
 * This is the only place the autonomous runtime constructs a model. It keeps
 * FlutterForge's existing provider semantics (OpenRouter / DeepSeek / any
 * OpenAI-compatible endpoint) but moves the call into LangChain so tools,
 * tracing, retries and token accounting are handled uniformly.
 */
import { ChatOpenAI, type ChatOpenAICallOptions } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { EngineerModelConfig } from './types.js';

import { configuredKeys, ServerKeyPool } from './keyPool.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const DEEPSEEK_BASE = 'https://api.deepseek.com';
const OPENAI_BASE = 'https://api.openai.com/v1';

const DEFAULT_MODELS: Record<EngineerModelConfig['provider'], string> = {
  openrouter: 'nvidia/nemotron-3.5-lightning:free',
  deepseek: 'deepseek-chat',
  'openai-compatible': 'gpt-4o-mini',
};

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function resolveModelConfig(env: NodeJS.ProcessEnv = process.env, overrideModel?: string): EngineerModelConfig | null {
  const requested = envValue(env, 'FLUTTERFORGE_LLM_PROVIDER')?.toLowerCase();
  const provider: EngineerModelConfig['provider'] = requested === 'deepseek'
    ? 'deepseek'
    : requested === 'openai' || requested === 'openai-compatible'
      ? 'openai-compatible'
      : requested === 'openrouter'
        ? 'openrouter'
        : configuredKeys(env, 'openrouter').length
          ? 'openrouter'
          : configuredKeys(env, 'deepseek').length ? 'deepseek' : 'openrouter';

  const generic = envValue(env, 'FLUTTERFORGE_LLM_API_KEY');
  const apiKey = provider === 'openrouter'
    ? envValue(env, 'OPENROUTER_API_KEY') ?? generic
    : provider === 'deepseek'
      ? envValue(env, 'DEEPSEEK_API_KEY') ?? generic
      : generic;
  const apiKeys = configuredKeys(env, provider, apiKey);
  if (!apiKeys.length) return null;

  const baseUrl = provider === 'openrouter'
    ? OPENROUTER_BASE
    : provider === 'deepseek'
      ? DEEPSEEK_BASE
      : (envValue(env, 'FLUTTERFORGE_LLM_BASE_URL') ?? envValue(env, 'OPENAI_BASE_URL') ?? OPENAI_BASE).replace(/\/+$/, '');

  const configuredModel = overrideModel ?? envValue(env, 'FLUTTERFORGE_LLM_MODEL') ?? envValue(env, 'FLUTTERFORGE_ENGINE_MODEL') ?? DEFAULT_MODELS[provider];
  const fallbacks = (envValue(env, 'FLUTTERFORGE_LLM_FALLBACK_MODELS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== configuredModel);

  const headers: Record<string, string> = {};
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://flutterforge.app';
    headers['X-Title'] = 'FlutterForge Engineer';
  }

  return {
    provider,
    model: configuredModel,
    fallbackModels: fallbacks,
    apiKey: apiKeys[0],
    apiKeys,
    baseUrl,
    headers,
    timeoutMs: Number(envValue(env, 'FLUTTERFORGE_LLM_TIMEOUT_MS') ?? 120_000),
    maxRetries: Number(envValue(env, 'FLUTTERFORGE_LLM_MAX_RETRIES') ?? 2),
  };
}

function instantiate(config: EngineerModelConfig, model: string, pool: ServerKeyPool, maxTokens: number): BaseChatModel {
  return new ChatOpenAI({
    apiKey: config.apiKey,
    model,
    temperature: 0.2,
    maxTokens,
    timeout: Number.isFinite(config.timeoutMs) ? config.timeoutMs : 120_000,
    maxRetries: 0, // The pool bounds credential retries; do not retry an exhausted pool in the SDK.
    configuration: {
      baseURL: config.baseUrl,
      fetch: pool.fetch(),
      defaultHeaders: config.headers,
    },
  });
}

/**
 * Build the tool-bound chat model. Tool binding happens once; every reasoning
 * turn reuses the same bound runnable so provider state does not drift.
 */
export function createEngineerModel(config: EngineerModelConfig, tools: StructuredToolInterface[], pool = new ServerKeyPool(config.apiKeys ?? [config.apiKey]), maxTokens = 8192): BaseChatModel {
  const primary = instantiate(config, config.model, pool, maxTokens);
  const toolOptions: Partial<ChatOpenAICallOptions> = { parallel_tool_calls: false };
  const boundPrimary = tools.length > 0
    ? primary.bindTools(tools, toolOptions)
    : primary;
  if (config.fallbackModels.length === 0) return boundPrimary as unknown as BaseChatModel;

  const fallbacks = config.fallbackModels.map((model) => {
    const fallback = instantiate(config, model, pool, maxTokens);
    return tools.length > 0 ? fallback.bindTools(tools, toolOptions) : fallback;
  });
  return (boundPrimary as unknown as { withFallbacks: (input: unknown) => BaseChatModel })
    .withFallbacks(fallbacks) as unknown as BaseChatModel;
}

export function describeModel(config: EngineerModelConfig | null): string {
  if (!config) return 'unconfigured';
  return `${config.provider}:${config.model}`;
}

/** Extract token usage from a LangChain AIMessage without trusting provider-specific fields. */
export function readUsage(message: unknown): { promptTokens: number; completionTokens: number } {
  const record = message && typeof message === 'object' ? message as Record<string, unknown> : {};
  const usage = record.usage_metadata && typeof record.usage_metadata === 'object'
    ? record.usage_metadata as Record<string, unknown>
    : {};
  const meta = record.response_metadata && typeof record.response_metadata === 'object'
    ? record.response_metadata as Record<string, unknown>
    : {};
  const tokenUsage = meta.token_usage && typeof meta.token_usage === 'object'
    ? meta.token_usage as Record<string, unknown>
    : meta.usage && typeof meta.usage === 'object' ? meta.usage as Record<string, unknown> : {};
  const prompt = Number(usage.input_tokens ?? tokenUsage.prompt_tokens ?? meta.prompt_tokens ?? 0);
  const completion = Number(usage.output_tokens ?? tokenUsage.completion_tokens ?? meta.completion_tokens ?? 0);
  return {
    promptTokens: Number.isFinite(prompt) ? prompt : 0,
    completionTokens: Number.isFinite(completion) ? completion : 0,
  };
}
