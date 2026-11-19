import { supabase } from '../services/supabase';
import type { AgentContext, AgentGenerationOptions, AgentGenerationResult } from './types';

export interface EngineerEvent {
  seq: number; runId: string; type: string; at: number; content?: string; message?: string;
  status?: string; tool?: string; callId?: string; summary?: string; ok?: boolean;
  path?: string; action?: 'created' | 'modified' | 'deleted'; durationMs?: number;
}
export interface EngineerStatus {
  threadId: string; runId: string; status: string; summary?: string; error?: string;
  approval?: { id: string; reason: string; calls: Array<{ name: string; args: unknown }> };
  changedFiles: Array<{ path: string; action: 'created' | 'modified' | 'deleted' }>;
  verification?: { passed: boolean; summary: string; steps?: Array<{ command: string; status: 'passed' | 'failed' | 'skipped' }> };
  preview?: { status: string; url: string | null; logs: string[] } | null;
  specialistReports?: Array<{ role: 'planner' | 'reviewer'; status: string; summary: string }>;
  usage?: { modelCalls: number; toolCalls: number };
}
export class EngineerRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function headers() {
  const { data } = await supabase.auth.getSession();
  return { 'Content-Type': 'application/json', ...(data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {}) };
}
const endpoint = (id: string, operation: string) => `/api/platform/engine/projects/${encodeURIComponent(id)}/${operation}`;
export async function engineerRequest<T>(projectId: string, operation: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(endpoint(projectId, operation), {
    method: body === undefined ? 'GET' : 'POST', headers: await headers(), signal,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({ error: 'The engine returned an invalid response. Check that the backend is running.' }));
  if (!response.ok) throw new EngineerRequestError(result.error?.message ?? result.error ?? `Engineer request failed (${response.status})`, response.status);
  return result as T;
}

/** Handles UTF-8 and SSE frames split across arbitrary network chunks. */
export async function readEngineerEvents(body: ReadableStream<Uint8Array>, onEvent: (event: EngineerEvent) => void, signal?: AbortSignal) {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) onEvent(JSON.parse(data) as EngineerEvent);
      }
      if (buffer.length > 1_000_000) throw new Error('Execution event exceeded the transport limit.');
    }
  } finally { signal?.removeEventListener('abort', cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export async function streamEngineerEvents(projectId: string, after: number, onEvent: (event: EngineerEvent) => void, signal: AbortSignal) {
  const response = await fetch(endpoint(projectId, `events?after=${after}`), { headers: await headers(), signal });
  if (!response.ok || !response.body) throw new EngineerRequestError('Execution stream is unavailable.', response.status);
  await readEngineerEvents(response.body, onEvent, signal);
}
export async function executeEngineer(prompt: string, context: AgentContext, options: AgentGenerationOptions & { onToken?: (token: string) => void; onEngineEvent?: (event: EngineerEvent) => void }): Promise<AgentGenerationResult> {
  const projectId = context.projectId;
  if (!projectId) throw new Error('A persistent project ID is required.');
  options.signal?.throwIfAborted();
  const run = await engineerRequest<{ runId: string }>(projectId, 'run', { prompt, files: context.files ?? [] }, options.signal);
  const streamAbort = new AbortController(); let cursor = 0;
  // Reconnect/replay by cursor. Status polling is the authoritative terminal condition.
  const listen = async () => {
    while (!streamAbort.signal.aborted) {
      try {
        await streamEngineerEvents(projectId, cursor, event => {
          if (event.seq <= cursor) return; cursor = event.seq;
          if (event.runId !== run.runId) return;
          options.onEngineEvent?.(event);
          if (event.type === 'token' && event.content) options.onToken?.(event.content);
          if (['progress', 'status', 'tool_start', 'tool_end'].includes(event.type)) {
            const message = event.message ?? event.summary ?? (event.tool ? `${event.type === 'tool_start' ? 'Running' : 'Finished'} ${event.tool.replaceAll('_', ' ')}` : `Engineer: ${event.status}`);
            options.onProgress?.(message); options.onEvent?.({ phase: event.status ?? event.type, message });
          }
        }, streamAbort.signal);
      } catch { /* Reconnect without failing the durable run. */ }
      if (!streamAbort.signal.aborted) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  };
  const listening = listen();
  const cancel = () => { void engineerRequest(projectId, 'cancel', {}).catch(() => undefined); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    let state: EngineerStatus;
    for (;;) {
      options.signal?.throwIfAborted();
      state = await engineerRequest<EngineerStatus>(projectId, 'state', undefined, options.signal);
      if (state.runId !== run.runId) throw new Error('This execution was replaced by another run.');
      if (['completed', 'failed', 'cancelled'].includes(state.status)) break;
      if (state.status === 'interrupted') throw new Error('Execution interrupted. Resume from the execution controls.');
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    const snapshot = await engineerRequest<{ files: Array<{ path: string; content: string }> }>(projectId, 'files');
    const contents = new Map(snapshot.files.map(f => [f.path, f.content]));
    const files = state.changedFiles.map(f => ({ ...f, content: contents.get(f.path) ?? '', language: f.path.endsWith('.dart') ? 'dart' : 'text' }));
    for (const file of files) options.onFile?.({ ...file, node: 'engineer' });
    return { success: state.status === 'completed', files,
      summary: state.error ?? state.summary ?? `Execution ${state.status}.`,
      verification: { verified: state.verification?.passed === true, gates: state.verification ? [{ id: 'execution', status: state.verification.passed ? 'pass' : 'fail', detail: state.verification.summary }] : [] } };
  } finally { options.signal?.removeEventListener('abort', cancel); streamAbort.abort(); await listening; }
}
