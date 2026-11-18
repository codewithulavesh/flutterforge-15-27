/**
 * OSV-backed dependency vulnerability gate.
 *
 * Queries the Open Source Vulnerabilities database (https://osv.dev) for the
 * hosted packages pinned in a pubspec.lock and fails the build when a policy-
 * relevant advisory applies. The network seam (`QueryFn` / `fetchFn`) is
 * injectable so tests never touch the network.
 *
 * Security posture: fail closed. Any transport, HTTP, protocol or parsing
 * failure raises `PlatformError` with code `OSV_UNAVAILABLE` (for direct
 * `queryOsvBatch` calls) or is captured into `OsvGateResult.errors` with
 * `blocked=true` under policy `block` (for `gate`). A gate that cannot verify
 * the dependency set must never silently allow it.
 *
 * Severity bucketing (see `mapSeverity` for the full decision ladder):
 *   1. `database_specific.severity` string (case-insensitive; GitHub style,
 *      e.g. "CRITICAL" / "HIGH" / "MODERATE" / "MEDIUM" / "LOW") wins.
 *   2. Otherwise CVSS scores are bucketed critical ≥ 9.0, high ≥ 7.0,
 *      medium ≥ 4.0, low > 0, and 0.0 → low. Vector strings are scored with a
 *      real CVSS v3.1 / v2 base-score calculator; a plain number or a
 *      `cvss:<number>` string is bucketed directly. When an advisory lists
 *      several CVSS entries the HIGHEST score wins (fail toward blocking).
 *      CVSS v4 vectors are NOT evaluated and bucket to `unknown`.
 *   3. Anything unrecognised buckets to `unknown` (never to a blocking class
 *      by accident, and never silently upgraded either).
 *
 * `allowIds` (in `gate`) bypasses specific advisories by id or alias and is
 * intended ONLY for tracked, time-boxed exceptions reviewed by a human. It is
 * NOT a production escape hatch: do not ship allowIds without a security
 * review trail. Matching is case-insensitive and alias-aware (allowing a CVE
 * also suppresses a GHSA that aliases the same issue) — document allowlisted
 * ids in your exception tracker.
 */
import { PlatformError, ValidationError } from '../kernel/errors.js';
import { parsePubspecLock } from './sbom.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type OsvSeverity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export interface OsvVulnerability {
  id: string;
  summary: string;
  severity: OsvSeverity;
  aliases: string[];
  fixedIn?: string;
  reference?: string;
}

export interface OsvGateVulnerability {
  package: string;
  version: string;
  vulnerability: OsvVulnerability;
}

export interface OsvGateResult {
  /** True when nothing blocked the build and no errors were recorded. */
  ok: boolean;
  vulnerabilities: OsvGateVulnerability[];
  /** True when policy='block' and at least one blocking finding or failure occurred. */
  blocked: boolean;
  policy: 'block' | 'warn';
  /** Per-package failure reasons, e.g. `OSV_QUERY_FAILED <pkg>@<version>: <reason>`. Never swallowed. */
  errors: string[];
  checkedAtMs: number;
  totalPackages: number;
}

/** Network seam. Returns a map keyed `name@version` → vulnerabilities (empty array when clean). */
export type QueryFn = (
  packages: Array<{ name: string; version: string }>,
) => Promise<Map<string, OsvVulnerability[]>>;

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; statusText?: string; json(): Promise<unknown> }>;

export interface QueryOsvBatchOptions {
  /** Overrides global fetch. Tests inject fakes; production uses globalThis.fetch. */
  fetchFn?: FetchLike;
  /** Overrides the OSV querybatch endpoint (default: https://api.osv.dev/v1/querybatch). */
  endpoint?: string;
  /**
   * Overrides the per-advisory record endpoint. Defaults to the endpoint
   * derived from `endpoint` (a trailing `/querybatch` becomes `/vulns/`),
   * else https://api.osv.dev/v1/vulns/. Needed because querybatch
   * returns compact {id, modified} records against the live API.
   */
  vulnerabilityEndpoint?: string;
  /** Per-request deadline. Defaults to 15000ms. */
  timeoutMs?: number;
}

export interface GateOptions {
  /** Pre-resolved packages. Mutually exclusive with `lock`. */
  packages?: Array<{ name: string; version: string }>;
  /** Raw pubspec.lock contents; hosted packages only. */
  lock?: string;
  policy: 'block' | 'warn';
  queryFn?: QueryFn;
  /**
   * Advisory ids/aliases to bypass (case-insensitive). NOT for production use
   * without review — see module docblock. Intended for tracked, time-boxed
   * exceptions only.
   */
  allowIds?: Iterable<string>;
}

/** Deterministic rank for out-of-band severity strings from hand-built results. */
function severityRank(severity: OsvSeverity): number {
  return SEVERITY_ORDER[severity] ?? 99;
}

/** Hosted pubspec packages as parsed from a lock, plus the invalid-entry count. */
export interface ParsedLockfilePackages extends Array<{ name: string; version: string }> {
  /** Number of lock entries that were skipped because they lacked a valid name/version. */
  skipped: number;
}

