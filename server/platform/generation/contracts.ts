/**
 * Generation contracts — the typed intermediate representation (IR) shared by
 * every stage of the "any prompt → top app" lane.
 *
 * Pipeline:
 *   prompt ──compileSpec──▶ AppSpec ──emit*──▶ GeneratedFile[] ──gates──▶ sealed project
 *
 * Design rules:
 *  - The spec is the single source of truth. Emitters must never invent screens
 *    or entities that are absent from the spec; a screen in the spec is a
 *    contract that the UI layer will emit it.
 *  - Every emitted file path is deterministic from the spec, so re-running the
 *    pipeline is idempotent and diffs are reviewable.
 *  - Contracts are dependency-free (types only) so each stage can be tested in
 *    isolation with node:test.
 */

export const SPEC_VERSION = 1 as const;

/** Product domains the deterministic compiler recognizes. `custom` is honest. */
export type AppDomain =
  | 'productivity'
  | 'commerce'
  | 'social'
  | 'finance'
  | 'health'
  | 'education'
  | 'travel'
  | 'media'
  | 'developer'
  | 'custom';

export const APP_DOMAINS: readonly AppDomain[] = [
  'productivity',
  'commerce',
  'social',
  'finance',
  'health',
  'education',
  'travel',
  'media',
  'developer',
  'custom',
];

/** Field primitives. `enum` carries `values`; `relation` carries `target`. */
export type FieldType =
  | 'string'
  | 'text'
  | 'int'
  | 'double'
  | 'bool'
  | 'datetime'
  | 'enum'
  | 'stringList'
  | 'relation';

export interface FieldSpec {
  /** camelCase name, e.g. `dueAt`. */
  name: string;
  type: FieldType;
  required: boolean;
  /** Allowed values for `enum` fields. */
  values?: string[];
  /** Target entity name for `relation` fields. */
  target?: string;
  /** True for the primary display field (e.g. note title). */
  primary?: boolean;
  /** Human label used by forms and detail rows. */
  label?: string;
}

export interface EntitySpec {
  /** PascalCase singular, e.g. `Note`. */
  name: string;
  /** Plural, snake_case storage-friendly, e.g. `notes`. */
  plural: string;
  description: string;
  /** `id` is implicit and must not be listed. */
  fields: FieldSpec[];
  /** Field used for search/filter; defaults to the primary field. */
  searchField?: string;
  /** Natural sort field; defaults to `createdAt` when present. */
  sortField?: string;
}

/**
 * Screen archetypes. Each maps to a distinct, well-crafted widget pattern —
 * adding a kind here is a design decision, not a string.
 *
 *  dashboard  – KPI tiles + recent activity + quick actions
 *  list       – searchable/filterable collection bound to an entity
 *  detail     – entity record with metadata + actions
 *  form       – validated create/edit form bound to an entity
 *  chat       – message thread with composer and optimistic send
 *  profile    – identity header + stats + preferences entry
 *  settings   – grouped toggles, theme control, about section
 *  onboarding – intention-setting first-run flow
 */
export type ScreenKind =
  | 'dashboard'
  | 'list'
  | 'detail'
  | 'form'
  | 'chat'
  | 'profile'
  | 'settings'
  | 'onboarding';

export const SCREEN_KINDS: readonly ScreenKind[] = [
  'dashboard',
  'list',
  'detail',
  'form',
  'chat',
  'profile',
  'settings',
  'onboarding',
];

export interface ScreenSpec {
  /** snake_case id, also the feature folder name, e.g. `note_detail`. */
  id: string;
  title: string;
  /** Route path beginning with `/`, e.g. `/notes/:id`. */
  route: string;
  kind: ScreenKind;
  purpose: string;
  /** Entity the screen is bound to, matching EntitySpec.name. */
  entity?: string;
  /** Primary call to action, e.g. `New note`. */
  primaryAction?: string;
  /** True when the screen is reachable from the primary navigation. */
  inNavigation?: boolean;
  /** Material icon name (snake_case) declared by the spec, resolved by app layer. */
  icon?: string;
}

export interface FlowStep {
  screenId: string;
  action: string;
}

export interface FlowSpec {
  id: string;
  name: string;
  /** Ordered user journey; must reference existing screen ids. */
  steps: FlowStep[];
}

export interface DesignSpec {
  /** `#RRGGBB` seed color. */
  seedColor: string;
  /** Optional secondary accent; falls back to a harmonized seed derivative. */
  accentColor?: string;
  brightness: 'light' | 'dark' | 'system';
  /** Spacing scale in logical pixels, ascending. */
  spacing: number[];
  radii: { sm: number; md: number; lg: number; xl: number };
  /** Animation duration for micro-interactions; 0 disables motion. */
  motionMs: number;
  /** Corner style label; drives component shapes. */
  shape: 'rounded' | 'soft' | 'square';
}

export type RequirementCategory =
  | 'functional'
  | 'ux'
  | 'accessibility'
  | 'data'
  | 'performance'
  | 'reliability';

export interface RequirementSpec {
  id: string;
  statement: string;
  category: RequirementCategory;
  /** Quality gate that proves the requirement, e.g. `analyze`, `test`, `score`. */
  verifiedBy: string;
}

export interface AppSpec {
  version: typeof SPEC_VERSION;
  app: {
    /** Display name, e.g. `Trail Notes`. */
    name: string;
    /** dart package name, snake_case. */
    packageName: string;
    tagline: string;
    description: string;
    domain: AppDomain;
  };
  audience: {
    primary: string;
    secondary?: string;
  };
  entities: EntitySpec[];
  screens: ScreenSpec[];
  flows: FlowSpec[];
  design: DesignSpec;
  requirements: RequirementSpec[];
  /** Backend intent; emitters always produce a local repository seam. */
  backend: 'local' | 'supabase';
  /** Seed data quantity per entity (0 = empty-state-first app). */
  seedCount: number;
}

