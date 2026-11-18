/**
 * Usage metering and quota enforcement for the platform control plane.
 *
 * Units (read this before integrating)
 * -----------------------------------
 * `cost_micros` — micro-USD. **1_000_000 micros = $1.00 USD.** All costs are
 * integer micro-USD; there is no fractional-cent drift anywhere in this
 * module. The price table below is expressed in micro-USD per 1_000 tokens.
 *
 * Token accounting
 * ----------------
 * `promptTokens` is INCLUSIVE of `cachedTokens` (OpenAI/Anthropic usage
 * semantics: the prompt count already contains the cached portion).
 * `completionTokens` is separate. `cachedTokens <= promptTokens` is enforced.
 *
 *   billable prompt = promptTokens - cachedTokens
 *   cost = round_half_up(
 *     billable prompt * promptMicrosPer1k
 *     + cachedTokens  * (cachedMicrosPer1k ?? promptMicrosPer1k)
 *     + completion   * completionMicrosPer1k
 *   , 1000)   // i.e. divide by 1_000 with half-up rounding to whole micros
 *
 * For a model with no `cachedMicrosPer1k`, cached tokens are billed at the
 * prompt rate (never cheaper than real work performed without a cached rate).
 * All integer arithmetic; only the final division rounds, half up.
 *
 * Cost source (illustrative, NOT provider invoice truth)
 * -----------------------------------------------------
 * `PROVIDER_PRICE_TABLE` ships with launch-era public prices rounded to whole
 * micro-USD per 1k tokens and a zeroed OpenRouter-free tier. These values are
 * ILLUSTRATIVE ONLY. Replace them with provider-invoice truth in production;
 * they exist so recorded costs are deterministic and positive, not so they are
 * billing-accurate. Lookup order: `"<provider>:<model>"`, then bare `"<model>"`.
 * A model absent from the table records `cost_micros = 0`. We NEVER guess a
 * price high; an unknown model is free on paper until priced, not expensive.
 * A caller-supplied `costMicros` on the input always overrides the table
 * (validated like everything else).
 *
 * Quota semantics
 * ---------------
 * Quotas live in `platform_settings` under `quota:<tenantId>` with JSON
 *   { windowMs, limitTokens?, limitMicros?, costBasis, resetAtMs?, updatedAt }
 * `costBasis` selects what is enforced: 'micros' compares against `limitMicros`,
 * 'tokens' (prompt + completion) against `limitTokens`. Limits are INCLUSIVE:
 * usage equal to the limit is denied — there is no headroom left at the cap.
 *
 * The window is SLIDING: usage is summed over rows with
 * `recorded_at >= now - windowMs`, further restricted by any reset boundary:
 * rows with `recorded_at <= resetAtMs` do not count (the reset boundary is
 * EXCLUSIVE; the sliding window start stays inclusive). `resetAtMs` comes from
 * the optional `quota_reset:<tenantId>` marker written by `resetWindow()` and
 * from an optional `resetAtMs` carried by the quota row itself; the effective
 * boundary is the maximum of the two. After a reset, pre-reset rows are
 * excluded from both `checkQuota` and `summary`.
 *
 *     checkQuota(tenantId)      — standing state. allowed iff stored usage
 *                                 is strictly below the limit.
 *     chargeFor(input)          — pre-flight. allowed iff stored usage PLUS
 *                                 this call's cost/tokens stays at or below
 *                                 the limit (exact fit allowed). Denials do
 *                                 NOT record the row.
 *     chargeFor reports `quota.used*`/`remaining*` as the projection that
 *     includes the incoming call; `checkQuota` reports stored usage only.
 *     `remaining*` may be negative on a denial; that is deliberate.
 *
 * Failure mode (important for billing correctness)
 * ------------------------------------------------
 * Quota enforcement FAILS CLOSED. Any storage failure or corrupt quota state
 * inside `checkQuota` yields `allowed:false, reason:'QUOTA_CHECK_FAILED'`, and
 * inside `chargeFor` yields `ok:false, reason:'QUOTA_CHECK_FAILED'` with
 * NOTHING recorded. An outage therefore never grants unlimited or untracked
 * usage. A missing quota row is NOT a failure: `allowed:true` with
 * `reason:'no-quota-configured'`.
 *
 * Audit policy (deliberately narrow)
 * ---------------------------------
 * Audit entries are written ONLY for `QUOTA_EXCEEDED` denials and for quota
 * rule changes (`setQuota`, `resetWindow`). Every token call is NOT audited:
 * the cost of logging each metering event would dominate the metering itself.
 * Successful recording is silent. Audit failures never mask a denial (the
 * call is already denied and nothing was recorded) nor a committed quota
 * change; they are reported on stderr instead.
 *
 * Identifier rules
 * ----------------
 * provider/model MUST match `^[a-z0-9][a-z0-9._-]{0,63}$` — a single,
 * lowercase, filesystem- and log-friendly segment. Namespaced model ids such
 * as `openrouter/deepseek-chat` or the `:free` suffix are rejected BY DESIGN:
 * pass `provider='openrouter', model='deepseek-chat'`, or the zero-priced
 * alias `model='openrouter-free'` for the free tier (or supply an explicit
 * `costMicros: 0`). Strictness keeps the ledger joinable and the price table
 * finite. All other strings are length-bounded and reject control characters.
 *
 * `label` is validated (bounded, no control characters, LLM-ish gibberish
 * with quotes/emoji/newlines-free payloads welcome) but NOT PERSISTED: the
 * `token_usage` table has no label column. It exists for call-site context
 * and future schema work; do not expect to read it back.
 *
 * Validation
 * ----------
 * Every input is validated before any database work. Invalid input throws
 * `ValidationError` with `code: 'METERING_INVALID'` (HTTP 400). Numbers must
 * be finite, safe integers in [0, 10_000_000] (token/cost fields).
 */
