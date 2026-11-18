/**
 * Normalized diagnostics for the FlutterForge QA loop.
 *
 * Every parser in this module is total: malformed tool output never throws.
 * Unparseable input is reported through `parseErrors` (capped) and unexpected
 * non-empty lines are counted in `ignoredLines`. Diagnostic collections are
 * capped at `MAX_DIAGNOSTICS` so a pathological tool run cannot blow up
 * memory or downstream prompts; truncations are reported as a document-level
 * parseError instead of silently dropped.
 */
import { createHash } from 'node:crypto';

export const DIAGNOSTIC_SEVERITIES = ['error', 'warning', 'info'] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

export const DIAGNOSTIC_SOURCES = ['analyzer', 'compiler', 'test', 'runtime', 'contract'] as const;
export type DiagnosticSource = (typeof DIAGNOSTIC_SOURCES)[number];

export interface Diagnostic {
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  source: DiagnosticSource;
}

export interface DiagnosticParseError {
  /** 1-based input line, or 0 for a document-level error. */
  line: number;
  message: string;
  text: string;
}

export interface ParseReport {
  diagnostics: Diagnostic[];
  parseErrors: DiagnosticParseError[];
  /** Non-empty lines that were intentionally not diagnostics. */
  ignoredLines: number;
}

export interface FingerprintOptions {
  /** Include line/column in the key. Off by default so moved code dedupes. */
  includeLocation?: boolean;
}

