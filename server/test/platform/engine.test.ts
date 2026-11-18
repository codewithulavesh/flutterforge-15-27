import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from '../../platform/storage/database.js';
import { AuditLog } from '../../platform/audit/auditLog.js';
import { PLATFORM_MIGRATIONS } from '../../platform/storage/schema.js';
import {
  WorkflowEngine,
  topologicalOrder,
  validateDefinition,
  type WorkflowDefinition,
} from '../../platform/workflow/engine.js';

async function makeEngine(name: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `flutterforge-engine-${name}-`));
  const db = await Database.open({ file: path.join(dir, 'platform.sqlite') });
  await db.migrate(PLATFORM_MIGRATIONS);
  const audit = new AuditLog(db);
  const engine = new WorkflowEngine({
    db,
    audit,
    leaseTtlMs: 10_000,
    defaultStepTimeoutMs: 2_000,
    maxConcurrentRuns: 4,
  });
  return { engine, db, audit, dir };
}

const runToIdle = async (engine: WorkflowEngine, runId: string) => {
  // Drive the engine to a settled state; executeRun is synchronous from the
  // caller's perspective but claims asynchronously, so loop tick + execute.
  for (let i = 0; i < 20; i += 1) {
    await engine.executeRun(runId);
    const run = await engine.getRun(runId);
    if (run && ['succeeded', 'failed', 'cancelled', 'waiting_approval'].includes(run.status)) return;
  }
};

