/**
 * Data Models Agent — generates real, typed Dart model classes for the app.
 * This runs BEFORE frontend/backend agents so screens can import proper models.
 *
 * Determinism contract:
 * - Models are derived 1:1 from the tables in `state.dataSchema`. Class names
 *   are singularized PascalCase (`users` -> `UserModel`), files land at
 *   `lib/features/<feature>/data/models/<name>_model.dart` when a feature can
 *   be inferred from `architectureSpec.features`, otherwise at
 *   `lib/core/data/models/<name>_model.dart`. Never nests deeper.
 * - Every model is an immutable class with a const constructor, fromJson,
 *   toJson, copyWith, plain-Dart `==`/`hashCode` (no codegen dependency).
 * - Inter-model references resolve to `package:<pkg>/...` imports pointing at
 *   files in the same generation batch. `<pkg>` is the pubspec package name
 *   when one is already present in `state.generatedFiles`, else a sanitized
 *   `productBrief.appName`, falling back to `flutterforge_app` (same rule as
 *   src/agents/projectContract.ts).
 * - LLM output is only accepted for files that survive deterministic
 *   validation (balanced delimiters, no TODO/UnimplementedError, no
 *   `part of`, resolvable `package:` imports). Anything that fails to parse
 *   is replaced by a deterministic local synthesis of the file.
 */
import type {
  GateDiagnostic,
  ProjectState,
  GeneratedFile,
  TableColumn,
  TableDefinition,
} from '../orchestrator/state';
import { callLLMText, parseFilesFromLLMOutput, agentModelFor } from './llmClient';

