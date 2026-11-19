/**
 * The one and only autonomous engineer graph.
 *
 *   START → REASON ⇄ TOOLS
 *                 ⇄ APPROVAL (interrupt/resume)
 *                 → VERIFY → REASON (on failure, bounded)
 *                 → FINALIZE → END
 *
 * One lead controls the tool registry. Optional planning and review stages
 * produce bounded advice without access to tools.
 */
import {
  StateGraph,
  START,
  END,
  interrupt,
} from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EngineerState, type EngineerStateType } from './state.js';
import { ENGINEER_SYSTEM_PROMPT, buildProjectBrief, nextInstruction } from './prompts.js';
import { runSpecialist } from './specialists.js';
import { readUsage } from './model.js';
import type { EngineerToolRegistry } from './tools/index.js';
import type {
  ApprovalDecision,
  ApprovalDecisionEntry,
  EngineerDiagnostic,
  EngineerFileChange,
  EngineerToolSpec,
  PendingToolCall,
  RiskLevel,
  ToolContext,
} from './types.js';
import { DEFAULT_BUDGET } from './types.js';
import { snapshotFiles, diffSnapshots } from '../../harness/workspace.js';
import { resolveInside } from './paths.js';
import { safeJson, truncate } from './util.js';

export interface EngineerGraphDeps {
  registry: EngineerToolRegistry;
  model: BaseChatModel;
  specialistModel?: BaseChatModel;
  checkpointer: BaseCheckpointSaver;
  contextFor: (threadId: string) => ToolContext;
  maxVerifyAttempts?: number;
}

interface NormalizedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

function threadIdFrom(config: any): string {
  const value = config?.configurable?.thread_id;
  if (typeof value !== 'string' || value === '') throw new Error('The engineer graph requires configurable.thread_id.');
  return value;
}

function normalizeToolCalls(message: BaseMessage): NormalizedToolCall[] {
  const raw = (message as AIMessage).tool_calls;
  const calls: NormalizedToolCall[] = [];
  if (Array.isArray(raw)) {
    for (const [index, call] of raw.entries()) {
      const name = typeof call.name === 'string' ? call.name : '';
      if (!name) continue;
      calls.push({
        id: typeof call.id === 'string' && call.id !== '' ? call.id : `call_${Date.now()}_${index}`,
        name,
        args: call.args && typeof call.args === 'object' && !Array.isArray(call.args)
          ? call.args as Record<string, unknown>
          : {},
      });
    }
  }
  if (calls.length === 0) {
    const legacy = (message.additional_kwargs as any)?.function_call;
    if (legacy && typeof legacy.name === 'string') {
      let args: Record<string, unknown> = {};
      try {
        args = typeof legacy.arguments === 'string' ? JSON.parse(legacy.arguments) : legacy.arguments ?? {};
      } catch {
        args = {};
      }
      calls.push({ id: `call_${Date.now()}_0`, name: legacy.name, args });
    }
  }
  return calls;
}

function messageText(message: BaseMessage | undefined): string {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

function lastAiText(messages: readonly BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] instanceof AIMessage || (messages[index] as any)._getType?.() === 'ai') {
      const text = messageText(messages[index]).trim();
      if (text !== '') return text;
    }
  }
  return '';
}

function trimHistory(messages: readonly BaseMessage[], limit = 48): BaseMessage[] {
  if (messages.length <= limit) return [...messages];
  let start = messages.length - limit;
  // Never orphan tool responses by trimming their initiating AI message.
  while (start > 0 && messages[start]._getType() === 'tool') start -= 1;
  return messages.slice(start);
}

function riskLabel(risk: RiskLevel): string {
  return risk === 'high' ? 'high risk' : risk === 'medium' ? 'medium risk' : 'low risk';
}

