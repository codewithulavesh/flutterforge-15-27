/**
 * Project-scoped long-term memory.
 *
 * Backed by the platform's existing `project_memory` table (SQLite locally,
 * PostgreSQL in production). Every read and write is scoped by tenant and
 * project, so two projects can never see each other's decisions.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from '../storage/database.js';
import type { MemoryEntry, MemoryPort } from './types.js';

export class ProjectMemoryStore implements MemoryPort {
  constructor(
    private readonly db: Database,
    private readonly tenantId: string,
  ) {}

  async list(projectId: string, limit = 20): Promise<MemoryEntry[]> {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await this.db.all<{
      id: string;
      kind: MemoryEntry['kind'];
      content: string;
      source: string;
      confidence: number;
      created_at: number;
    }>(
      `SELECT id, kind, content, source, confidence, created_at
         FROM project_memory
        WHERE tenant_id = ? AND project_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
      this.tenantId,
      projectId,
      bounded,
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      content: row.content,
      source: row.source,
      confidence: row.confidence,
      createdAt: row.created_at,
    }));
  }

  async put(projectId: string, entry: Pick<MemoryEntry, 'kind' | 'content' | 'source' | 'confidence'>): Promise<MemoryEntry> {
    const content = String(entry.content ?? '').trim();
    if (content === '') throw new Error('Memory content cannot be empty.');
    if (content.length > 4000) throw new Error('Memory content is limited to 4000 characters.');
    const confidence = Number.isFinite(entry.confidence) ? Math.max(0, Math.min(1, entry.confidence)) : 0.8;
    const now = Date.now();
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO project_memory (id, tenant_id, project_id, kind, content, source, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      this.tenantId,
      projectId,
      entry.kind,
      content,
      entry.source,
      confidence,
      now,
      now,
    );
    return { id, kind: entry.kind, content, source: entry.source, confidence, createdAt: now };
  }
}

/** Used by tests and by runtimes without a database. */
export class InMemoryProjectMemory implements MemoryPort {
  private readonly entries = new Map<string, MemoryEntry[]>();

  async list(projectId: string, limit = 20): Promise<MemoryEntry[]> {
    return [...(this.entries.get(projectId) ?? [])].slice(0, limit);
  }

  async put(projectId: string, entry: Pick<MemoryEntry, 'kind' | 'content' | 'source' | 'confidence'>): Promise<MemoryEntry> {
    const record: MemoryEntry = { id: randomUUID(), ...entry, createdAt: Date.now() };
    const list = this.entries.get(projectId) ?? [];
    list.unshift(record);
    this.entries.set(projectId, list.slice(0, 100));
    return record;
  }
}