export async function runDataModelsAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const appName = state.productBrief?.appName || 'FlutterForge App';
  const pkg = guessPackageName(state);
  const brief = state.productBrief;
  const screens = state.screenGraph?.screens || [];
  const arch = state.architectureSpec || state.architecture;
  const intake = state._intakeData as Record<string, unknown> | undefined;
  const domain = (intake?.domain as string) || 'general';
  const keyFeatures = (intake?.keyFeatures as string[]) || [];
  const needsSupabase = arch?.backendMode === 'supabase';
  const packages = arch?.packages || {};
  const jsonCodegenAllowed = Boolean(
    packages['json_serializable'] || packages['freezed'] || packages['build_runner']
  );
  const tables = state.dataSchema?.tables ?? [];
  const diagnostics: GateDiagnostic[] = [...state.diagnostics];
  const logs: string[] = [];

  const files = new Map<string, GeneratedFile>(state.generatedFiles ?? new Map());

  // ── 1. Deterministic schema-derived models (source of truth) ─────────
  const specs = buildModelSpecs(tables, arch?.features);
  for (const spec of specs) {
    putGeneratedFile(files, spec.path, 'dart', synthesizeModelContent(spec, pkg));
  }

  // ── 2. LLM augmentation (accepted only when it validates) ─────────────
  let raw = '';
  try {
    raw = await callLLMText(
      [
        {
          role: 'system',
          content: `You are a senior Dart/Flutter architect generating PRODUCTION-QUALITY model classes.

STRICT RULES:
1. Every model is an immutable Dart class with final fields and a const constructor
2. Include fromJson(Map<String, dynamic>) factory constructor
3. Include toJson() Map<String, dynamic> method
4. Include copyWith(...) method for immutable updates
5. Include == operator and hashCode override (plain Dart, Equatable-style — no package:equatable import)
6. Include toString() override
7. Use proper Dart types: String, int, double, bool, DateTime, List<T>, Map<String, dynamic>
8. DateTime fields: use DateTime.parse(json['field']) and .toIso8601String() in toJson
9. Nullable fields: use String? with json['field'] as String?
10. Enums: define as proper Dart enums with values
11. Models must be real domain objects — NOT generic "Item" or "Record"
12. Each model in its own file under lib/features/<feature>/data/models/<name>_model.dart,
    or lib/core/data/models/<name>_model.dart when the feature cannot be determined.
    Never nest deeper than one feature segment.
13. NEVER emit a \`part of\` directive, NEVER emit .g.dart / .freezed.dart content.
    Do NOT reference json_serializable, freezed or build_runner${jsonCodegenAllowed ? ' (allowed: the architecture spec declares it)' : ' (the architecture spec does NOT declare them — do not use them)'}.
14. No TODO comments, no UnimplementedError, no placeholder implementations.
15. Cross-file references to other models use: import 'package:${pkg}/<path from lib/>';
16. Do not reproduce the schema-derived models listed in the user prompt unless you can make them strictly better; the pipeline enforces its own deterministic copies for those paths.

For a ${domain} app, generate ALL domain models needed.

Output format — EXACT separator for each file:
// FILE: lib/features/<feature>/data/models/user_model.dart
\`\`\`dart
// full Dart code
\`\`\`

// FILE: lib/core/data/models/product_model.dart
\`\`\`dart
// full Dart code
\`\`\``,
        },
        {
          role: 'user',
          content: `Generate ALL Dart model classes for "${appName}" — a ${domain} app.

App description: ${brief?.oneLiner}
Key features: ${keyFeatures.join(', ')}
Screens: ${screens.map((s) => `${s.name}: ${s.purpose}`).join('; ')}
Needs Supabase: ${needsSupabase}
Package name: ${pkg}

Schema-derived models (deterministic, already generated — do not re-emit these paths):
${specs.map((s) => `- ${s.className} -> ${s.path}`).join('\n') || '(none — no tables in dataSchema)'}

Domain context: ${domain}

For a ${domain} app specifically generate models like:
${getDomainModelHints(domain)}

Also generate:
- UserModel / ProfileModel (always)
- Any model needed for each screen's data

Make models REAL and domain-specific. Each field should make sense for a real ${domain} app.
No generic "Item" or "Data" model names.`,
        },
      ],
      { model: agentModelFor('data-models'), temperature: 0.2, maxTokens: 6000 }
    );
  } catch (err) {
    console.warn('[DataModelsAgent] LLM failed, using domain fallbacks:', err);
    raw = '';
  }

  // ── 2a. Validate + stage LLM files ───────────────────────────────────
  const parsed = parseFilesFromLLMOutput(raw);
  const deterministicPaths = new Set(specs.map((s) => s.path));
  const llmAccepted = new Map<string, string>();
  for (const f of parsed) {
    const path = f.path.trim();
    const cleanContent = f.content.replace(/^```(?:dart)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    if (!isValidGeneratedPath(path) || !path.startsWith('lib/') || !/\/models\//.test(path)) {
      logs.push(`[DataModelsAgent] Skipping LLM file at invalid path ${path || '(empty)'}`);
      diagnostics.push({
        gate: 'data-models',
        level: 'info',
        file: path,
        message: `LLM emitted a file at an unusable path (${path || 'empty'}); it was skipped.`,
      });
      continue;
    }

    if (deterministicPaths.has(path)) {
      // Deterministic schema-derived model wins on path collisions.
      continue;
    }

    const validity = isValidModelContent(cleanContent);
    if (!validity.ok) {
      const spec = findSpecForPath(specs, path);
      logs.push(`[DataModelsAgent] LLM parse failed for ${path}; used deterministic fallback`);
      diagnostics.push({
        gate: 'data-models',
        level: 'info',
        file: path,
        message: `LLM output for ${path} failed validation (${validity.reason}); replaced with deterministic synthesis.`,
      });
      if (spec) {
        putGeneratedFile(files, spec.path, 'dart', synthesizeModelContent(spec, pkg));
      }
      continue;
    }

    if (llmAccepted.get(path) === cleanContent) continue; // identical duplicate — dedupe
    llmAccepted.set(path, cleanContent);
  }

  // ── 2b. Fixpoint: every package:<pkg> import must resolve ────────────
  for (let guard = 0; guard < 10; guard += 1) {
    let changed = false;
    for (const [path, content] of [...llmAccepted].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const candidates = new Set<string>([...files.keys(), ...llmAccepted.keys()]);
      const missing = unresolvedImports(content, path, candidates, pkg);
      if (missing.length === 0) continue;
      const spec = findSpecForPath(specs, path);
      logs.push(
        spec
          ? `[DataModelsAgent] LLM parse failed for ${path}; used deterministic fallback`
          : `[DataModelsAgent] Dropped LLM file ${path}: unresolved imports (${missing.join(', ')})`
      );
      diagnostics.push({
        gate: 'data-models',
        level: 'info',
        file: path,
        message: `LLM file ${path} imports ${missing.join(', ')} which do not exist in this batch.`,
      });
      llmAccepted.delete(path);
      if (spec) {
        putGeneratedFile(files, spec.path, 'dart', synthesizeModelContent(spec, pkg));
      }
      changed = true;
    }
    if (!changed) break;
  }
  for (const [path, content] of llmAccepted) {
    putGeneratedFile(files, path, 'dart', content);
  }

  // ── 3. Always ensure a base user model exists ──────────────────────────
  const hasUserLikeModel = [...files.keys()].some((k) => /\/models\/(user|profile|account)_model\.dart$/.test(k));
  if (!hasUserLikeModel) {
    const synthetic: TableDefinition = {
      name: 'users',
      enableRLS: false,
      policies: [],
      columns: [
        { name: 'id', type: 'UUID', isPrimary: true },
        { name: 'email', type: 'TEXT' },
        { name: 'full_name', type: 'TEXT', isNullable: true },
        { name: 'avatar_url', type: 'TEXT', isNullable: true },
        { name: 'created_at', type: 'TIMESTAMPTZ', defaultValue: 'NOW()' },
        { name: 'updated_at', type: 'TIMESTAMPTZ', defaultValue: 'NOW()' },
      ],
    };
    const [userSpec] = buildModelSpecs([synthetic], undefined);
    if (userSpec) {
      putGeneratedFile(files, 'lib/core/data/models/user_model.dart', 'dart', synthesizeModelContent(userSpec, pkg));
    }
  }

  // ── 4. Deterministic output ordering ───────────────────────────────────
  const sortedFiles = sortFiles(files);
  const modelFiles = [...sortedFiles.keys()].filter((k) => /\/models\/[^/]+\.dart$/.test(k));
  const modelList = modelFiles.map((k) => k.split('/').pop()?.replace('.dart', '')).filter(Boolean).join(', ');

  return {
    generatedFiles: sortedFiles,
    _modelFiles: modelFiles,
    diagnostics,
    logs: [
      ...state.logs,
      ...logs,
      `[Data Models Agent] Generated ${modelFiles.length} domain model classes: ${modelList}`,
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Package name handling — same convention as src/agents/projectContract.ts
// (pubspec name when known, sanitized appName, else flutterforge_app).
// ─────────────────────────────────────────────────────────────────────────

function sanitizePackageName(raw: string): string {
  let s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_');
  s = s.replace(/^_+|_+$/g, '').replace(/^[0-9_]+/, '');
  if (!s) return '';
  if (!/^[a-z]/.test(s)) s = `app_${s}`;
  return s.slice(0, 60);
}

function guessPackageName(state: ProjectState): string {
  const pubspec = state.generatedFiles?.get('pubspec.yaml')?.content;
  if (pubspec) {
    const match = pubspec.match(/^name\s*:\s*([^\r\n]+)/m);
    const fromPubspec = match?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
    const sanitized = sanitizePackageName(fromPubspec);
    if (sanitized) return sanitized;
  }
  return sanitizePackageName(state.productBrief?.appName ?? '') || 'flutterforge_app';
}

// ─────────────────────────────────────────────────────────────────────────
// Naming helpers
// ─────────────────────────────────────────────────────────────────────────

const SINGULAR_EXCEPTIONS = new Set([
  'series', 'species', 'news', 'information', 'equipment', 'sheep', 'fish',
  'means', 'crossroads', 'status', 'alias', 'analysis', 'basis', 'crisis',
]);

function singularizeWord(word: string): string {
  const w = word.toLowerCase();
  if (SINGULAR_EXCEPTIONS.has(w)) return w;
  if (/ies$/.test(w) && w.length > 3) return `${w.slice(0, -3)}y`;
  if (/(sses|ches|shes|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w) && !/ss$/.test(w) && w.length > 1) return w.slice(0, -1);
  return w;
}

function singularize(name: string): string {
  const parts = String(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return String(name);
  parts[parts.length - 1] = singularizeWord(parts[parts.length - 1]);
  return parts.join('_');
}

function slugify(value: string): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function toPascalCase(raw: string): string {
  const parts = String(raw).split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  if (!joined) return 'Record';
  return /^[A-Za-z]/.test(joined) ? joined : `Row${joined}`;
}

function toSnakeCase(raw: string): string {
  return String(raw)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

const DART_KEYWORDS = new Set([
  'abstract', 'as', 'assert', 'async', 'await', 'break', 'case', 'catch', 'class',
  'const', 'continue', 'covariant', 'default', 'deferred', 'do', 'dynamic', 'else',
  'enum', 'export', 'extends', 'extension', 'external', 'factory', 'false', 'final',
  'finally', 'for', 'function', 'get', 'hide', 'if', 'implements', 'import', 'in',
  'interface', 'is', 'late', 'mixin', 'new', 'null', 'on', 'operator', 'part',
  'required', 'rethrow', 'return', 'set', 'show', 'static', 'super', 'switch',
  'sync', 'this', 'throw', 'true', 'try', 'typedef', 'var', 'void', 'while', 'with',
]);

function camelCase(raw: string): string {
  const parts = String(raw).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return 'value';
  const [head, ...rest] = parts;
  let camel = head.charAt(0).toLowerCase() + head.slice(1);
  for (const part of rest) {
    camel += part.charAt(0).toUpperCase() + part.slice(1);
  }
  if (/^[0-9]/.test(camel)) camel = `n${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
  if (DART_KEYWORDS.has(camel)) camel = `${camel}Value`;
  return camel;
}

function featureForTable(tableName: string, features?: string[] | null): string | null {
  if (!features || features.length === 0) return null;
  const t = slugify(tableName);
  const tSingular = slugify(singularize(tableName));
  for (const feature of features) {
    const f = slugify(feature);
    if (!f) continue;
    const fSingular = slugify(singularize(f));
    if (f === t || f === tSingular || fSingular === t || fSingular === tSingular) return f;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Type mapping (PostgreSQL/Supabase types → Dart)
// ─────────────────────────────────────────────────────────────────────────

function scalarDartType(t: string): string {
  const s = t.toLowerCase().trim();
  if (/^(bigint|int8|integer|int|int4|int2|smallint|serial|bigserial|smallserial|oid)/.test(s)) return 'int';
  if (s === 'double precision') return 'double';
  if (/^(numeric|decimal|real|double|float|money)/.test(s)) return 'double';
  if (/^(bool|boolean)/.test(s)) return 'bool';
  if (/timestamp|timestamptz|datetime/.test(s)) return 'DateTime';
  if (s === 'date' || s === 'time' || s.startsWith('timetz')) return 'DateTime';
  if (/^(json|jsonb)/.test(s) || s.includes('json')) return 'Map<String, dynamic>';
  if (/^(uuid|text|varchar|char|character|name|citext|bpchar|inet|cidr|macaddr|bytea|xml)/.test(s)) return 'String';
  if (s.includes('bool')) return 'bool';
  if (s.includes('int') || s.includes('serial')) return 'int';
  if (/numeric|decimal|double|float|real|money/.test(s)) return 'double';
  if (s.includes('text') || s.includes('char') || s.includes('string') || s.includes('uuid')) return 'String';
  return 'String';
}

function dartTypeForColumn(typeRaw: string | undefined): string {
  const raw = String(typeRaw ?? 'text').trim();
  const lower = raw.toLowerCase();
  let base = lower;
  let isArray = false;
  if (lower.endsWith('[]')) {
    isArray = true;
    base = lower.slice(0, -2);
  } else if (lower.endsWith(' array')) {
    isArray = true;
    base = lower.slice(0, -' array'.length).trim();
  } else if (lower.startsWith('_') && lower.length > 1) {
    isArray = true;
    base = lower.slice(1);
  }
  const scalar = scalarDartType(base);
  return isArray ? `List<${scalar}>` : scalar;
}

function sqlLiteralToDart(dartBase: string, rawDefault: unknown): string | undefined {
  const v = String(rawDefault ?? '').trim();
  if (!v) return undefined;
  const single = v.replace(/^'(.*)'$/s, '$1').replace(/''/g, "'");
  const double = v.replace(/^"(.*)"$/s, '$1').replace(/""/g, '"');
  switch (dartBase) {
    case 'bool':
      if (/^(true|'true')$/i.test(v)) return 'true';
      if (/^(false|'false')$/i.test(v)) return 'false';
      if (/^'(t|f)'$/i.test(v)) return /t/i.test(v) ? 'true' : 'false';
      if (v === '0' || v === '1') return v === '1' ? 'true' : 'false';
      return undefined;
    case 'int':
      return /^-?\d+$/.test(v) ? v : undefined;
    case 'double': {
      if (!/^-?\d+(\.\d+)?$/.test(v)) return undefined;
      return v.includes('.') ? v : `${v}.0`;
    }
    case 'String':
      if (/^'(.*)'$/s.test(v)) return dartStringLiteral(single);
      if (/^"(.*)"$/s.test(v)) return dartStringLiteral(double);
      return undefined;
    case 'Map<String, dynamic>':
      if (/^\{.*\}$/s.test(v) || /^'\{.*\}'$/s.test(v) || /^"\{.*\}"$/s.test(v)) return 'const <String, dynamic>{}';
      return undefined;
    default:
      if (dartBase.startsWith('List<')) {
        const elem = dartBase.slice('List<'.length, -1);
        return `const <${elem}>[]`;
      }
      return undefined;
  }
}

function zeroLiteral(dartBase: string): string | undefined {
  switch (dartBase) {
    case 'int': return '0';
    case 'double': return '0.0';
    case 'bool': return 'false';
    case 'Map<String, dynamic>': return 'const <String, dynamic>{}';
    default:
      if (dartBase.startsWith('List<')) return `const <${dartBase.slice('List<'.length, -1)}>[]`;
      return undefined;
  }
}

function dartStringLiteral(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\$/g, '\\$')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `'${escaped}'`;
}

// ─────────────────────────────────────────────────────────────────────────
// Model specs
// ─────────────────────────────────────────────────────────────────────────

interface ModelField {
  column: TableColumn;
  field: string;
  dartBase: string;
  nullable: boolean;
  defaultLiteral?: string;
  required: boolean;
}

interface ModelRef {
  relationName: string;
  className: string;
  path: string;
  viaColumn: string;
}

interface ModelSpec {
  table: string;
  className: string;
  fileBase: string;
  path: string;
  feature: string | null;
  fields: ModelField[];
  refs: ModelRef[];
}

function referencedTableName(column: TableColumn): string | null {
  const type = String(column?.type ?? '');
  const match = type.match(/references\s+(?:(?:[A-Za-z0-9_]+)\.)?"?([A-Za-z0-9_]+)"?/i);
  if (match) return match[1];
  const name = String(column?.name ?? '').toLowerCase();
  if (name.endsWith('_id') && name !== 'id') return name.slice(0, -3);
  return null;
}

function relationNameForColumn(column: TableColumn): string {
  const raw = String(column?.name ?? '').trim();
  if (/_id$/i.test(raw) && raw.length > 3) return camelCase(raw.slice(0, -3));
  return camelCase(raw);
}

function fieldType(field: ModelField): string {
  return field.nullable ? `${field.dartBase}?` : field.dartBase;
}

function buildModelSpecs(tables: TableDefinition[], features?: string[] | null): ModelSpec[] {
  const specs: ModelSpec[] = [];
  const usedClasses = new Set<string>();
  const usedPaths = new Set<string>();

  tables.forEach((table, index) => {
    const rawTableName = String(table?.name ?? '').trim();
    if (!rawTableName) return;

    let base = toPascalCase(singularize(rawTableName));
    if (base.endsWith('Model')) base = base.slice(0, -'Model'.length) || 'Record';
    let className = `${base}Model`;
    if (usedClasses.has(className)) {
      className = `${toPascalCase(rawTableName)}Model`;
      if (usedClasses.has(className)) className = `${toPascalCase(rawTableName)}${index + 1}Model`;
    }
    usedClasses.add(className);

    const fileBase = toSnakeCase(className.slice(0, -'Model'.length)) || `table_${index + 1}`;
    const feature = featureForTable(rawTableName, features);
    let path = feature
      ? `lib/features/${feature}/data/models/${fileBase}_model.dart`
      : `lib/core/data/models/${fileBase}_model.dart`;
    if (usedPaths.has(path)) {
      let suffix = 2;
      while (usedPaths.has(path.replace(/_model\.dart$/, `_${suffix}_model.dart`))) suffix += 1;
      path = path.replace(/_model\.dart$/, `_${suffix}_model.dart`);
    }
    usedPaths.add(path);

    const fields: ModelField[] = [];
    const usedFields = new Set<string>();
    const columns = Array.isArray(table.columns) ? table.columns : [];
    for (const [colIndex, column] of columns.entries()) {
      const colName = String(column?.name ?? '').trim();
      if (!colName) continue;
      let field = camelCase(colName);
      if (usedFields.has(field)) field = `${field}${colIndex + 1}`;
      usedFields.add(field);

      const dartBase = dartTypeForColumn(column?.type);
      const nullable = column?.isNullable === true;
      const rawDefault = column?.defaultValue;
      const hasDefault = rawDefault !== undefined && String(rawDefault).trim() !== '';
      let defaultLiteral = hasDefault ? sqlLiteralToDart(dartBase, rawDefault) : undefined;
      if (hasDefault && defaultLiteral === undefined) {
        defaultLiteral = zeroLiteral(dartBase); // int/double/bool/const-container defaults
      }
      const required = !nullable && defaultLiteral === undefined;
      fields.push({
        column: { ...column, name: colName, type: String(column?.type ?? 'text') },
        field,
        dartBase,
        nullable,
        defaultLiteral,
        required,
      });
    }
    if (fields.length === 0) {
      fields.push({
        column: { name: 'id', type: 'text' },
        field: 'id',
        dartBase: 'String',
        nullable: false,
        required: true,
      });
    }

    specs.push({ table: rawTableName, className, fileBase, path, feature, fields, refs: [] });
  });

  // Second pass: inter-model references (FKs to tables in the same batch).
  for (const spec of specs) {
    const refs: ModelRef[] = [];
    const seen = new Set<string>();
    for (const field of spec.fields) {
      const target = referencedTableName(field.column);
      if (!target) continue;
      const normTarget = slugify(singularize(target));
      const match = specs.find(
        (candidate) =>
          candidate.table !== spec.table &&
          (slugify(singularize(candidate.table)) === normTarget ||
            slugify(candidate.table) === slugify(target))
      );
      if (!match) continue;
      const relationName = relationNameForColumn(field.column);
      if (!relationName || seen.has(relationName)) continue;
      if (spec.fields.some((existing) => existing.field === relationName)) continue; // no clash with a real column
      seen.add(relationName);
      refs.push({ relationName, className: match.className, path: match.path, viaColumn: field.column.name });
    }
    spec.refs = refs;
  }

  return specs;
}

function findSpecForPath(specs: ModelSpec[], path: string): ModelSpec | undefined {
  const byPath = specs.find((s) => s.path === path);
  if (byPath) return byPath;
  const base = path.split('/').pop()?.replace(/\.dart$/, '').replace(/_model$/, '') ?? '';
  if (!base) return undefined;
  return specs.find((s) => s.fileBase === base || toSnakeCase(s.className.replace(/Model$/, '')) === base);
}

// ─────────────────────────────────────────────────────────────────────────
// Deterministic model synthesis
// ─────────────────────────────────────────────────────────────────────────

function jsonValue(field: ModelField): string {
  const key = field.column.name;
  const raw = `json['${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
  const base = field.dartBase;
  const def = field.defaultLiteral;
  if (base === 'DateTime') {
    return field.nullable
      ? `${raw} == null ? null : DateTime.parse(${raw} as String)`
      : `DateTime.parse(${raw} as String)`;
  }
  if (base === 'Map<String, dynamic>') {
    const conv = `Map<String, dynamic>.from(${raw} as Map)`;
    if (field.nullable) return `${raw} == null ? null : ${conv}`;
    if (def !== undefined) return `${raw} == null ? ${def} : ${conv}`;
    return conv;
  }
  if (base.startsWith('List<')) {
    const elem = base.slice('List<'.length, -1);
    const conv = `(${raw} as List).cast<${elem}>()`;
    if (field.nullable) return `${raw} == null ? null : ${conv}`;
    if (def !== undefined) return `${raw} == null ? ${def} : ${conv}`;
    return conv;
  }
  if (base === 'int') {
    if (field.nullable) return `(${raw} as num?)?.toInt()`;
    if (def !== undefined) return `(${raw} as num?)?.toInt() ?? ${def}`;
    return `(${raw} as num).toInt()`;
  }
  if (base === 'double') {
    if (field.nullable) return `(${raw} as num?)?.toDouble()`;
    if (def !== undefined) return `(${raw} as num?)?.toDouble() ?? ${def}`;
    return `(${raw} as num).toDouble()`;
  }
  if (base === 'bool') {
    if (field.nullable) return `${raw} as bool?`;
    if (def !== undefined) return `${raw} as bool? ?? ${def}`;
    return `${raw} as bool`;
  }
  if (field.nullable) return `${raw} as ${base}?`;
  if (def !== undefined) return `${raw} as ${base}? ?? ${def}`;
  return `${raw} as ${base}`;
}

function toJsonValue(field: ModelField): string {
  if (field.dartBase === 'DateTime') {
    return field.nullable ? `${field.field}?.toIso8601String()` : `${field.field}.toIso8601String()`;
  }
  return field.field;
}

function equalityOperand(name: string, dartBase: string): string {
  if (dartBase.startsWith('List<')) return `listEquals(${name}, other.${name})`;
  if (dartBase === 'Map<String, dynamic>') return `mapEquals(${name}, other.${name})`;
  return `${name} == other.${name}`;
}

function synthesizeModelContent(spec: ModelSpec, pkg: string): string {
  const className = spec.className;
  const allNames = [...spec.fields.map((f) => f.field), ...spec.refs.map((r) => r.relationName)];

  const lines: string[] = [
    `import 'package:flutter/foundation.dart';`,
    ...spec.refs.map((ref) => `import 'package:${pkg}/${ref.path.replace(/^lib\//, '')}';`),
    ``,
    `/// Immutable model for the \`${spec.table}\` table.`,
    `@immutable`,
    `class ${className} {`,
  ];

  for (const field of spec.fields) {
    lines.push(`  final ${fieldType(field)} ${field.field};`);
  }
  for (const ref of spec.refs) {
    lines.push(`  /// Hydrated join payload for the \`${ref.viaColumn}\` relation, when present.`);
    lines.push(`  final ${ref.className}? ${ref.relationName};`);
  }

  lines.push(``);
  lines.push(`  const ${className}({`);
  for (const field of spec.fields) {
    if (field.nullable) lines.push(`    this.${field.field},`);
    else if (field.defaultLiteral !== undefined) lines.push(`    this.${field.field} = ${field.defaultLiteral},`);
    else lines.push(`    required this.${field.field},`);
  }
  for (const ref of spec.refs) {
    lines.push(`    this.${ref.relationName},`);
  }
  lines.push(`  });`);

  lines.push(``);
  lines.push(`  factory ${className}.fromJson(Map<String, dynamic> json) {`);
  lines.push(`    return ${className}(`);
  for (const field of spec.fields) {
    lines.push(`      ${field.field}: ${jsonValue(field)},`);
  }
  for (const ref of spec.refs) {
    lines.push(
      `      ${ref.relationName}: json['${ref.relationName}'] == null ? null : ${ref.className}.fromJson(Map<String, dynamic>.from(json['${ref.relationName}'] as Map)),`
    );
  }
  lines.push(`    );`);
  lines.push(`  }`);

  lines.push(``);
  lines.push(`  Map<String, dynamic> toJson() => {`);
  for (const field of spec.fields) {
    lines.push(`    '${field.column.name}': ${toJsonValue(field)},`);
  }
  for (const ref of spec.refs) {
    lines.push(`    if (${ref.relationName} != null) '${ref.relationName}': ${ref.relationName}!.toJson(),`);
  }
  lines.push(`  };`);

  lines.push(``);
  lines.push(`  ${className} copyWith({`);
  for (const field of spec.fields) {
    lines.push(`    ${field.dartBase}? ${field.field},`);
  }
  for (const ref of spec.refs) {
    lines.push(`    ${ref.className}? ${ref.relationName},`);
  }
  lines.push(`  }) {`);
  lines.push(`    return ${className}(`);
  for (const field of spec.fields) {
    lines.push(`      ${field.field}: ${field.field} ?? this.${field.field},`);
  }
  for (const ref of spec.refs) {
    lines.push(`      ${ref.relationName}: ${ref.relationName} ?? this.${ref.relationName},`);
  }
  lines.push(`    );`);
  lines.push(`  }`);

  const equalsList = allNames
    .map((name) => {
      const field = spec.fields.find((f) => f.field === name);
      return equalityOperand(name, field?.dartBase ?? 'ref');
    })
    .join(' &&\n          ');
  lines.push(``);
  lines.push(`  @override`);
  lines.push(`  bool operator ==(Object other) =>`);
  lines.push(`      identical(this, other) ||`);
  lines.push(`      other is ${className} &&`);
  lines.push(`          runtimeType == other.runtimeType &&`);
  lines.push(`          ${equalsList};`);
  lines.push(``);
  lines.push(`  @override`);
  lines.push(`  int get hashCode => Object.hashAll([${allNames.join(', ')}]);`);

  const toStringParts = allNames.map((name) => `${name}: $${name}`).join(', ');
  lines.push(``);
  lines.push(`  @override`);
  lines.push(`  String toString() => '${className}(${toStringParts})';`);
  lines.push(`}`);
  lines.push(``);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// Output validation & hygiene
// ─────────────────────────────────────────────────────────────────────────

function stripCommentsOnly(src: string): string {
  let out = src;
  let prev = out;
  do {
    prev = out;
    out = out.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  } while (out !== prev);
  return out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function stripCommentsAndStrings(src: string): string {
  return stripCommentsOnly(src).replace(
    /r?'''[\s\S]*?'''|r?"""[\s\S]*?"""|r?'(?:\\.|[^'\\\n])*'|r?"(?:\\.|[^"\\\n])*"/g,
    (m) => ' '.repeat(m.length)
  );
}

function hasUnterminatedString(src: string): boolean {
  const s = stripCommentsOnly(src);
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch !== "'" && ch !== '"') {
      i += 1;
      continue;
    }
    const triple = s.startsWith(ch.repeat(3), i);
    const quote = triple ? ch.repeat(3) : ch;
    let j = i + quote.length;
    let closed = false;
    while (j < s.length) {
      const cj = s[j];
      if (!triple && cj === '\\') {
        j += 2;
        continue;
      }
      if (s.startsWith(quote, j)) {
        closed = true;
        j += quote.length;
        break;
      }
      if (!triple && (cj === '\n' || cj === '\r')) break;
      j += 1;
    }
    if (!closed) return true;
    i = j;
  }
  return false;
}

