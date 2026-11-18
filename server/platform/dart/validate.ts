/**
 * Deterministic pre-write structural gate for Dart sources.
 *
 * `validateDartFiles` inspects an in-memory set of project files and returns
 * a pass/fail verdict with diagnostics. It is deliberately dependency-free and
 * deterministic: identical input always produces byte-identical output arrays.
 * All diagnostics are sorted by (path, line, column, code, message) and capped
 * at `MAX_DIAGNOSTICS` entries; the `truncated` flag reports when the cap was
 * hit.
 *
 * Diagnostic codes:
 * - DELIMITER_IMBALANCE — unclosed/unmatched `()`, `[]`, `{}` (error)
 * - LEX_ERROR           — tokenizer errors (error)
 * - UNRESOLVED_IMPORT   — import/export/part URI did not resolve to a project
 *                         file or external package (error)
 * - SELF_PACKAGE_MISMATCH — `package:<other>/…` used where `<self>` is
 *                         expected; without pubspec's declared-dependency
 *                         list this cannot be told apart from a legitimate
 *                         external dependency, so it is a warning
 * - MISSING_MAIN        — entrypoint has no top-level `main` (error)
 * - MISSING_RUN_APP     — entrypoint never calls `runApp(` (error)
 * - DUPLICATE_DECLARATION — same top-level declaration name twice in one
 *                         library or across files (error; a getter+setter
 *                         pair is allowed, private cross-library names are not flagged)
 * - EMPTY_FILE          — file without any significant tokens (error)
 * - MISSING_PART        — `part 'x.dart'` target not present in the file set (error)
 * - PART_MISSING_OF     — part file lacks `part of` (or points at a different
 *                         library) (error)
 * - IMPORT_CYCLE        — import/export cycle between project files (warning;
 *                         Dart permits cyclic imports, so this does not block)
 * - SECRET_IN_CODE      — live-looking credential material in sources (error)
 */
import { analyzeDart } from './ast.js';
import type { DartAnalysis, DartSymbol } from './ast.js';
import { tokenize, significantTokens } from './lexer.js';
import type { Token } from './lexer.js';
import { buildImportGraph, normalizeProjectPath } from './imports.js';

export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  path: string;
  line: number;
  column: number;
  message: string;
}

export interface ValidationResult {
  /** True when no error-severity diagnostics were produced (after capping). */
  passed: boolean;
  /** Error-severity diagnostics. */
  blockers: Diagnostic[];
  /** Warning-severity diagnostics. */
  warnings: Diagnostic[];
  /** All diagnostics (errors and warnings), sorted and capped. */
  diagnostics: Diagnostic[];
  /** True when the raw diagnostic count exceeded MAX_DIAGNOSTICS. */
  truncated: boolean;
}

export interface ValidateDartFilesOptions {
  files: Array<{ path: string; content: string }>;
  packageName: string;
  /** Project-relative entrypoint, defaults to `lib/main.dart`. */
  entrypoint?: string;
}

const MAX_DIAGNOSTICS = 200;
const MAX_DELIMITER_ISSUES_PER_FILE = 20;
const MAX_SECRETS_PER_FILE = 10;

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    byString(a.path, b.path) ||
    a.line - b.line ||
    a.column - b.column ||
    byString(a.code, b.code) ||
    byString(a.message, b.message)
  );
}

/** Compute line/column (1-based) for a raw source offset. */
function lineColAt(lineStarts: number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - lineStarts[low] + 1 };
}

function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code === 10) starts.push(i + 1);
    else if (code === 13) {
      if (i + 1 < source.length && source.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

// ---------------------------------------------------------------------
// Delimiter balance
// ---------------------------------------------------------------------

const BRACKET_PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const BRACKET_OPEN = new Set(['(', '[', '{']);
const BRACKET_CLOSE = new Set([')', ']', '}']);

function checkDelimiters(path: string, tokens: Token[], push: (d: Diagnostic) => void): void {
  const stack: Token[] = [];
  let issues = 0;
  for (const token of tokens) {
    if (token.kind === 'eof') break;
    const value = token.value;
    if (BRACKET_OPEN.has(value)) {
      stack.push(token);
      continue;
    }
    if (BRACKET_CLOSE.has(value)) {
      const expected = BRACKET_PAIRS[value];
      const top = stack[stack.length - 1];
      if (top && top.value === expected) {
        stack.pop();
        continue;
      }
      // Recovery: if a matching opener exists deeper in the stack, every
      // opener above it is implicitly unclosed — report those (at their own
      // lines) and treat this closer as closing the matching opener.
      let matchIndex = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].value === expected) {
          matchIndex = i;
          break;
        }
      }
      if (matchIndex === -1) {
        push({
          code: 'DELIMITER_IMBALANCE',
          severity: 'error',
          path,
          line: token.line,
          column: token.column,
          message: `Unmatched '${value}'${top ? ` (expected to close '${top.value}' from line ${top.line})` : ''}.`,
        });
        if (++issues >= MAX_DELIMITER_ISSUES_PER_FILE) return;
        continue;
      }
      for (let i = stack.length - 1; i > matchIndex; i--) {
        const open = stack[i];
        push({
          code: 'DELIMITER_IMBALANCE',
          severity: 'error',
          path,
          line: open.line,
          column: open.column,
          message: `Unclosed '${open.value}'.`,
        });
        if (++issues >= MAX_DELIMITER_ISSUES_PER_FILE) return;
      }
      stack.length = matchIndex;
    }
  }
  for (const open of stack) {
    push({
      code: 'DELIMITER_IMBALANCE',
      severity: 'error',
      path,
      line: open.line,
      column: open.column,
      message: `Unclosed '${open.value}'.`,
    });
    if (++issues >= MAX_DELIMITER_ISSUES_PER_FILE) return;
  }
}

