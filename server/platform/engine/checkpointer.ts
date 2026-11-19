/**
 * Durable LangGraph checkpointing.
 *
 * Production prefers PostgreSQL; the desktop build falls back to SQLite, which
 * keeps threads resumable across process restarts without external services.
 * MemorySaver is only used when neither driver can be loaded (for example a
 * restricted runtime), and the caller is told which backend is active.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

export type CheckpointerKind = 'postgres' | 'sqlite' | 'memory';

export interface CheckpointerSelection {
  saver: BaseCheckpointSaver;
  kind: CheckpointerKind;
  detail: string;
}

export interface CheckpointerOptions {
  dataDir: string;
  databaseUrl?: string;
  /** Injected in tests. */
  checkpointer?: BaseCheckpointSaver;
}

export async function createEngineCheckpointer(options: CheckpointerOptions): Promise<CheckpointerSelection> {
  if (options.checkpointer) {
    return { saver: options.checkpointer, kind: 'memory', detail: 'injected checkpointer' };
  }

  const databaseUrl = options.databaseUrl
    ?? process.env.FLUTTERFORGE_POSTGRES_URL
    ?? process.env.DATABASE_URL
    ?? process.env.POSTGRES_URL;
  if (databaseUrl) {
    try {
      const mod = await import('@langchain/langgraph-checkpoint-postgres');
      const saver = mod.PostgresSaver.fromConnString(databaseUrl, {
        schema: process.env.FLUTTERFORGE_CHECKPOINT_SCHEMA || 'public',
      });
      await saver.setup();
      return { saver, kind: 'postgres', detail: 'postgres checkpoint store' };
    } catch (error) {
      // Explicit production persistence configuration must never silently degrade.
      throw new Error('Configured PostgreSQL checkpoint store is unavailable.', { cause: error });
    }
  }

  try {
    const dir = path.join(options.dataDir, 'engine');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'checkpoints.sqlite');
    const saver = SqliteSaver.fromConnString(file);
    return { saver, kind: 'sqlite', detail: `sqlite checkpoint store at ${file}` };
  } catch (error) {
    throw new Error('Durable SQLite checkpoint store is unavailable.', { cause: error });
  }
}
