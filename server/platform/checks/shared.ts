/**
 * Shared primitives for the Deterministic checks.
 *
 * Everything here is pure and deterministic: no network, no filesystem, no
 * clock reads. Agents receive a file snapshot and return findings; scoring is
 * a closed function of those findings.
 */
import type {
  CheckFinding,
  CheckStatus,
  FindingSeverity,
  ReviewContext,
  ReviewFile,
} from './types.js';
import { stripDartCommentsAndStrings } from '../qa/contract.js';

/** Stable penalty per finding severity. A single blocker fails an agent. */
export const SEVERITY_PENALTY: Record<FindingSeverity, number> = {
  blocker: 45,
  major: 12,
  minor: 3,
  info: 0,
};

export const SEVERITY_RANK: Record<FindingSeverity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  info: 3,
};

/** Hard cap per agent so one systemic problem cannot flood the report. */
export const MAX_FINDINGS_PER_AGENT = 12;

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function scoreFindings(findings: readonly CheckFinding[]): number {
  let score = 100;
  for (const finding of findings) score -= SEVERITY_PENALTY[finding.severity] ?? 0;
  return clampScore(score);
}

export function statusForFindings(findings: readonly CheckFinding[]): CheckStatus {
  if (findings.some((finding) => finding.severity === 'blocker')) return 'fail';
  if (findings.some((finding) => finding.severity === 'major' || finding.severity === 'minor')) return 'warn';
  return 'pass';
}

export interface FindingStats {
  blockers: number;
  majors: number;
  minors: number;
  infos: number;
}

export function countSeverities(findings: readonly CheckFinding[]): FindingStats {
  const stats: FindingStats = { blockers: 0, majors: 0, minors: 0, infos: 0 };
  for (const finding of findings) {
    if (finding.severity === 'blocker') stats.blockers += 1;
    else if (finding.severity === 'major') stats.majors += 1;
    else if (finding.severity === 'minor') stats.minors += 1;
    else stats.infos += 1;
  }
  return stats;
}

/** Stable ordering everywhere: severity, file, line, code. */
export function sortFindings(findings: readonly CheckFinding[]): CheckFinding[] {
  return [...findings].sort((a, b) => {
    const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severity !== 0) return severity;
    const file = (a.file ?? '').localeCompare(b.file ?? '');
    if (file !== 0) return file;
    const line = (a.line ?? 0) - (b.line ?? 0);
    if (line !== 0) return line;
    return a.code.localeCompare(b.code) || a.message.localeCompare(b.message);
  });
}

export function finding(
  code: string,
  severity: FindingSeverity,
  message: string,
  extra: Partial<Pick<CheckFinding, 'file' | 'line' | 'suggestion' | 'evidence'>> = {},
): CheckFinding {
  return { code, severity, message, ...extra };
}

/** Cap per-agent findings, folding the remainder into one aggregate finding. */
export function capFindings(findings: CheckFinding[], cap = MAX_FINDINGS_PER_AGENT): CheckFinding[] {
  if (findings.length <= cap) return findings;
  const kept = findings.slice(0, cap);
  const overflow = findings.slice(cap);
  kept.push(
    finding(
      'AGENT_FINDINGS_TRUNCATED',
      'info',
      `${overflow.length} more finding(s) suppressed by the per-agent cap (${cap}).`,
      { suggestion: 'Fix the reported instances first; the remainder will surface on the next review.' },
    ),
  );
  return kept;
}

export function dartFiles(context: ReviewContext): ReviewFile[] {
  return context.files.filter((file) => file.path.endsWith('.dart'));
}

export function libFiles(context: ReviewContext): ReviewFile[] {
  return context.files.filter((file) => file.path.startsWith('lib/') && file.path.endsWith('.dart'));
}

export function testFiles(context: ReviewContext): ReviewFile[] {
  return context.files.filter((file) => file.path.startsWith('test/') && file.path.endsWith('.dart'));
}

export function filesMatching(context: ReviewContext, test: (path: string) => boolean): ReviewFile[] {
  return context.files.filter((file) => test(file.path));
}

export function fileContent(context: ReviewContext, predicate: (path: string) => boolean): ReviewFile | null {
  return context.files.find((file) => predicate(file.path)) ?? null;
}

export function hasFile(context: ReviewContext, predicate: (path: string) => boolean): boolean {
  return context.files.some((file) => predicate(file.path));
}

/** Strip comments and string bodies so regexes only see live code. */
export function stripDart(source: string): string {
  return stripDartCommentsAndStrings(source ?? '');
}

export function countMatches(source: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = global.exec(source)) !== null) {
    count += 1;
    if (match.index === global.lastIndex) global.lastIndex += 1;
  }
  return count;
}

