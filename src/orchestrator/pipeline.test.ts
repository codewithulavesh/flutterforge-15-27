import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GateDiagnostic, ProjectState } from './state';

// ── Mock every agent via vi.mock('../agents') — no LLM calls ──────────────
const mocks = vi.hoisted(() => ({
  runIntakeAgent: vi.fn(),
  runUXResearchAgent: vi.fn(),
  runDesignSystemAgent: vi.fn(),
  runArchitectureAgent: vi.fn(),
  runDataModelAgent: vi.fn(),
  runFeaturePlannerAgent: vi.fn(),
  runDataModelsAgent: vi.fn(),
  runCodeGenAgent: vi.fn(),
  runFrontendBuilderAgent: vi.fn(),
  runBackendApiAgent: vi.fn(),
  runIntegrationAgent: vi.fn(),
  runAppShellAgent: vi.fn(),
  runQAValidationAgent: vi.fn(),
  runRepairAgent: vi.fn(),
}));

vi.mock('../agents', () => ({
  runIntakeAgent: mocks.runIntakeAgent,
  runUXResearchAgent: mocks.runUXResearchAgent,
  runDesignSystemAgent: mocks.runDesignSystemAgent,
  runArchitectureAgent: mocks.runArchitectureAgent,
  runDataModelAgent: mocks.runDataModelAgent,
  runFeaturePlannerAgent: mocks.runFeaturePlannerAgent,
  runDataModelsAgent: mocks.runDataModelsAgent,
  runCodeGenAgent: mocks.runCodeGenAgent,
  runFrontendBuilderAgent: mocks.runFrontendBuilderAgent,
  runBackendApiAgent: mocks.runBackendApiAgent,
  runIntegrationAgent: mocks.runIntegrationAgent,
  runAppShellAgent: mocks.runAppShellAgent,
  runQAValidationAgent: mocks.runQAValidationAgent,
  runRepairAgent: mocks.runRepairAgent,
}));

import { LovableGenerationPipeline, PIPELINE_STEPS } from './graph';

const errDiag = (message: string, gate = 'G1-critical-files', filePath = 'pubspec.yaml'): GateDiagnostic => ({
  gate,
  level: 'error',
  filePath,
  message,
});

const allAgentMocks = () => [
  mocks.runIntakeAgent,
  mocks.runUXResearchAgent,
  mocks.runDesignSystemAgent,
  mocks.runArchitectureAgent,
  mocks.runDataModelAgent,
  mocks.runFeaturePlannerAgent,
  mocks.runDataModelsAgent,
  mocks.runCodeGenAgent,
  mocks.runFrontendBuilderAgent,
  mocks.runBackendApiAgent,
  mocks.runIntegrationAgent,
  mocks.runAppShellAgent,
  mocks.runQAValidationAgent,
  mocks.runRepairAgent,
];

function resetAgentMocks() {
  vi.clearAllMocks();
  // Default: every generative step succeeds with a no-op partial state.
  const noop = async () => ({});
  mocks.runIntakeAgent.mockImplementation(noop);
  mocks.runUXResearchAgent.mockImplementation(noop);
  mocks.runDesignSystemAgent.mockImplementation(noop);
  mocks.runArchitectureAgent.mockImplementation(noop);
  mocks.runDataModelAgent.mockImplementation(noop);
  mocks.runFeaturePlannerAgent.mockImplementation(noop);
  mocks.runDataModelsAgent.mockImplementation(noop);
  mocks.runCodeGenAgent.mockImplementation(noop);
  mocks.runFrontendBuilderAgent.mockImplementation(noop);
  mocks.runBackendApiAgent.mockImplementation(noop);
  mocks.runIntegrationAgent.mockImplementation(noop);
  mocks.runAppShellAgent.mockImplementation(noop);
  // Default: QA is clean.
  mocks.runQAValidationAgent.mockImplementation(
    async (state: ProjectState) => ({ diagnostics: [], logs: [...state.logs, '[QA] clean'] })
  );
  // Default: repair bumps repairAttempts (like the real agent).
  mocks.runRepairAgent.mockImplementation(
    async (state: ProjectState) => ({
      repairAttempts: state.repairAttempts + 1,
      generatedFiles: state.generatedFiles,
      logs: [...state.logs, '[Repair] cycle done'],
    })
  );
}

