/**
 * Deny-by-default command policy.
 *
 * This module is the single place that decides whether an argv may execute,
 * where it may run, and which environment it may see. It is deliberately
 * pure: {@link evaluateCommand} never throws and never spawns. Callers
 * (runners) enforce the decision and convert denials into `SandboxError`.
 *
 * Nothing here interpolates caller input into a shell. The only string that
 * reaches `sh -c` is the fixed prelude produced by {@link buildUlimitWrapper},
 * whose sole expansion is `"$@"`; the command itself travels as positional
 * parameters.
 */
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  SandboxError,
  normalizeLimits,
  type SandboxCommand,
  type SandboxLimits,
} from './types.js';

export const MAX_ARGV_CHARS = 4_096;
export const MAX_ARGV_ITEMS = 256;

/** Basenames that may execute at all. `rm` is intentionally absent. */
export const ALLOWED_EXECUTABLES = Object.freeze([
  'flutter',
  'dart',
  'git',
  'node',
  'npm',
  'npx',
  'ls',
  'pwd',
  'cat',
  'echo',
  'which',
  'mkdir',
  'cp',
  'mv',
] as const);

export const DEFAULT_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'PUB_CACHE',
  'FLUTTER_ROOT',
  'FLUTTER_STORAGE_BASE_URL',
  'CI',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TERM',
  'USERPROFILE',
  'SystemRoot',
  'ComSpec',
] as const);

/**
 * Any allowlisted variable matching this pattern is dropped anyway. Defence in
 * depth: even if an operator extends the allowlist with e.g. `AWS_SESSION_TOKEN`,
 * the secret never reaches the child.
 */
export const SECRET_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i;

/**
 * Substrings that disqualify a `node -e` script. Matched case-insensitively as
 * plain substrings, so quoting/spacing tricks like `require ( 'child_process' )`
 * are still caught via `child_process`.
 */
export const NODE_E_DENY_PATTERNS = Object.freeze([
  'child_process',
  'process.binding',
  // Covers `fs.writeFile`, `fs.writeFileSync`, `require('fs').writeFile(...)`, etc.
  'writefile',
  'net',
  'dgram',
  'eval(',
] as const);

const GIT_SUBCOMMANDS = Object.freeze([
  'status',
  'diff',
  'log',
  'show',
  'branch',
  'rev-parse',
  'ls-files',
  'add',
  'commit',
  'stash',
  'checkout',
] as const);

const FLUTTER_FLAG_ALLOWS = Object.freeze(['--version', '--help'] as const);
const DART_FLAG_ALLOWS = Object.freeze(['--version'] as const);
const NPM_FLAG_ALLOWS = Object.freeze(['--version', '--help'] as const);
const NPX_FLAG_ALLOWS = Object.freeze(['--version', '--help'] as const);

/** `pub` is only ever allowed with a known safe sub-verb. */
const PUB_VERBS = Object.freeze(['get', 'outdated', 'upgrade'] as const);

export interface SandboxPolicyConfig {
  /** Replace the executable allowlist entirely (still subject to `rm` ban semantics — do not re-add `rm`). */
  allowedExecutables?: readonly string[];
  /** Replace the environment allowlist. The secret-pattern strip always applies. */
  envAllowlist?: readonly string[];
  /** Override the hard timeout ceiling (milliseconds). Defaults to {@link MAX_TIMEOUT_MS}. */
  maxTimeoutMs?: number;
  /** Override the total argv character budget. Defaults to {@link MAX_ARGV_CHARS}. */
  maxArgvChars?: number;
  /** Override the argv length budget. Defaults to {@link MAX_ARGV_ITEMS}. */
  maxArgvItems?: number;
  /** Extra lowercase substring denies appended to the `node -e` denylist. */
  nodeDenyPatterns?: readonly string[];
}

export interface EvaluateCommandOptions {
  workspaceRoot: string;
  limits?: SandboxLimits;
  config?: SandboxPolicyConfig;
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  /** Normalized argv (string-coerced, NUL-free). On success this is what executes. */
  argv: string[];
  /** Sanitized environment actually passed to the child. `{}` when evaluation fails early. */
  env: Record<string, string>;
  /** Realpath-resolved working directory, guaranteed inside the workspace when `allowed`. */
  cwd: string;
  /** Effective timeout after defaulting/clamping. Denied only when above the hard cap. */
  timeoutMs: number;
  /** Effective resource limits. */
  limits: SandboxLimits;
}