/** 1-based line number for a character offset. */
export function lineAt(source: string, index: number): number {
  if (index <= 0) return 1;
  let line = 1;
  const end = Math.min(index, source.length);
  for (let i = 0; i < end; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export function firstMatchLine(source: string, pattern: RegExp): number | undefined {
  const flags = pattern.flags.includes('g') ? pattern.flags.replace('g', '') : pattern.flags;
  const match = new RegExp(pattern.source, flags).exec(source);
  return match ? lineAt(source, match.index) : undefined;
}

export function truncate(value: string, max = 120): string {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Redact anything that looks like a live credential before it reaches a report. */
export function redactSecrets(value: string): string {
  return String(value ?? '')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, 'jwt.***')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, 'AIza***')
    .replace(/\b(sbp|supabase)[_-]?[A-Za-z0-9]{20,}/gi, 'sb***');
}

/* ── pubspec ─────────────────────────────────────────────────────────────── */

export interface PubspecInfo {
  name: string | null;
  version: string | null;
  description: string | null;
  sdkConstraint: string | null;
  dependencies: Map<string, string>;
  devDependencies: Map<string, string>;
}

function scalar(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Minimal, dependency-free reader for the subset of YAML pubspec files use:
 * top-level scalars and the two dependency maps. Anything else is ignored.
 */
export function parsePubspec(raw: string | null): PubspecInfo {
  const info: PubspecInfo = {
    name: null,
    version: null,
    description: null,
    sdkConstraint: null,
    dependencies: new Map(),
    devDependencies: new Map(),
  };
  if (!raw) return info;

  let section: 'dependencies' | 'dev_dependencies' | 'environment' | null = null;
  let lastDependency: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const topLevel = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (topLevel) {
      const key = topLevel[1];
      const value = scalar(topLevel[2] ?? '');
      if (key === 'name') info.name = value;
      else if (key === 'version') info.version = value;
      else if (key === 'description') info.description = value;
      lastDependency = null;
      section = key === 'dependencies'
        ? 'dependencies'
        : key === 'dev_dependencies'
          ? 'dev_dependencies'
          : key === 'environment'
            ? 'environment'
            : null;
      continue;
    }

    const indented = /^(\s+)([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (!indented) continue;
    const depth = indented[1].length;
    const name = indented[2];
    const value = scalar(indented[3] ?? '');
    if (depth === 2) {
      if (section === 'dependencies' || section === 'dev_dependencies') {
        dependencyMap(info, section).set(name, value ?? '');
        lastDependency = name;
      } else if (section === 'environment' && name === 'sdk' && !info.sdkConstraint) {
        info.sdkConstraint = value;
      }
      continue;
    }
    if (depth === 4 && name === 'sdk' && lastDependency && section) {
      const map = dependencyMap(info, section);
      if (map) map.set(lastDependency, `sdk:${value ?? ''}`);
    }
  }
  return info;
}

function dependencyMap(
  info: PubspecInfo,
  section: 'dependencies' | 'dev_dependencies' | 'environment',
): Map<string, string> | null {
  if (section === 'dependencies') return info.dependencies;
  if (section === 'dev_dependencies') return info.devDependencies;
  return null;
}

export function importRoots(pubspec: PubspecInfo): Set<string> {
  return new Set([...pubspec.dependencies.keys(), ...pubspec.devDependencies.keys()]);
}

/** Every `package:<name>/` namespace referenced by project Dart code. */
export function importedPackages(files: readonly ReviewFile[]): Set<string> {
  const packages = new Set<string>();
  const pattern = /(?:^|\n)\s*(?:import|export)\s+['"]package:([^/'"]+)/g;
  for (const file of files) {
    let match: RegExpExecArray | null;
    const source = stripDart(file.content);
    while ((match = pattern.exec(source)) !== null) packages.add(match[1]);
  }
  return packages;
}

export function isGeneratedAppFile(path: string): boolean {
  return path.startsWith('lib/') || path.startsWith('test/') || path === 'pubspec.yaml';
}

export function pathStem(path: string): string {
  return path.replace(/\.[^./]+$/, '');
}

export interface CallBlock {
  /** Character offset of the opening parenthesis in the stripped source. */
  start: number;
  /** Text between the parentheses (inclusive), from the stripped source. */
  body: string;
}

/**
 * Extract balanced `callee(...)` blocks from stripped Dart source. String and
 * comment content is already blanked, so parentheses inside literals cannot
 * unbalance the scan.
 */
export function callBlocks(strippedSource: string, callee: string): CallBlock[] {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])${callee}\\s*\\(`, 'g');
  const blocks: CallBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(strippedSource)) !== null) {
    const open = strippedSource.indexOf('(', match.index + match[0].length - 1);
    if (open < 0) continue;
    let depth = 0;
    let index = open;
    for (; index < strippedSource.length; index += 1) {
      const ch = strippedSource[index];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push({ start: open, body: strippedSource.slice(open, Math.min(index + 1, strippedSource.length)) });
  }
  return blocks;
}

/** 1-based line number of the first `callee(` occurrence, if any. */
export function calleeLine(source: string, callee: string): number | undefined {
  const match = new RegExp(`(^|[^A-Za-z0-9_])${callee}\\s*\\(`).exec(stripDart(source));
  return match ? lineAt(source, match.index) : undefined;
}

