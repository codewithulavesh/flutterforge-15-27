import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ProjectState, GateDiagnostic } from '../orchestrator/state';
import { runIntakeAgent } from './intakeAgent';
import { runUXResearchAgent } from './uxResearchAgent';
import { runDesignSystemAgent } from './designSystemAgent';
import { runArchitectureAgent } from './architectureAgent';
import { runDataModelAgent } from './dataModelAgent';
import { runFeaturePlannerAgent } from './featurePlannerAgent';

const { callLLMJsonStrictMock } = vi.hoisted(() => ({
  callLLMJsonStrictMock: vi.fn(),
}));

vi.mock('./llmClient', () => ({
  callLLMJsonStrict: callLLMJsonStrictMock,
  agentModelFor: () => 'test-model',
}));

function baseState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectId: 'p1',
    userPrompt: 'build a demo app',
    status: 'planning',
    productBrief: {
      appName: 'Demo',
      oneLiner: 'A demo app',
      targetAudience: 'Everyone',
      primaryProblem: 'Testing discovery',
      platforms: ['android'],
      constraints: [],
    },
    screenGraph: null,
    designTokens: null,
    architectureSpec: null,
    architecture: null,
    dataSchema: null,
    plan: null,
    generatedFiles: new Map(),
    diagnostics: [],
    repairAttempts: 0,
    logs: [],
    ...overrides,
  };
}

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

function allHex(tokens: Record<string, unknown>): boolean {
  return ['primaryColor', 'secondaryColor', 'accentColor', 'backgroundColor', 'surfaceColor']
    .every((k) => typeof tokens[k] === 'string' && HEX_RE.test(tokens[k] as string));
}

const cannedIntake = (overrides: Record<string, unknown> = {}) => ({
  appName: 'DemoApp',
  oneLiner: 'A demo app for testing',
  targetAudience: 'Everyone',
  primaryProblem: 'Needs a demo',
  domain: 'tasks',
  platforms: ['android'],
  constraints: ['Material 3 compliance'],
  keyFeatures: ['Dashboard'],
  screens: ['HomeScreen'],
  stateManagement: 'provider',
  needsSupabase: false,
  colorPalette: '#2563EB',
  ...overrides,
});

beforeEach(() => {
  callLLMJsonStrictMock.mockReset();
});

describe('ArchitectureAgent — enum hard-clamping', () => {
  it("normalizes a stateManagement of 'redux' to 'provider' without crashing", async () => {
    callLLMJsonStrictMock.mockResolvedValue({
      stateManagement: 'redux',
      navigationType: 'sideways',
      folderStructure: ['lib/'],
      features: ['home'],
      packages: { provider: '^6.1.2', bogus: 42 },
      backendMode: 'firebase',
      rationale: 'because',
    });

    const result = await runArchitectureAgent(baseState());

    expect(result.architectureSpec?.stateManagement).toBe('provider');
    expect(result.architectureSpec?.navigationType).toBe('tabs');
    expect(result.architectureSpec?.backendMode).toBe('none');
    expect(result.architectureSpec?.packages).toEqual({ provider: '^6.1.2' });
    expect(result.diagnostics?.some((d: GateDiagnostic) => /stateManagement/.test(d.message))).toBe(true);
  });

  it('forces backendMode to supabase when the brief constraints mention supabase', async () => {
    callLLMJsonStrictMock.mockResolvedValue({
      stateManagement: 'riverpod',
      navigationType: 'drawer',
      folderStructure: ['lib/'],
      features: ['home'],
      packages: {},
      backendMode: 'local',
      rationale: 'model prefers local',
    });

    const state = baseState({
      productBrief: {
        appName: 'ShopApp',
        oneLiner: 'A shop',
        targetAudience: 'Shoppers',
        primaryProblem: 'Buying',
        platforms: ['android'],
        constraints: ['Supabase backend requested (auth/database/realtime)'],
      },
    });
    const result = await runArchitectureAgent(state);
    expect(result.architectureSpec?.backendMode).toBe('supabase');
    // Valid enum values are left untouched
    expect(result.architectureSpec?.stateManagement).toBe('riverpod');
    expect(result.architectureSpec?.navigationType).toBe('drawer');
  });
});

