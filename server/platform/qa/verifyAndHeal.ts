/**
 * `verify.heal` — the closed loop from a red project to a repaired one.
 *
 * Phase 3 of the roadmap as one durable DAG run:
 *
 *   verify  ──▶  heal (loop: analyze → plan → repair → re-analyze)  ──▶  revise
 *
 * The `heal` step is the only unbounded part and is bounded internally
 * (`maxCycles`, oscillation detection via the healing policy). Every cycle is
 * emitted as an event and audited, so a 4 a.m. failure is fully reconstructible.
 *
 * The step is at-least-once: if the worker dies mid-cycle, the whole heal
 * step re-runs from the initial analysis. That is safe by construction — the
 * healing invoker is a model turn edited into the same workspace either way,
 * and `verify` is idempotent on a clean workspace.
 */
import {
  PlatformError,
  describeError,
} from '../kernel/errors.js';
import {
  planRepair,
  fingerprint,
  rankDiagnostics,
  type RepairPolicy,
} from './index.js';
import type { Diagnostic as QaDiagnostic } from './diagnostics.js';
import type { WorkflowDefinition, StepContext } from '../workflow/engine.js';
import type { AuditLog } from '../audit/auditLog.js';
import { normalizeDiagnosticPath } from './diagnostics.js';
import { getProjectWorkspace } from '../../harness/run.js';

export interface VerifyHealInput {
  projectId: string;
  /** 0..5 repair cycles; 0 means "analyze and plan only, never invoke". Default 3. */
  maxCycles?: number;
  /** When false (default), the run stops after producing the repair brief. */
  invokeRepair?: boolean;
  /** Skip project scanning and use these files instead. */
  files?: Array<{ path: string; content: string }>;
}

export interface VerifyLikeResult {
  verified: boolean;
  skipped: boolean;
  summary: string;
  diagnostics: Array<{
    filePath?: string;
    path?: string;
    line: number;
    column: number;
    severity: 'error' | 'warning' | 'info';
    code: string;
    message: string;
  }>;
}

export interface VerifyHealDeps {
  verify: (input: { projectId: string; files: Array<{ path: string; content: string }> }) => Promise<VerifyLikeResult>;
  snapshot?: (projectRoot: string) => Promise<Map<string, { content: string }>>;
  /** Workspace path resolution for the project. */
  projectRoot: (projectId: string) => string;
  /**
   * Execute one repair turn (typically one harness `dsh` session in edit
   * mode). Throwing fails the heal step; returning `applied: false` aborts
   * further cycles with the brief attached.
   */
  invokeRepair?: (params: { projectId: string; summary: string; brief: string; targets: string[]; attempt: number }) => Promise<{ applied: boolean; summary: string }>;
  audit?: AuditLog;
}

const MAX_DIAGNOSTICS = 40;
const MAX_CYCLES_CEILING = 5;

export function createVerifyHealWorkflow(deps: VerifyHealDeps): WorkflowDefinition {
  const maxFromInput = (raw: unknown): number => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return 3;
    return Math.min(MAX_CYCLES_CEILING, Math.floor(parsed));
  };

  return {
    name: 'verify.heal',
    version: 1,
    displayName: 'Verify and self-heal (dart analyze · repair plan · re-verify)',
    description:
      'Runs the verification gate against a project, builds a deterministic repair brief from the structured analyzer diagnostics, and optionally invokes one repair turn per cycle until the gate is green or the policy stops it (max cycles / oscillation / unsafe target).',
    steps: [
      {
        id: 'verify',
        description: 'Snapshot the project (or accept provided files) and run the verification gate.',
        timeoutMs: 10 * 60_000,
        retry: { maxAttempts: 1 },
        run: async (ctx) => {
          const input = ctx.input as VerifyHealInput;
          const files = await collectFiles(deps, input);
          if (files.length === 0) {
            throw new PlatformError({ code: 'VERIFY_NO_FILES', message: 'The project contains no files to verify.', statusCode: 422 });
          }
          const result = await deps.verify({ projectId: input.projectId, files });
          const diagnostics = normalizeDiagnostics(result.diagnostics);
          await ctx.emit('verify.completed', {
            verdict: verdictOf(result),
            diagnostics: diagnostics.length,
            blockers: diagnostics.filter((d) => d.severity === 'error').length,
            summary: result.summary,
          });
          await deps.audit?.append({
            tenantId: ctx.tenantId,
            actor: ctx.actor,
            action: 'verify.run',
            resourceType: 'project',
            resourceId: input.projectId,
            metadata: { verdict: verdictOf(result), diagnostics: diagnostics.length },
          });
          return { verdict: verdictOf(result), diagnostics, summary: result.summary };
        },
      },
      {
        id: 'heal',
        dependsOn: ['verify'],
        description: 'Plan-and-repair loop bounded by the healing policy.',
        when: (_input, outputs) => (outputs.verify as { verdict?: string } | undefined)?.verdict === 'failed',
        timeoutMs: 30 * 60_000,
        retry: { maxAttempts: 1 },
        run: (ctx) => runHealLoop(ctx, deps, maxFromInput((ctx.input as VerifyHealInput)?.maxCycles)),
      },
      {
        id: 'revise',
        dependsOn: ['heal'],
        description: 'Seal a new immutable revision when a heal turn mutated the workspace.',
        when: (_input, outputs) => Boolean((outputs.heal as { appliedCycles?: number } | undefined)?.appliedCycles),
        timeoutMs: 60_000,
        retry: { maxAttempts: 1 },
        run: async (ctx) => {
          // Sealing is a separate definition so this DAG stays single-purpose;
          // callers who need a revision invoke the `revise` step of patch.apply.
          await ctx.emit('heal.revision_recommended', { reason: 'Workspace changed during healing.' });
          return { revisionSealedBy: 'caller' };
        },
      },
    ],
  };
}

