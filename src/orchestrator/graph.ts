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
import {
  classifyStepFailure,
  hashErrorDiagnostics,
  MAX_IDENTICAL_DIAGNOSTIC_SETS,
  MAX_REPAIR_CYCLES,
} from './pipelinePolicy';

export type PipelineProgressCallback = (phase: string, message: string, state: ProjectState) => void;

export interface PipelineOptions {
  /**
   * Optional cancellation signal. Checked before every step (including
   * QA/repair); when aborted, the pipeline stops early: state.status is set
   * to 'failed', "Aborted by user" is logged, a `failed` progress event is
   * emitted and the failed state is returned (no exception is thrown).
   */
  signal?: AbortSignal;
}

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
 * Internal sentinel used to unwind the pipeline when the user aborts.
 * Never escapes execute(): the outer catch turns it into a graceful
 * return of the failed state.
 */
class PipelineAbortError extends Error {
  constructor() {
    super('Aborted by user');
    this.name = 'PipelineAbortError';
  }
}

/**
 * LovableGenerationPipeline — the core 12-agent AI generation graph.
 * Each agent calls real LLMs via OpenRouter and passes structured output
 * to the next agent via the shared ProjectState blackboard.
 *
 * Failure semantics are governed by ./pipelinePolicy (CRITICAL_STEPS abort
 * the run, best-effort steps are tolerated, everything else is bounded by a
 * hard MAX_REPAIR_CYCLES cap plus an oscillation guard on the diagnostic
 * hash). Final statuses are deterministic: 'ready' only when QA reports zero
 * error diagnostics, 'repaired' when fixes were applied and QA is green
 * afterwards, 'failed' otherwise.
 */
export class LovableGenerationPipeline {
  public static async execute(
    projectId: string,
    userPrompt: string,
    onProgress?: PipelineProgressCallback,
    options?: PipelineOptions
  ): Promise<ProjectState> {
    const signal = options?.signal;
    let state = createInitialProjectState(projectId, userPrompt);

    const totalSteps = PIPELINE_STEPS.length;
    let stepIndex = 0;

    const step = async (
      phaseId: string,
      fn: (s: ProjectState) => Promise<Partial<ProjectState>> | Partial<ProjectState>
    ): Promise<boolean> => {
      stepIndex++;
      const info = PIPELINE_STEPS.find((p) => p.id === phaseId);
      const label = info ? `${info.emoji} ${info.label}` : phaseId;

      // ── Cancellation: checked before any work is started ──
      if (signal?.aborted) {
        state = {
          ...state,
          status: 'failed',
          logs: [...state.logs, 'Aborted by user'],
          failure: { stepId: phaseId, message: 'Aborted by user' },
        };
        onProgress?.('failed', 'Aborted by user', state);
        throw new PipelineAbortError();
      }

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
        return true;
      } catch (err) {
        if (err instanceof PipelineAbortError) {
          throw err;
        }
        const classified = classifyStepFailure(phaseId, err);

        if (classified.fatal) {
          // CRITICAL_STEPS: abort the pipeline — status 'failed', error entry
          // naming the step, failed progress with the message, then throw.
          const fatalLog = `[${phaseId}] Fatal: ${classified.message}`;
          state = {
            ...state,
            status: 'failed',
            logs: [...state.logs, fatalLog],
            failure: { stepId: phaseId, message: classified.message },
          };
          onProgress?.('failed', fatalLog, state);
          throw err;
        }

        // Non-critical / best-effort: log and continue.
        const message = classified.message;
        const errorLog = `[${phaseId}] Error: ${message}`;
        state = {
          ...state,
          logs: [...state.logs, errorLog],
        };
        onProgress?.(phaseId, errorLog, state);
        return false;
      }
    };

