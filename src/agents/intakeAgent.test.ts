import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ProjectState } from '../orchestrator/state';
import { runIntakeAgent } from './intakeAgent';

const { callLLMJsonStrictMock } = vi.hoisted(() => ({
  callLLMJsonStrictMock: vi.fn(),
}));

vi.mock('./llmClient', () => ({
  callLLMJsonStrict: callLLMJsonStrictMock,
  agentModelFor: () => 'test-model',
}));

const PROMPT = `Project: ApexAdmin
Build a production-grade Flutter Admin Dashboard app called "ApexAdmin".
Platform: web
Backend: None — local only (no auth, no database, no SQL)
State Management: provider
Theme Mode: dark
Do NOT use Supabase or any backend. Keep state local. No SQL, no auth screens, no service layer.`;

const WRONG_LLM_OUTPUT = {
  appName: 'Production',
  oneLiner: 'An ecommerce app',
  targetAudience: 'Shoppers',
  primaryProblem: 'Selling products',
  domain: 'ecommerce',
  platforms: ['web', 'android', 'ios'],
  constraints: ['Supabase backend requested (auth/database/realtime)'],
  keyFeatures: ['Products', 'Cart', 'Checkout'],
  screens: ['SplashScreen', 'HomeScreen', 'DetailScreen'],
  stateManagement: 'bloc',
  needsSupabase: true,
  colorPalette: '#7C3AED',
};

function baseState(): ProjectState {
  return {
    projectId: 'p1',
    userPrompt: PROMPT,
    status: 'planning',
    productBrief: {
      appName: '',
      oneLiner: '',
      targetAudience: '',
      primaryProblem: '',
      platforms: [],
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
  };
}

beforeEach(() => {
  callLLMJsonStrictMock.mockReset();
  callLLMJsonStrictMock.mockResolvedValue(WRONG_LLM_OUTPUT);
});

describe('IntakeAgent — explicit prompt intent overrides model guesses', () => {
  it('uses the declared app name, domain, platform, state management and dark theme', async () => {
    const result = await runIntakeAgent(baseState());

    expect(result.productBrief?.appName).toBe('ApexAdmin');
    expect((result as Record<string, unknown>)._intakeData).toMatchObject({
      domain: 'general',
      platforms: ['web'],
      stateManagement: 'provider',
      needsSupabase: false,
    });
    expect(result.designTokens?.isDarkPreferred).toBe(true);
    expect(result.productBrief?.constraints.some((c) => /supabase/i.test(c))).toBe(false);
    expect((result.logs ?? []).join('\n')).toMatch(/Domain: "general" \| App: "ApexAdmin".*Supabase: false/);
  });

  it('keeps the same result when the LLM call fails and the keyword fallback runs', async () => {
    callLLMJsonStrictMock.mockRejectedValue(new Error('offline'));

    const result = await runIntakeAgent(baseState());

    expect(result.productBrief?.appName).toBe('ApexAdmin');
    expect((result as Record<string, unknown>)._intakeData).toMatchObject({
      domain: 'general',
      needsSupabase: false,
    });
    expect(result.productBrief?.constraints.some((c) => /supabase/i.test(c))).toBe(false);
  });

  it('preserves a genuine Supabase request', async () => {
    const state = baseState();
    state.userPrompt = 'Build a group chat app using Supabase auth and a Postgres database';
    callLLMJsonStrictMock.mockResolvedValue({ ...WRONG_LLM_OUTPUT, needsSupabase: false });

    const result = await runIntakeAgent(state);

    expect((result as Record<string, unknown>)._intakeData).toMatchObject({
      needsSupabase: true,
    });
    expect(result.productBrief?.constraints.some((c) => /supabase/i.test(c))).toBe(true);
  });
});