import { systemClock, type Clock } from '../kernel/clock.js';
import { PlatformError, ValidationError } from '../kernel/errors.js';
import type { AuditLog } from '../audit/auditLog.js';
import type { Database, TransactionContext } from '../storage/database.js';

// ---------------------------------------------------------------------------
// Units and bounds
// ---------------------------------------------------------------------------

/** Micro-USD per $1.00 USD. `cost_micros = 1_000_000` means exactly $1. */
export const COST_MICROS_PER_USD = 1_000_000;
/** Per record, every numeric field is capped here (10_000_000 tokens or micros). */
export const MAX_RECORD_NUMBER = 10_000_000;
/** Quota limits are bounded by safe-integer range, not by the record cap. */
const MAX_LIMIT_NUMBER = Number.MAX_SAFE_INTEGER;
const MAX_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 512;
const MIN_WINDOW_MS = 1_000;
const MAX_WINDOW_MS = 400 * 86_400_000; // ~400 days
const MAX_RETENTION_DAYS = 3_650; // 10 years
const DAY_MS = 86_400_000;

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// No control (C0/C1) or format characters: labels and ids end up in logs,
// invoices and JSON. Everything else, including emoji, is fine.
const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/u;

/** cost basis for quota enforcement */
export type QuotaCostBasis = 'micros' | 'tokens';

// ---------------------------------------------------------------------------
// Price table
// ---------------------------------------------------------------------------

export interface ProviderPrice {
  /** micro-USD per 1_000 prompt tokens, billed on tokens NOT cached. */
  readonly promptMicrosPer1k: number;
  /** micro-USD per 1_000 completion tokens. */
  readonly completionMicrosPer1k: number;
  /** micro-USD per 1_000 cached prompt tokens; defaults to the prompt rate. */
  readonly cachedMicrosPer1k?: number;
}

/**
 * ILLUSTRATIVE PRICES — micro-USD per 1_000 tokens, launch-era public list
 * prices rounded to whole micros, expressed per the unit contract above
 * (so `$0.14 / 1M prompt tokens` is `140` micros per 1k).
 *
 * *** These are NOT provider-invoice truth. Replace this table with the
 * *** contracted/invoice prices of your actual providers before relying on
 * *** recorded costs for billing. OpenRouter's free tier is deliberately 0.
 * *** Unknown models record 0 — we never guess a price high.
 *
 * Lookup order: `"<provider>:<model>"`, then bare `"<model>"`.
 */
