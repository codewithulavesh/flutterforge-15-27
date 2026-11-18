/**
 * Deterministic quality rubric for generated Flutter projects.
 *
 * The scorer is a pure function of (spec, files, clock). It never reads the
 * filesystem, never uses randomness and never awards points for volume: a file
 * that exists but does not do its job is treated as missing. Every deduction
 * emits a stable `QualityFinding.code` so regressions can be tracked by code
 * across releases.
 *
 * Categories and weights (sum 100):
 *   architecture 15 · completeness 20 · design 15 · accessibility 15
 *   reliability 15 · testability 10 · performance 10
 */
import type {
  AppSpec,
  EntitySpec,
  FieldSpec,
  GeneratedFile,
  QualityCategory,
  QualityFinding,
  QualityReport,
  QualityStats,
  ScreenSpec,
} from '../contracts.js';
import {
  controllerClass,
  controllerFile,
  entityClass,
  entityVar,
  modelFile,
  normalizeHex,
  pascal,
  repositoryClass,
  repositoryFile,
  routeOf,
  screenClass,
  screenFile,
  screenNeedsId,
  seedFile,
  snake,
} from '../emit/shared.js';

export const QUALITY_WEIGHTS: Record<QualityCategory, number> = {
  architecture: 15,
  completeness: 20,
  design: 15,
  accessibility: 15,
  reliability: 15,
  testability: 10,
  performance: 10,
};

export const QUALITY_MAX_FINDINGS = 80;
export const BENCHMARK_MIN_QUALITY = 70;

/** Meaningful code lines required before a screen is treated as implemented. */
const MIN_SCREEN_LINES = 18;

export interface ScoreOptions {
  /** Injected clock; only used for `generatedAt`. Defaults to `Date.now`. */
  now?: () => number;
}

const SEVERITY_ORDER: Record<QualityFinding['severity'], number> = { error: 0, warning: 1, info: 2 };

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function fraction(numerator: number, denominator: number, empty = 0): number {
  if (denominator <= 0) return empty;
  return Math.max(0, Math.min(1, numerator / denominator));
}

/** Strip Dart comments so comment-only "signals" never earn points. */
export function stripDartComments(source: string): string {
  const text = String(source ?? '');
  let out = '';
  let index = 0;
  let state: 'code' | 'line' | 'block' | 'single' | 'double' = 'code';
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line';
        out += '  ';
        index += 2;
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block';
        out += '  ';
        index += 2;
        continue;
      }
      if (char === "'") state = 'single';
      else if (char === '"') state = 'double';
      out += char;
      index += 1;
      continue;
    }
    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        out += '\n';
      } else {
        out += ' ';
      }
      index += 1;
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code';
        out += '  ';
        index += 2;
      } else {
        out += char === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    const quote = state === 'single' ? "'" : '"';
    if (char === '\\') {
      out += char + (next ?? '');
      index += 2;
      continue;
    }
    if (char === quote) state = 'code';
    out += char;
    index += 1;
  }
  return out;
}

function codeLines(source: string): number {
  return String(source ?? '')
    .split('\n')
    .filter((line) => line.trim().length > 0).length;
}

function countMatches(code: string, pattern: RegExp): number {
  return (code.match(pattern) ?? []).length;
}

function mentions(code: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(code);
}

class FindingCollector {
  readonly items: QualityFinding[] = [];

  add(category: QualityCategory, severity: QualityFinding['severity'], code: string, message: string, path?: string): void {
    this.items.push(path ? { category, severity, code, message, path } : { category, severity, code, message });
  }

  sorted(): QualityFinding[] {
    return [...this.items]
      .sort((a, b) => {
        const severity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
        if (severity !== 0) return severity;
        const code = cmpStr(a.code, b.code);
        if (code !== 0) return code;
        const path = cmpStr(a.path ?? '', b.path ?? '');
        if (path !== 0) return path;
        return cmpStr(a.message, b.message);
      })
      .slice(0, QUALITY_MAX_FINDINGS);
  }
}

interface ResolvedScreen {
  spec: ScreenSpec;
  path: string;
  file?: GeneratedFile;
  code: string;
  className: string;
  exists: boolean;
  classPresent: boolean;
  lines: number;
  completeness: number;
}

interface ResolvedEntity {
  spec: EntitySpec;
  className: string;
  varName: string;
  controllerName: string;
  repositoryName: string;
  modelPath: string;
  repositoryPath: string;
  controllerPath: string;
  seedPath: string;
  modelCode: string;
  repositoryCode: string;
  controllerCode: string;
  seedCode: string;
  modelValid: boolean;
  repositoryValid: boolean;
  controllerValid: boolean;
  seedValid: boolean;
}

interface ProjectContext {
  spec: AppSpec;
  files: GeneratedFile[];
  byPath: Map<string, GeneratedFile>;
  code: (path: string) => string;
  screens: ResolvedScreen[];
  entities: ResolvedEntity[];
  testFiles: GeneratedFile[];
  testCode: string;
}

