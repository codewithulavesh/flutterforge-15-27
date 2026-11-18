/**
 * `app.forge` workflow tests. The real emitter/scorer chain is exercised
 * end-to-end with a stubbed analyzer, so these tests are fast and deterministic
 * and still prove the durable DAG end to end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from '../../platform/storage/database.js';
import { AuditLog } from '../../platform/audit/auditLog.js';
import { PLATFORM_MIGRATIONS } from '../../platform/storage/schema.js';
import { WorkflowEngine, type WorkflowDefinition } from '../../platform/workflow/engine.js';
import { createAppForgeWorkflow, type AppForgeDeps } from '../../platform/generation/forgeWorkflow.js';
import { compileSpec } from '../../platform/generation/spec/index.js';
import type { AppSpec } from '../../platform/generation/contracts.js';
import type { GateResult } from '../../platform/generation/contracts.js';

async function makeEngine(name: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `flutterforge-forge-${name}-`));
  const workspaces = path.join(dir, 'workspaces');
  await fs.mkdir(workspaces, { recursive: true });
  process.env.FLUTTERFORGE_WORKSPACES = workspaces;
  const db = await Database.open({ file: path.join(dir, 'platform.sqlite') });
  await db.migrate(PLATFORM_MIGRATIONS);
  const audit = new AuditLog(db);
  const engine = new WorkflowEngine({
    db,
    audit,
    leaseTtlMs: 10_000,
    defaultStepTimeoutMs: 60_000,
    maxConcurrentRuns: 2,
  });
  return { engine, dir, workspaces, transactionRoot: path.join(dir, 'transactions') };
}

const passGate: GateResult = { gate: 'analyze', passed: true, blockers: [], detail: 'stubbed analyzer' };

const failGate: GateResult = {
  gate: 'analyze',
  passed: false,
  blockers: ['lib/features/notes/notes_page.dart:12 — The argument type \'String\' can\'t be assigned to the parameter type \'int\''],
};

async function startRun(engine: WorkflowEngine, projectId: string, input: Record<string, unknown>) {
  const { run } = await engine.start('app.forge', {
    tenantId: 'tenant',
    projectId,
    actor: 'tester',
    input: { projectId, prompt: 'Build a notes app with tags, search and pinning', ...input },
    idempotencyKey: `${projectId}-${JSON.stringify(input)}`,
  });
  return run;
}

async function runToIdle(engine: WorkflowEngine, runId: string) {
  for (let index = 0; index < 20; index += 1) {
    await engine.executeRun(runId);
    const run = await engine.getRun(runId);
    if (run && ['succeeded', 'failed', 'cancelled', 'waiting_approval'].includes(run.status)) return run;
  }
  throw new Error('run did not settle');
}

function forgeWorkflow(deps: Partial<AppForgeDeps> & Pick<AppForgeDeps, 'dataDir' | 'transactionRoot'>): WorkflowDefinition {
  return createAppForgeWorkflow({ ...deps, analyze: async () => passGate });
}

test('happy path: spec → emit → score → verify → seal', async () => {
  const { engine, dir, workspaces } = await makeEngine('happy');
  engine.register(forgeWorkflow({ dataDir: dir, transactionRoot: path.join(dir, 'transactions') }));

  const run = await startRun(engine, 'forge-happy-1', {});
  const finished = await runToIdle(engine, run.id);
  assert.equal(finished.status, 'succeeded');

  const output = finished.output as {
    plan: { spec: AppSpec; enriched: boolean; notes: string[] };
    emit: { fileCount: number; bytes: number };
    score: { report: { total: number; grade: string } };
    verify: { gate: GateResult };
    seal: { transactionId: string; workspace: string; filesWritten: number };
  };
  assert.equal(output.plan.spec.app.name.length > 0, true);
  assert.ok(output.plan.spec.screens.length >= 3);
  assert.ok(output.emit.fileCount >= 20);
  assert.ok(output.emit.bytes > 10_000);
  assert.ok(output.score.report.total >= 0 && output.score.report.total <= 100);
  assert.equal(output.verify.gate.passed, true);
  assert.ok(output.seal.transactionId);

  // Sealed files really landed in the workspace, not just in memory.
  const sealed = path.join(workspaces, 'forge-happy-1');
  const main = await fs.readFile(path.join(sealed, 'lib/main.dart'), 'utf8');
  assert.ok(main.includes('runApp('));
  const pubspec = await fs.readFile(path.join(sealed, 'pubspec.yaml'), 'utf8');
  assert.ok(pubspec.includes('name:'));
});

test('refuses to overwrite a non-empty workspace unless force is set', async () => {
  const { engine, dir, workspaces } = await makeEngine('nonempty');
  engine.register(forgeWorkflow({ dataDir: dir, transactionRoot: path.join(dir, 'transactions') }));

  const sealed = path.join(workspaces, 'forge-existing-1');
  await fs.mkdir(sealed, { recursive: true });
  await fs.writeFile(path.join(sealed, 'README.md'), '# existing project\n', 'utf8');

  const run = await startRun(engine, 'forge-existing-1', {});
  const finished = await runToIdle(engine, run.id);
  assert.equal(finished.status, 'failed');
  assert.match(JSON.stringify(finished.error), /not empty/i);

  const forced = await startRun(engine, 'forge-existing-1', { force: true });
  const forcedFinished = await runToIdle(engine, forced.id);
  assert.equal(forcedFinished.status, 'succeeded');
});

test('an invalid compiled spec fails with GENERATION_SPEC_INVALID', async () => {
  const { engine, dir } = await makeEngine('badspec');
  engine.register(
    createAppForgeWorkflow({
      dataDir: dir,
      transactionRoot: path.join(dir, 'transactions'),
      compile: () => ({ ...compileSpec({ prompt: 'notes' }), screens: [], entities: [] }),
      analyze: async () => passGate,
    }),
  );

  const run = await startRun(engine, 'forge-badspec-1', {});
  const finished = await runToIdle(engine, run.id);
  assert.equal(finished.status, 'failed');
  assert.match(JSON.stringify(finished.error), /GENERATION_SPEC_INVALID/);
});

test('emitter structural problems fail with GENERATION_STRUCTURE_FAILED', async () => {
  const { engine, dir } = await makeEngine('structure');
  engine.register(
    createAppForgeWorkflow({
      dataDir: dir,
      transactionRoot: path.join(dir, 'transactions'),
      emit: () => ({ files: [], problems: ['missing required file: pubspec.yaml'] }),
      analyze: async () => passGate,
    }),
  );

  const run = await startRun(engine, 'forge-structure-1', {});
  const finished = await runToIdle(engine, run.id);
  assert.equal(finished.status, 'failed');
  assert.match(JSON.stringify(finished.error), /GENERATION_STRUCTURE_FAILED/);
});

test('quality below the threshold fails with GENERATION_QUALITY_BELOW_THRESHOLD', async () => {
  const { engine, dir } = await makeEngine('quality');
  engine.register(
    createAppForgeWorkflow({
      dataDir: dir,
      transactionRoot: path.join(dir, 'transactions'),
      score: () => ({
        total: 40,
        grade: 'F',
        categories: {
          architecture: 40,
          completeness: 40,
          design: 40,
          accessibility: 40,
          reliability: 40,
          testability: 40,
          performance: 40,
        },
        findings: [
          { category: 'completeness', severity: 'error', code: 'MISSING_SCREEN', message: 'screen missing' },
        ],
        stats: { files: 1, bytes: 10, lines: 5, screens: 1, entities: 1, tests: 0 },
        generatedAt: Date.now(),
      }),
      analyze: async () => passGate,
    }),
  );

  const run = await startRun(engine, 'forge-quality-1', { minQuality: 80 });
  const finished = await runToIdle(engine, run.id);
  assert.equal(finished.status, 'failed');
  assert.match(JSON.stringify(finished.error), /GENERATION_QUALITY_BELOW_THRESHOLD/);
});

test('a failing analyzer gate fails with GENERATION_VERIFY_FAILED', async () => {
  const { engine, dir } = await makeEngine('verify');
  engine.register(
    createAppForgeWorkflow({
      dataDir: dir,
      transactionRoot: path.join(dir, 'transactions'),
      analyze: async () => failGate,
    }),
  );

  const run = await startRun(engine, 'forge-verify-1', {});
  const finished = await runToIdle(engine, run.id);
  assert.equal(finished.status, 'failed');
  assert.match(JSON.stringify(finished.error), /GENERATION_VERIFY_FAILED/);
});

test('enrichment failures are failure-safe: the deterministic spec still seals', async () => {
  const { engine, dir } = await makeEngine('enrich');
  engine.register(
    createAppForgeWorkflow({
      dataDir: dir,
      transactionRoot: path.join(dir, 'transactions'),
      enrich: async () => {
        throw new Error('provider unreachable');
      },
      analyze: async () => passGate,
    }),
  );

  const run = await startRun(engine, 'forge-enrich-1', {});
  const finished = await runToIdle(engine, run.id);
  assert.equal(finished.status, 'succeeded');
  const output = finished.output as { plan: { enriched: boolean; notes: string[] } };
  assert.equal(output.plan.enriched, false);
  assert.ok(output.plan.notes.some((note) => note.includes('provider unreachable')));
});

test('deterministic re-emission: the sealed file set is byte-identical across runs', async () => {
  const { engine, dir, workspaces } = await makeEngine('determinism');
  engine.register(forgeWorkflow({ dataDir: dir, transactionRoot: path.join(dir, 'transactions') }));

  for (const projectId of ['forge-determinism-1', 'forge-determinism-2']) {
    const run = await startRun(engine, projectId, {});
    const finished = await runToIdle(engine, run.id);
    assert.equal(finished.status, 'succeeded');
  }
  const first = path.join(workspaces, 'forge-determinism-1');
  const second = path.join(workspaces, 'forge-determinism-2');
  const firstMain = await fs.readFile(path.join(first, 'lib/main.dart'), 'utf8');
  const secondMain = await fs.readFile(path.join(second, 'lib/main.dart'), 'utf8');
  assert.equal(firstMain, secondMain);
  const firstNotes = await fs.readFile(path.join(first, 'lib/data/models/note.dart'), 'utf8');
  const secondNotes = await fs.readFile(path.join(second, 'lib/data/models/note.dart'), 'utf8');
  assert.equal(firstNotes, secondNotes);
});

test('missing prompt fails validation before any work is done', async () => {
  const { engine, dir } = await makeEngine('validation');
  engine.register(forgeWorkflow({ dataDir: dir, transactionRoot: path.join(dir, 'transactions') }));

  const { run } = await engine.start('app.forge', {
    tenantId: 'tenant',
    actor: 'tester',
    input: { projectId: 'forge-validation-1', prompt: '   ' },
  });
  const finished = await runToIdle(engine, run.id);
  assert.equal(finished.status, 'failed');
  assert.match(JSON.stringify(finished.error), /prompt is required/i);
});
