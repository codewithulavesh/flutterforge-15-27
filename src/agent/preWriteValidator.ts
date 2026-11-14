/**
 * preWriteValidator — fix the failure classes LLMs produce BEFORE the files
 * are written to the project or the compiler can ever see them.
 *
 * Covers the classes we actually hit in production:
 *  1. pubspec.yaml `name:` that is not a valid Dart package name
 *  2. `description:` plain scalars containing `: `, `#`, quotes … → YAML parse error
 *  3. `package:<hallucinated>/…` imports that don't resolve to any file
 *  4. Imports of real packages missing from `dependencies:` (provider, go_router, …)
 *  5. Missing `dependencies:` / `environment:` / `flutter:` sections
 *
 * Deterministic only: fixes it cannot make confidently are reported as
 * issues, never guessed.
 */

export interface ValidationFix {
  path: string;
  content: string;
  message: string;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface PreWriteValidation {
  /** Files whose content changed (fixes to apply/save). */
  fixes: ValidationFix[];
  /** Problems that could not be fixed deterministically. */
  issues: ValidationIssue[];
  /** Short human-readable change summary, suitable for logs. */
  changes: string[];
  /** Deterministic artifact gate — passed:false means "do not build this". */
  gate: { passed: boolean; blockers: string[] };
}

interface FileLike {
  path: string;
  content: string | null;
}

const DART_NAME = /^[a-z][a-z0-9_]*$/;

const PROTO_PACKAGES = new Set([
  'flutter', 'dart', 'sky_engine', 'cupertino_icons',
  'flutter_test', 'flutter_lints', 'meta',
  'collection', 'vector_math', 'characters', 'material_color_utilities',
]);

/** Known pub.dev packages and sane caret ranges (Aug 2026 stable). */
const KNOWN_VERSIONS: Record<string, string> = {
  provider: '^6.1.2', flutter_riverpod: '^2.6.1',
  flutter_bloc: '^8.1.6', bloc: '^8.1.4', get: '^4.6.6',
  go_router: '^14.6.2', dio: '^5.7.0', http: '^1.2.2',
  supabase_flutter: '^2.9.0', supabase: '^2.9.0', postgres: '^3.4.5',
  intl: '^0.20.2', shared_preferences: '^2.3.3', sqflite: '^2.4.1',
  uuid: '^4.5.1', path: '^1.9.0', path_provider: '^2.1.5',
  fl_chart: '^0.70.0', cached_network_image: '^3.4.1', google_fonts: '^6.2.1',
  shimmer: '^3.0.0', flutter_svg: '^2.0.17', animations: '^2.0.11',
  url_launcher: '^6.3.1', share_plus: '^10.1.2', image_picker: '^1.1.2',
  flutter_secure_storage: '^9.2.3', connectivity_plus: '^6.1.1',
  permission_handler: '^11.3.1', rxdart: '^0.28.0', flutter_screenutil: '^5.9.3',
  dio_cache_interceptor: '^3.5.1', jwt_decoder: '^2.0.1', equatable: '^2.0.7',
  fluttertoast: '^8.2.12', flutter_local_notifications: '^18.0.1',
  google_sign_in: '^6.2.2', firebase_core: '^3.10.0', firebase_auth: '^5.4.0',
  cloud_firestore: '^5.6.1', flutter_hooks: '^0.21.2', hive: '^2.2.3',
  hive_flutter: '^1.1.0', drift: '^2.21.0', freezed_annotation: '^2.4.4',
  json_annotation: '^4.9.0', dio_http_cache: '^0.3.0', flutter_spinkit: '^5.2.1',
  smooth_page_indicator: '^1.2.0+3', pin_code_fields: '^8.0.1',
};

const YAML_KEY_VALUE = /^([A-Za-z0-9_-]+)\s*:/;
const PUBSPEC_PACKAGE = /^([A-Za-z0-9_]+)\s*:/;

/**
 * Strip comments and string literals before delimiter counting.
 * Truncation (an LLM stopping mid-expression) leaves unbalanced
 * braces/parens — counting the stripped text catches it deterministically.
 */
export function stripCommentsAndStrings(src: string): string {
  let out = src;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  } while (out !== prev); // Dart allows nested block comments — repeat to fixed point
  return out
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/r?'''[\s\S]*?'''|r?"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, (m) => ' '.repeat(m.length));
}

