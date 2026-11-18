/**
 * Injected time.
 *
 * Every durable component (workflow leases, rate limits, audit ordering)
 * receives a clock instead of calling `Date.now()` directly. Tests then drive
 * time deterministically without sleeping.
 */
export interface Clock {
  now(): number;
  iso(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
};

export class ManualClock implements Clock {
  private current: number;

  constructor(initialMs = 0) {
    this.current = initialMs;
  }

  now(): number {
    return this.current;
  }

  iso(): string {
    return new Date(this.current).toISOString();
  }

  set(ms: number): void {
    this.current = ms;
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Clock can only advance by a non-negative number.');
    this.current += ms;
  }
}

/** Monotonic duration measurement, independent of wall-clock adjustments. */
export function elapsedMs(startNs: bigint): number {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}
