/**
 * Repair-planning for the FlutterForge QA loop.
 *
 * `planRepair` decides whether another LLM repair cycle should run and, if so,
 * which files to hand to the repairer. The policy is deliberately small and
 * deterministic: dedupe, rank, safety-check paths, detect oscillation from the
 * fingerprint history of previous cycles, cap the number of target files, and
 * emit a compact briefing for the repair prompt.
 *
 * This module never throws: malformed input (non-arrays, bogus diagnostics,
 * absolute/escaping paths) is sanitized or rejected with a stop reason.
 */
import {
  dedupeDiagnostics,
  fingerprint,
  groupByFile,
  normalizeDiagnosticPath,
  rankDiagnostics,
  type Diagnostic,
  type DiagnosticSource,
} from './diagnostics.js';

export interface RepairPolicy {
  /** Maximum number of repair cycles before stopping. Default 3. */
  maxCycles: number;
  /** How many times the same fingerprint set may repeat before stopping. Default 2. */
  maxSameFingerprint: number;
  /** Diagnostic sources considered repairable. Default analyzer/compiler/test. */
  allowedSources: DiagnosticSource[];
  /** Maximum number of target files per cycle. Default 5. */
  maxTargets?: number;
}

export type RepairStrategy = 'surgical' | 'regenerate_file' | 'stop';

export type StopReason = 'MAX_CYCLES' | 'OSCILLATION' | 'UNSAFE_TARGET' | 'NOTHING_TO_REPAIR';

export interface RepairTarget {
  path: string;
  diagnostics: Diagnostic[];
}

export interface RepairPlan {
  shouldRepair: boolean;
  strategy: RepairStrategy;
  targets: RepairTarget[];
  brief: string;
  stopReason?: StopReason;
}

export interface PlanRepairInput {
  diagnostics: Diagnostic[];
  /** 1-based cycle number of the repair attempt being planned. */
  cycle: number;
  /** Fingerprint arrays captured after each previous cycle. */
  history?: string[][];
  /** Optional policy overrides; defaults come from DEFAULT_REPAIR_POLICY. */
  policy?: Partial<RepairPolicy>;
}

export const DEFAULT_ALLOWED_SOURCES: readonly DiagnosticSource[] = ['analyzer', 'compiler', 'test'];

export const DEFAULT_REPAIR_POLICY: RepairPolicy = {
  maxCycles: 3,
  maxSameFingerprint: 2,
  allowedSources: [...DEFAULT_ALLOWED_SOURCES],
  maxTargets: 5,
};

const MAX_BRIEF_CHARS = 2000;
const MAX_PER_FILE_DIAGNOSTICS = 20;
const MAX_MESSAGE_CHARS = 200;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isAbsolutePath(path: string): boolean {
  if (!path) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return true;
  if (/^[A-Za-z]:[\\/]/.test(path)) return true; // Windows drive letter
  return false;
}

function containsPathEscape(path: string): boolean {
  return path.includes('..');
}

function sanitizeHistory(history: unknown): string[][] {
  if (!Array.isArray(history)) return [];
  const result: string[][] = [];
  for (const entry of history) {
    if (!Array.isArray(entry)) continue;
    const fingerprints = entry.filter((item): item is string => typeof item === 'string');
    result.push([...new Set(fingerprints)].sort(compareText));
    if (result.length >= 100) break;
  }
  return result;
}

function sanitizeDiagnostics(diagnostics: unknown): Diagnostic[] {
  if (!Array.isArray(diagnostics)) return [];
  const result: Diagnostic[] = [];
  for (const entry of diagnostics) {
    const record = asRecord(entry);
    if (!record) continue;
    const severity = record.severity;
    if (severity !== 'error' && severity !== 'warning' && severity !== 'info') continue;
    const source = record.source;
    if (
      source !== 'analyzer' &&
      source !== 'compiler' &&
      source !== 'test' &&
      source !== 'runtime' &&
      source !== 'contract'
    ) {
      continue;
    }
    const line = Number(record.line);
    const column = Number(record.column);
    result.push({
      path: typeof record.path === 'string' ? record.path : '',
      line: Number.isFinite(line) ? Math.max(0, Math.trunc(line)) : 0,
      column: Number.isFinite(column) ? Math.max(0, Math.trunc(column)) : 0,
      severity,
      code: typeof record.code === 'string' && record.code.trim() ? record.code.trim() : 'UNKNOWN',
      message: typeof record.message === 'string' ? record.message : '',
      source,
    });
    if (result.length >= 500) break;
  }
  return result;
}