export const MAX_DIAGNOSTICS = 500;
export const MAX_PARSE_ERRORS = 50;
export const MAX_BLOCKING = 12;
export const MAX_TOP_FILES = 10;
const MAX_PARSE_ERROR_TEXT = 240;
const MAX_PROMPT_DIAGNOSTICS = 100;
const MAX_PROMPT_MESSAGE = 240;

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function clip(value: string, max: number): string {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

function toFiniteInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function normalizeSeverity(value: unknown, fallback: DiagnosticSeverity = 'error'): DiagnosticSeverity {
  const lower = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (lower === 'error' || lower === 'warning' || lower === 'info') return lower;
  if (lower === 'warn') return 'warning';
  if (lower === 'hint' || lower === 'note') return 'info';
  return fallback;
}

function isDiagnosticSource(value: unknown): value is DiagnosticSource {
  return typeof value === 'string' && (DIAGNOSTIC_SOURCES as readonly string[]).includes(value);
}

function decodeFileUri(value: string): string {
  if (!/^file:\/\//i.test(value)) return value;
  try {
    let raw = value.replace(/^file:\/\//i, '');
    if (raw.startsWith('localhost/')) raw = raw.slice('localhost'.length);
    raw = decodeURIComponent(raw);
    if (/^\/[A-Za-z]:\//.test(raw)) raw = raw.slice(1);
    return raw;
  } catch {
    return value;
  }
}

function stripRootPrefix(filePath: string, root: string): string {
  const file = filePath.replace(/\\/g, '/');
  const base = root.replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!base) return file;
  if (file === base) return '';
  if (file.startsWith(`${base}/`)) return file.slice(base.length + 1);
  return file;
}

export function normalizeDiagnosticPath(value: unknown, root = ''): string {
  let result = asText(value).trim();
  if (!result) return '';
  result = decodeFileUri(result).replace(/\\/g, '/').replace(/\0/g, '');
  if (root) result = stripRootPrefix(result, root);
  result = result.replace(/^\.\/+/, '');
  return result;
}

function makeDiagnostic(input: {
  path?: unknown;
  line?: unknown;
  column?: unknown;
  endLine?: unknown;
  endColumn?: unknown;
  severity?: unknown;
  code?: unknown;
  message?: unknown;
  source?: unknown;
  root?: string;
}): Diagnostic {
  const line = toFiniteInt(input.line) ?? 0;
  const column = toFiniteInt(input.column) ?? 0;
  const endLine = toFiniteInt(input.endLine);
  const endColumn = toFiniteInt(input.endColumn);
  const diagnostic: Diagnostic = {
    path: normalizeDiagnosticPath(input.path, input.root ?? ''),
    line,
    column,
    severity: normalizeSeverity(input.severity),
    code: asText(input.code).trim() || 'UNKNOWN',
    message: asText(input.message).trim(),
    source: isDiagnosticSource(input.source) ? input.source : 'runtime',
  };
  if (endLine !== null && endLine > 0) diagnostic.endLine = endLine;
  if (endColumn !== null && endColumn > 0) diagnostic.endColumn = endColumn;
  return diagnostic;
}

function pushParseError(report: ParseReport, line: number, message: string, text: string): void {
  if (report.parseErrors.length >= MAX_PARSE_ERRORS) return;
  report.parseErrors.push({
    line,
    message,
    text: clip(stripAnsi(text).replace(/\s+/g, ' ').trim(), MAX_PARSE_ERROR_TEXT),
  });
}

/** Enforce the collection cap; overflow becomes one document-level parseError. */
function capDiagnostics(report: ParseReport, alreadyCounted = 0): void {
  const overflow = alreadyCounted + Math.max(0, report.diagnostics.length - MAX_DIAGNOSTICS);
  if (report.diagnostics.length > MAX_DIAGNOSTICS) {
    report.diagnostics = report.diagnostics.slice(0, MAX_DIAGNOSTICS);
  }
  if (overflow > 0) {
    pushParseError(report, 0, `Diagnostic cap (${MAX_DIAGNOSTICS}) reached; ${overflow} diagnostic(s) dropped.`, '');
  }
}

/**
 * Parse `dart analyze --format=machine` output.
 *
 * Format: `SEVERITY|TYPE|CODE|FILE|LINE|COLUMN|LENGTH|MESSAGE`.
 * Dart does not escape pipes in MESSAGE, so the line is split on `|` and the
 * eighth field is rebuilt by rejoining the remainder with `|` — a naive
 * `split('|', 8)` would silently truncate the message instead.
 */
export function parseDartAnalyzeMachine(stdout: string): ParseReport {
  const report: ParseReport = { diagnostics: [], parseErrors: [], ignoredLines: 0 };
  const text = asText(stdout);
  const lines = splitLines(text);
  let overflow = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = stripAnsi(lines[index]).replace(/\r$/, '');
    const line = rawLine.trim();
    if (!line) continue;

    if (!/^(ERROR|WARNING|INFO)\|/i.test(line)) {
      report.ignoredLines += 1;
      continue;
    }

    const fields = rawLine.split('|');
    if (fields.length < 8) {
      pushParseError(report, index + 1, 'Machine diagnostic has fewer than 8 fields.', rawLine);
      continue;
    }
    const [severityRaw, typeRaw, codeRaw, fileRaw, lineRaw, columnRaw, lengthRaw] = fields;
    const messageRaw = fields.slice(7).join('|');
    const lineNumber = toFiniteInt(lineRaw);
    const columnNumber = toFiniteInt(columnRaw);
    if (!fileRaw.trim() || lineNumber === null || columnNumber === null) {
      pushParseError(report, index + 1, 'Machine diagnostic has an invalid file, line, or column.', rawLine);
      continue;
    }
    const length = toFiniteInt(lengthRaw) ?? 0;
    report.diagnostics.push(
      makeDiagnostic({
        path: fileRaw,
        line: lineNumber,
        column: columnNumber,
        endLine: lineNumber,
        endColumn: length > 0 ? columnNumber + length : undefined,
        severity: severityRaw,
        code: codeRaw.trim() || typeRaw.trim() || 'ANALYZE',
        message: messageRaw,
        source: 'analyzer',
      }),
    );
    if (report.diagnostics.length >= MAX_DIAGNOSTICS) {
      // Account for diagnostic-like lines beyond the cap so the drop is reported accurately.
      for (let rest = index + 1; rest < lines.length; rest += 1) {
        const restLine = stripAnsi(lines[rest]).trim();
        if (!restLine) continue;
        if (/^(ERROR|WARNING|INFO)\|/i.test(restLine)) overflow += 1;
        else report.ignoredLines += 1;
      }
      break;
    }
  }

  capDiagnostics(report, overflow);
  return report;
}

function messageFrom(value: unknown): string {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  if (!record) return '';
  return messageFrom(record.text ?? record.message ?? record.problemMessage ?? record.description ?? '');
}

interface JsonCapCounter {
  dropped: number;
}

function parseJsonDiagnostic(
  entry: Record<string, unknown>,
  report: ParseReport,
  root: string,
  inputLine: number,
  counter: JsonCapCounter,
): void {
  if (report.diagnostics.length >= MAX_DIAGNOSTICS) {
    counter.dropped += 1;
    return;
  }
  const location = asRecord(entry.location) ?? asRecord(entry.range) ?? {};
  const start =
    asRecord(location.start) ??
    asRecord(entry.range) ??
    asRecord(entry.start) ??
    {};
  const end = asRecord(location.end) ?? asRecord(entry.end) ?? {};

  const rawPath =
    entry.file ??
    entry.path ??
    entry.filePath ??
    entry.uri ??
    location.file ??
    location.path ??
    location.uri ??
    start.file ??
    start.path ??
    '';

  const codeValue =
    entry.code ??
    entry.errorCode ??
    entry.diagnosticCode ??
    (typeof entry.type === 'string' && !/^(analyzerDiagnostic|diagnostic|error)$/i.test(entry.type)
      ? entry.type
      : '');

  const message = messageFrom(entry.problemMessage ?? entry.message ?? entry.description ?? entry.text);
  if (!message && !asText(codeValue)) {
    pushParseError(report, inputLine, 'Diagnostic JSON object has neither a message nor a code.', JSON.stringify(entry) ?? '');
    return;
  }

  const line = toFiniteInt(entry.line ?? start.line ?? start.startLine ?? entry.startLine ?? location.startLine);
  const column = toFiniteInt(entry.column ?? start.column ?? start.startColumn ?? entry.startColumn ?? location.startColumn);
  const endLine = toFiniteInt(entry.endLine ?? end.line ?? end.startLine ?? end.endLine ?? location.endLine);
  const endColumn = toFiniteInt(entry.endColumn ?? end.column ?? end.startColumn ?? end.endColumn ?? location.endColumn);
  const severityValue =
    entry.severity ??
    entry.level ??
    (/^(ERROR|WARNING|INFO|HINT)$/i.test(asText(entry.type)) ? entry.type : undefined);

  report.diagnostics.push(
    makeDiagnostic({
      path: rawPath,
      line: line ?? 0,
      column: column ?? 0,
      endLine,
      endColumn,
      severity: severityValue,
      code: asText(codeValue) || 'ANALYZE',
      message: message || `Analyzer reported ${asText(codeValue)}.`,
      source: 'analyzer',
      root,
    }),
  );
}

function isDiagnosticLike(record: Record<string, unknown>): boolean {
  return (
    'severity' in record ||
    'code' in record ||
    'errorCode' in record ||
    'problemMessage' in record ||
    'file' in record ||
    'location' in record
  );
}

function parseJsonEntry(
  entry: unknown,
  report: ParseReport,
  root: string,
  inputLine: number,
  counter: JsonCapCounter,
): void {
  if (Array.isArray(entry)) {
    for (const item of entry) parseJsonEntry(item, report, root, inputLine, counter);
    return;
  }
  const record = asRecord(entry);
  if (!record) {
    pushParseError(report, inputLine, 'JSON entry is not an object.', JSON.stringify(entry) ?? '');
    return;
  }

  const nested = asRecord(record.diagnostic) ?? asRecord(record.error);
  if (nested) {
    parseJsonDiagnostic(nested, report, root, inputLine, counter);
    return;
  }
  if (Array.isArray(record.diagnostics)) {
    for (const item of record.diagnostics) parseJsonEntry(item, report, root, inputLine, counter);
    return;
  }

  const type = asText(record.type).toLowerCase();
  if (isDiagnosticLike(record)) {
    parseJsonDiagnostic(record, report, root, inputLine, counter);
    return;
  }
  if (type === 'analyzerdiagnostic' || type === 'diagnostic') {
    pushParseError(report, inputLine, 'Diagnostic event is missing its diagnostic payload.', JSON.stringify(record) ?? '');
  }
  // Status/progress events (analyzerStatus, etc.) are not diagnostics but still count as seen lines.
  report.ignoredLines += 1;
}

/**
 * Parse the analyzer JSON event stream and the single JSON document shape.
 * Absolute paths under `root` are converted to project-relative paths.
 */
export function parseDartAnalyzeJson(stdout: string, root = ''): ParseReport {
  const report: ParseReport = { diagnostics: [], parseErrors: [], ignoredLines: 0 };
  const text = asText(stdout).replace(/^\uFEFF/, '').trim();
  if (!text) return report;
  const counter: JsonCapCounter = { dropped: 0 };

  let wholeParsed: unknown;
  let wholeOk = false;
  try {
    wholeParsed = JSON.parse(text);
    wholeOk = true;
  } catch {
    // Fall back to the line-delimited event stream.
  }

  if (wholeOk) {
    parseJsonEntry(wholeParsed, report, root, 1, counter);
    capDiagnostics(report, counter.dropped);
    return report;
  }

  const lines = splitLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = stripAnsi(lines[index]).replace(/\r$/, '');
    const line = rawLine.trim();
    if (!line) continue;
    try {
      parseJsonEntry(JSON.parse(line), report, root, index + 1, counter);
    } catch {
      if (line.startsWith('{') || line.startsWith('[')) {
        pushParseError(report, index + 1, 'Invalid JSON.', rawLine);
      } else {
        report.ignoredLines += 1;
      }
    }
  }

  capDiagnostics(report, counter.dropped);
  return report;
}

const COMPILER_SEVERITY_CODE: Record<DiagnosticSeverity, string> = {
  error: 'COMPILER_ERROR',
  warning: 'COMPILER_WARNING',
  info: 'COMPILER_INFO',
};

/**
 * Parse common Flutter/Dart compiler stderr formats:
 *   lib/main.dart:12:5: Error: Message
 *   lib/main.dart(12,5): error G0123: Message
 *   Target dart2js failed: ...
 */
export function parseFlutterCompileErrors(stderr: string): ParseReport {
  const report: ParseReport = { diagnostics: [], parseErrors: [], ignoredLines: 0 };
  const lines = splitLines(asText(stderr));

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = stripAnsi(lines[index]).replace(/\r$/, '');
    const line = rawLine.trim();
    if (!line) continue;

    const colonFormat = /^(.*?):(\d+):(\d+):\s*(error|warning|info|hint)\s*:\s*(.*)$/i.exec(line);
    if (colonFormat) {
      const [, file, lineRaw, columnRaw, severityRaw, message] = colonFormat;
      const severity = normalizeSeverity(severityRaw);
      report.diagnostics.push(
        makeDiagnostic({
          path: file,
          line: lineRaw,
          column: columnRaw,
          severity,
          code: COMPILER_SEVERITY_CODE[severity],
          message,
          source: 'compiler',
        }),
      );
      continue;
    }

    const parenFormat = /^(.*?)\((\d+),(\d+)\):\s*(error|warning|info|hint)\b(?:\s+([A-Za-z][A-Za-z0-9_]*))?\s*:\s*(.*)$/i.exec(line);
    if (parenFormat) {
      const [, file, lineRaw, columnRaw, severityRaw, codeRaw, message] = parenFormat;
      const severity = normalizeSeverity(severityRaw);
      report.diagnostics.push(
        makeDiagnostic({
          path: file,
          line: lineRaw,
          column: columnRaw,
          severity,
          code: codeRaw || COMPILER_SEVERITY_CODE[severity],
          message,
          source: 'compiler',
        }),
      );
      continue;
    }

    const targetFormat = /^Target\s+([A-Za-z0-9_.-]+)\s+failed\b(.*)$/i.exec(line);
    if (targetFormat) {
      const target = targetFormat[1];
      report.diagnostics.push(
        makeDiagnostic({
          path: '',
          line: 0,
          column: 0,
          severity: 'error',
          code: `${target.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_FAILED`,
          message: line,
          source: 'compiler',
        }),
      );
      continue;
    }

    report.ignoredLines += 1;
    if (/\.(?:dart|yaml):\d+(?::\d+)?/.test(line) && /\b(error|warning)\b/i.test(line)) {
      pushParseError(report, index + 1, 'Diagnostic-like compiler line did not match a supported format.', rawLine);
    }
  }

  capDiagnostics(report);
  return report;
}

