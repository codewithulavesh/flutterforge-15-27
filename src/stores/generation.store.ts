import { create } from 'zustand';

/**
 * Client for the generation lane (`/api/platform/generation/*` and the
 * durable workflow run endpoints). The platform is local-first, so no auth
 * headers are attached. Every action folds failures into `error` and resolves
 * `{ ok: false }` — components never need a try/catch.
 */

/** Must match `server/platform/generation/contracts.ts` (types are duplicated
 *  because the frontend bundle must not import server code). */
export const SPEC_VERSION = 1 as const;
export const MIN_TOP_APP_QUALITY = 80 as const;
export const POLL_INTERVAL_MS = 2_000;

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

export type GenerationDomain = AppDomain | 'auto';
export type GenerationBackend = 'local' | 'supabase';
export type GenerationTarget = 'web' | 'android-apk' | 'android-aab' | 'ios-archive';

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
  name: string;
  type: FieldType;
  required: boolean;
  values?: string[];
  target?: string;
  primary?: boolean;
  label?: string;
}

export interface EntitySpec {
  name: string;
  plural: string;
  description: string;
  fields: FieldSpec[];
  searchField?: string;
  sortField?: string;
}

export type ScreenKind =
  | 'dashboard'
  | 'list'
  | 'detail'
  | 'form'
  | 'chat'
  | 'profile'
  | 'settings'
  | 'onboarding';

export interface ScreenSpec {
  id: string;
  title: string;
  route: string;
  kind: ScreenKind;
  purpose: string;
  entity?: string;
  primaryAction?: string;
  inNavigation?: boolean;
  icon?: string;
}

export interface FlowStep {
  screenId: string;
  action: string;
}

export interface FlowSpec {
  id: string;
  name: string;
  steps: FlowStep[];
}

export interface DesignSpec {
  seedColor: string;
  accentColor?: string;
  brightness: 'light' | 'dark' | 'system';
  spacing: number[];
  radii: { sm: number; md: number; lg: number; xl: number };
  motionMs: number;
  shape: 'rounded' | 'soft' | 'square';
}

export interface AppSpec {
  version: typeof SPEC_VERSION;
  app: {
    name: string;
    packageName: string;
    tagline: string;
    description: string;
    domain: AppDomain;
  };
  audience: { primary: string; secondary?: string };
  entities: EntitySpec[];
  screens: ScreenSpec[];
  flows: FlowSpec[];
  design: DesignSpec;
  requirements: Array<{
    id: string;
    statement: string;
    category: string;
    verifiedBy: string;
  }>;
  backend: GenerationBackend;
  seedCount: number;
}

export interface SpecValidation {
  ok: boolean;
  errors: string[];
}

export type QualityCategory =
  | 'architecture'
  | 'completeness'
  | 'design'
  | 'accessibility'
  | 'reliability'
  | 'testability'
  | 'performance';

export type QualitySeverity = 'info' | 'warning' | 'error';

export interface QualityFinding {
  category: QualityCategory;
  severity: QualitySeverity;
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

export type GenerationRunStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'compensating'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface GenerationRunError {
  code: string;
  message: string;
  details?: unknown;
}

export interface GenerationRun {
  id: string;
  definition: string;
  definitionVersion?: number;
  status: GenerationRunStatus;
  input?: unknown;
  output?: unknown;
  error?: GenerationRunError | null;
  tenantId?: string;
  projectId?: string;
  actor?: string;
  attempt?: number;
  cancelRequested?: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface GenerationRunEvent {
  seq: number;
  runId?: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: number;
}

/** Metadata only — the benchmark corpus no longer ships full reports here. */
export interface GenerationBenchmark {
  id: string;
  prompt: string;
  domain?: AppDomain;
  screenKinds?: ScreenKind[];
  entities?: string[];
  minScreens?: number;
  weight?: number;
}

export interface GenerationOptions {
  appName: string;
  seedColor: string;
  backend: GenerationBackend;
  domain: GenerationDomain;
  target: GenerationTarget;
}

export type GenerationFailure = 'compile' | 'forge' | 'run';

export interface GenerationResult {
  ok: boolean;
}

export interface GenerationState extends GenerationOptions {
  prompt: string;
  spec: AppSpec | null;
  validation: SpecValidation | null;
  quality: QualityReport | null;
  run: GenerationRun | null;
  events: GenerationRunEvent[];
  benchmarks: GenerationBenchmark[];
  /** Project the active forge run was started for (used for quality refresh). */
  projectId: string | null;
  error: string | null;
  qualityError: string | null;
  benchmarksError: string | null;
  failure: GenerationFailure | null;
  busy: boolean;
  compiling: boolean;
  forging: boolean;
  refreshingRun: boolean;
  loadingEvents: boolean;
  loadingQuality: boolean;
  loadingBenchmarks: boolean;

