/**
 * Per-agent output schemas. Every JSON-mode agent must satisfy one of these
 * before its output is allowed into ProjectState. `validate` coerces common
 * LLM sloppiness (string booleans, quoted numbers, single items in arrays,
 * wrong-cased enums) and reports the rest with JSON paths for a corrective
 * retry — never silently, never "good enough".
 */
import { s } from './schema';

const DOMAINS = [
  'ecommerce', 'fitness', 'social', 'finance', 'tasks', 'education', 'health',
  'travel', 'food', 'music', 'general', 'weather', 'recipes', 'crm',
  'dashboard', 'booking', 'media', 'learning', 'productivity', 'gaming',
];
const STATE_MANAGEMENT = ['provider', 'riverpod', 'bloc'];
const NAVIGATION = ['tabs', 'drawer', 'stack'];
const BACKEND_MODES = ['none', 'local', 'supabase'];
const PLATFORMS = ['web', 'android', 'ios', 'macos', 'windows'];
const TABLE_ACTIONS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL'];
const FILE_ACTIONS = ['create', 'edit'];

export const IntakeLLMOutput = s.object({
  appName: s.string(1, 80),
  oneLiner: s.string(1, 400),
  targetAudience: s.string(0, 300),
  primaryProblem: s.string(0, 300),
  domain: s.strEnum(...DOMAINS),
  platforms: s.strEnumArray(PLATFORMS, 1),
  constraints: s.strings(0, 20),
  keyFeatures: s.strings(0, 30),
  screens: s.strings(1, 40),
  stateManagement: s.strEnum(...STATE_MANAGEMENT, 'change_notifier'),
  needsSupabase: s.boolean(),
  colorPalette: s.string(0, 200),
});

export const UXResearchOutput = s.object({
  screens: s.array(
    s.object({
      id: s.string(1, 80),
      name: s.string(1, 80),
      route: s.string(0, 120),
      purpose: s.string(1, 300),
      primaryAction: s.string(0, 200),
      isAuthRequired: s.boolean(),
      widgets: s.strings(1, 20),
      states: s.object({
        loading: s.string(1, 400),
        empty: s.string(1, 400),
        error: s.string(1, 400),
        content: s.string(1, 400),
      }),
    }),
    1,
    40,
  ),
  userFlows: s.array(
    s.object({
      id: s.string(0, 80),
      name: s.string(1, 120),
      steps: s.strings(1, 20),
    }),
    0,
    20,
  ),
  navigation: s.strEnum('bottom_tabs', 'drawer', 'stack', 'tabs'),
});

export const DesignSystemOutput = s.object({
  primaryColor: s.string(4, 30),
  secondaryColor: s.string(4, 30),
  accentColor: s.string(4, 30),
  backgroundColor: s.string(4, 30),
  surfaceColor: s.string(4, 30),
  fontFamily: s.string(1, 60),
  useMaterial3: s.boolean(),
  isDarkPreferred: s.boolean(),
  borderRadius: s.number(0, 60),
  colorRationale: s.string(0, 400),
  typography: s.object({
    display: s.string(1, 80),
    headline: s.string(1, 80),
    body: s.string(1, 80),
    label: s.string(1, 80),
  }),
  spacingScale: s.array(s.number(0, 200), 1, 10),
  componentStyle: s.string(0, 200),
});

export const ArchitectureOutput = s.object({
  stateManagement: s.strEnum(...STATE_MANAGEMENT),
  navigationType: s.strEnum(...NAVIGATION),
  folderStructure: s.strings(1, 60),
  features: s.strings(1, 60),
  packages: s.record(s.string(0, 80)),
  backendMode: s.strEnum(...BACKEND_MODES),
  rationale: s.string(0, 400),
});

export const DataModelOutput = s.object({
  tables: s.array(
    s.object({
      name: s.string(1, 80),
      description: s.string(0, 400),
      columns: s.array(
        s.object({
          name: s.string(1, 80),
          type: s.string(1, 80),
          isPrimary: s.boolean(),
          isNullable: s.boolean(),
          defaultValue: s.string(0, 120),
        }),
        1,
        40,
      ),
      enableRLS: s.boolean(),
      policies: s.array(
        s.object({
          name: s.string(1, 120),
          action: s.strEnum(...TABLE_ACTIONS),
          rule: s.string(1, 400),
        }),
        0,
        30,
      ),
      indexes: s.strings(0, 20),
    }),
    0,
    40,
  ),
  migrations: s.strings(0, 20),
  relationships: s.array(
    s.object({
      from: s.string(1, 80),
      to: s.string(1, 80),
      type: s.string(1, 40),
      via: s.string(0, 80),
    }),
    0,
    40,
  ),
});

export const FeaturePlannerOutput = s.object({
  files: s.array(
    s.object({
      path: s.string(1, 200),
      purpose: s.string(1, 300),
      action: s.strEnum(...FILE_ACTIONS),
    }),
    1,
    200,
  ),
  phases: s.array(
    s.object({
      id: s.string(1, 80),
      label: s.string(1, 160),
      files: s.strings(1, 120),
      gateAfter: s.string(1, 300),
    }),
    1,
    30,
  ),
  dependencies: s.record(s.string(0, 120)),
  milestones: s.strings(0, 30),
});

