/**
 * Hard admission gates for generated projects.
 *
 * Nothing enters a workspace until every gate here is green. A gate is only
 * allowed to report success from positive evidence:
 *  - structure  — the spec validates and the file set is self-consistent
 *  - quality    — a report exists, clears the threshold and contains no errors
 *  - budget     — file count / bytes / lines are all inside hard ceilings
 *  - tests      — meaningful tests were generated, not just test-shaped files
 *  - analyze    — the real Flutter analyzer accepted the project
 *
 * The analyzer gate is the authoritative one. If the toolchain could not run,
 * the gate fails closed unless an operator explicitly opted into unverified
 * generation via `FLUTTERFORGE_ALLOW_UNVERIFIED_GENERATION=1`.
 *
 * Gates are pure (apart from the analyze gate's verifier) and deterministic:
 * the same input always produces the same `GateResult`.
 */
import type { AppSpec, GateResult, GeneratedFile, QualityFinding, QualityReport } from '../contracts.js';
import { MIN_TOP_APP_QUALITY, QUALITY_CATEGORIES } from '../contracts.js';
import { validateSpec, verifyFileSet } from '../emit/shared.js';

export interface GenerationGateInput {
  spec: AppSpec;
  files: GeneratedFile[];
  quality?: QualityReport;
}

// ── budget ─────────────────────────────────────────────────────────────────

export interface GenerationBudget {
  /** Maximum number of emitted files. */
  maxFiles: number;
  /** Maximum total UTF-8 payload across all files. */
  maxBytes: number;
  /** Maximum UTF-8 payload for any single file (assets included). */
  maxFileBytes: number;
  /** Maximum total source lines across all files. */
  maxLines: number;
}

export const DEFAULT_GENERATION_BUDGET: GenerationBudget = Object.freeze({
  maxFiles: 400,
  maxBytes: 2_500_000,
  maxFileBytes: 120_000,
  maxLines: 40_000,
});

const MAX_ANALYZE_BLOCKERS = 12;
const MAX_DIAGNOSTIC_LENGTH = 240;
const MAX_QUALITY_ERRORS = 3;
const MAX_BUDGET_FILE_BLOCKERS = 12;
const MAX_UNMARKED_TEST_BLOCKERS = 5;

const APP_SMOKE_TEST = 'test/app/app_smoke_test.dart';
const UNVERIFIED_BLOCKER = 'ANALYZE: Flutter toolchain unavailable — verification did not run';

// ── shared helpers ─────────────────────────────────────────────────────────

function normalizeFiles(files: GeneratedFile[] | undefined): GeneratedFile[] {
  if (!Array.isArray(files)) return [];
  return files.filter((file): file is GeneratedFile => Boolean(file) && typeof file === 'object');
}

function contentOf(file: GeneratedFile): string {
  return typeof file.content === 'string' ? file.content : String(file.content ?? '');
}

function pathOf(file: GeneratedFile): string {
  return typeof file.path === 'string' ? file.path : String(file.path ?? '');
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? 'unknown error');
}