  updateOptions: (patch: Partial<GenerationOptions>) => void;
  setPrompt: (prompt: string) => void;
  compile: () => Promise<GenerationResult>;
  forge: (projectId: string) => Promise<GenerationResult>;
  refreshRun: () => Promise<GenerationResult>;
  loadEvents: (runId: string) => Promise<GenerationResult>;
  loadQuality: (projectId?: string) => Promise<GenerationResult>;
  loadBenchmarks: () => Promise<GenerationResult>;
  reset: () => void;
  clearError: () => void;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const ACTIVE_RUN_STATUSES: readonly GenerationRunStatus[] = ['pending', 'running'];
const RUN_STATUSES: readonly GenerationRunStatus[] = [
  'pending',
  'running',
  'waiting_approval',
  'compensating',
  'succeeded',
  'failed',
  'cancelled',
];

/** Timers are module-scoped so a remount never loses (or duplicates) a poll. */
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;
let compileAbort: AbortController | null = null;

export function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollInFlight = false;
}

export function isRunActive(status: GenerationRunStatus | undefined): boolean {
  return status !== undefined && ACTIVE_RUN_STATUSES.includes(status);
}

export function isRunSettled(status: GenerationRunStatus | undefined): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function humanMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return '';
    return error.message.trim() || fallback;
  }
  if (typeof error === 'string' && error.trim()) return error.trim();
  return fallback;
}

async function readErrorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as
    | { error?: { message?: unknown } }
    | null;
  if (body && typeof body.error?.message === 'string' && body.error.message.length > 0) {
    return body.error.message;
  }
  return `Generation request failed (HTTP ${response.status}).`;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as T;
}

function normalizeRun(value: unknown): GenerationRun | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) return null;
  const rawStatus = typeof value.status === 'string' ? value.status : '';
  const status = (RUN_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as GenerationRunStatus)
    : 'pending';
  const rawError = isRecord(value.error) ? value.error : null;
  return {
    id: value.id,
    definition: typeof value.definition === 'string' ? value.definition : 'prompt.to.app',
    definitionVersion: finiteNumber(value.definitionVersion) ?? undefined,
    status,
    input: value.input,
    output: value.output,
    error: rawError
      ? {
          code: typeof rawError.code === 'string' ? rawError.code : 'RUN_FAILED',
          message: typeof rawError.message === 'string' ? rawError.message : 'The run failed.',
          details: rawError.details,
        }
      : null,
    tenantId: typeof value.tenantId === 'string' ? value.tenantId : undefined,
    projectId: typeof value.projectId === 'string' ? value.projectId : undefined,
    actor: typeof value.actor === 'string' ? value.actor : undefined,
    attempt: finiteNumber(value.attempt) ?? undefined,
    cancelRequested: value.cancelRequested === true,
    createdAt: finiteNumber(value.createdAt) ?? Date.now(),
    updatedAt: finiteNumber(value.updatedAt) ?? Date.now(),
    startedAt: finiteNumber(value.startedAt) ?? undefined,
    finishedAt: finiteNumber(value.finishedAt) ?? undefined,
  };
}

function normalizeEvents(value: unknown): GenerationRunEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): GenerationRunEvent[] => {
    if (!isRecord(entry) || typeof entry.type !== 'string') return [];
    return [
      {
        seq: finiteNumber(entry.seq) ?? 0,
        runId: typeof entry.runId === 'string' ? entry.runId : undefined,
        type: entry.type,
        data: isRecord(entry.data) ? entry.data : {},
        createdAt: finiteNumber(entry.createdAt) ?? Date.now(),
      },
    ];
  });
}

const INITIAL_STATE = {
  prompt: '',
  appName: '',
  seedColor: '#26bac1',
  backend: 'local' as GenerationBackend,
  domain: 'auto' as GenerationDomain,
  target: 'web' as GenerationTarget,
  spec: null,
  validation: null,
  quality: null,
  run: null,
  events: [],
  projectId: null,
  error: null,
  qualityError: null,
  benchmarksError: null,
  failure: null,
  busy: false,
  compiling: false,
  forging: false,
  refreshingRun: false,
  loadingEvents: false,
  loadingQuality: false,
  loadingBenchmarks: false,
} satisfies Partial<GenerationState>;