const TEST_PROGRESS = /^\s*\d{1,3}:\d{2}\s+\+\d+(?:(?:\s+-\d+)|(?:\s+~\d+))*\s*:\s*(.*)$/;
const TEST_FILE_MARKERS = new Set(['test', 'integration_test', 'lib', 'tool', 'bin']);

interface TestFailureBuilder {
  title: string;
  details: string[];
  references: Array<{ path: string; line: number; column: number }>;
}

function relativeTestPath(raw: string): string {
  let value = decodeFileUri(raw.trim()).replace(/\\/g, '/');
  if (value.startsWith('package:')) {
    const slash = value.indexOf('/');
    value = slash >= 0 ? value.slice(slash + 1) : '';
  }
  if (value.startsWith('/')) {
    const segments = value.split('/').filter(Boolean);
    for (let index = 0; index < segments.length; index += 1) {
      if (TEST_FILE_MARKERS.has(segments[index])) return segments.slice(index).join('/');
    }
    return value.replace(/^\/+/, '');
  }
  return value.replace(/^\.\/+/, '');
}

function parseTestReference(line: string): { path: string; line: number; column: number } | null {
  const patterns: RegExp[] = [
    /(?:^|\s)package:[A-Za-z0-9_]+\/((?:test|integration_test|lib|tool|bin)\/[^\s:]+\.dart)(?:\s+|:)(\d+):(\d+)(?:\s|$)/,
    /(?:^|\s)((?:test|integration_test|lib|tool|bin)\/[^\s:]+\.dart)(?:\s+|:)(\d+):(\d+)(?:\s|$)/,
    /(?:^|\s)(file:\/\/[^\s]+?\.dart)(?:\s+|:)(\d+):(\d+)(?:\s|$)/,
    /(?:^|\s)((?:\/|[A-Za-z]:[\\/])[^\s]+?\.dart)(?:\s+|:)(\d+):(\d+)(?:\s|$)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(line);
    if (!match) continue;
    return {
      path: relativeTestPath(match[1]),
      line: Number(match[2]),
      column: Number(match[3]),
    };
  }
  return null;
}

