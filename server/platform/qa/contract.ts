/**
 * Project-contract verification for generated Flutter projects.
 *
 * This module is deliberately text-based and local: it never imports the
 * generated Dart code, and it never throws on malformed input. Every check
 * is deterministic and independently testable — checks run in a fixed order
 * and append to the `checks` array exactly once.
 *
 * A check fails by returning `passed: false`. Failures at severity `error`
 * become blockers (capped at `MAX_CONTRACT_BLOCKERS`); warnings (e.g. a
 * missing Supabase migration) never block. `passed` is true iff there are
 * no blocking failures.
 */

export type ContractCheckSeverity = 'error' | 'warning' | 'info';

export interface ContractCheck {
  id: string;
  severity: ContractCheckSeverity;
  passed: boolean;
  message: string;
  /** Optional file path the check refers to (project-relative). */
  path?: string;
}

export interface ContractFile {
  path: string;
  content: string;
}

export interface ContractExpectations {
  /** Entry file to require instead of the default `lib/main.dart`. */
  mainPath?: string;
  /** Additional dependency names that must be declared (dependencies or dev_dependencies). */
  requiredDependencies?: string[];
  /** Additional asset paths that must be listed in pubspec `assets:`. */
  requiredAssets?: string[];
}

export interface VerifyProjectContractInput {
  files: ContractFile[];
  packageName: string;
  appId?: string;
  expectsSupabase?: boolean;
  expectations?: ContractExpectations;
}

export interface ProjectContractResult {
  passed: boolean;
  checks: ContractCheck[];
  blockers: ContractCheck[];
}

export const MAX_CONTRACT_BLOCKERS = 12;
const MAX_LISTED = 8;

/* -------------------------------------------------------------------------- */
/* Small local helpers                                                        */
/* -------------------------------------------------------------------------- */

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clip(value: string, max: number): string {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Normalize a project-relative path: forward slashes, no leading ./ or /. */
export function normalizeContractPath(value: unknown): string {
  let result = asText(value).replace(/\\/g, '/').replace(/\0/g, '').trim();
  result = result.replace(/^\.\/+/, '').replace(/^\/+/, '');
  return result;
}

function normalizeFiles(files: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (!Array.isArray(files)) return result;
  for (const entry of files) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const path = normalizeContractPath(record.path);
    if (!path || result.has(path)) continue;
    result.set(path, asText(record.content));
  }
  return result;
}

function sanitizePackageName(value: unknown): string {
  const name = asText(value).trim();
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : '';
}

const YAML_TOP_KEY = /^([A-Za-z_][\w-]*)\s*:(.*)$/;
const YAML_TWO_SPACE_KEY = /^ {2}([A-Za-z0-9_.-]+)\s*:/;

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

function stripYamlComment(value: string): string {
  // Only strips trailing comments starting at whitespace or line start; quoted values keep their #.
  const match = /^(.*?)\s+#.*$/.exec(value);
  return match ? match[1].replace(/\s+$/, '') : value;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = stripYamlComment(value).trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Parse a two-space-indented dependency block. Returns the sorted unique dependency names. */
function parseDependencyBlock(lines: string[], startIndex: number): string[] {
  const names: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) break; // next top-level key
    const match = YAML_TWO_SPACE_KEY.exec(line);
    if (match) names.push(match[1]);
  }
  return [...new Set(names)].sort(compareText);
}

interface PubspecInfo {
  found: boolean;
  name: string;
  hasEnvironmentSection: boolean;
  sdkConstraint: string;
  hasFlutterSection: boolean;
  dependencies: string[];
  devDependencies: string[];
  /** Union of dependencies and devDependencies, sorted. */
  declared: string[];
  assets: string[];
  raw: string;
}

const EMPTY_PUBSPEC: PubspecInfo = {
  found: false,
  name: '',
  hasEnvironmentSection: false,
  sdkConstraint: '',
  hasFlutterSection: false,
  dependencies: [],
  devDependencies: [],
  declared: [],
  assets: [],
  raw: '',
};

