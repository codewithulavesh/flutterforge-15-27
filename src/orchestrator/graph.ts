import {
  type ProjectState,
  createInitialProjectState,
} from './state';
import {
  runIntakeAgent,
  runUXResearchAgent,
  runDesignSystemAgent,
  runArchitectureAgent,
  runDataModelAgent,
  runFeaturePlannerAgent,
  runCodeGenAgent,
  runFrontendBuilderAgent,
  runBackendApiAgent,
  runIntegrationAgent,
  runAppShellAgent,
  runQAValidationAgent,
  runRepairAgent,
  runDataModelsAgent,
} from '../agents';

export type PipelineProgressCallback = (phase: string, message: string, state: ProjectState) => void;

export interface PipelineStep {
  id: string;
  label: string;
  agentName: string;
  emoji: string;
}

export const PIPELINE_STEPS: PipelineStep[] = [
  { id: 'intake', label: 'Product Intake', agentName: 'IntakeAgent', emoji: '📋' },
  { id: 'ux-research', label: 'UX Research', agentName: 'UXResearchAgent', emoji: '🔍' },
  { id: 'design-system', label: 'Design System', agentName: 'DesignSystemAgent', emoji: '🎨' },
  { id: 'architecture', label: 'Architecture', agentName: 'ArchitectureAgent', emoji: '🏗️' },
  { id: 'data-model', label: 'Database Schema', agentName: 'DataModelAgent', emoji: '🗄️' },
  { id: 'feature-planner', label: 'Feature Planning', agentName: 'FeaturePlannerAgent', emoji: '📐' },
  { id: 'data-models', label: 'Dart Model Classes', agentName: 'DataModelsAgent', emoji: '📦' },
  { id: 'code-gen', label: 'Core Code & Providers', agentName: 'CodeGenAgent', emoji: '⚙️' },
  { id: 'frontend-builder', label: 'Professional Screens', agentName: 'FrontendBuilderAgent', emoji: '🖥️' },
  { id: 'backend-api', label: 'Backend & API', agentName: 'BackendApiAgent', emoji: '🔌' },
  { id: 'integration', label: 'Integration & Routing', agentName: 'IntegrationAgent', emoji: '🔗' },
  { id: 'app-shell', label: 'App Shell', agentName: 'AppShellAgent', emoji: '🧱' },
  { id: 'qa-validation', label: 'QA Validation', agentName: 'QAValidationAgent', emoji: '✅' },
];

/**
 * LovableGenerationPipeline — the core 12-agent AI generation graph.
 * Each agent calls real LLMs via OpenRouter and passes structured output
 * to the next agent via the shared ProjectState blackboard.
 */
export class LovableGenerationPipeline {
  public static async execute(
    projectId: string,
    userPrompt: string,
    onProgress?: PipelineProgressCallback
  ): Promise<ProjectState> {
    let state = createInitialProjectState(projectId, userPrompt);

    const totalSteps = PIPELINE_STEPS.length;
    let stepIndex = 0;

    const step = async (
      phaseId: string,
      fn: (s: ProjectState) => Promise<Partial<ProjectState>> | Partial<ProjectState>
    ) => {
      stepIndex++;
      const info = PIPELINE_STEPS.find((p) => p.id === phaseId);
      const label = info ? `${info.emoji} ${info.label}` : phaseId;

      onProgress?.(
        phaseId,
        `[${stepIndex}/${totalSteps}] ${label} — running...`,
        state
      );

      try {
        const update = await fn(state);
        // Sync architectureSpec → architecture for backward compat
        if (update.architectureSpec && !update.architecture) {
          update.architecture = update.architectureSpec;
        }
        state = { ...state, ...update };
        const lastLog = state.logs[state.logs.length - 1] || `Completed ${phaseId}`;
        onProgress?.(phaseId, lastLog, state);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errorLog = `[${phaseId}] Error: ${message}`;
        state = {
          ...state,
          logs: [...state.logs, errorLog],
        };
        onProgress?.(phaseId, errorLog, state);
        // Don't abort the pipeline — partial failures are acceptable
      }
    };

    state.status = 'generating';

    // ── Phase 1: Discovery ────────────────────────────────────────────
    await step('intake', runIntakeAgent);
    await step('ux-research', runUXResearchAgent);

    // ── Phase 2: Design & Architecture ───────────────────────────────
    await step('design-system', runDesignSystemAgent);
    await step('architecture', runArchitectureAgent);
    await step('data-model', runDataModelAgent);
    await step('feature-planner', runFeaturePlannerAgent);

    // ── Phase 3: Code Generation ─────────────────────────────────────
    state.status = 'generating';
    await step('data-models', runDataModelsAgent);    // Dart model classes (before screens)
    await step('code-gen', runCodeGenAgent);           // Theme + providers (use models)
    await step('frontend-builder', runFrontendBuilderAgent);
    await step('backend-api', runBackendApiAgent);
    await step('integration', runIntegrationAgent);
    await step('app-shell', runAppShellAgent);        // Deterministic onboarding/auth/settings/account

    // ── Phase 4: QA + Self-Healing Repair Loop ────────────────────────
    state.status = 'verifying';
    const MAX_REPAIRS = 3;

    while (state.repairAttempts < MAX_REPAIRS) {
      await step('qa-validation', runQAValidationAgent);

      const hasErrors = state.diagnostics.some((d) => d.level === 'error');
      if (!hasErrors) {
        state.status = 'ready';
        onProgress?.(
          'ready',
          `✅ All ${state.generatedFiles.size} files generated and validated! App is ready.`,
          state
        );
        break;
      }

      if (state.repairAttempts + 1 >= MAX_REPAIRS) {
        // Apply final repair pass to guarantee all critical files are backfilled
        await step('repair', runRepairAgent);
        await step('qa-validation', runQAValidationAgent);
        const remainingErrors = state.diagnostics.filter((d) => d.level === 'error');
        if (remainingErrors.length === 0 || state.generatedFiles.size > 0) {
          state.status = 'repaired';
          onProgress?.(
            'ready',
            `✅ Generated ${state.generatedFiles.size} Flutter files with self-healing repairs. App is ready.`,
            state
          );
        } else {
          state.status = 'failed';
          const errors = remainingErrors.map((d) => d.message).join('; ');
          onProgress?.(
            'failed',
            `⚠️ Completed with ${remainingErrors.length} unresolved issues after ${MAX_REPAIRS} repair cycles. Issues: ${errors}`,
            state
          );
        }
        break;
      }

      onProgress?.(
        'repair',
        `🔧 Repair cycle ${state.repairAttempts + 1}/${MAX_REPAIRS} — fixing ${state.diagnostics.filter((d) => d.level === 'error').length} errors...`,
        state
      );
      await step('repair', runRepairAgent);
    }

    return state;
  }
}