function isTestDetail(line: string): boolean {
  return /^(Expected|Actual|Which|Error|Exception|The following)\b[^:]*:/i.test(line.trim());
}

function finalizeTestFailure(builder: TestFailureBuilder, report: ParseReport): void {
  if (!builder.title && builder.details.length === 0) return;
  const reference = builder.references[0];
  const detail = builder.details
    .map((entry) => entry.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  const title = builder.title || 'Test failure';
  const message = clip(detail ? `${title}\n${detail}` : title, 1200);
  report.diagnostics.push(
    makeDiagnostic({
      path: reference?.path ?? '',
      line: reference?.line ?? 0,
      column: reference?.column ?? 0,
      severity: 'error',
      code: 'TEST_FAILURE',
      message,
      source: 'test',
    }),
  );
}

/**
 * Parse `package:test` failure blocks. A block starts at a progress line such
 * as `00:03 +2 -1: test name [E]` and continues until the next progress line.
 */
export function parseTestOutput(text: string): ParseReport {
  const report: ParseReport = { diagnostics: [], parseErrors: [], ignoredLines: 0 };
  let current: TestFailureBuilder | null = null;

  const flush = (): void => {
    if (!current) return;
    finalizeTestFailure(current, report);
    current = null;
  };

  for (const raw of splitLines(asText(text))) {
    const line = stripAnsi(raw).replace(/\r$/, '');
    const progress = TEST_PROGRESS.exec(line);

    if (progress) {
      flush();
      const title = progress[1].replace(/\s*\[E\]\s*$/i, '').trim();
      if (/\[E\]\s*$/i.test(progress[1])) {
        current = { title, details: [], references: [] };
      }
      continue;
    }

    if (!current) {
      if (line.trim()) report.ignoredLines += 1;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    const reference = parseTestReference(line);
    if (reference) {
      if (current.references.length < 8) current.references.push(reference);
      continue;
    }

    if (/^\s{2,}/.test(line) && isTestDetail(trimmed)) {
      if (current.details.length < 12) current.details.push(trimmed);
      continue;
    }
    if (isTestDetail(trimmed) && current.details.length < 12) {
      current.details.push(trimmed);
      continue;
    }

    if (/^(All tests passed!|Some tests failed\.)/i.test(trimmed)) {
      flush();
      continue;
    }

    report.ignoredLines += 1;
  }

  flush();
  capDiagnostics(report);
  return report;
}

/**
 * Stable canonical key: `source|code|path|normalized message`.
 * Location is omitted by default so a diagnostic that moves lines keeps the
 * same fingerprint; message digits are collapsed to `#` so renumbering a
 * literal in the message does not fork the key either. Set `includeLocation`
 * when occurrences matter.
 */
export function fingerprint(diagnostic: Diagnostic, options: FingerprintOptions = {}): string {
  const path = normalizeDiagnosticPath(diagnostic.path);
  const message = String(diagnostic.message ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\d+/g, '#');
  const base = `${diagnostic.source}|${diagnostic.code}|${path}|${message}`;
  if (!options.includeLocation) return base;
  return `${base}|${Math.max(0, Math.trunc(diagnostic.line || 0))}:${Math.max(0, Math.trunc(diagnostic.column || 0))}`;
}

/** Short digest for compact logs/telemetry; not the dedupe key. */
export function fingerprintDigest(diagnostic: Diagnostic, options: FingerprintOptions = {}): string {
  return createHash('sha256').update(fingerprint(diagnostic, options)).digest('hex').slice(0, 16);
}

export function dedupeDiagnostics(diagnostics: readonly Diagnostic[], options: FingerprintOptions = {}): Diagnostic[] {
  const seen = new Set<string>();
  const result: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = fingerprint(diagnostic, options);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(diagnostic);
    if (result.length >= MAX_DIAGNOSTICS) break;
  }
  return result;
}

export function rankDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => {
    const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severity !== 0) return severity;
    const path = compareText(normalizeDiagnosticPath(a.path), normalizeDiagnosticPath(b.path));
    if (path !== 0) return path;
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    const code = compareText(a.code, b.code);
    if (code !== 0) return code;
    return compareText(a.message, b.message);
  });
}

