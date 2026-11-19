import { create } from 'zustand';

/**
 * Client for the local-first platform API (`/api/platform/*`, same origin,
 * proxied to the engine in dev / served by it in the desktop shell). No auth
 * headers — the platform is local-first. `projectId` is passed per call; this
 * store never reads routing itself.
 */

export interface PlatformRun {
  id: string;
  definition: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  projectId?: string;
}

export interface PlatformRevision {
  id: string;
  tenantId: string;
  projectId: string;
  parentId?: string;
  message: string;
  actor: string;
  fileCount: number;
  totalBytes: number;
  createdAt: number;
}

export type PlatformRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface PlatformApproval {
  id: string;
  runId: string;
  stepId: string;
  risk: PlatformRiskLevel;
  reason: string;
  requestedAt: number;
  summary: Record<string, unknown>;
}

export interface PlatformAuditEntry {
  seq: number;
  action: string;
  actor: string;
  resourceId?: string;
  createdAt: number;
}

export interface PlatformAuditVerification {
  ok: boolean;
  checked: number;
  firstBadSeq?: number;
  reason?: string;
  headHash?: string;
}

export type ApprovalDecision = 'approved' | 'rejected';

/* ── Agent Corps ─────────────────────────────────────────────────────────── */

export type CorpsDepartment = 'product' | 'design' | 'engineering' | 'quality' | 'delivery' | 'intelligence';
export type CorpsSeverity = 'blocker' | 'major' | 'minor' | 'info';
export type CorpsStatus = 'pass' | 'warn' | 'fail';

export interface CorpsAgent {
  id: string;
  name: string;
  title: string;
  department: CorpsDepartment;
  description: string;
  capabilities: string[];
  mode: 'deterministic';
}

export interface CorpsDepartmentGroup {
  department: CorpsDepartment;
  label: string;
  weight: number;
  remit: string;
  agents: CorpsAgent[];
}

export interface CorpsFinding {
  code: string;
  severity: CorpsSeverity;
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
  evidence?: string;
}

export interface CorpsReport {
  agentId: string;
  name: string;
  title: string;
  department: CorpsDepartment;
  status: CorpsStatus;
  score: number;
  findings: CorpsFinding[];
  stats: { blockers: number; majors: number; minors: number; infos: number; filesConsidered?: number };
  durationMs: number;
}

export interface CorpsDepartmentScore {
  department: CorpsDepartment;
  label: string;
  weight: number;
  score: number;
  status: CorpsStatus;
  agentIds: string[];
  blockers: number;
  majors: number;
  minors: number;
}

export interface CorpsScorecard {
  projectId: string;
  overallScore: number;
  verdict: CorpsStatus;
  departments: CorpsDepartmentScore[];
  reports: CorpsReport[];
  blockers: CorpsFinding[];
  findingCounts: Record<string, number>;
  stats: {
    agents: number;
    findings: number;
    blockers: number;
    majors: number;
    minors: number;
    infos: number;
    filesReviewed: number;
  };
  generatedAt: number;
  durationMs: number;
}

interface PlatformState {
  revisions: PlatformRevision[];
  approvals: PlatformApproval[];
  loading: boolean;
  error: string | null;
  /** Wall-clock duration of the last completed request, in milliseconds. */
  lastFetchMs: number;

  /** Agent Corps roster, grouped by department. Empty until fetched. */
  corpsRoster: CorpsDepartmentGroup[];
  rosterLoaded: boolean;
  /** Latest board review; null until a project has been reviewed this session. */
  scorecard: CorpsScorecard | null;
  reviewing: boolean;
  reviewError: string | null;