function parsePubspec(content: string): PubspecInfo {
  if (!content.trim()) return { ...EMPTY_PUBSPEC, found: true, raw: content };
  const lines = splitLines(content);
  let name = '';
  let hasEnvironmentSection = false;
  let sdkConstraint = '';
  let hasFlutterSection = false;
  let dependencies: string[] = [];
  let devDependencies: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const top = YAML_TOP_KEY.exec(line);
    if (!top) continue;
    const key = top[1];
    const rest = top[2];

    if (key === 'name') {
      name = unquoteYamlScalar(rest);
      continue;
    }
    if (key === 'environment') {
      hasEnvironmentSection = true;
      for (let inner = index + 1; inner < lines.length; inner += 1) {
        const innerLine = lines[inner];
        if (innerLine.trim() && !/^\s/.test(innerLine)) break;
        const sdk = /^ {2}sdk\s*:(.*)$/.exec(innerLine);
        if (sdk) {
          sdkConstraint = unquoteYamlScalar(sdk[1]);
          break;
        }
      }
      continue;
    }
    if (key === 'flutter') {
      hasFlutterSection = true;
      continue;
    }
    if (key === 'dependencies') {
      dependencies = parseDependencyBlock(lines, index);
      continue;
    }
    if (key === 'dev_dependencies') {
      devDependencies = parseDependencyBlock(lines, index);
    }
  }

  // Assets: `assets:` at any indent, followed by `- path` entries at deeper indent,
  // or inline flow style `assets: [a, b]`.
  const assets: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const assetsKey = /^(\s*)assets\s*:(.*)$/.exec(line);
    if (!assetsKey) continue;
    const indent = assetsKey[1].length;
    const inline = assetsKey[2].trim();
    if (inline.startsWith('[')) {
      const body = inline.replace(/^\[/, '').replace(/\].*$/, '');
      for (const part of body.split(',')) {
        const entry = unquoteYamlScalar(part);
        if (entry) assets.push(entry);
      }
      continue;
    }
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const innerLine = lines[inner];
      if (!innerLine.trim() || innerLine.trim().startsWith('#')) continue;
      const innerIndent = innerLine.length - innerLine.trimStart().length;
      if (innerIndent <= indent) break;
      const item = /^\s*-\s+(.+)$/.exec(innerLine);
      if (item) {
        const entry = unquoteYamlScalar(item[1]);
        if (entry) assets.push(entry);
      } else if (/^\s*\w[\w-]*\s*:/.test(innerLine)) {
        break; // next sub-key
      }
    }
  }

  const declared = [...new Set([...dependencies, ...devDependencies])].sort(compareText);
  return {
    found: true,
    name,
    hasEnvironmentSection,
    sdkConstraint,
    hasFlutterSection,
    dependencies,
    devDependencies,
    declared,
    assets: [...new Set(assets)],
    raw: content,
  };
}

/* --------------------------------- Dart ---------------------------------- */

