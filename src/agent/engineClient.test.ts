import { describe, it, expect, vi } from 'vitest';
import { readEngineerEvents, engineerRequest, EngineerRequestError } from './engineClient';
vi.mock('../services/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }));
describe('engine transport', () => {
  it('decodes split UTF-8 and fragmented SSE without fabricating events', async () => {
    const bytes = new TextEncoder().encode(': heartbeat\n\nid: 1\ndata: {"seq":1,"type":"token","content":"hello 🌍"}\n\nid: 2\ndata: {"seq":2,"type":"tool_end","ok":false}\n\n');
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
    const events: unknown[] = []; await readEngineerEvents(stream, event => events.push(event));
    expect(events).toEqual([{ seq: 1, type: 'token', content: 'hello 🌍' }, { seq: 2, type: 'tool_end', ok: false }]);
  });
  it('keeps backend errors and HTTP status actionable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Execution is paused.' } }), { status: 409 })));
    try { await expect(engineerRequest('p', 'run', { prompt: 'hi' })).rejects.toEqual(new EngineerRequestError('Execution is paused.', 409)); }
    finally { vi.unstubAllGlobals(); }
  });
});