/* ------------------------------------------------------------------ */
/* Severity ranking                                                    */
/* ------------------------------------------------------------------ */

/** Lower rank = more severe. Use for ascending sorts (critical first). */
export const SEVERITY_ORDER: Record<OsvSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4,
};

/**
 * True when `vuln` blocks the build under `policy`. Only severity
 * critical|high blocks, and only for policy='block'. `allowIds` matches the
 * advisory id or any alias, case-insensitively.
 */
const KNOWN_SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low', 'unknown']);

/** Harden an injected vulnerability record so a broken seam cannot crash the gate. */
function normalizeInjectedVulnerability(vuln: OsvVulnerability): OsvVulnerability {
  const severity = KNOWN_SEVERITIES.has(vuln.severity) ? vuln.severity : 'unknown';
  const aliases = Array.isArray(vuln.aliases)
    ? vuln.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim() !== '')
    : [];
  return { ...vuln, id: vuln.id.trim(), severity, aliases, summary: typeof vuln.summary === 'string' ? vuln.summary : '' };
}

export function blockOn(
  vuln: OsvVulnerability,
  policy: 'block' | 'warn',
  allowIds?: Set<string> | Iterable<string>,
): boolean {
  if (policy !== 'block') return false;
  if (vuln.severity !== 'critical' && vuln.severity !== 'high') return false;
  if (allowIds) {
    const allowed = new Set([...allowIds].map((id) => String(id).toLowerCase().trim()).filter((id) => id !== ''));
    const aliases = Array.isArray(vuln.aliases) ? vuln.aliases : [];
    const candidates = [vuln.id, ...aliases].map((id) => id.toLowerCase());
    if (candidates.some((id) => allowed.has(id))) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Lockfile parsing                                                    */
/* ------------------------------------------------------------------ */

export const MAX_PACKAGES = 500;
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const VERSION_RE = /^[^\s"']+$/;

/** Locate the indented `packages:` map of a pubspec.lock (mirrors sbom.ts conventions). */
function findTopLevelSection(lines: string[], key: string): { start: number; end: number } | null {
  const topLevel = /^([A-Za-z_][A-Za-z0-9_-]*):/;
  for (let index = 0; index < lines.length; index += 1) {
    const match = topLevel.exec(lines[index]);
    if (match && match[1] === key) {
      let end = index + 1;
      while (end < lines.length && !topLevel.test(lines[end])) end += 1;
      return { start: index + 1, end };
    }
  }
  return null;
}

/** Count `  <name>:` headers under `packages:` — used to detect entries the parser had to drop. */
function countLockPackageHeaders(lock: string): number {
  const lines = lock.split('\n');
  const section = findTopLevelSection(lines, 'packages');
  if (!section) return 0;
  const header = /^ {2}[A-Za-z0-9_.-]+:\s*$/;
  let count = 0;
  for (let index = section.start; index < section.end; index += 1) {
    if (header.test(lines[index])) count += 1;
  }
  return count;
}

function isValidPackageEntry(name: string, version: string): boolean {
  return NAME_RE.test(name) && version.length > 0 && VERSION_RE.test(version);
}

/**
 * Extract hosted packages (skipping path/git/sdk sources) from pubspec.lock
 * contents. Deduped by `name@version`, capped at {@link MAX_PACKAGES}
 * (deterministic: sorted input, first 500 kept). Entries lacking a valid
 * name/version are skipped and counted on the returned array's `skipped`
 * property — callers must surface that count; silently dropping unscannable
 * packages defeats the point of a gate.
 */
export function parseLockfilePackages(lock: string): ParsedLockfilePackages {
  const locked = parsePubspecLock(lock ?? '');
  // Entries parsePubspecLock had to discard entirely (e.g. no version field).
  const droppedByParser = Math.max(0, countLockPackageHeaders(lock ?? '') - locked.length);

  let skipped = droppedByParser;
  const seen = new Set<string>();
  const out: Array<{ name: string; version: string }> = [];

  for (const pkg of locked) {
    if (pkg.source !== 'hosted') continue; // path/git/sdk are never sent to OSV
    if (!isValidPackageEntry(pkg.name, pkg.version)) {
      skipped += 1;
      continue;
    }
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: pkg.name, version: pkg.version });
    if (out.length >= MAX_PACKAGES) break;
  }

  const result = out as ParsedLockfilePackages;
  result.skipped = skipped;
  return result;
}

/** Normalise a caller-supplied package array: validate, dedupe, cap. */
function normalizePackages(input: Array<{ name: string; version: string }>): {
  packages: Array<{ name: string; version: string }>;
  invalid: Array<{ name: unknown; version: unknown }>;
  capped: boolean;
} {
  const seen = new Set<string>();
  const packages: Array<{ name: string; version: string }> = [];
  const invalid: Array<{ name: unknown; version: unknown }> = [];
  const capped = input.length > MAX_PACKAGES;

  for (const entry of input) {
    if (packages.length >= MAX_PACKAGES) break;
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    const version = typeof entry?.version === 'string' ? entry.version.trim() : '';
    if (!isValidPackageEntry(name, version)) {
      invalid.push({ name: entry?.name, version: entry?.version });
      continue;
    }
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    packages.push({ name, version });
  }
  return { packages, invalid, capped };
}

/* ------------------------------------------------------------------ */
/* CVSS scoring (real v3.1 + v2 base-score calculators)                */
/* ------------------------------------------------------------------ */

interface CvssBucketInput {
  score: number;
}

function roundUp1(value: number): number {
  // Official CVSS v3 "roundup": round up to the nearest 0.1 with float guards.
  const intInput = Math.round(value * 100000);
  if (intInput % 10000 === 0) return intInput / 100000;
  return (Math.floor(intInput / 10000) + 1) / 10;
}

const CVSS31_AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const CVSS31_AC: Record<string, number> = { L: 0.77, H: 0.44 };
const CVSS31_PR_U: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const CVSS31_PR_C: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };
const CVSS31_UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CVSS31_CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

