/**
 * Durable workflow engine.
 *
 * A workflow is a versioned DAG of steps. Execution is persisted after every
 * transition, leases are claimed atomically in SQLite, and a worker that dies
 * mid-step is resumed by another worker once its lease expires. A step whose
 * output is durable is never re-run. A step parked for human approval resumes
 * after the decision is recorded.
 *
 * This is not a general-purpose job queue: steps are ordinary async code
 * invoked through a typed context, with optional retry, timeout, approval
 * gating, and saga compensation.
 */
import { EventEmitter } from 'node:events';
import {
  PlatformError,
  TimeoutError,
  describeError,
  isRetryable,
  sleep,
} from '../kernel/errors.js';
import { prefixedId } from '../kernel/ids.js';
import { systemClock, type Clock } from '../kernel/clock.js';
import { createLogger, type Logger } from '../kernel/logger.js';
import type { Database, TransactionContext } from '../storage/database.js';
import { IdempotencyStore } from '../storage/idempotency.js';
import type { AuditLog } from '../audit/auditLog.js';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'compensating'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ApprovalDecision = 'approved' | 'rejected';

export interface ApprovalRecord {
  id: string;
  runId: string;
  stepId: string;
  status: 'pending' | 'approved' | 'rejected';
  risk: RiskLevel;
  reason: string;
  summary: Record<string, unknown>;
  requestedAt: number;
  decidedAt?: number;
  decidedBy?: string;
  decisionNote?: string;
}
export interface StepOutputs {
  [stepId: string]: unknown;
}


export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 30_000,
  jitter: true,
};

export interface StepDefinition {
  readonly id: string;
  readonly dependsOn?: readonly string[];
  readonly description?: string;
  readonly timeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
  /** Return false to skip the step without failing the run. */
  readonly when?: (input: RunInput, outputs: StepOutputs) => boolean | Promise<boolean>;
  readonly run: (context: StepContext) => Promise<unknown>;
  readonly compensate?: (context: StepContext) => Promise<void>;
}

export interface WorkflowDefinition {
  readonly name: string;
  readonly version: number;
  readonly description?: string;
  readonly displayName?: string;
  readonly steps: readonly StepDefinition[];
}

export type RunInput = unknown;

export interface StepContext {
  readonly runId: string;
  readonly stepId: string;
  readonly definition: string;
  readonly attempt: number;
  readonly input: RunInput;
  readonly outputs: StepOutputs;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly actor: string;
  readonly projectId?: string;
  readonly tenantId: string;
  emit(type: string, data: Record<string, unknown>): Promise<void>;
  requestApproval(request: {
    risk: RiskLevel;
    reason: string;
    summary: Record<string, unknown>;
  }): Promise<void>;
}

export interface RunRecord {
  id: string;
  definition: string;
  definitionVersion: number;
  status: RunStatus;
  input: RunInput;
  output: unknown | null;
  error: { code: string; message: string; details?: unknown } | null;
  tenantId: string;
  projectId?: string;
  actor: string;
  parentRunId?: string;
  attempt: number;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface StepRecord {
  runId: string;
  stepId: string;
  status: StepStatus;
  attempt: number;
  output: unknown | null;
  error: { code: string; message: string } | null;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
}

export interface RunEvent {
  seq: number;
  runId: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface StartOptions {
  tenantId: string;
  projectId?: string;
  actor: string;
  input?: unknown;
  idempotencyKey?: string;
  parentRunId?: string;
}

export interface EngineOptions {
  db: Database;
  clock?: Clock;
  logger?: Logger;
  audit?: AuditLog;
  workerId?: string;
  leaseTtlMs?: number;
  defaultStepTimeoutMs?: number;
  maxConcurrentRuns?: number;
  idempotencyTtlMs?: number;
}

const HEARTBEAT_FRACTION = 3;

/** Sentinel thrown by the context to park a run for human approval. */
class SuspendRun extends Error {
  constructor(readonly approval: { risk: RiskLevel; reason: string; summary: Record<string, unknown> }) {
    super('Run suspended pending human approval.');
    this.name = 'SuspendRun';
  }
}

export class WorkflowEngine {
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly audit?: AuditLog;
  private readonly workerId: string;
  private readonly leaseTtlMs: number;
  private readonly defaultStepTimeoutMs: number;
  private readonly maxConcurrentRuns: number;
  private readonly idempotency: IdempotencyStore;
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private readonly running = new Set<string>();
  private readonly activeAbort = new Map<string, AbortController>();
  private readonly emitter = new EventEmitter();