describe('UXResearchAgent — screen count clamp', () => {
  const makeScreens = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `feature_${i}`,
      name: `Feature${i}Screen`,
      route: `/feature-${i}`,
      purpose: `Feature ${i} functionality`,
      primaryAction: 'Continue',
      isAuthRequired: false,
      widgets: ['Scaffold', 'ListView'],
      states: { loading: 'spinner', empty: 'CTA', error: 'retry', content: 'list' },
    }));

  it('clamps 20 screens to 12 with a diagnostic log entry', async () => {
    callLLMJsonStrictMock.mockResolvedValue({
      screens: makeScreens(20),
      userFlows: [{ id: 'main', name: 'Main flow', steps: ['Home', 'Detail'] }],
      navigation: 'bottom_tabs',
    });

    const result = await runUXResearchAgent(baseState());

    expect(result.screenGraph?.screens).toHaveLength(12);
    expect(result.logs?.join('\n')).toMatch(/screenscap/i);
    expect(result.diagnostics?.some((d: GateDiagnostic) => /screenscap/i.test(d.message))).toBe(true);
  });

  it('pads to a minimum of 3 screens when the model returns fewer', async () => {
    callLLMJsonStrictMock.mockResolvedValue({
      screens: makeScreens(1),
      userFlows: [],
      navigation: 'drawer',
    });

    const result = await runUXResearchAgent(baseState());

    expect(result.screenGraph?.screens.length).toBeGreaterThanOrEqual(3);
  });
});

describe('DesignSystemAgent — color and font hard-clamping', () => {
  it('falls back to Material 3 neutrals for invalid hex colors and unknown fonts', async () => {
    callLLMJsonStrictMock.mockResolvedValue({
      primaryColor: 'not-a-color',
      secondaryColor: '#12345',
      accentColor: '#ZZZZZZ',
      backgroundColor: 'rgba(0,0,0,0.5)',
      surfaceColor: 'blue',
      fontFamily: 'Comic Sans',
      useMaterial3: false,
      isDarkPreferred: false,
      borderRadius: 999,
      colorRationale: 'vibes',
      typography: { display: 'd', headline: 'h', body: 'b', label: 'l' },
      spacingScale: [4, 8],
      componentStyle: 'filled',
    });

    const result = await runDesignSystemAgent(baseState());
    const tokens = result.designTokens!;

    expect(tokens.primaryColor).toBe('#6750A4');
    expect(tokens.secondaryColor).toBe('#625B71');
    expect(tokens.accentColor).toBe('#7D5260');
    expect(tokens.backgroundColor).toBe('#FFFBFE');
    expect(tokens.surfaceColor).toBe('#F3EDF7');
    expect(allHex(tokens as unknown as Record<string, unknown>)).toBe(true);
    expect(tokens.fontFamily).toBe('Inter');
    expect(tokens.useMaterial3).toBe(true);
    expect(tokens.borderRadius).toBe(60);
    expect(result.diagnostics?.some((d: GateDiagnostic) => /design token/i.test(d.message))).toBe(true);
  });

  it('keeps valid tokens untouched, including Satoshi font', async () => {
    callLLMJsonStrictMock.mockResolvedValue({
      primaryColor: '#047857',
      secondaryColor: '#10B981',
      accentColor: '#F59E0B',
      backgroundColor: '#FFFAFA',
      surfaceColor: '#FFFFFF',
      fontFamily: 'Satoshi',
      useMaterial3: true,
      isDarkPreferred: false,
      borderRadius: 14,
      colorRationale: 'calm',
      typography: { display: 'd', headline: 'h', body: 'b', label: 'l' },
      spacingScale: [4, 8, 16],
      componentStyle: 'filled',
    });

    const result = await runDesignSystemAgent(baseState());
    const tokens = result.designTokens!;

    expect(tokens.primaryColor).toBe('#047857');
    expect(tokens.surfaceColor).toBe('#FFFFFF');
    expect(tokens.fontFamily).toBe('Satoshi');
    expect(tokens.borderRadius).toBe(14);
    expect(result.diagnostics).toHaveLength(0);
  });
});

