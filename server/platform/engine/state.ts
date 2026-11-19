/**
 * The single engineer's graph state.
 *
 * All channels are durable: the checkpointer persists them between interrupts
 * and process restarts. Large artefacts are referenced by path, never inlined.
 * The reducer choices are deliberate:
 *   messages        append (LangChain message reducer)
 *   toolCalls       append, bounded by the run budget
 *   approvals       append (audit trail)
 *   changedFiles    last-write-wins per path
 *   usage/budget    merged counters
 */
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import type {
  ApprovalDecision,
  ApprovalRequest,
  EngineBudgetLimits,
  EngineBudgetUsage,
  EngineStatus,
  EngineerDiagnostic,
  EngineerFileChange,
  EngineerProject,
  EngineerVerification,
  PendingToolCall,
  ToolCallRecord,
  SpecialistRole,
  SpecialistReport,
} from './types.js';
import { DEFAULT_BUDGET } from './types.js';
import { mergeChangedFiles } from './util.js';

function append<T>(left: T[] | undefined, right: T | T[] | undefined): T[] {
  const base = Array.isArray(left) ? left : [];
  if (right === undefined) return base;
  return base.concat(Array.isArray(right) ? right : [right]);
}

function mergeUsage(left: EngineBudgetUsage, right: Partial<EngineBudgetUsage> | undefined): EngineBudgetUsage {
  return {
    modelCalls: (left?.modelCalls ?? 0) + (right?.modelCalls ?? 0),
    toolCalls: (left?.toolCalls ?? 0) + (right?.toolCalls ?? 0),
    iterations: (left?.iterations ?? 0) + (right?.iterations ?? 0),
    promptTokens: (left?.promptTokens ?? 0) + (right?.promptTokens ?? 0),
    completionTokens: (left?.completionTokens ?? 0) + (right?.completionTokens ?? 0),
  };
}

export const EngineerState = Annotation.Root({
  // Conversation and objective
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  objective: Annotation<string>({ reducer: (_l, r) => r ?? '', default: () => '' }),
  pendingInstructions: Annotation<string[]>({ reducer: (_l, r) => r ?? [], default: () => [] }),

  // Identity
  project: Annotation<EngineerProject | null>({ reducer: (_l, r) => r ?? null, default: () => null }),
  threadId: Annotation<string>({ reducer: (_l, r) => r ?? '', default: () => '' }),
  runId: Annotation<string>({ reducer: (_l, r) => r ?? '', default: () => '' }),
  tenantId: Annotation<string>({ reducer: (_l, r) => r ?? '', default: () => '' }),
  actor: Annotation<string>({ reducer: (_l, r) => r ?? '', default: () => '' }),

  specialists: Annotation<SpecialistRole[]>({ reducer: (_l, r) => r, default: () => [] }),
  specialistReports: Annotation<SpecialistReport[]>({ reducer: append<SpecialistReport>, default: () => [] }),

  // Planning and context
  plan: Annotation<string[]>({ reducer: append<string>, default: () => [] }),
  memoryContext: Annotation<string[]>({ reducer: append<string>, default: () => [] }),
  projectBrief: Annotation<string>({ reducer: (_l, r) => r ?? '', default: () => '' }),

  // Execution
  status: Annotation<EngineStatus>({ reducer: (_l, r) => r ?? 'idle', default: () => 'idle' }),
  phase: Annotation<string>({ reducer: (_l, r) => r ?? '', default: () => '' }),
  pendingToolCalls: Annotation<PendingToolCall[]>({ reducer: (_l, r) => r ?? [], default: () => [] }),
  approvedToolCallIds: Annotation<string[]>({ reducer: (_l, r) => r ?? [], default: () => [] }),
  deniedToolCallIds: Annotation<string[]>({ reducer: (_l, r) => r ?? [], default: () => [] }),
  toolCalls: Annotation<ToolCallRecord[]>({ reducer: append<ToolCallRecord>, default: () => [] }),

  // Budgets and lifecycle
  budget: Annotation<EngineBudgetLimits>({
    reducer: (left, right) => ({ ...(left ?? DEFAULT_BUDGET), ...(right ?? {}) }),
    default: () => DEFAULT_BUDGET,
  }),
  usage: Annotation<EngineBudgetUsage>({
    reducer: (left, right) => mergeUsage(left ?? { modelCalls: 0, toolCalls: 0, iterations: 0, promptTokens: 0, completionTokens: 0 }, right),
    default: () => ({ modelCalls: 0, toolCalls: 0, iterations: 0, promptTokens: 0, completionTokens: 0 }),
  }),
  startedAt: Annotation<number>({ reducer: (_l, r) => r ?? Date.now(), default: () => Date.now() }),
  deadlineAt: Annotation<number>({ reducer: (_l, r) => r ?? 0, default: () => 0 }),

  // Outputs and evidence
  changedFiles: Annotation<EngineerFileChange[]>({
    reducer: (left, right) => mergeChangedFiles(left ?? [], right ?? []),
    default: () => [],
  }),
  diagnostics: Annotation<EngineerDiagnostic[]>({ reducer: append<EngineerDiagnostic>, default: () => [] }),
  verification: Annotation<EngineerVerification | null>({ reducer: (_l, r) => r ?? null, default: () => null }),
  finalSummary: Annotation<string>({ reducer: (_l, r) => r ?? '', default: () => '' }),
  error: Annotation<string | null>({ reducer: (_l, r) => r ?? null, default: () => null }),
  cancellationRequested: Annotation<boolean>({ reducer: (_l, r) => r ?? false, default: () => false }),

  // Human collaboration
  approvalRequest: Annotation<ApprovalRequest | null>({ reducer: (_l, r) => r ?? null, default: () => null }),
  approvalHistory: Annotation<ApprovalDecision[]>({ reducer: append<ApprovalDecision>, default: () => [] }),
  verificationRequired: Annotation<boolean>({ reducer: (_l, r) => r ?? false, default: () => false }),
  verifyAttempts: Annotation<number>({ reducer: (_l, r) => r ?? 0, default: () => 0 }),
});

export type EngineerStateType = typeof EngineerState.State;
export type EngineerStateUpdate = typeof EngineerState.Update;