  refreshRevisions: (projectId: string) => Promise<void>;
  refreshApprovals: () => Promise<void>;
  /** Restores a revision through the transactional patch engine.
   *  Resolves `{ ok: false }` and stores `error` on failure — never throws into the UI. */
  restore: (projectId: string, revisionId: string) => Promise<{ ok: boolean }>;
  decideApproval: (id: string, decision: ApprovalDecision, note?: string) => Promise<{ ok: boolean }>;
  /** Returns the latest entries (empty on failure — `error` carries the reason). */
  fetchAudit: (limit?: number) => Promise<PlatformAuditEntry[]>;
  /** Returns the chain verification verdict, or null on failure. */
  verifyAudit: () => Promise<PlatformAuditVerification | null>;
  fetchCorpsRoster: () => Promise<void>;
  /** Runs the Agent Corps over the project's current workspace snapshot.
   *  Resolves the scorecard, or null with `reviewError` set. */
  reviewProject: (projectId: string, options?: { prompt?: string }) => Promise<CorpsScorecard | null>;
  clearReview: () => void;
  clearError: () => void;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function readErrorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
  if (body && typeof body.error?.message === 'string' && body.error.message.length > 0) {
    return body.error.message;
  }
  return `Platform request failed (HTTP ${response.status}).`;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return (await response.json()) as T;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const usePlatformStore = create<PlatformState>((set) => {
  /** Shared scaffold: mark loading, time the request, and fold failures into `error`. */
  const run = async <T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
    const started = Date.now();
    set({ loading: true, error: null });
    try {
      const value = await fn();
      set({ loading: false, lastFetchMs: Date.now() - started });
      return { ok: true, value };
    } catch (error) {
      set({ loading: false, error: message(error), lastFetchMs: Date.now() - started });
      return { ok: false };
    }
  };

  return {
    revisions: [],
    approvals: [],
    loading: false,
    error: null,
    lastFetchMs: 0,
    corpsRoster: [],
    rosterLoaded: false,
    scorecard: null,
    reviewing: false,
    reviewError: null,

    refreshRevisions: async (projectId) => {
      const result = await run(() =>
        apiFetch<{ revisions?: PlatformRevision[] }>(
          `/api/platform/projects/${encodeURIComponent(projectId)}/revisions?limit=20`,
        ),
      );
      if (result.ok) {
        set({ revisions: Array.isArray(result.value.revisions) ? result.value.revisions : [] });
      }
    },

    refreshApprovals: async () => {
      const result = await run(() =>
        apiFetch<{ approvals?: PlatformApproval[] }>('/api/platform/approvals/pending'),
      );
      if (result.ok) {
        set({ approvals: Array.isArray(result.value.approvals) ? result.value.approvals : [] });
      }
    },

    restore: async (projectId, revisionId) => {
      const result = await run(() =>
        apiFetch(`/api/platform/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/restore`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ revisionId }),
        }),
      );
      return { ok: result.ok };
    },

    decideApproval: async (id, decision, note) => {
      const result = await run(() =>
        apiFetch(`/api/platform/approvals/${encodeURIComponent(id)}/decision`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(note ? { decision, note } : { decision }),
        }),
      );
      return { ok: result.ok };
    },

    fetchAudit: async (limit = 20) => {
      const result = await run(() =>
        apiFetch<{ entries?: PlatformAuditEntry[] }>(`/api/platform/audit/entries?limit=${Math.floor(limit)}`),
      );
      return result.ok && Array.isArray(result.value.entries) ? result.value.entries : [];
    },

    verifyAudit: async () => {
      const result = await run(() =>
        apiFetch<{ ok?: boolean; verification?: PlatformAuditVerification }>('/api/platform/audit/verify'),
      );
      if (!result.ok) return null;
      return result.value.verification ?? { ok: Boolean(result.value.ok), checked: 0 };
    },

    fetchCorpsRoster: async () => {
      try {
        const data = await apiFetch<{ departments?: CorpsDepartmentGroup[] }>('/api/platform/agents');
        set({
          corpsRoster: Array.isArray(data.departments) ? data.departments : [],
          rosterLoaded: true,
        });
      } catch (error) {
        set({ error: message(error), rosterLoaded: true });
      }
    },

    reviewProject: async (projectId, options) => {
      set({ reviewing: true, reviewError: null });
      const started = Date.now();
      try {
        const response = await apiFetch<{ scorecard?: CorpsScorecard }>(
          `/api/platform/projects/${encodeURIComponent(projectId)}/agents/review`,
          {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(options?.prompt ? { prompt: options.prompt } : {}),
          },
        );
        const scorecard = response.scorecard ?? null;
        set({ reviewing: false, scorecard, lastFetchMs: Date.now() - started });
        return scorecard;
      } catch (error) {
        set({
          reviewing: false,
          reviewError: message(error),
          lastFetchMs: Date.now() - started,
        });
        return null;
      }
    },

    clearReview: () => set({ scorecard: null, reviewError: null }),

    clearError: () => set({ error: null }),
  };
});