describe('FeaturePlannerAgent — build plan integrity', () => {
  it('prunes phantom file dependencies in phases and drops phases referencing only phantoms', async () => {
    callLLMJsonStrictMock.mockResolvedValue({
      files: [
        { path: 'pubspec.yaml', purpose: 'manifest', action: 'create' },
        { path: 'lib/main.dart', purpose: 'entry', action: 'create' },
        { path: 'lib/app/app.dart', purpose: 'app widget', action: 'create' },
      ],
      phases: [
        { id: 'foundation', label: 'Foundation', files: ['pubspec.yaml', 'lib/main.dart', 'lib/phantom_file.dart'], gateAfter: 'App boots' },
        { id: 'ghost', label: 'Ghost phase', files: ['lib/never_planned.dart'], gateAfter: 'never' },
      ],
      dependencies: { go_router: '^14.2.0' },
      milestones: ['App boots'],
    });

    const result = await runFeaturePlannerAgent(baseState());
    const plan = result.plan!;

    const fileSet = new Set(plan.files.map((f) => f.path));
    for (const phase of plan.phases) {
      for (const ref of phase.files) {
        expect(fileSet.has(ref)).toBe(true);
      }
    }
    expect(plan.phases.map((p) => p.id)).toEqual(['foundation']);
    expect(plan.phases[0].files).toEqual(['pubspec.yaml', 'lib/main.dart']);
    expect(result.diagnostics?.some((d: GateDiagnostic) => /phantom/i.test(d.message))).toBe(true);
  });

  it('caps build plans larger than 60 files to 60 with a diagnostic note', async () => {
    const files = Array.from({ length: 70 }, (_, i) => ({
      path: `lib/generated/file_${String(i).padStart(2, '0')}.dart`,
      purpose: `File ${i}`,
      action: 'create' as const,
    }));
    callLLMJsonStrictMock.mockResolvedValue({
      files,
      phases: [{ id: 'all', label: 'All', files: files.map((f) => f.path), gateAfter: 'done' }],
      dependencies: {},
      milestones: ['done'],
    });

    const result = await runFeaturePlannerAgent(baseState());
    const plan = result.plan!;

    expect(plan.files).toHaveLength(60);
    expect(result.logs?.join('\n')).toMatch(/60/);
    expect(result.diagnostics?.some((d: GateDiagnostic) => /capped to 60/i.test(d.message))).toBe(true);
    const fileSet = new Set(plan.files.map((f) => f.path));
    for (const phase of plan.phases) {
      for (const ref of phase.files) expect(fileSet.has(ref)).toBe(true);
    }
  });

  it('falls back to a non-empty structural plan when the model emits no files', async () => {
    callLLMJsonStrictMock.mockResolvedValue({
      files: [],
      phases: [],
      dependencies: {},
      milestones: [],
    });

    const result = await runFeaturePlannerAgent(baseState({
      screenGraph: {
        screens: [
          {
            id: 'home', name: 'HomeScreen', route: '/', purpose: 'home', primaryAction: 'go',
            states: { loading: 'l', empty: 'e', error: 'x', content: 'c' }, widgets: ['Card'],
          },
        ],
        userFlows: [],
      },
    }));

    expect(result.plan!.files.length).toBeGreaterThan(0);
    expect(result.plan!.phases.length).toBeGreaterThan(0);
  });

  it('derives a content-stable plan id (no timestamps)', async () => {
    const canned = {
      files: [
        { path: 'pubspec.yaml', purpose: 'manifest', action: 'create' as const },
        { path: 'lib/main.dart', purpose: 'entry', action: 'create' as const },
      ],
      phases: [{ id: 'foundation', label: 'Foundation', files: ['pubspec.yaml', 'lib/main.dart'], gateAfter: 'boots' }],
      dependencies: {},
      milestones: ['boots'],
    };
    callLLMJsonStrictMock.mockResolvedValue(canned);

    const first = await runFeaturePlannerAgent(baseState());
    const second = await runFeaturePlannerAgent(baseState());

    expect(first.plan!.id).toMatch(/^plan_[0-9a-f]{8}$/);
    expect(second.plan!.id).toBe(first.plan!.id);
  });
});