/** Count of unbalanced `{` vs `}` etc.; non-zero = truncated/unparseable output. */
export function delimiterImbalance(src: string): { braces: number; parens: number; brackets: number } {
  const stripped = stripCommentsAndStrings(src);
  const count = (a: string, b: string) => {
    let depth = 0;
    for (const ch of stripped) {
      if (ch === a) depth += 1;
      else if (ch === b) depth -= 1;
    }
    return Math.abs(depth);
  };
  return {
    braces: count('{', '}'),
    parens: count('(', ')'),
    brackets: count('[', ']'),
  };
}

function sanitizePackageName(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
  s = s.replace(/^_+|_+$/g, '');
  s = s.replace(/^[0-9_]+/, '');
  if (!s) s = 'app';
  if (!/^[a-z]/.test(s)) s = `app_${s}`;
  return s.slice(0, 60);
}

export function pubspecPackageName(yamlText: string): string | null {
  const match = yamlText.match(/^name\s*:\s*([^\r\n]+)/m);
  if (!match) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, '') || null;
}

export function declaredDependencies(yamlText: string): Set<string> {
  const deps = new Set<string>();
  let section: 'deps' | null = null;
  for (const raw of yamlText.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const isTopLevel = /^[A-Za-z0-9_-]+\s*:/.test(raw);
    if (/^(dependencies|dev_dependencies)\s*:/.test(trimmed)) {
      section = 'deps';
      continue;
    }
    if (isTopLevel && /:/.test(raw)) {
      section = null;
      continue;
    }
    if (section) {
      // Only direct children of dependencies: (indent ≥ 2), skip `sdk:` etc.
      const indent = raw.match(/^\s*/)![0].length;
      if (indent >= 2 && indent < 4) {
        const m = trimmed.match(PUBSPEC_PACKAGE);
        if (m && m[1] !== 'sdk') deps.add(m[1]);
      }
    }
  }
  return deps;
}

