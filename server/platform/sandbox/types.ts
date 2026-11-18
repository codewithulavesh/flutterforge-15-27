/**
 * Sandbox contract types shared by every runner.
 *
 * A sandbox command is always an argv array. There is no `shell` escape hatch:
 * callers that need shell syntax must not go through this layer at all.
 * Keeping the contract this narrow is what makes `shell: false` enforceable
 * at the runner boundary.
 */

export type SandboxErrorCode =
  | 'POLICY_DENIED'
  | 'PATH_ESCAPE'
  | 'TIMEOUT'
  | 'SPAWN_FAILED'
  | 'UNAVAILABLE'
  | 'OUTPUT_LIMIT';

export interface SandboxCommand {
  /** Program followed by its arguments. `argv[0]` is never passed through a shell. */
  argv: string[];
  /** Working directory. Relative paths are resolved against the workspace root. */
  cwd?: string;
  /** Extra environment entries; only policy-allowlisted names survive filtering. */
  env?: Record<string, string>;
  /** Wall-clock timeout in milliseconds. Rejected by the policy above the 30 minute cap. */
  timeoutMs?: number;
  /** Text written to the child's stdin before it is closed. */
  stdin?: string;
  /** Binary payload written to the child's stdin; takes precedence over `stdin`. */
  input?: Buffer;
}

export interface SandboxLimits {
  cpuCores: number;
  memoryMb: number;
  pidsLimit: number;
  diskMb?: number;
  nofileLimit?: number;
}

/**
 * Default isolation envelope. 512 MiB / 2 CPUs / 256 PIDs is enough for
 * `flutter analyze`, `dart format` and `npm --version`-class invocations, and
 * small enough that a fork bomb or runaway compiler cannot take the host down.
 */
export const DEFAULT_LIMITS: Readonly<SandboxLimits> = Object.freeze({
  cpuCores: 2,
  memoryMb: 512,
  pidsLimit: 256,
  diskMb: 512,
  nofileLimit: 1024,
});

export interface SandboxResult {
  /** Exit code reported by the OS, or `null` when the process died to a signal before exiting. */
  exitCode: number | null;
  /** Signal name (e.g. `SIGTERM`) when the process was killed by one, otherwise `null`. */
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Wall-clock duration from spawn to `close`. */
  durationMs: number;
  /** True when the timeout fired (SIGTERM was sent, then SIGKILL after the grace period). */
  timedOut: boolean;
  /** True when the runner terminated the process group (timeout or abort). */
  killed: boolean;
  /** True when either stream exceeded its capture cap and bytes were discarded. */
  truncated: boolean;
  /** The argv that was actually executed (after any ulimit wrapping), for audit logs. */
  command: string[];
}

/** Options accepted by {@link SandboxRunner.run}. */
export interface SandboxRunOptions {
  /** Aborts a queued or in-flight command. Aborting is reported as `killed: true`. */
  signal?: AbortSignal;
  /** Overrides the runner's resource limits for this invocation. */
  limits?: SandboxLimits;
}

export interface SandboxRunner {
  run(cmd: SandboxCommand, options?: SandboxRunOptions): Promise<SandboxResult>;
  dispose?(): Promise<void>;
}

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: SandboxErrorCode,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SandboxError';
    this.code = code;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

/** Default wall-clock timeout for a sandboxed command: 2 minutes. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Hard ceiling on any requested timeout: 30 minutes. Above this the policy denies. */
export const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
/** Per-stream capture cap: 4 MiB. */
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Largest accepted per-stream cap: 64 MiB. */
export const MAX_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
/** Grace period between SIGTERM and SIGKILL when terminating a timed-out process. */
export const TERM_GRACE_MS = 2_000;
/** Default admission gate size for local execution. */
export const DEFAULT_MAX_CONCURRENT = 2;

export function normalizeLimits(limits?: Partial<SandboxLimits> | null): SandboxLimits {
  const source = limits ?? {};
  const cpuCores = clampNumber(source.cpuCores, DEFAULT_LIMITS.cpuCores, 0.1, 64);
  const memoryMb = Math.round(clampNumber(source.memoryMb, DEFAULT_LIMITS.memoryMb, 32, 262_144));
  const pidsLimit = Math.round(clampNumber(source.pidsLimit, DEFAULT_LIMITS.pidsLimit, 8, 1_048_576));

  const normalized: SandboxLimits = {
    cpuCores: Math.round(cpuCores * 100) / 100,
    memoryMb,
    pidsLimit,
  };
  if (source.diskMb !== undefined) {
    normalized.diskMb = Math.round(clampNumber(source.diskMb, DEFAULT_LIMITS.diskMb ?? 512, 1, 4_194_304));
  }
  if (source.nofileLimit !== undefined) {
    normalized.nofileLimit = Math.round(clampNumber(source.nofileLimit, DEFAULT_LIMITS.nofileLimit ?? 1024, 16, 1_048_576));
  }
  return normalized;
}

export function normalizeOutputLimit(value: unknown, fallback = DEFAULT_MAX_OUTPUT_BYTES): number {
  const requested = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.round(clampNumber(requested, fallback, 1, MAX_OUTPUT_LIMIT_BYTES));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, numeric));
}
