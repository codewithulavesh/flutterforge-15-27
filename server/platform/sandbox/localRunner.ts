/**
 * Local process sandbox runner.
 *
 * This is a *process* sandbox, not a filesystem or kernel jail. It enforces:
 * the command policy, a bounded environment, per-stream output caps, a
 * wall-clock timeout (SIGTERM, then SIGKILL after a 2s grace), process-group
 * termination on POSIX, a FIFO admission gate (default 2 concurrent) and
 * cooperative cancellation via AbortSignal.
 *
 * `spawn` is always `shell: false` with an argv array. On POSIX the command is
 * additionally wrapped in a fixed `sh -c 'ulimit ...; exec "$@"'` prelude
 * (best-effort resource limits). For hostile code use the Docker runner.
 *
 * `run()` never throws for process-level failures — spawn errors are returned
 * as a `SandboxResult` with `exitCode: null`. `SandboxError` is reserved for
 * policy denials and internal/runner errors.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import {
  assertAllowed,
  buildUlimitWrapper,
  resolveRealPath,
  sanitizeEnvironment,
} from './policy.js';
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_LIMITS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  TERM_GRACE_MS,
  SandboxError,
  normalizeLimits,
  normalizeOutputLimit,
  type SandboxCommand,
  type SandboxLimits,
  type SandboxResult,
  type SandboxRunner,
  type SandboxRunOptions,
} from './types.js';

const IS_WINDOWS = process.platform === 'win32';

export interface LocalSandboxRunnerOptions {
  workspaceRoot: string;
  /** Resource limits for every command; overridable per run via {@link SandboxRunOptions.limits}. */
  limits?: Partial<SandboxLimits>;
  /** Admission gate size. Commands beyond it wait FIFO. Default: 2. */
  maxConcurrent?: number;
  /** Per-stream capture cap in bytes. Default: 4 MiB. */
  maxOutputBytes?: number;
  /**
   * Internal escape hatch used by the Docker runner, whose argv is already
   * policy-checked before the docker client invocation. Never set this for
   * untrusted input.
   */
  skipPolicy?: boolean;
}

class AbortWaitingError extends Error {
  constructor() {
    super('Sandbox run aborted while waiting for a slot');
    this.name = 'AbortWaitingError';
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort: () => void;
}

/**
 * FIFO admission gate. `occupied` is the live slot counter exposed on the
 * runner as {@link LocalSandboxRunner.slots}. Aborting a queued waiter removes
 * it from the queue without ever holding (or leaking) a slot.
 */
class FifoGate {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly max: number) {}

  get occupied(): number {
    return this.active;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new AbortWaitingError());
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (release) => resolve(release),
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal?.removeEventListener('abort', waiter.onAbort);
          reject(new AbortWaitingError());
        },
      };
      this.waiters.push(waiter);
      if (signal) signal.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.max && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      if (waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort);
      this.active += 1;
      waiter.resolve(this.makeRelease());
    }
  }
}

/** Per-stream bounded capture. Bytes past the cap are discarded but the stream stays drained. */
class BoundedCapture {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private truncatedFlag = false;

  constructor(private readonly limit: number) {}

  get truncated(): boolean {
    return this.truncatedFlag;
  }

