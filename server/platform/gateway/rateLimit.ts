/**
 * Distributed token-bucket rate limiting.
 *
 * The limiter only needs a tiny store port. A Redis implementation should make
 * `get` + `set` atomic per key (for example with a Lua script); this process
 * additionally serialises operations for the same key so concurrent requests
 * cannot oversubscribe an in-memory store.
 *
 * Clocks are injected and elapsed time is clamped to zero. Moving the clock
 * backwards therefore cannot mint tokens. State timestamps never move
 * backwards either, so time is not counted twice when the clock catches up.
 */
import { systemClock, type Clock } from '../kernel/clock.js';

export interface BucketState {
  /** Tokens currently available. May be fractional. */
  tokens: number;
  /** Epoch milliseconds of the last refill/consumption. */
  updatedAtMs: number;
}

export interface TokenBucketStore {
  get(key: string): BucketState | null | Promise<BucketState | null>;
  set(key: string, state: BucketState, ttlMs: number): void | Promise<void>;
  /** Reserved for stores that can maintain auxiliary counters atomically. */
  increment?(key: string, amount: number, ttlMs: number): number | Promise<number>;
}

export interface RateTierConfig {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

/** Named presets. `refillPerSecond` is the sustained rate. */
export const RateTier = Object.freeze({
  /** 60 requests per minute. */
  public: Object.freeze({ capacity: 60, refillPerSecond: 1 }),
  /** 600 requests per minute. */
  developer: Object.freeze({ capacity: 600, refillPerSecond: 10 }),
  /** 60 events per second with a 120-event burst. */
  streaming: Object.freeze({ capacity: 120, refillPerSecond: 60 }),
  /** 10 workflow starts per minute. */
  workflow_start: Object.freeze({ capacity: 10, refillPerSecond: 10 / 60 }),
  /** 4 builds per minute. */
  build: Object.freeze({ capacity: 4, refillPerSecond: 4 / 60 }),
} as const);

export type RateTierName = keyof typeof RateTier;
export const RATE_TIERS = RateTier;

export interface BucketOptions extends RateTierConfig {
  cost?: number;
}

export interface ConsumeRequest extends BucketOptions {
  key: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  /** Epoch milliseconds at which the bucket would be full again. */
  resetAtMs: number;
  /** Milliseconds until this exact cost can be served. Zero when allowed. */
  retryAfterMs: number;
}

export interface MemoryTokenBucketStoreOptions {
  maxEntries?: number;
  sweepIntervalMs?: number;
  clock?: Clock;
}

interface MemoryEntry {
  state: BucketState;
  expiresAtMs: number;
}

const EPSILON = 1e-9;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const MAX_KEY_LENGTH = 1024;
const MAX_CAPACITY = 1_000_000_000;
const KEY_PATTERN = /^[^\s\u0000-\u001F\u007F]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isClock(value: unknown): value is Clock {
  return isPlainObject(value) && typeof (value as { now?: unknown }).now === 'function';
}

function assertKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(key)) {
    throw new RangeError(`Rate-limit key must be 1-${MAX_KEY_LENGTH} non-whitespace characters.`);
  }
}

function normalizeConfig(options: BucketOptions): { capacity: number; refillPerSecond: number; cost: number } {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('Token bucket options are required.');
  }
  const { capacity, refillPerSecond } = options;
  if (!Number.isSafeInteger(capacity) || capacity <= 0 || capacity > MAX_CAPACITY) {
    throw new RangeError(`capacity must be an integer between 1 and ${MAX_CAPACITY}.`);
  }
  if (typeof refillPerSecond !== 'number' || !Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new RangeError('refillPerSecond must be a positive finite number.');
  }
  const cost = options.cost ?? 1;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) {
    throw new RangeError('cost must be a positive finite number.');
  }
  if (cost > capacity + EPSILON) {
    throw new RangeError('cost cannot exceed the bucket capacity.');
  }
  return { capacity, refillPerSecond, cost };
}

function normalizeState(state: BucketState | null): BucketState | null {
  if (state === null || !isPlainObject(state)) return null;
  if (typeof state.tokens !== 'number' || !Number.isFinite(state.tokens)) return null;
  if (typeof state.updatedAtMs !== 'number' || !Number.isFinite(state.updatedAtMs)) return null;
  return { tokens: state.tokens, updatedAtMs: state.updatedAtMs };
}

function cloneState(state: BucketState): BucketState {
  return { tokens: state.tokens, updatedAtMs: state.updatedAtMs };
}