async function runHealLoop(ctx: StepContext, deps: VerifyHealDeps, maxCycles: number): Promise<unknown> {
  const input = ctx.input as VerifyHealInput;
  const verifyStepOutput = (ctx.outputs.verify as { diagnostics: QaDiagnostic[] }) ?? { diagnostics: [] };
  let current = verifyStepOutput.diagnostics;
  const history: string[][] = [fingerprintsOf(current)];
  const invoke = input.invokeRepair === true && deps.invokeRepair !== undefined && maxCycles > 0;

  let appliedCycles = 0;
  let brief = '';
  let lastVerdict = 'failed';

  // Zero budget: produce the deterministic brief without entering the loop.
  if (maxCycles <= 0) {
    const plan = planRepair({ diagnostics: current, cycle: 1, history });
    return {
      verdict: 'needs_repair',
      cycles: 0,
      appliedCycles: 0,
      brief: plan.brief,
      targets: plan.targets.map((target) => target.path),
    };
  }

  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const policy: Partial<RepairPolicy> | undefined = maxCycles !== undefined ? { maxCycles } : undefined;
    const plan = planRepair({ diagnostics: current, cycle, history, policy });

    if (plan.shouldRepair) {
      brief = plan.brief;
      const targets = plan.targets.map((target) => target.path);
      await ctx.emit('heal.cycle', {
        cycle,
        strategy: plan.strategy,
        targets,
        shouldRepair: true,
        sourceErrors: current.filter((d) => d.severity === 'error').length,
      });
      await deps.audit?.append({
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        action: 'heal.cycle',
        resourceType: 'project',
        resourceId: input.projectId,
        metadata: { cycle, strategy: plan.strategy, targets },
      });

      if (!deps.invokeRepair || !invoke) {
        // Deterministic stop: the brief is ready for a human or for the
        // generation endpoints to drive the repair turn.
        return { verdict: 'needs_repair', cycles: cycle, appliedCycles, brief, targets };
      }

      const outcome = await deps.invokeRepair({ projectId: input.projectId, summary: `Repair cycle ${cycle}`, brief, targets, attempt: cycle });
      appliedCycles += 1;
      if (!outcome.applied) {
        return { verdict: 'needs_human', cycles: cycle, appliedCycles, brief, targets, invokeSummary: outcome.summary };
      }
    } else {
      switch (plan.stopReason) {
        case 'NOTHING_TO_REPAIR':
          return { verdict: 'needs_human', cycles: cycle - 1, appliedCycles, brief, diagnostics: current };
        case 'UNSAFE_TARGET':
          throw new PlatformError({ code: 'HEAL_UNSAFE_TARGET', message: 'The repair plan targets a path outside the workspace; refusing to edit.', statusCode: 422, details: { brief: plan.brief } });
        case 'OSCILLATION':
        default:
          throw new PlatformError({ code: 'HEAL_OSCILLATION', message: 'The same diagnostics keep returning despite repair attempts; oscillation detected.', statusCode: 422, details: { brief: plan.brief } });
      }
    }

    // Re-verify after the repair turn, then feed this cycle's diagnostics forward.
    const fresh = await freshSnapshot(deps, input);
    const reverified = await deps.verify({ projectId: input.projectId, files: fresh });
    current = normalizeDiagnostics(reverified.diagnostics);
    history.push(fingerprintsOf(current));
    lastVerdict = verdictOf(reverified);

    await ctx.emit('heal.reverified', {
      cycle,
      verdict: lastVerdict,
      remainingBlockers: current.filter((d) => d.severity === 'error').length,
    });

    if (lastVerdict === 'passed') {
      return { verdict: 'repaired', cycles: cycle, appliedCycles, remainingBlockers: 0 };
    }
  }

  throw new PlatformError({
    code: 'HEAL_EXHAUSTED',
    message: `Automated repair exhausted its ${maxCycles} cycle(s) without a green verification gate.`,
    statusCode: 422,
    details: { appliedCycles, remainingBlockers: current.filter((d) => d.severity === 'error').length, brief },
  });
}

