/**
 * Durable event stream for engine runs.
 *
 * Events are emitted synchronously (so graph nodes never block on disk) and
 * persisted in order per thread. SSE handlers replay from the database and then
 * subscribe to live events, so a reconnect or process restart does not lose the
 * execution record.
 */
import type { Database } from '../storage/database.js';
import type { EngineEvent } from './types.js';

export class EngineEventBus {
  private readonly sequences = new Map<string, number>();
  private readonly ring = new Map<string, EngineEvent[]>();
  private readonly subscribers = new Map<string, Set<(event: EngineEvent) => void>>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Database | null,
    private readonly retain = 1000,
  ) {}

  async prime(threadId: string): Promise<void> {
    if (this.sequences.has(threadId)) return;
    let max = 0;
    if (this.db) {
      const row = await this.db.get<{ seq: number | null }>(
        'SELECT MAX(seq) AS seq FROM engine_events WHERE thread_id = ?',
        threadId,
      );
      max = Number(row?.seq ?? 0) || 0;
    }
    this.sequences.set(threadId, max);
  }

  publish(threadId: string, runId: string, input: Omit<EngineEvent, 'seq' | 'at'> & { type: string; [key: string]: unknown }): EngineEvent {
    const seq = (this.sequences.get(threadId) ?? 0) + 1;
    this.sequences.set(threadId, seq);
    const event: EngineEvent = { ...input, seq, threadId, runId, at: Date.now() } as EngineEvent;
    const buffer = this.ring.get(threadId) ?? [];
    buffer.push(event);
    if (buffer.length > this.retain) buffer.splice(0, buffer.length - this.retain);
    this.ring.set(threadId, buffer);

    for (const subscriber of this.subscribers.get(threadId) ?? []) {
      try {
        subscriber(event);
      } catch {
        // A broken SSE socket must not break the run.
      }
    }

    if (this.db) {
      const payload = JSON.stringify(event);
      this.writes = this.writes.then(() => this.db!.run(
        'INSERT INTO engine_events (thread_id, run_id, seq, type, payload_json, at) VALUES (?, ?, ?, ?, ?, ?)',
        threadId,
        runId,
        seq,
        event.type,
        payload,
        event.at,
      )).catch(() => undefined);
    }
    return event;
  }

  async history(threadId: string, after = 0, limit = 500): Promise<EngineEvent[]> {
    await this.writes;
    if (this.db) {
      const rows = await this.db.all<{ payload_json: string }>(
        'SELECT payload_json FROM engine_events WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
        threadId,
        Math.max(0, Math.floor(after)),
        Math.max(1, Math.min(2000, Math.floor(limit))),
      );
      if (rows.length > 0) {
        return rows.map((row) => JSON.parse(row.payload_json) as EngineEvent).filter((event) => event.seq > after);
      }
    }
    return (this.ring.get(threadId) ?? []).filter((event) => event.seq > after).slice(0, limit);
  }

  subscribe(threadId: string, callback: (event: EngineEvent) => void): () => void {
    const set = this.subscribers.get(threadId) ?? new Set();
    set.add(callback);
    this.subscribers.set(threadId, set);
    return () => {
      set.delete(callback);
      if (set.size === 0) this.subscribers.delete(threadId);
    };
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}