/** LRU + TTL store with a hard entry bound. Suitable for a single process. */
export class MemoryTokenBucketStore implements TokenBucketStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly clock: Clock;
  private readonly max: number;
  private readonly sweepIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: MemoryTokenBucketStoreOptions = {}) {
    // typeof-check keeps the parameter's declared type for the rest of the
    // constructor (a type predicate would narrow it to Record<string, unknown>).
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new TypeError('Memory store options must be an object.');
    }
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError('maxEntries must be a positive integer.');
    }
    const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs < 0) {
      throw new RangeError('sweepIntervalMs must be a non-negative integer.');
    }
    this.clock = options.clock ?? systemClock;
    if (!isClock(this.clock)) throw new TypeError('clock must implement now().');
    this.max = maxEntries;
    this.sweepIntervalMs = sweepIntervalMs;

    if (sweepIntervalMs > 0) {
      const timer = setInterval(() => {
        // TTL expiry is also checked on every read; a failed sweep must never
        // take down the process.
        try {
          this.sweep();
        } catch {
          /* retry on the next tick */
        }
      }, sweepIntervalMs);
      const unref = (timer as { unref?: () => void }).unref;
      if (typeof unref === 'function') unref.call(timer);
      this.timer = timer;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get maxEntries(): number {
    return this.max;
  }

  get(key: string): BucketState | null {
    assertKey(key);
    const nowMs = this.now();
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (nowMs >= entry.expiresAtMs) {
      this.entries.delete(key);
      return null;
    }
    // Touch for LRU recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return cloneState(entry.state);
  }

  set(key: string, state: BucketState, ttlMs: number): void {
    assertKey(key);
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) {
      throw new RangeError('ttlMs must be a finite number.');
    }
    if (ttlMs <= 0) {
      this.entries.delete(key);
      return;
    }
    const normalized = normalizeState(state);
    if (!normalized) throw new TypeError('Bucket state is invalid.');

    const nowMs = this.now();
    const existing = this.entries.get(key);
    // Never shorten an existing expiry when the wall clock jumps backwards.
    const expiresAtMs = Math.max(existing?.expiresAtMs ?? 0, nowMs + Math.ceil(ttlMs));
    this.entries.delete(key);
    this.entries.set(key, { state: normalized, expiresAtMs });

    if (this.entries.size > this.max) {
      this.sweepExpiredEntries(nowMs);
      while (this.entries.size > this.max) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.entries.delete(oldest.value);
      }
    }
  }

  /** Delete every expired entry and return how many were removed. */
  sweepExpired(): number {
    return this.sweepExpiredEntries(this.now());
  }

  /** Alias for sweepExpired(). */
  sweep(): number {
    return this.sweepExpired();
  }

  clear(): void {
    this.entries.clear();
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private now(): number {
    const value = this.clock.now();
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RangeError('Clock must return finite epoch milliseconds.');
    }
    return value;
  }

  private sweepExpiredEntries(nowMs: number): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (nowMs >= entry.expiresAtMs) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

export interface TokenBucketLimiterOptions {
  store?: TokenBucketStore;
  clock?: Clock;
  /**
   * Bound for the default in-memory store (LRU-ish eviction). Ignored when an
   * explicit `store` is supplied. Defaults to 10000.
   */
  maxEntries?: number;
}

function isStore(value: unknown): value is TokenBucketStore {
  return isPlainObject(value)
    && typeof (value as { get?: unknown }).get === 'function'
    && typeof (value as { set?: unknown }).set === 'function';
}