// ── compile input ──────────────────────────────────────────────────────────

export interface CompileInput {
  prompt: string;
  appName?: string;
  packageName?: string;
  seedColor?: string;
  backend?: 'local' | 'supabase';
  /** Force a domain instead of inferring from the prompt. */
  domain?: AppDomain;
  /** Override the deterministic seed count. */
  seedCount?: number;
}

// ── generated files ────────────────────────────────────────────────────────

export interface GeneratedFile {
  /** Workspace-relative POSIX path, e.g. `lib/app/app.dart`. */
  path: string;
  content: string;
  /** Emitting layer, for attribution and duplicate detection. */
  layer?: 'app' | 'data' | 'ui' | 'shell' | 'test' | 'docs';
}

export interface EmitContext {
  spec: AppSpec;
}

// ── LLM seam ───────────────────────────────────────────────────────────────

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompletionRequest {
  system: string;
  user: string;
  /** Ask the provider for a JSON object response. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Short label used by metering/audit, e.g. `generation.spec`. */
  label?: string;
}

export interface LlmCompletionResult {
  text: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

/**
 * The only dependency the spec enricher accepts. The platform provider
 * (`server/platform/ai/provider.ts`) implements it; tests pass a stub.
 */
export interface LlmComplete {
  (request: LlmCompletionRequest): Promise<LlmCompletionResult>;
}

// ── quality ────────────────────────────────────────────────────────────────

export type QualityCategory =
  | 'architecture'
  | 'completeness'
  | 'design'
  | 'accessibility'
  | 'reliability'
  | 'testability'
  | 'performance';

export const QUALITY_CATEGORIES: readonly QualityCategory[] = [
  'architecture',
  'completeness',
  'design',
  'accessibility',
  'reliability',
  'testability',
  'performance',
];

export interface QualityFinding {
  category: QualityCategory;
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  path?: string;
}

export interface QualityStats {
  files: number;
  bytes: number;
  lines: number;
  screens: number;
  entities: number;
  tests: number;
}

export interface QualityReport {
  total: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  categories: Record<QualityCategory, number>;
  findings: QualityFinding[];
  stats: QualityStats;
  generatedAt: number;
}

/** Verdict from a hard gate (analyze / test / structure / budget). */
export interface GateResult {
  gate: string;
  passed: boolean;
  /** Blocking reasons; empty when passed. */
  blockers: string[];
  /** Informational detail (never secrets). */
  detail?: string;
}

// ── benchmarks ─────────────────────────────────────────────────────────────

export interface BenchmarkExpectation {
  /** Entity class names that must exist in the compiled spec. */
  entities: string[];
  /** Screen kinds that must exist. */
  screenKinds: ScreenKind[];
  /** Lowercase substrings that must appear somewhere in the emitted project. */
  mustInclude?: string[];
  /** Minimum number of screens. */
  minScreens?: number;
}

export interface BenchmarkCase {
  id: string;
  prompt: string;
  expectation: BenchmarkExpectation;
  /** Category weight for aggregate scoring; defaults to 1. */
  weight?: number;
}

export interface BenchmarkCaseResult {
  caseId: string;
  passed: boolean;
  failures: string[];
  quality: QualityReport;
  gates: GateResult[];
  spec: AppSpec;
  durationMs: number;
}

export interface BenchmarkSuiteReport {
  total: number;
  passed: number;
  failed: number;
  /** Mean quality score across cases, 0-100. */
  meanQuality: number;
  cases: BenchmarkCaseResult[];
  generatedAt: number;
}

/** A compiled spec that survived structural validation. */
export interface SpecValidation {
  ok: boolean;
  errors: string[];
}

export const MIN_TOP_APP_QUALITY = 80 as const;

/**
 * Runtime contract between emitted layers. Documented here because it is
 * enforced by `emit/index.ts` assembly tests and by `flutter analyze`.
 *
 * data layer:
 *   lib/data/models/<entity>.dart        class <Entity> (const ctor, copyWith, toJson/fromJson)
 *   lib/data/repositories/<entity>_repository.dart
 *                                        abstract class <Entity>Repository
 *                                        class InMemory<Entity>Repository
 *   lib/state/<entity>_controller.dart   class <Entity>Controller extends ChangeNotifier
 *                                        items / isLoading / error / load() / create() / update() / remove()
 * ui layer:
 *   lib/features/<screen>/<screen>_page.dart   class <Screen>Page({super.key, this.entityId})
 *   lib/ui/components/*.dart                   shared presentational widgets only
 * app layer:
 *   lib/main.dart, lib/app/{app,app_scope,router,theme,navigation}.dart
 *   lib/state/app_settings_controller.dart
 *     class AppSettingsController extends ChangeNotifier
 *     ThemeMode themeMode; bool isDark; setThemeMode(ThemeMode); toggleTheme()
 *   lib/app/app_scope.dart
 *     class AppScope extends InheritedWidget
 *     final AppSettingsController settings;
 *     final <Entity>Controller <entityVar>;  // one per entity
 *     static AppScope of(BuildContext) => dependOnInheritedWidgetOfExactType
 *   test/app/app_smoke_test.dart
 *
 * UI screens read state with `AppScope.of(context).<entityVar>` and rebuild via
 * `ListenableBuilder(listenable: controller, builder: ...)`. No state package.
 */
export const LAYER_CONTRACT_VERSION = 1 as const;

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