/** Deterministic, bounded text for blocker lines. */
function truncate(value: string, max = MAX_DIAGNOSTIC_LENGTH): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}…`;
}

function isDartTestPath(rawPath: string): boolean {
  return rawPath.startsWith('test/') && rawPath.endsWith('_test.dart');
}

function hasTestMarker(content: string): boolean {
  return /\btestWidgets\s*\(|\btest\s*\(/.test(content);
}

function isModelOrControllerTest(rawPath: string): boolean {
  if (!isDartTestPath(rawPath)) return false;
  if (/^test\/(data|state)\//.test(rawPath)) return true;
  return /(_model|_controller|_repository)_test\.dart$/.test(rawPath);
}

function countLines(content: string): number {
  if (!content) return 0;
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += 1;
  }
  if (content.endsWith('\n')) lines -= 1;
  return Math.max(0, lines);
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

// ── structure ──────────────────────────────────────────────────────────────

/**
 * True for paths that may not be materialized: absolute paths, Windows
 * separators/drive letters, NUL bytes and any `..` traversal segment.
 */
function isUnsafePath(rawPath: string): boolean {
  if (!rawPath) return true;
  if (rawPath.startsWith('/') || rawPath.startsWith('\\')) return true;
  if (rawPath.includes('\\') || rawPath.includes('\0')) return true;
  if (/^[A-Za-z]:/.test(rawPath)) return true;
  return rawPath.split('/').some((segment) => segment === '..');
}

/**
 * Structure gate: the spec must validate, the file set must be complete and
 * self-consistent, and the entrypoint/tests must actually exist.
 */
export function structuralGate(input: GenerationGateInput): GateResult {
  const gate = 'structure';
  const blockers: string[] = [];
  try {
    const spec = input?.spec;
    const files = normalizeFiles(input?.files);

    try {
      const validation = validateSpec(spec);
      for (const error of validation.errors) blockers.push(`STRUCTURE: ${error}`);
    } catch (error: unknown) {
      blockers.push(`STRUCTURE: spec validation failed — ${truncate(messageOf(error))}`);
    }

    const seen = new Set<string>();
    const reportedDuplicates = new Set<string>();
    const verifiable: GeneratedFile[] = [];

    for (const file of files) {
      const filePath = pathOf(file);
      if (!filePath.trim()) {
        blockers.push('STRUCTURE: invalid path: (empty)');
        continue;
      }
      if (isUnsafePath(filePath)) {
        blockers.push(`STRUCTURE: unsafe path (traversal or absolute): ${truncate(filePath)}`);
      }
      if (seen.has(filePath)) {
        if (!reportedDuplicates.has(filePath)) {
          blockers.push(`STRUCTURE: duplicate path: ${truncate(filePath)}`);
          reportedDuplicates.add(filePath);
        }
      } else {
        seen.add(filePath);
      }
      verifiable.push(file);
    }

    const packageName = String(spec?.app?.packageName ?? '');
    try {
      const problems = verifyFileSet(verifiable, packageName);
      for (const problem of problems) {
        // Invalid/duplicate paths are diagnosed above with stable wording.
        if (problem.startsWith('duplicate path: ') || problem.startsWith('invalid path: ')) continue;
        blockers.push(`STRUCTURE: ${problem}`);
      }
    } catch (error: unknown) {
      blockers.push(`STRUCTURE: file-set verification failed — ${truncate(messageOf(error))}`);
    }

    const main = files.find((file) => pathOf(file) === 'lib/main.dart');
    if (main && !/runApp\s*\(/.test(contentOf(main))) {
      blockers.push('STRUCTURE: lib/main.dart does not call runApp(...)');
    }

    const testFiles = files.filter((file) => isDartTestPath(pathOf(file)));
    if (testFiles.length === 0) {
      blockers.push('STRUCTURE: at least one test/**/*_test.dart file is required');
    }

    const uniqueBlockers = uniqueInOrder(blockers);
    return {
      gate,
      passed: uniqueBlockers.length === 0,
      blockers: uniqueBlockers,
      detail:
        uniqueBlockers.length === 0
          ? `${files.length} files · ${testFiles.length} test file(s) · runApp entrypoint present`
          : `${uniqueBlockers.length} structural blocker(s)`,
    };
  } catch (error: unknown) {
    return {
      gate,
      passed: false,
      blockers: [`STRUCTURE: internal check failure — ${truncate(messageOf(error))}`],
      detail: 'Structural validation threw; the gate fails closed.',
    };
  }
}

// ── quality ────────────────────────────────────────────────────────────────

function weakestCategories(
  categories: Record<string, number> | undefined,
  limit = 3,
): Array<{ name: string; score: number }> {
  if (!categories || typeof categories !== 'object') return [];
  const scored: Array<{ name: string; score: number; order: number }> = [];
  QUALITY_CATEGORIES.forEach((name, order) => {
    const score = Number((categories as Record<string, unknown>)[name]);
    if (Number.isFinite(score)) scored.push({ name, score, order });
  });
  scored.sort((left, right) => left.score - right.score || left.order - right.order);
  return scored.slice(0, limit).map(({ name, score }) => ({ name, score }));
}

function formatQualityFinding(finding: QualityFinding): string {
  const code = truncate(String(finding?.code ?? 'QUALITY') || 'QUALITY', 60);
  const message = truncate(String(finding?.message ?? '') || 'quality error', 180);
  const path = typeof finding?.path === 'string' && finding.path ? ` @ ${truncate(finding.path, 80)}` : '';
  return `QUALITY: error finding ${code}${path} — ${message}`;
}

/**
 * Quality gate: threshold plus a hard zero-error rule. A missing report fails
 * closed — absence of evidence is never treated as a clean report.
 */
export function qualityGate(quality: QualityReport, minimum: number = MIN_TOP_APP_QUALITY): GateResult {
  const gate = 'quality';
  const threshold = Number.isFinite(Number(minimum)) ? Number(minimum) : MIN_TOP_APP_QUALITY;

  if (!quality || typeof quality !== 'object' || !Number.isFinite(Number(quality.total))) {
    return {
      gate,
      passed: false,
      blockers: ['QUALITY: report missing'],
      detail: 'No usable quality report was supplied; the quality gate fails closed.',
    };
  }

  const total = Number(quality.total);
  const findings = Array.isArray(quality.findings) ? quality.findings.filter(Boolean) : [];
  const errors = findings.filter((finding) => String(finding?.severity).toLowerCase() === 'error');
  const blockers: string[] = [];

  if (total < threshold) {
    blockers.push(`QUALITY: total ${total} is below the minimum ${threshold}`);
  }
  if (errors.length > 0) {
    blockers.push(`QUALITY: ${errors.length} error finding(s) in the report`);
  }
  if (blockers.length > 0) {
    const weakest = weakestCategories(quality.categories);
    if (weakest.length > 0) {
      blockers.push(`QUALITY: weakest categories — ${weakest.map(({ name, score }) => `${name} ${score}`).join(', ')}`);
    }
  }
  for (const finding of errors.slice(0, MAX_QUALITY_ERRORS)) {
    blockers.push(formatQualityFinding(finding));
  }

  const uniqueBlockers = uniqueInOrder(blockers);
  return {
    gate,
    passed: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    detail:
      uniqueBlockers.length === 0
        ? `score ${total}/100 (grade ${quality.grade}) · ${findings.length} finding(s) · no errors`
        : `score ${total}/100 (grade ${quality.grade}) · ${errors.length} error finding(s)`,
  };
}

// ── budget ─────────────────────────────────────────────────────────────────

function sanitizeLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function resolveBudget(overrides?: Partial<GenerationBudget>): GenerationBudget {
  const source = overrides && typeof overrides === 'object' ? overrides : {};
  return {
    maxFiles: sanitizeLimit(source.maxFiles, DEFAULT_GENERATION_BUDGET.maxFiles),
    maxBytes: sanitizeLimit(source.maxBytes, DEFAULT_GENERATION_BUDGET.maxBytes),
    maxFileBytes: sanitizeLimit(source.maxFileBytes, DEFAULT_GENERATION_BUDGET.maxFileBytes),
    maxLines: sanitizeLimit(source.maxLines, DEFAULT_GENERATION_BUDGET.maxLines),
  };
}

/**
 * Budget gate: hard ceilings for generated payload size. Per-file bytes are
 * checked independently so a single oversized generated asset cannot hide
 * behind an otherwise small project.
 */
export function budgetGate(input: GenerationGateInput, budget?: Partial<GenerationBudget>): GateResult {
  const gate = 'budget';
  try {
    const files = normalizeFiles(input?.files);
    const limits = resolveBudget(budget);
    const ordered = [...files].sort((left, right) => pathOf(left).localeCompare(pathOf(right)));

    let totalBytes = 0;
    let totalLines = 0;
    const emptyFiles: string[] = [];
    const oversizedFiles: Array<{ path: string; bytes: number }> = [];

    for (const file of ordered) {
      const filePath = pathOf(file) || '(unknown)';
      const content = contentOf(file);
      const bytes = Buffer.byteLength(content, 'utf8');
      totalBytes += bytes;
      totalLines += countLines(content);
      if (bytes === 0) emptyFiles.push(filePath);
      if (bytes > limits.maxFileBytes) oversizedFiles.push({ path: filePath, bytes });
    }

    const blockers: string[] = [];
    if (files.length > limits.maxFiles) {
      blockers.push(`BUDGET: file count ${files.length} exceeds the limit of ${limits.maxFiles}`);
    }
    if (totalBytes > limits.maxBytes) {
      blockers.push(`BUDGET: total size ${totalBytes} bytes exceeds the limit of ${limits.maxBytes} bytes`);
    }
    if (totalLines > limits.maxLines) {
      blockers.push(`BUDGET: total lines ${totalLines} exceeds the limit of ${limits.maxLines}`);
    }

    for (const file of oversizedFiles.slice(0, MAX_BUDGET_FILE_BLOCKERS)) {
      blockers.push(
        `BUDGET: ${file.path} is ${file.bytes} bytes, exceeding the per-file limit of ${limits.maxFileBytes} bytes`,
      );
    }
    if (oversizedFiles.length > MAX_BUDGET_FILE_BLOCKERS) {
      blockers.push(
        `BUDGET: ${oversizedFiles.length - MAX_BUDGET_FILE_BLOCKERS} additional file(s) exceed the per-file limit of ${limits.maxFileBytes} bytes`,
      );
    }

    for (const filePath of emptyFiles.slice(0, MAX_BUDGET_FILE_BLOCKERS)) {
      blockers.push(`BUDGET: empty file ${filePath} (0 bytes)`);
    }
    if (emptyFiles.length > MAX_BUDGET_FILE_BLOCKERS) {
      blockers.push(`BUDGET: ${emptyFiles.length - MAX_BUDGET_FILE_BLOCKERS} additional empty file(s)`);
    }

    const uniqueBlockers = uniqueInOrder(blockers);
    return {
      gate,
      passed: uniqueBlockers.length === 0,
      blockers: uniqueBlockers,
      detail: `${files.length} files · ${totalBytes} bytes · ${totalLines} lines · limits ${limits.maxFiles} files / ${limits.maxBytes} bytes / ${limits.maxFileBytes} bytes per file / ${limits.maxLines} lines`,
    };
  } catch (error: unknown) {
    return {
      gate,
      passed: false,
      blockers: [`BUDGET: internal check failure — ${truncate(messageOf(error))}`],
      detail: 'Budget accounting threw; the gate fails closed.',
    };
  }
}

// ── tests ──────────────────────────────────────────────────────────────────

/**
 * Test gate: three real Dart test files, or one comprehensive app smoke test
 * paired with at least one model/controller test. Every counted file must
 * declare at least one `testWidgets(...)` / `test(...)` case.
 */
export function testGate(input: GenerationGateInput): GateResult {
  const gate = 'tests';
  try {
    const files = normalizeFiles(input?.files);
    const testFiles = files.filter((file) => isDartTestPath(pathOf(file)));
    const blockers: string[] = [];

    const annotated = testFiles.filter((file) => hasTestMarker(contentOf(file)));
    const unmarked = testFiles.filter((file) => !hasTestMarker(contentOf(file)));

    if (testFiles.length === 0) {
      blockers.push('TESTS: no Dart test files were generated (expected test/**/*_test.dart)');
    } else {
      for (const file of unmarked.slice(0, MAX_UNMARKED_TEST_BLOCKERS)) {
        blockers.push(`TESTS: ${pathOf(file)} declares no testWidgets(...) or test(...) case`);
      }
      if (unmarked.length > MAX_UNMARKED_TEST_BLOCKERS) {
        blockers.push(
          `TESTS: ${unmarked.length - MAX_UNMARKED_TEST_BLOCKERS} additional test file(s) declare no test case`,
        );
      }
    }

    const smoke = files.find((file) => pathOf(file) === APP_SMOKE_TEST);
    const smokeHasMarker = smoke ? hasTestMarker(contentOf(smoke)) : false;
    const smokePumpsApp = smoke ? /pumpWidget\s*\(/.test(contentOf(smoke)) : false;
    const smokeComprehensive = smokeHasMarker && smokePumpsApp;
    const modelOrControllerTests = annotated.filter((file) => isModelOrControllerTest(pathOf(file)));
    const alternativeSatisfied = smokeComprehensive && modelOrControllerTests.length > 0;

    if (annotated.length < 3 && !alternativeSatisfied) {
      blockers.push(
        `TESTS: only ${annotated.length} declarative Dart test file(s); at least 3 are required unless ${APP_SMOKE_TEST} is a comprehensive app smoke test with a model/controller test`,
      );
      if (smoke) {
        if (!smokeHasMarker) {
          blockers.push(`TESTS: ${APP_SMOKE_TEST} declares no testWidgets(...) case`);
        } else if (!smokePumpsApp) {
          blockers.push(`TESTS: ${APP_SMOKE_TEST} does not pump the app with pumpWidget(...)`);
        }
        if (smokeComprehensive && modelOrControllerTests.length === 0) {
          blockers.push(
            `TESTS: ${APP_SMOKE_TEST} requires at least one model/controller test (test/data/**, test/state/**, or *_model_test.dart / *_controller_test.dart)`,
          );
        }
      }
    }

    const uniqueBlockers = uniqueInOrder(blockers);
    return {
      gate,
      passed: uniqueBlockers.length === 0,
      blockers: uniqueBlockers,
      detail: uniqueBlockers.length
        ? `${testFiles.length} test file(s) · ${annotated.length} declarative · smoke ${smoke ? 'present' : 'absent'}`
        : `${annotated.length} declarative test file(s) · smoke ${smokeComprehensive ? 'comprehensive' : 'not used'} · model/controller ${modelOrControllerTests.length > 0 ? 'present' : 'not required'}`,
    };
  } catch (error: unknown) {
    return {
      gate,
      passed: false,
      blockers: [`TESTS: internal check failure — ${truncate(messageOf(error))}`],
      detail: 'Test-file validation threw; the gate fails closed.',
    };
  }
}

// ── analyze (real Flutter toolchain) ───────────────────────────────────────

export interface AnalyzeGateDeps {
  /** Defaults to server/harness/verify.ts verifyProject. */
  verify?: (input: { projectId: string; files: Array<{ path: string; content: string }> }) => Promise<{
    verified: boolean;
    skipped: boolean;
    available: boolean;
    summary: string;
    diagnostics: Array<{ severity: string; message: string; file?: string; line?: number }>;
  }>;
}