export function isSecretEnvName(name: string): boolean {
  return SECRET_ENV_PATTERN.test(name);
}

function stripWindowsNamespace(value: string): string {
  if (path.sep === '\\' && value.startsWith('\\\\?\\')) return value.slice(4);
  return value;
}

/**
 * Realpath resolving the deepest *existing* ancestor and re-appending the
 * missing tail, so `/ws/sub/dir-that-does-not-exist-yet` still resolves the
 * symlinked `/ws` prefix correctly. Never throws on ENOENT; throws only on
 * unexpected filesystem errors.
 */
export function resolveRealPath(target: string): string {
  let current = path.resolve(target);
  const missing: string[] = [];

  for (;;) {
    try {
      const real = stripWindowsNamespace(realpathSync(current));
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function comparable(value: string): string {
  // macOS and Windows default to case-insensitive filesystems; comparing
  // prefixes byte-exactly there would let `/Volumes/WS/../ws_evil`-style
  // tricks differ in case and escape. Linux stays byte-exact.
  return process.platform === 'linux' ? value : value.toLowerCase();
}

export function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = comparable(path.resolve(root));
  const resolvedCandidate = comparable(path.resolve(candidate));
  if (resolvedCandidate === resolvedRoot) return true;
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  return resolvedCandidate.startsWith(prefix);
}

/** Relative PATH entries are dropped so a workspace file can never shadow `node`/`flutter` via an inherited PATH. */
function sanitizePath(value: string): string {
  if (process.platform === 'win32') return value;
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of value.split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry) || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return entries.join(path.delimiter);
}

/**
 * Allowlist-filtered view of the environment (process.env merged with `extra`),
 * with secret-pattern names always stripped. Used for processes that need a
 * minimal, safe environment without going through full command policy — e.g.
 * the docker CLI invoked by the Docker runner.
 */
export function sanitizeEnvironment(
  extra?: Record<string, string>,
  allowlist: readonly string[] = DEFAULT_ENV_ALLOWLIST,
): Record<string, string> {
  return buildEnv(extra, allowlist);
}

function buildEnv(
  extra: Record<string, string> | undefined,
  allowlist: readonly string[],
): Record<string, string> {
  const allow = new Set(allowlist.map((name) => (process.platform === 'win32' ? name.toLowerCase() : name)));
  const output: Record<string, string> = {};
  const sources: Array<Record<string, string | undefined> | undefined> = [
    process.env as Record<string, string | undefined>,
    extra,
  ];

  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== 'string') continue;
      const lookup = process.platform === 'win32' ? key.toLowerCase() : key;
      if (!allow.has(lookup)) continue;
      if (isSecretEnvName(key)) continue;
      output[key] = key.toUpperCase() === 'PATH' ? sanitizePath(value) : value;
    }
  }
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)));
}

function executableBasename(executable: string): string {
  let base = path.basename(executable);
  if (process.platform === 'win32') base = base.replace(/\.(?:exe|cmd|bat|com)$/i, '');
  return base;
}

/** First token not starting with `-`, plus the second when it is also not a flag. */
function positionalTokens(args: readonly string[]): string[] {
  const tokens: string[] = [];
  for (const arg of args) {
    if (tokens.length >= 2) break;
    if (arg === '--') continue;
    if (arg.startsWith('-')) continue;
    tokens.push(arg);
  }
  return tokens;
}

interface SubcommandVerdict {
  ok: boolean;
  reason?: string;
}

function checkGit(args: string[]): SubcommandVerdict {
  const [sub] = positionalTokens(args);
  if (!sub) return { ok: false, reason: 'git requires an explicit subcommand' };
  if ((GIT_SUBCOMMANDS as readonly string[]).includes(sub)) return { ok: true };
  return { ok: false, reason: `git subcommand "${sub}" is not allowed` };
}

function checkFlagOrPub(
  args: string[],
  flagAllows: readonly string[],
  flagVerbs: readonly string[],
  allowTopLevel: readonly string[],
): SubcommandVerdict {
  const first = args[0];
  if (first !== undefined && (flagAllows as readonly string[]).includes(first)) {
    return { ok: true };
  }
  const [sub, second] = positionalTokens(args);
  if (!sub) return { ok: false, reason: 'a subcommand is required' };
  if (sub === 'pub') {
    if (second !== undefined && (flagVerbs as readonly string[]).includes(second)) {
      return { ok: true };
    }
    return { ok: false, reason: second ? `pub verb "${second}" is not allowed (allowed: ${flagVerbs.join(', ')})` : 'pub requires a verb (get|outdated|upgrade)' };
  }
  if ((allowTopLevel as readonly string[]).includes(sub)) return { ok: true };
  return { ok: false, reason: `subcommand "${sub}" is not allowed` };
}