  constructor(options: EngineOptions) {
    this.db = options.db;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? createLogger({ name: 'workflow' });
    this.audit = options.audit;
    this.workerId = options.workerId ?? `worker-${process.pid}-${prefixedId('w', this.clock.now()).slice(2, 8)}`;
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000;
    this.defaultStepTimeoutMs = options.defaultStepTimeoutMs ?? 15 * 60_000;
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 4;
    this.idempotency = new IdempotencyStore(this.db, this.clock);
    this.emitter.setMaxListeners(100);
  }

  // ------------------------------------------------------------------
  // Registry
  // ------------------------------------------------------------------

  register(definition: WorkflowDefinition): void {
    validateDefinition(definition);
    this.definitions.set(definitionKey(definition), definition);
  }

  listDefinitions(): Array<{ name: string; version: number; description?: string; steps: string[] }> {
    return [...this.definitions.values()].map((definition) => ({
      name: definition.name,
      version: definition.version,
      description: definition.description,
      steps: definition.steps.map((step) => step.id),
    }));
  }

  private definition(name: string, version?: number): WorkflowDefinition {
    if (version !== undefined) {
      const found = this.definitions.get(`${name}@${version}`);
      if (!found) throw new PlatformError({ code: 'WORKFLOW_NOT_FOUND', message: `Unknown workflow definition ${name}@${version}.`, statusCode: 404 });
      return found;
    }
    const candidates = [...this.definitions.values()].filter((definition) => definition.name === name).sort((a, b) => b.version - a.version);
    if (candidates.length === 0) throw new PlatformError({ code: 'WORKFLOW_NOT_FOUND', message: `Unknown workflow definition ${name}.`, statusCode: 404 });
    return candidates[0];
  }

  // ------------------------------------------------------------------
  // Starting runs
  // ------------------------------------------------------------------

