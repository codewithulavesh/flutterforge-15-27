/**
 * Project verification service.
 *
 * "Verified" must mean the real toolchain accepted the project. This module
 * materializes the exact files the user would export into an isolated
 * verification workspace, resolves dependencies, runs the Dart analyzer with
 * machine-readable output, and returns structured diagnostics.
 *
 * It never touches the generation workspace, so a failed verification cannot
 * corrupt the files the user is editing or the preview build.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getProjectDataRoot } from '../paths.js';
import { materializeFiles, safeRelativePath } from './workspace.js';
import { ensureFlutter } from './managedFlutter.js';
import { analyzeProject, formatDiagnostic, type Diagnostic } from './analyze.js';
import { runCommand } from './dsh.js';
import {
  fixInvalidPlainScalars,
  getToolchainVersions,
  sanitizeFlutterConstraint,
  sanitizeSdkConstraint,
} from './pubspecFix.js';
import { normalizePackageImports } from './normalizeImports.js';

export interface VerifyFileInput {
  path: string;
  content?: string | null;
  is_directory?: boolean;
  isDirectory?: boolean;
}

export interface VerifyProjectInput {
  projectId: string;
  files: VerifyFileInput[];
  /** Force a dependency resolution even when the pubspec hash is unchanged. */
  forcePubGet?: boolean;
  timeoutMs?: number;
  onLine?: (line: string) => void;
}

export interface VerifyProjectResult {
  projectId: string;
  /** true only when the analyzer actually ran and reported zero errors. */
  verified: boolean;
  /** true when the analyzer could not run (no SDK / no dependencies). */
  skipped: boolean;
  /** The analyzer's own verdict; false when skipped or when errors exist. */
  ok: boolean;
  available: boolean;
  summary: string;
  errorCount: number;
  warningCount: number;
  diagnostics: Diagnostic[];
  gate: { passed: boolean; blockers: string[] };
  pubGet: { ran: boolean; ok: boolean; output: string };
  workspace: string;
  durationMs: number;
}

const PUB_GET_TIMEOUT_MS = Number(process.env.FLUTTERFORGE_PUB_GET_TIMEOUT_MS || 4 * 60 * 1000);
const VERIFY_TIMEOUT_MS = Number(process.env.FLUTTERFORGE_VERIFY_TIMEOUT_MS || 4 * 60 * 1000);
const MAX_BLOCKERS = 12;
const PRESERVE = new Set(['.dart_tool', 'pubspec.lock', '.flutterforge-pubspec-hash']);
const locks = new Map<string, Promise<unknown>>();

function safeProjectKey(projectId: string): string {
  const raw = String(projectId ?? '').trim();
  const readable = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  if (readable.length >= 3 && readable === raw) return readable;
  return `${readable || 'project'}-${createHash('sha256').update(raw || 'default').digest('hex').slice(0, 10)}`;
}

function tail(text: string, max = 4000): string {
  return text.length > max ? text.slice(-max) : text;
}

function verificationRoot(): string {
  return process.env.FLUTTERFORGE_VERIFICATIONS || path.join(getProjectDataRoot(), 'verifications');
}

async function withProjectLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => current);
  locks.set(key, next);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (locks.get(key) === next) locks.delete(key);
  }
}

async function cleanWorkspace(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (PRESERVE.has(entry.name)) continue;
    await fs.rm(path.join(directory, entry.name), { recursive: true, force: true });
  }
}

function skippedResult(projectId: string, workspace: string, available: boolean, summary: string, extra: Partial<VerifyProjectResult> = {}): VerifyProjectResult {
  return {
    projectId,
    verified: false,
    skipped: true,
    ok: false,
    available,
    summary,
    errorCount: 0,
    warningCount: 0,
    diagnostics: [],
    gate: { passed: false, blockers: [summary] },
    pubGet: { ran: false, ok: false, output: '' },
    workspace,
    durationMs: 0,
    ...extra,
  };
}

function blockersFromDiagnostics(diagnostics: Diagnostic[]): string[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .slice(0, MAX_BLOCKERS)
    .map((diagnostic) => formatDiagnostic(diagnostic));
}

/**
 * Materialize + resolve + analyze one project.
 *
 * Failures are returned as data (never thrown) so the caller can show an
 * honest "not verified" state instead of a fake success.
 */