function checkFlutter(args: string[]): SubcommandVerdict {
  return checkFlagOrPub(args, FLUTTER_FLAG_ALLOWS, PUB_VERBS, ['analyze', 'test', 'build', 'doctor', 'create', 'clean']);
}

function checkDart(args: string[]): SubcommandVerdict {
  return checkFlagOrPub(args, DART_FLAG_ALLOWS, PUB_VERBS, ['analyze', 'format', 'fix', 'test']);
}

function checkFlagsOnly(args: string[], flagAllows: readonly string[], toolName: string): SubcommandVerdict {
  // Only flag tokens are acceptable, and at least one must be present.
  // Positional arguments are denied so `npm install` / `npx cowsay` cannot slip through.
  if (args.length === 0) {
    return { ok: false, reason: `${toolName} only supports ${flagAllows.join(', ')}` };
  }
  for (const arg of args) {
    if (!(flagAllows as readonly string[]).includes(arg)) {
      return { ok: false, reason: `${toolName} argument "${arg}" is not allowed; only ${flagAllows.join(', ')}` };
    }
  }
  return { ok: true };
}

function checkNode(args: string[], extraDeny: readonly string[]): SubcommandVerdict {
  const first = args[0];
  if (first === '--version' || first === '--help') return { ok: true };
  if (first !== '-e') {
    return { ok: false, reason: 'node only supports --version, --help and -e' };
  }
  const script = args[1];
  if (script === undefined) return { ok: false, reason: 'node -e requires a script argument' };
  const lowered = script.toLowerCase();
  const denylist = [...NODE_E_DENY_PATTERNS, ...extraDeny.map((pattern) => pattern.toLowerCase())];
  for (const pattern of denylist) {
    if (lowered.includes(pattern)) {
      return { ok: false, reason: `node -e script contains denied pattern "${pattern}"` };
    }
  }
  return { ok: true };
}

function checkSubcommand(basename: string, args: string[], config?: SandboxPolicyConfig): SubcommandVerdict {
  switch (basename) {
    case 'git':
      return checkGit(args);
    case 'flutter':
      return checkFlutter(args);
    case 'dart':
      return checkDart(args);
    case 'npm':
      return checkFlagsOnly(args, NPM_FLAG_ALLOWS, 'npm');
    case 'npx':
      return checkFlagsOnly(args, NPX_FLAG_ALLOWS, 'npx');
    case 'node':
      return checkNode(args, config?.nodeDenyPatterns ?? []);
    default:
      // Simple utilities (ls, pwd, cat, echo, which, mkdir, cp, mv) carry no
      // dangerous subcommand grammar; shape/size/cwd limits still apply.
      return { ok: true };
  }
}

function denyDecision(
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
  limits: SandboxLimits,
  reason: string,
): PolicyDecision {
  return { allowed: false, reason, argv, env, cwd, timeoutMs, limits };
}

