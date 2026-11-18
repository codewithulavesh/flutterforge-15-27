import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from '../../platform/storage/database.js';
import { AuditLog } from '../../platform/audit/auditLog.js';
import { PLATFORM_MIGRATIONS } from '../../platform/storage/schema.js';
import { WorkflowEngine } from '../../platform/workflow/engine.js';
import {
  createVerifyHealWorkflow,
  type VerifyHealDeps,
  type VerifyLikeResult,
} from '../../platform/qa/verifyAndHeal.js';

const FILES = [{ path: 'lib/main.dart', content: 'void main() { runApp(const SizedBox()); }\n' }];

const passedResult: VerifyLikeResult = {
  verified: true,
  skipped: false,
  summary: 'No issues.',
  diagnostics: [],
};

const failedResult = (code = 'G1234'): VerifyLikeResult => ({
  verified: false,
  skipped: false,
  summary: '1 error.',
  diagnostics: [
    {
      filePath: 'lib/main.dart',
      line: 3,
      column: 7,
      severity: 'error',
      code,
      message: 'Type mismatch: expected int, got String.',
    },
  ],
});

const skippedResult: VerifyLikeResult = {
  verified: false,
  skipped: true,
  summary: 'Flutter SDK is not available.',
  diagnostics: [],
};

interface Harness {
  engine: WorkflowEngine;
  invoked: string[];
  verifyCalls: Array<{ fileCount: number }>;
}

async function makeWorkflow(
  scenario: { verdicts: VerifyLikeResult[]; invoke?: (params: { attempt: number }) => Promise<{ applied: boolean; summary: string }> },
  snapshotOverride?: Map<string, { content: string }>,
): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flutterforge-heal-'));
  const db = await Database.open({ file: path.join(dir, 'platform.sqlite') });
  await db.migrate(PLATFORM_MIGRATIONS);
  const audit = new AuditLog(db);

  let verifyCalls = 0;
  const verifyCallsLog: Array<{ fileCount: number }> = [];
  const invoked: string[] = [];

  const deps: VerifyHealDeps = {
    projectRoot: () => dir,
    snapshot: async () => snapshotOverride ?? new Map([['lib/main.dart', { content: '// current source v1\n' }]]),
    verify: async ({ files }) => {
      verifyCallsLog.push({ fileCount: files.length });
      const index = Math.min(verifyCalls, scenario.verdicts.length - 1);
      verifyCalls += 1;
      return scenario.verdicts[index];
    },
    invokeRepair: scenario.invoke
      ? async (params) => {
          invoked.push(`cycle-${params.attempt}`);
          return scenario.invoke!(params);
        }
      : undefined,
    audit,
  };

  const engine = new WorkflowEngine({ db, audit, defaultStepTimeoutMs: 10_000 });
  engine.register(createVerifyHealWorkflow(deps));
  return { engine, invoked, verifyCalls: verifyCallsLog };
}

const runToSettled = async (engine: WorkflowEngine, runId: string) => {
  for (let i = 0; i < 10; i += 1) {
    await engine.executeRun(runId);
    const run = await engine.getRun(runId);
    if (run && ['succeeded', 'failed', 'cancelled', 'waiting_approval'].includes(run.status)) return;
  }
};

test('a green verification skips the heal loop entirely', async () => {
  const { engine, invoked } = await makeWorkflow({ verdicts: [passedResult] });
  const { run } = await engine.start('verify.heal', { tenantId: 't', actor: 'tester', input: { projectId: 'p', files: FILES } });
  await runToSettled(engine, run.id);

  const finished = await engine.getRun(run.id);
  assert.equal(finished?.status, 'succeeded');
  assert.equal((finished?.output as any)?.verify?.verdict, 'passed');

  const steps = await engine.loadSteps(run.id);
  assert.equal(steps.find((s) => s.stepId === 'heal')?.status, 'skipped');
  assert.deepEqual(invoked, []);
});