describe('DataModelAgent — schema hardening', () => {
  const supabaseState = () =>
    baseState({
      architectureSpec: {
        stateManagement: 'provider',
        navigationType: 'tabs',
        features: ['home'],
        packages: {},
        backendMode: 'supabase',
      },
      _intakeData: { needsSupabase: true, domain: 'general', keyFeatures: ['Todos'] },
    } as Partial<ProjectState>);

  it('coerces bad column types to text and normalizes table names', async () => {
    callLLMJsonStrictMock.mockResolvedValue({
      tables: [
        {
          name: 'Shop Items!',
          description: 'weird name',
          columns: [
            { name: 'id', type: 'UUID' },
            { name: 'title', type: 'varchar(255)', isNullable: false },
            { name: 'price', type: 'DOUBLE PRECISION' },
            { name: 'created_at', type: 'TIMESTAMPTZ', defaultValue: 'NOW()' },
          ],
          policies: [{ name: 'read_all', action: 'SELECT', rule: 'true' }],
          indexes: [],
        },
      ],
      migrations: [],
      relationships: [],
    });

    const result = await runDataModelAgent(supabaseState());
    const table = result.dataSchema!.tables[0];

    expect(table.name).toBe('shop_items');
    expect(table.columns.find((c) => c.name === 'title')?.type).toBe('text');
    expect(table.columns.find((c) => c.name === 'price')?.type).toBe('text');
    expect(table.columns.find((c) => c.name === 'created_at')?.type).toBe('timestamptz');
    // Existing id column is detected as the primary key
    expect(table.columns.find((c) => c.name === 'id')?.isPrimary).toBe(true);
    // RLS defaults to true for Supabase-backed apps
    expect(table.enableRLS).toBe(true);
  });

  it('drops policies with empty rule SQL and emits a diagnostic', async () => {
    callLLMJsonStrictMock.mockResolvedValue({
      tables: [
        {
          name: 'profiles',
          description: 'user profiles',
          columns: [{ name: 'id', type: 'uuid', isPrimary: true }],
          // note: enableRLS intentionally omitted → must default to true
          policies: [
            { name: 'owner_select', action: 'SELECT', rule: '   ' },
            { name: 'owner_update', action: 'UPDATE', rule: 'auth.uid() = id' },
            { name: 'garbled', action: 'READ_ALL', rule: '' },
          ],
          indexes: [],
        },
      ],
      migrations: [],
      relationships: [],
    });

    const result = await runDataModelAgent(supabaseState());
    const table = result.dataSchema!.tables[0];

    expect(table.enableRLS).toBe(true);
    expect(table.policies).toHaveLength(1);
    expect(table.policies[0].name).toBe('owner_update');
    const policyDiagnostics = result.diagnostics!.filter((d: GateDiagnostic) => /policy/i.test(d.message) && d.level === 'warning');
    expect(policyDiagnostics.length).toBeGreaterThanOrEqual(2);
  });

  it('synthesizes an id uuid PRIMARY KEY when a table has no primary key', async () => {
    callLLMJsonStrictMock.mockResolvedValue({
      tables: [
        {
          name: 'widgets',
          description: 'no pk here',
          columns: [
            { name: 'label', type: 'text' },
            { name: 'count', type: 'integer' },
          ],
          enableRLS: true,
          policies: [],
          indexes: [],
        },
      ],
      migrations: [],
      relationships: [],
    });

    const result = await runDataModelAgent(supabaseState());
    const table = result.dataSchema!.tables[0];

    expect(table.columns[0].name).toBe('id');
    expect(table.columns[0].type).toBe('uuid');
    expect(table.columns[0].isPrimary).toBe(true);
    expect(result.diagnostics!.some((d: GateDiagnostic) => /primary key/i.test(d.message))).toBe(true);
  });

  it('emits an empty schema for local-only apps (no supabase context)', async () => {
    const result = await runDataModelAgent(baseState());
    expect(result.dataSchema?.tables).toEqual([]);
  });
});