export class TokenBucketLimiter {
  readonly store: TokenBucketStore;
  private readonly clock: Clock;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options?: TokenBucketLimiterOptions);
  constructor(store: TokenBucketStore, options?: Omit<TokenBucketLimiterOptions, 'store'>);
  constructor(
    optionsOrStore: TokenBucketLimiterOptions | TokenBucketStore = {},
    maybeOptions: Omit<TokenBucketLimiterOptions, 'store'> = {},
  ) {
    const directStore = isStore(optionsOrStore);
    const options: TokenBucketLimiterOptions = directStore
      ? maybeOptions
      : (optionsOrStore as TokenBucketLimiterOptions);
    const suppliedClock = options.clock;
    if (suppliedClock !== undefined && !isClock(suppliedClock)) {
      throw new TypeError('clock must implement now().');
    }
    this.clock = suppliedClock ?? systemClock;
    const store = directStore ? optionsOrStore : options.store;
    if (store !== undefined && !isStore(store)) {
      throw new TypeError('store must implement get() and set().');
    }
    const maxEntries = options.maxEntries;
    if (maxEntries !== undefined && (!Number.isSafeInteger(maxEntries) || maxEntries <= 0)) {
      throw new RangeError('maxEntries must be a positive integer.');
    }
    this.store = store ?? new MemoryTokenBucketStore({
      clock: this.clock,
      ...(maxEntries !== undefined ? { maxEntries } : {}),
    });
  }

  async consume(key: string, options: BucketOptions): Promise<RateLimitResult> {
    assertKey(key);
    const config = normalizeConfig(options);
    return this.withKeyLock(key, () => this.consumeLocked(key, config));
  }

  async consumeTier(
    key: string,
    tier: RateTierName | RateTierConfig,
    cost = 1,
  ): Promise<RateLimitResult> {
    let config: RateTierConfig;
    if (typeof tier === 'string') {
      if (!Object.prototype.hasOwnProperty.call(RateTier, tier)) {
        throw new RangeError(`Unknown rate tier: ${tier}.`);
      }
      config = RateTier[tier];
    } else {
      config = tier;
    }
    return this.consume(key, { capacity: config.capacity, refillPerSecond: config.refillPerSecond, cost });
  }

  /**
   * Delete expired buckets when the underlying store supports it (the bundled
   * in-memory store does). Returns the number of removed entries; returns 0
   * for stores without sweep support, in which case TTL is still enforced on
   * every read.
   */
  sweepExpired(): number {
    const candidate = this.store as TokenBucketStore & { sweepExpired?: () => number };
    if (typeof candidate.sweepExpired === 'function') {
      const removed = candidate.sweepExpired();
      return typeof removed === 'number' && Number.isFinite(removed) ? removed : 0;
    }
    return 0;
  }

  /**
   * Consume several buckets (for example per-IP and per-tenant) and return the
   * most restrictive composite result. Every bucket is charged even when a
   * different bucket denies, so clients cannot bypass one dimension by
   * exhausting another. When any bucket denies, `remaining` is the smallest
   * remaining count and `retryAfterMs` the largest wait across the buckets.
   */
  async consumeAll(consumables: readonly ConsumeRequest[]): Promise<RateLimitResult> {
    if (!Array.isArray(consumables) || consumables.length === 0) {
      throw new RangeError('consumeAll requires at least one bucket request.');
    }
    const results = await Promise.all(consumables.map((request) => this.consume(request.key, request)));
    const allowed = results.every((result) => result.allowed);
    const remaining = Math.min(...results.map((result) => result.remaining));
    const limit = Math.min(...results.map((result) => result.limit));
    const resetAtMs = Math.max(...results.map((result) => result.resetAtMs));
    const retryAfterMs = allowed ? 0 : Math.max(...results.map((result) => result.retryAfterMs));
    return { allowed, remaining, limit, resetAtMs, retryAfterMs };
  }

  private nowMs(): number {
    const value = this.clock.now();
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RangeError('Clock must return finite epoch milliseconds.');
    }
    return value;
  }

  private async consumeLocked(
    key: string,
    config: { capacity: number; refillPerSecond: number; cost: number },
  ): Promise<RateLimitResult> {
    const { capacity, refillPerSecond, cost } = config;
    const nowMs = this.nowMs();
    const raw = await this.store.get(key);
    const saved = normalizeState(raw);

    let tokens: number;
    let updatedAtMs: number;
    if (saved === null) {
      tokens = capacity;
      updatedAtMs = nowMs;
    } else {
      // Elapsed is clamped to zero so a backwards clock cannot mint tokens.
      const elapsedMs = Math.max(0, nowMs - saved.updatedAtMs);
      tokens = Math.min(capacity, Math.max(0, saved.tokens) + (elapsedMs / 1000) * refillPerSecond);
      // Keep the later timestamp. If the store is ahead of the clock we wait
      // for the clock to catch up instead of counting that span twice.
      updatedAtMs = Math.max(saved.updatedAtMs, nowMs);
    }

    const allowed = tokens + EPSILON >= cost;
    const tokensAfter = allowed ? Math.max(0, tokens - cost) : tokens;
    const refillBaseMs = Math.max(nowMs, updatedAtMs);
    const missingForReset = Math.max(0, capacity - tokensAfter);
    const missingForRetry = Math.max(0, cost - tokensAfter);
    const resetAtMs = refillBaseMs + Math.ceil((missingForReset / refillPerSecond) * 1000);
    const retryAtMs = refillBaseMs + Math.ceil((missingForRetry / refillPerSecond) * 1000);
    const retryAfterMs = allowed ? 0 : Math.max(1, retryAtMs - nowMs);
    const ttlMs = Math.max(1000, resetAtMs - nowMs + 1000);

    await this.store.set(key, { tokens: tokensAfter, updatedAtMs: refillBaseMs }, ttlMs);

    return {
      allowed,
      remaining: Math.max(0, Math.min(capacity, Math.floor(tokensAfter + EPSILON))),
      limit: capacity,
      resetAtMs,
      retryAfterMs,
    };
  }

  private async withKeyLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(operation);
    const guard = run.then(() => undefined, () => undefined);
    this.locks.set(key, guard);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === guard) this.locks.delete(key);
    }
  }
}

/** Convert a result into standards-shaped rate-limit headers. */
export function rateLimitHeaders(
  result: RateLimitResult,
  nowMs: number = Date.now(),
): Record<string, string> {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new TypeError('Rate-limit result is required.');
  }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError('nowMs must be finite epoch milliseconds.');
  }
  const resetSeconds = Math.max(0, Math.ceil((result.resetAtMs - nowMs) / 1000));
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(resetSeconds),
  };
  if (typeof result.retryAfterMs === 'number' && Number.isFinite(result.retryAfterMs) && result.retryAfterMs > 0) {
    // Retry-After is expressed in whole seconds, rounded up.
    headers['Retry-After'] = String(Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
  }
  return headers;
}

export function isRateTierName(value: unknown): value is RateTierName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RateTier, value);
}