function sanitizeCycle(cycle: unknown): number {
  const value = Number(cycle);
  if (!Number.isFinite(value)) return 1;
  const truncated = Math.trunc(value);
  return truncated < 0 ? 0 : truncated;
}

function resolvePolicy(policyOverride: unknown): RepairPolicy {
  const override = asRecord(policyOverride) ?? {};
  const maxCycles = Number.isFinite(Number(override.maxCycles))
    ? Math.max(0, Math.trunc(Number(override.maxCycles)))
    : DEFAULT_REPAIR_POLICY.maxCycles;
  const maxSameFingerprint = Number.isFinite(Number(override.maxSameFingerprint))
    ? Math.max(1, Math.trunc(Number(override.maxSameFingerprint)))
    : DEFAULT_REPAIR_POLICY.maxSameFingerprint;
  const maxTargets = Number.isFinite(Number(override.maxTargets))
    ? Math.max(1, Math.trunc(Number(override.maxTargets)))
    : DEFAULT_REPAIR_POLICY.maxTargets ?? 5;
  const allowedSources: DiagnosticSource[] = Array.isArray(override.allowedSources)
    ? [
        ...new Set(
          override.allowedSources.filter(
            (source): source is DiagnosticSource =>
              typeof source === 'string' &&
              (['analyzer', 'compiler', 'test', 'runtime', 'contract'] as readonly string[]).includes(source),
          ),
        ),
      ]
    : [...DEFAULT_ALLOWED_SOURCES];
  return {
    maxCycles,
    maxSameFingerprint,
    maxTargets,
    allowedSources: allowedSources.length > 0 ? allowedSources : [...DEFAULT_ALLOWED_SOURCES],
  };
}

function isRepairable(diagnostic: Diagnostic, policy: RepairPolicy): boolean {
  if (diagnostic.severity === 'info') return false;
  return policy.allowedSources.includes(diagnostic.source);
}