    try {
      state.status = 'generating';

      // ── Phase 1: Discovery ────────────────────────────────────────────
      // Note: agents are typed as (state) => ... — none of the current QA /
      // repair agents accept an AbortSignal, so no signal can be threaded into
      // their signatures without modifying them. Cancellation is enforced for
      // those steps by the signal check at the top of step() instead.
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
      // Bounded independently of state.repairAttempts: a local hard cap plus an
      // oscillation guard over the error-diagnostic hash. QA/repair agents do
      // not accept an AbortSignal (checked their signatures), so the signal is
      // enforced here via the step() pre-check instead of being threaded in.
      let repairCycles = 0;
      let lastDiagnosticHash: string | null = null;
      let identicalHashCount = 0;
      let oscillationDetected = false;
      let qaStepFailed = false;
      let repairStepFailed = false;

      for (;;) {
        const qaOk = await step('qa-validation', runQAValidationAgent);
        if (!qaOk) {
          // The QA agent itself failed (non-fatal by policy). We cannot verify
          // the generated app, so we must not claim success — break out and let
          // the deterministic verdict logic below mark the run as failed.
          qaStepFailed = true;
          break;
        }

        const errorDiagnostics = state.diagnostics.filter((d) => d.level === 'error');
        if (errorDiagnostics.length === 0) {
          break;
        }

        // Oscillation guard: hash the current error diagnostic set
        // (severity|code|filePath|message, lowercased). Two consecutive
        // identical sets mean repair made no progress — stop early instead of
        // burning the remaining cycles on the same failure.
        const hash = hashErrorDiagnostics(errorDiagnostics);
        identicalHashCount = hash === lastDiagnosticHash ? identicalHashCount + 1 : 1;
        lastDiagnosticHash = hash;
        if (identicalHashCount >= MAX_IDENTICAL_DIAGNOSTIC_SETS) {
          oscillationDetected = true;
          break;
        }

        if (repairCycles >= MAX_REPAIR_CYCLES) {
          break;
        }

        onProgress?.(
          'repair',
          `🔧 Repair cycle ${repairCycles + 1}/${MAX_REPAIR_CYCLES} — fixing ${errorDiagnostics.length} errors...`,
          state
        );
        const repairOk = await step('repair', runRepairAgent);
        if (!repairOk) {
          // Repair threw (non-fatal by policy). Count the cycle anyway so the
          // local hard cap and the oscillation guard bound the loop — no
          // infinite spinning on a broken repair agent.
          repairStepFailed = true;
        }
        repairCycles++;
      }

      // ── Deterministic final verdict ─────────────────────────────────────
      const remainingErrors = state.diagnostics.filter((d) => d.level === 'error');

      if (qaStepFailed) {
        const message = '[qa-validation] QA validation failed — unable to verify the generated app. Marking the run as failed.';
        state = {
          ...state,
          status: 'failed',
          logs: [...state.logs, message],
          failure: { stepId: 'qa-validation', message },
        };
        onProgress?.('failed', message, state);
      } else if (remainingErrors.length === 0 && !oscillationDetected) {
        if (repairCycles > 0) {
          state.status = 'repaired';
          onProgress?.(
            'ready',
            `✅ Generated ${state.generatedFiles.size} Flutter files with self-healing repairs. App is ready.`,
            state
          );
        } else {
          state.status = 'ready';
          onProgress?.(
            'ready',
            `✅ All ${state.generatedFiles.size} files generated and validated! App is ready.`,
            state
          );
        }
      } else {
        state.status = 'failed';
        const errors = remainingErrors.map((d) => d.message).join('; ');
        const message = oscillationDetected
          ? `⚠️ Repair halted: identical error diagnostics across ${MAX_IDENTICAL_DIAGNOSTIC_SETS} consecutive QA runs — no repair progress. Unresolved issues after ${repairCycles} repair cycle(s). Issues: ${errors}`
          : `⚠️ Completed with ${remainingErrors.length} unresolved issues after ${repairCycles} repair cycle(s). Issues: ${errors}`;
        const failureMessage = repairStepFailed
          ? `${message} (last repair step failed — see logs)`
          : message;
        state = {
          ...state,
          logs: [...state.logs, `[qa-validation] ${failureMessage}`],
          failure: { stepId: 'qa-validation', message: failureMessage },
        };
        onProgress?.('failed', failureMessage, state);
      }

      return state;
    } catch (err) {
      if (err instanceof PipelineAbortError) {
        // User cancellation: the failed state (status, log, failed progress)
        // was already applied inside step(); return it gracefully.
        return state;
      }
      // CRITICAL_STEPS failures were already classified, logged, emitted and
      // reflected in state.status = 'failed' inside step(). Rethrow so the
      // caller knows the run did not complete.
      throw err;
    }
  }
}
