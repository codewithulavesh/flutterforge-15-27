/**
 * FlutterForge autonomous engineer — shared contracts.
 *
 * There is exactly one reasoning loop. Everything in this module describes the
 * state that loop reads and writes; it does not contain model calls or tool
 * implementations. Deterministic validators, sandboxes and Flutter commands
 * are tools of the single engineer, never additional AI agents.
 */
import type { z } from 'zod';
import type { SandboxRunner } from '../sandbox/index.js';

export type EngineStatus =
  | 'idle'
  | 'reasoning'
  | 'executing'
  | 'awaiting_approval'
  | 'paused'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RiskLevel = 'low' | 'medium' | 'high';

export type SpecialistRole = 'planner' | 'reviewer';

export interface SpecialistReport {
  role: SpecialistRole;
  status: 'completed' | 'skipped' | 'failed';
  summary: string;
}

export interface EngineBudgetLimits {
  /** Model invocations allowed in one run. */
  maxModelCalls: number;
  /** Tool executions allowed in one run. */
  maxToolCalls: number;
  /** Reason-node iterations allowed in one run. */
  maxIterations: number;
  /** Wall-clock ceiling for one run. */
  maxWallMs: number;
  /** LangGraph recursion guard. */
  recursionLimit: number;
}

export interface EngineBudgetUsage {
  modelCalls: number;
  toolCalls: number;
  iterations: number;
  promptTokens: number;
  completionTokens: number;
}

export const DEFAULT_BUDGET: Readonly<EngineBudgetLimits> = Object.freeze({
  maxModelCalls: 40,
  maxToolCalls: 80,
  maxIterations: 60,
  maxWallMs: 45 * 60_000,
  recursionLimit: 160,
});

export interface EngineerProject {
  projectId: string;
  name?: string;
  /** Absolute workspace root the engineer is confined to. */
  root: string;
  framework: 'flutter';
  targets: string[];
}

export interface EngineerFileChange {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  content?: string;
  language?: string;
}

export interface EngineerDiagnostic {
  code?: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
}

export interface EngineerVerification {
  steps?: { command: string; status: 'passed' | 'failed' | 'skipped' }[];
  passed: boolean;
  skipped?: boolean;
  summary: string;
  errorCount: number;
  warningCount: number;
  diagnostics: EngineerDiagnostic[];
  evidence: string[];
  at: number;
}

export interface PendingToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  risk: RiskLevel;
  reason?: string;
}

export interface ApprovalRequest {
  id: string;
  threadId: string;
  projectId: string;
  reason: string;
  calls: PendingToolCall[];
  requestedAt: number;
}

export interface ApprovalDecisionEntry {
  toolCallId: string;
  approved: boolean;
  note?: string;
}

export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
  decisions?: ApprovalDecisionEntry[];
  note?: string;
  decidedAt: number;
  actor: string;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  risk: RiskLevel;
  approved?: boolean;
  durationMs: number;
  error?: string;
  at: number;
}

export interface ToolOutcome {
  /** Text returned to the model. Always bounded by the tool. */
  content: string;
  /** Structured data for state updates (never required by the model). */
  data?: Record<string, unknown>;
  changedFiles?: EngineerFileChange[];
  verification?: EngineerVerification;
  diagnostics?: EngineerDiagnostic[];
}

export interface ToolApprovalVerdict {
  required: boolean;
  risk: RiskLevel;
  reason?: string;
}

export interface EngineerToolSpec {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  /** Classifies risk and decides whether a human must approve this call. */
  approval?: (input: any) => ToolApprovalVerdict;
  invoke: (input: any, context: ToolContext) => Promise<ToolOutcome>;
}

export interface PreviewStatus {
  sessionId: string;
  projectId: string;
  status: 'building' | 'running' | 'failed' | 'stopped';
  url: string | null;
  port: number | null;
  logs: string[];
  diagnostics?: EngineerDiagnostic[];
}

export interface PreviewPort {
  start(projectId: string, files: Array<{ path: string; content: string }>): Promise<{ sessionId: string; status: string; url: string | null }>;
  status(projectId: string): PreviewStatus | null;
  stop(sessionId: string): boolean;
  reload(projectId: string, options?: { restart?: boolean }): { ok: boolean; body: Record<string, unknown> };
}

export interface MemoryEntry {
  id: string;
  kind: 'decision' | 'constraint' | 'fact' | 'summary';
  content: string;
  source: string;
  confidence: number;
  createdAt: number;
}

export interface MemoryPort {
  list(projectId: string, limit?: number): Promise<MemoryEntry[]>;
  put(projectId: string, entry: Pick<MemoryEntry, 'kind' | 'content' | 'source' | 'confidence'>): Promise<MemoryEntry>;
}

