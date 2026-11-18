import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from '../../platform/storage/database.js';
import { AuditLog, GENESIS_HASH } from '../../platform/audit/auditLog.js';
import { PLATFORM_MIGRATIONS } from '../../platform/storage/schema.js';

async function tempDb(): Promise<{ db: Database; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flutterforge-audit-'));
  const db = await Database.open({ file: path.join(dir, 'test.sqlite') });
  await db.migrate(PLATFORM_MIGRATIONS);
  return {
    db,
    cleanup: async () => {
      db.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('audit chain is append-only and verifies', async () => {
  const { db, cleanup } = await tempDb();
  try {
    const audit = new AuditLog(db);
    const first = await audit.append({ tenantId: 't1', actor: 'a', action: 'workflow.start', resourceType: 'workflow_run', resourceId: 'run_1', metadata: { n: 1 } });
    assert.equal(first.prevHash, GENESIS_HASH);

    const second = await audit.append({ tenantId: 't1', actor: 'a', action: 'patch.apply', resourceType: 'project_revision', resourceId: 'rev_1', metadata: { n: 2 } });
    assert.equal(second.prevHash, first.hash);

    const third = await audit.append({ tenantId: 't2', actor: 'root', action: 'org.manage', resourceType: 'org', metadata: {} });
    assert.equal(third.prevHash, second.hash);

    const verified = await audit.verify();
    assert.equal(verified.ok, true);
    assert.equal(verified.checked, 3);
    assert.equal(verified.headHash, third.hash);

    const entries = await audit.list({ tenantId: 't1' });
    assert.equal(entries.length, 2);
    assert.equal(entries[0].action, 'workflow.start');
  } finally {
    await cleanup();
  }
});

test('tampering with any entry breaks verification deterministically', async () => {
  const { db, cleanup } = await tempDb();
  try {
    const audit = new AuditLog(db);
    await audit.append({ tenantId: 't', actor: 'a', action: 'one', resourceType: 'r', metadata: {} });
    await audit.append({ tenantId: 't', actor: 'a', action: 'two', resourceType: 'r', metadata: {} });
    await audit.append({ tenantId: 't', actor: 'a', action: 'three', resourceType: 'r', metadata: {} });

    // Simulate an attacker with direct SQL access editing row 2's metadata.
    await db.run(`UPDATE audit_log SET metadata_json = ? WHERE seq = 2`, '{"forged":true}');

    const verified = await audit.verify();
    assert.equal(verified.ok, false);
    assert.equal(verified.firstBadSeq, 2);
    assert.match(String(verified.reason), /hash|contents/i);
  } finally {
    await cleanup();
  }
});

test('deleting a middle entry breaks chain linkage', async () => {
  const { db, cleanup } = await tempDb();
  try {
    const audit = new AuditLog(db);
    await audit.append({ tenantId: 't', actor: 'a', action: 'one', resourceType: 'r', metadata: {} });
    await audit.append({ tenantId: 't', actor: 'a', action: 'two', resourceType: 'r', metadata: {} });
    await audit.append({ tenantId: 't', actor: 'a', action: 'three', resourceType: 'r', metadata: {} });
    await db.run('DELETE FROM audit_log WHERE seq = 2');
    const verified = await audit.verify();
    assert.equal(verified.ok, false);
    assert.equal(verified.firstBadSeq, 3);
  } finally {
    await cleanup();
  }
});