describe('Determinism — identical canned responses produce identical state', () => {
  it('architecture agent output is byte-identical across runs', async () => {
    const canned = {
      stateManagement: 'bloc',
      navigationType: 'drawer',
      folderStructure: ['lib/', 'lib/features/home/'],
      features: ['home', 'settings'],
      packages: { go_router: '^14.2.0', provider: '^6.1.2' },
      backendMode: 'local',
      rationale: 'stable',
    };
    callLLMJsonStrictMock.mockResolvedValue(canned);

    const first = await runArchitectureAgent(baseState());
    const second = await runArchitectureAgent(baseState());

    expect(second).toEqual(first);
  });

  it('design system agent output is byte-identical across runs', async () => {
    const canned = {
      primaryColor: '#112233',
      secondaryColor: '#445566',
      accentColor: '#778899',
      backgroundColor: '#FFFFFF',
      surfaceColor: '#F1F1F1',
      fontFamily: 'Panchang',
      useMaterial3: true,
      isDarkPreferred: true,
      borderRadius: 8,
      colorRationale: 'stable',
      typography: { display: 'd', headline: 'h', body: 'b', label: 'l' },
      spacingScale: [4, 8, 16],
      componentStyle: 'outlined',
    };
    callLLMJsonStrictMock.mockResolvedValue(canned);

    const first = await runDesignSystemAgent(baseState());
    const second = await runDesignSystemAgent(baseState());

    expect(second).toEqual(first);
  });
});

describe('IntakeAgent + architecture coordination via ProductBrief.constraints', () => {
  it('records a supabase constraint when the prompt asks for it, and architecture honors it', async () => {
    callLLMJsonStrictMock.mockResolvedValue(
      cannedIntake({ needsSupabase: false, constraints: ['Material 3 compliance'] }),
    );

    const intakeResult = await runIntakeAgent(
      baseState({ userPrompt: 'Build a shop app with supabase for auth and orders' }),
    );

    expect(intakeResult.productBrief?.constraints.some((c) => /supabase/i.test(c))).toBe(true);

    callLLMJsonStrictMock.mockResolvedValue({
      stateManagement: 'provider',
      navigationType: 'tabs',
      folderStructure: ['lib/'],
      features: ['shop'],
      packages: { provider: '^6.1.2' },
      backendMode: 'local',
      rationale: 'model prefers local',
    });

    const archState = baseState();
    archState.productBrief = intakeResult.productBrief!;
    (archState as Record<string, unknown>)._intakeData = intakeResult._intakeData;

    const archResult = await runArchitectureAgent(archState);
    expect(archResult.architectureSpec?.backendMode).toBe('supabase');
  });

  it('defaults platforms to [android] when the model emits garbage, and constraints to []', async () => {
    callLLMJsonStrictMock.mockResolvedValue(
      cannedIntake({ platforms: ['toaster', 'fridge'], constraints: 'not-an-array' }),
    );

    const result = await runIntakeAgent(baseState({ userPrompt: 'build something' }));

    expect(result.productBrief?.platforms).toEqual(['android']);
    expect(result.productBrief?.constraints).toEqual([]);
  });

  it('keeps valid platform entries and sanitizes an invalid color palette', async () => {
    callLLMJsonStrictMock.mockResolvedValue(
      cannedIntake({ platforms: ['Android', 'web', 'toaster'], colorPalette: 'rgb(10,20,30)' }),
    );

    const result = await runIntakeAgent(baseState({ userPrompt: 'build something' }));

    expect([...result.productBrief!.platforms].sort()).toEqual(['android', 'web']);
    expect(result.designTokens?.primaryColor).toBe('#6750A4');
    expect(result.diagnostics!.some((d: GateDiagnostic) => /color palette/i.test(d.message))).toBe(true);
  });
});
