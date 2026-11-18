/**
 * Docker-backed sandbox runner.
 *
 * Builds a hardened `docker run` invocation — an argv array, never a shell
 * string — and hands it to the local runner (or to an injected exec hook in
 * tests). Every run gets: no network by default, a read-only root filesystem,
 * a bounded tmpfs, memory/CPU/PID limits, dropped capabilities, the
 * no-new-privileges security option, a non-root uid:gid and a bind-mounted
 * workspace.
 *
 * The command policy is enforced here, once, before the docker client is
 * spawned; the inner local runner is constructed with `skipPolicy` because
 * re-evaluating would double-count and its allowlist does not (and should not)
 * contain `docker`. For hostile workloads pair this with a stronger runtime
 * via the `runtime: 'runsc'` option (gVisor).
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import {
  assertAllowed,
  resolveRealPath,
  sanitizeEnvironment,
} from './policy.js';
import { LocalSandboxRunner } from './localRunner.js';
import {
  DEFAULT_LIMITS,
  DEFAULT_MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  SandboxError,
  normalizeLimits,
  normalizeOutputLimit,
  type SandboxCommand,
  type SandboxLimits,
  type SandboxResult,
  type SandboxRunner,
  type SandboxRunOptions,
} from './types.js';

/** How long a positive/negative `docker version` probe stays cached. */
export const DOCKER_AVAILABILITY_TTL_MS = 30_000;
/** Timeout for the `docker version` availability probe. */
export const DOCKER_PROBE_TIMEOUT_MS = 3_000;
/** Default container workdir; the host workspace root is bind-mounted here. */
export const DEFAULT_CONTAINER_WORKDIR = '/workspace';

export interface DockerExecContext {
  /** Host-side working directory for the docker CLI itself (the real workspace root). */
  cwd: string;
  /** Sanitized environment for the docker client process. */
  env: Record<string, string>;
  /** Stdin payload forwarded into `docker run -i`. */
  input?: Buffer | string;
  /** Timeout budget for the inner docker invocation. */
  timeoutMs: number;
  /** Cooperative cancellation propagated to the docker client process. */
  signal?: AbortSignal;
  /** Effective, normalized limits for this invocation. */
  limits: SandboxLimits;
  /** Audit copy of the full argv including the leading `docker`. */
  command: string[];
}

/**
 * Injectable execution hook. Replaces spawning the docker client entirely;
 * production uses the built-in path, tests capture the argv instead. The hook
 * must resolve a {@link SandboxResult} — it is not allowed to reject for
 * process-level failures any more than the local runner is.
 */
export type DockerExecHook = (argv: string[], context: DockerExecContext) => Promise<SandboxResult>;

export interface DockerSandboxRunnerOptions {
  /** Host directory to bind-mount at `workdir`. Must be absolute; realpath'd; must not contain `,` or newlines. */
  workspaceRoot: string;
  /** Container image, e.g. `flutterforge/sandbox:latest`. */
  image: string;
  /** Container network. Default: `none` (no network at all). */
  network?: 'none' | 'bridge';
  /** OCI runtime. `runsc` appends `--runtime=runsc` (gVisor). */
  runtime?: 'runc' | 'runsc';
  /** Container working directory. Default: `/workspace`. */
  workdir?: string;
  /** Bind-mount mode for the workspace. Default: `rw`. */
  mount?: 'ro' | 'rw';
  /** Default limits; overridable per run. */
  limits?: Partial<SandboxLimits>;
  /** Per-stream capture cap. Default: 4 MiB. */
  maxOutputBytes?: number;
  /** Test hook replacing the docker client spawn entirely. */
  exec?: DockerExecHook;
}

function validateWorkspaceRoot(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new SandboxError('UNAVAILABLE', 'DockerSandboxRunner requires an absolute workspaceRoot');
  }
  if (!path.isAbsolute(raw)) {
    throw new SandboxError('UNAVAILABLE', `Workspace root must be absolute, got "${raw}"`);
  }
  let real: string;
  try {
    real = resolveRealPath(raw);
  } catch (error) {
    throw new SandboxError('UNAVAILABLE', `Workspace root cannot be resolved: ${(error as Error).message}`, { cause: error });
  }
  try {
    if (!statSyncDirectory(real)) {
      throw new SandboxError('UNAVAILABLE', `Workspace root does not exist or is not a directory: ${real}`);
    }
  } catch (error) {
    if (error instanceof SandboxError) throw error;
    throw new SandboxError('UNAVAILABLE', `Workspace root is not accessible: ${(error as Error).message}`, { cause: error });
  }
  // The -v operand is colon-delimited inside docker itself; commas are not
  // legal inside docker's -v spec parsing on some versions and newlines are
  // never acceptable in an argv that may be logged.
  if (real.includes(',') || real.includes('\n') || real.includes('\r')) {
    throw new SandboxError('UNAVAILABLE', 'Workspace root must not contain commas or newlines (docker -v parsing)');
  }
  return real;
}

function statSyncDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function validateImage(image: unknown): string {
  if (typeof image !== 'string' || image.trim().length === 0) {
    throw new SandboxError('UNAVAILABLE', 'DockerSandboxRunner requires a container image');
  }
  if (/[\s,]/.test(image) || image.includes('\0') || image.includes('\n')) {
    throw new SandboxError('UNAVAILABLE', `Container image "${image}" contains illegal characters`);
  }
  return image.trim();
}

function validateWorkdir(workdir: unknown): string {
  if (workdir === undefined) return DEFAULT_CONTAINER_WORKDIR;
  if (typeof workdir !== 'string' || !workdir.startsWith('/') || workdir.includes('..') || workdir.includes('\0') || workdir.includes(',')) {
    throw new SandboxError('UNAVAILABLE', `Container workdir must be an absolute POSIX path without "..", got "${String(workdir)}"`);
  }
  return path.posix.normalize(workdir);
}

function toContainerPath(rootReal: string, hostPath: string, workdir: string): string {
  const relative = path.relative(rootReal, hostPath);
  if (relative === '') return workdir;
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SandboxError('PATH_ESCAPE', `Host path "${hostPath}" is outside the mounted workspace`);
  }
  const posixRelative = relative.split(path.sep).join('/');
  return path.posix.join(workdir, posixRelative);
}

export interface DockerRunArgvInput {
  image: string;
  network: 'none' | 'bridge';
  runtime?: 'runc' | 'runsc';
  workdir: string;
  mount: 'ro' | 'rw';
  rootReal: string;
  containerCwd: string;
  cmdArgv: string[];
  env: Record<string, string>;
  limits: SandboxLimits;
  interactive: boolean;
}

/** Pure argv builder, exported for tests and audits. Returns argv *including* the leading `docker`. */
export function buildDockerRunArgv(input: DockerRunArgvInput): string[] {
  const argv: string[] = ['docker', 'run', '--rm'];
  if (input.interactive) argv.push('-i');
  argv.push(`--network=${input.network}`);
  argv.push('--read-only');
  argv.push('--tmpfs', '/tmp:rw,noexec,nosuid,size=256m');
  argv.push(`--memory=${Math.round(input.limits.memoryMb)}m`);
  argv.push(`--cpus=${input.limits.cpuCores}`);
  argv.push(`--pids-limit=${Math.round(input.limits.pidsLimit)}`);
  argv.push('--cap-drop=ALL');
  argv.push('--security-opt=no-new-privileges');
  argv.push('--user=1000:1000');
  for (const [key, value] of Object.entries(input.env)) {
    argv.push('-e', `${key}=${value}`);
  }
  argv.push('-v', `${input.rootReal}:${input.workdir}:${input.mount}`);
  argv.push('-w', input.containerCwd);
  if (input.runtime === 'runsc') argv.push('--runtime=runsc');
  argv.push(input.image, ...input.cmdArgv);
  return argv;
}

export class DockerSandboxRunner implements SandboxRunner {
  readonly workspaceRoot: string;
  readonly image: string;
  readonly network: 'none' | 'bridge';
  readonly runtime?: 'runc' | 'runsc';
  readonly workdir: string;
  readonly mount: 'ro' | 'rw';
  readonly limits: SandboxLimits;
  readonly maxOutputBytes: number;

  private readonly execHook?: DockerExecHook;
  private inner: LocalSandboxRunner | null = null;
  private readonly controllers = new Set<AbortController>();
  private availabilityCache: { value: boolean; expiresAt: number } | null = null;
  private disposed = false;