/** Parse a CVSS v3.x vector and return its base score, or null when unparseable. */
export function cvss31BaseScore(vector: string): number | null {
  const match = /^CVSS:3\.\d\/(.+)$/i.exec(vector.trim());
  if (!match) return null;
  const metrics = new Map<string, string>();
  for (const part of match[1].split('/')) {
    const [key, value] = part.split(':');
    if (key && value) metrics.set(key.toUpperCase(), value.toUpperCase());
  }
  const av = CVSS31_AV[metrics.get('AV') ?? ''];
  const ac = CVSS31_AC[metrics.get('AC') ?? ''];
  const scope = metrics.get('S');
  const pr = scope === 'C' ? CVSS31_PR_C[metrics.get('PR') ?? ''] : CVSS31_PR_U[metrics.get('PR') ?? ''];
  const ui = CVSS31_UI[metrics.get('UI') ?? ''];
  const c = CVSS31_CIA[metrics.get('C') ?? ''];
  const i = CVSS31_CIA[metrics.get('I') ?? ''];
  const a = CVSS31_CIA[metrics.get('A') ?? ''];
  if (av === undefined || ac === undefined || pr === undefined || ui === undefined
    || c === undefined || i === undefined || a === undefined
    || (scope !== 'U' && scope !== 'C')) {
    return null;
  }

  // CVSS v3.1 spec §7.1: Scope Changed → 7.52×(ISS−0.029) − 3.25×(ISS−0.02)^15
  // (the 0.9731 factor and exponent 13 apply only to the Environmental MISS
  // formula, §7.3 — not to the base score).
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = scope === 'U'
    ? 6.42 * iss
    : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
  const exploitability = 8.22 * av * ac * pr * ui;

  if (impact <= 0) return 0;
  const base = scope === 'U'
    ? roundUp1(Math.min(impact + exploitability, 10))
    : roundUp1(Math.min(1.08 * (impact + exploitability), 10));
  return Math.min(10, Math.max(0, base));
}

const CVSS2_CIA: Record<string, number> = { N: 0, P: 0.275, C: 0.66 };
const CVSS2_AV: Record<string, number> = { L: 0.395, A: 0.646, N: 1.0 };
const CVSS2_AC: Record<string, number> = { H: 0.35, M: 0.61, L: 0.71 };
const CVSS2_AU: Record<string, number> = { M: 0.45, S: 0.56, N: 0.704 };

