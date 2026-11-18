/**
 * `app.forge` — the durable "any prompt → top app" pipeline.
 *
 * Steps are idempotent and deterministic from the persisted step outputs: the
 * spec is the durable artifact, and every later step re-derives the file set
 * from it rather than passing megabytes of source through SQLite. A process
 * restart between `verify` and `seal` therefore converges to exactly the same
 * project, byte for byte.
 *
 * Failure semantics are fail-closed and attributable:
 *   plan    → GENERATION_SPEC_INVALID          (422) — the prompt could not be compiled/validated
 *   emit    → GENERATION_STRUCTURE_FAILED      (422) — emitted project is not internally complete
 *   score   → GENERATION_QUALITY_BELOW_THRESHOLD (422) — below the top-app bar
 *   verify  → GENERATION_VERIFY_FAILED         (422) — the real Flutter analyzer rejected it
 *   seal    → PROJECT_NOT_EMPTY                (409) — refused to overwrite an existing project
 *
 * Nothing is written to the workspace until every gate is green.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { WorkflowDefinition } from '../workflow/engine.js';
import { PlatformError, ValidationError } from '../kernel/errors.js';
import { applyPatch, type PatchInput } from '../patch/transaction.js';
import { getProjectWorkspace } from '../../harness/run.js';
import { compileSpec } from './spec/index.js';
import { enrichSpec, type EnrichResult } from './spec/enrich.js';
import { validateSpec } from './emit/shared.js';
import { emitAndCheck } from './emit/index.js';
import { scoreProject } from './quality/index.js';
import { analyzeGate } from './gate/index.js';
import type { AppSpec, CompileInput, GeneratedFile, QualityReport, GateResult } from './contracts.js';
import { MIN_TOP_APP_QUALITY } from './contracts.js';
import { createLlmProvider, type LlmProvider } from '../ai/index.js';
import type { LlmComplete } from './contracts.js';

export interface AppForgeInput {
  projectId: string;
  prompt: string;
  appName?: string;
  packageName?: string;
  seedColor?: string;
  backend?: 'local' | 'supabase';
  /** Force a domain instead of inferring from the prompt. */
  domain?: CompileInput['domain'];
  seedCount?: number;
  /** Minimum quality score required to seal. Defaults to MIN_TOP_APP_QUALITY. */
  minQuality?: number;
  /** Allow sealing into a non-empty workspace (destroys the previous generated app). */
  force?: boolean;
}

export interface AppForgeDeps {
  dataDir: string;
  transactionRoot: string;
  compile?: (input: CompileInput) => AppSpec;
  /**
   * Optional enrichment. Accepts either an AppSpec or an `{ spec }` result.
   * It must never throw; the workflow treats any failure as "base spec stands".
   */
  enrich?: (spec: AppSpec, llm?: LlmComplete) => Promise<AppSpec | EnrichResult> | AppSpec | EnrichResult;
  emit?: (spec: AppSpec) => { files: GeneratedFile[]; problems: string[] };
  score?: (spec: AppSpec, files: GeneratedFile[]) => QualityReport;
  analyze?: (input: { projectId: string; spec: AppSpec; files: GeneratedFile[] }) => Promise<GateResult>;
  llm?: LlmComplete;
  minQuality?: number;
}

function normalizeSpec(input: unknown): AppSpec {
  const spec = input as AppSpec | null | undefined;
  if (!spec || typeof spec !== 'object') {
    throw new PlatformError({ code: 'GENERATION_SPEC_INVALID', message: 'compile() returned no spec.', statusCode: 422 });
  }
  const validation = validateSpec(spec);
  if (!validation.ok) {
    throw new PlatformError({
      code: 'GENERATION_SPEC_INVALID',
      message: `The compiled app spec is invalid: ${validation.errors.slice(0, 6).join('; ')}`,
      statusCode: 422,
      details: { errors: validation.errors },
    });
  }
  return spec;
}

function asEnrichResult(value: AppSpec | EnrichResult): { spec: AppSpec; enriched: boolean; notes: string[] } {
  if (value && typeof value === 'object' && 'spec' in value && (value as EnrichResult).spec) {
    const result = value as EnrichResult;
    return { spec: result.spec, enriched: Boolean(result.enriched), notes: Array.isArray(result.notes) ? result.notes : [] };
  }
  return { spec: value as AppSpec, enriched: true, notes: [] };
}

async function workspaceEntries(projectId: string): Promise<string[]> {
  const workspace = getProjectWorkspace(projectId);
  try {
    return (await fs.readdir(workspace)).filter((entry) => entry !== '.flutterforge');
  } catch {
    return [];
  }
}

