/**
 * Idempotency keys for non-idempotent HTTP operations (workflow start, patch
 * apply). Two concurrent requests with the same key must not create two runs;
 * the unique index in `idempotency_keys` is the arbiter, and the loser reads
 * the winner's stored response.
 */
import { sha256Hex } from '../kernel/hash.js';
import type { Clock } from '../kernel/clock.js';
import { systemClock } from '../kernel/clock.js';
import type { Database } from './database.js';

export interface IdempotencyRecord<T> {
  scope: string;
  key: string;
  value: T;
  createdAt: number;
  expiresAt: number;
}

export class IdempotencyStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Normalize the caller-provided key into a stable, bounded value. */
  static key(raw: string): string {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) throw new Error('Idempotency key must not be empty.');
    if (trimmed.length > 512) throw new Error('Idempotency key is too long (max 512).');
    return sha256Hex(trimmed);
  }

  async get<T>(scope: string, key: string): Promise<IdempotencyRecord<T> | null> {
    const row = await this.db.get<{
      scope: string;
      key: string;
      value_json: string;
      created_at: number;
      expires_at: number;
    }>('SELECT * FROM idempotency_keys WHERE scope = ? AND key = ?', scope, key);
    if (!row) return null;
    if (row.expires_at <= this.clock.now()) {
      await this.db.run('DELETE FROM idempotency_keys WHERE scope = ? AND key = ?', scope, key);
      return null;
    }
    return {
      scope: row.scope,
      key: row.key,
      value: JSON.parse(row.value_json) as T,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Store `value` unless the key already exists. Returns the effective record
   * (the existing one wins) and whether this call inserted it.
   */
  async put<T>(scope: string, key: string, value: T, ttlMs: number): Promise<{ record: IdempotencyRecord<T>; created: boolean }> {
    const now = this.clock.now();
    const expiresAt = now + Math.max(1000, ttlMs);
    const result = await this.db.run(
      `INSERT INTO idempotency_keys (scope, key, value_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (scope, key) DO NOTHING`,
      scope,
      key,
      JSON.stringify(value),
      now,
      expiresAt,
    );
    if (result.changes > 0) {
      return { record: { scope, key, value, createdAt: now, expiresAt }, created: true };
    }
    const existing = await this.get<T>(scope, key);
    if (!existing) {
      // Extremely narrow race: the row expired between insert and read.
      return this.put(scope, key, value, ttlMs);
    }
    return { record: existing, created: false };
  }

  async purgeExpired(limit = 1000): Promise<number> {
    const result = await this.db.run(
      'DELETE FROM idempotency_keys WHERE expires_at <= ? LIMIT ?',
      this.clock.now(),
      limit,
    );
    return result.changes;
  }
}
