/**
 * Public surface of the FlutterForge sandbox layer.
 *
 * Typical usage:
 *
 * ```ts
 * const { runner, describe } = await createSandboxRunner({ mode: 'auto', workspaceRoot });
 * const result = await runner.run({ argv: ['flutter', 'analyze'] });
 * ```
 */
import {
  DEFAULT_LIMITS,
  normalizeLimits,
  type SandboxLimits,
  type SandboxRunner,
} from './types.js';
import { DockerSandboxRunner } from './dockerRunner.js';
import { LocalSandboxRunner } from './localRunner.js';

export type {
  SandboxCommand,
  SandboxLimits,
  SandboxResult,
  SandboxRunner,
  SandboxRunOptions,
  SandboxErrorCode,
} from './types.js';
export {
  SandboxError,
  DEFAULT_LIMITS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LIMIT_BYTES,
  DEFAULT_MAX_CONCURRENT,
  TERM_GRACE_MS,
  normalizeLimits,
  normalizeOutputLimit,
} from './types.js';

export type { EvaluateCommandOptions, PolicyDecision } from './policy.js';

export {
  evaluateCommand,
  assertAllowed,
  buildUlimitWrapper,
  resolveRealPath,
  isPathInside,
  isSecretEnvName,
  sanitizeEnvironment,
  ALLOWED_EXECUTABLES,
  DEFAULT_ENV_ALLOWLIST,
  SECRET_ENV_PATTERN,
  NODE_E_DENY_PATTERNS,
  MAX_ARGV_CHARS,
  MAX_ARGV_ITEMS,
} from './policy.js';
export type { UlimitWrapper, SandboxPolicyConfig } from './policy.js';

export { LocalSandboxRunner } from './localRunner.js';
export type { LocalSandboxRunnerOptions } from './localRunner.js';

export {
  DockerSandboxRunner,
  buildDockerRunArgv,
  DOCKER_AVAILABILITY_TTL_MS,
  DOCKER_PROBE_TIMEOUT_MS,
  DEFAULT_CONTAINER_WORKDIR,
} from './dockerRunner.js';
export type {
  DockerSandboxRunnerOptions,
  DockerExecContext,
  DockerExecHook,
  DockerRunArgvInput,
} from './dockerRunner.js';

/** Default container image when none is configured. Overridable via config.image or FLUTTERFORGE_SANDBOX_IMAGE. */
export const DEFAULT_SANDBOX_IMAGE = 'flutterforge/sandbox:latest';

export type SandboxMode = 'auto' | 'local' | 'docker';

export interface CreateSandboxRunnerConfig {
  /** Execution mode. Default: `auto` — Docker when the daemon answers, otherwise local. */
  mode?: SandboxMode;
  /** Host workspace root. Default: `process.cwd()`. */
  workspaceRoot?: string;
  /** Container image for docker mode. Default: $FLUTTERFORGE_SANDBOX_IMAGE or flutterforge/sandbox:latest. */
  image?: string;
  /** Container network. Default: `none`. */
  network?: 'none' | 'bridge';
  /** OCI runtime. `runsc` selects gVisor. */
  runtime?: 'runc' | 'runsc';
  /** Container working directory. Default: `/workspace`. */
  workdir?: string;
  /** Bind-mount mode for the workspace. Default: `rw`. */
  mount?: 'ro' | 'rw';
  /** Resource limits; defaults to {@link DEFAULT_LIMITS}. */
  limits?: Partial<SandboxLimits>;
  /** Local admission gate size. Default: 2. */
  maxConcurrent?: number;
  /** Per-stream capture cap in bytes. Default: 4 MiB. */
  maxOutputBytes?: number;
}

export interface SandboxRunnerDescription {
  /** The backend actually in use. */
  mode: 'local' | 'docker';
  /** The mode that was requested. */
  requestedMode: SandboxMode;
  /** Realpath-resolved workspace root every command is confined to. */
  workspaceRoot: string;
  /** Container image, present only in docker mode. */
  image?: string;
  /** Effective resource limits. */
  limits: SandboxLimits;
  /** Local admission gate size, present only in local mode. */
  maxConcurrent?: number;
  /** Set when the requested configuration could not be honoured and a fallback was used. */
  warning?: string;
}

export interface CreatedSandboxRunner {
  runner: SandboxRunner;
  describe: SandboxRunnerDescription;
}

function describeLocal(
  runner: LocalSandboxRunner,
  requestedMode: SandboxMode,
  limits: SandboxLimits,
  warning?: string,
): CreatedSandboxRunner {
  return {
    runner,
    describe: {
      mode: 'local',
      requestedMode,
      workspaceRoot: runner.workspaceRoot,
      limits,
      maxConcurrent: runner.maxConcurrent,
      ...(warning ? { warning } : {}),
    },
  };
}

function describeDocker(
  runner: DockerSandboxRunner,
  requestedMode: SandboxMode,
  limits: SandboxLimits,
): CreatedSandboxRunner {
  return {
    runner,
    describe: {
      mode: 'docker',
      requestedMode,
      workspaceRoot: runner.workspaceRoot,
      image: runner.image,
      limits,
    },
  };
}

/**
 * Creates a sandbox runner for the requested mode.
 *
 * - `local`: always the local process sandbox.
 * - `docker`: Docker when the daemon answers `docker version`; otherwise a
 *   local runner with `describe.warning` set (the caller decides whether the
 *   degraded isolation is acceptable). Never throws solely because Docker is
 *   missing.
 * - `auto` (default): Docker when available, local otherwise.
 *
 * Nothing is logged from here; observability is the caller's job.
 */
export async function createSandboxRunner(config: CreateSandboxRunnerConfig = {}): Promise<CreatedSandboxRunner> {
  const requestedMode = config.mode ?? 'auto';
  const workspaceRoot = config.workspaceRoot ?? process.cwd();
  const limits = normalizeLimits(config.limits ?? DEFAULT_LIMITS);
  const image = config.image ?? process.env.FLUTTERFORGE_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;

  const makeLocal = (): LocalSandboxRunner =>
    new LocalSandboxRunner({
      workspaceRoot,
      limits,
      maxConcurrent: config.maxConcurrent,
      maxOutputBytes: config.maxOutputBytes,
    });

  const makeDocker = (): DockerSandboxRunner =>
    new DockerSandboxRunner({
      workspaceRoot,
      image,
      network: config.network,
      runtime: config.runtime,
      workdir: config.workdir,
      mount: config.mount,
      limits,
      maxOutputBytes: config.maxOutputBytes,
    });

  if (requestedMode === 'local') {
    return describeLocal(makeLocal(), requestedMode, limits);
  }

  // Probe Docker. Construction validates the workspace root even in `auto`
  // mode so misconfiguration surfaces identically in both modes.
  const docker = makeDocker();
  if (await docker.isAvailable()) {
    return describeDocker(docker, requestedMode, limits);
  }

  if (requestedMode === 'docker') {
    return describeLocal(
      makeLocal(),
      requestedMode,
      limits,
      'Docker is unavailable; fell back to the local process sandbox. Commands run without container isolation.',
    );
  }

  // auto: silent fallback to local.
  return describeLocal(makeLocal(), requestedMode, limits);
}