export function evaluateCommand(cmd: SandboxCommand, options: EvaluateCommandOptions): PolicyDecision {
  const config = options?.config;
  const limits = normalizeLimits(options?.limits);
  const maxTimeoutMs = Math.max(1, Math.floor(config?.maxTimeoutMs ?? MAX_TIMEOUT_MS));
  const maxArgvChars = Math.max(1, Math.floor(config?.maxArgvChars ?? MAX_ARGV_CHARS));
  const maxArgvItems = Math.max(1, Math.floor(config?.maxArgvItems ?? MAX_ARGV_ITEMS));
  const allowlist = config?.allowedExecutables ?? ALLOWED_EXECUTABLES;
  const envAllowlist = config?.envAllowlist ?? DEFAULT_ENV_ALLOWLIST;

  // ---- normalize + validate argv ----------------------------------------
  const rawArgv: unknown[] = Array.isArray(cmd?.argv) ? cmd.argv : [];
  const argv = rawArgv.map((arg) => (typeof arg === 'string' ? arg : String(arg)));
  const env = buildEnv(cmd?.env, envAllowlist);

  const requestedTimeout = typeof cmd?.timeoutMs === 'number' && Number.isFinite(cmd.timeoutMs)
    ? Math.floor(cmd.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const timeoutMs = requestedTimeout <= 0 ? DEFAULT_TIMEOUT_MS : requestedTimeout;

  const fallbackCwd = typeof options?.workspaceRoot === 'string' ? options.workspaceRoot : process.cwd();
  let cwd = path.resolve(fallbackCwd);

  if (argv.length === 0) {
    return denyDecision(argv, env, cwd, timeoutMs, limits, 'Command argv must be a non-empty array');
  }
  if (argv.length > maxArgvItems) {
    return denyDecision(argv, env, cwd, timeoutMs, limits, `Command has ${argv.length} arguments; the limit is ${maxArgvItems}`);
  }
  let totalChars = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.includes('\0')) {
      return denyDecision(argv, env, cwd, timeoutMs, limits, `Argument ${index} contains a NUL byte`);
    }
    totalChars += arg.length;
  }
  if (totalChars > maxArgvChars) {
    return denyDecision(argv, env, cwd, timeoutMs, limits, `Command argv is ${totalChars} characters; the limit is ${maxArgvChars}`);
  }
  if (timeoutMs > maxTimeoutMs) {
    return denyDecision(argv, env, cwd, timeoutMs, limits, `Timeout ${timeoutMs}ms exceeds the maximum of ${maxTimeoutMs}ms`);
  }

  // ---- workspace + cwd containment ---------------------------------------
  if (typeof options?.workspaceRoot !== 'string' || options.workspaceRoot.length === 0) {
    return denyDecision(argv, env, cwd, timeoutMs, limits, 'A workspace root is required');
  }
  let rootReal: string;
  try {
    rootReal = resolveRealPath(options.workspaceRoot);
  } catch (error) {
    return denyDecision(argv, env, cwd, timeoutMs, limits, `Workspace root cannot be resolved: ${(error as Error).message}`);
  }
  if (rootReal.includes('\0')) {
    return denyDecision(argv, env, rootReal, timeoutMs, limits, 'Workspace root contains a NUL byte');
  }
  try {
    if (!statSync(rootReal).isDirectory()) {
      return denyDecision(argv, env, rootReal, timeoutMs, limits, 'Workspace root is not a directory');
    }
  } catch (error) {
    return denyDecision(argv, env, rootReal, timeoutMs, limits, `Workspace root is not accessible: ${(error as Error).message}`);
  }

  const requestedCwd = cmd?.cwd;
  if (requestedCwd !== undefined && typeof requestedCwd !== 'string') {
    return denyDecision(argv, env, rootReal, timeoutMs, limits, 'Working directory must be a string');
  }
  if (requestedCwd !== undefined && requestedCwd.includes('\0')) {
    return denyDecision(argv, env, rootReal, timeoutMs, limits, 'Working directory contains a NUL byte');
  }
  const requested =
    requestedCwd === undefined || requestedCwd === ''
      ? rootReal
      : path.isAbsolute(requestedCwd)
        ? path.resolve(requestedCwd)
        : path.resolve(rootReal, requestedCwd);

  let cwdReal: string;
  try {
    cwdReal = resolveRealPath(requested);
  } catch (error) {
    return denyDecision(argv, env, rootReal, timeoutMs, limits, `Working directory cannot be resolved: ${(error as Error).message}`);
  }
  if (!isPathInside(rootReal, cwdReal)) {
    return denyDecision(argv, env, cwdReal, timeoutMs, limits, `Working directory "${cwdReal}" resolves outside the workspace root`);
  }
  cwd = cwdReal;

  // ---- executable allowlist ------------------------------------------------
  const executable = argv[0];
  if (executable.trim() !== executable || executable.length === 0) {
    return denyDecision(argv, env, cwd, timeoutMs, limits, 'Executable name is empty or has surrounding whitespace');
  }
  const base = executableBasename(executable);
  const lookup = process.platform === 'win32' ? base.toLowerCase() : base;
  const allowedLookup = new Set(allowlist.map((name) => (process.platform === 'win32' ? name.toLowerCase() : name)));

  if (base === 'rm') {
    return denyDecision(argv, env, cwd, timeoutMs, limits, 'The rm command is disabled in this sandbox');
  }
  if (!allowedLookup.has(lookup)) {
    return denyDecision(argv, env, cwd, timeoutMs, limits, `Executable "${base || executable}" is not allowlisted`);
  }
  if (executable.includes('/') || executable.includes('\\')) {
    // Explicit paths are never trusted to resolve inside the workspace when
    // they point at workspace content (a workspace-controlled shim would run
    // with the caller's privileges). Only absolute paths outside the workspace
    // that exist as regular files are permitted, e.g. /usr/bin/node.
    try {
      const real = resolveRealPath(path.isAbsolute(executable) ? executable : path.resolve(cwd, executable));
      if (!statSync(real).isFile()) {
        return denyDecision(argv, env, cwd, timeoutMs, limits, `Executable "${executable}" is not a regular file`);
      }
      if (isPathInside(rootReal, real)) {
        return denyDecision(argv, env, cwd, timeoutMs, limits, 'Executable paths inside the workspace are not allowed; invoke the allowlisted name from PATH');
      }
      argv[0] = real;
    } catch {
      return denyDecision(argv, env, cwd, timeoutMs, limits, `Executable "${executable}" does not exist`);
    }
  }

  // ---- per-executable subcommand grammar -----------------------------------
  const verdict = checkSubcommand(lookup, argv.slice(1), config);
  if (!verdict.ok) {
    return denyDecision(argv, env, cwd, timeoutMs, limits, `${base}: ${verdict.reason ?? 'command shape is not allowed'}`);
  }

  return { allowed: true, argv, env, cwd, timeoutMs, limits };
}