function resolveEntities(spec: AppSpec, code: (path: string) => string, byPath: Map<string, GeneratedFile>): ResolvedEntity[] {
  return (spec.entities ?? []).map((entity) => {
    const className = entityClass(entity);
    const controllerName = controllerClass(entity);
    const repositoryName = repositoryClass(entity);
    const modelPath = modelFile(entity);
    const repositoryPath = repositoryFile(entity);
    const controllerPath = controllerFile(entity);
    const seedPath = seedFile(entity);
    const modelCode = code(modelPath);
    const repositoryCode = code(repositoryPath);
    const controllerCode = code(controllerPath);
    const seedCode = code(seedPath);
    const modelValid = Boolean(
      byPath.get(modelPath) &&
        new RegExp(`class\\s+${className}\\b`).test(modelCode) &&
        /toJson\s*\(/.test(modelCode) &&
        /fromJson\s*\(/.test(modelCode) &&
        /copyWith\s*\(/.test(modelCode) &&
        codeLines(modelCode) >= 10 &&
        !/package:flutter\/(material|widgets)/.test(modelCode),
    );
    const repositoryValid = Boolean(
      byPath.get(repositoryPath) &&
        new RegExp(`abstract\\s+class\\s+${repositoryName}\\b`).test(repositoryCode) &&
        new RegExp(`class\\s+InMemory\\w*\\b`).test(repositoryCode) &&
        new RegExp(`(?:implements|extends)\\s+${repositoryName}\\b`).test(repositoryCode),
    );
    const controllerValid = Boolean(
      byPath.get(controllerPath) &&
        new RegExp(`class\\s+${controllerName}\\b\\s+extends\\s+ChangeNotifier`).test(controllerCode) &&
        /notifyListeners\s*\(/.test(controllerCode),
    );
    const seedValid = Boolean(
      byPath.get(seedPath) && mentions(seedCode, className) && codeLines(seedCode) >= 3,
    );
    return {
      spec: entity,
      className,
      varName: entityVar(entity),
      controllerName,
      repositoryName,
      modelPath,
      repositoryPath,
      controllerPath,
      seedPath,
      modelCode,
      repositoryCode,
      controllerCode,
      seedCode,
      modelValid,
      repositoryValid,
      controllerValid,
      seedValid,
    };
  });
}

function screenScore(
  code: string,
  exists: boolean,
  classPresent: boolean,
  entity?: ResolvedEntity,
): number {
  if (!exists) return 0;
  const lines = codeLines(code);
  const structure = (/AppBar\s*\(|body\s*:/.test(code) && /child\s*:|children\s*:/.test(code));
  const dataReference = entity
    ? mentions(code, entity.className) ||
      mentions(code, entity.controllerName) ||
      mentions(code, entity.varName) ||
      /\bcontroller\./.test(code) ||
      /\bitems\b/.test(code)
    : /\bcontroller\./.test(code) || /\bitems\b/.test(code);
  let score = 0;
  if (classPresent) score += 0.3;
  if (lines >= MIN_SCREEN_LINES) score += 0.2;
  if (structure) score += 0.25;
  if (dataReference) score += 0.25;
  if (/return\s+Scaffold\s*\(\s*\)\s*;/.test(code)) return 0.05;
  if (!structure || lines < MIN_SCREEN_LINES) score = Math.min(score, 0.15);
  return score;
}

function resolveContext(spec: AppSpec, files: GeneratedFile[]): ProjectContext {
  const byPath = new Map<string, GeneratedFile>();
  const codeByPath = new Map<string, string>();
  for (const file of files ?? []) {
    byPath.set(file.path, file);
    codeByPath.set(file.path, file.path.endsWith('.dart') ? stripDartComments(file.content) : String(file.content ?? ''));
  }
  const code = (path: string) => codeByPath.get(path) ?? '';
  const entities = resolveEntities(spec, code, byPath);
  const entityByName = new Map<string, ResolvedEntity>();
  for (const entity of entities) entityByName.set(entity.className, entity);
  const screens: ResolvedScreen[] = (spec.screens ?? []).map((screen) => {
    const path = screenFile(screen);
    const className = screenClass(screen);
    const file = byPath.get(path);
    const screenCode = code(path);
    const classPresent = Boolean(file) && new RegExp(`class\\s+${className}\\b`).test(screenCode);
    const entity = screen.entity ? entityByName.get(pascal(screen.entity)) : undefined;
    return {
      spec: screen,
      path,
      file,
      code: screenCode,
      className,
      exists: Boolean(file),
      classPresent,
      lines: codeLines(screenCode),
      completeness: screenScore(screenCode, Boolean(file), classPresent, entity),
    };
  });
  const testFiles = (files ?? []).filter((file) => /^test\/.+\.dart$/.test(file.path));
  return {
    spec,
    files: files ?? [],
    byPath,
    code,
    screens,
    entities,
    testFiles,
    testCode: testFiles.map((file) => code(file.path)).join('\n'),
  };
}

function testedEntity(ctx: ProjectContext, entity: ResolvedEntity): boolean {
  if (!/\btest\s*\(/.test(ctx.testCode)) return false;
  return mentions(ctx.testCode, entity.className) || mentions(ctx.testCode, entity.controllerName);
}

// ── architecture ───────────────────────────────────────────────────────────

function scoreArchitecture(ctx: ProjectContext, findings: FindingCollector): number {
  if (ctx.entities.length === 0) {
    findings.add('architecture', 'warning', 'NO_DATA_LAYER', 'Spec declares no entities; model, repository and controller layers are absent.');
  }
  for (const entity of ctx.entities) {
    if (!ctx.byPath.get(entity.modelPath)) {
      findings.add('architecture', 'error', 'MISSING_MODEL', `Entity ${entity.className} has no model at ${entity.modelPath}.`, entity.modelPath);
    } else if (!entity.modelValid) {
      if (/package:flutter\/(material|widgets)/.test(entity.modelCode)) {
        findings.add('architecture', 'warning', 'DATA_LAYER_IMPORTS_FLUTTER', `${entity.className} model imports Flutter widgets; models must be dependency-light.`, entity.modelPath);
      } else if (!/toJson\s*\(/.test(entity.modelCode) || !/fromJson\s*\(/.test(entity.modelCode)) {
        findings.add('architecture', 'warning', 'MODEL_NOT_SERIALIZABLE', `${entity.className} model is missing toJson/fromJson.`, entity.modelPath);
      } else {
        findings.add('architecture', 'warning', 'EMPTY_MODEL', `${entity.className} model is too thin to be real.`, entity.modelPath);
      }
    }
    if (!entity.repositoryValid) {
      findings.add('architecture', 'error', 'NO_REPOSITORY_SEAM', `No repository seam for ${entity.className}; expected ${entity.repositoryName} plus an in-memory implementation.`, entity.repositoryPath);
    }
    if (!ctx.byPath.get(entity.controllerPath)) {
      findings.add('architecture', 'error', 'NO_CONTROLLER', `No ${entity.controllerName} for ${entity.className}.`, entity.controllerPath);
    } else if (!entity.controllerValid) {
      findings.add('architecture', 'error', 'NO_CHANGE_NOTIFIER', `${entity.controllerName} must extend ChangeNotifier and call notifyListeners().`, entity.controllerPath);
    }
  }

  let cleanScreens = 0;
  let existingScreens = 0;
  for (const screen of ctx.screens) {
    if (!screen.exists) continue;
    existingScreens += 1;
    const problems: string[] = [];
    if (/DateTime\.now\s*\(/.test(screen.code)) problems.push('DateTime.now()');
    if (/setState\s*\([\s\S]{0,400}?\.(?:create|update|remove|delete|save)\s*\(/.test(screen.code)) problems.push('setState-wrapped CRUD');
    if (/InMemory\w*Repository\s*\(/.test(screen.code) || /import\s+['"][^'"]*\/repositories\//.test(screen.code)) problems.push('data-layer construction');
    if (problems.length === 0) cleanScreens += 1;
    else findings.add('architecture', 'warning', 'BUSINESS_LOGIC_IN_WIDGET', `${screen.className} contains ${problems.join(', ')}; move it into a controller or repository.`, screen.path);
  }

  const modelRatio = fraction(ctx.entities.filter((entity) => entity.modelValid).length, ctx.entities.length, 0);
  const repositoryRatio = fraction(ctx.entities.filter((entity) => entity.repositoryValid).length, ctx.entities.length, 0);
  const controllerRatio = fraction(ctx.entities.filter((entity) => entity.controllerValid).length, ctx.entities.length, 0);
  const purityRatio = fraction(cleanScreens, existingScreens, existingScreens === 0 ? 1 : 0);
  return 25 * (modelRatio + repositoryRatio + controllerRatio + purityRatio);
}

// ── completeness ───────────────────────────────────────────────────────────

function scoreCompleteness(ctx: ProjectContext, findings: FindingCollector): number {
  if (ctx.screens.length === 0) {
    findings.add('completeness', 'error', 'NO_SCREENS', 'Spec declares no screens; there is no UI to ship.');
  }
  if (ctx.entities.length === 0) {
    findings.add('completeness', 'warning', 'NO_ENTITIES', 'Spec declares no entities; there is no data to display.');
  }
  for (const screen of ctx.screens) {
    if (!screen.exists) {
      findings.add('completeness', 'error', 'MISSING_SCREEN', `Screen ${screen.spec.id} was not emitted.`, screen.path);
      continue;
    }
    if (!screen.classPresent) {
      findings.add('completeness', 'error', 'MISSING_SCREEN_CLASS', `Expected class ${screen.className} in ${screen.path}.`, screen.path);
    }
    if (screen.completeness < 0.5) {
      findings.add('completeness', 'error', 'EMPTY_SCREEN', `${screen.className} exists but is not a meaningful screen (needs structure, data binding and substance).`, screen.path);
    }
  }

  let screenSum = 0;
  for (const screen of ctx.screens) screenSum += screen.completeness;
  const screenRatio = fraction(screenSum, ctx.screens.length, 0);

  let artifactSum = 0;
  for (const entity of ctx.entities) {
    const hasTest = testedEntity(ctx, entity);
    const artifacts = [entity.modelValid, entity.repositoryValid, entity.controllerValid, entity.seedValid, hasTest];
    artifactSum += artifacts.filter(Boolean).length / artifacts.length;
    if (!entity.seedValid) {
      findings.add('completeness', 'warning', 'MISSING_SEED', `Entity ${entity.className} has no usable seed data at ${entity.seedPath}.`, entity.seedPath);
    }
    if (!hasTest) {
      findings.add('completeness', 'warning', 'MISSING_ENTITY_TEST', `Entity ${entity.className} has no model/controller test.`, `test/data/${snake(entity.className)}_test.dart`);
    }
  }
  const artifactRatio = fraction(artifactSum, ctx.entities.length, 0);

  let fieldSum = 0;
  for (const entity of ctx.entities) {
    if (!entity.modelCode) continue;
    const present = entity.spec.fields.filter((field) => mentions(entity.modelCode, field.name)).length;
    fieldSum += fraction(present, entity.spec.fields.length, 1);
    for (const field of entity.spec.fields) {
      if (!mentions(entity.modelCode, field.name)) {
        findings.add('completeness', 'warning', 'MISSING_FIELD', `${entity.className} model omits field '${field.name}'.`, entity.modelPath);
      }
    }
  }
  const fieldRatio = fraction(fieldSum, ctx.entities.length, 0);

  const idScreens = ctx.screens.filter((screen) => screenNeedsId(screen.spec) && screen.spec.entity);
  let idOk = 0;
  for (const screen of idScreens) {
    if (routeOf(screen.spec).includes(':')) idOk += 1;
    else findings.add('completeness', 'error', 'ROUTE_MISSING_ID', `${screen.spec.kind} route '${routeOf(screen.spec)}' must carry an :id parameter.`, screen.path);
  }
  const routeRatio = fraction(idOk, idScreens.length, 1);

  const navCode = ctx.files
    .filter((file) => /^lib\/app\/(?:router|navigation|app)\.dart$/.test(file.path))
    .map((file) => ctx.code(file.path))
    .join('\n');
  const navScreens = ctx.screens.filter((screen) => screen.spec.inNavigation);
  let navOk = 0;
  for (const screen of navScreens) {
    const route = routeOf(screen.spec);
    const bare = route.replace(/\/:[^/]+/g, '');
    const covered =
      navCode.includes(route) ||
      (bare.length > 1 && navCode.includes(bare)) ||
      navCode.includes(screen.spec.id) ||
      navCode.includes(screen.className);
    if (covered) navOk += 1;
    else findings.add('completeness', 'warning', 'MISSING_NAV_ENTRY', `Navigation does not reference ${screen.spec.id} (${route}).`, screen.path);
  }
  const navigationRatio = fraction(navOk, navScreens.length, 1);

  return (
    55 * screenRatio +
    30 * artifactRatio +
    10 * fieldRatio +
    5 * ((routeRatio + navigationRatio) / 2)
  );
}

// ── design ─────────────────────────────────────────────────────────────────

const RAW_COLOR = /Color\s*\(\s*0x[0-9A-Fa-f]{8}\s*\)|Color\.fromARGB\s*\(|Colors\.(?!transparent\b)[A-Za-z]+/g;

function scoreDesign(ctx: ProjectContext, findings: FindingCollector): number {
  const themePath = 'lib/app/theme.dart';
  const themeFile = ctx.byPath.get(themePath) ?? ctx.files.find((file) => /(?:^|\/)theme\.dart$/.test(file.path));
  const themeCode = themeFile ? ctx.code(themeFile.path) : '';
  const uiCode = [
    ...ctx.screens.map((screen) => screen.code),
    ...ctx.files.filter((file) => /^lib\/ui\/components\/.+\.dart$/.test(file.path)).map((file) => ctx.code(file.path)),
  ].join('\n');

  let score = 0;
  if (!themeFile) {
    findings.add('design', 'error', 'MISSING_THEME', 'No lib/app/theme.dart; the app has no design system.', themePath);
  } else {
    const seedHex = normalizeHex(ctx.spec.design.seedColor);
    const seeded =
      /ColorScheme\.fromSeed\s*\(/.test(themeCode) &&
      (themeCode.toLowerCase().includes(seedHex.toLowerCase()) ||
        themeCode.toLowerCase().includes(`0xff${seedHex.slice(1).toLowerCase()}`));
    if (seeded) score += 25;
    else findings.add('design', 'error', 'THEME_NOT_SEEDED', `Theme does not derive ColorScheme.fromSeed from ${seedHex}.`, themeFile.path);

    if (/useMaterial3\s*:\s*true/.test(themeCode)) score += 10;
    else findings.add('design', 'warning', 'NO_MATERIAL3', 'Theme must set useMaterial3: true.', themeFile.path);

    if (/darkTheme|Brightness\.dark|ThemeMode\.dark/.test(themeCode) || /darkTheme/.test(ctx.code('lib/app/app.dart'))) score += 10;
    else findings.add('design', 'warning', 'NO_DARK_THEME', 'No dark theme/brightness is defined.', themeFile.path);

    const spacingDefined = /class\s+AppSpacing\b|static\s+const\s+double\s+(?:xs|sm|md|lg|xl|xxl)\b|AppSpacing/.test(themeCode);
    const radiusDefined = /class\s+AppRadius\b|AppRadius|BorderRadius\.circular\s*\(/.test(themeCode);
    const tokensUsed = /AppSpacing\.|AppRadius\.|Theme\.of\(context\)\.extension/.test(uiCode);
    if (spacingDefined && tokensUsed) score += 7.5;
    else findings.add('design', 'warning', 'NO_SPACING_TOKENS', 'Spacing tokens are not defined in the theme and used by screens.');
    if (radiusDefined && tokensUsed) score += 7.5;
    else findings.add('design', 'info', 'NO_RADIUS_TOKENS', 'Radius tokens are not defined in the theme and used by screens.');
  }

  const existingScreens = ctx.screens.filter((screen) => screen.exists);
  let cleanColorScreens = 0;
  for (const screen of existingScreens) {
    const matches = screen.code.match(RAW_COLOR) ?? [];
    if (matches.length === 0) {
      cleanColorScreens += 1;
    } else {
      findings.add('design', 'warning', 'RAW_COLOR', `${screen.className} hard-codes ${matches.length} color value(s); use ColorScheme tokens.`, screen.path);
    }
  }
  score += 20 * fraction(cleanColorScreens, existingScreens.length, 0);

  const hasLoading = /CircularProgressIndicator\s*\(|LinearProgressIndicator\s*\(|LoadingState\s*\(/.test(uiCode);
  const hasEmpty = /\.isEmpty\b/.test(uiCode) && /(?:EmptyState\s*\(|Center\s*\(|Icons\.)/.test(uiCode);
  const hasError = /\berror\b/.test(uiCode) && /(?:ErrorState\s*\(|Retry|retry|Try again)/.test(uiCode);
  if (hasLoading) score += 20 / 3;
  else findings.add('design', 'warning', 'NO_LOADING_STATE', 'No loading state (progress indicator) is rendered.');
  if (hasEmpty) score += 20 / 3;
  else findings.add('design', 'warning', 'NO_EMPTY_STATE', 'No empty state is rendered for empty collections.');
  if (hasError) score += 20 / 3;
  else findings.add('design', 'warning', 'NO_ERROR_STATE', 'No error state with retry affordance is rendered.');

  return score;
}

// ── accessibility ──────────────────────────────────────────────────────────

function scoreAccessibility(ctx: ProjectContext, findings: FindingCollector): number {
  const existingScreens = ctx.screens.filter((screen) => screen.exists);
  if (existingScreens.length === 0) {
    findings.add('accessibility', 'info', 'NO_ACCESSIBLE_UI', 'No screen files were emitted, so accessibility cannot be measured.');
    return 0;
  }

  let iconButtons = 0;
  let iconLabels = 0;
  for (const screen of existingScreens) {
    const buttons = countMatches(screen.code, /IconButton\s*\(/g);
    const labels = countMatches(screen.code, /tooltip\s*:/g) + countMatches(screen.code, /\bSemantics\s*\(/g);
    iconButtons += buttons;
    iconLabels += labels;
    if (buttons > labels) {
      findings.add('accessibility', 'warning', 'MISSING_TOOLTIP', `${screen.className} has ${buttons} icon control(s) but only ${labels} tooltip/semantics label(s).`, screen.path);
    }
  }
  const iconRatio = iconButtons === 0 ? 1 : fraction(iconLabels, iconButtons, 1);

  const formScreens = ctx.screens.filter((screen) => screen.spec.kind === 'form');
  let formSum = 0;
  for (const screen of formScreens) {
    if (!screen.exists) continue;
    const fields = countMatches(screen.code, /(?:TextFormField|TextField|DropdownButtonFormField)\s*\(/g);
    const labels = countMatches(screen.code, /labelText\s*:|label\s*:|semanticsLabel\s*:/g);
    const screenRatio = fields === 0 ? 1 : fraction(labels, fields, 1);
    formSum += screenRatio;
    if (screenRatio < 1) {
      findings.add('accessibility', 'error', 'MISSING_FORM_LABEL', `${screen.className} labels ${labels}/${fields} form fields.`, screen.path);
    }
  }
  const formRatio = formScreens.length === 0 ? 1 : fraction(formSum, formScreens.length, 0);

  let tapClean = 0;
  for (const screen of existingScreens) {
    const hasGesture = /GestureDetector\s*\(/.test(screen.code);
    const sized = /(?:behavior\s*:\s*HitTestBehavior|minWidth\s*:\s*48|minHeight\s*:\s*48|MaterialTapTargetSize)/.test(screen.code);
    if (!hasGesture || sized) tapClean += 1;
    else findings.add('accessibility', 'warning', 'SMALL_TAP_TARGET', `${screen.className} uses an unsized GestureDetector; wrap it in a 48dp tap target.`, screen.path);
  }
  const tapRatio = fraction(tapClean, existingScreens.length, 0);

  const textScaleSafe =
    /textScaler|textScaleFactor|TextScaler/.test(ctx.screens.map((screen) => screen.code).join('\n')) ||
    (/maxLines\s*:\s*\d+/.test(ctx.screens.map((screen) => screen.code).join('\n')) &&
      /overflow\s*:\s*TextOverflow\./.test(ctx.screens.map((screen) => screen.code).join('\n')));
  if (!textScaleSafe) findings.add('accessibility', 'info', 'NO_TEXT_SCALE_SAFETY', 'No text-scale safety marker (maxLines/overflow or textScaler) found in screens.');

  const allUi = existingScreens.map((screen) => screen.code).join('\n');
  const excludes = countMatches(allUi, /excludeFromSemantics\s*:\s*true/g);
  const semantics = countMatches(allUi, /\bSemantics\s*\(/g);
  const excludeRatio = excludes === 0 ? 1 : semantics >= excludes ? 1 : 0;
  if (excludeRatio === 0) {
    findings.add('accessibility', 'warning', 'EXCLUDE_FROM_SEMANTICS_MISUSE', 'excludeFromSemantics is used without a compensating Semantics label.');
  }

  return 30 * iconRatio + 25 * formRatio + 15 * tapRatio + 15 * (textScaleSafe ? 1 : 0) + 15 * excludeRatio;
}

// ── reliability ────────────────────────────────────────────────────────────

const DELETE_CONFIRM = /showDialog|AlertDialog|confirmDelete|ConfirmDialog/;
const BARE_BANG = /[A-Za-z0-9_\])]!(?=\s*[.;,)}\]])/g;
const ASYNC_CALLBACK = /on(?:Pressed|Tap|Retry|Submitted|Changed)\s*:\s*(?:\(\)\s*)?(?:async\s*)?\{([\s\S]{0,700}?)\}/g;
const ASYNC_ARROW = /on(?:Pressed|Tap|Retry)\s*:\s*\(\)\s*=>\s*[^;\n]*\.(?:create|update|remove|delete|save|load|submit)\s*\(/g;

function unawaitedCallbacks(code: string): number {
  let count = 0;
  let match: RegExpExecArray | null;
  const callback = new RegExp(ASYNC_CALLBACK.source, 'g');
  while ((match = callback.exec(code)) !== null) {
    const body = match[1] ?? '';
    if (/\.(?:create|update|remove|delete|save|load|submit)\s*\(/.test(body) && !/\bawait\b/.test(body)) count += 1;
  }
  count += countMatches(code, new RegExp(ASYNC_ARROW.source, 'g'));
  return count;
}

function validatableFields(entity: EntitySpec): FieldSpec[] {
  return entity.fields.filter(
    (field) => field.required && ['string', 'text', 'enum', 'relation', 'int', 'double'].includes(field.type),
  );
}

function scoreReliability(ctx: ProjectContext, findings: FindingCollector): number {
  const controllers = ctx.entities.filter((entity) => ctx.byPath.get(entity.controllerPath));
  const existingScreens = ctx.screens.filter((screen) => screen.exists);
  if (controllers.length === 0 && existingScreens.length === 0) {
    findings.add('reliability', 'info', 'NO_RELIABILITY_SIGNAL', 'No controllers or screens were emitted, so reliability cannot be measured.');
    return 0;
  }
  let tryCatchSum = 0;
  let errorFieldSum = 0;
  for (const entity of controllers) {
    const hasTryCatch = /try\s*\{/.test(entity.controllerCode) && /catch\s*\(/.test(entity.controllerCode);
    if (hasTryCatch) tryCatchSum += 1;
    else findings.add('reliability', 'error', 'NO_TRY_CATCH', `${entity.controllerName} performs async work without try/catch.`, entity.controllerPath);
    if (/\berror\b/.test(entity.controllerCode)) errorFieldSum += 1;
    else findings.add('reliability', 'warning', 'NO_ERROR_SURFACE', `${entity.controllerName} never records an error state.`, entity.controllerPath);
  }
  const tryCatchRatio = fraction(tryCatchSum, controllers.length, 0);
  const controllerErrorRatio = fraction(errorFieldSum, controllers.length, 0);

  let screenErrorCount = 0;
  for (const screen of existingScreens) {
    const surfaces = /\berror\b/.test(screen.code) && /(?:ErrorState\s*\(|Retry|retry|Try again|SnackBar)/.test(screen.code);
    if (surfaces) screenErrorCount += 1;
    else findings.add('reliability', 'warning', 'NO_SCREEN_ERROR_UI', `${screen.className} does not surface an error state.`, screen.path);
  }
  const screenErrorRatio = fraction(screenErrorCount, existingScreens.length, 0);

  let validatorSum = 0;
  let formCount = 0;
  for (const screen of ctx.screens) {
    if (screen.spec.kind !== 'form') continue;
    formCount += 1;
    const entity = screen.spec.entity
      ? ctx.entities.find((candidate) => candidate.className === pascal(screen.spec.entity ?? ''))
      : undefined;
    const required = entity ? validatableFields(entity.spec) : [];
    const validators = countMatches(screen.code, /validator\s*:/g);
    const needed = required.length;
    const cover = needed === 0 ? (screen.exists ? 1 : 0) : fraction(validators, needed, 0);
    validatorSum += cover;
    if (cover < 1) {
      findings.add('reliability', 'error', 'MISSING_VALIDATOR', `${screen.className} validates ${validators}/${needed} required field(s).`, screen.path);
    }
  }
  const validatorRatio = fraction(validatorSum, formCount, 1);

  const removeCapable =
    controllers.some((entity) => /\bremove\s*\(/.test(entity.controllerCode)) ||
    existingScreens.some((screen) => /\.remove\s*\(|\.delete\s*\(/.test(screen.code));
  const hasConfirm = existingScreens.some((screen) => DELETE_CONFIRM.test(screen.code));
  const deleteRatio = !removeCapable || hasConfirm ? 1 : 0;
  if (deleteRatio === 0) {
    findings.add('reliability', 'error', 'NO_DELETE_CONFIRM', 'Destructive remove() actions have no confirmation dialog.');
  }

  let unawaitedScreens = 0;
  for (const screen of existingScreens) {
    const count = unawaitedCallbacks(screen.code);
    if (count === 0) unawaitedScreens += 1;
    else findings.add('reliability', 'warning', 'UNAWAITED_FUTURE', `${screen.className} has ${count} unawaited async action(s).`, screen.path);
  }
  const unawaitedRatio = fraction(unawaitedScreens, existingScreens.length, 1);

  let bangCount = 0;
  for (const screen of existingScreens) bangCount += countMatches(screen.code, BARE_BANG);
  for (const entity of controllers) bangCount += countMatches(entity.controllerCode, BARE_BANG);
  if (bangCount > 0) {
    findings.add('reliability', 'warning', 'BARE_NULL_ASSERTION', `${bangCount} bare null assertion(s) on user data; guard instead.`);
  }
  const bangRatio = bangCount === 0 ? 1 : 0;

  return (
    30 * tryCatchRatio +
    25 * ((controllerErrorRatio + screenErrorRatio) / 2) +
    20 * validatorRatio +
    15 * deleteRatio +
    5 * unawaitedRatio +
    5 * bangRatio
  );
}

// ── testability ────────────────────────────────────────────────────────────

function scoreTestability(ctx: ProjectContext, findings: FindingCollector): number {
  const smoke = ctx.testFiles.some(
    (file) =>
      /^test\/app\/.+\.dart$/.test(file.path) &&
      /testWidgets\s*\(/.test(ctx.code(file.path)) &&
      countMatches(ctx.code(file.path), /expect\s*\(/g) >= 3,
  );

  let coveredScreens = 0;
  for (const screen of ctx.screens) {
    const covered =
      smoke ||
      ctx.testFiles.some(
        (file) =>
          ctx.code(file.path).includes(screen.className) ||
          file.path.includes(`/${snake(screen.spec.id)}`) ||
          file.path.includes(`${snake(screen.spec.id)}_test.dart`),
      );
    if (covered) coveredScreens += 1;
    else findings.add('testability', 'error', 'MISSING_TEST', `No widget test (or comprehensive smoke test) covers ${screen.className}.`, screen.path);
  }
  const screenRatio = fraction(coveredScreens, ctx.screens.length, 0);

  let testedEntities = 0;
  for (const entity of ctx.entities) {
    if (testedEntity(ctx, entity)) testedEntities += 1;
  }
  const entityRatio = fraction(testedEntities, ctx.entities.length, 0);

  const names: string[] = [];
  const namePattern = /\b(?:test|testWidgets|group)\s*\(\s*(['"])([^'"]*)\1/g;
  let nameMatch: RegExpExecArray | null;
  while ((nameMatch = namePattern.exec(ctx.testCode)) !== null) names.push(nameMatch[2]);
  const stable = names.filter(
    (name) => name.trim().length > 0 && !name.includes('${') && !/DateTime|Random|Date\.now/i.test(name),
  );
  const stableRatio = names.length === 0 ? 0 : fraction(stable.length, names.length, 0);
  if (names.length > 0 && stableRatio < 1) {
    findings.add('testability', 'warning', 'UNSTABLE_TEST_NAME', 'Tests use generated or timestamped names; names must be stable.');
  }

  return 50 * screenRatio + 30 * entityRatio + 20 * stableRatio;
}

// ── performance ────────────────────────────────────────────────────────────

function scorePerformance(ctx: ProjectContext, findings: FindingCollector): number {
  const existing = ctx.screens.filter((screen) => screen.exists);
  if (existing.length === 0) {
    findings.add('performance', 'info', 'NO_UI_TO_MEASURE', 'No screen files were emitted, so performance cannot be measured.');
    return 0;
  }

  const constScreens = existing.filter((screen) => /\bconst\s+[A-Za-z_]/.test(screen.code));
  const constRatio = fraction(constScreens.length, existing.length, 0);
  if (constRatio < 1) {
    findings.add('performance', 'info', 'NO_CONST_CONSTRUCTORS', `${existing.length - constScreens.length} screen(s) use no const constructors.`);
  }

  let listScreens = 0;
  let builderScreens = 0;
  let shrinkWrap = 0;
  let opacityLists = 0;
  let setStateLoops = 0;
  let imageCount = 0;
  let sizedImages = 0;

  for (const screen of existing) {
    const isList = /(?:ListView|GridView)\s*\(|SliverList\s*\(/.test(screen.code);
    if (isList) {
      listScreens += 1;
      const builder =
        /ListView\.(?:builder|separated)\s*\(/.test(screen.code) ||
        /GridView\.(?:builder|count)\s*\(/.test(screen.code) ||
        /SliverList\s*\(/.test(screen.code) ||
        /SliverChildBuilderDelegate\s*\(/.test(screen.code);
      if (builder) builderScreens += 1;
      else findings.add('performance', 'warning', 'NON_BUILDER_LIST', `${screen.className} renders a list without ListView.builder/separated; prefer a builder for unbounded collections.`, screen.path);
    }
    if (/shrinkWrap\s*:\s*true/.test(screen.code) && isList) {
      shrinkWrap += 1;
      findings.add('performance', 'warning', 'SHRINKWRAP_LIST', `${screen.className} uses shrinkWrap on a list; scope it instead.`, screen.path);
    }
    if (/Opacity\s*\([\s\S]{0,300}?(?:ListView|GridView)/.test(screen.code)) {
      opacityLists += 1;
      findings.add('performance', 'warning', 'OPACITY_LIST', `${screen.className} wraps a list in Opacity; use a color with alpha.`, screen.path);
    }
    if (/for\s*\([^)]*\)\s*\{[\s\S]{0,400}?setState\s*\(/.test(screen.code) || /\.forEach\s*\([\s\S]{0,300}?setState\s*\(/.test(screen.code)) {
      setStateLoops += 1;
      findings.add('performance', 'warning', 'SETSTATE_IN_LOOP', `${screen.className} calls setState inside a loop.`, screen.path);
    }
    const images = countMatches(screen.code, /Image\.(?:network|asset|file)\s*\(/g);
    if (images > 0) {
      imageCount += images;
      const sizes = countMatches(screen.code, /width\s*:|height\s*:/g);
      sizedImages += Math.min(images, sizes);
      if (sizes < images) {
        findings.add('performance', 'warning', 'UNSIZED_IMAGE', `${screen.className} has ${images - sizes} image(s) without explicit width/height.`, screen.path);
      }
    }
  }

  const builderRatio = fraction(builderScreens, listScreens, 1);
  const shrinkRatio = shrinkWrap === 0 ? 1 : 0;
  const opacityRatio = opacityLists === 0 ? 1 : 0;
  const imageRatio = fraction(sizedImages, imageCount, 1);
  const loopRatio = setStateLoops === 0 ? 1 : 0;

  return (
    20 * constRatio +
    25 * builderRatio +
    15 * shrinkRatio +
    15 * opacityRatio +
    10 * imageRatio +
    15 * loopRatio
  );
}

// ── report ─────────────────────────────────────────────────────────────────

/** Grade thresholds: A ≥90, B ≥80, C ≥70, D ≥60, F <60. */
export function gradeFor(total: number): QualityReport['grade'] {
  if (total >= 90) return 'A';
  if (total >= 80) return 'B';
  if (total >= 70) return 'C';
  if (total >= 60) return 'D';
  return 'F';
}

function statsFor(spec: AppSpec, files: GeneratedFile[]): QualityStats {
  let bytes = 0;
  let lines = 0;
  for (const file of files) {
    const content = String(file.content ?? '');
    bytes += Buffer.byteLength(content, 'utf8');
    if (content.length > 0) lines += content.split('\n').length;
  }
  return {
    files: files.length,
    bytes,
    lines,
    screens: (spec.screens ?? []).length,
    entities: (spec.entities ?? []).length,
    tests: files.filter((file) => /^test\//.test(file.path)).length,
  };
}

/**
 * Score an emitted project. Pure except for the injected clock, which only
 * stamps `generatedAt`.
 */
export function scoreProject(spec: AppSpec, files: GeneratedFile[], options: ScoreOptions = {}): QualityReport {
  const clock = options.now ?? Date.now;
  const stamp = clock();
  const generatedAt = Number.isFinite(stamp) ? Math.trunc(stamp) : 0;
  const ctx = resolveContext(spec, files ?? []);
  const findings = new FindingCollector();

  const categories: Record<QualityCategory, number> = {
    architecture: clampScore(scoreArchitecture(ctx, findings)),
    completeness: clampScore(scoreCompleteness(ctx, findings)),
    design: clampScore(scoreDesign(ctx, findings)),
    accessibility: clampScore(scoreAccessibility(ctx, findings)),
    reliability: clampScore(scoreReliability(ctx, findings)),
    testability: clampScore(scoreTestability(ctx, findings)),
    performance: clampScore(scorePerformance(ctx, findings)),
  };

  const weightSum = Object.values(QUALITY_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  const weighted = (Object.keys(categories) as QualityCategory[]).reduce(
    (sum, category) => sum + categories[category] * QUALITY_WEIGHTS[category],
    0,
  );
  const total = clampScore(weighted / weightSum);

  return {
    total,
    grade: gradeFor(total),
    categories,
    findings: findings.sorted(),
    stats: statsFor(spec, files ?? []),
    generatedAt,
  };
}