/** Group diagnostics by normalized file path, with deterministically sorted keys. */
export function groupByFile(diagnostics: readonly Diagnostic[]): Record<string, Diagnostic[]> {
  const groups = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const key = normalizeDiagnosticPath(diagnostic.path) || '(project)';
    const bucket = groups.get(key);
    if (bucket) bucket.push(diagnostic);
    else groups.set(key, [diagnostic]);
  }
  const result: Record<string, Diagnostic[]> = {};
  for (const key of [...groups.keys()].sort(compareText)) {
    result[key] = groups.get(key) ?? [];
  }
  return result;
}

export interface FileDiagnosticSummary {
  path: string;
  count: number;
  errors: number;
  warnings: number;
  infos: number;
}

export interface DiagnosticSummary {
  total: number;
  errors: number;
  warnings: number;
  infos: number;
  bySeverity: Record<DiagnosticSeverity, number>;
  topFiles: FileDiagnosticSummary[];
  /** Error diagnostics in rank order, capped at MAX_BLOCKING (12). */
  blocking: Diagnostic[];
  blockingTotal: number;
  blockingTruncated: boolean;
}

export function summarizeDiagnostics(diagnostics: readonly Diagnostic[]): DiagnosticSummary {
  const bySeverity: Record<DiagnosticSeverity, number> = { error: 0, warning: 0, info: 0 };
  const files = new Map<string, FileDiagnosticSummary>();

  for (const diagnostic of diagnostics) {
    const severity = normalizeSeverity(diagnostic.severity);
    bySeverity[severity] += 1;
    const path = normalizeDiagnosticPath(diagnostic.path) || '(project)';
    const entry = files.get(path) ?? { path, count: 0, errors: 0, warnings: 0, infos: 0 };
    entry.count += 1;
    if (severity === 'error') entry.errors += 1;
    else if (severity === 'warning') entry.warnings += 1;
    else entry.infos += 1;
    files.set(path, entry);
  }

  const topFiles = [...files.values()]
    .sort((a, b) => b.errors - a.errors || b.count - a.count || compareText(a.path, b.path))
    .slice(0, MAX_TOP_FILES);

  const rankedErrors = rankDiagnostics(diagnostics.filter((diagnostic) => diagnostic.severity === 'error'));
  const blocking = rankedErrors.slice(0, MAX_BLOCKING);

  return {
    total: diagnostics.length,
    errors: bySeverity.error,
    warnings: bySeverity.warning,
    infos: bySeverity.info,
    bySeverity,
    topFiles,
    blocking,
    blockingTotal: rankedErrors.length,
    blockingTruncated: rankedErrors.length > MAX_BLOCKING,
  };
}