/** Convenience for callers that want a thrown `SandboxError` instead of a decision object. */
export function assertAllowed(cmd: SandboxCommand, options: EvaluateCommandOptions): PolicyDecision {
  const decision = evaluateCommand(cmd, options);
  if (!decision.allowed) {
    const reason = decision.reason ?? '';
    const code = /outside the workspace|workspace root|working directory/i.test(reason)
      ? 'PATH_ESCAPE'
      : 'POLICY_DENIED';
    throw new SandboxError(code, decision.reason ?? 'Command denied by sandbox policy', {
      details: { argv: decision.argv, cwd: decision.cwd },
    });
  }
  return decision;
}

export interface UlimitWrapper {
  /** argv ready to hand to `spawn` (already prefixed with `sh -c <prelude>`). */
  argv: string[];
  /** Always `false`; the field exists so callers can introspect platform handling uniformly. */
  windows: boolean;
}

/**
 * Best-effort POSIX resource limits applied via a fixed `sh -c` prelude.
 *
 * Produces `sh -c '<prelude>; exec "$@"' sh <argv...>`. The script contains no
 * caller-controlled text: argv travels exclusively as positional parameters
 * and the only expansion is `"$@"`. `ulimit` values come from normalized
 * limits; every line is `|| true` so a kernel that refuses a limit (e.g.
 * macOS refuses `ulimit -v`) degrades to a warning instead of a failure.
 *
 * `-v` is floored at 1 GiB ("unlimited-ish") because V8 reserves large
 * virtual regions and would abort at startup under a strict address-space
 * cap; the Docker runner is the hard memory boundary, this is backstop only.
 *
 * Returns `null` on Windows, where there is no equivalent builtin.
 */
export function buildUlimitWrapper(argv: readonly string[], limits: SandboxLimits): UlimitWrapper | null {
  if (process.platform === 'win32') return null;
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new SandboxError('POLICY_DENIED', 'Cannot build an ulimit wrapper for empty argv');
  }
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.includes('\0')) {
      throw new SandboxError('POLICY_DENIED', 'Cannot build an ulimit wrapper for argv containing NUL bytes');
    }
  }

  const normalized = normalizeLimits(limits);
  const cpuSeconds = Math.max(30, Math.ceil(600 * Math.min(normalized.cpuCores, 8)));
  const memoryKb = Math.max(1024 * 1024, Math.round(normalized.memoryMb) * 1024);

  const lines = [
    'ulimit -c 0 2>/dev/null || true',
    `ulimit -t ${cpuSeconds} 2>/dev/null || true`,
    `ulimit -v ${memoryKb} 2>/dev/null || true`,
    `ulimit -u ${Math.round(normalized.pidsLimit)} 2>/dev/null || true`,
  ];
  if (normalized.diskMb !== undefined) {
    // -f is measured in 1024-byte blocks on both bash and dash.
    lines.push(`ulimit -f ${Math.round(normalized.diskMb) * 1024} 2>/dev/null || true`);
  }
  if (normalized.nofileLimit !== undefined) {
    lines.push(`ulimit -n ${Math.round(normalized.nofileLimit)} 2>/dev/null || true`);
  }
  lines.push('exec "$@"');

  return {
    argv: ['sh', '-c', lines.join('\n'), 'flutterforge-sandbox', ...argv],
    windows: false,
  };
}
