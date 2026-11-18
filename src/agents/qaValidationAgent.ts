/**
 * QA Validation Agent — deterministic, bounded, read-only gate.
 *
 * Runs after code generation and before the repair loop. Every problem maps to
 * exactly one GateDiagnostic with a STABLE machine code so the repair loop can
 * reason about oscillation: if the fingerprint set is unchanged between cycles,
 * the errors did not move and retrying the same fix is pointless.
 *
 * Hard rules:
 *  - Read-only. The agent never mutates generated files and never touches
 *    repairAttempts (graph.ts owns the cycle counter).
 *  - Deterministic. No LLM, no clock, no randomness. Diagnostics are
 *    deduplicated by (code, filePath, message), sorted by (filePath, line,
 *    code, message) and capped at MAX_QA_DIAGNOSTICS.
 *  - Never crashes the pipeline. Any unexpected failure inside the analysis is
 *    caught and reported as a single QA_INTERNAL diagnostic.
 *
 * The checks share the pubspec/dependency primitives from preWriteValidator.ts
 * (pubspecPackageName / declaredDependencies) so QA and the artifact gate read
 * the dependency graph the same way. Import resolution is implemented inline
 * with the same semantics so this gate stays self-contained. The mutating
 * enforceProjectContract() normalizer is deliberately NOT called here: it
 * backfills missing files (e.g. lib/main.dart), which would mask the very
 * findings this gate exists to report.
 */
import type { GateDiagnostic, ProjectState } from '../orchestrator/state';
import type { GeneratedFile } from '../orchestrator/state';
import {
  declaredDependencies,
  pubspecPackageName,
} from '../agent/preWriteValidator';

declare module '../orchestrator/state' {
  interface GateDiagnostic {
    /**
     * Stable machine code set by the QA validation agent
     * (e.g. `MISSING_MAIN`, `UNRESOLVED_IMPORT`). Used by
     * diagnosticFingerprint() to detect error-set oscillation across repair
     * cycles. Optional so existing GateDiagnostic constructors keep compiling.
     */
    code?: string;
  }
}

/** Diagnostics are deduplicated and capped so the repair loop stays bounded. */
export const MAX_QA_DIAGNOSTICS = 50;

/** A Dart package name must be a lowercase snake_case slug. */
const DART_PACKAGE_NAME = /^[a-z][a-z0-9_]*$/;

/** Matches Dart import/export/part directives and captures the URI. */
const DART_IMPORT = /(import|export|part)\s+['"]([^'"]+)['"]/g;