  constructor(options: DockerSandboxRunnerOptions) {
    if (!options || typeof options !== 'object') {
      throw new SandboxError('UNAVAILABLE', 'DockerSandboxRunner requires an options object');
    }
    this.workspaceRoot = validateWorkspaceRoot(options.workspaceRoot);
    this.image = validateImage(options.image);
    this.network = options.network === 'bridge' ? 'bridge' : 'none';
    if (options.runtime !== undefined && options.runtime !== 'runc' && options.runtime !== 'runsc') {
      throw new SandboxError('UNAVAILABLE', `Unsupported runtime "${String(options.runtime)}"; expected "runc" or "runsc"`);
    }
    this.runtime = options.runtime;
    this.workdir = validateWorkdir(options.workdir);
    if (options.mount !== undefined && options.mount !== 'ro' && options.mount !== 'rw') {
      throw new SandboxError('UNAVAILABLE', `Unsupported mount mode "${String(options.mount)}"; expected "ro" or "rw"`);
    }
    this.mount = options.mount ?? 'rw';
    this.limits = normalizeLimits(options.limits ?? DEFAULT_LIMITS);
    this.maxOutputBytes = normalizeOutputLimit(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
    this.execHook = options.exec;
  }

  /**
   * Probes `docker version --format {{.Server.Version}}` with a 3s timeout.
   * Result is cached for {@link DOCKER_AVAILABILITY_TTL_MS} (30s). Purely
   * observational — safe to call at any time, never throws.
   */
  async isAvailable(forceRefresh = false): Promise<boolean> {
    const now = Date.now();
    if (!forceRefresh && this.availabilityCache && this.availabilityCache.expiresAt > now) {
      return this.availabilityCache.value;
    }
    const value = await probeDocker(DOCKER_PROBE_TIMEOUT_MS);
    this.availabilityCache = { value, expiresAt: now + DOCKER_AVAILABILITY_TTL_MS };
    return value;
  }

  async run(cmd: SandboxCommand, options: SandboxRunOptions = {}): Promise<SandboxResult> {
    if (this.disposed) {
      throw new SandboxError('UNAVAILABLE', 'DockerSandboxRunner has been disposed');
    }
    if (cmd === null || typeof cmd !== 'object' || !Array.isArray(cmd.argv)) {
      throw new SandboxError('POLICY_DENIED', 'SandboxCommand must include an argv array');
    }
    if (options.signal?.aborted) {
      return abortedResult(cmd.argv.map(String));
    }

    const effectiveLimits = normalizeLimits(options.limits ?? this.limits);

    // Policy is enforced exactly once, here. The inner local runner (or the
    // injected hook) executes the docker client under the same limits with
    // the check disabled.
    const decision = assertAllowed(cmd, { workspaceRoot: this.workspaceRoot, limits: effectiveLimits });

    const containerCwd = toContainerPath(this.workspaceRoot, decision.cwd, this.workdir);
    const interactive = cmd.input !== undefined || cmd.stdin !== undefined;
    const command = buildDockerRunArgv({
      image: this.image,
      network: this.network,
      runtime: this.runtime,
      workdir: this.workdir,
      mount: this.mount,
      rootReal: this.workspaceRoot,
      containerCwd,
      cmdArgv: decision.argv,
      env: decision.env,
      limits: effectiveLimits,
      interactive,
    });

    const controller = new AbortController();
    const external = options.signal;
    const forwardAbort = (): void => controller.abort();
    if (external) {
      external.addEventListener('abort', forwardAbort, { once: true });
    }
    this.controllers.add(controller);

    const context: DockerExecContext = {
      cwd: this.workspaceRoot,
      env: sanitizeEnvironment(decision.env),
      input: cmd.input ?? cmd.stdin,
      timeoutMs: Math.min(Math.max(1, decision.timeoutMs), MAX_TIMEOUT_MS),
      signal: controller.signal,
      limits: effectiveLimits,
      command,
    };

    try {
      if (this.execHook) {
        const result = await this.execHook(command, context);
        return { ...result, command };
      }
      const inner = this.getInnerRunner(effectiveLimits);
      return await inner.run(
        {
          argv: command,
          cwd: this.workspaceRoot,
          env: context.env,
          timeoutMs: context.timeoutMs,
          stdin: cmd.stdin,
          input: cmd.input,
        },
        { signal: controller.signal, limits: effectiveLimits },
      );
    } finally {
      this.controllers.delete(controller);
      if (external) external.removeEventListener('abort', forwardAbort);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    if (this.inner) {
      await this.inner.dispose();
      this.inner = null;
    }
  }

  private getInnerRunner(limits: SandboxLimits): LocalSandboxRunner {
    if (!this.inner) {
      this.inner = new LocalSandboxRunner({
        workspaceRoot: this.workspaceRoot,
        limits,
        maxOutputBytes: this.maxOutputBytes,
        skipPolicy: true,
      });
    }
    return this.inner;
  }
}

function probeDocker(timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let child;
    try {
      child = spawn('docker', ['version', '--format', '{{.Server.Version}}'], {
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: sanitizeEnvironment(undefined),
        windowsHide: true,
      });
    } catch {
      finish(false);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish(false);
    }, timeoutMs);
    timer.unref?.();

    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
  });
}

function abortedResult(command: string[]): SandboxResult {
  return {
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    killed: true,
    truncated: false,
    command,
  };
}