function compactMessage(message: string, max = MAX_PROMPT_MESSAGE): string {
  return clip(String(message ?? '').replace(/\s+/g, ' ').trim(), max);
}

/**
 * Compact deterministic block for an LLM repair prompt. Never exceeds
 * `maxChars`; diagnostics are deduped and ranked first.
 */
export function diagnosticsPromptBlock(diagnostics: readonly Diagnostic[], maxChars = 4000): string {
  const budget = Number.isFinite(maxChars) ? Math.max(20, Math.trunc(maxChars)) : 4000;
  const unique = dedupeDiagnostics(rankDiagnostics(diagnostics)).slice(0, MAX_PROMPT_DIAGNOSTICS);
  if (unique.length === 0) return clip('No diagnostics.', budget);

  const summary = summarizeDiagnostics(unique);
  const header = `Diagnostics: ${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.infos} info.`;
  const lines = unique.map((diagnostic) => {
    const path = normalizeDiagnosticPath(diagnostic.path) || '(project)';
    const location = `${path}:${diagnostic.line}:${diagnostic.column}`;
    return `- ${location} [${diagnostic.severity}] ${diagnostic.code}: ${compactMessage(diagnostic.message)}`;
  });

  let output = clip(header, budget);
  let appended = 0;
  for (const line of lines) {
    const candidate = `\n${line}`;
    if (output.length + candidate.length > budget) break;
    output += candidate;
    appended += 1;
  }

  const remaining = lines.length - appended;
  if (remaining > 0) {
    const note = `\n… (${remaining} more diagnostic(s) omitted)`;
    if (output.length + note.length <= budget) output += note;
  }
  return output.length <= budget ? output : clip(output, budget);
}