/** `main()` — covers `void main()`, `Future<void> main() async`, etc. */
const MAIN_FUNCTION = /\bmain\s*\(/;

const PACKAGE_URI_PREFIX = 'package:';

const DART_IMPORT_ALL = /(?:import|export|part)\s+['"]([^'"]+)['"]/g;

interface UnresolvedImport {
  path: string;
  uri: string;
  kind: 'package' | 'relative';
  message: string;
}

function normalizePosix(value: string): string {
  const out: string[] = [];
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function resolveRelativeImport(fromFile: string, uri: string): string {
  const directory = fromFile.split('/').slice(0, -1).join('/');
  return normalizePosix(`${directory}/${uri}`);
}

/** Every URI that is not `dart:`/`package:` is a project-relative reference. */
function isRelativeUri(uri: string): boolean {
  return Boolean(uri) && !uri.startsWith('dart:') && !uri.startsWith(PACKAGE_URI_PREFIX);
}

/**
 * Resolve the import graph without running Dart. External packages are not
 * inspected; self-namespace and relative imports must point at a real library
 * file. Mirrors the pre-write artifact gate so the two cannot disagree.
 */
function findUnresolvedImportsIn(
  files: Map<string, GeneratedFile>,
  selfName: string | null,
): UnresolvedImport[] {
  const dartFiles = new Map<string, string>();
  for (const [path, file] of files) {
    if (path.endsWith('.dart')) dartFiles.set(path, file.content);
  }
  const unresolved: UnresolvedImport[] = [];
  const seen = new Set<string>();
  const push = (entry: UnresolvedImport): void => {
    const key = `${entry.path} ${entry.uri}`;
    if (seen.has(key)) return;
    seen.add(key);
    unresolved.push(entry);
  };

  for (const [filePath, content] of dartFiles) {
    for (const match of content.matchAll(DART_IMPORT_ALL)) {
      const uri = match[1];
      if (!uri || uri.startsWith('dart:')) continue;
      if (uri.startsWith(PACKAGE_URI_PREFIX)) {
        if (!selfName) continue; // no package name — cannot tell self from external
        const prefix = `${PACKAGE_URI_PREFIX}${selfName}/`;
        if (!uri.startsWith(prefix)) continue;
        const target = `lib/${uri.slice(prefix.length)}`;
        if (dartFiles.has(target)) continue;
        push({
          path: filePath,
          uri,
          kind: 'package',
          message: `import '${uri}' does not resolve to any file in the project`,
        });
        continue;
      }
      if (!isRelativeUri(uri)) continue;
      const target = resolveRelativeImport(filePath, uri);
      const candidates = target.endsWith('.dart')
        ? [target]
        : [`${target}.dart`, target, `${target}/index.dart`];
      if (candidates.some((candidate) => dartFiles.has(candidate))) continue;
      push({
        path: filePath,
        uri,
        kind: 'relative',
        message: `relative import '${uri}' does not resolve to any file in the project`,
      });
    }
  }

  return unresolved;
}

/**
 * Unfinished-output markers reported by generated code. All patterns are
 * global and case-insensitive where the underlying marker is.
 */
const PLACEHOLDER_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'todo-implement', pattern: /TODO:\s*implement/gi },
  { id: 'unimplemented-error', pattern: /throw\s+UnimplementedError/g },
  { id: 'your-api-key', pattern: /YOUR_API_KEY/g },
  { id: 'replace-me', pattern: /REPLACE_ME/g },
  { id: 'lorem-ipsum', pattern: /lorem\s+ipsum/gi },
];

/**
 * Stable oscillation fingerprint for a diagnostic. Changes ONLY when the
 * underlying level/code/filePath/message tuple changes — never per line
 * number drift (line is intentionally not part of the fingerprint) and never
 * per id/counter data (messages carry no volatile payloads).
 */
export function diagnosticFingerprint(d: GateDiagnostic): string {
  return `${d.level}|${d.code}|${d.filePath}|${d.message}`;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable total ordering: filePath, then line, then code, then message. */
function compareDiagnostics(a: GateDiagnostic, b: GateDiagnostic): number {
  const byFile = compareStrings(a.filePath ?? '', b.filePath ?? '');
  if (byFile !== 0) return byFile;
  const byLine = (a.line ?? 0) - (b.line ?? 0);
  if (byLine !== 0) return byLine;
  const byCode = compareStrings(a.code ?? '', b.code ?? '');
  if (byCode !== 0) return byCode;
  return compareStrings(a.message, b.message);
}

function diagnosticKey(d: GateDiagnostic): string {
  return `${d.code ?? ''} ${d.filePath ?? ''} ${d.message}`;
}

/** Deduplicate on (code, filePath, message), sort, and cap. */
function boundDiagnostics(diagnostics: GateDiagnostic[]): GateDiagnostic[] {
  const seen = new Set<string>();
  const unique: GateDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = diagnosticKey(diagnostic);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(diagnostic);
  }
  unique.sort(compareDiagnostics);
  return unique.slice(0, MAX_QA_DIAGNOSTICS);
}

function isNonEmpty(file: GeneratedFile | undefined): file is GeneratedFile {
  return Boolean(file && file.content.trim().length > 0);
}

