/**
 * SQLite access layer.
 *
 * The control plane needs durability without asking operators to run
 * PostgreSQL for a desktop-first product. `node:sqlite` ships with Node 22+,
 * so the platform gets WAL journaling, real transactions and prepared
 * statements with zero native dependencies. The schema and repository
 * boundaries keep a PostgreSQL adapter a later swap, not a rewrite.
 *
 * Rules enforced here:
 *  - WAL + `synchronous=NORMAL` for crash safety without fsync-per-write.
 *  - `BEGIN IMMEDIATE` for write transactions to fail fast on contention.
 *  - Bounded retries on SQLITE_BUSY/LOCKED with jittered backoff.
 *  - Every statement parameterized; no string interpolation of values.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { InternalError, PlatformError, sleep } from '../kernel/errors.js';

export interface DatabaseOptions {
  readonly file: string;
  readonly readOnly?: boolean;
  readonly busyTimeoutMs?: number;
  readonly verbose?: boolean;
}

export interface Migration {
  readonly id: string;
  readonly up: string;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

const MAX_BUSY_ATTEMPTS = 5;
const BUSY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED']);

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const message = (error as { message?: unknown })?.message;
  return (typeof code === 'string' && BUSY_CODES.has(code))
    || (typeof message === 'string' && /database is locked|SQLITE_BUSY/i.test(message));
}

export class Database {
  readonly file: string;
  private readonly handle: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly verbose: boolean;
  private closed = false;
  private transactionQueue: Promise<unknown> = Promise.resolve();

  constructor(options: DatabaseOptions) {
    this.file = options.file;
    this.verbose = options.verbose ?? false;
    this.handle = new DatabaseSync(options.file, { readOnly: options.readOnly ?? false });
    this.handle.exec(`PRAGMA busy_timeout = ${Math.max(0, options.busyTimeoutMs ?? 5000)}`);
    if (!options.readOnly) {
      this.handle.exec('PRAGMA journal_mode = WAL');
      this.handle.exec('PRAGMA synchronous = NORMAL');
      this.handle.exec('PRAGMA temp_store = MEMORY');
      this.handle.exec('PRAGMA wal_autocheckpoint = 1000');
    }
    this.handle.exec('PRAGMA foreign_keys = ON');
  }

  static async open(options: DatabaseOptions): Promise<Database> {
    if (options.file !== ':memory:') {
      await fs.mkdir(path.dirname(options.file), { recursive: true });
    }
    return new Database(options);
  }

  get inTransaction(): boolean {
    return this.transactionDepth > 0;
  }

  private statement(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const prepared = this.handle.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  private async retryBusy<T>(operation: () => T): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_BUSY_ATTEMPTS; attempt += 1) {
      try {
        return operation();
      } catch (error) {
        lastError = error;
        if (!isBusy(error) || attempt === MAX_BUSY_ATTEMPTS - 1) throw error;
        await sleep(15 * 2 ** attempt + Math.random() * 25);
      }
    }
    throw lastError;
  }

  exec(sql: string): void {
    this.assertOpen();
    if (this.verbose) process.stderr.write(`[sqlite] ${sql.replace(/\s+/g, ' ').slice(0, 240)}\n`);
    this.handle.exec(sql);
  }

  run(sql: string, ...params: unknown[]): Promise<RunResult> {
    this.assertOpen();
    return this.retryBusy(() => {
      const result = this.statement(sql).run(...(params as never[]));
      return {
        changes: Number(result.changes ?? 0),
        lastInsertRowid: Number(result.lastInsertRowid ?? 0),
      };
    });
  }

  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    this.assertOpen();
    return this.retryBusy(() => {
      const row = this.statement(sql).get(...(params as never[]));
      return row === undefined ? undefined : ({ ...(row as Record<string, unknown>) } as T);
    });
  }

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    this.assertOpen();
    return this.retryBusy(() => {
      const rows = this.statement(sql).all(...(params as never[]));
      return rows.map((row) => ({ ...(row as Record<string, unknown>) }) as T);
    });
  }

  /**
   * Write transaction. Nested calls become savepoints, so repositories can
   * compose without knowing whether they are already inside a transaction.
   * Top-level transactions are serialized through a FIFO queue: two callers
   * must never interleave statements on the shared connection (one caller's
   * COMMIT would otherwise commit the other's unfinished work).
   */
  transaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.transactionDepth > 0) {
      // Already inside a transaction on this connection — run inline as a savepoint.
      return this.runTransaction(work);
    }
    const task = this.transactionQueue.then(() => this.runTransaction(work));
    // Keep the queue alive even when a transaction fails; the caller sees the error.
    this.transactionQueue = task.catch(() => undefined);
    return task;
  }

  private transactionDepth = 0;

  private async runTransaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const depth = this.transactionDepth;
    const savepoint = `sp_${depth}`;
    this.transactionDepth += 1;
    const context: TransactionContext = {
      run: (sql, ...params) => this.run(sql, ...params),
      get: (sql, ...params) => this.get(sql, ...params),
      all: (sql, ...params) => this.all(sql, ...params),
      exec: (sql) => this.exec(sql),
    };

    try {
      this.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      const result = await work(context);
      this.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      try {
        this.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`);
        if (depth > 0) this.exec(`RELEASE ${savepoint}`);
      } catch (rollbackError) {
        // A failed rollback means the connection is unusable; surface that,
        // not the original error, because durability is now in question.
        throw new InternalError('Transaction rollback failed; the database connection is unsafe.', rollbackError);
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  async migrate(migrations: readonly Migration[], options: { onApply?: (migration: Migration) => void } = {}): Promise<string[]> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const applied = new Set((await this.all<{ id: string }>('SELECT id FROM schema_migrations')).map((row) => row.id));
    const pending = migrations.filter((migration) => !applied.has(migration.id));
    const now = new Date().toISOString();

    for (const migration of pending) {
      await this.transaction(async () => {
        this.exec(migration.up);
        await this.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', migration.id, now);
      });
      options.onApply?.(migration);
    }
    return pending.map((migration) => migration.id);
  }

  async integrityCheck(): Promise<{ ok: boolean; detail: string }> {
    const row = await this.get<{ integrity_check: string }>('PRAGMA integrity_check');
    const detail = row?.integrity_check ?? 'unknown';
    return { ok: detail === 'ok', detail };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    try {
      this.handle.close();
    } catch {
      /* already closed */
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new PlatformError({ code: 'DATABASE_CLOSED', message: 'The database connection is closed.', statusCode: 500 });
  }
}

export interface TransactionContext {
  run(sql: string, ...params: unknown[]): Promise<RunResult>;
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  exec(sql: string): void;
}

let shared: Promise<Database> | null = null;

/** Process-wide handle used by the HTTP layer. Tests open isolated databases. */
export function getPlatformDatabase(file: string): Promise<Database> {
  if (!shared) {
    shared = Database.open({ file }).then(async (db) => {
      const { PLATFORM_MIGRATIONS } = await import('./schema.js');
      await db.migrate(PLATFORM_MIGRATIONS);
      return db;
    });
  }
  return shared;
}

export async function closePlatformDatabase(): Promise<void> {
  if (!shared) return;
  const db = await shared.catch(() => null);
  shared = null;
  db?.close();
}