function validateDartSource(content: string): { ok: boolean; reason: string } {
  if (!content || content.trim().length < 20) return { ok: false, reason: 'empty output' };
  if (/\b(TODO|FIXME|XXX)\b/.test(content)) return { ok: false, reason: 'contains a TODO marker' };
  if (content.includes('UnimplementedError')) return { ok: false, reason: 'contains UnimplementedError' };
  if (/^\s*part\s+of\b/m.test(content)) return { ok: false, reason: 'contains a `part of` directive' };
  if (hasUnterminatedString(content)) return { ok: false, reason: 'unterminated string literal' };

  const stripped = stripCommentsAndStrings(content);
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  for (const ch of stripped) {
    if (ch === '{') braces += 1;
    else if (ch === '}') {
      braces -= 1;
      if (braces < 0) return { ok: false, reason: 'unbalanced braces' };
    } else if (ch === '(') parens += 1;
    else if (ch === ')') {
      parens -= 1;
      if (parens < 0) return { ok: false, reason: 'unbalanced parentheses' };
    } else if (ch === '[') brackets += 1;
    else if (ch === ']') {
      brackets -= 1;
      if (brackets < 0) return { ok: false, reason: 'unbalanced brackets' };
    }
  }
  if (braces !== 0 || parens !== 0 || brackets !== 0) {
    return { ok: false, reason: `unbalanced delimiters (braces ${braces}, parens ${parens}, brackets ${brackets})` };
  }
  return { ok: true, reason: 'ok' };
}