interface AnalyzeDiagnosticLike {
  severity?: unknown;
  message?: unknown;
  file?: unknown;
  filePath?: unknown;
  line?: unknown;
}

/** Lazy so importing the gates never touches the harness/toolchain. */
const defaultVerify: NonNullable<AnalyzeGateDeps['verify']> = async (input) => {
  const { verifyProject } = await import('../../../harness/verify.js');
  const result = await verifyProject(input);
  return {
    verified: result.verified,
    skipped: result.skipped,
    available: result.available,
    summary: result.summary,
    diagnostics: result.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      message: diagnostic.message,
      file: diagnostic.filePath || undefined,
      line: diagnostic.line || undefined,
    })),
  };
};

function allowUnverifiedGeneration(): boolean {
  return process.env.FLUTTERFORGE_ALLOW_UNVERIFIED_GENERATION === '1';
}

function formatAnalyzeDiagnostic(raw: AnalyzeDiagnosticLike): string {
  const file = typeof raw.file === 'string' && raw.file.trim()
    ? raw.file.trim()
    : typeof raw.filePath === 'string' && raw.filePath.trim()
      ? raw.filePath.trim()
      : '(project)';
  const lineValue = Number(raw.line);
  const line = Number.isFinite(lineValue) && lineValue > 0 ? `:${Math.floor(lineValue)}` : '';
  const message = truncate(String(raw.message ?? '') || 'Analyzer reported an error.');
  return truncate(`${file}${line} — ${message}`);
}