test('a skipped verification is reported honestly, not treated as pass or fail', async () => {
  const { engine } = await makeWorkflow({ verdicts: [skippedResult] });
  const { run } = await engine.start('verify.heal', { tenantId: 't', actor: 'tester', input: { projectId: 'p', files: FILES } });
  await runToSettled(engine, run.id);

  const finished = await engine.getRun(run.id);
  assert.equal(finished?.status, 'succeeded');
  assert.equal((finished?.output as any)?.verify?.verdict, 'skipped');
});

test('dry-run by default: brief is produced, no repair invoked', async () => {
  const { engine, invoked } = await makeWorkflow({ verdicts: [failedResult()] }); // no invoke fn wired
  const { run } = await engine.start('verify.heal', {
    tenantId: 't',
    actor: 'tester',
    projectId: 'p',
    input: { projectId: 'p', files: FILES, maxCycles: 3 },
  });
  await runToSettled(engine, run.id);

  const finished = await engine.getRun(run.id);
  assert.equal(finished?.status, 'succeeded');
  assert.equal((finished?.output as any)?.heal?.verdict, 'needs_repair');
  assert.ok((finished?.output as any)?.heal?.brief.includes('lib/main.dart'));
  assert.deepEqual(invoked, []);
});

test('invoked repair turns close the loop to green and seal the change', async () => {
  const { engine, invoked, verifyCalls } = await makeWorkflow({
    verdicts: [failedResult(), passedResult],
    invoke: async () => ({ applied: true, summary: 'fixed' }),
  });
  const { run } = await engine.start('verify.heal', {
    tenantId: 't',
    actor: 'tester',
    projectId: 'p',
    input: { projectId: 'p', files: FILES, invokeRepair: true, maxCycles: 3 },
  });
  await runToSettled(engine, run.id);

  const finished = await engine.getRun(run.id);
  assert.equal(finished?.status, 'succeeded');
  assert.equal((finished?.output as any)?.heal?.verdict, 'repaired');
  assert.deepEqual(invoked, ['cycle-1']);
  // verify -> heal re-verify: at least two verification passes happened.
  assert.ok(verifyCalls.length >= 2);
});

test('unrepaired blockers exhaust the policy and fail loudly', async () => {
  const { engine } = await makeWorkflow({
    verdicts: [failedResult(), failedResult(), failedResult(), failedResult()],
    invoke: async () => ({ applied: true, summary: 'attempted' }),
  });
  const { run } = await engine.start('verify.heal', {
    tenantId: 't',
    actor: 'tester',
    projectId: 'p',
    input: { projectId: 'p', files: FILES, invokeRepair: true, maxCycles: 2 },
  });
  await runToSettled(engine, run.id);

  const finished = await engine.getRun(run.id);
  assert.equal(finished?.status, 'failed');
  assert.match(String(finished?.error?.code), /HEAL_(EXHAUSTED|OSCILLATION)/);
});

test('maxCycles=0 produces the repair brief without entering the loop', async () => {
  const { engine, invoked } = await makeWorkflow({ verdicts: [failedResult()] });
  const { run } = await engine.start('verify.heal', {
    tenantId: 't',
    actor: 'tester',
    projectId: 'p',
    input: { projectId: 'p', files: FILES, maxCycles: 0 },
  });
  await runToSettled(engine, run.id);

  const finished = await engine.getRun(run.id);
  assert.equal(finished?.status, 'succeeded');
  assert.equal((finished?.output as any)?.heal?.verdict, 'needs_repair');
  assert.equal((finished?.output as any)?.heal?.cycles, 0);
  assert.ok((finished?.output as any)?.heal?.brief.length > 0);
  assert.deepEqual(invoked, []);
});

test('a project with no files cannot be verified', async () => {
  const { engine } = await makeWorkflow({ verdicts: [passedResult] }, new Map());
  const { run } = await engine.start('verify.heal', {
    tenantId: 't',
    actor: 'tester',
    projectId: 'p',
    input: { projectId: 'p' },
  });
  await runToSettled(engine, run.id);

  const finished = await engine.getRun(run.id);
  assert.equal(finished?.status, 'failed');
  assert.equal(finished?.error?.code, 'VERIFY_NO_FILES');
});