function isValidModelContent(content: string): { ok: boolean; reason: string } {
  const base = validateDartSource(content);
  if (!base.ok) return base;
  if (!/\bclass\s+[A-Za-z_][A-Za-z0-9_]*\b/.test(content)) return { ok: false, reason: 'no class declaration' };
  for (const required of ['fromJson', 'toJson', 'copyWith', 'operator ==', 'hashCode'] as const) {
    if (!content.includes(required)) return { ok: false, reason: `missing ${required}` };
  }
  return { ok: true, reason: 'ok' };
}

function isValidGeneratedPath(path: string): boolean {
  return (
    /^lib\/[A-Za-z0-9_.\-/]+\.dart$/.test(path) &&
    !path.includes('..') &&
    !path.includes('//') &&
    !/\s/.test(path)
  );
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

/** Import/export URIs in `content` that do not resolve against `candidates`. */
function unresolvedImports(
  content: string,
  filePath: string,
  candidates: Set<string>,
  pkg: string
): string[] {
  const missing: string[] = [];
  const re = /(?:import|export)\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const uri = match[1];
    if (uri.startsWith('dart:')) continue;
    if (uri.startsWith(`package:${pkg}/`)) {
      const target = `lib/${uri.slice(`package:${pkg}/`.length)}`;
      if (!candidates.has(target)) missing.push(uri);
      continue;
    }
    if (uri.startsWith('package:')) continue; // external dependency — assumed installed
    const dir = filePath.split('/').slice(0, -1).join('/');
    const resolved = normalizePosix(`${dir}/${uri}`);
    if (candidates.has(resolved)) continue;
    if (!resolved.endsWith('.dart') && candidates.has(`${resolved}.dart`)) continue;
    if (candidates.has(`${resolved}/index.dart`)) continue;
    missing.push(uri);
  }
  return missing;
}