  push(chunk: Buffer): void {
    const remaining = this.limit - this.size;
    if (remaining <= 0) {
      this.truncatedFlag = true;
      return; // Keep consuming: the child never blocks on a full pipe.
    }
    if (chunk.length <= remaining) {
      this.chunks.push(chunk);
      this.size += chunk.length;
      return;
    }
    this.chunks.push(chunk.subarray(0, remaining));
    this.size = this.limit;
    this.truncatedFlag = true;
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.size).toString('utf8');
  }
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals, useGroup: boolean): void {
  const pid = child.pid;
  if (pid !== undefined && !IS_WINDOWS && useGroup) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return; // Group already gone.
      // Fall through to the direct child on unexpected errors.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

function clampTimeout(value: unknown): number {
  const requested = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
  if (requested <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(requested, MAX_TIMEOUT_MS);
}

export class LocalSandboxRunner implements SandboxRunner {
  readonly workspaceRoot: string;
  readonly limits: SandboxLimits;
  readonly maxConcurrent: number;
  readonly maxOutputBytes: number;

  private readonly skipPolicy: boolean;
  private readonly gate: FifoGate;
  private readonly gracePeriodMs = TERM_GRACE_MS;
  private readonly controllers = new Set<AbortController>();
  private disposed = false;

  constructor(options: LocalSandboxRunnerOptions) {
    if (!options || typeof options.workspaceRoot !== 'string' || options.workspaceRoot.length === 0) {
      throw new SandboxError('UNAVAILABLE', 'LocalSandboxRunner requires a workspace root');
    }
    try {
      this.workspaceRoot = resolveRealPath(options.workspaceRoot);
    } catch (error) {
      throw new SandboxError('UNAVAILABLE', `Workspace root cannot be resolved: ${(error as Error).message}`, { cause: error });
    }
    if (!isDirectory(this.workspaceRoot)) {
      throw new SandboxError('UNAVAILABLE', `Workspace root is missing, inaccessible or not a directory: ${this.workspaceRoot}`);
    }

    this.limits = normalizeLimits(options.limits ?? DEFAULT_LIMITS);
    this.maxConcurrent = Math.max(1, Math.min(128, Math.round(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)));
    this.maxOutputBytes = normalizeOutputLimit(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
    this.skipPolicy = options.skipPolicy === true;
    this.gate = new FifoGate(this.maxConcurrent);
  }

  /** Number of admission slots currently occupied. Diagnostics only. */
  get slots(): number {
    return this.gate.occupied;
  }

  async run(cmd: SandboxCommand, options: SandboxRunOptions = {}): Promise<SandboxResult> {
    if (this.disposed) {
      throw new SandboxError('UNAVAILABLE', 'LocalSandboxRunner has been disposed');
    }
    if (cmd === null || typeof cmd !== 'object' || !Array.isArray(cmd.argv)) {
      throw new SandboxError('POLICY_DENIED', 'SandboxCommand must include an argv array');
    }

    const external = options.signal;
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', forwardAbort, { once: true });
    }
    this.controllers.add(controller);

    let release: (() => void) | undefined;
    try {
      // ---- policy gate (unless explicitly bypassed for pre-checked argv) ----
      const effectiveLimits = normalizeLimits(options.limits ?? this.limits);
      let argv: string[];
      let cwd: string;
      let env: Record<string, string>;
      let timeoutMs: number;

      if (this.skipPolicy) {
        argv = cmd.argv.map((arg) => String(arg));
        if (argv.some((arg) => arg.includes('\0'))) {
          throw new SandboxError('POLICY_DENIED', 'argv contains a NUL byte');
        }
        cwd = cmd.cwd ? path.resolve(cmd.cwd) : this.workspaceRoot;
        env = sanitizeEnvironment(cmd.env);
        timeoutMs = clampTimeout(cmd.timeoutMs);
      } else {
        const decision = assertAllowed(cmd, { workspaceRoot: this.workspaceRoot, limits: effectiveLimits });
        argv = decision.argv;
        cwd = decision.cwd;
        env = decision.env;
        timeoutMs = decision.timeoutMs;
      }

      const commandForResult = [...argv];

      if (controller.signal.aborted) return abortedResult(commandForResult, 0);

      // ---- admission gate (FIFO) -------------------------------------------
      try {
        release = await this.gate.acquire(controller.signal);
      } catch (error) {
        if (error instanceof AbortWaitingError) return abortedResult(commandForResult, 0);
        throw error;
      }
      if (controller.signal.aborted) return abortedResult(commandForResult, 0);
      if (this.disposed) {
        throw new SandboxError('UNAVAILABLE', 'LocalSandboxRunner was disposed before the command started');
      }

      // ---- POSIX ulimit prelude (best effort) --------------------------------
      let spawnArgv = argv;
      if (!IS_WINDOWS) {
        const wrapper = buildUlimitWrapper(argv, effectiveLimits);
        if (wrapper) spawnArgv = wrapper.argv;
      }

      return await this.spawnAndCapture(spawnArgv, {
        cwd,
        env,
        timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        stdin: cmd.stdin,
        input: cmd.input,
        signal: controller.signal,
        auditCommand: commandForResult,
      });
    } finally {
      release?.();
      this.controllers.delete(controller);
      if (external) external.removeEventListener('abort', forwardAbort);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  private spawnAndCapture(
    argv: string[],
    opts: {
      cwd: string;
      env: Record<string, string>;
      timeoutMs: number;
      maxOutputBytes: number;
      stdin?: string;
      input?: Buffer;
      signal: AbortSignal;
      auditCommand: string[];
    },
  ): Promise<SandboxResult> {
    const startedAt = performance.now();
    const stdout = new BoundedCapture(opts.maxOutputBytes);
    const stderr = new BoundedCapture(opts.maxOutputBytes);
    const useProcessGroup = !IS_WINDOWS;

    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env,
        shell: false,
        detached: useProcessGroup,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      // Synchronous throw (rare: bad cwd, resource exhaustion) — process-level failure.
      return Promise.resolve({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: `Failed to spawn "${argv[0]}": ${(error as Error).message}`,
        durationMs: Math.round(performance.now() - startedAt),
        timedOut: false,
        killed: false,
        truncated: false,
        command: opts.auditCommand,
      });
    }

    return new Promise<SandboxResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      let killed = false;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        timeoutTimer = undefined;
        killTimer = undefined;
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      };

      const finish = (result: SandboxResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const terminate = (asTimeout: boolean): void => {
        if (settled) return;
        if (child.exitCode !== null || child.signalCode !== null) return;
        killed = true;
        if (asTimeout) timedOut = true;
        terminateProcessTree(child, 'SIGTERM', useProcessGroup);
        if (!killTimer) {
          killTimer = setTimeout(() => {
            if (!settled) terminateProcessTree(child, 'SIGKILL', useProcessGroup);
          }, this.gracePeriodMs);
          killTimer.unref?.();
        }
      };

      const onAbort = (): void => terminate(false);

      child.once('error', (error) => {
        // Process-level failure (ENOENT, EACCES, ...). Not an internal error.
        finish({
          exitCode: null,
          signal: null,
          stdout: stdout.toString(),
          stderr: `Failed to spawn "${argv[0]}": ${error.message}`,
          durationMs: Math.round(performance.now() - startedAt),
          timedOut,
          killed,
          truncated: stdout.truncated || stderr.truncated,
          command: opts.auditCommand,
        });
      });

      child.once('close', (exitCode, signal) => {
        finish({
          exitCode,
          signal,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          durationMs: Math.round(performance.now() - startedAt),
          timedOut,
          killed,
          truncated: stdout.truncated || stderr.truncated,
          command: opts.auditCommand,
        });
      });

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.stdout?.on('error', () => {});
      child.stderr?.on('error', () => {});

      const stdin = child.stdin;
      if (stdin) {
        // EPIPE is expected when the child exits without reading stdin.
        stdin.on('error', () => {});
        try {
          if (opts.input !== undefined) stdin.end(opts.input);
          else if (opts.stdin !== undefined) stdin.end(opts.stdin, 'utf8');
          else stdin.end();
        } catch {
          // Best effort: the process may already have closed its stdin.
        }
      }

      timeoutTimer = setTimeout(() => terminate(true), opts.timeoutMs);
      timeoutTimer.unref?.();

      if (opts.signal.aborted) terminate(false);
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function abortedResult(command: string[], durationMs: number): SandboxResult {
  return {
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs,
    timedOut: false,
    killed: true,
    truncated: false,
    command,
  };
}