export const PROVIDER_PRICE_TABLE: Readonly<Record<string, ProviderPrice>> = {
  // DeepSeek V-series family (~$0.14 / $0.28 per 1M tokens, cache-read ~10%).
  'deepseek-chat': { promptMicrosPer1k: 140, completionMicrosPer1k: 280, cachedMicrosPer1k: 14 },
  'deepseek-reasoner': { promptMicrosPer1k: 550, completionMicrosPer1k: 2190, cachedMicrosPer1k: 140 },
  'deepseek-flash': { promptMicrosPer1k: 140, completionMicrosPer1k: 280, cachedMicrosPer1k: 28 },
  // Google Flash-class (illustrative list prices).
  'gemini-2.0-flash': { promptMicrosPer1k: 100, completionMicrosPer1k: 400 },
  'gemini-2.5-flash': { promptMicrosPer1k: 300, completionMicrosPer1k: 2500 },
  // OpenAI GPT-4o-class — PLACEHOLDER EXAMPLE VALUES, not contract pricing.
  'gpt-4o': { promptMicrosPer1k: 2500, completionMicrosPer1k: 10000, cachedMicrosPer1k: 1250 },
  'gpt-4o-mini': { promptMicrosPer1k: 150, completionMicrosPer1k: 600, cachedMicrosPer1k: 75 },
  'gpt-4.1': { promptMicrosPer1k: 2000, completionMicrosPer1k: 8000, cachedMicrosPer1k: 500 },
  'gpt-4.1-mini': { promptMicrosPer1k: 400, completionMicrosPer1k: 1600, cachedMicrosPer1k: 100 },
  // OpenRouter free tier — explicitly zero. Never guess high.
  'openrouter-free': { promptMicrosPer1k: 0, completionMicrosPer1k: 0, cachedMicrosPer1k: 0 },
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UsageRecordInput {
  tenantId: string;
  projectId?: string;
  runId?: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  /** Explicit override (integer micros, $1 = 1_000_000 micros). Overrides the table. */
  costMicros?: number;
  /** Validated but NOT persisted (token_usage has no label column). */
  label?: string;
  /** Unix ms; defaults to the injected clock. */
  recordedAt?: number;
}

export interface RecordedUsage {
  id: number;
  tenantId: string;
  projectId?: string;
  runId?: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costMicros: number;
  recordedAt: number;
}

export interface UsageSummary {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
  totalCostMicros: number;
  callCount: number;
  windowStartMs: number;
  windowEndMs: number;
}

export interface QuotaRule {
  tenantId: string;
  windowMs: number;
  limitTokens?: number;
  limitMicros?: number;
  costBasis: QuotaCostBasis;
  /** Unix ms of the last window reset boundary, if one was applied. */
  resetAtMs?: number;
  updatedAt: number;
}

export interface SetQuotaInput {
  tenantId: string;
  windowMs: number;
  limitMicros?: number;
  limitTokens?: number;
  /** Defaults to 'micros' when limitMicros is set, else 'tokens'. */
  costBasis?: QuotaCostBasis;
  /** Audit actor; defaults to 'platform:metering'. */
  actor?: string;
}

export interface QuotaCheck {
  allowed: boolean;
  /** 'no-quota-configured' | 'QUOTA_EXCEEDED' | 'QUOTA_CHECK_FAILED' */
  reason?: string;
  costBasis?: QuotaCostBasis;
  limitMicros?: number;
  usedMicros?: number;
  remainingMicros?: number;
  limitTokens?: number;
  usedTokens?: number;
  remainingTokens?: number;
  /** Effective sliding-window boundary + windowMs. */
  resetsAtMs?: number;
}

export type ChargeResult =
  | { ok: true; usage: RecordedUsage; quota: QuotaCheck }
  | { ok: false; reason: 'QUOTA_EXCEEDED' | 'QUOTA_CHECK_FAILED'; quota?: QuotaCheck };

export interface MeteringServiceOptions {
  db: Database;
  clock?: Clock;
  audit?: AuditLog;
}

export interface SummaryOptions {
  tenantId: string;
  projectId?: string;
  sinceMs?: number;
  untilMs?: number;
}

/** Internal, fully-validated record ready for persistence and costing. */
interface PreparedRecord {
  tenantId: string;
  projectId?: string;
  runId?: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costMicros: number;
  recordedAt: number;
  label?: string;
}

interface StoredQuota {
  windowMs: number;
  limitTokens?: number;
  limitMicros?: number;
  costBasis: QuotaCostBasis;
  resetAtMs?: number;
  updatedAt: number;
}

type SqlContext = Pick<TransactionContext, 'run' | 'get' | 'all'>;

const SETTINGS_QUOTA_PREFIX = 'quota:';
const SETTINGS_RESET_PREFIX = 'quota_reset:';
const ACTOR_DEFAULT = 'platform:metering';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function invalid(message: string, details?: Record<string, unknown>): ValidationError {
  return new ValidationError(message, details, 'METERING_INVALID');
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function requireId(value: unknown, field: string, options: { maxLength?: number } = {}): string {
  const maxLength = options.maxLength ?? MAX_ID_LENGTH;
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`${field} must be a non-empty string.`, { field });
  }
  if (value.length > maxLength) {
    throw invalid(`${field} must be at most ${maxLength} characters.`, { field, maxLength });
  }
  if (CONTROL_CHARS.test(value)) {
    throw invalid(`${field} must not contain control characters.`, { field });
  }
  return value;
}

function requireOptionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireId(value, field);
}

function requireProviderOrModel(value: unknown, field: 'provider' | 'model'): string {
  const id = requireId(value, field, { maxLength: 64 });
  if (!ID_PATTERN.test(id)) {
    throw invalid(
      `${field} must match ^[a-z0-9][a-z0-9._-]{0,63}$ (single lowercase segment, no slashes or ':'); got ${JSON.stringify(id)}.`,
      { field, pattern: ID_PATTERN.source },
    );
  }
  return id;
}

function requireRecordNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw invalid(`${field} must be a finite integer.`, { field });
  }
  if (value < 0) throw invalid(`${field} must be >= 0.`, { field, value });
  if (value > MAX_RECORD_NUMBER) {
    throw invalid(`${field} must be <= ${MAX_RECORD_NUMBER}.`, { field, value, max: MAX_RECORD_NUMBER });
  }
  return value;
}

function requireOptionalRecordNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireRecordNumber(value, field);
}

function requireLimitNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalid(`${field} must be a finite integer.`, { field });
  }
  if (value < 0) throw invalid(`${field} must be >= 0.`, { field, value });
  if (value > MAX_LIMIT_NUMBER) throw invalid(`${field} exceeds the safe-integer range.`, { field });
  return value;
}

function requireWindowMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalid('windowMs must be a finite integer number of milliseconds.', { field: 'windowMs' });
  }
  if (value < MIN_WINDOW_MS || value > MAX_WINDOW_MS) {
    throw invalid(`windowMs must be between ${MIN_WINDOW_MS} and ${MAX_WINDOW_MS} ms.`, { field: 'windowMs', value });
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${field} must be a unix-ms integer >= 0.`, { field });
  }
  return value;
}

function requireLabel(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid('label must be a string.', { field: 'label' });
  if (value.length > MAX_LABEL_LENGTH) {
    throw invalid(`label must be at most ${MAX_LABEL_LENGTH} characters.`, { field: 'label', maxLength: MAX_LABEL_LENGTH });
  }
  if (CONTROL_CHARS.test(value)) throw invalid('label must not contain control characters.', { field: 'label' });
  return value;
}

function corrupt(message: string, details?: Record<string, unknown>): PlatformError {
  // Fail loud on unreadable persisted state. Quota paths catch this and fail
  // closed; read paths propagate it so corruption is never silently served.
  return new PlatformError({
    code: 'METERING_STATE_CORRUPT',
    message,
    statusCode: 500,
    expose: false,
    details,
  });
}

function parseStoredQuota(raw: string, tenantId: string): StoredQuota {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw corrupt(`Quota row for tenant ${JSON.stringify(tenantId)} is not valid JSON.`, { cause: describe(error) });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw corrupt(`Quota row for tenant ${JSON.stringify(tenantId)} is not a JSON object.`);
  }
  const value = parsed as Record<string, unknown>;
  if (!isSafeInteger(value.windowMs) || value.windowMs < MIN_WINDOW_MS || value.windowMs > MAX_WINDOW_MS) {
    throw corrupt('Quota row has an invalid windowMs.');
  }
  const limitMicros = optionalStoredLimit(value.limitMicros, 'limitMicros');
  const limitTokens = optionalStoredLimit(value.limitTokens, 'limitTokens');
  if (limitMicros === undefined && limitTokens === undefined) {
    throw corrupt('Quota row carries no limit (limitMicros and limitTokens are both missing).');
  }
  let costBasis: QuotaCostBasis;
  if (value.costBasis === undefined) {
    // Tolerate rows written before costBasis existed: infer like setQuota does.
    costBasis = limitMicros !== undefined ? 'micros' : 'tokens';
  } else if (value.costBasis === 'micros' || value.costBasis === 'tokens') {
    costBasis = value.costBasis;
  } else {
    throw corrupt('Quota row has an invalid costBasis.');
  }
  if (costBasis === 'micros' && limitMicros === undefined) {
    throw corrupt("Quota row has costBasis 'micros' but no limitMicros.");
  }
  if (costBasis === 'tokens' && limitTokens === undefined) {
    throw corrupt("Quota row has costBasis 'tokens' but no limitTokens.");
  }
  const updatedAt = value.updatedAt === undefined ? 0 : requireStoredTimestamp(value.updatedAt, 'updatedAt');
  const resetAtMs = value.resetAtMs === undefined ? undefined : requireStoredTimestamp(value.resetAtMs, 'resetAtMs');
  return { windowMs: value.windowMs, limitMicros, limitTokens, costBasis, resetAtMs, updatedAt };
}

function optionalStoredLimit(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isSafeInteger(value) || value < 0) {
    throw corrupt(`Quota row has an invalid ${field}.`);
  }
  return value;
}

function requireStoredTimestamp(value: unknown, field: string): number {
  if (!isSafeInteger(value) || (value as number) < 0) {
    throw corrupt(`Quota row has an invalid ${field}.`);
  }
  return value as number;
}

function parseResetMarker(raw: string, tenantId: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw corrupt(`quota_reset marker for tenant ${JSON.stringify(tenantId)} is not valid JSON.`, { cause: describe(error) });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw corrupt(`quota_reset marker for tenant ${JSON.stringify(tenantId)} is not a JSON object.`);
  }
  const resetAtMs = (parsed as Record<string, unknown>).resetAtMs;
  if (!isSafeInteger(resetAtMs) || resetAtMs < 0) {
    throw corrupt('quota_reset marker has an invalid resetAtMs.');
  }
  return resetAtMs;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class MeteringService {
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly audit?: AuditLog;

  constructor(options: MeteringServiceOptions) {
    if (!options.db) throw invalid('MeteringService requires a Database.', { field: 'db' });
    this.db = options.db;
    this.clock = options.clock ?? systemClock;
    this.audit = options.audit;
  }

  // ------------------------------------------------------------------
  // Recording
  // ------------------------------------------------------------------

  /**
   * Validates, prices and appends one row to `token_usage`. Deliberately does
   * NOT enforce quota — `chargeFor` is the enforcing entry point. Not audited:
   * metering must stay cheaper than what it measures.
   */
  async record(input: UsageRecordInput): Promise<{ id: number }> {
    const prepared = this.prepareRecord(input);
    const id = await this.insertUsage(this.db, prepared);
    return { id };
  }

  /**
   * Pre-flight quota gate + record, atomically. The check and the insert run
   * in one `BEGIN IMMEDIATE` transaction: if the call would push the window
   * over the limit, nothing is recorded and a structured denial is returned.
   * Storage failures fail CLOSED with `reason: 'QUOTA_CHECK_FAILED'`.
   */
  async chargeFor(input: UsageRecordInput): Promise<ChargeResult> {
    const prepared = this.prepareRecord(input);
    let outcome: ChargeResult;
    try {
      outcome = await this.db.transaction(async (tx) => {
        const now = this.clock.now();
        const decision = await this.evaluateQuota(tx, prepared.tenantId, now, {
          addCostMicros: prepared.costMicros,
          addTokens: prepared.promptTokens + prepared.completionTokens,
        });
        if (!decision.allowed) {
          // evaluateQuota only reports QUOTA_EXCEEDED on denial here.
          return { ok: false as const, reason: 'QUOTA_EXCEEDED' as const, quota: decision };
        }
        const id = await this.insertUsage(tx, prepared);
        return {
          ok: true as const,
          usage: toRecordedUsage(id, prepared),
          // Report the post-call projection so callers see the same numbers
          // checkQuota would report immediately after this call commits.
          quota: decision,
        };
      });
    } catch (error) {
      // Fail closed: an outage or corrupt quota state must never grant
      // untracked, unlimited usage. Nothing was recorded on this path.
      this.logAnomaly('chargeFor failed; failing closed', prepared.tenantId, error);
      return { ok: false, reason: 'QUOTA_CHECK_FAILED' };
    }
    // Non-strict tsconfig: narrowing of boolean discriminants does not apply,
    // so cast to the denial shape explicitly.
    const denial = outcome as Extract<ChargeResult, { ok: false }>;
    if (denial.ok === false && denial.reason === 'QUOTA_EXCEEDED') {
      await this.auditQuotaExceeded(prepared, denial.quota);
    }
    return outcome;
  }

  // ------------------------------------------------------------------
  // Reading
  // ------------------------------------------------------------------

  /**
   * Aggregates `token_usage` over an optional window. Rows older than a
   * `quota_reset` boundary (or the quota row's `resetAtMs`) are excluded;
   * `windowStartMs` reports the effective start AFTER that adjustment.
   * An empty window returns zeros with meaningful bounds.
   */
  async summary(options: SummaryOptions): Promise<UsageSummary> {
    const tenantId = requireId(options?.tenantId, 'tenantId');
    const projectId = requireOptionalId(options?.projectId, 'projectId');
    const sinceMs = options?.sinceMs === undefined ? undefined : requireTimestamp(options.sinceMs, 'sinceMs');
    const untilMs = options?.untilMs === undefined ? undefined : requireTimestamp(options.untilMs, 'untilMs');
    if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
      throw invalid('sinceMs must be <= untilMs.', { sinceMs, untilMs });
    }

    const resetAtMs = await this.resolveResetBoundary(this.db, tenantId);
    const windowStartMs = Math.max(sinceMs ?? 0, resetAtMs ?? 0);
    const windowEndMs = untilMs ?? this.clock.now();

    // The reset boundary is EXCLUSIVE: a row recorded in the same millisecond
    // as the reset does not count. `sinceMs`/`untilMs` stay inclusive.
    let sql = `SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt,
              COALESCE(SUM(completion_tokens), 0) AS completion,
              COALESCE(SUM(cached_tokens), 0) AS cached,
              COALESCE(SUM(cost_micros), 0) AS micros,
              COUNT(*) AS calls
         FROM token_usage
        WHERE tenant_id = ? AND recorded_at >= ? AND recorded_at <= ?`;
    const params: unknown[] = [tenantId, windowStartMs, windowEndMs];
    if (resetAtMs !== undefined) {
      sql += ' AND recorded_at > ?';
      params.push(resetAtMs);
    }
    if (projectId !== undefined) {
      sql += ' AND project_id = ?';
      params.push(projectId);
    }
    const row = await this.db.get<{
      prompt: number | bigint;
      completion: number | bigint;
      cached: number | bigint;
      micros: number | bigint;
      calls: number | bigint;
    }>(sql, ...params);

    return {
      totalPromptTokens: numeric(row?.prompt),
      totalCompletionTokens: numeric(row?.completion),
      totalCachedTokens: numeric(row?.cached),
      totalCostMicros: numeric(row?.micros),
      callCount: numeric(row?.calls),
      windowStartMs,
      windowEndMs,
    };
  }

  // ------------------------------------------------------------------
  // Quota configuration
  // ------------------------------------------------------------------

  /**
   * Creates or replaces the tenant's quota rule in `platform_settings`
   * (`quota:<tenantId>`). At least one limit is required. Invalid input
   * throws `METERING_INVALID`. Audited as `metering.quota_set` (rule change).
   */
  async setQuota(input: SetQuotaInput): Promise<QuotaRule> {
    const tenantId = requireId(input?.tenantId, 'tenantId');
    const windowMs = requireWindowMs(input?.windowMs);
    const limitMicros = requireLimitNumber(input?.limitMicros, 'limitMicros');
    const limitTokens = requireLimitNumber(input?.limitTokens, 'limitTokens');
    if (limitMicros === undefined && limitTokens === undefined) {
      throw invalid('At least one of limitMicros or limitTokens is required.', { field: 'limitMicros' });
    }
    let costBasis: QuotaCostBasis;
    if (input.costBasis === undefined) {
      costBasis = limitMicros !== undefined ? 'micros' : 'tokens';
    } else if (input.costBasis === 'micros' || input.costBasis === 'tokens') {
      costBasis = input.costBasis;
    } else {
      throw invalid("costBasis must be 'micros' or 'tokens'.", { field: 'costBasis', value: input.costBasis });
    }
    if (costBasis === 'micros' && limitMicros === undefined) {
      throw invalid("costBasis 'micros' requires limitMicros.", { field: 'limitMicros' });
    }
    if (costBasis === 'tokens' && limitTokens === undefined) {
      throw invalid("costBasis 'tokens' requires limitTokens.", { field: 'limitTokens' });
    }
    const actor = input.actor === undefined ? ACTOR_DEFAULT : requireId(input.actor, 'actor');

    const now = this.clock.now();
    const previous = await this.readQuotaRow(this.db, tenantId);
    // A reset boundary survives a quota edit unless the tenant resets again.
    // Carry forward the effective boundary: max of the marker and the row.
    const resetAtMs = await this.readResetBoundary(this.db, tenantId, previous?.resetAtMs);
    const stored: StoredQuota = { windowMs, limitTokens, limitMicros, costBasis, resetAtMs, updatedAt: now };

    await this.db.run(
      `INSERT INTO platform_settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      `${SETTINGS_QUOTA_PREFIX}${tenantId}`,
      serializeQuota(stored),
      now,
    );

    await this.safeAudit({
      tenantId,
      actor,
      action: 'metering.quota_set',
      resourceType: 'tenant_quota',
      resourceId: tenantId,
      metadata: {
        windowMs,
        ...(limitMicros !== undefined ? { limitMicros } : {}),
        ...(limitTokens !== undefined ? { limitTokens } : {}),
        costBasis,
        ...(resetAtMs !== undefined ? { resetAtMs } : {}),
        unit: 'micros = 1e-6 USD',
      },
    });

    return toRule(tenantId, stored);
  }

  /** Returns the persisted quota rule, or null when none is configured. */
  async getQuota(tenantId: string): Promise<QuotaRule | null> {
    const id = requireId(tenantId, 'tenantId');
    const stored = await this.readQuotaRow(this.db, id);
    return stored === null ? null : toRule(id, stored);
  }

  /**
   * Standing quota state for the sliding window (`recorded_at >= now -
   * windowMs`, raised to any reset boundary). A missing quota row yields
   * `allowed:true, reason:'no-quota-configured'`. Any storage failure or
   * corrupt quota state FAILS CLOSED: `allowed:false,
   * reason:'QUOTA_CHECK_FAILED'`. Usage equal to the limit is denied.
   */
  async checkQuota(tenantId: string): Promise<QuotaCheck> {
    const id = requireId(tenantId, 'tenantId');
    try {
      return await this.evaluateQuota(this.db, id, this.clock.now());
    } catch (error) {
      this.logAnomaly('checkQuota failed; failing closed', id, error);
      return { allowed: false, reason: 'QUOTA_CHECK_FAILED' };
    }
  }

  // ------------------------------------------------------------------
  // Maintenance
  // ------------------------------------------------------------------

  /** Deletes this tenant's rows older than `retentionDays` (1..3650). */
  async pruneRetention(tenantId: string, retentionDays: number): Promise<{ deleted: number }> {
    const id = requireId(tenantId, 'tenantId');
    if (!isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > MAX_RETENTION_DAYS) {
      throw invalid(`retentionDays must be an integer between 1 and ${MAX_RETENTION_DAYS}.`, { field: 'retentionDays' });
    }
    const cutoff = this.clock.now() - retentionDays * DAY_MS;
    const result = await this.db.run(
      'DELETE FROM token_usage WHERE tenant_id = ? AND recorded_at < ?',
      id,
      cutoff,
    );
    return { deleted: result.changes };
  }

  /**
   * Writes the `quota_reset:<tenantId>` marker (and the quota row's own
   * `resetAtMs` when one exists), which excludes all rows recorded before
   * now from subsequent `summary`/`checkQuota`/`chargeFor` windows.
   * Audited as `metering.quota_reset` (rule change). Returns the boundary.
   */
  async resetWindow(tenantId: string, actor: string = ACTOR_DEFAULT): Promise<{ resetAtMs: number }> {
    const id = requireId(tenantId, 'tenantId');
    const auditActor = actor === undefined ? ACTOR_DEFAULT : requireId(actor, 'actor');
    const now = this.clock.now();
    const previousResetAtMs = await this.resolveResetBoundary(this.db, id);

    await this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO platform_settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        `${SETTINGS_RESET_PREFIX}${id}`,
        JSON.stringify({ resetAtMs: now, updatedAt: now }),
        now,
      );
      const row = await tx.get<{ value_json: string }>(
        'SELECT value_json FROM platform_settings WHERE key = ?',
        `${SETTINGS_QUOTA_PREFIX}${id}`,
      );
      if (row) {
        const stored = parseStoredQuota(row.value_json, id);
        stored.resetAtMs = now;
        stored.updatedAt = now;
        await tx.run(
          `INSERT INTO platform_settings (key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          `${SETTINGS_QUOTA_PREFIX}${id}`,
          serializeQuota(stored),
          now,
        );
      }
    });

    await this.safeAudit({
      tenantId: id,
      actor: auditActor,
      action: 'metering.quota_reset',
      resourceType: 'tenant_quota',
      resourceId: id,
      metadata: { resetAtMs: now, ...(previousResetAtMs !== undefined ? { previousResetAtMs } : {}) },
    });
    return { resetAtMs: now };
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private prepareRecord(input: UsageRecordInput): PreparedRecord {
    if (typeof input !== 'object' || input === null) {
      throw invalid('input must be an object.');
    }
    const tenantId = requireId(input.tenantId, 'tenantId');
    const projectId = requireOptionalId(input.projectId, 'projectId');
    const runId = requireOptionalId(input.runId, 'runId');
    const provider = requireProviderOrModel(input.provider, 'provider');
    const model = requireProviderOrModel(input.model, 'model');
    const promptTokens = requireRecordNumber(input.promptTokens, 'promptTokens');
    const completionTokens = requireRecordNumber(input.completionTokens, 'completionTokens');
    const cachedTokens = requireOptionalRecordNumber(input.cachedTokens, 'cachedTokens') ?? 0;
    if (cachedTokens > promptTokens) {
      throw invalid('cachedTokens must be <= promptTokens (cached tokens are a subset of the prompt).', {
        field: 'cachedTokens',
        cachedTokens,
        promptTokens,
      });
    }
    const costMicros = requireOptionalRecordNumber(input.costMicros, 'costMicros');
    const label = requireLabel(input.label);
    const recordedAt = input.recordedAt === undefined ? this.clock.now() : requireTimestamp(input.recordedAt, 'recordedAt');

    return {
      tenantId,
      projectId,
      runId,
      provider,
      model,
      promptTokens,
      completionTokens,
      cachedTokens,
      costMicros: costMicros ?? estimateCostMicros(provider, model, promptTokens, completionTokens, cachedTokens),
      recordedAt,
      ...(label !== undefined ? { label } : {}),
    };
  }

  private async insertUsage(ctx: SqlContext, record: PreparedRecord): Promise<number> {
    const result = await ctx.run(
      `INSERT INTO token_usage
         (tenant_id, project_id, run_id, provider, model,
          prompt_tokens, completion_tokens, cached_tokens, cost_micros, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.tenantId,
      record.projectId ?? null,
      record.runId ?? null,
      record.provider,
      record.model,
      record.promptTokens,
      record.completionTokens,
      record.cachedTokens,
      record.costMicros,
      record.recordedAt,
    );
    return Number(result.lastInsertRowid);
  }

  private async evaluateQuota(
    ctx: SqlContext,
    tenantId: string,
    now: number,
    incoming?: { addCostMicros: number; addTokens: number },
  ): Promise<QuotaCheck> {
    const quota = await this.readQuotaRow(ctx, tenantId);
    if (quota === null) {
      return { allowed: true, reason: 'no-quota-configured' };
    }
    const resetAtMs = await this.readResetBoundary(ctx, tenantId, quota.resetAtMs);
    const windowStart = now - quota.windowMs;
    const effectiveStart = Math.max(windowStart, resetAtMs ?? 0);
    const resetsAtMs = effectiveStart + quota.windowMs;

    let usageSql = `SELECT COALESCE(SUM(cost_micros), 0) AS micros,
              COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0) AS tokens
         FROM token_usage
        WHERE tenant_id = ? AND recorded_at >= ?`;
    const usageParams: unknown[] = [tenantId, effectiveStart];
    if (resetAtMs !== undefined) {
      // The reset boundary is EXCLUSIVE (same-ms rows do not count).
      usageSql += ' AND recorded_at > ?';
      usageParams.push(resetAtMs);
    }
    const usage = await ctx.get<{ micros: number | bigint; tokens: number | bigint }>(usageSql, ...usageParams);
    const storedMicros = numeric(usage?.micros);
    const storedTokens = numeric(usage?.tokens);
    // Standing check (checkQuota) denies at the cap; pre-flight (chargeFor)
    // denies when the incoming call would push usage over it.
    const usedMicros = storedMicros + (incoming?.addCostMicros ?? 0);
    const usedTokens = storedTokens + (incoming?.addTokens ?? 0);
    const exceeded = incoming
      ? (quota.costBasis === 'micros'
          ? usedMicros > (quota.limitMicros ?? 0)
          : usedTokens > (quota.limitTokens ?? 0))
      : (quota.costBasis === 'micros'
          ? storedMicros >= (quota.limitMicros ?? 0)
          : storedTokens >= (quota.limitTokens ?? 0));

    const check: QuotaCheck = {
      allowed: !exceeded,
      ...(exceeded ? { reason: 'QUOTA_EXCEEDED' } : {}),
      costBasis: quota.costBasis,
      usedMicros,
      usedTokens,
      resetsAtMs,
    };
    if (quota.limitMicros !== undefined) {
      check.limitMicros = quota.limitMicros;
      check.remainingMicros = quota.limitMicros - usedMicros;
    }
    if (quota.limitTokens !== undefined) {
      check.limitTokens = quota.limitTokens;
      check.remainingTokens = quota.limitTokens - usedTokens;
    }
    return check;
  }

  /** Reads quota row + reset marker; throws METERING_STATE_CORRUPT on bad data. */
  private async resolveResetBoundary(ctx: SqlContext, tenantId: string): Promise<number | undefined> {
    const quota = await this.readQuotaRow(ctx, tenantId);
    return this.readResetBoundary(ctx, tenantId, quota?.resetAtMs);
  }

  private async readResetBoundary(
    ctx: SqlContext,
    tenantId: string,
    quotaResetAtMs: number | undefined,
  ): Promise<number | undefined> {
    const marker = await ctx.get<{ value_json: string }>(
      'SELECT value_json FROM platform_settings WHERE key = ?',
      `${SETTINGS_RESET_PREFIX}${tenantId}`,
    );
    const markerResetAtMs = marker ? parseResetMarker(marker.value_json, tenantId) : undefined;
    const candidates = [quotaResetAtMs, markerResetAtMs].filter((v): v is number => v !== undefined);
    return candidates.length === 0 ? undefined : Math.max(...candidates);
  }

  private async readQuotaRow(ctx: Pick<SqlContext, 'get'>, tenantId: string): Promise<StoredQuota | null> {
    const row = await ctx.get<{ value_json: string }>(
      'SELECT value_json FROM platform_settings WHERE key = ?',
      `${SETTINGS_QUOTA_PREFIX}${tenantId}`,
    );
    return row ? parseStoredQuota(row.value_json, tenantId) : null;
  }

  private async safeAudit(entry: {
    tenantId: string;
    actor: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    // Audit is best-effort: it must not turn a committed quota change (or an
    // already-denied call) into a thrown error. Failures surface on stderr.
    if (!this.audit) return;
    try {
      await this.audit.append(entry);
    } catch (error) {
      this.logAnomaly(`audit append failed for ${entry.action}`, entry.tenantId, error);
    }
  }

  private async auditQuotaExceeded(record: PreparedRecord, quota?: QuotaCheck): Promise<void> {
    await this.safeAudit({
      tenantId: record.tenantId,
      actor: ACTOR_DEFAULT,
      action: 'metering.quota_exceeded',
      resourceType: 'tenant_quota',
      resourceId: record.tenantId,
      metadata: {
        provider: record.provider,
        model: record.model,
        ...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
        ...(record.runId !== undefined ? { runId: record.runId } : {}),
        // cost_micros here means 1e-6 USD (1_000_000 micros = $1).
        attemptedCostMicros: record.costMicros,
        costUnit: 'micros = 1e-6 USD',
        ...(quota?.costBasis !== undefined ? { costBasis: quota.costBasis } : {}),
        ...(quota?.usedMicros !== undefined ? { usedMicros: quota.usedMicros } : {}),
        ...(quota?.limitMicros !== undefined ? { limitMicros: quota.limitMicros } : {}),
        ...(quota?.usedTokens !== undefined ? { usedTokens: quota.usedTokens } : {}),
        ...(quota?.limitTokens !== undefined ? { limitTokens: quota.limitTokens } : {}),
      },
    });
  }

  private logAnomaly(message: string, tenantId: string, error: unknown): void {
    process.stderr.write(`[metering] ${message} (tenant=${JSON.stringify(tenantId)}): ${describe(error)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Costing
// ---------------------------------------------------------------------------

/**
 * Integer-micro cost estimate. `promptTokens` includes `cachedTokens`;
 * billable prompt is the difference. Unknown models (absent from
 * PROVIDER_PRICE_TABLE) cost 0 — never a guessed-high price.
 */
export function estimateCostMicros(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
): number {
  const price = PROVIDER_PRICE_TABLE[`${provider}:${model}`] ?? PROVIDER_PRICE_TABLE[model];
  if (!price) return 0;
  const billablePrompt = Math.max(0, promptTokens - cachedTokens);
  const cachedRate = price.cachedMicrosPer1k ?? price.promptMicrosPer1k;
  const numerator =
    billablePrompt * price.promptMicrosPer1k +
    cachedTokens * cachedRate +
    completionTokens * price.completionMicrosPer1k;
  // Half-up rounding at whole-micro granularity. Numerator is an integer
  // (max 1e7 * 1e6-ish scale), so this is exact, not float-fuzzy.
  return Math.floor((numerator + 500) / 1000);
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

function toRecordedUsage(id: number, record: PreparedRecord): RecordedUsage {
  const rest = { ...record } as Record<string, unknown>;
  delete rest.label; // label is validated but never persisted
  return { id, ...rest } as RecordedUsage;
}

function toRule(tenantId: string, stored: StoredQuota): QuotaRule {
  return {
    tenantId,
    windowMs: stored.windowMs,
    ...(stored.limitTokens !== undefined ? { limitTokens: stored.limitTokens } : {}),
    ...(stored.limitMicros !== undefined ? { limitMicros: stored.limitMicros } : {}),
    costBasis: stored.costBasis,
    ...(stored.resetAtMs !== undefined ? { resetAtMs: stored.resetAtMs } : {}),
    updatedAt: stored.updatedAt,
  };
}

function serializeQuota(stored: StoredQuota): string {
  return JSON.stringify({
    windowMs: stored.windowMs,
    ...(stored.limitTokens !== undefined ? { limitTokens: stored.limitTokens } : {}),
    ...(stored.limitMicros !== undefined ? { limitMicros: stored.limitMicros } : {}),
    costBasis: stored.costBasis,
    ...(stored.resetAtMs !== undefined ? { resetAtMs: stored.resetAtMs } : {}),
    updatedAt: stored.updatedAt,
  });
}

function numeric(value: number | bigint | undefined): number {
  if (value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}