  async start(name: string, options: StartOptions): Promise<{ run: RunRecord; created: boolean }> {
    const definition = this.definition(name);
    const key = options.idempotencyKey ? IdempotencyStore.key(options.idempotencyKey) : undefined;

    if (key) {
      const existing = await this.findByIdempotency(definition.name, key, options.tenantId);
      if (existing) return { run: existing, created: false };
    }

    const runId = prefixedId('run', this.clock.now());
    const now = this.clock.now();
    const inputJson = JSON.stringify(options.input ?? null);

    try {
      await this.db.transaction(async (tx) => {
        await tx.run(
          `INSERT INTO workflow_runs
             (id, definition, definition_version, status, input_json, tenant_id, project_id, actor,
              idempotency_key, parent_run_id, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
          runId, definition.name, definition.version, inputJson,
          options.tenantId, options.projectId ?? null, options.actor, key ?? null, options.parentRunId ?? null,
          now, now,
        );
        await this.insertSteps(runId, definition, now, tx);
      });
    } catch (error) {
      if (key && isUniqueViolation(error)) {
        const existing = await this.findByIdempotency(definition.name, key, options.tenantId);
        if (existing) return { run: existing, created: false };
      }
      throw error;
    }
    await this.appendEvent(runId, 'run.created', { definition: definition.name, version: definition.version, actor: options.actor });
    await this.audit?.append({
      tenantId: options.tenantId,
      actor: options.actor,
      action: 'workflow.start',
      resourceType: 'workflow_run',
      resourceId: runId,
      metadata: { definition: definition.name, version: definition.version, projectId: options.projectId ?? null },
    });

    const run = await this.getRun(runId);
    if (!run) throw new PlatformError({ code: 'WORKFLOW_START_FAILED', message: 'The run was created but could not be read back.' });
    return { run, created: true };
  }

  private async findByIdempotency(definitionName: string, key: string, tenantId: string): Promise<RunRecord | null> {
    const row = await this.db.get<any>('SELECT * FROM workflow_runs WHERE tenant_id = ? AND definition = ? AND idempotency_key = ? LIMIT 1', tenantId, definitionName, key);
    return row ? mapRun(row) : null;
  }

  private async insertSteps(runId: string, definition: WorkflowDefinition, now: number, tx?: TransactionContext): Promise<void> {
    const db = tx ?? this.db;
    for (const step of definition.steps) {
      await db.run(
        `INSERT INTO workflow_steps (run_id, step_id, status, attempt, updated_at)
         VALUES (?, ?, 'pending', 0, ?)
         ON CONFLICT (run_id, step_id) DO NOTHING`,
        runId, step.id, now,
      );
    }
  }

  // ------------------------------------------------------------------
  // Scheduling
  // ------------------------------------------------------------------

  /** Claim resumable runs up to the concurrency budget and execute them. Returns the number claimed. */
  async tick(): Promise<number> {
    const available = Math.max(0, this.maxConcurrentRuns - this.running.size);
    if (available === 0) return 0;
    const claimed = await this.claimRuns(available);
    for (const runId of claimed) {
      void this.executeRun(runId).catch((error) => {
        this.logger.error('run crashed outside the engine loop', error, { runId });
      });
    }
    return claimed.length;
  }

  private async claimRun(runId: string): Promise<boolean> {
    const now = this.clock.now();
    const result = await this.db.run(
      `UPDATE workflow_runs
         SET status = 'running', worker_id = ?, lease_expires_at = ?,
             attempt = attempt + 1,
             started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ?
         AND (status = 'pending'
              OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?))`,
      this.workerId, now + this.leaseTtlMs, now, now, runId, now,
    );
    if (result.changes !== 1) return false;
    await this.db.run(
      `UPDATE workflow_steps SET status = 'pending', updated_at = ? WHERE run_id = ? AND status = 'running'`,
      now, runId,
    );
    return true;
  }


  private async claimRuns(limit: number): Promise<string[]> {
    const now = this.clock.now();
    const rows = await this.db.all<any>(
      `SELECT id FROM workflow_runs
       WHERE status = 'pending'
          OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
       ORDER BY created_at ASC
       LIMIT ?`,
      now, limit,
    );
    const claimed: string[] = [];
    for (const row of rows) {
      if (await this.claimRun(row.id)) claimed.push(row.id);
    }
    return claimed;
  }

  /** Execute a run to a terminal or parked state. Safe to call; no-op if another invocation is active. */
  async executeRun(runId: string): Promise<void> {
    if (this.running.has(runId)) return;
    this.running.add(runId);
    const abort = new AbortController();
    this.activeAbort.set(runId, abort);
    const heartbeat = setInterval(() => void this.renewLease(runId), Math.max(250, Math.floor(this.leaseTtlMs / HEARTBEAT_FRACTION)));
    heartbeat.unref?.();

    try {
      // tick() claims runs and then hands them here; direct callers (API,
      // tests) claim on demand. Either way, ownership is verified here.
      const alreadyOurs = await this.ownsActiveLease(runId);
      const claimed = alreadyOurs || await this.claimRun(runId);
      if (!claimed) return;
      await this.runLoop(runId, abort.signal);
    } finally {
      clearInterval(heartbeat);
      this.running.delete(runId);
      this.activeAbort.delete(runId);
    }
  }

  private async ownsActiveLease(runId: string): Promise<boolean> {
    const row = await this.db.get<{ worker_id: string | null; lease_expires_at: number | null }>(
      'SELECT worker_id, lease_expires_at FROM workflow_runs WHERE id = ?', runId,
    );
    return row?.worker_id === this.workerId && (row.lease_expires_at ?? 0) >= this.clock.now();
  }

  private async renewLease(runId: string): Promise<void> {
    const now = this.clock.now();
    await this.db.run(
      `UPDATE workflow_runs SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND worker_id = ?`,
      now + this.leaseTtlMs, now, runId, this.workerId,
    );
  }

  private async holdsLease(runId: string): Promise<boolean> {
    const row = await this.db.get<{ worker_id: string | null; lease_expires_at: number | null }>(
      'SELECT worker_id, lease_expires_at FROM workflow_runs WHERE id = ?', runId,
    );
    return row?.worker_id === this.workerId && (row.lease_expires_at ?? 0) >= this.clock.now();
  }

  private async runLoop(runId: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      const run = await this.getRun(runId);
      if (!run || run.status !== 'running') return;

      if (!(await this.holdsLease(runId))) {
        this.logger.warn('lease lost; another worker will continue this run', { runId });
        return;
      }
      if (run.cancelRequested || signal.aborted) {
        await this.finishCancelled(runId, 'Cancelled by request.');
        return;
      }

      const definition = this.definition(run.definition, run.definitionVersion);
      const ordered = topologicalOrder(definition);
      const steps = await this.loadSteps(runId);
      const outputs = buildOutputs(steps);

      const next = ordered.find((step) => {
        const record = steps.find((s) => s.stepId === step.id);
        return record && (record.status === 'pending' || record.status === 'running');
      });

      if (!next) {
        await this.finishSucceeded(runId, outputs);
        return;
      }

      await this.executeStep(run, definition, next, steps, outputs, signal);
    }
  }

  private async executeStep(
    run: RunRecord,
    definition: WorkflowDefinition,
    stepDef: StepDefinition,
    steps: StepRecord[],
    outputs: StepOutputs,
    parentSignal: AbortSignal,
  ): Promise<void> {
    const now = this.clock.now();
    const record = steps.find((s) => s.stepId === stepDef.id);
    const attempt = (record?.attempt ?? 0) + 1;

    // `when` gate: a false result skips without failing the run.
    if (stepDef.when) {
      try {
        const shouldRun = await stepDef.when(run.input, outputs);
        if (!shouldRun) {
          await this.db.run(
            `UPDATE workflow_steps SET status = 'skipped', updated_at = ? WHERE run_id = ? AND step_id = ?`,
            now, run.id, stepDef.id,
          );
          await this.appendEvent(run.id, 'step.skipped', { stepId: stepDef.id });
          return;
        }
      } catch (error) {
        this.logger.warn('step `when` predicate threw; running the step anyway', { runId: run.id, stepId: stepDef.id, err: describeError(error) });
      }
    }

    await this.db.run(
      `UPDATE workflow_steps SET status = 'running', attempt = ?, started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE run_id = ? AND step_id = ?`,
      attempt, now, now, run.id, stepDef.id,
    );
    await this.appendEvent(run.id, 'step.started', { stepId: stepDef.id, attempt });

    const controller = new AbortController();
    const timeoutMs = stepDef.timeoutMs ?? this.defaultStepTimeoutMs;
    const timer = setTimeout(() => controller.abort(new TimeoutError(stepDef.id, timeoutMs)), Math.max(1, timeoutMs));
    timer.unref?.();
    const onParentAbort = () => controller.abort(new Error('Parent workflow was aborted.'));
    parentSignal.addEventListener('abort', onParentAbort, { once: true });

    const stepId = stepDef.id;
    const context: StepContext = {
      runId: run.id,
      stepId,
      definition: `${definition.name}@${definition.version}`,
      attempt,
      input: run.input,
      outputs,
      signal: controller.signal,
      logger: this.logger.child({ runId: run.id, stepId, attempt }),
      clock: this.clock,
      actor: run.actor,
      projectId: run.projectId,
      tenantId: run.tenantId,
      emit: async (type, data) => {
        await this.appendEvent(run.id, type, data, stepId);
      },
      requestApproval: async (request) => {
        const granted = await this.findGrantedApproval(run.id, stepId);
        if (granted) return; // resuming after a human approved this exact gate
        const pending = await this.findPendingApproval(run.id, stepId);
        if (!pending) await this.parkForApproval(run, stepId, request);
        throw new SuspendRun(request);
      },
    };

    try {
      const output = await this.invokeWithTimeout(context, stepDef, timeoutMs);
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);

      const finished = this.clock.now();
      await this.db.run(
        `UPDATE workflow_steps
           SET status = 'succeeded', output_json = ?, error_json = NULL, finished_at = ?, updated_at = ?
         WHERE run_id = ? AND step_id = ?`,
        JSON.stringify(output ?? null), finished, finished, run.id, stepId,
      );
      await this.appendEvent(run.id, 'step.succeeded', { stepId, attempt, durationMs: finished - now });
      return;
    } catch (error) {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);

      if (error instanceof SuspendRun) return; // run is parked waiting for approval
      if (controller.signal.aborted && parentSignal.aborted) {
        // Parent was cancelled: leave the step pending so resume re-runs it.
        await this.db.run(`UPDATE workflow_steps SET status = 'pending', updated_at = ? WHERE run_id = ? AND step_id = ?`, this.clock.now(), run.id, stepId);
        return;
      }

      const retry = { ...DEFAULT_RETRY, ...stepDef.retry };
      const retryable = isRetryable(error) || error instanceof TimeoutError;

      if (retryable && attempt < retry.maxAttempts && !controller.signal.aborted) {
        const exponential = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
        const delay = Math.max(1, Math.round(retry.jitter ? exponential * (0.5 + Math.random() * 0.5) : exponential));
        await this.db.run(
          `UPDATE workflow_steps SET status = 'pending', updated_at = ? WHERE run_id = ? AND step_id = ?`,
          this.clock.now(), run.id, stepId,
        );
        await this.appendEvent(run.id, 'step.retry_scheduled', {
          stepId, attempt, delayMs: delay, error: describeError(error),
        });
        await sleep(delay, controller.signal.aborted ? undefined : parentSignal);
        return;
      }

      const failure = describeError(error);
      await this.db.run(
        `UPDATE workflow_steps
           SET status = 'failed', output_json = NULL, error_json = ?, finished_at = ?, updated_at = ?
         WHERE run_id = ? AND step_id = ?`,
        JSON.stringify({ code: failure.code ?? failure.name, message: failure.message }),
        this.clock.now(), this.clock.now(), run.id, stepId,
      );
      await this.appendEvent(run.id, 'step.failed', { stepId, attempt, error: failure });
      await this.failRun(run, definition, error);
    }
  }

  private async invokeWithTimeout(context: StepContext, stepDef: StepDefinition, timeoutMs: number): Promise<unknown> {
    const signal = context.signal;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(stepDef.id, timeoutMs)), Math.max(1, timeoutMs));
      timer.unref?.();
    });
    try {
      return await Promise.race([Promise.resolve().then(() => stepDef.run(context)), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      void signal; // the step may observe the timeout via context.signal, which we cannot forcibly interrupt
    }
  }

  // ------------------------------------------------------------------
  // Approvals (human governance)
  // ------------------------------------------------------------------

  private async parkForApproval(run: RunRecord, stepId: string, request: { risk: RiskLevel; reason: string; summary: Record<string, unknown> }): Promise<void> {
    const now = this.clock.now();
    // One pending approval per run+step at a time.
    const existing = await this.findPendingApproval(run.id, stepId);
    if (existing) {
      await this.db.run(`UPDATE workflow_runs SET status = 'waiting_approval', lease_expires_at = NULL, updated_at = ? WHERE id = ?`, now, run.id);
      return;
    }

    const approvalId = prefixedId('apv', now);
    await this.db.run(
      `INSERT INTO workflow_approvals (id, run_id, step_id, status, risk, reason, summary_json, requested_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
      approvalId, run.id, stepId, request.risk, request.reason, JSON.stringify(request.summary ?? {}), now,
    );
    await this.db.run(
      `UPDATE workflow_steps SET status = 'pending', updated_at = ? WHERE run_id = ? AND step_id = ?`,
      now, run.id, stepId,
    );
    await this.db.run(
      `UPDATE workflow_runs SET status = 'waiting_approval', lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
      now, run.id,
    );
    await this.appendEvent(run.id, 'run.approval_required', { stepId, approvalId, risk: request.risk, reason: request.reason }, stepId);
    await this.audit?.append({
      tenantId: run.tenantId,
      actor: run.actor,
      action: 'workflow.approval_requested',
      resourceType: 'workflow_run',
      resourceId: run.id,
      metadata: { stepId, approvalId, risk: request.risk, reason: request.reason, summary: request.summary },
    });
  }

  private async findPendingApproval(runId: string, stepId: string): Promise<{ id: string } | null> {
    return (await this.db.get<{ id: string }>(
      `SELECT id FROM workflow_approvals WHERE run_id = ? AND step_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1`,
      runId, stepId,
    )) ?? null;
  }

  private async findGrantedApproval(runId: string, stepId: string): Promise<{ id: string } | null> {
    return (await this.db.get<{ id: string }>(
      `SELECT id FROM workflow_approvals WHERE run_id = ? AND step_id = ? AND status = 'approved' ORDER BY decided_at DESC LIMIT 1`,
      runId, stepId,
    )) ?? null;
  }

  async decideApproval(approvalId: string, decision: ApprovalDecision, actor: string, note?: string): Promise<ApprovalRecord> {
    return this.db.transaction(async (tx) => {
      const row = await tx.get<any>('SELECT * FROM workflow_approvals WHERE id = ?', approvalId);
      if (!row) throw new PlatformError({ code: 'APPROVAL_NOT_FOUND', message: `Approval ${approvalId} was not found.`, statusCode: 404 });
      if (row.status !== 'pending') {
        throw new PlatformError({ code: 'APPROVAL_ALREADY_DECIDED', message: 'This approval has already been decided.', statusCode: 409, details: { decision: row.status } });
      }

      const now = this.clock.now();
      await tx.run(
        `UPDATE workflow_approvals SET status = ?, decided_at = ?, decided_by = ?, decision_note = ? WHERE id = ? AND status = 'pending'`,
        decision, now, actor, note ?? null, approvalId,
      );

      const tenantRow = await tx.get<{ tenant_id: string }>('SELECT tenant_id FROM workflow_runs WHERE id = ?', row.run_id);
      if (decision === 'approved') {
        await tx.run(`UPDATE workflow_runs SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'waiting_approval'`, now, row.run_id);
        await this.appendEvent(row.run_id, 'run.approval_granted', { approvalId, stepId: row.step_id, actor }, row.step_id);
      } else {
        await tx.run(
          `UPDATE workflow_runs SET status = 'failed', error_json = ?, lease_expires_at = NULL, finished_at = ?, updated_at = ? WHERE id = ?`,
          JSON.stringify({ code: 'APPROVAL_REJECTED', message: note ?? 'Human rejected the action.' }), now, now, row.run_id,
        );
        await tx.run(
          `UPDATE workflow_steps SET status = 'failed', error_json = ?, updated_at = ? WHERE run_id = ? AND step_id = ?`,
          JSON.stringify({ code: 'APPROVAL_REJECTED', message: note ?? 'Human rejected the action.' }), now, row.run_id, row.step_id,
        );
        await this.appendEvent(row.run_id, 'run.approval_rejected', { approvalId, stepId: row.step_id, actor, note }, row.step_id);
      }

      await this.audit?.append({
        tenantId: tenantRow?.tenant_id ?? 'unknown',
        actor,
        action: decision === 'approved' ? 'workflow.approval_granted' : 'workflow.approval_rejected',
        resourceType: 'workflow_approval',
        resourceId: approvalId,
        metadata: { runId: row.run_id, stepId: row.step_id, risk: row.risk, note },
      });

      return mapApproval({ ...row, status: decision, decided_at: now, decided_by: actor, decision_note: note ?? null });
    });
  }

  async listPendingApprovals(options: { tenantId?: string; limit?: number } = {}): Promise<ApprovalRecord[]> {
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    const rows = options.tenantId
      ? await this.db.all<any>(
        `SELECT a.* FROM workflow_approvals a
           JOIN workflow_runs r ON r.id = a.run_id
         WHERE a.status = 'pending' AND r.tenant_id = ?
         ORDER BY a.requested_at ASC LIMIT ?`,
        options.tenantId, limit,
      )
      : await this.db.all<any>('SELECT * FROM workflow_approvals WHERE status = ? ORDER BY requested_at ASC LIMIT ?', 'pending', limit);
    return rows.map(mapApproval);
  }

  // ------------------------------------------------------------------
  // Cancellation
  // ------------------------------------------------------------------

  async cancel(runId: string, actor: string, reason?: string): Promise<RunRecord> {
    const run = await this.getRun(runId);
    if (!run) throw new PlatformError({ code: 'RUN_NOT_FOUND', message: `Workflow run ${runId} was not found.`, statusCode: 404 });
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;

    const now = this.clock.now();
    await this.db.run(
      `UPDATE workflow_runs SET cancel_requested = 1, updated_at = ? WHERE id = ?`,
      now, runId,
    );
    this.activeAbort.get(runId)?.abort(new Error(reason ?? 'Cancellation requested.'));

    if (run.status === 'waiting_approval' || run.status === 'pending') {
      await this.finishCancelled(runId, reason ?? 'Cancelled by request.');
    }

    await this.audit?.append({
      tenantId: run.tenantId,
      actor,
      action: 'workflow.cancel',
      resourceType: 'workflow_run',
      resourceId: runId,
      metadata: { definition: run.definition, reason: reason ?? null },
    });

    const updated = await this.getRun(runId);
    return updated ?? run;
  }

  private async finishCancelled(runId: string, message: string): Promise<void> {
    const now = this.clock.now();
    await this.db.run(
      `UPDATE workflow_runs SET status = 'cancelled', lease_expires_at = NULL, finished_at = ?, updated_at = ?,
              error_json = ? WHERE id = ?`,
      now, now, JSON.stringify({ code: 'CANCELLED', message }), runId,
    );
    await this.appendEvent(runId, 'run.cancelled', { message });
  }

  // ------------------------------------------------------------------
  // Outcomes
  // ------------------------------------------------------------------

  private async finishSucceeded(runId: string, output: unknown): Promise<void> {
    const now = this.clock.now();
    await this.db.run(
      `UPDATE workflow_runs SET status = 'succeeded', lease_expires_at = NULL, output_json = ?,
              error_json = NULL, finished_at = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify(output), now, now, runId,
    );
    await this.appendEvent(runId, 'run.succeeded', {});
  }

  private async failRun(run: RunRecord, definition: WorkflowDefinition, error: unknown): Promise<void> {
    const now = this.clock.now();
    await this.db.run(
      `UPDATE workflow_runs SET status = 'compensating', lease_expires_at = ?, updated_at = ? WHERE id = ?`,
      now + this.leaseTtlMs, now, run.id,
    );

    const steps = await this.loadSteps(run.id);
    const ordered = topologicalOrder(definition);
    const succeeded = new Set(steps.filter((s) => s.status === 'succeeded').map((s) => s.stepId));
    const outputs = buildOutputs(steps);
    const compensationErrors: unknown[] = [];

    for (const stepDef of [...ordered].reverse()) {
      if (!succeeded.has(stepDef.id) || !stepDef.compensate) continue;
      const attempt = 1;
      const context: StepContext = {
        runId: run.id,
        stepId: stepDef.id,
        definition: `${definition.name}@${definition.version}`,
        attempt,
        input: run.input,
        outputs,
        signal: new AbortController().signal,
        logger: this.logger.child({ runId: run.id, stepId: stepDef.id, phase: 'compensate' }),
        clock: this.clock,
        actor: run.actor,
        projectId: run.projectId,
        tenantId: run.tenantId,
        emit: async (type, data) => {
          await this.appendEvent(run.id, type, data, stepDef.id);
        },
        requestApproval: async () => {
          throw new PlatformError({ code: 'APPROVAL_NOT_AVAILABLE', message: 'Approvals are not available during compensation.' });
        },
      };
      try {
        await stepDef.compensate(context);
        await this.appendEvent(run.id, 'step.compensated', { stepId: stepDef.id });
      } catch (compensationError) {
        compensationErrors.push(compensationError);
        this.logger.error('step compensation failed', compensationError, { runId: run.id, stepId: stepDef.id });
        await this.appendEvent(run.id, 'step.compensation_failed', { stepId: stepDef.id, error: describeError(compensationError) });
      }
    }

    const failure = describeError(error);
    const finished = this.clock.now();
    await this.db.run(
      `UPDATE workflow_runs SET status = 'failed', lease_expires_at = NULL,
              error_json = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify({
        code: failure.code ?? failure.name,
        message: failure.message,
        compensationErrors: compensationErrors.length,
      }), finished, finished, run.id,
    );
    await this.appendEvent(run.id, 'run.failed', { error: failure, compensationErrors: compensationErrors.length });
    await this.audit?.append({
      tenantId: run.tenantId,
      actor: run.actor,
      action: 'workflow.failed',
      resourceType: 'workflow_run',
      resourceId: run.id,
      metadata: { definition: definition.name, code: failure.code ?? failure.name, compensationErrors: compensationErrors.length },
    });
  }

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  async getRun(runId: string): Promise<RunRecord | null> {
    const row = await this.db.get<any>('SELECT * FROM workflow_runs WHERE id = ?', runId);
    return row ? mapRun(row) : null;
  }

  async listRuns(options: { tenantId?: string; projectId?: string; status?: RunStatus; limit?: number } = {}): Promise<RunRecord[]> {
    const limit = Math.min(500, Math.max(1, options.limit ?? 50));
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.tenantId) { clauses.push('tenant_id = ?'); params.push(options.tenantId); }
    if (options.projectId) { clauses.push('project_id = ?'); params.push(options.projectId); }
    if (options.status) { clauses.push('status = ?'); params.push(options.status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.db.all<any>(`SELECT * FROM workflow_runs ${where} ORDER BY created_at DESC LIMIT ?`, ...params, limit);
    return rows.map(mapRun);
  }

  async loadSteps(runId: string): Promise<StepRecord[]> {
    const rows = await this.db.all<any>('SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY step_id ASC', runId);
    return rows.map(mapStep);
  }

  async eventsAfter(runId: string, seq = 0, limit = 500): Promise<RunEvent[]> {
    const rows = await this.db.all<any>(
      'SELECT seq, run_id, type, data_json, created_at FROM workflow_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
      runId, seq, Math.min(1000, Math.max(1, limit)),
    );
    return rows.map((row) => ({
      seq: row.seq,
      runId: row.run_id,
      type: row.type,
      data: safeJson(row.data_json) ?? {},
      createdAt: row.created_at,
    }));
  }

  /** Register a listener for run events. Returns an unsubscribe function. */
  onEvent(listener: (event: RunEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  private async appendEvent(runId: string, type: string, data: Record<string, unknown>, stepId?: string): Promise<RunEvent> {
    const now = this.clock.now();
    const payload = { ...data, ...(stepId ? { stepId } : {}) };
    const result = await this.db.run(
      'INSERT INTO workflow_events (run_id, type, data_json, created_at) VALUES (?, ?, ?, ?)',
      runId, type, JSON.stringify(payload), now,
    );
    const event: RunEvent = { seq: result.lastInsertRowid, runId, type, data: payload, createdAt: now };
    this.emitter.emit('event', event);
    return event;
  }

  // ------------------------------------------------------------------
  // Maintenance
  // ------------------------------------------------------------------

  /** Delete finished runs older than `retentionDays`. */
  async pruneRetention(retentionDays: number): Promise<number> {
    const cutoff = this.clock.now() - retentionDays * 86_400_000;
    const result = await this.db.run(
      `DELETE FROM workflow_runs
       WHERE finished_at IS NOT NULL AND finished_at < ? AND status IN ('succeeded', 'failed', 'cancelled')`,
      cutoff,
    );
    return result.changes;
  }
}

// ------------------------------------------------------------------
// Definition validation & ordering
// ------------------------------------------------------------------

function definitionKey(definition: WorkflowDefinition): string {
  return `${definition.name}@${definition.version}`;
}

export function validateDefinition(definition: WorkflowDefinition): void {
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(definition.name)) {
    throw new PlatformError({ code: 'WORKFLOW_DEFINITION_INVALID', message: `Invalid workflow name "${definition.name}".` });
  }
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    throw new PlatformError({ code: 'WORKFLOW_DEFINITION_INVALID', message: 'Workflow version must be a positive integer.' });
  }
  if (!Array.isArray(definition.steps) || definition.steps.length === 0) {
    throw new PlatformError({ code: 'WORKFLOW_DEFINITION_INVALID', message: 'Workflow must define at least one step.' });
  }

  const seen = new Set<string>();
  for (const step of definition.steps) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(step.id)) {
      throw new PlatformError({ code: 'WORKFLOW_DEFINITION_INVALID', message: `Invalid step id "${step.id}".` });
    }
    if (seen.has(step.id)) {
      throw new PlatformError({ code: 'WORKFLOW_DEFINITION_INVALID', message: `Duplicate step id "${step.id}".` });
    }
    seen.add(step.id);
  }

  // Cycle detection via iterative DFS over dependency edges.
  const graph = new Map<string, string[]>();
  for (const step of definition.steps) graph.set(step.id, (step.dependsOn ?? []).map((dep) => dep));
  const colors = new Map<string, 'white' | 'gray' | 'black'>();
  for (const id of graph.keys()) colors.set(id, 'white');

  for (const id of graph.keys()) {
    if (colors.get(id) !== 'white') continue;
    // Recursive DFS is fine here: DAGs in this platform are small (< 100 steps).
    const visit = (node: string, trail: Set<string>): void => {
      colors.set(node, 'gray');
      trail.add(node);
      for (const dep of graph.get(node) ?? []) {
        if (!graph.has(dep)) {
          throw new PlatformError({ code: 'WORKFLOW_DEFINITION_INVALID', message: `Step "${node}" depends on unknown step "${dep}".` });
        }
        if (trail.has(dep)) {
          throw new PlatformError({ code: 'WORKFLOW_DEFINITION_INVALID', message: `Dependency cycle detected at step "${dep}".` });
        }
        if (colors.get(dep) === 'white') visit(dep, trail);
      }
      trail.delete(node);
      colors.set(node, 'black');
    };
    visit(id, new Set());
  }
}

/** Kahn's algorithm over the dependency graph, with deterministic tie-breaking by step id. */
export function topologicalOrder(definition: WorkflowDefinition): StepDefinition[] {
  const byId = new Map(definition.steps.map((step) => [step.id, step]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const step of definition.steps) {
    const deps = step.dependsOn ?? [];
    indegree.set(step.id, deps.length);
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(step.id);
      dependents.set(dep, list);
    }
  }

  const ready = definition.steps.filter((step) => (indegree.get(step.id) ?? 0) === 0).map((s) => s.id).sort();
  const ordered: StepDefinition[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;
    const step = byId.get(id);
    if (!step) continue;
    ordered.push(step);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (ordered.length !== definition.steps.length) {
    throw new PlatformError({ code: 'WORKFLOW_DEFINITION_INVALID', message: 'The workflow graph contains a dependency cycle.' });
  }
  return ordered;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  const message = (error as { message?: string })?.message ?? '';
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT' || /UNIQUE constraint failed/i.test(message);
}

// ------------------------------------------------------------------
// Mapping helpers
// ------------------------------------------------------------------

function mapRun(row: any): RunRecord {
  return {
    id: row.id,
    definition: row.definition,
    definitionVersion: row.definition_version,
    status: row.status,
    input: safeJson(row.input_json),
    output: row.output_json == null ? null : safeJson(row.output_json),
    error: row.error_json == null ? null : safeJson(row.error_json),
    tenantId: row.tenant_id,
    projectId: row.project_id ?? undefined,
    actor: row.actor,
    parentRunId: row.parent_run_id ?? undefined,
    attempt: row.attempt,
    cancelRequested: Boolean(row.cancel_requested),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
  };
}

function mapStep(row: any): StepRecord {
  return {
    runId: row.run_id,
    stepId: row.step_id,
    status: row.status,
    attempt: row.attempt,
    output: row.output_json == null ? null : safeJson(row.output_json),
    error: row.error_json == null ? null : safeJson(row.error_json),
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function mapApproval(row: any): ApprovalRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    status: row.status,
    risk: row.risk,
    reason: row.reason,
    summary: safeJson(row.summary_json) ?? {},
    requestedAt: row.requested_at,
    decidedAt: row.decided_at ?? undefined,
    decidedBy: row.decided_by ?? undefined,
    decisionNote: row.decision_note ?? undefined,
  };
}

function buildOutputs(steps: StepRecord[]): StepOutputs {
  const outputs: StepOutputs = {};
  for (const step of steps) {
    if (step.status === 'succeeded' && step.output !== undefined) outputs[step.stepId] = step.output;
  }
  return outputs;
}

function safeJson(value: string | null | undefined): any {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