function fingerprintsOf(diagnostics: QaDiagnostic[]): string[] {
  return [...new Set(diagnostics.map((diagnostic) => fingerprint(diagnostic)))].sort();
}

async function collectFiles(deps: VerifyHealDeps, input: VerifyHealInput): Promise<Array<{ path: string; content: string }>> {
  if (Array.isArray(input.files) && input.files.length > 0) {
    return input.files
      .filter((file) => file && typeof file.path === 'string' && typeof file.content === 'string')
      .map((file) => ({ path: file.path, content: file.content }));
  }
  const root = deps.projectRoot(input.projectId);
  const snapshot = deps.snapshot ? await deps.snapshot(root) : await defaultSnapshot(root);
  return [...snapshot.entries()].map(([filePath, entry]) => ({ path: filePath, content: entry.content }));
}

async function freshSnapshot(deps: VerifyHealDeps, input: VerifyHealInput): Promise<Array<{ path: string; content: string }>> {
  // A repair turn mutates the workspace, so re-verification must always read
  // the live tree — never the (stale) pre-repair file list from the input.
  const root = deps.projectRoot(input.projectId);
  const snapshot = deps.snapshot ? await deps.snapshot(root) : await defaultSnapshot(root);
  return [...snapshot.entries()].map(([filePath, entry]) => ({ path: filePath, content: entry.content }));
}

async function defaultSnapshot(root: string): Promise<Map<string, { content: string }>> {
  // Lazily loaded: the harness module is the same layer this runs in.
  const { snapshotFiles } = await import('../../harness/workspace.js');
  const snapshot = await snapshotFiles(root);
  const result = new Map<string, { content: string }>();
  for (const [filePath, entry] of snapshot.entries()) {
    if (typeof entry.content === 'string') result.set(filePath, { content: entry.content });
  }
  return result;
}

function normalizeDiagnostics(raw: VerifyLikeResult['diagnostics']): QaDiagnostic[] {
  const result: QaDiagnostic[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const record = entry as Record<string, unknown>;
    const pathValue = typeof record.path === 'string' ? record.path : typeof record.filePath === 'string' ? String(record.filePath) : '';
    const normalized = normalizeDiagnosticPath(pathValue);
    if (!normalized) continue;
    result.push({
      path: normalized,
      line: Number(record.line) || 1,
      column: Number(record.column) || 1,
      severity: record.severity === 'error' || record.severity === 'warning' || record.severity === 'info' ? record.severity : 'error',
      code: String(record.code ?? 'ANALYZER'),
      message: String(record.message ?? ''),
      source: 'analyzer',
    });
    if (result.length >= MAX_DIAGNOSTICS) break;
  }
  return rankDiagnostics(result);
}

function verdictOf(result: VerifyLikeResult | undefined): 'passed' | 'skipped' | 'failed' {
  if (!result) return 'failed';
  if (result.skipped) return 'skipped';
  return result.verified ? 'passed' : 'failed';
}

/**
 * Live wiring used by the server composition root. Kept separate from the
 * workflow factory so tests never touch the harness.
 */
export function createLiveVerifyHealDeps(platform: { audit?: AuditLog }): VerifyHealDeps {
  return {
    projectRoot: (projectId) => getProjectWorkspace(projectId),
    verify: async ({ projectId, files }) => {
      const { verifyProject } = await import('../../harness/verify.js');
      const result = await verifyProject({
        projectId,
        files: files as Array<{ path: string; content: string }>,
      });
      return {
        verified: result.verified,
        skipped: result.skipped,
        summary: result.summary,
        diagnostics: result.diagnostics.map((diagnostic) => ({
          filePath: diagnostic.filePath,
          line: diagnostic.line,
          column: diagnostic.column,
          severity: diagnostic.severity,
          code: diagnostic.code,
          message: diagnostic.message,
        })),
      };
    },
    invokeRepair: async ({ projectId, brief, attempt }) => {
      const { runGeneration } = await import('../../harness/run.js');
      const emit = () => undefined;
      try {
        await runGeneration({
          projectId,
          prompt: [
            'Repair the following analyzer diagnostics. Change only what is needed;',
            'do not restructure unrelated files, do not bump dependencies, do not invent packages.',
            '',
            brief,
          ].join('\n'),
          isIncremental: true,
          fresh: false,
          buildErrors: brief.split('\n').slice(0, 40),
          emit,
        });
        return { applied: true, summary: `Repair turn ${attempt} dispatched to the harness.` };
      } catch (error) {
        throw new PlatformError({
          code: 'HEAL_INVOKE_FAILED',
          message: describeError(error).message.slice(0, 500),
          statusCode: 502,
          cause: error,
        });
      }
    },
    audit: platform.audit,
  };
}