beforeEach(resetAgentMocks);

describe('LovableGenerationPipeline — failure semantics', () => {
  it('1. fatal intake failure stops the pipeline, no later agents run, status=failed', async () => {
    mocks.runIntakeAgent.mockRejectedValue(new Error('Intake LLM unreachable'));
    const onProgress = vi.fn();

    await expect(
      LovableGenerationPipeline.execute('proj-1', 'build a todo app', onProgress)
    ).rejects.toThrow('Intake LLM unreachable');

    // No later agent may run
    for (const mock of allAgentMocks()) {
      if (mock === mocks.runIntakeAgent) continue;
      expect(mock).not.toHaveBeenCalled();
    }

    // A failed progress event was emitted, naming the step, status='failed'
    const failedCalls = onProgress.mock.calls.filter((call) => call[0] === 'failed');
    expect(failedCalls).toHaveLength(1);
    expect(failedCalls[0][1]).toContain('intake');
    expect(failedCalls[0][1]).toContain('Intake LLM unreachable');
    expect(failedCalls[0][2].status).toBe('failed');
    expect(
      failedCalls[0][2].logs.some((l: string) => l.startsWith('[intake] Fatal:'))
    ).toBe(true);
  });

  it('2. QA error → repair → QA green → repaired (repairAttempts increments)', async () => {
    let qaCalls = 0;
    mocks.runQAValidationAgent.mockImplementation(async (state: ProjectState) => {
      qaCalls += 1;
      if (qaCalls === 1) {
        return { diagnostics: [errDiag('Missing pubspec')], logs: [...state.logs, '[QA] 1 error'] };
      }
      return { diagnostics: [], logs: [...state.logs, '[QA] clean'] };
    });

    const events: Array<[string, string]> = [];
    const state = await LovableGenerationPipeline.execute(
      'proj-2',
      'build a todo app',
      (phase, message) => events.push([phase, message])
    );

    expect(state.status).toBe('repaired');
    expect(state.repairAttempts).toBe(1);
    expect(mocks.runRepairAgent).toHaveBeenCalledTimes(1);
    expect(mocks.runQAValidationAgent).toHaveBeenCalledTimes(2);
    // 'ready' phase was used for the repaired verdict
    expect(events.some(([phase]) => phase === 'ready')).toBe(true);
    expect(state.diagnostics.filter((d) => d.level === 'error')).toHaveLength(0);
  });

  it('3. identical QA failure twice in a row with no progress → bounded stop with failure', async () => {
    const onProgress = vi.fn();
    // Same diagnostic every time: repair makes no progress.
    mocks.runQAValidationAgent.mockImplementation(async (state: ProjectState) => ({
      diagnostics: [errDiag('G1-critical-files: Critical file missing or empty: pubspec.yaml')],
      logs: [...state.logs, '[QA] same error again'],
    }));

    const state = await LovableGenerationPipeline.execute('proj-3', 'build a todo app', onProgress);

    expect(state.status).toBe('failed');
    // Loop must be bounded: QA ran exactly twice (original + one confirmation)
    expect(mocks.runQAValidationAgent).toHaveBeenCalledTimes(2);
    // Repair ran at most once — no infinite spinning
    expect(mocks.runRepairAgent).toHaveBeenCalledTimes(1);
    expect(state.repairAttempts).toBe(1);
    const failedCalls = onProgress.mock.calls.filter((call) => call[0] === 'failed');
    expect(failedCalls).toHaveLength(1);
    expect(failedCalls[0][1]).toMatch(/identical|no progress|halted/i);
  });

  it('4. hard cap reaches 3 even if QA keeps returning different errors', async () => {
    let qaCalls = 0;
    // Every QA run returns a *different* error, so the oscillation guard never triggers.
    mocks.runQAValidationAgent.mockImplementation(async (state: ProjectState) => {
      qaCalls += 1;
      return { diagnostics: [errDiag(`Distinct failure #${qaCalls}`)], logs: [...state.logs] };
    });

    const state = await LovableGenerationPipeline.execute('proj-4', 'build a todo app');

    expect(state.status).toBe('failed');
    expect(mocks.runRepairAgent).toHaveBeenCalledTimes(3);
    expect(state.repairAttempts).toBe(3);
    // 4 QA runs: initial + one after each repair cycle
    expect(mocks.runQAValidationAgent).toHaveBeenCalledTimes(4);
  });

  it('5. abort signal stops the pipeline deterministically', async () => {
    const controller = new AbortController();
    mocks.runIntakeAgent.mockImplementation(async (state: ProjectState) => {
      controller.abort(); // abort while intake is running; intake completes
      return { logs: [...state.logs, '[Intake] done'] };
    });

    const state = await LovableGenerationPipeline.execute(
      'proj-5',
      'build a todo app',
      undefined,
      { signal: controller.signal }
    );

    expect(state.status).toBe('failed');
    expect(state.logs).toContain('Aborted by user');
    // Nothing after intake may run
    expect(mocks.runUXResearchAgent).not.toHaveBeenCalled();
    expect(mocks.runDesignSystemAgent).not.toHaveBeenCalled();
    expect(mocks.runQAValidationAgent).not.toHaveBeenCalled();

    // A pre-aborted signal stops before any agent runs at all
    resetAgentMocks();
    const preAborted = new AbortController();
    preAborted.abort();
    const state2 = await LovableGenerationPipeline.execute(
      'proj-5b',
      'build a todo app',
      undefined,
      { signal: preAborted.signal }
    );
    expect(state2.status).toBe('failed');
    expect(state2.logs).toContain('Aborted by user');
    for (const mock of allAgentMocks()) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it('6. final ready only when QA diagnostics are clean', async () => {
    // Scenario A: clean QA → ready
    const ready = await LovableGenerationPipeline.execute('proj-6a', 'build a todo app');
    expect(ready.status).toBe('ready');
    expect(ready.diagnostics.filter((d) => d.level === 'error')).toHaveLength(0);

    // Scenario B: errors persist even with files present → must NOT be ready/repaired
    let qaCalls = 0;
    mocks.runQAValidationAgent.mockImplementation(async (state: ProjectState) => {
      qaCalls += 1;
      // Always a fresh, distinct error → oscillation guard never triggers
      return { diagnostics: [errDiag(`Persistent failure #${qaCalls}`)], logs: [...state.logs] };
    });
    mocks.runRepairAgent.mockImplementation(async (state: ProjectState) => ({
      repairAttempts: state.repairAttempts + 1,
      // Repair "fixes" files — generatedFiles.size > 0 must NOT mask errors
      generatedFiles: new Map([
        ...state.generatedFiles,
        [
          'lib/main.dart',
          { path: 'lib/main.dart', content: '// substantial flutter main with runApp(const App());', action: 'created' as const, language: 'dart' },
        ],
      ]),
      logs: [...state.logs, '[Repair] applied'],
    }));

    const failed = await LovableGenerationPipeline.execute('proj-6b', 'build a todo app');
    expect(failed.generatedFiles.size).toBeGreaterThan(0);
    expect(failed.diagnostics.filter((d) => d.level === 'error').length).toBeGreaterThan(0);
    expect(failed.status).toBe('failed');
    expect(failed.status).not.toBe('repaired');
    expect(failed.status).not.toBe('ready');
  });

  it('7. existing PIPELINE_STEPS ordering preserved', () => {
    expect(PIPELINE_STEPS.map((s) => s.id)).toEqual([
      'intake',
      'ux-research',
      'design-system',
      'architecture',
      'data-model',
      'feature-planner',
      'data-models',
      'code-gen',
      'frontend-builder',
      'backend-api',
      'integration',
      'app-shell',
      'qa-validation',
    ]);
    // Every step keeps id/label/agentName/emoji shape
    for (const step of PIPELINE_STEPS) {
      expect(step.id).toBeTruthy();
      expect(step.label).toBeTruthy();
      expect(step.agentName).toBeTruthy();
      expect(step.emoji).toBeTruthy();
    }
  });
});
