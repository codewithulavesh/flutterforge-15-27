/**
 * Usage metering and quota enforcement — public surface.
 * Contract (units, semantics, failure modes) lives in ./usage.ts; in short:
 * `cost_micros` is micro-USD (1_000_000 = $1.00), quotas are inclusive-limit,
 * enforcement fails CLOSED, audit is limited to QUOTA_EXCEEDED and quota
 * rule changes.
 */
export * from './usage.js';