function putGeneratedFile(
  files: Map<string, GeneratedFile>,
  path: string,
  language: string,
  content: string
): 'created' | 'modified' | 'kept' {
  const existing = files.get(path);
  if (existing && existing.content === content) return 'kept'; // identical output — never emit twice
  files.set(path, {
    path,
    content,
    action: existing ? 'modified' : 'created',
    language,
  });
  return existing ? 'modified' : 'created';
}

function sortFiles(files: Map<string, GeneratedFile>): Map<string, GeneratedFile> {
  return new Map([...files.entries()].sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1)));
}

// ─────────────────────────────────────────────────────────────────────────
// LLM prompt helpers
// ─────────────────────────────────────────────────────────────────────────

function getDomainModelHints(domain: string): string {
  const hints: Record<string, string> = {
    ecommerce: `- ProductModel (id, name, description, price, imageUrl, category, rating, stockCount, isFavorite)
- CartItemModel (product, quantity, totalPrice)
- OrderModel (id, items, totalAmount, status, createdAt, deliveryAddress)
- CategoryModel (id, name, iconUrl, productCount)
- ReviewModel (id, userId, productId, rating, comment, createdAt)
- AddressModel (id, street, city, state, country, zipCode, isDefault)`,
    fitness: `- WorkoutModel (id, name, description, duration, caloriesBurned, exercises, difficulty)
- ExerciseModel (id, name, sets, reps, weight, restSeconds, muscleGroup, imageUrl)
- WorkoutLogModel (id, workoutId, completedAt, actualDuration, notes)
- GoalModel (id, type, targetValue, currentValue, deadline, isCompleted)
- NutritionModel (id, name, calories, protein, carbs, fats, servingSize)
- StreakModel (currentStreak, longestStreak, lastWorkoutDate)`,
    tasks: `- TaskModel (id, title, description, priority, status, dueDate, tags, assigneeId, projectId)
- ProjectModel (id, name, description, color, memberIds, taskCount, completedCount)
- TagModel (id, name, color)
- CommentModel (id, taskId, userId, content, createdAt)
- SubtaskModel (id, taskId, title, isCompleted)`,
    social: `- PostModel (id, userId, content, imageUrls, likesCount, commentsCount, createdAt, isLiked)
- UserProfileModel (id, username, fullName, bio, avatarUrl, followersCount, followingCount, postsCount)
- CommentModel (id, postId, userId, content, likesCount, createdAt)
- NotificationModel (id, type, fromUserId, postId, message, isRead, createdAt)
- MessageModel (id, senderId, receiverId, content, imageUrl, sentAt, isRead)`,
    finance: `- TransactionModel (id, amount, type, category, note, date, accountId, isRecurring)
- AccountModel (id, name, type, balance, currency, color, icon)
- CategoryModel (id, name, icon, color, budget, spent, type)
- BudgetModel (id, categoryId, amount, spent, period, startDate, endDate)
- GoalModel (id, name, targetAmount, currentAmount, deadline, icon)
- RecurringModel (id, transactionTemplate, frequency, nextDate, isActive)`,
    food: `- RecipeModel (id, name, description, imageUrl, ingredients, steps, cookTime, servings, calories, rating)
- IngredientModel (name, amount, unit)
- MealPlanModel (id, date, breakfast, lunch, dinner, snacks)
- RestaurantModel (id, name, cuisine, rating, deliveryTime, minOrder, imageUrl)
- OrderModel (id, restaurantId, items, totalAmount, status, estimatedTime)`,
    music: `- TrackModel (id, title, artist, album, duration, imageUrl, audioUrl, genre, isFavorite)
- AlbumModel (id, title, artist, year, imageUrl, tracks, totalDuration)
- PlaylistModel (id, name, tracks, createdBy, isPublic, imageUrl)
- ArtistModel (id, name, imageUrl, monthlyListeners, genres, albums)`,
    travel: `- TripModel (id, destination, startDate, endDate, budget, notes, itinerary, coverImageUrl)
- ItineraryItemModel (id, tripId, day, time, activity, location, notes)
- HotelModel (id, name, location, rating, pricePerNight, imageUrl, amenities)
- FlightModel (id, from, to, departureTime, arrivalTime, airline, price, seatClass)
- PackingItemModel (id, tripId, name, category, isPacked)`,
    education: `- CourseModel (id, title, instructor, description, imageUrl, duration, lessons, rating, enrolled)
- LessonModel (id, courseId, title, duration, videoUrl, isCompleted, order)
- QuizModel (id, lessonId, questions)
- QuestionModel (id, text, options, correctIndex, explanation)
- ProgressModel (courseId, completedLessons, totalLessons, lastAccessedAt)`,
    general: `- ItemModel (id, title, description, imageUrl, createdAt, updatedAt, isActive)
- CategoryModel (id, name, icon, color, itemCount)
- NotificationModel (id, title, body, type, isRead, createdAt)
- SettingsModel (theme, language, notifications, biometrics)`,
  };
  return hints[domain] || hints['general'];
}