test('DAG order respects dependencies and is deterministic', () => {
  const definition: WorkflowDefinition = {
    name: 'order.test',
    version: 1,
    steps: [
      { id: 'c', dependsOn: ['b'], run: async () => 'c' },
      { id: 'a', run: async () => 'a' },
      { id: 'b', dependsOn: ['a'], run: async () => 'b' },
    ],
  };
  const order = topologicalOrder(definition).map((step) => step.id);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('a cyclic graph is rejected at registration', () => {
  const definition: WorkflowDefinition = {
    name: 'cycle.test',
    version: 1,
    steps: [
      { id: 'a', dependsOn: ['b'], run: async () => 'a' },
      { id: 'b', dependsOn: ['a'], run: async () => 'b' },
    ],
  };
  assert.throws(() => validateDefinition(definition), /[Cc]ycle/);
});

test('a dependency on an unknown step is rejected', () => {
  const definition: WorkflowDefinition = {
    name: 'missing.dep',
    version: 1,
    steps: [{ id: 'a', dependsOn: ['nope'], run: async () => 'a' }],
  };
  assert.throws(() => validateDefinition(definition), /unknown/);
});

test('a simple two-step DAG executes and persists outputs', async () => {
  const { engine, db } = await makeEngine('simple');
  engine.register({
    name: 'flow.simple',
    version: 1,
    steps: [
      { id: 'first', run: async () => ({ value: 21 }) },
      { id: 'second', dependsOn: ['first'], run: async (ctx) => ({ doubled: (ctx.outputs.first as any).value * 2 }) },
    ],
  });

  const { run } = await engine.start('flow.simple', { tenantId: 'tenant', actor: 'tester', input: {} });
  await runToIdle(engine, run.id);

  const finished = await engine.getRun(run.id);
  assert.equal(finished?.status, 'succeeded');
  assert.equal((finished?.output as any)?.second?.doubled, 42);

  const events = await engine.eventsAfter(run.id);
  assert.ok(events.some((event) => event.type === 'run.created'));
  assert.ok(events.some((event) => event.type === 'step.succeeded'));
  assert.equal(events.at(-1)?.type, 'run.succeeded');
  db.close();
});

test('a transient failure is retried with backoff and succeeds', async () => {
  const { engine, db } = await makeEngine('retry');
  let attempts = 0;
  engine.register({
    name: 'flow.retry',
    version: 1,
    steps: [
      {
        id: 'flaky',
        run: async () => {
          attempts += 1;
          if (attempts < 3) {
            const error = new Error('connection reset') as NodeJS.ErrnoException;
            error.code = 'ECONNRESET';
            throw error;
          }
          return { attempts };
        },
      },
    ],
  });

  const { run } = await engine.start('flow.retry', { tenantId: 'tenant', actor: 'tester' });
  await runToIdle(engine, run.id);

  const finished = await engine.getRun(run.id);
  assert.equal(finished?.status, 'succeeded');
  assert.equal((finished?.output as any)?.flaky?.attempts, 3);

  const steps = await engine.loadSteps(run.id);
  assert.equal(steps[0]?.attempt, 3);
  db.close();
});

test('a permanently failing step triggers saga compensation in reverse order', async () => {
  const { engine, db } = await makeEngine('saga');
  const calls: string[] = [];
  engine.register({
    name: 'flow.saga',
    version: 1,
    steps: [
      { id: 'a', run: async () => 'a-ok', compensate: async () => { calls.push('undo-a'); } },
      { id: 'b', dependsOn: ['a'], run: async () => 'b-ok', compensate: async () => { calls.push('undo-b'); } },
      {
        id: 'c',
        dependsOn: ['b'],
        retry: { maxAttempts: 1 },
        run: async () => { throw Object.assign(new Error('permanent'), { code: 'X' }); },
      },
    ],
  });

  const { run } = await engine.start('flow.saga', { tenantId: 'tenant', actor: 'tester' });
  await runToIdle(engine, run.id);

  const finished = await engine.getRun(run.id);
  assert.equal(finished?.status, 'failed');
  assert.deepEqual(calls, ['undo-b', 'undo-a'], 'compensation must run in reverse dependency order');
  db.close();
});

test('a gated step parks the run, and approval resumes it to completion', async () => {
  const { engine, db, audit } = await makeEngine('approval');
  engine.register({
    name: 'flow.gate',
    version: 1,
    steps: [
      {
        id: 'deploy',
        run: async (ctx) => {
          await ctx.requestApproval({ risk: 'high', reason: 'Deploys to production', summary: { target: 'prod' } });
          return { deployed: true };
        },
      },
    ],
  });

  const { run } = await engine.start('flow.gate', { tenantId: 'tenant', actor: 'tester', projectId: 'proj' });
  await runToIdle(engine, run.id);

  const parked = await engine.getRun(run.id);
  assert.equal(parked?.status, 'waiting_approval');

  const pending = await engine.listPendingApprovals({ tenantId: 'tenant' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].risk, 'high');

  await engine.decideApproval(pending[0].id, 'approved', 'release-manager', 'lgtm');
  await runToIdle(engine, run.id);

  const finished = await engine.getRun(run.id);
  assert.equal(finished?.status, 'succeeded');
  assert.equal((finished?.output as any)?.deploy?.deployed, true);

  // The approval was audited.
  const auditEntries = await audit.list({ tenantId: 'tenant' });
  assert.ok(auditEntries.some((entry) => entry.action === 'workflow.approval_requested'));
  assert.ok(auditEntries.some((entry) => entry.action === 'workflow.approval_granted'));
  db.close();
});

test('a rejection fails the run with APPROVAL_REJECTED', async () => {
  const { engine, db } = await makeEngine('reject');
  engine.register({
    name: 'flow.reject',
    version: 1,
    steps: [
      {
        id: 'deploy',
        retry: { maxAttempts: 1 },
        run: async (ctx) => {
          await ctx.requestApproval({ risk: 'critical', reason: 'Destructive migration', summary: {} });
          return 'never';
        },
      },
    ],
  });

  const { run } = await engine.start('flow.reject', { tenantId: 'tenant', actor: 'tester' });
  await runToIdle(engine, run.id);
  const pending = await engine.listPendingApprovals({ tenantId: 'tenant' });
  await engine.decideApproval(pending[0].id, 'rejected', 'security-team', 'blocked');

  const finished = await engine.getRun(run.id);
  assert.equal(finished?.status, 'failed');
  assert.equal(finished?.error?.code, 'APPROVAL_REJECTED');
  db.close();
});

test('idempotency keys return the same run instead of duplicating', async () => {
  const { engine, db } = await makeEngine('idem');
  engine.register({ name: 'flow.idem', version: 1, steps: [{ id: 'one', run: async () => 'done' }] });

  const first = await engine.start('flow.idem', { tenantId: 't', actor: 'a', idempotencyKey: 'key-1' });
  const second = await engine.start('flow.idem', { tenantId: 't', actor: 'a', idempotencyKey: 'key-1' });
  assert.equal(first.run.id, second.run.id);
  assert.equal(second.created, false);
  db.close();
});

test('cancelling a waiting-for-approval run marks it cancelled', async () => {
  const { engine, db } = await makeEngine('cancel');
  engine.register({
    name: 'flow.cancel',
    version: 1,
    steps: [
      {
        id: 'gate',
        run: async (ctx) => {
          await ctx.requestApproval({ risk: 'medium', reason: 'review', summary: {} });
          return 'done';
        },
      },
    ],
  });

  const { run } = await engine.start('flow.cancel', { tenantId: 'tenant', actor: 'tester' });
  await runToIdle(engine, run.id);
  assert.equal((await engine.getRun(run.id))?.status, 'waiting_approval');

  await engine.cancel(run.id, 'tester', 'no longer needed');
  assert.equal((await engine.getRun(run.id))?.status, 'cancelled');
  db.close();
});

test('a step that exceeds its timeout fails instead of hanging forever', async () => {
  const { engine, db } = await makeEngine('timeout');
  engine.register({
    name: 'flow.timeout',
    version: 1,
    steps: [
      {
        id: 'hangs',
        timeoutMs: 50,
        retry: { maxAttempts: 1 },
        run: () => new Promise<string>(() => {}), // never settles
      },
    ],
  });

  const { run } = await engine.start('flow.timeout', { tenantId: 'tenant', actor: 'tester' });
  await runToIdle(engine, run.id);
  assert.equal((await engine.getRun(run.id))?.status, 'failed');
  db.close();
});