export interface DatabasePort {
  schema(): Promise<Array<{ table: string; columns: string[] }>>;
  query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
}

export interface BrowserConsoleEntry {
  type: string;
  text: string;
  at: number;
}

export interface BrowserElement {
  tag: string;
  text: string;
  selector: string;
  role?: string;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  text: string;
  elements: BrowserElement[];
}

export interface BrowserPort {
  navigate(url: string): Promise<BrowserSnapshot>;
  snapshot(): Promise<BrowserSnapshot>;
  click(input: { selector?: string; x?: number; y?: number }): Promise<string>;
  typeText(input: { text: string; selector?: string; submit?: boolean }): Promise<string>;
  pressKey(key: string): Promise<string>;
  screenshot(name: string): Promise<string>;
  console(): Promise<BrowserConsoleEntry[]>;
  close(): Promise<void>;
}

export interface ArtifactPort {
  /** Persist bytes under the project's artifact directory and return an absolute path. */
  write(name: string, bytes: Buffer, contentType?: string): Promise<string>;
}

export interface CheckpointRecord {
  id: string;
  label: string;
  files: number;
  createdAt: number;
  path: string;
}

export interface CheckpointPort {
  create(label?: string): Promise<CheckpointRecord>;
  restore(id: string): Promise<{ id: string; restored: number; deleted: number }>;
  list(): Promise<CheckpointRecord[]>;
}

export interface ToolContext {
  projectId: string;
  tenantId: string;
  actor: string;
  threadId: string;
  runId: string;
  projectRoot: string;
  artifactsDir: string;
  signal?: AbortSignal;
  sandbox: SandboxRunner;
  preview: PreviewPort;
  memory: MemoryPort;
  database: DatabasePort;
  artifacts: ArtifactPort;
  checkpoints: CheckpointPort;
  browser: BrowserPort;
  /** Deterministic full-project verification (pub get + analyzer). */
  verify: () => Promise<EngineVerification>;
  /** Instructions submitted mid-run; reading them clears the queue. */
  takeInstructions: () => string[];
  /** True when the user requested cancellation for this run. */
  cancelled: () => boolean;
  paused?: () => boolean;
  emit: (event: Omit<EngineEvent, 'seq' | 'at'> & { type: string; [key: string]: unknown }) => void;
}

export type EngineEventType =
  | 'run_started'
  | 'status'
  | 'progress'
  | 'reasoning'
  | 'message'
  | 'token'
  | 'tool_start'
  | 'tool_end'
  | 'file'
  | 'approval_required'
  | 'approval_decided'
  | 'instruction'
  | 'verification'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface EngineEvent {
  seq: number;
  threadId: string;
  runId: string;
  type: EngineEventType;
  at: number;
  [key: string]: unknown;
}

export interface EngineRunInput {
  threadId?: string;
  projectId: string;
  tenantId: string;
  actor: string;
  projectName?: string;
  prompt: string;
  /** Existing project files, materialized before the run (incremental edits). */
  files?: Array<{ path: string; content: string }>;
  /** Optional user instruction appended to an existing thread. */
  instruction?: string;
  verificationRequired?: boolean;
  budgets?: Partial<EngineBudgetLimits>;
  /** Model override for this run (must be an allowed configured model). */
  model?: string;
}

export interface EngineResumeInput {
  decision?: ApprovalDecision | { approved: boolean; note?: string };
  instruction?: string;
}

export interface EngineRunResult {
  runId: string;
  threadId: string;
  status: EngineStatus;
  finalSummary: string;
  changedFiles: EngineerFileChange[];
  verification: EngineerVerification | null;
  interrupts: Array<{ id: string; value: unknown }>;
}

export interface EngineerModelConfig {
  provider: 'openrouter' | 'deepseek' | 'openai-compatible';
  model: string;
  fallbackModels: string[];
  apiKey: string;
  apiKeys?: string[];
  baseUrl: string;
  headers: Record<string, string>;
  timeoutMs: number;
  maxRetries: number;
}

export interface EngineerRuntimeOptions {
  dataDir: string;
  /** Optional PostgreSQL connection string for durable checkpointing. */
  databaseUrl?: string;
  /** Injected for tests. */
  model?: import('@langchain/core/language_models/chat_models').BaseChatModel;
  /** Injected for tests. */
  checkpointer?: import('@langchain/langgraph-checkpoint').BaseCheckpointSaver;
  /** Injected for tests. */
  sandbox?: SandboxRunner;
  /** Injected for tests. */
  memory?: MemoryPort;
  /** Injected for tests. */
  preview?: PreviewPort;
  /** Injected for tests. */
  verify?: (projectId: string, root: string) => Promise<EngineVerification>;
  vision?: boolean;
}

export type EngineVerification = EngineerVerification;

export interface EngineEventBusOptions {
  retain?: number;
}