/** Parse a CVSS v2 vector ("AV:N/AC:L/Au:N/C:P/I:P/A:P") and return its base score, or null. */
export function cvss2BaseScore(vector: string): number | null {
  const trimmed = vector.trim().replace(/^CVSS2#/i, '');
  if (!/^AV:[LAMNP]\//i.test(trimmed) && !trimmed.toUpperCase().startsWith('AV:')) return null;
  const metrics = new Map<string, string>();
  for (const part of trimmed.split('/')) {
    const [key, value] = part.split(':');
    if (key && value) metrics.set(key.trim().toLowerCase(), value.trim().toUpperCase());
  }
  const av = CVSS2_AV[metrics.get('av') ?? ''];
  const ac = CVSS2_AC[metrics.get('ac') ?? ''];
  const au = CVSS2_AU[metrics.get('au') ?? ''];
  const c = CVSS2_CIA[metrics.get('c') ?? ''];
  const i = CVSS2_CIA[metrics.get('i') ?? ''];
  const a = CVSS2_CIA[metrics.get('a') ?? ''];
  if (av === undefined || ac === undefined || au === undefined
    || c === undefined || i === undefined || a === undefined) {
    return null;
  }

  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = 10.41 * iss;
  const exploitability = 20 * av * ac * au;
  const f = impact === 0 ? 0 : 1.176;
  const base = ((0.6 * impact) + (0.4 * exploitability) - 1.5) * f;
  return Math.min(10, Math.max(0, Math.round(base * 10) / 10));
}

/** Bucket a numeric CVSS base score. 0.0 buckets to `low` (NVD "None" has no OSV bucket). */
export function bucketCvssScore(score: number): OsvSeverity {
  if (!Number.isFinite(score) || score < 0) return 'unknown';
  if (score >= 9.0) return 'critical';
  if (score >= 7.0) return 'high';
  if (score >= 4.0) return 'medium';
  return 'low';
}

/**
 * Interpret a CVSS "score" string as found in OSV's `severity[].score`.
 * Accepts: a full vector ("CVSS:3.1/..." / v2 "AV:N/..."), a plain number
 * ("9.8"), or a `cvss:<number>` decoration ("cvss:9.8"). Returns null when the
 * string cannot be reduced to a base score.
 */
export function cvssScoreFromString(raw: string): CvssBucketInput | null {
  const value = raw.trim();
  if (value === '') return null;

  const decorated = /^cvss:\s*(\d+(?:\.\d+)?)$/i.exec(value);
  if (decorated) {
    const score = Number(decorated[1]);
    return Number.isFinite(score) && score <= 10 ? { score } : null;
  }
  if (/^\d+(\.\d+)?$/.test(value)) {
    const score = Number(value);
    return Number.isFinite(score) && score <= 10 ? { score } : null;
  }
  if (/^CVSS:4(\.\d+)?\//i.test(value)) {
    // CVSS v4 is not evaluated: the v4 spec is a different metric set and the
    // OSV ecosystem mixes v3/v4 freely. Honest `unknown`, never a guess.
    return null;
  }
  if (/^CVSS:3(\.\d+)?\//i.test(value)) {
    const score = cvss31BaseScore(value);
    return score === null ? null : { score };
  }
  if (/^(CVSS2#)?AV:/i.test(value)) {
    const score = cvss2BaseScore(value);
    return score === null ? null : { score };
  }
  return null;
}

const DATABASE_SEVERITY_MAP: Record<string, OsvSeverity> = {
  critical: 'critical',
  crit: 'critical',
  high: 'high',
  medium: 'medium',
  moderate: 'medium', // GitHub advisories use MODERATE for CVSS 4.0–6.9
  moderately: 'medium',
  low: 'low',
  minor: 'low',
  // NONE / UNKNOWN deliberately absent → falls through to CVSS, else unknown.
};

function severityFromDatabaseSpecific(db: unknown): OsvSeverity | null {
  if (!db || typeof db !== 'object') return null;
  const raw = (db as Record<string, unknown>).severity;
  if (typeof raw !== 'string') return null;
  return DATABASE_SEVERITY_MAP[raw.trim().toLowerCase()] ?? null;
}

function severityFromCvssEntries(severityEntries: unknown): OsvSeverity | null {
  if (!Array.isArray(severityEntries)) return null;
  let best: number | null = null;
  for (const entry of severityEntries) {
    if (!entry || typeof entry !== 'object') continue;
    const score = (entry as Record<string, unknown>).score;
    if (typeof score !== 'string') continue;
    const parsed = cvssScoreFromString(score);
    if (parsed && (best === null || parsed.score > best)) best = parsed.score;
  }
  return best === null ? null : bucketCvssScore(best);
}

/**
 * Map an OSV advisory's severity. Precedence: database_specific.severity →
 * highest parseable CVSS score → unknown.
 */
export function mapSeverity(vuln: {
  severity?: unknown;
  database_specific?: unknown;
}): OsvSeverity {
  const fromDb = severityFromDatabaseSpecific(vuln.database_specific);
  if (fromDb) return fromDb;
  const fromCvss = severityFromCvssEntries(vuln.severity);
  if (fromCvss) return fromCvss;
  return 'unknown';
}

/* ------------------------------------------------------------------ */
/* OSV response → typed vulnerabilities                                */
/* ------------------------------------------------------------------ */

interface OsvAffectedRange {
  type?: unknown;
  events?: unknown;
  /** Non-standard but observed in some feeds; honoured when present. */
  fixed?: unknown;
}

interface OsvRawVulnerability {
  id?: unknown;
  summary?: unknown;
  details?: unknown;
  aliases?: unknown;
  severity?: unknown;
  database_specific?: unknown;
  affected?: unknown;
  references?: unknown;
}

/** Loose semver-ish compare: numeric identifiers compare numerically, others lexically. */
function compareVersionsLoose(a: string, b: string): number {
  const split = (v: string) => v.split(/[^0-9A-Za-z]+/).filter(Boolean);
  const left = split(a);
  const right = split(b);
  const len = Math.max(left.length, right.length);
  for (let index = 0; index < len; index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) {
      const diff = Number(l) - Number(r);
      if (diff !== 0) return diff;
    } else {
      const diff = l.localeCompare(r);
      if (diff !== 0) return diff;
    }
  }
  return 0;
}

/**
 * Lowest `fixed` version across all affected ranges — i.e. the first release
 * carrying the fix. Checks both the standard `ranges[].events[].fixed` shape
 * and the non-standard `ranges[].fixed` string. Returns undefined when no
 * fixed version is published (e.g. unpatched advisories).
 */
export function extractFixedIn(affected: unknown): string | undefined {
  if (!Array.isArray(affected)) return undefined;
  const candidates: string[] = [];
  for (const entry of affected) {
    if (!entry || typeof entry !== 'object') continue;
    const ranges = (entry as { ranges?: unknown }).ranges;
    if (!Array.isArray(ranges)) continue;
    for (const range of ranges as OsvAffectedRange[]) {
      if (!range || typeof range !== 'object') continue;
      if (typeof range.fixed === 'string' && range.fixed.trim() !== '') {
        candidates.push(range.fixed.trim());
      }
      const events = range.events;
      if (!Array.isArray(events)) continue;
      for (const event of events) {
        if (!event || typeof event !== 'object') continue;
        const fixed = (event as Record<string, unknown>).fixed;
        if (typeof fixed === 'string' && fixed.trim() !== '') candidates.push(fixed.trim());
      }
    }
  }
  if (candidates.length === 0) return undefined;
  const unique = [...new Set(candidates)];
  unique.sort(compareVersionsLoose);
  return unique[0];
}

function parseOsvVulnerability(raw: OsvRawVulnerability): OsvVulnerability {
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : 'UNKNOWN';
  const summarySource = typeof raw.summary === 'string' && raw.summary.trim() !== ''
    ? raw.summary
    : typeof raw.details === 'string' ? raw.details : '';
  const summary = summarySource.trim();
  const aliases = Array.isArray(raw.aliases)
    ? [...new Set(raw.aliases.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map((a) => a.trim()))]
    : [];
  const fixedIn = extractFixedIn(raw.affected);
  const references = Array.isArray(raw.references) ? raw.references : [];
  const reference = references
    .map((ref) => (ref && typeof ref === 'object' ? (ref as Record<string, unknown>).url : undefined))
    .find((url): url is string => typeof url === 'string' && url.trim() !== '');

  return {
    id,
    summary,
    severity: mapSeverity(raw),
    aliases,
    ...(fixedIn ? { fixedIn } : {}),
    ...(reference ? { reference: reference.trim() } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* queryOsvBatch                                                       */
/* ------------------------------------------------------------------ */

const DEFAULT_ENDPOINT = 'https://api.osv.dev/v1/querybatch';
const DEFAULT_VULNERABILITY_ENDPOINT = 'https://api.osv.dev/v1/vulns/';
const CHUNK_SIZE = 100;
const OSV_ECOSYSTEM = 'Pub';
/**
 * Hard cap on per-advisory record fetches when querybatch returns compact
 * records. Exceeding it fails closed (OSV_UNAVAILABLE) rather than shipping a
 * gate that cannot tell a critical advisory from a clean tree.
 */
const MAX_ENRICHMENTS = 200;

/** querybatch returns compact records; decide whether a raw entry needs /v1/vulns/{id} enrichment. */
const DETAIL_FIELDS = ['summary', 'details', 'severity', 'aliases', 'affected', 'references', 'database_specific'] as const;

function rawHasDetailFields(raw: Record<string, unknown>): boolean {
  return DETAIL_FIELDS.some((field) => raw[field] !== undefined);
}

function deriveVulnerabilityEndpoint(endpoint: string): string {
  if (/\/querybatch\/?$/.test(endpoint)) return endpoint.replace(/\/querybatch\/?$/, '/vulns/');
  return DEFAULT_VULNERABILITY_ENDPOINT;
}

function osvUnavailable(message: string, details: Record<string, unknown>, cause?: unknown): PlatformError {
  return new PlatformError({
    code: 'OSV_UNAVAILABLE',
    message,
    statusCode: 503,
    retryable: true,
    details,
    cause,
    expose: true,
    severity: 'error',
  });
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/**
 * Query OSV for a batch of packages. Packages are deduped by `name@version`
 * and queried in chunks of 100 against `endpoint` (default
 * https://api.osv.dev/v1/querybatch) with ecosystem `Pub`.
 *
 * IMPORTANT — wire shape: against the live API, `/v1/querybatch` returns
 * COMPACT records (`{ id, modified }`) only. Entries that already carry any
 * detail field (summary/details/aliases/severity/affected/references/
 * database_specific — e.g. recorded or mirrored responses) are used as-is;
 * compact entries are enriched by fetching the full record from
 * `/v1/vulns/{id}` (endpoint derived from `endpoint`, or
 * `vulnerabilityEndpoint` when given). At most {@link MAX_ENRICHMENTS} unique
 * advisory records are fetched per call; exceeding that fails closed.
 *
 * Returns a Map keyed `name@version` → vulnerabilities; every queried package
 * has an entry (empty array when clean). ANY network, HTTP or protocol
 * failure — including a failed enrichment fetch — throws `PlatformError` with
 * code `OSV_UNAVAILABLE`; callers must not treat that as "no vulnerabilities".
 */
export async function queryOsvBatch(
  packages: Array<{ name: string; version: string }>,
  options: QueryOsvBatchOptions = {},
): Promise<Map<string, OsvVulnerability[]>> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const vulnerabilityEndpoint = options.vulnerabilityEndpoint ?? deriveVulnerabilityEndpoint(endpoint);
  const fetchFn: FetchLike = options.fetchFn
    ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
  const timeoutMs = options.timeoutMs ?? 15000;

  const { packages: unique, invalid } = normalizePackages(packages);
  if (invalid.length > 0) {
    throw new ValidationError(
      'Refusing to query OSV with invalid package entries.',
      { endpoint, invalidCount: invalid.length, firstInvalid: invalid[0] },
      'OSV_INVALID_INPUT',
    );
  }

  const rawPerPackage: Array<{ key: string; raws: unknown[] }> = [];
  const compactIds = new Set<string>();
  const chunks = chunk(unique, CHUNK_SIZE);

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const slice = chunks[chunkIndex];
    const body = JSON.stringify({
      queries: slice.map((pkg) => ({
        package: { name: pkg.name, ecosystem: OSV_ECOSYSTEM },
        version: pkg.version,
      })),
    });

    let response: { ok: boolean; status: number; statusText?: string; json(): Promise<unknown> };
    try {
      response = await fetchFn(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(timeoutMs)
          : undefined,
      });
    } catch (error) {
      throw osvUnavailable(
        `OSV query failed (network error) for chunk ${chunkIndex + 1}/${chunks.length}.`,
        { endpoint, chunkIndex, chunkSize: slice.length, packageCount: unique.length, cause: describeCause(error) },
        error,
      );
    }

    if (!response || typeof response.ok !== 'boolean') {
      throw osvUnavailable(
        `OSV query returned a malformed response object for chunk ${chunkIndex + 1}/${chunks.length}.`,
        { endpoint, chunkIndex, chunkSize: slice.length },
      );
    }
    if (!response.ok) {
      throw osvUnavailable(
        `OSV query failed with HTTP ${response.status} for chunk ${chunkIndex + 1}/${chunks.length}.`,
        { endpoint, chunkIndex, chunkSize: slice.length, status: response.status, statusText: response.statusText ?? null },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw osvUnavailable(
        `OSV query returned a non-JSON body for chunk ${chunkIndex + 1}/${chunks.length}.`,
        { endpoint, chunkIndex, chunkSize: slice.length, cause: describeCause(error) },
        error,
      );
    }

    const results = (payload as { results?: unknown } | null)?.results;
    if (!Array.isArray(results) || results.length !== slice.length) {
      throw osvUnavailable(
        'OSV query returned a result count that does not match the query count.',
        {
          endpoint,
          chunkIndex,
          chunkSize: slice.length,
          resultsLength: Array.isArray(results) ? results.length : null,
        },
      );
    }

    for (let index = 0; index < slice.length; index += 1) {
      const pkg = slice[index];
      const key = `${pkg.name}@${pkg.version}`;
      const entry = results[index] as { vulns?: unknown } | null;
      const vulns = entry && typeof entry === 'object' && Array.isArray(entry.vulns) ? entry.vulns : [];
      for (const raw of vulns) {
        if (raw && typeof raw === 'object') {
          const record = raw as Record<string, unknown>;
          const id = typeof record.id === 'string' ? record.id.trim() : '';
          if (id !== '' && !rawHasDetailFields(record)) compactIds.add(id);
        }
      }
      rawPerPackage.push({ key, raws: vulns });
    }
  }

  // Enrich compact querybatch records with their full /v1/vulns/{id}
  // documents — querybatch alone never carries severity/aliases/fixedIn.
  const enriched = new Map<string, OsvVulnerability>();
  if (compactIds.size > MAX_ENRICHMENTS) {
    throw osvUnavailable(
      `OSV querybatch returned ${compactIds.size} distinct advisory ids; refusing to enrich more than ${MAX_ENRICHMENTS}.`,
      { endpoint, vulnerabilityEndpoint, distinctAdvisoryIds: compactIds.size, limit: MAX_ENRICHMENTS },
    );
  }
  for (const id of compactIds) {
    const url = `${vulnerabilityEndpoint}${encodeURIComponent(id)}`;
    let response: { ok: boolean; status: number; statusText?: string; json(): Promise<unknown> };
    try {
      response = await fetchFn(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(timeoutMs)
          : undefined,
      });
    } catch (error) {
      throw osvUnavailable(
        `OSV advisory fetch failed (network error) for ${id}.`,
        { vulnerabilityEndpoint, id, cause: describeCause(error) },
        error,
      );
    }
    if (!response || typeof response.ok !== 'boolean' || !response.ok) {
      throw osvUnavailable(
        `OSV advisory fetch failed with HTTP ${response?.status ?? 'unknown'} for ${id}.`,
        { vulnerabilityEndpoint, id, status: response?.status ?? null, statusText: response?.statusText ?? null },
      );
    }
    let record: unknown;
    try {
      record = await response.json();
    } catch (error) {
      throw osvUnavailable(
        `OSV advisory fetch returned a non-JSON body for ${id}.`,
        { vulnerabilityEndpoint, id, cause: describeCause(error) },
        error,
      );
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw osvUnavailable(
        `OSV advisory fetch returned a malformed record for ${id}.`,
        { vulnerabilityEndpoint, id },
      );
    }
    const parsed = parseOsvVulnerability(record as OsvRawVulnerability);
    // The record id wins when present; otherwise keep the requested id.
    enriched.set(id, { ...parsed, id: parsed.id === 'UNKNOWN' ? id : parsed.id });
  }

  const out = new Map<string, OsvVulnerability[]>();
  for (const { key, raws } of rawPerPackage) {
    out.set(key, raws.map((raw) => {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const record = raw as Record<string, unknown>;
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        if (id !== '' && !rawHasDetailFields(record)) {
          const full = enriched.get(id);
          if (!full) {
            throw osvUnavailable(
              `OSV advisory ${id} could not be enriched after a successful fetch.`,
              { vulnerabilityEndpoint, id },
            );
          }
          return full;
        }
        // Detailed entry (e.g. recorded fixture or mirror) — parse directly.
        return parseOsvVulnerability(record);
      }
      // Advisory-shaped garbage must stay visible, never vanish silently.
      return { id: 'UNKNOWN', summary: '', severity: 'unknown', aliases: [] } satisfies OsvVulnerability;
    }));
  }

  return out;
}

function describeCause(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/* ------------------------------------------------------------------ */
/* gate                                                                */
/* ------------------------------------------------------------------ */

/**
 * Run the OSV gate over a lockfile or an explicit package list.
 *
 * Policy:
 *  - `block`: blocked=true when any finding has severity critical|high, or
 *    when anything about the scan failed (query error, missing result for a
 *    queried package, invalid entries). Fail closed.
 *  - `warn`: blocked is ALWAYS false; findings and errors are still reported.
 *
 * `allowIds` bypasses advisories by id or alias, case-insensitively. NOT for
 * production use without review: every bypassed id must be tracked with an
 * owner and an expiry in your exception tracker.
 *
 * Errors are never swallowed: each failing package contributes one entry of
 * the form `OSV_QUERY_FAILED <name>@<version>: <reason>` to `errors`.
 * `ok` is true only when the gate neither blocked nor recorded errors.
 */
export async function gate(options: GateOptions): Promise<OsvGateResult> {
  if (!options || (options.packages === undefined && options.lock === undefined)) {
    throw new ValidationError('gate requires either `packages` or `lock`.', { option: 'packages|lock' }, 'OSV_GATE_INPUT');
  }
  const policy = options.policy;
  if (policy !== 'block' && policy !== 'warn') {
    throw new ValidationError('gate policy must be "block" or "warn".', { policy }, 'OSV_GATE_INPUT');
  }

  const errors: string[] = [];
  let packages: Array<{ name: string; version: string }>;
  let skipped = 0;

  if (options.lock !== undefined) {
    const parsed = parseLockfilePackages(options.lock);
    packages = [...parsed];
    skipped = parsed.skipped;
  } else {
    const normalized = normalizePackages(options.packages ?? []);
    packages = normalized.packages;
    for (const entry of normalized.invalid) {
      errors.push(`OSV_INVALID_PACKAGE ${stringifyEntry(entry)}: missing or invalid name/version; package was not scanned.`);
    }
    if (normalized.capped) {
      errors.push(`OSV_PACKAGE_CAP: more than ${MAX_PACKAGES} packages supplied; only the first ${MAX_PACKAGES} were scanned.`);
    }
  }
  if (skipped > 0) {
    errors.push(`OSV_SKIPPED_PACKAGES: ${skipped} lock entr${skipped === 1 ? 'y was' : 'ies were'} skipped (invalid name/version) and could not be scanned.`);
  }

  const allowIds = options.allowIds
    ? new Set([...options.allowIds].map((id) => String(id).toLowerCase().trim()).filter((id) => id !== ''))
    : undefined;
  const queryFn: QueryFn = options.queryFn ?? ((pkgs) => queryOsvBatch(pkgs));

  const vulnerabilities: OsvGateVulnerability[] = [];

  if (packages.length > 0) {
    let results: Map<string, OsvVulnerability[]> | null = null;
    try {
      results = await queryFn(packages);
    } catch (error) {
      const reason = error instanceof PlatformError
        ? `${error.code}: ${error.message}`
        : describeCause(error);
      for (const pkg of packages) {
        errors.push(`OSV_QUERY_FAILED ${pkg.name}@${pkg.version}: ${reason}`);
      }
    }

    if (results) {
      if (!(results instanceof Map)) {
        const reason = 'queryFn did not return a Map';
        for (const pkg of packages) {
          errors.push(`OSV_QUERY_FAILED ${pkg.name}@${pkg.version}: ${reason}`);
        }
      } else {
        for (const pkg of packages) {
          const key = `${pkg.name}@${pkg.version}`;
          const vulns = results.get(key);
          if (vulns === undefined) {
            errors.push(`OSV_QUERY_FAILED ${key}: queryFn returned no result for this package.`);
            continue;
          }
          if (!Array.isArray(vulns)) {
            errors.push(`OSV_QUERY_FAILED ${key}: queryFn returned a non-array vulnerability list.`);
            continue;
          }
          for (const vuln of vulns) {
            if (!vuln || typeof vuln.id !== 'string' || vuln.id.trim() === '') {
              errors.push(`OSV_QUERY_FAILED ${key}: vulnerability entry without a valid id was dropped.`);
              continue;
            }
            vulnerabilities.push({ package: pkg.name, version: pkg.version, vulnerability: normalizeInjectedVulnerability(vuln) });
          }
        }
      }
    }
  }

  vulnerabilities.sort((a, b) =>
    severityRank(a.vulnerability.severity) - severityRank(b.vulnerability.severity)
    || a.package.localeCompare(b.package)
    || a.version.localeCompare(b.version)
    || a.vulnerability.id.localeCompare(b.vulnerability.id));

  const blocking = vulnerabilities.filter((finding) => blockOn(finding.vulnerability, policy, allowIds));
  // Fail closed: any recorded error (query failure, missing result, invalid
  // entry, cap overflow, skipped lock entries) blocks under policy 'block'.
  const blocked = policy === 'block' && (blocking.length > 0 || errors.length > 0);

  return {
    ok: !blocked && errors.length === 0,
    vulnerabilities,
    blocked,
    policy,
    errors,
    checkedAtMs: Date.now(),
    totalPackages: packages.length,
  };
}

function stringifyEntry(entry: { name: unknown; version: unknown }): string {
  const name = typeof entry?.name === 'string' ? entry.name : JSON.stringify(entry?.name);
  const version = typeof entry?.version === 'string' ? entry.version : JSON.stringify(entry?.version);
  return `${name ?? '?'}@${version ?? '?'}`;
}

/* ------------------------------------------------------------------ */
/* summarize                                                           */
/* ------------------------------------------------------------------ */

const SUMMARY_CAP = 20;
const ERROR_LINE_CAP = 5;
const FINDING_SUMMARY_MAX = 140;

/**
 * Compact, deterministic rendering of a gate result for LLM/UI consumption.
 * One line per blocking-class finding (severity critical|high), sorted by
 * severity rank then package name then id, capped at 20 lines with an
 * `… and N more` trailer. Errors (when present) follow, capped at 5 lines.
 * No timestamps — identical input yields identical output.
 */
export function summarize(result: OsvGateResult): string {
  const blockingClass = result.vulnerabilities
    .filter((finding) => finding.vulnerability.severity === 'critical' || finding.vulnerability.severity === 'high')
    .sort((a, b) =>
      severityRank(a.vulnerability.severity) - severityRank(b.vulnerability.severity)
      || a.package.localeCompare(b.package)
      || a.version.localeCompare(b.version)
      || a.vulnerability.id.localeCompare(b.vulnerability.id));

  const lines: string[] = [
    `OSV gate: ${result.blocked ? 'BLOCKED' : 'OK'} (policy=${result.policy}, packages=${result.totalPackages}, blocking-class findings=${blockingClass.length})`,
  ];

  const shown = blockingClass.slice(0, SUMMARY_CAP);
  for (const finding of shown) {
    const { vulnerability } = finding;
    const summary = vulnerability.summary.length > FINDING_SUMMARY_MAX
      ? `${vulnerability.summary.slice(0, FINDING_SUMMARY_MAX - 1)}…`
      : vulnerability.summary;
    const fixed = vulnerability.fixedIn ? ` (fixed in ${vulnerability.fixedIn})` : ' (no fixed version published)';
    const aliases = vulnerability.aliases.length > 0 ? ` [aliases: ${vulnerability.aliases.join(', ')}]` : '';
    lines.push(
      `[${vulnerability.severity.toUpperCase()}] ${finding.package}@${finding.version} ${vulnerability.id}${aliases}: ${summary}${fixed}`,
    );
  }
  if (blockingClass.length > SUMMARY_CAP) {
    lines.push(`… and ${blockingClass.length - SUMMARY_CAP} more blocking finding(s)`);
  }

  if (result.errors.length > 0) {
    lines.push(`errors (${result.errors.length}):`);
    for (const error of result.errors.slice(0, ERROR_LINE_CAP)) {
      lines.push(`- ${error}`);
    }
    if (result.errors.length > ERROR_LINE_CAP) {
      lines.push(`… and ${result.errors.length - ERROR_LINE_CAP} more error(s)`);
    }
  }

  return lines.join('\n');
}