export const useGenerationStore = create<GenerationState>((set, get) => {
  const schedulePolling = (): void => {
    stopPolling();
    pollTimer = setInterval(() => {
      void get().refreshRun();
    }, POLL_INTERVAL_MS);
  };

  const settlePolling = (status: GenerationRunStatus): void => {
    if (isRunActive(status)) schedulePolling();
    else stopPolling();
  };

  return {
    ...INITIAL_STATE,
    benchmarks: [],

    updateOptions: (patch) => set(patch),
    setPrompt: (prompt) => set({ prompt }),

    compile: async () => {
      const state = get();
      const prompt = state.prompt.trim();
      if (!prompt) {
        set({
          error: 'Describe the app you want to forge before compiling a spec.',
          failure: 'compile',
        });
        return { ok: false };
      }

      compileAbort?.abort();
      const controller = new AbortController();
      compileAbort = controller;
      set({ compiling: true, busy: true, error: null, failure: null });

      const payload: { prompt: string; backend: GenerationBackend; appName?: string; seedColor?: string; domain?: AppDomain } = {
        prompt,
        backend: state.backend,
      };
      if (state.appName.trim()) payload.appName = state.appName.trim();
      if (/^#[0-9a-f]{6}$/i.test(state.seedColor.trim())) payload.seedColor = state.seedColor.trim();
      if (state.domain !== 'auto') payload.domain = state.domain;

      try {
        const body = await apiFetch<{ spec?: AppSpec; validation?: SpecValidation }>(
          '/api/platform/generation/spec',
          {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(payload),
            signal: controller.signal,
          },
        );
        if (compileAbort !== controller) return { ok: false };
        if (!body.spec) throw new Error('The spec compiler returned no app spec.');
        set((current) => ({
          spec: body.spec ?? null,
          validation: body.validation ?? null,
          compiling: false,
          busy: current.forging || current.refreshingRun,
        }));
        return { ok: true };
      } catch (error) {
        if (compileAbort !== controller || controller.signal.aborted) return { ok: false };
        set((current) => ({
          compiling: false,
          busy: current.forging || current.refreshingRun,
          error: humanMessage(
            error,
            'The spec compiler did not respond. Check that the platform is running and try again.',
          ),
          failure: 'compile',
        }));
        return { ok: false };
      } finally {
        if (compileAbort === controller) compileAbort = null;
      }
    },

    forge: async (projectId) => {
      const state = get();
      const prompt = state.prompt.trim();
      const targetProject = projectId.trim() || state.projectId || '';
      if (!prompt) {
        set({
          error: 'Describe the app you want to forge before starting the pipeline.',
          failure: 'forge',
        });
        return { ok: false };
      }
      if (!targetProject) {
        set({
          error: 'Open a project first — forging writes the app into its workspace.',
          failure: 'forge',
        });
        return { ok: false };
      }
      if (state.run && !isRunSettled(state.run.status)) {
        return { ok: false };
      }

      stopPolling();
      set({
        forging: true,
        busy: true,
        error: null,
        failure: null,
        run: null,
        events: [],
        quality: null,
        qualityError: null,
        projectId: targetProject,
      });

      try {
        const body = await apiFetch<{ run?: unknown }>('/api/platform/generation/build', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            projectId: targetProject,
            prompt,
            target: state.target,
            minQuality: MIN_TOP_APP_QUALITY,
          }),
        });
        const run = normalizeRun(body.run);
        if (!run) throw new Error('The pipeline accepted the request but returned no run.');
        set((current) => ({
          run,
          forging: false,
          busy: current.compiling || current.refreshingRun,
          projectId: run.projectId ?? targetProject,
        }));
        settlePolling(run.status);
        await get().loadEvents(run.id);
        if (run.status === 'succeeded') {
          await get().loadQuality(run.projectId ?? targetProject);
        }
        // Small builds can finish before the first poll lands.
        if (isRunActive(run.status)) void get().refreshRun();
        return { ok: true };
      } catch (error) {
        set((current) => ({
          forging: false,
          busy: current.compiling || current.refreshingRun,
          error: humanMessage(
            error,
            'The forge request failed. Check the platform and try again.',
          ),
          failure: 'forge',
        }));
        return { ok: false };
      }
    },

    refreshRun: async () => {
      const watched = get().run;
      if (!watched || pollInFlight) return { ok: false };
      pollInFlight = true;
      set({ refreshingRun: true, busy: true });

      try {
        const body = await apiFetch<{ run?: unknown }>(
          `/api/platform/workflows/runs/${encodeURIComponent(watched.id)}`,
        );
        const run = normalizeRun(body.run);
        if (!run) throw new Error('The workflow returned no run state.');
        if (get().run?.id !== run.id) return { ok: false };

        set((current) => ({
          run,
          busy: current.compiling || current.forging,
          error: null,
          failure: null,
        }));

        await get().loadEvents(run.id);
        if (run.status === 'succeeded') {
          const qualityProject = run.projectId ?? get().projectId;
          if (qualityProject) await get().loadQuality(qualityProject);
        }
        settlePolling(run.status);
        return { ok: true };
      } catch (error) {
        if (get().run?.id !== watched.id) return { ok: false };
        set((current) => ({
          error: humanMessage(
            error,
            'Could not refresh the run. The studio will retry while it is active.',
          ),
          failure: 'run',
          busy: current.compiling || current.forging,
        }));
        // Keep the polling timer alive for transient failures.
        if (isRunActive(get().run?.status)) schedulePolling();
        return { ok: false };
      } finally {
        pollInFlight = false;
        set((current) => ({ refreshingRun: false, busy: current.compiling || current.forging }));
      }
    },

    loadEvents: async (runId) => {
      if (!get().run || get().run?.id !== runId) return { ok: false };
      set({ loadingEvents: true });
      try {
        const body = await apiFetch<{ events?: unknown }>(
          `/api/platform/workflows/runs/${encodeURIComponent(runId)}/events`,
        );
        if (get().run?.id !== runId) return { ok: false };
        set({ events: normalizeEvents(body.events), loadingEvents: false });
        return { ok: true };
      } catch (error) {
        if (get().run?.id !== runId) return { ok: false };
        set({ loadingEvents: false });
        set((current) => ({
          error: humanMessage(error, 'Could not load run events.'),
          failure: 'run',
          busy: current.compiling || current.forging,
        }));
        return { ok: false };
      }
    },

    loadQuality: async (projectId) => {
      const target = projectId?.trim() || get().projectId || '';
      if (!target) {
        set({ qualityError: 'Open a project to load its quality report.' });
        return { ok: false };
      }

      set({ loadingQuality: true, qualityError: null });
      try {
        const response = await fetch(
          `/api/platform/generation/quality?projectId=${encodeURIComponent(target)}`,
        );
        // A project that has not been forged yet has no report — not an error.
        if (response.status === 404) {
          set({ quality: null, loadingQuality: false });
          return { ok: false };
        }
        if (!response.ok) throw new Error(await readErrorMessage(response));
        const body = (await response.json()) as { report?: QualityReport | null };
        set({ quality: body.report ?? null, loadingQuality: false });
        return { ok: true };
      } catch (error) {
        set({
          loadingQuality: false,
          qualityError: humanMessage(
            error,
            'Could not load the quality report. Try refreshing it.',
          ),
        });
        return { ok: false };
      }
    },

    loadBenchmarks: async () => {
      set({ loadingBenchmarks: true, benchmarksError: null });
      try {
        const body = await apiFetch<{ benchmarks?: unknown }>('/api/platform/generation/benchmarks');
        set({
          benchmarks: Array.isArray(body.benchmarks)
            ? (body.benchmarks as GenerationBenchmark[]).filter(
                (entry) => isRecord(entry) && typeof entry.id === 'string',
              )
            : [],
          loadingBenchmarks: false,
        });
        return { ok: true };
      } catch (error) {
        set({
          loadingBenchmarks: false,
          benchmarksError: humanMessage(
            error,
            'Could not load benchmark metadata. The studio still works without it.',
          ),
        });
        return { ok: false };
      }
    },

    reset: () => {
      stopPolling();
      compileAbort?.abort();
      compileAbort = null;
      set((current) => ({
        ...INITIAL_STATE,
        // Corpus metadata is global; keep it across briefs.
        benchmarks: current.benchmarks,
        loadingBenchmarks: current.loadingBenchmarks,
        benchmarksError: current.benchmarksError,
      }));
    },

    clearError: () => set({ error: null, failure: null }),
  };
});
