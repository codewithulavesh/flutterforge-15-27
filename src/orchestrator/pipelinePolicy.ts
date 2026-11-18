/**
 * Explicit failure policy for the LovableGenerationPipeline.
 *
 * Previously every agent error was swallowed ("partial failures are
 * acceptable"), which let a pipeline with fatal failures fall through to a
 * success-ish status. This module makes the policy explicit and testable:
 *
 *  - CRITICAL_STEPS: a failure ABORTS the pipeline run. The runner sets
 *    state.status = 'failed', appends an error entry naming the step,
 *    emits a `failed` progress event and throws out of execute().
 *  - BEST_EFFORT_STEPS: a failure is tolerated — logged and the pipeline
 *    continues. Empty by default: nothing is best-effort unless explicitly
 *    whitelisted here.
 *  - Steps in neither set (qa-validation, repair) are non-fatal and are
 *    governed by the bounded repair loop (MAX_REPAIR_CYCLES + an oscillation
 *    guard on the error-diagnostic hash), never by state.repairAttempts.
 */

import type { GateDiagnostic } from './state';

/** Steps whose failure aborts the whole pipeline run. */
export const CRITICAL_STEPS: ReadonlySet<string> = new Set<string>([
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
]);

/** Steps whose failure is tolerated (logged, pipeline continues). Empty by default. */
export const BEST_EFFORT_STEPS: ReadonlySet<string> = new Set<string>();

/** Hard cap on self-healing repair cycles, independent of state.repairAttempts. */
export const MAX_REPAIR_CYCLES = 3;

/** Number of consecutive identical error-diagnostic sets tolerated before declaring no progress. */
export const MAX_IDENTICAL_DIAGNOSTIC_SETS = 2;

/** Maximum length of a classified failure message. */
export const MAX_FAILURE_MESSAGE_LENGTH = 300;

export interface StepFailure {
  fatal: boolean;
  stepId: string;
  message: string;
  cause?: unknown;
}

function truncateMessage(message: string, maxLength: number = MAX_FAILURE_MESSAGE_LENGTH): string {
  if (message.length <= maxLength) {
    return message;
  }
  return message.slice(0, maxLength);
}

/**
 * Classify a step failure according to the explicit policy.
 *
 * fatal === true  → the pipeline must abort: status 'failed', error entry
 *                   naming the step, failed progress emitted, execute() throws.
 * fatal === false → log and continue (non-critical / best-effort work).
 *
 * The message is always truncated to MAX_FAILURE_MESSAGE_LENGTH (300) chars.
 */
export function classifyStepFailure(stepId: string, error: unknown): StepFailure {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = truncateMessage(rawMessage || 'Unknown error');

  const fatal = !BEST_EFFORT_STEPS.has(stepId) && CRITICAL_STEPS.has(stepId);

  return {
    fatal,
    stepId,
    message,
    cause: error,
  };
}

/**
 * Stable, order-insensitive hash of the current error diagnostic set.
 *
 * Each entry is normalized as `severity|code|filePath|message` (lowercased).
 * `code` maps to the diagnostic's `gate` (or an optional `code` property when
 * present). Entries are sorted before hashing so reordering diagnostics does
 * not change the digest. Used by the repair loop's oscillation guard: two
 * consecutive identical hashes mean repair made no progress.
 */
export function hashErrorDiagnostics(diagnostics: ReadonlyArray<GateDiagnostic>): string {
  const normalized = diagnostics
    .map((diagnostic) => {
      const severity = String(diagnostic.level ?? '').toLowerCase();
      const rawCode = (diagnostic as GateDiagnostic & { code?: unknown }).code ?? diagnostic.gate ?? '';
      const code = String(rawCode).toLowerCase();
      const filePath = String(diagnostic.filePath ?? diagnostic.file ?? '').toLowerCase();
      const message = String(diagnostic.message ?? '').toLowerCase();
      return `${severity}|${code}|${filePath}|${message}`;
    })
    .sort();

  const joined = normalized.join('::');
  // FNV-1a (32-bit) — deterministic, dependency-free, good enough to detect
  // identical consecutive diagnostic sets.
  let hash = 0x811c9dc5;
  for (let i = 0; i < joined.length; i += 1) {
    hash ^= joined.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