export function createAppForgeWorkflow(deps: AppForgeDeps): WorkflowDefinition {
  const minQuality = deps.minQuality ?? MIN_TOP_APP_QUALITY;
  const compile = deps.compile ?? ((input: CompileInput) => compileSpec(input));
  const emit = deps.emit ?? emitAndCheck;
  const score = deps.score ?? ((spec: AppSpec, files: GeneratedFile[]) => scoreProject(spec, files));
  const analyze =
    deps.analyze
    ?? (({ projectId, spec, files }: { projectId: string; spec: AppSpec; files: GeneratedFile[] }) =>
      analyzeGate({ projectId, spec, files }));

  return {
    name: 'app.forge',
    version: 1,
    displayName: 'Forge an app from a prompt (spec → emit → score → verify → seal)',
    description:
      'Compiles a free-text prompt into a typed AppSpec, emits a zero-dependency Flutter project, scores it against the top-app rubric, proves it with the real Flutter analyzer, and seals it into the workspace atomically.',
    steps: [
      {
        id: 'plan',
        description: 'Compile and validate the typed AppSpec (deterministic; optional LLM enrichment).',
        timeoutMs: 150_000,
        retry: { maxAttempts: 1 },
        run: async (ctx) => {
          const input = ctx.input as AppForgeInput;
          const projectId = String(input?.projectId ?? '').trim();
          if (!projectId) throw new ValidationError('projectId is required.', { field: 'projectId' });
          const prompt = String(input?.prompt ?? '').trim();
          if (!prompt) throw new ValidationError('prompt is required.', { field: 'prompt' });

          const compiled = compile({
            prompt,
            appName: input?.appName,
            packageName: input?.packageName,
            seedColor: input?.seedColor,
            backend: input?.backend,
            domain: input?.domain,
            seedCount: input?.seedCount,
          });

          let spec = normalizeSpec(compiled);
          let enriched = false;
          let notes: string[] = [];
          if (deps.enrich) {
            try {
              const raw = await deps.enrich(spec, deps.llm);
              const result = asEnrichResult(raw);
              // Re-validate: enrichment may not weaken a previously valid spec.
              const candidate = normalizeSpec(result.spec);
              spec = candidate;
              enriched = result.enriched;
              notes = result.notes.slice(0, 30);
            } catch (error) {
              // Failure-safe: the deterministic compiler output is the floor.
              notes = [`enrichment skipped: ${error instanceof Error ? error.message : String(error)}`];
            }
          }

          await ctx.emit('app.spec', {
            appName: spec.app.name,
            domain: spec.app.domain,
            entities: spec.entities.map((entity) => entity.name),
            screens: spec.screens.map((screen) => ({ id: screen.id, kind: screen.kind, route: screen.route })),
            enriched,
            notes,
          });
          // Only the spec is persisted; downstream steps re-emit from it.
          return { spec, enriched, notes };
        },
      },
      {
        id: 'emit',
        dependsOn: ['plan'],
        description: 'Materialize the full project from the spec (pure, deterministic).',
        timeoutMs: 30_000,
        retry: { maxAttempts: 1 },
        run: async (ctx) => {
          const plan = ctx.outputs.plan as { spec: AppSpec };
          const spec = normalizeSpec(plan?.spec);
          const { files, problems } = emit(spec);
          if (problems.length > 0) {
            throw new PlatformError({
              code: 'GENERATION_STRUCTURE_FAILED',
              message: `Generated project is not internally complete: ${problems.slice(0, 6).join('; ')}`,
              statusCode: 422,
              details: { problems },
            });
          }
          const bytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
          await ctx.emit('app.emitted', { fileCount: files.length, bytes, layers: countLayers(files) });
          return { fileCount: files.length, bytes, layers: countLayers(files) };
        },
      },
      {
        id: 'score',
        dependsOn: ['emit'],
        description: 'Score the project against the top-app rubric; fail below the threshold.',
        timeoutMs: 30_000,
        retry: { maxAttempts: 1 },
        run: async (ctx) => {
          const plan = ctx.outputs.plan as { spec: AppSpec };
          const spec = normalizeSpec(plan?.spec);
          const input = ctx.input as AppForgeInput;
          const threshold = typeof input?.minQuality === 'number' ? input.minQuality : minQuality;
          const { files } = emit(spec);
          const report = score(spec, files);
          if (report.total < threshold) {
            throw new PlatformError({
              code: 'GENERATION_QUALITY_BELOW_THRESHOLD',
              message: `Generated app scored ${report.total}/100 (grade ${report.grade}), below the required ${threshold}.`,
              statusCode: 422,
              details: {
                total: report.total,
                grade: report.grade,
                threshold,
                categories: report.categories,
                findings: report.findings
                  .filter((finding) => finding.severity !== 'info')
                  .slice(0, 8)
                  .map(({ severity, code, message, path: filePath }) => ({ severity, code, message, path: filePath })),
              },
            });
          }
          await ctx.emit('app.scored', { total: report.total, grade: report.grade });
          return { report };
        },
      },
      {
        id: 'verify',
        dependsOn: ['score'],
        description: 'Prove the project with the real Flutter analyzer (fail-closed when unavailable).',
        timeoutMs: 10 * 60_000,
        retry: { maxAttempts: 1 },
        run: async (ctx) => {
          const plan = ctx.outputs.plan as { spec: AppSpec };
          const spec = normalizeSpec(plan?.spec);
          const input = ctx.input as AppForgeInput;
          const { files } = emit(spec);
          const gate = await analyze({ projectId: input.projectId, spec, files });
          if (!gate.passed) {
            throw new PlatformError({
              code: 'GENERATION_VERIFY_FAILED',
              message: `The generated project did not pass verification: ${gate.blockers.slice(0, 3).join('; ')}`,
              statusCode: 422,
              details: { gate: gate.gate, blockers: gate.blockers },
            });
          }
          await ctx.emit('app.verified', { summary: gate.detail ?? 'verification passed', errorCount: 0 });
          return { gate };
        },
      },
      {
        id: 'seal',
        dependsOn: ['verify'],
        description: 'Atomically seal the verified project into the workspace (two-phase commit).',
        timeoutMs: 2 * 60_000,
        retry: { maxAttempts: 1 },
        run: async (ctx) => {
          const plan = ctx.outputs.plan as { spec: AppSpec };
          const spec = normalizeSpec(plan?.spec);
          const input = ctx.input as AppForgeInput;
          const existing = await workspaceEntries(input.projectId);
          if (existing.length > 0 && input.force !== true) {
            throw new PlatformError({
              code: 'PROJECT_NOT_EMPTY',
              message: 'Workspace is not empty — refusing to overwrite it. Re-run with force=true to replace it.',
              statusCode: 409,
              details: { projectId: input.projectId, files: existing.slice(0, 10) },
            });
          }
          const { files } = emit(spec);
          const workspace = getProjectWorkspace(input.projectId);
          const result = await applyPatch({
            transactionRoot: deps.transactionRoot,
            workspaceRoot: workspace,
            actor: ctx.actor,
            message: `forge: ${spec.app.name}`.slice(0, 200),
            files: files.map((file): PatchInput => ({ path: file.path, content: file.content })),
          });
          await ctx.emit('app.sealed', {
            transactionId: result.transactionId,
            fileCount: result.filesWritten,
            appName: spec.app.name,
          });
          return { transactionId: result.transactionId, workspace, filesWritten: result.filesWritten };
        },
      },
    ],
  };
}