export async function verifyProject(input: VerifyProjectInput): Promise<VerifyProjectResult> {
  const started = Date.now();
  const projectId = String(input.projectId || 'anonymous');
  const workspace = path.join(verificationRoot(), safeProjectKey(projectId));
  const log = input.onLine ?? (() => undefined);

  if (!Array.isArray(input.files) || input.files.length === 0) {
    return skippedResult(projectId, workspace, true, 'No files were supplied to verify.');
  }

  const materializable = input.files.filter((file) => file && !file.is_directory && !file.isDirectory);
  if (materializable.length === 0) {
    return skippedResult(projectId, workspace, true, 'No source files were supplied to verify.');
  }
  if (!materializable.some((file) => file.path === 'pubspec.yaml')) {
    return skippedResult(projectId, workspace, true, 'pubspec.yaml is required before a project can be verified.');
  }

  for (const file of materializable) {
    try {
      safeRelativePath(file.path);
    } catch (error: unknown) {
      return skippedResult(
        projectId,
        workspace,
        true,
        `Unsafe project path: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return withProjectLock(safeProjectKey(projectId), async () => {
    log('[verify] Preparing isolated verification workspace…');
    await cleanWorkspace(workspace);

    try {
      await materializeFiles(workspace, materializable as any);
    } catch (error: unknown) {
      return skippedResult(
        projectId,
        workspace,
        true,
        `Could not write the project files: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const pubspecPath = path.join(workspace, 'pubspec.yaml');
    let pubspec = await fs.readFile(pubspecPath, 'utf8').catch(() => '');
    if (!pubspec.trim()) {
      return skippedResult(projectId, workspace, true, 'pubspec.yaml is empty.');
    }

    // Toolchain-level repairs mirror the preview pipeline so verification
    // fails for real code problems, not stale SDK constraints.
    try {
      const scalar = fixInvalidPlainScalars(pubspec);
      if (scalar.changed) {
        pubspec = scalar.content;
        log(`[verify] ${scalar.note}`);
      }
      const toolchain = await getToolchainVersions();
      const sdk = sanitizeSdkConstraint(pubspec, { dartVersion: toolchain.dartVersion });
      if (sdk.changed) {
        pubspec = sdk.content;
        log(`[verify] ${sdk.note}`);
      }
      const flutter = sanitizeFlutterConstraint(pubspec, { flutterVersion: toolchain.flutterVersion });
      if (flutter.changed) {
        pubspec = flutter.content;
        log(`[verify] ${flutter.note}`);
      }
      if (scalar.changed || sdk.changed || flutter.changed) {
        await fs.writeFile(pubspecPath, pubspec, 'utf8');
      }
    } catch (error: unknown) {
      log(`[verify] pubspec constraint check skipped: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      await normalizePackageImports(workspace, pubspec, log);
    } catch (error: unknown) {
      log(`[verify] import namespace check skipped: ${error instanceof Error ? error.message : String(error)}`);
    }

    let flutterBin: string;
    try {
      flutterBin = await ensureFlutter({ onProgress: log });
    } catch (error: unknown) {
      return skippedResult(
        projectId,
        workspace,
        false,
        `Flutter SDK is not available: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const pubspecHash = createHash('sha256').update(pubspec).digest('hex');
    const hashFile = path.join(workspace, '.flutterforge-pubspec-hash');
    const previousHash = await fs.readFile(hashFile, 'utf8').catch(() => '');
    const hasPackageConfig = await fs
      .access(path.join(workspace, '.dart_tool', 'package_config.json'))
      .then(() => true)
      .catch(() => false);
    const needsPubGet = input.forcePubGet === true || !hasPackageConfig || previousHash !== pubspecHash;

    let pubGet = { ran: false, ok: !needsPubGet, output: '' };
    if (needsPubGet) {
      log('[verify] Running flutter pub get…');
      const result = await runCommand(flutterBin, ['pub', 'get'], {
        cwd: workspace,
        timeoutMs: input.timeoutMs ?? PUB_GET_TIMEOUT_MS,
      });
      const output = tail(`${result.stdout}\n${result.stderr}`.trim());
      pubGet = { ran: true, ok: result.ok, output };
      if (!result.ok) {
        const reason = result.timedOut
          ? 'flutter pub get timed out'
          : `flutter pub get failed${result.code !== null ? ` (exit ${result.code})` : ''}`;
        return {
          projectId,
          verified: false,
          skipped: false,
          ok: false,
          available: true,
          summary: `${reason}; the project was not verified. ${output.split('\n').slice(-4).join(' ')}`.trim(),
          errorCount: 1,
          warningCount: 0,
          diagnostics: [],
          gate: { passed: false, blockers: [reason, ...output.split('\n').slice(-4)] },
          pubGet,
          workspace,
          durationMs: Date.now() - started,
        };
      }
      await fs.writeFile(hashFile, pubspecHash, 'utf8').catch(() => undefined);
    } else {
      log('[verify] Dependencies unchanged — reusing the warm pub cache.');
    }

    log('[verify] Running dart analyze…');
    const analysis = await analyzeProject(workspace, {
      flutterBin,
      timeoutMs: input.timeoutMs ?? VERIFY_TIMEOUT_MS,
    });
    const gateBlockers = analysis.skipped
      ? [analysis.summary]
      : blockersFromDiagnostics(analysis.diagnostics);

    const verified = analysis.available && !analysis.skipped && !analysis.timedOut && analysis.errorCount === 0;
    const result: VerifyProjectResult = {
      projectId,
      verified,
      skipped: Boolean(analysis.skipped),
      ok: Boolean(analysis.ok),
      available: Boolean(analysis.available),
      summary: analysis.summary,
      errorCount: analysis.errorCount,
      warningCount: analysis.warningCount,
      diagnostics: analysis.diagnostics,
      gate: { passed: verified, blockers: verified ? [] : gateBlockers },
      pubGet,
      workspace,
      durationMs: Date.now() - started,
    };

    log(`[verify] ${analysis.summary}`);
    for (const blocker of result.gate.blockers) log(`[verify] ${blocker}`);
    return result;
  });
}
