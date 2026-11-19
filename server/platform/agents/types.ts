/**
 * Agent Corps — typed contracts.
 *
 * The Corps is the review organisation of the platform: twenty named
 * specialists that inspect a generated project and produce attributable,
 * machine-stable findings. Every agent is deterministic by default — the same
 * project always produces the same findings — so a review can gate a release
 * without burning tokens. LLM agents remain where they belong: generation and
 * repair (`src/agents`, `server/harness`).
 */

export type AgentDepartment =
  | 'product'
  | 'design'
  | 'engineering'
  | 'quality'
  | 'delivery'
  | 'intelligence';

export type FindingSeverity = 'blocker' | 'major' | 'minor' | 'info';

export type AgentStatus = 'pass' | 'warn' | 'fail';

export interface ReviewFile {
  /** Workspace-relative POSIX path. */
  path: string;
  content: string;
}

export interface ReviewContext {
  projectId: string;
  files: readonly ReviewFile[];
  /** `name:` from pubspec.yaml, when it could be read. */
  packageName: string | null;
  /** Raw pubspec.yaml contents, when present. */
  pubspec: string | null;
  /** Original product prompt, when the review was launched from a generation run. */
  prompt?: string;
  /** Injected clock — agents must not read Date.now directly. */
  now: number;
}

export interface AgentFinding {
  /** Stable machine code, e.g. `SEC_HARDCODED_SECRET`. Regression-trackable. */
  code: string;
  severity: FindingSeverity;
  message: string;
  file?: string;
  /** 1-based line number when it can be derived. */
  line?: number;
  suggestion?: string;
  /** Short quoted evidence (already redacted upstream where relevant). */
  evidence?: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  title: string;
  department: AgentDepartment;
  /** Human-readable remit shown in the roster. */
  description: string;
  /** Capability tags, stable and lowercase. */
  capabilities: readonly string[];
  /** How the agent reaches a verdict. Corps agents are deterministic. */
  mode: 'deterministic';
  run: (context: ReviewContext) => AgentFinding[] | Promise<AgentFinding[]>;
}

/** Roster entry — agent definition without the executable body. */
export interface AgentSummary {
  id: string;
  name: string;
  title: string;
  department: AgentDepartment;
  description: string;
  capabilities: readonly string[];
  mode: 'deterministic';
}

export interface AgentReport {
  agentId: string;
  name: string;
  title: string;
  department: AgentDepartment;
  status: AgentStatus;
  /** 0–100, derived only from this agent's findings. */
  score: number;
  findings: AgentFinding[];
  stats: {
    blockers: number;
    majors: number;
    minors: number;
    infos: number;
    /** Files the agent considered, when meaningful. */
    filesConsidered?: number;
  };
  durationMs: number;
}

export interface DepartmentScore {
  department: AgentDepartment;
  label: string;
  weight: number;
  score: number;
  status: AgentStatus;
  agentIds: string[];
  blockers: number;
  majors: number;
  minors: number;
}

export type ReviewVerdict = 'pass' | 'warn' | 'fail';

export interface Scorecard {
  projectId: string;
  overallScore: number;
  verdict: ReviewVerdict;
  departments: DepartmentScore[];
  reports: AgentReport[];
  /** Blocking findings across the whole board, stable order. */
  blockers: AgentFinding[];
  /** Stable code → count across the board (for trend tracking). */
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

export interface RunCorpsOptions {
  /** Restrict the board to specific agent ids. Unknown ids are rejected. */
  agentIds?: readonly string[];
  /** Maximum agents executing concurrently. Default 4. */
  concurrency?: number;
  /** Drop `info` findings from reports and from the scorecard totals. */
  excludeInfo?: boolean;
}