/** Strip comments and string literals so structural tokens can be located. */
export function stripDartCommentsAndStrings(source: string): string {
  const input = String(source ?? '');
  let output = '';
  let index = 0;
  const length = input.length;

  const isTriple = (quoteIndex: number, quote: string): boolean =>
    input.startsWith(quote.repeat(3), quoteIndex);

  while (index < length) {
    const char = input[index];
    const next = input[index + 1];

    // Line comment
    if (char === '/' && next === '/') {
      index += 2;
      while (index < length && input[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    // Block comment (nestable in Dart)
    if (char === '/' && next === '*') {
      let depth = 1;
      index += 2;
      while (index < length && depth > 0) {
        if (input.startsWith('/*', index)) {
          depth += 1;
          index += 2;
        } else if (input.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      output += ' ';
      continue;
    }

    // Strings (raw strings allowed): r'...', r"...", r'''...''', normal + triples.
    let raw = false;
    let stringStart = -1;
    if (char === 'r' && (next === "'" || next === '"')) {
      raw = true;
      stringStart = index + 1;
    } else if (char === "'" || char === '"') {
      stringStart = index;
    }
    if (stringStart >= 0) {
      const quote = input[stringStart];
      output += ' ';
      if (isTriple(stringStart, quote)) {
        let end = stringStart + 3;
        while (end < length && !input.startsWith(quote.repeat(3), end)) {
          if (!raw && input[end] === '\\') end += 1; // escaped char cannot end the string
          end += 1;
        }
        index = Math.min(end + 3, length);
      } else {
        let end = stringStart + 1;
        while (end < length) {
          if (!raw && input[end] === '\\') {
            end += 2;
            continue;
          }
          if (input[end] === quote) {
            end += 1;
            break;
          }
          if (input[end] === '\n') break; // unterminated
          end += 1;
        }
        index = end;
      }
      continue;
    }

    // Character literals do not exist in Dart; skip nothing else.
    output += char;
    index += 1;
  }

  return output;
}

/** True if a call to `name(` appears at brace depth 0 in stripped source. */
function findTopLevelCall(stripped: string, name: string): boolean {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])${name}\\s*\\(`, 'g');
  let depth = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped)) !== null) {
    while (cursor < match.index) {
      const ch = stripped[cursor];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth = Math.max(0, depth - 1);
      cursor += 1;
    }
    if (depth === 0) return true;
  }
  return false;
}

function findAnyCall(stripped: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${name}\\s*\\(`).test(stripped);
}

function extractDartPackageImports(source: string): string[] {
  const packages = new Set<string>();
  const pattern = /(?:import|export)\s+['"]package:([A-Za-z0-9_][\w.-]*)\//g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    packages.add(match[1]);
  }
  return [...packages].sort(compareText);
}

function extractDartPackageImportPaths(source: string): Array<{ pkg: string; rest: string }> {
  const result: Array<{ pkg: string; rest: string }> = [];
  const pattern = /(?:import|export)\s+['"]package:([A-Za-z0-9_][\w.-]*)\/([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    result.push({ pkg: match[1], rest: match[2] });
  }
  return result;
}

/* -------------------------------- Secrets -------------------------------- */

const SECRET_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{7,}/ },
  { id: 'openrouter-key', pattern: /\bsk-or-v1-[A-Za-z0-9_-]{7,}/ },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{10,}/ },
  { id: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'private-key-block', pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
];

const PLACEHOLDER_MARKERS: Array<{ marker: string; pattern: RegExp }> = [
  { marker: 'TODO: implement', pattern: /TODO:\s*implement/i },
  { marker: 'throw UnimplementedError', pattern: /throw\s+UnimplementedError\b/ },
  { marker: 'YOUR_API_KEY', pattern: /YOUR_API_KEY/i },
  { marker: 'REPLACE_ME', pattern: /REPLACE_ME/i },
  { marker: 'lorem ipsum', pattern: /lorem\s+ipsum/i },
];

function collectMatches(
  files: Map<string, string>,
  predicate: (content: string) => string | null,
): Array<{ path: string; detail: string }> {
  const hits: Array<{ path: string; detail: string }> = [];
  for (const [path, content] of files) {
    const detail = predicate(content);
    if (detail !== null) hits.push({ path, detail });
  }
  return hits.sort((a, b) => compareText(a.path, b.path));
}

const MAX_SCAN_BYTES = 2 * 1024 * 1024; // skip scanning absurdly large files

/* ------------------------------- Verifier -------------------------------- */

function check(
  checks: ContractCheck[],
  id: string,
  severity: ContractCheckSeverity,
  passed: boolean,
  message: string,
  path?: string,
): void {
  const entry: ContractCheck = { id, severity, passed, message: clip(message, 500) };
  if (path !== undefined) entry.path = path;
  checks.push(entry);
}

const SKIPPED = (what: string): string => `Skipped: ${what}.`;

/**
 * Verify the project contract. Never throws: unexpected internal errors are
 * returned as a single `contract-internal` blocker.
 */
export function verifyProjectContract(input: VerifyProjectContractInput): ProjectContractResult {
  try {
    return runContractChecks(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const internal: ContractCheck = {
      id: 'contract-internal',
      severity: 'error',
      passed: false,
      message: clip(`Contract verification failed internally: ${message}`, 500),
    };
    return { passed: false, checks: [internal], blockers: [internal] };
  }
}

function runContractChecks(input: VerifyProjectContractInput): ProjectContractResult {
  const checks: ContractCheck[] = [];
  const files = normalizeFiles(input?.files);
  const packageName = sanitizePackageName(input?.packageName) || asText(input?.packageName).trim();
  const appId = asText(input?.appId).trim();
  const expectsSupabase = Boolean(input?.expectsSupabase);
  const expectations = input?.expectations ?? {};

  /* 1. pubspec.yaml exists ------------------------------------------------ */
  const pubspecRaw = files.get('pubspec.yaml');
  const pubspec = pubspecRaw === undefined ? EMPTY_PUBSPEC : parsePubspec(pubspecRaw);
  if (pubspecRaw === undefined) {
    check(checks, 'pubspec-exists', 'error', false, 'pubspec.yaml is missing.', 'pubspec.yaml');
  } else {
    check(checks, 'pubspec-exists', 'error', true, 'pubspec.yaml exists.', 'pubspec.yaml');
  }

  /* 2. pubspec name matches packageName ------------------------------------ */
  if (!pubspec.found) {
    check(checks, 'pubspec-name-matches', 'info', true, SKIPPED('pubspec.yaml is missing'), 'pubspec.yaml');
  } else if (!pubspec.name) {
    check(checks, 'pubspec-name-matches', 'error', false, 'pubspec.yaml has no `name:` key.', 'pubspec.yaml');
  } else if (packageName && pubspec.name !== packageName) {
    check(
      checks,
      'pubspec-name-matches',
      'error',
      false,
      `pubspec.yaml name \`${pubspec.name}\` does not match the expected package name \`${packageName}\`.`,
      'pubspec.yaml',
    );
  } else {
    check(checks, 'pubspec-name-matches', 'error', true, `pubspec.yaml name matches \`${pubspec.name}\`.`, 'pubspec.yaml');
  }

  /* 3. environment: section with an sdk constraint ------------------------- */
  if (!pubspec.found) {
    check(checks, 'pubspec-environment-sdk', 'info', true, SKIPPED('pubspec.yaml is missing'), 'pubspec.yaml');
  } else if (!pubspec.hasEnvironmentSection) {
    check(checks, 'pubspec-environment-sdk', 'error', false, 'pubspec.yaml has no top-level `environment:` section.', 'pubspec.yaml');
  } else if (!pubspec.sdkConstraint) {
    check(checks, 'pubspec-environment-sdk', 'error', false, 'pubspec.yaml `environment:` section has no `sdk:` constraint.', 'pubspec.yaml');
  } else {
    check(checks, 'pubspec-environment-sdk', 'error', true, `pubspec.yaml declares sdk constraint \`${pubspec.sdkConstraint}\`.`, 'pubspec.yaml');
  }

  /* 4. flutter: section when flutter deps are declared --------------------- */
  const flutterDeclared = pubspec.found && pubspec.declared.includes('flutter');
  if (!pubspec.found) {
    check(checks, 'pubspec-flutter-section', 'info', true, SKIPPED('pubspec.yaml is missing'), 'pubspec.yaml');
  } else if (!flutterDeclared) {
    check(checks, 'pubspec-flutter-section', 'info', true, 'No `flutter` dependency declared; no `flutter:` section required.', 'pubspec.yaml');
  } else if (!pubspec.hasFlutterSection) {
    check(checks, 'pubspec-flutter-section', 'error', false, 'pubspec.yaml declares the `flutter` dependency but has no top-level `flutter:` section.', 'pubspec.yaml');
  } else {
    check(checks, 'pubspec-flutter-section', 'error', true, 'pubspec.yaml has a `flutter:` section.', 'pubspec.yaml');
  }

  /* 5. lib/main.dart exists ------------------------------------------------ */
  const mainPath = normalizeContractPath(expectations.mainPath) || 'lib/main.dart';
  const mainSource = files.get(mainPath);
  if (mainSource === undefined) {
    check(checks, 'main-exists', 'error', false, `${mainPath} is missing.`, mainPath);
  } else {
    check(checks, 'main-exists', 'error', true, `${mainPath} exists.`, mainPath);
  }

  /* 6. top-level main( and runApp( outside comments/strings ---------------- */
  const strippedMain = mainSource === undefined ? '' : stripDartCommentsAndStrings(mainSource);
  if (mainSource === undefined) {
    check(checks, 'main-top-level', 'info', true, SKIPPED(`${mainPath} is missing`), mainPath);
  } else if (findTopLevelCall(strippedMain, 'main')) {
    check(checks, 'main-top-level', 'error', true, 'Found a top-level `main(` call outside comments/strings.', mainPath);
  } else {
    check(checks, 'main-top-level', 'error', false, 'No top-level `main(` call found outside comments/strings.', mainPath);
  }

  if (mainSource === undefined) {
    check(checks, 'main-runapp', 'info', true, SKIPPED(`${mainPath} is missing`), mainPath);
  } else if (findAnyCall(strippedMain, 'runApp')) {
    check(checks, 'main-runapp', 'error', true, 'Found a `runApp(` call outside comments/strings.', mainPath);
  } else {
    check(checks, 'main-runapp', 'error', false, 'No `runApp(` call found outside comments/strings.', mainPath);
  }

  /* 7. every imported external package: is declared ------------------------- */
  const dartFiles: Array<[string, string]> = [...files.entries()].filter(([path]) => path.endsWith('.dart'));
  const importedPackages = new Set<string>();
  for (const [, content] of dartFiles) {
    for (const pkg of extractDartPackageImports(content)) importedPackages.add(pkg);
  }
  if (!pubspec.found) {
    check(checks, 'imports-declared', 'info', true, SKIPPED('pubspec.yaml is missing; imports cannot be cross-checked'), 'pubspec.yaml');
  } else {
    const declared = new Set(pubspec.declared);
    const undeclared = [...importedPackages].filter((pkg) => pkg !== packageName && !declared.has(pkg));
    if (undeclared.length > 0) {
      check(
        checks,
        'imports-declared',
        'error',
        false,
        `Imported but not declared in pubspec.yaml dependencies/dev_dependencies: ${clip(undeclared.slice(0, MAX_LISTED).join(', '), 300)}${undeclared.length > MAX_LISTED ? ` (+${undeclared.length - MAX_LISTED} more)` : ''}.`,
      );
    } else {
      check(checks, 'imports-declared', 'error', true, 'Every imported package: dependency is declared in pubspec.yaml.');
    }
  }

  /* 8. no self-package mismatch --------------------------------------------- */
  {
    const fileSet = new Set(files.keys());
    const pubspecName = pubspec.found ? pubspec.name : '';
    const mismatches: string[] = [];
    for (const [path, content] of dartFiles) {
      for (const { pkg, rest } of extractDartPackageImportPaths(content)) {
        if (pkg === packageName || (pubspecName && pkg === pubspecName)) continue;
        if (pubspec.declared.includes(pkg)) continue; // declared external dep, not a self import
        if (fileSet.has(`lib/${rest}`)) {
          mismatches.push(`${path} imports package:${pkg}/${rest}`);
        }
      }
    }
    if (mismatches.length > 0) {
      mismatches.sort(compareText);
      check(
        checks,
        'self-package-import',
        'error',
        false,
        `Import(s) resolve to this project's lib/ but use a different package name: ${clip(mismatches.slice(0, MAX_LISTED).join('; '), 350)}${mismatches.length > MAX_LISTED ? ` (+${mismatches.length - MAX_LISTED} more)` : ''}.`,
      );
    } else {
      check(checks, 'self-package-import', 'error', true, 'No self-package import mismatches found.');
    }
  }

  /* 9. no placeholder markers ------------------------------------------------ */
  {
    const hits = collectMatches(files, (content) => {
      if (content.length > MAX_SCAN_BYTES) return null;
      for (const { marker, pattern } of PLACEHOLDER_MARKERS) {
        if (pattern.test(content)) return marker;
      }
      return null;
    });
    if (hits.length > 0) {
      check(
        checks,
        'placeholders',
        'error',
        false,
        `Placeholder marker(s) found: ${clip(hits.slice(0, MAX_LISTED).map((hit) => `${hit.path} (${hit.detail})`).join('; '), 350)}${hits.length > MAX_LISTED ? ` (+${hits.length - MAX_LISTED} more)` : ''}.`,
      );
    } else {
      check(checks, 'placeholders', 'error', true, 'No placeholder markers found.');
    }
  }

  /* 10. no hardcoded secrets ------------------------------------------------- */
  {
    const hits = collectMatches(files, (content) => {
      if (content.length > MAX_SCAN_BYTES) return null;
      for (const { id, pattern } of SECRET_PATTERNS) {
        if (pattern.test(content)) return id;
      }
      return null;
    });
    if (hits.length > 0) {
      check(
        checks,
        'secrets',
        'error',
        false,
        `Possible hardcoded secret(s) found: ${clip(hits.slice(0, MAX_LISTED).map((hit) => `${hit.path} (${hit.detail})`).join('; '), 350)}${hits.length > MAX_LISTED ? ` (+${hits.length - MAX_LISTED} more)` : ''}.`,
      );
    } else {
      check(checks, 'secrets', 'error', true, 'No hardcoded secrets found.');
    }
  }

  /* 11. android applicationId matches appId ----------------------------------- */
  {
    const gradlePath = ['android/app/build.gradle', 'android/app/build.gradle.kts'].find((path) => files.has(path));
    if (!gradlePath) {
      check(checks, 'android-applicationId', 'info', true, 'No android/app/build.gradle(.kts) present; applicationId not checked.');
    } else if (!appId) {
      check(checks, 'android-applicationId', 'info', true, 'No appId provided; applicationId not checked.', gradlePath);
    } else {
      const gradle = files.get(gradlePath) ?? '';
      const match = /applicationId\s*(?:=\s*)?["']([^"']+)["']/.exec(gradle);
      if (!match) {
        check(checks, 'android-applicationId', 'error', false, `${gradlePath} does not declare an applicationId; expected \`${appId}\`.`, gradlePath);
      } else if (match[1] !== appId) {
        check(checks, 'android-applicationId', 'error', false, `${gradlePath} applicationId \`${match[1]}\` does not match expected appId \`${appId}\`.`, gradlePath);
      } else {
        check(checks, 'android-applicationId', 'error', true, `${gradlePath} applicationId matches \`${appId}\`.`, gradlePath);
      }
    }
  }

  /* 12. every assets: entry exists in the file set --------------------------- */
  if (!pubspec.found) {
    check(checks, 'pubspec-assets', 'info', true, SKIPPED('pubspec.yaml is missing'), 'pubspec.yaml');
  } else if (pubspec.assets.length === 0 && (expectations.requiredAssets?.length ?? 0) === 0) {
    check(checks, 'pubspec-assets', 'error', true, 'pubspec.yaml lists no assets.', 'pubspec.yaml');
  } else {
    const fileSet = new Set(files.keys());
    const missing: string[] = [];
    const required = expectations.requiredAssets ?? [];
    for (const entry of [...pubspec.assets, ...required]) {
      const normalized = normalizeContractPath(entry);
      if (!normalized) continue;
      if (normalized.endsWith('/')) {
        // Directory entry: at least one file must live under it.
        if (![...fileSet].some((path) => path.startsWith(normalized))) missing.push(normalized);
      } else if (!fileSet.has(normalized)) {
        missing.push(normalized);
      }
    }
    if (missing.length > 0) {
      const uniqueMissing = [...new Set(missing)].sort(compareText);
      check(
        checks,
        'pubspec-assets',
        'error',
        false,
        `Asset(s) listed in pubspec.yaml but missing from the project: ${clip(uniqueMissing.slice(0, MAX_LISTED).join(', '), 350)}${uniqueMissing.length > MAX_LISTED ? ` (+${uniqueMissing.length - MAX_LISTED} more)` : ''}.`,
        'pubspec.yaml',
      );
    } else {
      check(checks, 'pubspec-assets', 'error', true, 'Every asset listed in pubspec.yaml exists in the project.', 'pubspec.yaml');
    }
  }

  /* 13. Supabase expectations ------------------------------------------------- */
  if (expectsSupabase) {
    if (!pubspec.found) {
      check(checks, 'supabase-dependency', 'info', true, SKIPPED('pubspec.yaml is missing'), 'pubspec.yaml');
    } else if (pubspec.declared.includes('supabase') || pubspec.declared.includes('supabase_flutter')) {
      check(checks, 'supabase-dependency', 'error', true, 'pubspec.yaml declares a Supabase dependency.', 'pubspec.yaml');
    } else {
      check(checks, 'supabase-dependency', 'error', false, 'expectsSupabase is true but pubspec.yaml declares neither `supabase` nor `supabase_flutter`.', 'pubspec.yaml');
    }

    const migrationPaths = [...files.keys()]
      .filter((path) => /^supabase\/migrations\/.+\.sql$/i.test(path))
      .sort(compareText);
    if (migrationPaths.length === 0) {
      // A missing migration is a warning, never a blocker.
      check(checks, 'supabase-migrations-missing', 'warning', false, 'expectsSupabase is true but no supabase/migrations/*.sql file exists.');
    } else {
      const tableCreating = migrationPaths.filter((path) => /create\s+table/i.test(files.get(path) ?? ''));
      const missingRls = tableCreating.filter(
        (path) => !/enable\s+row\s+level\s+security/i.test(files.get(path) ?? ''),
      );
      if (missingRls.length > 0) {
        check(
          checks,
          'supabase-migrations-rls',
          'error',
          false,
          `Table-creating migration(s) without ENABLE ROW LEVEL SECURITY: ${clip(missingRls.slice(0, MAX_LISTED).join(', '), 350)}${missingRls.length > MAX_LISTED ? ` (+${missingRls.length - MAX_LISTED} more)` : ''}.`,
        );
      } else if (tableCreating.length === 0) {
        check(checks, 'supabase-migrations-rls', 'info', true, 'Migrations exist but none create tables; no RLS required.');
      } else {
        check(checks, 'supabase-migrations-rls', 'error', true, `All ${tableCreating.length} table-creating migration(s) enable row level security.`);
      }
    }
  }

  /* 14. expectations.requiredDependencies -------------------------------------- */
  if (expectations.requiredDependencies && expectations.requiredDependencies.length > 0) {
    if (!pubspec.found) {
      check(checks, 'expectations-required-dependencies', 'info', true, SKIPPED('pubspec.yaml is missing'), 'pubspec.yaml');
    } else {
      const declared = new Set(pubspec.declared);
      const missing = expectations.requiredDependencies
        .map((name) => asText(name).trim())
        .filter((name) => name && !declared.has(name));
      if (missing.length > 0) {
        check(
          checks,
          'expectations-required-dependencies',
          'error',
          false,
          `Required dependencies not declared in pubspec.yaml: ${clip([...new Set(missing)].sort(compareText).slice(0, MAX_LISTED).join(', '), 300)}.`,
          'pubspec.yaml',
        );
      } else {
        check(checks, 'expectations-required-dependencies', 'error', true, 'All expected dependencies are declared.', 'pubspec.yaml');
      }
    }
  }

  const blockers = checks.filter((entry) => !entry.passed && entry.severity === 'error').slice(0, MAX_CONTRACT_BLOCKERS);
  return { passed: blockers.length === 0, checks, blockers };
}