/** Set-equality comparison of two normalized fingerprint sets. */
function sameFingerprintSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function buildBrief(cycle: number, targets: readonly RepairTarget[], totalOmitted: number): string {
  const header = `Repair cycle ${cycle}: fix the following diagnostics with minimal edits.`;
  const rules =
    'Rules: make the smallest possible change; do not restructure files or rename public symbols; ' +
    'keep the package name and every import valid; do not add new dependencies; ' +
    'do not leave placeholders (TODO: implement, UnimplementedError, YOUR_API_KEY, REPLACE_ME); ' +
    'do not touch unrelated files.';

  const lines: string[] = [];
  let used = header.length + rules.length + 3;
  let omitted = Math.max(0, totalOmitted);

  for (const target of targets) {
    const fileLine = `File: ${target.path}`;
    if (used + fileLine.length + 1 > MAX_BRIEF_CHARS) {
      omitted += target.diagnostics.length + 1;
      continue;
    }
    lines.push(fileLine);
    used += fileLine.length + 1;
    for (const diagnostic of target.diagnostics) {
      const message = String(diagnostic.message ?? '').replace(/\s+/g, ' ').trim();
      const short = message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS - 1)}…` : message;
      const line = `  - ${diagnostic.line}:${diagnostic.column} [${diagnostic.code}] ${short}`;
      if (used + line.length + 1 > MAX_BRIEF_CHARS) {
        omitted += 1;
        continue;
      }
      lines.push(line);
      used += line.length + 1;
    }
  }

  let brief = `${header}\n${rules}\n${lines.join('\n')}`;
  if (omitted > 0) {
    const note = `\n… (${omitted} more diagnostic(s) omitted to fit the brief)`;
    if (brief.length + note.length <= MAX_BRIEF_CHARS) brief += note;
  }
  return brief.length <= MAX_BRIEF_CHARS ? brief : `${brief.slice(0, MAX_BRIEF_CHARS - 1)}…`;
}

function stopPlan(stopReason: StopReason, brief: string): RepairPlan {
  return { shouldRepair: false, strategy: 'stop', targets: [], brief, stopReason };
}

/**
 * Plan the next repair cycle.
 *
 * - `cycle` is the 1-based cycle number of the repair attempt being planned.
 * - `history` is the array of fingerprint arrays captured after each previous cycle.
 * - Returns `strategy: 'stop'` with a `stopReason` when repairing is not safe or useful.
 */
export function planRepair(input: PlanRepairInput): RepairPlan {
  const safeInput = asRecord(input) ?? {};
  const policy = resolvePolicy(safeInput.policy);
  const cycle = sanitizeCycle(safeInput.cycle);
  const rawDiagnostics = sanitizeDiagnostics(safeInput.diagnostics);
  const history = sanitizeHistory(safeInput.history);

  // Deterministic ordering: dedupe first (stable), then rank (severity/path/line).
  const deduped = dedupeDiagnostics(rawDiagnostics);
  const ranked = rankDiagnostics(deduped);
  const repairable = ranked.filter((diagnostic) => isRepairable(diagnostic, policy));

  /* ---- cycle limit -------------------------------------------------------- */
  if (cycle > policy.maxCycles) {
    return stopPlan(
      'MAX_CYCLES',
      `Stop repair: cycle ${cycle} exceeds the maximum of ${policy.maxCycles} repair cycle(s). ` +
        `Remaining repairable diagnostics: ${repairable.length}.`,
    );
  }

  if (repairable.length === 0) {
    return stopPlan(
      'NOTHING_TO_REPAIR',
      'No repairable diagnostics (no error/warning diagnostics from allowed sources). Do not run a repair cycle.',
    );
  }

  /* ---- safety: no absolute paths, no escapes ------------------------------- */
  for (const diagnostic of repairable) {
    const normalized = normalizeDiagnosticPath(diagnostic.path);
    if (
      isAbsolutePath(diagnostic.path) ||
      isAbsolutePath(normalized) ||
      containsPathEscape(diagnostic.path) ||
      containsPathEscape(normalized)
    ) {
      return stopPlan(
        'UNSAFE_TARGET',
        `Refusing to repair: target path \`${diagnostic.path}\` is absolute or escapes the project root.`,
      );
    }
  }

  /* ---- oscillation detection over fingerprint sets -------------------------- */
  const currentFingerprints = [...new Set(repairable.map((diagnostic) => fingerprint(diagnostic)))].sort(compareText);
  const repetitions = history.filter((previous) => sameFingerprintSet(previous, currentFingerprints)).length;
  if (repetitions >= policy.maxSameFingerprint) {
    return stopPlan(
      'OSCILLATION',
      `Stop repair: the same fingerprint set has repeated ${repetitions} time(s) ` +
        `(limit ${policy.maxSameFingerprint}); the repairer is oscillating without making progress.`,
    );
  }

  /* ---- build targets: ranked files, capped, errors first ------------------- */
  const grouped = groupByFile(repairable);
  const fileEntries = Object.keys(grouped)
    .map((path) => {
      const diagnosticsForFile = grouped[path];
      const errors = diagnosticsForFile.filter((diagnostic) => diagnostic.severity === 'error').length;
      return { path, diagnostics: diagnosticsForFile, errors };
    })
    .sort((a, b) => b.errors - a.errors || compareText(a.path, b.path))
    .slice(0, policy.maxTargets);

  let listed = 0;
  const targets: RepairTarget[] = fileEntries.map((entry) => {
    const capped = rankDiagnostics(entry.diagnostics).slice(0, MAX_PER_FILE_DIAGNOSTICS);
    listed += capped.length;
    return { path: entry.path, diagnostics: capped };
  });
  const totalOmitted = repairable.length - listed;

  /* ---- strategy -------------------------------------------------------------- */
  const worstFile = fileEntries.reduce((max, entry) => Math.max(max, entry.diagnostics.length), 0);
  const oneFileDominates =
    fileEntries.length > 0 && worstFile >= 8 && worstFile >= Math.ceil(repairable.length / 2);
  const strategy: RepairStrategy = oneFileDominates ? 'regenerate_file' : 'surgical';

  /* ---- brief ----------------------------------------------------------------- */
  const brief = buildBrief(cycle, targets, Math.max(0, totalOmitted));

  return { shouldRepair: true, strategy, targets, brief };
}