/** Quote a `description:` value when it would not survive a YAML parse. */
function fixDescriptionLine(line: string): string {
  const match = line.match(/^(\s*)description\s*:\s*(.*)$/);
  if (!match) return line;
  const [, indent, rawValue] = match;
  const value = rawValue.trim();
  if (!value) return line;
  if (/^['"].*['"]$/.test(value)) return line; // already quoted
  // Plain scalars cannot contain ": " or " #"; quote conservatively otherwise.
  if (/^[A-Za-z0-9 .,'_()@&%/-]+$/.test(value) && !value.includes(': ') && !value.includes(' #')) {
    return line;
  }
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${indent}description: "${escaped}"`;
}

/** Insert `flutter:\n  uses-material-design: true` if absent. */
function ensureFlutterSection(yamlText: string): { text: string; changed: boolean } {
  if (/^flutter\s*:/m.test(yamlText)) return { text: yamlText, changed: false };
  return { text: `${yamlText.trimEnd()}\n\nflutter:\n  uses-material-design: true\n`, changed: true };
}

/** Insert `environment:\n  sdk: '>=3.0.0 <4.0.0'` if absent. */
function ensureEnvironment(yamlText: string): { text: string; changed: boolean } {
  if (/^environment\s*:/m.test(yamlText) && /^\s{2}sdk\s*:/m.test(yamlText)) {
    return { text: yamlText, changed: false };
  }
  return { text: `${yamlText.trimEnd()}\n\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n`, changed: true };
}

/** Simple YAML dependency insertion: add lines directly under `dependencies:`. */
function insertDependencies(yamlText: string, entries: Array<[string, string]>): { text: string; changed: boolean } {
  if (entries.length === 0) return { text: yamlText, changed: false };
  const lines = yamlText.split('\n');
  const depIdx = lines.findIndex((l) => /^dependencies\s*:/.test(l) && !/^\s/.test(l));
  if (depIdx === -1) {
    return {
      text: `${yamlText.trimEnd()}\n\ndependencies:\n  flutter:\n    sdk: flutter\n${entries.map(([name, version]) => `  ${name}: ${version}`).join('\n')}\n`,
      changed: true,
    };
  }
  // Ensure the flutter SDK dependency exists inside dependencies:
  const sectionEnd = lines.findIndex((l, i) => i > depIdx && /^[A-Za-z]/.test(l) && /:/.test(l));
  const end = sectionEnd === -1 ? lines.length : sectionEnd;
  const section = lines.slice(depIdx, end).join('\n');
  const hasFlutter = /^\s{2}flutter\s*:/m.test(section);
  const block = [
    ...(hasFlutter ? [] : ['  flutter:', '    sdk: flutter']),
    ...entries.map(([name, version]) => `  ${name}: ${version}`),
  ];
  const next = [...lines.slice(0, depIdx + 1), ...block, ...lines.slice(depIdx + 1)];
  return { text: next.join('\n'), changed: true };
}

export function validateProjectFiles(
  files: FileLike[],
  baseFiles: Array<{ path: string; content: string }> = [],
): PreWriteValidation {
  const fixes: ValidationFix[] = [];
  const issues: ValidationIssue[] = [];
  const changes: string[] = [];

  const fileMap = new Map<string, { path: string; content: string; source: 'changed' | 'base' }>();
  for (const f of baseFiles) {
    if (f.path.endsWith('/') || f.content === null) continue;
    fileMap.set(f.path, { path: f.path, content: f.content, source: 'base' });
  }
  for (const f of files) {
    if (f.content === null || f.path.endsWith('/')) continue;
    fileMap.set(f.path, { path: f.path, content: f.content, source: 'changed' });
  }

  const pubspecFile = [...fileMap.values()].find((f) => f.path === 'pubspec.yaml');
  const allDart = [...fileMap.values()].filter((f) => f.path.endsWith('.dart'));

  /* ── 1. pubspec.yaml repairs ─────────────────────────────────── */
  let pubspecText = pubspecFile?.content ?? null;
  if (pubspecFile && pubspecText !== null) {
    let text = pubspecText;

    // 1a. `name:` must be a valid Dart package name
    const rawName = pubspecPackageName(text);
    let appName = rawName;
    if (rawName && !DART_NAME.test(rawName)) {
      appName = sanitizePackageName(rawName);
      text = text.replace(/^name\s*:.*$/m, `name: ${appName}`);
      changes.push(`pubspec name '${rawName}' → '${appName}'`);
    }

    // 1b. `description:` plain scalars that break the YAML parser
    const descFixed = text
      .split('\n')
      .map(fixDescriptionLine)
      .join('\n');
    if (descFixed !== text) {
      changes.push('quoted unsafe description value');
      text = descFixed;
    }

    // 1c. Structural: ensure environment + flutter sections exist
    const env = ensureEnvironment(text);
    if (env.changed) {
      changes.push('added environment.sdk');
      text = env.text;
    }
    const flutterSection = ensureFlutterSection(text);
    if (flutterSection.changed) {
      changes.push('added flutter uses-material-design');
      text = flutterSection.text;
    }

    if (text !== pubspecText) {
      fixes.push({ path: 'pubspec.yaml', content: text, message: 'pubspec.yaml repaired' });
      pubspecText = text;
    }
  }

  const appName = pubspecText !== null ? pubspecPackageName(pubspecText) : null;
  const declared = pubspecText !== null ? declaredDependencies(pubspecText) : new Set<string>();

  /* ── 2. Import rewrites + dependency inference ────────────────── */
  const importRe = /(package:)([A-Za-z0-9_]+)(\/[^'"\s]+)/g;
  const depsToAdd: Array<[string, string]> = [];

  for (const file of allDart) {
    const content = file.content;
    let next = content;
    const rewritten: string[] = [];
    const missing: string[] = [];

    next = next.replace(importRe, (whole, prefix, pkg, rest) => {
      if (declared.has(pkg) || PROTO_PACKAGES.has(pkg)) return whole;
      if (appName && pkg === appName) return whole;

      if (pkg in KNOWN_VERSIONS) {
        if (!depsToAdd.some(([name]) => name === pkg)) {
          depsToAdd.push([pkg, KNOWN_VERSIONS[pkg]]);
        }
        return whole;
      }
      if (appName) {
        rewritten.push(pkg);
        return `${prefix}${appName}${rest}`;
      }
      missing.push(pkg);
      return whole;
    });

    if (rewritten.length > 0 || missing.length > 0) {
      if (rewritten.length > 0) {
        fixes.push({ path: file.path, content: next, message: `rewrote imports package:${[...new Set(rewritten)].join('/')} → package:${appName}` });
      }
      for (const pkg of [...new Set(missing)]) {
        issues.push({ path: file.path, message: `imports package:${pkg} which is not a known package and not in dependencies` });
      }
    } else if (next !== content) {
      fixes.push({ path: file.path, content: next, message: 'rewrote imports' });
    }

    file.content = next; // keep the working copy consistent for step 3
  }

  /* ── 3. App-namespace imports must resolve to real files ──────── */
  if (appName) {
    const libPaths = new Set(allDart.map((f) => f.path));
    for (const file of allDart) {
      const importMatches = [...file.content.matchAll(importRe)];
      let next = file.content;
      const fixesHere: string[] = [];
      for (const match of importMatches) {
        const [, , pkg, rawRel] = match;
        if (pkg !== appName) continue;
        const rel = rawRel.replace(/^\/+/, '');
        const libPath = `lib/${rel}`;
        if (libPaths.has(libPath)) continue;
        // Resolve against the closest match elsewhere in lib/, best tier wins
        const stem = (libPath.split('/').pop() ?? '').replace(/\.dart$/, '');
        const stemMatches = (p: string) => {
          const base = (p.split('/').pop() ?? '').replace(/\.dart$/, '');
          if (base === stem) return 3;
          if (base.endsWith(`_${stem}`) || stem.endsWith(`_${base}`)) return 2;
          if (base.includes(stem) || stem.includes(base)) return 1;
          return 0;
        };
        const scored = [...libPaths]
          .map((path) => [path, stemMatches(path)] as const)
          .filter(([, score]) => score > 0)
          .sort(([, a], [, b]) => b - a);
        const bestTier = scored[0]?.[1] ?? 0;
        const candidates = scored.filter(([, score]) => score === bestTier);
        if (candidates.length === 1) {
          const candidate = candidates[0][0];
          next = next.split(`package:${appName}/${rel}`).join(`package:${appName}/${candidate.replace(/^lib\//, '')}`);
          fixesHere.push(`${libPath} → ${candidate}`);
        } else {
          issues.push({ path: file.path, message: `import 'package:${appName}/${rel}' does not resolve to any file in the project` });
        }
      }
      if (fixesHere.length > 0 && next !== file.content) {
        fixes.push({ path: file.path, content: next, message: `fixed unresolved imports: ${fixesHere.join(', ')}` });
        file.content = next;
      }
    }
  }

  /* ── 4. Inject missing known dependencies into pubspec.yaml ───── */
  if (pubspecText !== null && depsToAdd.length > 0) {
    const { text, changed } = insertDependencies(pubspecText, depsToAdd);
    if (changed) {
      changes.push(`added dependencies: ${depsToAdd.map(([name]) => name).join(', ')}`);
      // Replace the pubspec fix (if any) with the fuller one.
      const existing = fixes.find((fix) => fix.path === 'pubspec.yaml');
      if (existing) existing.content = text;
      else fixes.push({ path: 'pubspec.yaml', content: text, message: 'dependencies injected from imports' });
    }
  }

  /* ── 5. Sanity: is lib/main.dart present? ─────────────────────── */
  if (!allDart.some((f) => f.path === 'lib/main.dart') && files.some((f) => f.path === 'pubspec.yaml')) {
    issues.push({ path: 'lib/main.dart', message: 'lib/main.dart is missing — the build will not produce a runnable app' });
  }

  /* ── 6. Deterministic artifact gate ────────────────────────────── */
  const blockers: string[] = [];

  if (pubspecText === null && files.some((f) => f.path === 'pubspec.yaml')) {
    blockers.push('pubspec.yaml could not be repaired');
  } else if (pubspecText !== null && !pubspecPackageName(pubspecText)) {
    blockers.push('pubspec.yaml has no valid package name after repair');
  } else if (pubspecText !== null && !/^(dependencies|dev_dependencies)\s*:/m.test(pubspecText)) {
    blockers.push('pubspec.yaml has no dependencies: section even after repair');
  }

  if (files.some((f) => f.path === 'pubspec.yaml') && !allDart.some((f) => f.path === 'lib/main.dart')) {
    blockers.push('lib/main.dart is missing — a Flutter app cannot build without an entrypoint');
  }

  for (const issue of issues) {
    if (/does not resolve to any file/.test(issue.message)) {
      blockers.push(`${issue.path}: ${issue.message}`);
    }
  }

  for (const file of allDart) {
    const { braces, parens, brackets } = delimiterImbalance(file.content);
    if (braces || parens || brackets) {
      blockers.push(
        `${file.path}: unbalanced delimiters (braces=${braces}, parens=${parens}, brackets=${brackets}) — output looks truncated`,
      );
    }
  }

  return { fixes, issues, changes, gate: { passed: blockers.length === 0, blockers } };
}
