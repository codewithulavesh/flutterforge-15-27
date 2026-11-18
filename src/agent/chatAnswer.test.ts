// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerGeneralQuestion, executeChatTurn, FAST_CHAT_MODEL } from './chatAnswer';
import { ChatError, type ChatEvent } from './chatTypes';

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index++]));
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('answerGeneralQuestion & executeChatTurn', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('streams tokens progressively and emits structured chat events', async () => {
    const fetchMock = vi.fn(async (_url?: string, _init?: RequestInit) => sseResponse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" from"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" FlutterForge"}}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const tokens: string[] = [];
    const events: ChatEvent[] = [];

    const result = await executeChatTurn('What is Supabase?', {
      apiKey: 'test-key',
      projectName: 'Demo',
      onToken: (token) => tokens.push(token),
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('Hello from FlutterForge');
      expect(result.model).toBe(FAST_CHAT_MODEL);
    }
    expect(tokens).toEqual(['Hello', ' from', ' FlutterForge']);

    // Verifies structured runtime events
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('message.started');
    expect(eventTypes).toContain('agent.thinking');
    expect(eventTypes).toContain('message.delta');
    expect(eventTypes).toContain('message.completed');
  });

  it('throws a typed configuration error when API key is missing (no silent localFallback)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // executeChatTurn returns typed result
    const result = await executeChatTurn('How do I add auth?', {
      apiKey: '',
      projectName: 'Habit Tracker',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('configuration');
      expect(result.error.message).toContain('No OpenRouter API key');
      expect(result.error.retryable).toBe(false);
    }

    // answerGeneralQuestion throws typed ChatError
    await expect(
      answerGeneralQuestion('How do I add auth?', { apiKey: '', projectName: 'Habit Tracker' })
    ).rejects.toThrow(ChatError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates a typed empty response error when model returns nothing', async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":""}}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeChatTurn('Explain BLoC', {
      apiKey: 'test-key',
      projectName: 'Demo',
      maxRetries: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('empty');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('classifies provider HTTP 429 as a retryable provider error', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'Rate limit reached' } }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeChatTurn('Explain Flutter isolates', {
      apiKey: 'test-key',
      projectName: 'Demo',
      maxRetries: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('provider');
      expect(result.error.status).toBe(429);
      expect(result.error.retryable).toBe(true);
    }
  });

  it('preserves cancellation and marks as cancelled, not a provider error', async () => {
    const controller = new AbortController();
    controller.abort();

    const events: ChatEvent[] = [];
    const result = await executeChatTurn('Explain Riverpod', {
      apiKey: 'test-key',
      projectName: 'Demo',
      signal: controller.signal,
      onEvent: (e) => events.push(e),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('cancelled');
      expect(result.error.message).toContain('stopped');
    }
    expect(events.map((e) => e.type)).toContain('run.cancelled');
  });

  it('prevents consecutive duplicate bursts in token streaming', async () => {
    const longChunk = 'This is a long repetitive chunk of tokens generated';
    const fetchMock = vi.fn(async () => sseResponse([
      `data: {"choices":[{"delta":{"content":"${longChunk}"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"${longChunk}"}}]}\n\n`, // duplicated chunk
      'data: {"choices":[{"delta":{"content":" continuing normally"}}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const tokens: string[] = [];
    const result = await executeChatTurn('Test query', {
      apiKey: 'test-key',
      onToken: (t) => tokens.push(t),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe(`${longChunk} continuing normally`);
    }
    // Duplicate longChunk was filtered out
    expect(tokens.filter((t) => t === longChunk).length).toBe(1);
  });
});
