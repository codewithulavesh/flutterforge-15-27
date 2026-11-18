/**
 * Emitter shared kernel — naming, Dart type mapping, literal escaping, spec
 * validation and file-set integrity. Owned by the CTO: emitters MUST NOT
 * duplicate or fork these rules, otherwise layers drift and the assembled
 * project stops compiling.
 */
import type {
  AppSpec,
  DesignSpec,
  EntitySpec,
  FieldSpec,
  GeneratedFile,
  ScreenSpec,
  SpecValidation,
} from '../contracts.js';
import { SCREEN_KINDS } from '../contracts.js';

// ── naming ────────────────────────────────────────────────────────────────

const IRREGULAR: Record<string, string> = {
  Person: 'People',
  Child: 'Children',
  Category: 'Categories',
  Activity: 'Activities',
  Company: 'Companies',
  Story: 'Stories',
  Entry: 'Entries',
  Series: 'Series',
  Analysis: 'Analyses',
  Status: 'Statuses',
};

export function words(raw: string): string[] {
  return String(raw ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function pascal(raw: string): string {
  return words(raw)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
}

export function camel(raw: string): string {
  const p = pascal(raw);
  return p ? p.charAt(0).toLowerCase() + p.slice(1) : '';
}

export function snake(raw: string): string {
  return words(raw)
    .map((part) => part.toLowerCase())
    .join('_');
}

export function kebab(raw: string): string {
  return snake(raw).replace(/_/g, '-');
}

export function pluralize(raw: string): string {
  const pascalName = pascal(raw);
  if (IRREGULAR[pascalName]) return IRREGULAR[pascalName];
  const lower = raw.toLowerCase();
  if (/(s|x|z|ch|sh)$/.test(lower)) return `${pascalName}es`;
  if (/[^aeiou]y$/.test(lower)) return `${pascalName.slice(0, -1)}ies`;
  return `${pascalName}s`;
}

export function entityVar(entity: EntitySpec): string {
  return camel(entity.plural);
}

export function entityClass(entity: EntitySpec): string {
  return pascal(entity.name);
}

export function controllerClass(entity: EntitySpec): string {
  return `${entityClass(entity)}Controller`;
}

export function repositoryClass(entity: EntitySpec): string {
  return `${entityClass(entity)}Repository`;
}

export function screenClass(screen: ScreenSpec): string {
  return `${pascal(screen.id)}Page`;
}

export function screenFile(screen: ScreenSpec): string {
  return `lib/features/${snake(screen.id)}/${snake(screen.id)}_page.dart`;
}

export function modelFile(entity: EntitySpec): string {
  return `lib/data/models/${snake(entity.name)}.dart`;
}

export function repositoryFile(entity: EntitySpec): string {
  return `lib/data/repositories/${snake(entity.name)}_repository.dart`;
}

export function controllerFile(entity: EntitySpec): string {
  return `lib/state/${snake(entity.name)}_controller.dart`;
}

export function seedFile(entity: EntitySpec): string {
  return `lib/data/seed/${snake(entity.name)}_seed.dart`;
}

/** Stable route for a screen, tolerant of missing leading slash. */
export function routeOf(screen: ScreenSpec): string {
  const route = String(screen.route ?? '').trim();
  return route.startsWith('/') ? route : `/${route}`;
}

/** True when the route is a detail/form screen that needs an `entityId`. */
export function screenNeedsId(screen: ScreenSpec): boolean {
  return screen.kind === 'detail' || screen.kind === 'form';
}

// ── Dart type mapping ─────────────────────────────────────────────────────

export function dartType(field: FieldSpec): string {
  const base = (() => {
    switch (field.type) {
      case 'int':
        return 'int';
      case 'double':
        return 'double';
      case 'bool':
        return 'bool';
      case 'datetime':
        return 'DateTime';
      case 'stringList':
        return 'List<String>';
      case 'relation':
        return 'String';
      case 'enum':
      case 'text':
      case 'string':
      default:
        return 'String';
    }
  })();
  return field.required ? base : `${base}?`;
}

export function defaultLiteral(field: FieldSpec): string {
  if (!field.required) return 'null';
  switch (field.type) {
    case 'int':
      return '0';
    case 'double':
      return '0';
    case 'bool':
      return 'false';
    case 'datetime':
      return 'DateTime.fromMillisecondsSinceEpoch(0)';
    case 'stringList':
      return 'const <String>[]';
    case 'relation':
    case 'enum':
    case 'text':
    case 'string':
    default:
      return "''";
  }
}

/** Dart expression that safely reads `json[name]` for this field. */
export function jsonRead(field: FieldSpec, key = field.name): string {
  const ref = `json['${key}']`;
  switch (field.type) {
    case 'int':
      return field.required ? `(${ref} as num?)?.toInt() ?? 0` : `(${ref} as num?)?.toInt()`;
    case 'double':
      return field.required ? `(${ref} as num?)?.toDouble() ?? 0` : `(${ref} as num?)?.toDouble()`;
    case 'bool':
      return field.required ? `(${ref} as bool?) ?? false` : `${ref} as bool?`;
    case 'datetime':
      return field.required
        ? `DateTime.tryParse(${ref} as String? ?? '') ?? DateTime.fromMillisecondsSinceEpoch(0)`
        : `DateTime.tryParse(${ref} as String? ?? '')`;
    case 'stringList':
      return `(${ref} as List?)?.whereType<String>().toList(growable: false) ?? const <String>[]`;
    case 'relation':
    case 'enum':
    case 'text':
    case 'string':
    default:
      return field.required ? `${ref} as String? ?? ''` : `${ref} as String?`;
  }
}

/** Dart expression that serializes the field back to JSON. */
export function jsonWrite(field: FieldSpec, accessor: string): string {
  switch (field.type) {
    case 'datetime':
      return `${accessor}${field.required ? '' : '?'}.toIso8601String()`;
    case 'stringList':
      return `${accessor}.toList(growable: false)`;
    default:
      return accessor;
  }
}

export function fieldLabel(field: FieldSpec): string {
  return field.label?.trim() || pascal(field.name).replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function enumValues(field: FieldSpec): string[] {
  return (field.values ?? []).map((v) => String(v)).filter(Boolean);
}

export function primaryField(entity: EntitySpec): FieldSpec | undefined {
  return entity.fields.find((f) => f.primary) ?? entity.fields.find((f) => f.type === 'string' || f.type === 'text');
}

export function createdAtField(entity: EntitySpec): FieldSpec | undefined {
  return entity.fields.find((f) => f.name === 'createdAt') ?? entity.fields.find((f) => f.type === 'datetime');
}

/** Quote a Dart string literal. Escapes quotes, backslashes, newlines and `$`. */
export function dartString(value: string): string {
  const escaped = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n')
    .replace(/\$/g, '\\$');
  return `'${escaped}'`;
}

/** `#RRGGBB` / `#AARRGGBB` → `Color(0xFFRRGGBB)` expression. */
export function dartColor(hex: string, opacityArgb = 'FF'): string {
  const raw = String(hex ?? '').replace(/^#/, '').trim();
  const normalized = /^[0-9a-fA-F]{6}$/.test(raw)
    ? `${opacityArgb}${raw.toUpperCase()}`
    : /^[0-9a-fA-F]{8}$/.test(raw)
      ? raw.toUpperCase()
      : `FF${'6750A4'}`;
  return `Color(0x${normalized})`;
}

/** CSS-style hex without alpha, used in reports and docs. */
export function normalizeHex(hex: string, fallback = '#6750A4'): string {
  const raw = String(hex ?? '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toUpperCase().replace('#', '#');
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toUpperCase()}`;
  return fallback;
}

// ── design helpers ────────────────────────────────────────────────────────

export interface SpacingScale {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  xxl: number;
}

export function spacingScale(design: DesignSpec): SpacingScale {
  const sorted = [...(design.spacing ?? [])].filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const at = (index: number, fallback: number) => sorted[Math.min(index, Math.max(0, sorted.length - 1))] ?? fallback;
  return { xs: at(0, 4), sm: at(1, 8), md: at(2, 12), lg: at(3, 16), xl: at(4, 24), xxl: at(5, 32) };
}

export function radiusOf(design: DesignSpec, key: keyof DesignSpec['radii'] = 'md'): number {
  const value = design.radii?.[key];
  return Number.isFinite(value) && value >= 0 ? value : 12;
}

// ── spec validation ───────────────────────────────────────────────────────

const PACKAGE_RE = /^[a-z][a-z0-9_]{1,60}$/;
const NAME_RE = /^[A-Za-z][A-Za-z0-9 '&.-]{0,60}$/;

export function validateSpec(spec: AppSpec): SpecValidation {
  const errors: string[] = [];
  if (!spec || typeof spec !== 'object') return { ok: false, errors: ['spec is not an object'] };
  if (spec.version !== 1) errors.push('spec.version must be 1');
  if (!spec.app?.name || !NAME_RE.test(spec.app.name)) errors.push('app.name is missing or invalid');
  if (!spec.app?.packageName || !PACKAGE_RE.test(spec.app.packageName)) {
    errors.push('app.packageName must be snake_case starting with a letter');
  }
  if (!spec.app?.tagline) errors.push('app.tagline is required');
  if (!spec.app?.description) errors.push('app.description is required');

  if (!Array.isArray(spec.entities) || spec.entities.length === 0) errors.push('at least one entity is required');
  if (!Array.isArray(spec.screens) || spec.screens.length < 2) errors.push('at least two screens are required');

  const entityNames = new Set<string>();
  for (const entity of spec.entities ?? []) {
    const name = pascal(entity.name);
    if (!name) errors.push('entity has an empty name');
    if (entityNames.has(name)) errors.push(`duplicate entity ${name}`);
    entityNames.add(name);
    if (!entity.plural) errors.push(`entity ${name} is missing plural`);
    if (!Array.isArray(entity.fields) || entity.fields.length === 0) errors.push(`entity ${name} has no fields`);
    const fieldNames = new Set<string>();
    for (const field of entity.fields ?? []) {
      if (!field.name) errors.push(`entity ${name} has a field without a name`);
      if (field.name === 'id') errors.push(`entity ${name} must not declare id (implicit)`);
      if (fieldNames.has(field.name)) errors.push(`entity ${name} has duplicate field ${field.name}`);
      fieldNames.add(field.name);
      if (field.type === 'enum' && enumValues(field).length === 0) errors.push(`entity ${name}.${field.name} is enum without values`);
      if (field.type === 'relation' && (!field.target || ![...entityNames].includes(pascal(field.target)))) {
        // Relation targets are validated after all entities are known (below).
      }
    }
  }
  for (const entity of spec.entities ?? []) {
    for (const field of entity.fields ?? []) {
      if (field.type === 'relation') {
        const target = pascal(field.target ?? '');
        if (!target) errors.push(`entity ${entity.name}.${field.name} relation is missing target`);
        else if (!(spec.entities ?? []).some((e) => pascal(e.name) === target)) {
          errors.push(`entity ${entity.name}.${field.name} references unknown entity ${field.target}`);
        }
      }
    }
  }

  const screenIds = new Set<string>();
  const routes = new Set<string>();
  for (const screen of spec.screens ?? []) {
    if (!screen.id) errors.push('screen has an empty id');
    if (screenIds.has(screen.id)) errors.push(`duplicate screen id ${screen.id}`);
    screenIds.add(screen.id);
    if (!SCREEN_KINDS.includes(screen.kind)) errors.push(`screen ${screen.id} has unknown kind ${String(screen.kind)}`);
    if (!screen.title) errors.push(`screen ${screen.id} is missing title`);
    const route = routeOf(screen);
    if (routes.has(route)) errors.push(`duplicate route ${route}`);
    routes.add(route);
    if (screen.entity) {
      const target = pascal(screen.entity);
      if (!entityNames.has(target)) errors.push(`screen ${screen.id} references unknown entity ${screen.entity}`);
    }
    if (screenNeedsId(screen) && screen.entity && !route.includes(':')) {
      errors.push(`screen ${screen.id} is ${screen.kind} but route ${route} has no :id parameter`);
    }
  }

  for (const flow of spec.flows ?? []) {
    if (!Array.isArray(flow.steps) || flow.steps.length === 0) errors.push(`flow ${flow.id} has no steps`);
    for (const step of flow.steps ?? []) {
      if (!screenIds.has(step.screenId)) errors.push(`flow ${flow.id} references unknown screen ${step.screenId}`);
    }
  }

  const spacing = spec.design?.spacing ?? [];
  if (!spacing.length || spacing.some((n) => !Number.isFinite(n) || n < 0)) errors.push('design.spacing must be positive numbers');
  if (!/^#[0-9a-fA-F]{6}$/.test(String(spec.design?.seedColor ?? ''))) errors.push('design.seedColor must be #RRGGBB');
  if (!Array.isArray(spec.requirements) || spec.requirements.length === 0) errors.push('requirements are required');

  return { ok: errors.length === 0, errors };
}

// ── file-set integrity ────────────────────────────────────────────────────

function normalizeRelative(from: string, specifier: string): string {
  const base = from.split('/').slice(0, -1);
  const parts = [...base, ...specifier.split('/')];
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/**
 * Structural integrity of an emitted file set. Catches the class of bug that
 * would otherwise surface only as a Flutter compiler error: duplicate paths,
 * dangling relative/package imports, missing pubspec/entrypoint, empty files.
 *
 * This is intentionally static and fast; `flutter analyze` remains the
 * authoritative gate.
 */
export function verifyFileSet(files: GeneratedFile[], packageName: string): string[] {
  const problems: string[] = [];
  const byPath = new Map<string, GeneratedFile>();
  for (const file of files) {
    if (!file.path || file.path.startsWith('/') || file.path.includes('\\')) {
      problems.push(`invalid path: ${String(file.path)}`);
      continue;
    }
    if (byPath.has(file.path)) problems.push(`duplicate path: ${file.path}`);
    byPath.set(file.path, file);
    if (!String(file.content ?? '').trim()) problems.push(`empty file: ${file.path}`);
  }

  const required = ['pubspec.yaml', 'analysis_options.yaml', 'lib/main.dart', 'lib/app/app.dart', 'lib/app/router.dart', 'lib/app/theme.dart', 'lib/app/app_scope.dart', 'lib/app/navigation.dart'];
  for (const path of required) if (!byPath.has(path)) problems.push(`missing required file: ${path}`);

  const pubspec = byPath.get('pubspec.yaml')?.content ?? '';
  if (pubspec && !new RegExp(`^name:\\s*${packageName}\\s*$`, 'm').test(pubspec)) {
    problems.push(`pubspec.yaml name does not match package ${packageName}`);
  }

  for (const file of files) {
    if (!file.path.endsWith('.dart')) continue;
    const importRe = /^\s*import\s+['"]([^'"]+)['"]/gm;
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(file.content)) !== null) {
      const specifier = match[1];
      if (specifier.startsWith('dart:')) continue;
      if (specifier.startsWith('package:flutter')) continue;
      if (specifier.startsWith('package:')) {
        const pkgPath = specifier.slice('package:'.length);
        const slash = pkgPath.indexOf('/');
        const pkg = slash === -1 ? pkgPath : pkgPath.slice(0, slash);
        if (pkg !== packageName) continue; // external package — pubspec gate covers it
        const rel = `lib/${pkgPath.slice(pkg.length + 1)}`;
        if (!byPath.has(rel)) problems.push(`${file.path} imports missing ${specifier}`);
        continue;
      }
      if (!specifier.startsWith('.')) continue;
      const target = normalizeRelative(file.path, specifier);
      if (!byPath.has(target)) problems.push(`${file.path} imports missing ${specifier} (resolved ${target})`);
    }
  }

  return problems;
}

/** Sort files stable by path so emitted output is reproducible. */
export function sortFiles(files: GeneratedFile[]): GeneratedFile[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path));
}

/** Fold duplicate paths, later layers win deterministically. */
export function mergeFiles(layers: Array<{ layer: GeneratedFile['layer']; files: GeneratedFile[] }>): GeneratedFile[] {
  const merged = new Map<string, GeneratedFile>();
  for (const { layer, files } of layers) {
    for (const file of files) {
      merged.set(file.path, { ...file, layer: file.layer ?? layer });
    }
  }
  return sortFiles([...merged.values()]);
}

/** Minimal pubspec used by the assembly when no emitter owns it. */
export function pubspecYaml(spec: AppSpec): string {
  return `name: ${spec.app.packageName}
description: ${dartString(spec.app.tagline).slice(1, -1)}
publish_to: "none"
version: 1.0.0+1

environment:
  sdk: ">=3.4.0 <4.0.0"

dependencies:
  flutter:
    sdk: flutter

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^4.0.0

flutter:
  uses-material-design: true
`;
}

export function analysisOptionsYaml(): string {
  return `include: package:flutter_lints/flutter.yaml

linter:
  rules:
    prefer_const_constructors: true
    prefer_const_declarations: true
    avoid_print: true
    use_super_parameters: true
`;
}

/** Deterministic id generator for seed data (no randomness in emitted code). */
export function seedId(entity: EntitySpec, index: number): string {
  return `${snake(entity.name)}_${String(index + 1).padStart(3, '0')}`;
}