/**
 * Analyze gate: the only gate that proves the project compiles. Verification
 * that did not run is a failure by default; success requires `available` and
 * `verified` together. This function never throws.
 */
export async function analyzeGate(input: {
  projectId: string;
  spec: AppSpec;
  files: GeneratedFile[];
  deps?: AnalyzeGateDeps;
}): Promise<GateResult> {
  const gate = 'analyze';
  try {
    const verify = input?.deps?.verify ?? defaultVerify;
    const files = normalizeFiles(input?.files).map((file) => ({
      path: pathOf(file),
      content: contentOf(file),
    }));
    const result = await verify({
      projectId: String(input?.projectId ?? ''),
      files,
    });

    if (!result || typeof result !== 'object') {
      return {
        gate,
        passed: false,
        blockers: ['ANALYZE_INTERNAL: verifier returned no result'],
        detail: 'Verification produced no result; the gate fails closed.',
      };
    }

    if (result.available !== true || result.skipped === true) {
      if (allowUnverifiedGeneration()) {
        return {
          gate,
          passed: true,
          blockers: [],
          detail: 'skipped by policy',
        };
      }
      return {
        gate,
        passed: false,
        blockers: [UNVERIFIED_BLOCKER],
        detail: truncate(String(result.summary ?? '') || 'Verification did not run.', 400),
      };
    }

    if (result.verified !== true) {
      const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
      const errors = diagnostics.filter(
        (diagnostic) => String(diagnostic?.severity).toLowerCase() === 'error',
      );
      const blockers = errors
        .slice(0, MAX_ANALYZE_BLOCKERS)
        .map((diagnostic) => formatAnalyzeDiagnostic(diagnostic as AnalyzeDiagnosticLike));

      if (blockers.length === 0) {
        const summary = truncate(String(result.summary ?? ''));
        blockers.push(truncate(`ANALYZE: verification failed${summary ? ` — ${summary}` : ''}`));
      }

      return {
        gate,
        passed: false,
        blockers,
        detail: `${errors.length} analyzer error(s) · ${truncate(String(result.summary ?? ''), 400)}`,
      };
    }

    return {
      gate,
      passed: true,
      blockers: [],
      detail: truncate(String(result.summary ?? '') || 'Flutter analyzer accepted the project.', 400),
    };
  } catch (error: unknown) {
    return {
      gate,
      passed: false,
      blockers: [`ANALYZE_INTERNAL: ${truncate(messageOf(error))}`],
      detail: 'Verification threw; the analyze gate fails closed.',
    };
  }
}