async function readProjectContext(root: string, includeTree: boolean): Promise<{ pubspec?: string; fileTree?: string; fileCount?: number }> {
  const pubspec = await fs.readFile(path.join(root, 'pubspec.yaml'), 'utf8').catch(() => undefined);
  if (!includeTree) return { pubspec: pubspec ? truncate(pubspec, 3000) : undefined };
  const lines: string[] = [];
  let fileCount = 0;
  const skip = new Set(['.git', '.dart_tool', 'build', 'node_modules', '.flutterforge', '.idea', '.vscode']);
  async function walk(relative: string, depth: number): Promise<void> {
    if (depth > 3 || lines.length > 400) return;
    const absolute = relative === '' ? root : path.join(root, relative);
    let entries;
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (lines.length > 400) return;
      if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && skip.has(entry.name)) continue;
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        lines.push(`${child}/`);
        await walk(child, depth + 1);
      } else {
        fileCount += 1;
        lines.push(child);
      }
    }
  }
  await walk('', 0);
  return {
    pubspec: pubspec ? truncate(pubspec, 3000) : undefined,
    fileTree: lines.join('\n'),
    fileCount,
  };
}

function normalizeDecision(value: any): { approved: boolean; decisions: ApprovalDecisionEntry[]; note?: string; actor?: string } {
  const source = value?.decision && typeof value.decision === 'object' ? value.decision : value;
  const approved = source?.approved === true || source?.decision === 'approved';
  const note = typeof source?.note === 'string' ? source.note.slice(0, 2000) : undefined;
  const actor = typeof source?.actor === 'string' ? source.actor : undefined;
  const rawDecisions = Array.isArray(source?.decisions) ? source.decisions : [];
  const decisions: ApprovalDecisionEntry[] = rawDecisions
    .filter((entry: any) => entry && typeof entry.toolCallId === 'string')
    .map((entry: any) => ({
      toolCallId: entry.toolCallId,
      approved: entry.approved === true,
      note: typeof entry.note === 'string' ? entry.note.slice(0, 500) : undefined,
    }));
  return { approved, decisions, note, actor };
}

