import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PatchTransaction,
  applyPatch,
  recoverTransactions,
  normalizePatchPath,
} from '../../platform/patch/transaction.js';
import { RevisionStore } from '../../platform/patch/revisions.js';
import { Database } from '../../platform/storage/database.js';
import { PLATFORM_MIGRATIONS } from '../../platform/storage/schema.js';
import { AuditLog } from '../../platform/audit/auditLog.js';
import { ConflictError, ValidationError } from '../../platform/kernel/errors.js';

interface Env {
  dir: string;
  workspaceRoot: string;
  transactionRoot: string;
  db: Database;
  audit: AuditLog;
}

async function makeEnv(name: string): Promise<Env> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `flutterforge-patch-${name}-`));
  const workspaceRoot = path.join(dir, 'workspace');
  const transactionRoot = path.join(dir, 'transactions');
  await fs.mkdir(workspaceRoot, { recursive: true });
  const db = await Database.open({ file: path.join(dir, 'platform.sqlite') });
  await db.migrate(PLATFORM_MIGRATIONS);
  return { dir, workspaceRoot, transactionRoot, db, audit: new AuditLog(db) };
}

test('happy path: staged patch commits atomically and records a revision', async () => {
  const env = await makeEnv('happy');
  const result = await applyPatch({
    transactionRoot: env.transactionRoot,
    workspaceRoot: env.workspaceRoot,
    actor: 'tester',
    message: 'initial feature',
    files: [
      { path: 'pubspec.yaml', content: 'name: app\ndescription: x\n' },
      { path: 'lib/main.dart', content: "void main() { runApp(const SizedBox()); }\n" },
      { path: 'assets/logo.bin', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]) },
    ],
  });

  assert.equal(result.state, 'committed');
  assert.equal(result.filesWritten, 3);
  const main = await fs.readFile(path.join(env.workspaceRoot, 'lib', 'main.dart'), 'utf8');
  assert.equal(main, "void main() { runApp(const SizedBox()); }\n");
  const bin = await fs.readFile(path.join(env.workspaceRoot, 'assets', 'logo.bin'));
  assert.deepEqual([...bin], [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

  const revisions = new RevisionStore({ db: env.db, blobRoot: path.join(env.dir, 'blobs'), audit: env.audit });
  const revision = await revisions.commitRevision({
    tenantId: 'tenant',
    projectId: 'proj-happy',
    workspaceRoot: env.workspaceRoot,
    message: 'initial feature',
    actor: 'tester',
  });
  assert.equal(revision.fileCount, 3);
  const listed = await revisions.listRevisions({ tenantId: 'tenant', projectId: 'proj-happy' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, revision.id);

  // Content-addressed blobs are shared, not duplicated.
  const blobs = await fs.readdir(path.join(env.dir, 'blobs'), { recursive: true });
  const blobFiles = blobs.filter((entry) => !String(entry).endsWith(path.sep));
  assert.ok(blobFiles.length >= 1);
  env.db.close();
});

test('validation failure rolls back: nothing touches the workspace', async () => {
  const env = await makeEnv('gate');
  await fs.writeFile(path.join(env.workspaceRoot, 'lib.dart'), 'ORIGINAL\n');

  await assert.rejects(
    applyPatch({
      transactionRoot: env.transactionRoot,
      workspaceRoot: env.workspaceRoot,
      actor: 'tester',
      message: 'bad gate',
      files: [
        { path: 'lib.dart', content: 'REPLACED\n' },
        { path: 'new.dart', content: 'IMBALANCED (((\n' },
      ],
      validate: async (entries) => {
        const bad = entries.find((entry) => entry.path === 'new.dart');
        if (bad?.content && Buffer.from(bad.content).toString('utf8').includes('(((')) {
          throw new ValidationError('gate rejected the file');
        }
      },
    }),
    /gate rejected/,
  );

  const content = await fs.readFile(path.join(env.workspaceRoot, 'lib.dart'), 'utf8');
  assert.equal(content, 'ORIGINAL\n', 'failed validation must not modify existing files');
  assert.equal(await fs.stat(path.join(env.workspaceRoot, 'new.dart')).catch(() => null), null);
  env.db.close();
});

test('crash recovery: an un-applied committing transaction rolls forward', async () => {
  const env = await makeEnv('recovery');
  const tx = await PatchTransaction.begin({
    transactionRoot: env.transactionRoot,
    workspaceRoot: env.workspaceRoot,
    actor: 'tester',
    message: 'crashed mid-commit',
  });
  tx.stagePut('lib/crashed.dart', '// recovered\n');
  await tx.prepare();

  // Simulate a crash after the commit decision was recorded but before any
  // file application happened.
  const journalPath = path.join(env.transactionRoot, tx.id, 'journal.json');
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  journal.state = 'committing';
  await fs.writeFile(journalPath, JSON.stringify(journal, null, 2));

  const recovery = await recoverTransactions(env.transactionRoot);
  assert.deepEqual(recovery.recovered, [tx.id]);

  const content = await fs.readFile(path.join(env.workspaceRoot, 'lib', 'crashed.dart'), 'utf8');
  assert.equal(content, '// recovered\n');
  env.db.close();
});

test('crash recovery: a prepared-but-uncommitted transaction rolls back', async () => {
  const env = await makeEnv('recovery2');
  await fs.writeFile(path.join(env.workspaceRoot, 'original.dart'), 'KEEP\n');

  const tx = await PatchTransaction.begin({
    transactionRoot: env.transactionRoot,
    workspaceRoot: env.workspaceRoot,
    actor: 'tester',
    message: 'crashed before commit',
  });
  tx.stagePut('original.dart', 'OVERWRITTEN\n');
  await tx.prepare();

  const recovery = await recoverTransactions(env.transactionRoot);
  assert.deepEqual(recovery.rolledBack, [tx.id]);
  const content = await fs.readFile(path.join(env.workspaceRoot, 'original.dart'), 'utf8');
  assert.equal(content, 'KEEP\n');
  env.db.close();
});

test('existing file modification is recorded as modified with before hash', async () => {
  const env = await makeEnv('modify');
  await fs.writeFile(path.join(env.workspaceRoot, 'pubspec.yaml'), 'name: before\n');
  const result = await applyPatch({
    transactionRoot: env.transactionRoot,
    workspaceRoot: env.workspaceRoot,
    actor: 'tester',
    message: 'bump',
    files: [{ path: 'pubspec.yaml', content: 'name: after\n' }],
  });
  const change = result.changes.find((c) => c.path === 'pubspec.yaml');
  assert.equal(change?.action, 'modified');
  assert.ok(change?.beforeHash);
  assert.ok(change?.afterHash);
  assert.notEqual(change?.beforeHash, change?.afterHash);
  env.db.close();
});

test('path traversal and protected segments are rejected', async () => {
  const env = await makeEnv('safety');
  assert.throws(() => normalizePatchPath('../escape.dart'), ValidationError);
  assert.throws(() => normalizePatchPath('/etc/passwd'), ValidationError);
  assert.throws(() => normalizePatchPath('.git/config'), ValidationError);
  assert.throws(() => normalizePatchPath('a/.flutterforge/session.json'), ValidationError);
  assert.throws(() => normalizePatchPath('a/../../b.dart'), ValidationError);
  env.db.close();
});

test('a second concurrent transaction for the same workspace is refused', async () => {
  const env = await makeEnv('mutex');
  const first = await PatchTransaction.begin({
    transactionRoot: env.transactionRoot,
    workspaceRoot: env.workspaceRoot,
    actor: 'tester',
    message: 'holder',
  });
  await assert.rejects(
    PatchTransaction.begin({
      transactionRoot: env.transactionRoot,
      workspaceRoot: env.workspaceRoot,
      actor: 'other',
      message: 'contender',
    }),
    (error: unknown) => error instanceof ConflictError && error.code === 'WORKSPACE_LOCKED',
  );
  await first.abort('done');
  const second = await PatchTransaction.begin({
    transactionRoot: env.transactionRoot,
    workspaceRoot: env.workspaceRoot,
    actor: 'tester',
    message: 'after holder finished',
  });
  await second.abort('done');
  env.db.close();
});

test('binary content is staged and committed byte-for-byte', async () => {
  const env = await makeEnv('binary');
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
  const result = await applyPatch({
    transactionRoot: env.transactionRoot,
    workspaceRoot: env.workspaceRoot,
    actor: 'tester',
    message: 'binary',
    files: [{ path: 'assets/blob.bin', content: bytes }],
  });
  assert.equal(result.filesWritten, 1);
  const written = await fs.readFile(path.join(env.workspaceRoot, 'assets', 'blob.bin'));
  assert.equal(written.compare(bytes), 0);
  env.db.close();
});

test('revision restore reconstructs a past state inside one transaction', async () => {
  const env = await makeEnv('restore');
  const revisions = new RevisionStore({ db: env.db, blobRoot: path.join(env.dir, 'blobs'), audit: env.audit });

  await applyPatch({
    transactionRoot: env.transactionRoot,
    workspaceRoot: env.workspaceRoot,
    actor: 'tester',
    message: 'v1',
    files: [
      { path: 'lib/a.dart', content: '// a v1\n' },
      { path: 'lib/b.dart', content: '// b v1\n' },
    ],
  });
  const rev1 = await revisions.commitRevision({
    tenantId: 'tenant', projectId: 'proj-restore', workspaceRoot: env.workspaceRoot, message: 'v1', actor: 'tester',
  });

  await applyPatch({
    transactionRoot: env.transactionRoot,
    workspaceRoot: env.workspaceRoot,
    actor: 'tester',
    message: 'v2 changes',
    files: [
      { path: 'lib/a.dart', content: '// a v2\n' },
      { path: 'lib/c.dart', content: '// c v2\n' },
      { path: 'lib/b.dart', content: null },
    ],
  });

  await revisions.restoreRevision({
    revisionId: rev1.id,
    tenantId: 'tenant',
    actor: 'tester',
    workspaceRoot: env.workspaceRoot,
    transactionRoot: env.transactionRoot,
  });

  assert.equal(await fs.readFile(path.join(env.workspaceRoot, 'lib', 'a.dart'), 'utf8'), '// a v1\n');
  assert.equal(await fs.readFile(path.join(env.workspaceRoot, 'lib', 'b.dart'), 'utf8'), '// b v1\n');
  assert.equal(await fs.stat(path.join(env.workspaceRoot, 'lib', 'c.dart')).catch(() => null), null);
  env.db.close();
});