// ── aggregation ────────────────────────────────────────────────────────────

function prefixBlockers(prefix: string, blockers: string[]): string[] {
  return blockers.map((blocker) => {
    const text = String(blocker ?? '').trim() || '(no detail)';
    // Preserve already-prefixed blockers, including ANALYZE_INTERNAL variants.
    if (text.startsWith(`${prefix}:`) || text.startsWith(`${prefix}_`)) return text;
    return `${prefix}: ${text}`;
  });
}

/**
 * AND aggregation. Input order is preserved so the blocking reason list is
 * deterministic. A failed gate without blockers is surfaced explicitly rather
 * than silently passing, and an empty gate list fails closed.
 */
export function aggregateGates(gates: GateResult[]): {
  passed: boolean;
  blockers: string[];
  gates: GateResult[];
} {
  const list = Array.isArray(gates)
    ? gates.filter((gate): gate is GateResult => Boolean(gate) && typeof gate === 'object')
    : [];
  const blockers: string[] = [];

  for (const result of list) {
    const prefix = String(result.gate ?? 'gate').trim().toUpperCase() || 'GATE';
    const gateBlockers = Array.isArray(result.blockers) ? result.blockers.map(String) : [];
    if (result.passed === true && gateBlockers.length === 0) continue;
    if (!result.passed && gateBlockers.length === 0) {
      blockers.push(`${prefix}: gate failed without a reported blocker`);
      continue;
    }
    blockers.push(...prefixBlockers(prefix, gateBlockers));
  }

  if (list.length === 0) {
    blockers.push('GATES: no gates were evaluated');
  }

  const passed = list.length > 0 && list.every((result) => result.passed === true) && blockers.length === 0;
  return {
    passed,
    blockers,
    gates: list.map((result) => ({
      ...result,
      blockers: Array.isArray(result.blockers) ? [...result.blockers] : [],
    })),
  };
}
