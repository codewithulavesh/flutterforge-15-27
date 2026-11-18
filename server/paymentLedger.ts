/**
 * Durable idempotency ledger for Razorpay payment grants.
 *
 * Why this exists: a Razorpay `payment.captured` webhook and the browser's
 * `/api/payments/fulfill` call race each other for the same payment, and the
 * fulfill endpoint itself can be replayed. Without a durable record, either
 * path could grant plan credits twice (or N times).
 *
 * Design:
 * - Single-process, dependency-free. Entries are `{ paymentId, plan, userId,
 *   grantedAt }` records persisted to a JSON file inside the data directory.
 * - Writes are atomic (tmp file + rename) and serialized through a promise
 *   chain so concurrent grants in the same process cannot interleave.
 * - `grantOnce` deduplicates both concurrent (in-flight) and sequential
 *   (persisted) grants for the same payment id: exactly one execution of
 *   `fn` performs the grant. The ledger is written only on success, so a
 *   failed grant never wedges the payment as "already processed".
 * - The ledger is bounded: when it exceeds MAX_ENTRIES the oldest entries
 *   are dropped. Razorpay payment ids are only useful for dedup for as long
 *   as a replay is plausible.
 * - Corruption never blocks startup or grants: an unreadable file is
 *   quarantined (`<file>.corrupt-<ts>`) and the ledger starts empty.
 *
 * Limitations: this dedups within one server instance/data directory. It is
 * not a distributed lock; run a single engine process per data directory
 * (the documented deployment model).
 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getProjectDataRoot } from './paths.js';

export interface LedgerEntry {
  paymentId: string;
  plan: string;
  userId: string;
  grantedAt: number;
}

interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
}

const MAX_ENTRIES = 5000;
const LEDGER_FILE = 'razorpay-ledger.json';

export type GrantOnceResult =
  | { granted: true; entry: LedgerEntry }
  | { granted: false; duplicate: true; entry: LedgerEntry };

export class PaymentLedger {
  private readonly file: string;
  private entries: LedgerEntry[] | null = null;
  /** Serializes ledger mutations (read-modify-write of the file). */
  private chain: Promise<unknown> = Promise.resolve();
  /** paymentId → in-flight grant, so concurrent callers share one outcome. */
  private readonly inFlight = new Map<string, Promise<GrantOnceResult | null>>();

  constructor(file?: string) {
    this.file = file ?? path.join(getProjectDataRoot(), LEDGER_FILE);
  }

  /** Path of the underlying file (used by tests and diagnostics). */
  get filePath(): string {
    return this.file;
  }

  private load(): LedgerEntry[] {
    if (this.entries) return this.entries;
    this.entries = [];
    if (!existsSync(this.file)) return this.entries;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as LedgerFile;
      if (parsed && Array.isArray(parsed.entries)) {
        this.entries = parsed.entries.filter(
          (entry): entry is LedgerEntry =>
            typeof entry?.paymentId === 'string'
            && typeof entry?.plan === 'string'
            && typeof entry?.userId === 'string'
            && typeof entry?.grantedAt === 'number',
        );
      }
    } catch {
      // Quarantine the corrupt file rather than crash or silently double-grant.
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
      this.entries = [];
    }
    return this.entries;
  }

  /** True when this payment id has already been granted. */
  has(paymentId: string): boolean {
    const key = String(paymentId || '').trim();
    if (!key) return false;
    return this.load().some((entry) => entry.paymentId === key);
  }

  /** Look up the recorded grant, if any. */
  get(paymentId: string): LedgerEntry | null {
    const key = String(paymentId || '').trim();
    if (!key) return null;
    return this.load().find((entry) => entry.paymentId === key) ?? null;
  }

  private persist(): void {
    const directory = path.dirname(this.file);
    mkdirSync(directory, { recursive: true });
    const payload: LedgerFile = { version: 1, entries: this.entries ?? [] };
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    renameSync(tmp, this.file);
  }

  private record(entry: LedgerEntry): Promise<void> {
    const run = this.chain.then(() => {
      const entries = this.load();
      if (entries.some((existing) => existing.paymentId === entry.paymentId)) return;
      entries.push(entry);
      if (entries.length > MAX_ENTRIES) {
        this.entries = entries.slice(entries.length - MAX_ENTRIES);
      }
      this.persist();
    });
    // Keep the chain alive regardless of outcome; surface the error to the caller.
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Execute the grant `fn` at most once per payment id.
   *
   * - If the ledger already records this payment, returns a duplicate result
   *   without calling `fn`.
   * - If a grant for this payment is currently in flight, awaits it and
   *   reports the same outcome rather than executing `fn` twice.
   * - `fn` performs the grant and returns the LedgerEntry to record. If `fn`
   *   throws or returns null, nothing is recorded and the next attempt
   *   retries normally.
   *
   * Returns null only for blank payment ids or when the grant itself failed.
   */
  async grantOnce(
    paymentId: string,
    fn: () => Promise<LedgerEntry | null>,
  ): Promise<GrantOnceResult | null> {
    const key = String(paymentId || '').trim();
    if (!key) return null;

    const existing = this.get(key);
    if (existing) return { granted: false, duplicate: true, entry: existing };

    // Another caller is already granting this payment in-flight — share its outcome.
    const pending = this.inFlight.get(key);
    if (pending) {
      const shared = await pending;
      if (!shared) return null;
      return shared.granted ? { granted: false, duplicate: true, entry: shared.entry } : shared;
    }

    const grant = (async (): Promise<GrantOnceResult | null> => {
      // Re-check under the in-flight umbrella in case the ledger changed.
      const already = this.get(key);
      if (already) return { granted: false, duplicate: true, entry: already };
      let entry: LedgerEntry | null = null;
      try {
        entry = await fn();
      } catch {
        return null;
      }
      if (!entry) return null;
      try {
        await this.record(entry);
      } catch {
        // The grant succeeded but persisting failed. Fail open here: the money
        // moved, so the caller must know it happened. Duplicate delivery within
        // this process is still blocked by `inFlight` + the in-memory entries.
      }
      return { granted: true, entry };
    })();

    this.inFlight.set(key, grant);
    try {
      return await grant;
    } finally {
      this.inFlight.delete(key);
    }
  }
}

/** Shared process-wide instance (lazy). */
let shared: PaymentLedger | null = null;
export function getPaymentLedger(): PaymentLedger {
  if (!shared) shared = new PaymentLedger();
  return shared;
}

/** Test seam: reset the shared instance so a fresh temp ledger is used. */
export function __resetPaymentLedgerForTests(file?: string): void {
  shared = file ? new PaymentLedger(file) : null;
}