function analyzeProject(files: Map<string, GeneratedFile>): GateDiagnostic[] {
  const diagnostics: GateDiagnostic[] = [];
  const add = (diagnostic: GateDiagnostic): void => {
    diagnostics.push(diagnostic);
  };

  const pubspec = files.get('pubspec.yaml');
  const pubspecText = pubspec?.content ?? null;
  const selfName = pubspecText ? pubspecPackageName(pubspecText) : null;

  // ── (a) pubspec.yaml package name must be a sane Dart slug ──────────────
  if (pubspecText === null) {
    add({
      gate: 'QA-pubspec',
      code: 'MISSING_PUBSPEC',
      level: 'error',
      filePath: 'pubspec.yaml',
      message:
        'pubspec.yaml is missing — package name, environment and dependency declarations cannot be verified',
      suggestion:
        "Generate pubspec.yaml with a valid `name:`, `environment:\n  sdk:` and `dependencies:` section",
    });
  } else if (!selfName) {
    add({
      gate: 'QA-pubspec',
      code: 'PACKAGE_MISMATCH',
      level: 'error',
      filePath: 'pubspec.yaml',
      message: 'pubspec.yaml does not declare a package name (missing `name:` key)',
      suggestion: 'Add `name: my_app` (lowercase snake_case) to pubspec.yaml',
    });
  } else if (!DART_PACKAGE_NAME.test(selfName)) {
    add({
      gate: 'QA-pubspec',
      code: 'PACKAGE_MISMATCH',
      level: 'error',
      filePath: 'pubspec.yaml',
      message: `pubspec.yaml package name '${selfName}' is not a valid Dart package slug (expected /^[a-z][a-z0-9_]*$/)`,
      suggestion: `Rename the package to a valid slug, e.g. 'my_app', and rewrite package:${selfName}/ imports accordingly`,
    });
  }

  // ── (b) lib/main.dart exists, declares main() and calls runApp() ────────
  const mainDart = files.get('lib/main.dart');
  if (!isNonEmpty(mainDart)) {
    add({
      gate: 'QA-main-entrypoint',
      code: 'MISSING_MAIN',
      level: 'error',
      filePath: 'lib/main.dart',
      message: 'lib/main.dart is missing or empty — a Flutter app cannot build without an entrypoint',
      suggestion: 'Generate lib/main.dart with a main() function that calls runApp()',
    });
  } else {
    if (!MAIN_FUNCTION.test(mainDart.content)) {
      add({
        gate: 'QA-main-entrypoint',
        code: 'MISSING_MAIN',
        level: 'error',
        filePath: 'lib/main.dart',
        message: 'lib/main.dart does not declare a main() entrypoint',
        suggestion: 'Add a main() function to lib/main.dart (e.g. `void main() { ... }`)',
      });
    }
    if (!mainDart.content.includes('runApp(')) {
      add({
        gate: 'QA-main-entrypoint',
        code: 'MISSING_RUN_APP',
        level: 'error',
        filePath: 'lib/main.dart',
        message: 'lib/main.dart does not call runApp()',
        suggestion: 'Call runApp(const App()) inside main()',
      });
    }
  }

  // ── (c) package:<self>/… and relative imports resolve to library files ──
  for (const unresolved of findUnresolvedImportsIn(files, selfName)) {
    add({
      gate: 'QA-imports',
      code: 'UNRESOLVED_IMPORT',
      level: 'error',
      filePath: unresolved.path,
      message: unresolved.message,
      suggestion:
        unresolved.kind === 'package'
          ? 'Create the imported library file or fix the package: import path'
          : 'Create the imported file or fix the relative import path',
    });
  }

  // ── (d) external package imports must be declared in pubspec.yaml ───────
  if (pubspecText !== null) {
    const declared = declaredDependencies(pubspecText);
    const seenDependencies = new Set<string>();
    for (const [path, file] of files) {
      if (!path.endsWith('.dart')) continue;
      for (const match of file.content.matchAll(DART_IMPORT)) {
        const uri = match[2];
        if (!uri.startsWith(PACKAGE_URI_PREFIX)) continue;
        const packageName = uri.slice(PACKAGE_URI_PREFIX.length).split('/')[0];
        if (!packageName) continue;
        if (selfName && packageName === selfName) continue; // self-imports: check (c)
        if (declared.has(packageName)) continue;
        const key = `${path} ${packageName}`;
        if (seenDependencies.has(key)) continue;
        seenDependencies.add(key);
        add({
          gate: 'QA-dependencies',
          code: 'UNDECLARED_DEPENDENCY',
          level: 'error',
          filePath: path,
          message: `${path} imports package:${packageName} which is not declared in pubspec.yaml dependencies: or dev_dependencies:`,
          suggestion: `Add \`${packageName}\` to dependencies: in pubspec.yaml (or remove the import)`,
        });
      }
    }
    // The project must never depend on itself — that constraint duplicates or
    // conflicts with the package being built.
    if (selfName && declared.has(selfName)) {
      add({
        gate: 'QA-dependencies',
        code: 'DUPLICATE_PACKAGE_CONSTRAINT',
        level: 'warning',
        filePath: 'pubspec.yaml',
        message: `pubspec.yaml declares '${selfName}' as a dependency of itself — the self-referencing constraint duplicates the package under test`,
        suggestion: 'Remove the self-referencing entry from dependencies:/dev_dependencies:',
      });
    }
  }

  // ── (e) required app shell files exist and are non-empty ────────────────
  // lib/main.dart is enforced by (b); here we check the app root, accepting
  // either the canonical lib/app/app.dart or the legacy lib/app.dart.
  const appRoot = files.get('lib/app/app.dart');
  const legacyAppRoot = files.get('lib/app.dart');
  // Note: Boolean() on purpose — an aliased call to the type guard would
  // narrow both variables to undefined inside the branch and make the
  // `appRoot ?? legacyAppRoot` below collapse to never.
  const hasAppRoot = Boolean(appRoot && appRoot.content.trim().length > 0);
  const hasLegacyAppRoot = Boolean(legacyAppRoot && legacyAppRoot.content.trim().length > 0);
  if (!hasAppRoot && !hasLegacyAppRoot) {
    const emptyShell = appRoot ?? legacyAppRoot;
    add({
      gate: 'QA-shell-files',
      code: 'MISSING_SHELL_FILE',
      level: 'error',
      filePath: emptyShell?.path ?? 'lib/app/app.dart',
      message: emptyShell
        ? `Required app shell file is empty: ${emptyShell.path}`
        : 'Required app shell file is missing: lib/app/app.dart (neither lib/app/app.dart nor legacy lib/app.dart exists)',
      suggestion: 'Generate lib/app/app.dart with the root app widget (MaterialApp/CupertinoApp)',
    });
  }

  // ── (f) no placeholder markers in generated output ───────────────────────
  for (const [path, file] of files) {
    const markerHits: string[] = [];
    let totalMarkers = 0;
    for (const { id, pattern } of PLACEHOLDER_PATTERNS) {
      const matches = file.content.match(pattern);
      if (matches && matches.length > 0) {
        totalMarkers += matches.length;
        markerHits.push(`${id} (${matches.length})`);
      }
    }
    if (totalMarkers > 0) {
      add({
        gate: 'QA-placeholders',
        code: 'PLACEHOLDER_MARKER',
        level: 'warning',
        filePath: path,
        message: `${path} contains ${totalMarkers} placeholder marker(s): ${markerHits.join(', ')}`,
        suggestion: 'Replace placeholder markers with the real implementation before shipping',
      });
    }
  }

  return diagnostics;
}