// ---------------------------------------------------------------------
// Secret detection
// ---------------------------------------------------------------------

interface SecretPattern {
  name: string;
  regex: RegExp;
  /** Capture group holding the secret itself (preceded by a context boundary). */
  group: number;
}

/**
 * Live-looking credentials. Prefix patterns require the secret to follow a
 * context boundary (start of input, whitespace, quote, or an assignment-ish
 * delimiter) so that prose like `disk-skateboarding-…` never matches.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'OpenRouter API key', regex: /(^|[\s'"=:(,[{`])(sk-or-v1-[A-Za-z0-9-]{16,})/gm, group: 2 },
  { name: 'OpenAI API key', regex: /(^|[\s'"=:(,[{`])(sk-(?!or-v1-)[A-Za-z0-9_-]{20,})/gm, group: 2 },
  { name: 'Google API key', regex: /(^|[\s'"=:(,[{`])(AIza[0-9A-Za-z_-]{35})/gm, group: 2 },
  { name: 'AWS access key ID', regex: /(^|[\s'"=:(,[{`])(AKIA[0-9A-Z]{16})/gm, group: 2 },
  { name: 'Private key block', regex: /(-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----)/g, group: 1 },
  { name: 'JWT', regex: /(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g, group: 1 },
];

const PLACEHOLDER_MARKERS = /your|example|placeholder|redacted|change[_-]?me|insert[_ -]?here|dummy|fake|sample|not[_-]?real|xxxxx|aaaaaa|0000000|1234567/i;

function looksLikePlaceholder(secret: string): boolean {
  if (PLACEHOLDER_MARKERS.test(secret)) return true;
  // A body made of a single repeated character is never a live credential.
  const body = secret.replace(/^(sk-or-v1-|sk-|AIza|AKIA|eyJ)/, '');
  if (body.length > 0) {
    const first = body[0];
    let allSame = true;
    for (let i = 1; i < body.length; i++) {
      if (body[i] !== first) {
        allSame = false;
        break;
      }
    }
    if (allSame) return true;
  }
  return false;
}

function findSecrets(path: string, source: string, push: (d: Diagnostic) => void): void {
  const lineStarts = computeLineStarts(source);
  let emitted = 0;
  for (const { name, regex, group } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      const secret = match[group];
      if (!secret) {
        regex.lastIndex++;
        continue;
      }
      if (name === 'JWT' && secret.length <= 40) continue;
      if (looksLikePlaceholder(secret)) continue;
      const secretOffset = match.index + match[0].length - secret.length;
      const { line, column } = lineColAt(lineStarts, secretOffset);
      push({
        code: 'SECRET_IN_CODE',
        severity: 'error',
        path,
        line,
        column,
        message: `${name} detected in source; move credentials to environment variables or a secret store.`,
      });
      if (++emitted >= MAX_SECRETS_PER_FILE) return;
    }
  }
}

// ---------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------

const TOP_LEVEL_KINDS = new Set([
  'class',
  'mixin',
  'extension',
  'enum',
  'typedef',
  'function',
  'getter',
  'setter',
  'variable',
]);

interface LibraryOccurrence {
  file: string;
  symbol: DartSymbol;
  library: string;
}

function libraryIdentity(filePath: string, analysis: DartAnalysis, fileSet: Set<string>): string {
  const partOf = analysis.parts.find((directive) => directive.kind === 'partOf');
  if (partOf?.uri) {
    const joined = normalizeProjectPath(posixJoin(posixDirname(filePath), partOf.uri));
    if (fileSet.has(joined)) return joined;
    return `part-of:${joined}`;
  }
  return filePath;
}

// Local posix helpers (kept local so this module makes no platform assumptions).
function posixDirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '.' : idx === 0 ? '/' : path.slice(0, idx);
}

function posixJoin(dir: string, rel: string): string {
  const combined = rel.startsWith('/') ? rel : `${dir}/${rel}`;
  const segments = combined.split('/');
  const out: string[] = [];
  const absolute = segments[0] === '';
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  return (absolute ? '/' : '') + out.join('/');
}

function findDuplicates(
  files: Array<{ path: string; analysis: DartAnalysis }>,
  fileSet: Set<string>,
  push: (d: Diagnostic) => void,
): void {
  const byName = new Map<string, LibraryOccurrence[]>();
  for (const file of files) {
    const library = libraryIdentity(file.path, file.analysis, fileSet);
    for (const symbol of file.analysis.symbols) {
      if (symbol.enclosing) continue; // members are never "top-level" duplicates
      if (!TOP_LEVEL_KINDS.has(symbol.kind)) continue;
      const list = byName.get(symbol.name) ?? [];
      list.push({ file: file.path, symbol, library });
      byName.set(symbol.name, list);
    }
  }

  for (const [name, occurrences] of byName) {
    if (occurrences.length < 2) continue;
    const sorted = [...occurrences].sort(
      (a, b) => byString(a.file, b.file) || a.symbol.offset - b.symbol.offset || byString(a.symbol.kind, b.symbol.kind),
    );
    const allAccessorPair = sorted.every((entry) => entry.symbol.kind === 'getter' || entry.symbol.kind === 'setter');
    // Getter/setter pairs are legal; in each library allow at most one of each.
    if (allAccessorPair) {
      const perLibrary = new Map<string, { getters: number; setters: number }>();
      let ok = true;
      for (const entry of sorted) {
        const bucket = perLibrary.get(entry.library) ?? { getters: 0, setters: 0 };
        if (entry.symbol.kind === 'getter') bucket.getters += 1;
        else bucket.setters += 1;
        perLibrary.set(entry.library, bucket);
      }
      for (const bucket of perLibrary.values()) {
        if (bucket.getters > 1 || bucket.setters > 1) ok = false;
      }
      if (ok) continue;
    }
    const isPrivate = name.startsWith('_');
    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      const prior = sorted.slice(0, i);
      const sameLibrary = prior.some((entry) => entry.library === current.library);
      const crossLibraryPublic = !isPrivate && prior.some((entry) => entry.library !== current.library);
      if (!sameLibrary && !crossLibraryPublic) continue;
      const first = prior[0];
      push({
        code: 'DUPLICATE_DECLARATION',
        severity: 'error',
        path: current.file,
        line: current.symbol.line,
        column: current.symbol.column,
        message:
          `Duplicate top-level declaration '${name}' ` +
          `(${current.symbol.kind} at ${current.file}:${current.symbol.line}, ` +
          `first declared at ${first.file}:${first.symbol.line}).`,
      });
    }
  }
}

// ---------------------------------------------------------------------
// Entrypoint checks
// ---------------------------------------------------------------------

function checkEntrypoint(
  entrypoint: string,
  analysis: DartAnalysis | null,
  tokens: Token[] | null,
  push: (d: Diagnostic) => void,
): void {
  if (!analysis) {
    push({
      code: 'MISSING_MAIN',
      severity: 'error',
      path: entrypoint,
      line: 1,
      column: 1,
      message: `Entrypoint not found in supplied files: ${entrypoint}.`,
    });
    return;
  }
  const hasMain = analysis.symbols.some(
    (symbol) => symbol.kind === 'function' && symbol.name === 'main' && symbol.enclosing === undefined,
  );
  if (!hasMain) {
    push({
      code: 'MISSING_MAIN',
      severity: 'error',
      path: entrypoint,
      line: 1,
      column: 1,
      message: `Entrypoint ${entrypoint} does not declare a top-level 'main' function.`,
    });
  }
  if (tokens) {
    let hasRunApp = false;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].kind === 'identifier' && tokens[i].value === 'runApp' && tokens[i + 1]?.value === '(') {
        hasRunApp = true;
        break;
      }
    }
    if (!hasRunApp) {
      push({
        code: 'MISSING_RUN_APP',
        severity: 'error',
        path: entrypoint,
        line: 1,
        column: 1,
        message: `Entrypoint ${entrypoint} never calls runApp(.`,
      });
    }
  }
}

// ---------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------

/**
 * Validate a set of Dart files. Never throws; even catastrophic input yields
 * a (failed) ValidationResult with diagnostics instead of an exception.
 */
