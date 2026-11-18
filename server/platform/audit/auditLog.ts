/**
 * Hash-chained audit trail.
 *
 * Each entry commits to its predecessor, so an attacker who edits or deletes a
 * row breaks verification from that point forward. Entries are append-only at
 * the repository level: there is intentionally no update or delete API except
 * tenant-scoped retention, which records a tombstone first.
 */
import { contentHash, sha256Hex } from '../kernel/hash.js';
import { prefixedId } from '../kernel/ids.js';
import type { Clock } from '../kernel/clock.js';
import { systemClock } from '../kernel/clock.js';
import type { Database } from '../storage/database.js';

export const GENESIS_HASH = sha256Hex('flutterforge:audit:genesis');

export interface AuditEntryInput {
  tenantId: string;
  actor: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditEntry {
  seq: number;
  entryId: string;
  tenantId: string;
  actor: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata: Record<string, unknown>;
  prevHash: string;
  hash: string;
  createdAt: number;
}

export interface AuditVerification {
  ok: boolean;
  checked: number;
  firstBadSeq?: number;
  reason?: string;
  headHash: string;
}

interface AuditRow {
  seq: number;
  entry_id: string;
  tenant_id: string;
  actor: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata_json: string;
  prev_hash: string;
  hash: string;
  created_at: number;
}

function hashEntry(entry: Omit<AuditEntry, 'hash' | 'seq'>): string {
  return contentHash({
    entryId: entry.entryId,
    tenantId: entry.tenantId,
    actor: entry.actor,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    metadata: entry.metadata,
    prevHash: entry.prevHash,
    createdAt: entry.createdAt,
  });
}

export class AuditLog {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  async append(input: AuditEntryInput): Promise<AuditEntry> {
    if (!input.tenantId || !input.actor || !input.action || !input.resourceType) {
      throw new Error('Audit entries require tenantId, actor, action and resourceType.');
    }

    return this.db.transaction(async (tx) => {
      const head = await tx.get<{ hash: string }>(
        'SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1',
      );
      const prevHash = head?.hash ?? GENESIS_HASH;
      const entryId = prefixedId('audit', this.clock.now());
      const createdAt = this.clock.now();
      const entry: Omit<AuditEntry, 'hash' | 'seq'> = {
        entryId,
        tenantId: input.tenantId,
        actor: input.actor,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        metadata: input.metadata ?? {},
        prevHash,
        createdAt,
      };
      const hash = hashEntry(entry);
      const result = await tx.run(
        `INSERT INTO audit_log
           (entry_id, tenant_id, actor, action, resource_type, resource_id, metadata_json, prev_hash, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        entry.entryId,
        entry.tenantId,
        entry.actor,
        entry.action,
        entry.resourceType,
        entry.resourceId ?? null,
        JSON.stringify(entry.metadata),
        entry.prevHash,
        hash,
        entry.createdAt,
      );
      return { ...entry, seq: result.lastInsertRowid, hash };
    });
  }

  async verify(options: { tenantId?: string; limit?: number } = {}): Promise<AuditVerification> {
    const limit = Math.min(100_000, Math.max(1, options.limit ?? 10_000));
    const rows = options.tenantId
      ? await this.db.all<AuditRow>(
        'SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY seq ASC LIMIT ?',
        options.tenantId,
        limit,
      )
      : await this.db.all<AuditRow>('SELECT * FROM audit_log ORDER BY seq ASC LIMIT ?', limit);

    let previous = GENESIS_HASH;
    let headHash = GENESIS_HASH;
    let checked = 0;

    for (const row of rows) {
      checked += 1;
      const metadata = safeParse(row.metadata_json);
      if (metadata === null) {
        return { ok: false, checked, firstBadSeq: row.seq, reason: 'metadata is not valid JSON', headHash };
      }
      if (row.prev_hash !== previous) {
        return {
          ok: false,
          checked,
          firstBadSeq: row.seq,
          reason: 'previous-hash linkage is broken',
          headHash,
        };
      }
      const expected = hashEntry({
        entryId: row.entry_id,
        tenantId: row.tenant_id,
        actor: row.actor,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id ?? undefined,
        metadata,
        prevHash: row.prev_hash,
        createdAt: row.created_at,
      });
      if (expected !== row.hash) {
        return { ok: false, checked, firstBadSeq: row.seq, reason: 'entry hash does not match its contents', headHash };
      }
      previous = row.hash;
      headHash = row.hash;
    }

    return { ok: true, checked, headHash };
  }

  async list(options: { tenantId?: string; limit?: number; afterSeq?: number } = {}): Promise<AuditEntry[]> {
    const limit = Math.min(1000, Math.max(1, options.limit ?? 100));
    const after = Math.max(0, options.afterSeq ?? 0);
    const rows = options.tenantId
      ? await this.db.all<AuditRow>(
        'SELECT * FROM audit_log WHERE tenant_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
        options.tenantId,
        after,
        limit,
      )
      : await this.db.all<AuditRow>('SELECT * FROM audit_log WHERE seq > ? ORDER BY seq ASC LIMIT ?', after, limit);
    return rows.map(mapRow);
  }

  async head(): Promise<{ seq: number; hash: string } | null> {
    const row = await this.db.get<{ seq: number; hash: string }>(
      'SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1',
    );
    return row ?? null;
  }
}

function safeParse(json: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mapRow(row: AuditRow): AuditEntry {
  return {
    seq: row.seq,
    entryId: row.entry_id,
    tenantId: row.tenant_id,
    actor: row.actor,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id ?? undefined,
    metadata: safeParse(row.metadata_json) ?? {},
    prevHash: row.prev_hash,
    hash: row.hash,
    createdAt: row.created_at,
  };
}