function qaInternalDiagnostic(err: unknown): GateDiagnostic {
  const message = err instanceof Error ? err.message : String(err);
  return {
    gate: 'QA-internal',
    code: 'QA_INTERNAL',
    level: 'error',
    message: `QA validation failed internally: ${message}`,
    suggestion: 'Inspect the QA validation agent and the shared pre-write validators; this is a bug in the pipeline, not in the app',
  };
}

export async function runQAValidationAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const files = state.generatedFiles as Map<string, GeneratedFile> | undefined | null;
  const fileCount = files && typeof files.get === 'function' ? files.size : 0;

  let diagnostics: GateDiagnostic[];
  try {
    if (!files || typeof files.get !== 'function') {
      throw new Error('state.generatedFiles is missing or is not a file map');
    }
    diagnostics = analyzeProject(files);
  } catch (err) {
    // Never crash the pipeline — report the failure as a single internal diagnostic.
    diagnostics = [qaInternalDiagnostic(err)];
  }

  const bounded = boundDiagnostics(diagnostics);
  const errorCount = bounded.filter((d) => d.level === 'error').length;
  const warnCount = bounded.filter((d) => d.level === 'warning').length;

  return {
    diagnostics: bounded,
    repairAttempts: state.repairAttempts,
    logs: [
      ...state.logs,
      `[QA Validation Agent] ${errorCount} error(s), ${warnCount} warning(s) across ${fileCount} file(s). ${
        errorCount === 0 ? '✅ All deterministic checks passed.' : '❌ Errors require repair.'
      }`,
    ],
  };
}