function countLayers(files: GeneratedFile[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    const layer = file.layer ?? 'shell';
    counts[layer] = (counts[layer] ?? 0) + 1;
  }
  return counts;
}

export interface AppForgeDefaultDepsPlatform {
  dataDir: string;
  transactionRoot: string;
  /** Optional server-side LLM for spec enrichment; ignored when absent. */
  llm?: LlmComplete;
  minQuality?: number;
}

/**
 * Wire the real modules. Enrichment is **opt-in**: it runs only when the
 * operator sets `FLUTTERFORGE_LLM_ENRICH=1`, because a misconfigured or
 * unreachable provider would otherwise make every run race the plan deadline.
 * It is additive and failure-safe; without it, the deterministic compiler
 * stands alone.
 */
export function appForgeDefaultDeps(platform: AppForgeDefaultDepsPlatform): AppForgeDeps {
  const wantsEnrichment = process.env.FLUTTERFORGE_LLM_ENRICH === '1';
  const provider = platform.llm
    ? platform.llm
    : wantsEnrichment
      ? createLlmProvider({ projectId: undefined, tenantId: undefined })
      : undefined;
  // An injected llm is trusted; a provider created from the environment only
  // participates when it is configured and reachable.
  const llm = provider && (platform.llm || (provider as LlmProvider).available) ? provider : undefined;
  return {
    dataDir: platform.dataDir,
    transactionRoot: platform.transactionRoot,
    llm,
    minQuality: platform.minQuality,
    enrich: llm
      ? async (spec: AppSpec, maybeLlm?: LlmComplete) =>
          enrichSpec(spec, maybeLlm ?? llm, { maxTokens: 6000, timeoutMs: 30_000 })
      : undefined,
  };
}

/** Convenience path used by tests and by the smoke harness. */
export function forgeWorkspacePath(projectId: string): string {
  return path.join(getProjectWorkspace(projectId));
}