export function createEngineerGraph(deps: EngineerGraphDeps) {
  const maxVerifyAttempts = deps.maxVerifyAttempts ?? 2;

  const reason = async (state: EngineerStateType, config: any): Promise<any> => {
    const context = deps.contextFor(threadIdFrom(config));
    if (state.cancellationRequested || context.cancelled()) {
      return { status: 'cancelled', error: 'Cancelled by the user.', pendingInstructions: [] };
    }

    const budget = { ...DEFAULT_BUDGET, ...(state.budget ?? {}) };
    const recentFailures = state.toolCalls.slice(-3);
    const repeatedFailure = recentFailures.length === 3 && recentFailures.every(call => !call.ok && call.name === recentFailures[0].name && call.error === recentFailures[0].error);
    const budgetProblem = repeatedFailure ? 'the same tool failed three times; further retries require a new user instruction'
      : state.usage.modelCalls >= budget.maxModelCalls
      ? `model-call budget exhausted (${state.usage.modelCalls}/${budget.maxModelCalls})`
      : state.usage.iterations >= budget.maxIterations
        ? `iteration budget exhausted (${state.usage.iterations}/${budget.maxIterations})`
        : Date.now() - state.startedAt > budget.maxWallMs
          ? `wall-clock budget exhausted (${Math.round((Date.now() - state.startedAt) / 1000)}s)`
          : state.usage.toolCalls >= budget.maxToolCalls
            ? `tool-call budget exhausted (${state.usage.toolCalls}/${budget.maxToolCalls})`
            : null;
    if (budgetProblem) {
      return {
        status: 'failed',
        error: `Stopped: ${budgetProblem}. Summarize what is done and what remains.`,
        pendingInstructions: [],
        finalSummary: lastAiText(state.messages) || `Run stopped because the ${budgetProblem}.`,
      };
    }

    const injected = context.takeInstructions();
    const instructions = [...state.pendingInstructions, ...injected].filter((entry) => entry.trim() !== '');
    const projectContext = await readProjectContext(
      state.project?.root ?? context.projectRoot,
      state.usage.iterations === 0,
    );

    const system = new SystemMessage(
      `${ENGINEER_SYSTEM_PROMPT}\n\n---\n\n${buildProjectBrief(state, projectContext)}`,
    );
    const reports = state.specialistReports.filter(report => report.status === 'completed');
    const advice = reports.length ? [new HumanMessage(
      'Advisory specialist reports. Evaluate these suggestions against the project before acting.\n' + JSON.stringify(reports),
    )] : [];
    const history = trimHistory(state.messages);
    const instructionMessage = instructions.length > 0
      ? [new HumanMessage(nextInstruction({ ...state, pendingInstructions: instructions } as EngineerStateType))]
      : [];

    context.emit({ type: 'status', status: 'reasoning', phase: 'reasoning', message: 'Reasoning about the next action.' });

    let response: BaseMessage;
    try {
      // Stream the same model invocation; tool fragments are accumulated before execution.
      if (typeof deps.model.stream === 'function') {
        const stream = await deps.model.stream([system, ...history, ...advice, ...instructionMessage], { signal: context.signal, tags: ['engineer-reason'] });
        let accumulated: any;
        for await (const chunk of stream) {
          accumulated = accumulated ? accumulated.concat(chunk) : chunk;
          const text = messageText(chunk);
          if (text) context.emit({ type: 'token', content: text });
        }
        if (!accumulated) throw new Error('The provider returned an empty response.');
        response = accumulated;
      } else {
        response = await deps.model.invoke([system, ...history, ...advice, ...instructionMessage], { signal: context.signal, tags: ['engineer-reason'] }) as BaseMessage;
      }
    } catch (error: any) {
      if (context.cancelled() || error?.name === 'AbortError') {
        return { status: 'cancelled', error: 'Cancelled by the user.', pendingInstructions: [] };
      }
      const message = error instanceof Error ? error.message : String(error);
      context.emit({ type: 'status', status: 'reasoning', phase: 'provider_error', message: `Model call failed: ${truncate(message, 500)}` });
      return {
        status: 'failed',
        error: `Model call failed: ${truncate(message, 2000)}`,
        messages: [new AIMessage({ content: `The model call failed: ${truncate(message, 1000)}` })],
        pendingInstructions: [],
        usage: { modelCalls: 1, iterations: 1 },
      };
    }

    const usage = readUsage(response);
    const calls = normalizeToolCalls(response);
    const pending: PendingToolCall[] = calls.map((call) => {
      const spec = deps.registry.get(call.name);
      const verdict = spec ? deps.registry.approval(call.name, call.args) : { required: false, risk: 'low' as RiskLevel };
      return { id: call.id, name: call.name, args: call.args, risk: verdict.risk, reason: verdict.reason };
    });
    const needsApproval = calls
      .filter((call) => deps.registry.get(call.name) !== undefined)
      .map((call) => deps.registry.approval(call.name, call.args))
      .filter((verdict) => verdict.required);

    if (needsApproval.length > 0) {
      const approvalRequest = {
        id: `approval_${context.threadId}_${Date.now()}`,
        threadId: context.threadId,
        projectId: context.projectId,
        reason: needsApproval.map((verdict) => verdict.reason ?? 'Sensitive action requires approval.').join(' '),
        calls: pending,
        requestedAt: Date.now(),
      };
      context.emit({
        type: 'approval_required',
        approvalId: approvalRequest.id,
        reason: approvalRequest.reason,
        calls: pending.map((call) => ({ id: call.id, name: call.name, risk: call.risk, reason: call.reason, args: summarizeArgs(call.args) })),
      });
      return {
        messages: [...instructionMessage, response],
        pendingToolCalls: pending,
        approvalRequest,
        status: 'awaiting_approval',
        usage: {
          modelCalls: 1,
          iterations: 1,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
        },
        pendingInstructions: [],
      };
    }

    if (pending.length > 0) {
      return {
        messages: [...instructionMessage, response],
        pendingToolCalls: pending,
        status: 'executing',
        usage: {
          modelCalls: 1,
          iterations: 1,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
        },
        pendingInstructions: [],
      };
    }

    const text = messageText(response).trim();
    context.emit({ type: 'message', role: 'assistant', content: truncate(text, 8000) });
    return {
      messages: [...instructionMessage, response],
      finalSummary: text,
      status: state.verificationRequired ? 'verifying' : 'completed',
      usage: {
        modelCalls: 1,
        iterations: 1,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      },
      pendingInstructions: [],
    };
  };

  const approval = async (state: EngineerStateType, config: any): Promise<any> => {
    const context = deps.contextFor(threadIdFrom(config));
    const request = state.approvalRequest;
    if (!request) return {};

    const resumeValue = interrupt({
      approvalId: request.id,
      reason: request.reason,
      calls: request.calls.map((call) => ({ id: call.id, name: call.name, risk: call.risk, reason: call.reason, args: summarizeArgs(call.args) })),
    });

    if (resumeValue && typeof resumeValue === 'object' && (resumeValue as any).type === 'instruction') {
      const instruction = String((resumeValue as any).instruction ?? '').slice(0, 8000);
      context.emit({ type: 'instruction', content: instruction, source: 'approval' });
      return {
        approvalRequest: null,
        pendingToolCalls: [],
        approvedToolCallIds: [],
        deniedToolCallIds: [],
        status: 'reasoning',
        pendingInstructions: instruction.trim() === '' ? [] : [instruction],
        messages: state.pendingToolCalls.map(call => new ToolMessage({ content: 'Superseded by a new user instruction; not executed.', tool_call_id: call.id, name: call.name })),
      };
    }

    if ((resumeValue as any)?.approvalId !== request.id) throw new Error('Approval does not match the pending request.');
    const decision = normalizeDecision(resumeValue);
    const calls = state.approvalRequest?.calls ?? state.pendingToolCalls;
    const perCall = new Map(decision.decisions.map((entry) => [entry.toolCallId, entry]));
    const approvedIds: string[] = [];
    const deniedIds: string[] = [];
    for (const call of calls) {
      const entry = perCall.get(call.id);
      const approved = entry ? entry.approved : decision.approved;
      if (approved) approvedIds.push(call.id);
      else deniedIds.push(call.id);
    }

    const historyEntry: ApprovalDecision = {
      approvalId: request.id,
      approved: decision.approved,
      decisions: decision.decisions,
      note: decision.note,
      decidedAt: Date.now(),
      actor: context.actor,
    };
    context.emit({
      type: 'approval_decided',
      approvalId: request.id,
      approved: decision.approved,
      decisions: decision.decisions,
      note: decision.note,
      actor: historyEntry.actor,
    });

    return {
      approvalRequest: null,
      approvalHistory: [historyEntry],
      approvedToolCallIds: approvedIds,
      deniedToolCallIds: deniedIds,
      status: 'executing',
    };
  };

  const tools = async (state: EngineerStateType, config: any): Promise<any> => {
    const context = deps.contextFor(threadIdFrom(config));
    const calls = state.pendingToolCalls;
    if (calls.length === 0) return { status: 'reasoning' };

    const approved = new Set(state.approvedToolCallIds);
    const denied = new Set(state.deniedToolCallIds);
    const messages: ToolMessage[] = [];
    const changedFiles: EngineerFileChange[] = [];
    const diagnostics: EngineerDiagnostic[] = [];
    let verification: EngineerStateType['verification'] = null;
    let executed = 0;
    const records: import("./types.js").ToolCallRecord[] = [];
    let budgetProblem: string | null = null;

    for (const call of calls) {
      if (context.cancelled() || context.signal?.aborted) budgetProblem = 'Run cancelled.';
      if (state.usage.toolCalls + executed >= state.budget.maxToolCalls) budgetProblem = 'Tool-call budget exhausted.';
      if (Date.now() - state.startedAt >= state.budget.maxWallMs) budgetProblem = 'Wall-clock budget exhausted.';
      if (budgetProblem) {
        messages.push(new ToolMessage({ content: `Not executed: ${budgetProblem}`, tool_call_id: call.id, name: call.name }));
        continue;
      }
      if (denied.has(call.id)) {
        messages.push(new ToolMessage({ content: 'The user denied this tool call. Do not retry it without a new instruction.', tool_call_id: call.id, name: call.name }));
        context.emit({ type: 'tool_end', tool: call.name, callId: call.id, ok: false, denied: true, message: 'Denied by user.' });
        continue;
      }
      const spec: EngineerToolSpec | undefined = deps.registry.get(call.name);
      if (!spec) {
        messages.push(new ToolMessage({
          content: `Unknown tool "${call.name}". Available tools: ${deps.registry.names().join(', ')}`,
          tool_call_id: call.id,
          name: call.name,
        }));
        continue;
      }
      const verdict = deps.registry.approval(call.name, call.args);
      if (verdict.required && !approved.has(call.id)) {
        messages.push(new ToolMessage({ content: 'This tool call requires human approval and was not approved.', tool_call_id: call.id, name: call.name }));
        continue;
      }
      const parsed = spec.schema.safeParse(call.args ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues.map((item) => `${item.path.join('.') || '(root)'}: ${item.message}`).join('; ');
        messages.push(new ToolMessage({ content: `Invalid arguments for ${call.name}: ${issue}`, tool_call_id: call.id, name: call.name }));
        continue;
      }

      const startedAt = Date.now();
      context.emit({ type: 'tool_start', tool: call.name, callId: call.id, risk: verdict.risk, args: summarizeArgs(call.args) });
      const trackCommands = /^(run_command|flutter_|pub_|dart_|git_|project_checkpoint_restore|verify_project|preview_start)/.test(call.name);
      const before = trackCommands ? await snapshotFiles(context.projectRoot) : null;
      try {
        const outcome = await spec.invoke(parsed.data, context);
        records.push({ id: call.id, name: call.name, args: summarizeArgs(call.args), ok: outcome.data?.ok !== false,
          risk: verdict.risk, approved: approved.has(call.id), durationMs: Date.now() - startedAt, at: startedAt });
        executed += 1;
        messages.push(new ToolMessage({ content: truncate(outcome.content, 40_000), tool_call_id: call.id, name: call.name }));
        if (outcome.changedFiles) {
          for (const change of outcome.changedFiles) {
            changedFiles.push(change);
            context.emit({ type: 'file', path: change.path, action: change.action, language: change.language });
          }
        }
        if (outcome.diagnostics) diagnostics.push(...outcome.diagnostics);
        if (outcome.verification) verification = outcome.verification;
        context.emit({
          type: 'tool_end',
          tool: call.name,
          callId: call.id,
          ok: outcome.data?.ok !== false,
          durationMs: Date.now() - startedAt,
          summary: truncate(outcome.content, 600),
        });
      } catch (error: any) {
        executed += 1;
        const message = error instanceof Error ? error.message : String(error);
        records.push({ id: call.id, name: call.name, args: summarizeArgs(call.args), ok: false, error: message, risk: verdict.risk, durationMs: Date.now() - startedAt, at: startedAt });
        messages.push(new ToolMessage({ content: `Tool ${call.name} failed: ${message}`, tool_call_id: call.id, name: call.name }));
        context.emit({ type: 'tool_end', tool: call.name, callId: call.id, ok: false, durationMs: Date.now() - startedAt, summary: truncate(message, 600) });
        if (/budget/i.test(message)) budgetProblem = message;
      } finally {
        // Commands can create/change files even when they exit unsuccessfully.
        if (before) {
          const actual = diffSnapshots(before, await snapshotFiles(context.projectRoot));
          for (const change of actual) {
            try { resolveInside(context.projectRoot, change.path); } catch { continue; }
            changedFiles.push(change);
            context.emit({ type: 'file', path: change.path, action: change.action, language: change.language });
          }
          if (actual.length && !/^(verify_project|preview_start)$/.test(call.name)) verification = null;
        }
      }
    }

    return {
      messages,
      pendingToolCalls: [],
      approvedToolCallIds: [],
      deniedToolCallIds: [],
      status: 'reasoning',
      changedFiles: changedFiles.map(({ content: _content, ...reference }) => reference),
      toolCalls: records,
      diagnostics,
      verification,
      usage: { toolCalls: executed },
    };
  };

  const verify = async (state: EngineerStateType, config: any): Promise<any> => {
    const context = deps.contextFor(threadIdFrom(config));
    try {
      if (context.cancelled() || context.signal?.aborted) return { status: 'cancelled' };
      if (state.usage.toolCalls >= state.budget.maxToolCalls) return { status: 'failed', error: 'Verification tool budget exhausted.' };
      const verification = await context.verify();
      const attempts = (state.verifyAttempts ?? 0) + 1;
      context.emit({
        type: 'verification',
        passed: verification.passed,
        skipped: verification.skipped === true,
        errorCount: verification.errorCount,
        warningCount: verification.warningCount,
        summary: verification.summary,
        attempt: attempts,
      });
      return {
        verification,
        messages: verification.passed ? [] : [new HumanMessage(`Verification failed. Repair using this evidence:\n${verification.summary}\n${verification.evidence.join('\n')}`)],
        diagnostics: verification.diagnostics,
        verifyAttempts: attempts,
        status: verification.passed ? 'completed' : 'verifying',
        usage: { toolCalls: 1 },
      };
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      context.emit({ type: 'verification', passed: false, errorCount: 1, warningCount: 0, summary: message, attempt: (state.verifyAttempts ?? 0) + 1 });
      return {
        verification: {
          passed: false,
          skipped: true,
          summary: `Verification could not run: ${message}`,
          errorCount: 0,
          warningCount: 0,
          diagnostics: [],
          evidence: [],
          at: Date.now(),
        },
        verifyAttempts: (state.verifyAttempts ?? 0) + 1,
        status: 'verifying',
        usage: { toolCalls: 1 },
      };
    }
  };

  const finalize = async (state: EngineerStateType, config: any): Promise<any> => {
    const context = deps.contextFor(threadIdFrom(config));
    let status: EngineerStateType['status'] = state.status;
    let error = state.error;
    if (state.cancellationRequested || context.cancelled()) {
      status = 'cancelled';
      error = error ?? 'Cancelled by the user.';
    } else if (error) {
      status = 'failed';
    } else if (state.verificationRequired && state.changedFiles.length > 0 && state.verification && !state.verification.passed) {
      status = 'failed';
      error = `Verification did not pass: ${state.verification.summary}`;
    } else if (state.verificationRequired && state.changedFiles.length > 0 && !state.verification) {
      status = 'failed';
      error = 'Changes were made but the deterministic verification gate never ran.';
    } else {
      status = 'completed';
    }

    const summary = status === 'completed'
      ? state.finalSummary?.trim() || 'The engineer stopped without a written summary.'
      : error ?? 'The run did not complete.';

    context.emit({
      type: status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed',
      status,
      summary: truncate(summary, 8000),
      error: error ?? null,
      changedFiles: state.changedFiles.map((change) => ({ path: change.path, action: change.action })),
      verification: state.verification
        ? { passed: state.verification.passed, summary: state.verification.summary, errorCount: state.verification.errorCount }
        : null,
    });

    return { status, finalSummary: summary, error: error ?? null };
  };

  const routeAfterReason = (state: EngineerStateType): string => {
    if (state.status === 'cancelled' || state.status === 'failed') return 'finalize';
    if (state.cancellationRequested) return 'finalize';
    if (state.approvalRequest && state.pendingToolCalls.length > 0) return 'approval';
    if (state.pendingToolCalls.length > 0) return 'tools';
    if (state.specialists.includes('reviewer') && !state.specialistReports.some(report => report.role === 'reviewer')) return 'reviewer';
    return routeToVerification(state);
  };

  const routeToVerification = (state: EngineerStateType): string => {
    if (
      state.verificationRequired
      && state.changedFiles.length > 0
      && !state.verification?.passed
      && state.verifyAttempts < maxVerifyAttempts
    ) {
      return 'verify';
    }
    return 'finalize';
  };

  const routeAfterApproval = (state: EngineerStateType): string => (
    state.pendingToolCalls.length > 0 ? 'tools' : 'reason'
  );

  const routeAfterVerify = (state: EngineerStateType): string => {
    if (state.status === 'cancelled' || state.status === 'failed' || state.verification?.passed || state.verification?.skipped === true) return 'finalize';
    if (state.verifyAttempts >= maxVerifyAttempts) return 'finalize';
    if (state.usage.toolCalls >= state.budget.maxToolCalls) return 'finalize';
    return 'reason';
  };

  const control = async (state: EngineerStateType, config: any) => {
    const context = deps.contextFor(threadIdFrom(config));
    if (context.paused?.()) {
      interrupt({ type: 'pause', reason: 'Execution paused by the user.' });
    }
    return {};
  };

  return new StateGraph(EngineerState)
    .addNode('planner', (state, config) => runSpecialist('planner', state, deps.contextFor(threadIdFrom(config)), deps.specialistModel))
    .addNode('reviewer', (state, config) => runSpecialist('reviewer', state, deps.contextFor(threadIdFrom(config)), deps.specialistModel))
    .addNode('control', control)
    .addNode('reason', reason)
    .addNode('approval', approval)
    .addNode('tools', tools)
    .addNode('verify', verify)
    .addNode('finalize', finalize)
    .addEdge(START, 'control')
    .addConditionalEdges('control', state =>
      state.specialists.includes('planner') && !state.specialistReports.some(report => report.role === 'planner') ? 'planner' : 'reason',
      { planner: 'planner', reason: 'reason' })
    .addConditionalEdges('planner', state => state.status === 'cancelled' ? 'finalize' : 'reason', { finalize: 'finalize', reason: 'reason' })
    .addConditionalEdges('reviewer', state => {
      if (state.status === 'cancelled') return 'finalize';
      return state.specialistReports.some(report => report.role === 'reviewer' && report.status === 'completed') ? 'control' : routeToVerification(state);
    }, { control: 'control', verify: 'verify', finalize: 'finalize' })
    .addConditionalEdges('reason', routeAfterReason, {
      reviewer: 'reviewer',
      approval: 'approval',
      tools: 'tools',
      verify: 'verify',
      finalize: 'finalize',
    })
    .addConditionalEdges('approval', routeAfterApproval, {
      tools: 'tools',
      reason: 'reason',
    })
    .addEdge('tools', 'control')
    .addConditionalEdges('verify', routeAfterVerify, {
      reason: 'reason',
      finalize: 'finalize',
    })
    .addEdge('finalize', END)
    .compile({ checkpointer: deps.checkpointer });
}

function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (typeof value === 'string') summary[key] = truncate(value, 300);
    else if (Array.isArray(value)) summary[key] = value.slice(0, 10).map((entry) => (typeof entry === 'string' ? truncate(entry, 120) : entry));
    else if (value && typeof value === 'object') summary[key] = safeJson(value).slice(0, 500);
    else summary[key] = value;
  }
  return summary;
}