export function validateDartFiles(options: ValidateDartFilesOptions): ValidationResult {
  const rawFiles = Array.isArray(options?.files) ? options.files : [];
  const packageName = typeof options?.packageName === 'string' ? options.packageName : '';
  const entrypoint = normalizeProjectPath(options?.entrypoint ?? 'lib/main.dart');

  const diagnostics: Diagnostic[] = [];
  const push = (diagnostic: Diagnostic): void => {
    diagnostics.push(diagnostic);
  };

  // Normalize + dedupe input files (keep first occurrence; deterministic).
  const seenPaths = new Set<string>();
  const files: Array<{ path: string; content: string }> = [];
  for (const file of rawFiles) {
    if (!file) continue;
    const path = normalizeProjectPath(typeof file.path === 'string' ? file.path : '');
    if (!path || path === '.' || seenPaths.has(path)) continue;
    seenPaths.add(path);
    files.push({ path, content: typeof file.content === 'string' ? file.content : String(file.content ?? '') });
  }
  files.sort((a, b) => byString(a.path, b.path));

  try {
    const analyses = new Map<string, DartAnalysis>();
    const tokenCache = new Map<string, Token[]>();

    for (const file of files) {
      // Only Dart files go through the Dart lexer/AST. Other project files
      // (pubspec.yaml, .gitignore, analysis_options.yaml, README…) must not
      // be parsed as if they were Dart.
      if (!file.path.endsWith('.dart')) {
        findSecrets(file.path, file.content, push);
        continue;
      }
      const analysis = analyzeDart(file.content);
      analyses.set(file.path, analysis);

      for (const error of analysis.errors) {
        push({
          code: 'LEX_ERROR',
          severity: 'error',
          path: file.path,
          line: error.line,
          column: error.column,
          message: error.message,
        });
      }

      const lexed = tokenize(file.content);
      const significant = significantTokens(lexed.tokens);
      tokenCache.set(file.path, significant);
      const meaningful = significant.filter((token) => token.kind !== 'eof');
      if (meaningful.length === 0) {
        push({
          code: 'EMPTY_FILE',
          severity: 'error',
          path: file.path,
          line: 1,
          column: 1,
          message: 'File contains no Dart tokens (empty or comments-only).',
        });
      }

      checkDelimiters(file.path, significant, push);
      findSecrets(file.path, file.content, push);
    }

    // Project-wide checks.
    const fileSet = new Set(files.map((file) => file.path));
    const graph = buildImportGraph(files, packageName);

    for (const unresolved of graph.unresolved) {
      push({
        code: 'UNRESOLVED_IMPORT',
        severity: 'error',
        path: unresolved.path,
        line: unresolved.line,
        column: unresolved.column,
        message: `Cannot resolve '${unresolved.uri}': ${unresolved.reason}.`,
      });
    }
    for (const mismatch of graph.selfPackageMismatches) {
      push({
        code: 'SELF_PACKAGE_MISMATCH',
        severity: 'warning',
        path: mismatch.path,
        line: mismatch.line,
        column: mismatch.column,
        message:
          `Import '${mismatch.uri}' references package '${mismatch.packageName}', ` +
          `not the current package '${packageName}'.`,
      });
    }
    for (const target of graph.missingPartTargets) {
      push({
        code: 'MISSING_PART',
        severity: 'error',
        path: target.path,
        line: target.line,
        column: target.column,
        message: `part '${target.uri}' does not resolve to a file in this project (${target.resolved}).`,
      });
    }
    for (const issue of graph.partFilesMissingOf) {
      push({
        code: 'PART_MISSING_OF',
        severity: 'error',
        path: issue.path,
        line: issue.line,
        column: issue.column,
        message: issue.detail,
      });
    }
    for (const cycle of graph.importCycles) {
      push({
        code: 'IMPORT_CYCLE',
        severity: 'warning',
        path: cycle[0],
        line: 1,
        column: 1,
        message: `Import cycle detected: ${[...cycle, cycle[0]].join(' → ')}.`,
      });
    }

    findDuplicates(
      files
        .filter((file) => file.path.endsWith('.dart') && analyses.has(file.path))
        .map((file) => ({ path: file.path, analysis: analyses.get(file.path)! })),
      fileSet,
      push,
    );

    const entrypointAnalysis = analyses.get(entrypoint) ?? null;
    const entrypointTokens = entrypointAnalysis ? tokenCache.get(entrypoint) ?? null : null;
    checkEntrypoint(entrypoint, entrypointAnalysis, entrypointTokens, push);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    push({
      code: 'INTERNAL_ERROR',
      severity: 'error',
      path: entrypoint,
      line: 1,
      column: 1,
      message: `Validation crashed: ${message}`,
    });
  }

  diagnostics.sort(sortDiagnostics);
  const truncated = diagnostics.length > MAX_DIAGNOSTICS;
  const capped = truncated ? diagnostics.slice(0, MAX_DIAGNOSTICS) : diagnostics;
  const blockers = capped.filter((diagnostic) => diagnostic.severity === 'error');
  const warnings = capped.filter((diagnostic) => diagnostic.severity === 'warning');
  return {
    passed: blockers.length === 0,
    blockers,
    warnings,
    diagnostics: capped,
    truncated,
  };
}
