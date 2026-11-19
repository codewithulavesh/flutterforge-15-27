import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listProjectConnectorContext, listProjectConnectors, updateProjectConnector } from '../../platform/connectors/projectConnectors.js';
import { Database } from '../../platform/storage/database.js';
import { PLATFORM_MIGRATIONS } from '../../platform/storage/schema.js';

test('connector snapshots stay project scoped and stale refreshes cannot resurrect a disconnected resource', async t => {
  const db = await Database.open({ file: ':memory:' });
  t.after(() => db.close());
  await db.migrate(PLATFORM_MIGRATIONS);
  const scope = { tenantId: 'tenant-a', projectId: 'counter' };
  const repository = { full_name: 'flutter/flutter', private: false, archived: false, default_branch: 'master', language: 'Dart', license: { spdx_id: 'BSD-3-Clause' }, description: 'Untrusted prose' };
  const request: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/flutter/flutter');
    assert.equal(options?.redirect, 'error');
    return Response.json(repository);
  };
  const sync = { action: 'sync', kind: 'github', resource: 'flutter/flutter', expectedRevision: null } as const;
  const [row] = await updateProjectConnector(db, scope, sync, request);
  assert.equal(row.metadata.Language, 'Dart');
  assert.doesNotMatch(JSON.stringify(await listProjectConnectorContext(db, scope)), /Untrusted/);
  assert.deepEqual(await listProjectConnectorContext(db, { ...scope, tenantId: 'tenant-b' }), []);
  assert.deepEqual(await listProjectConnectors(db, { ...scope, projectId: 'other' }), []);
  await assert.rejects(updateProjectConnector(db, scope, { ...sync, expectedRevision: row.revision }, async () => new Response(null, { status: 429 })), /429/);
  assert.equal((await listProjectConnectors(db, scope))[0].revision, row.revision);
  await updateProjectConnector(db, scope, { kind: 'github', action: 'disconnect', expectedRevision: row.revision });
  await assert.rejects(updateProjectConnector(db, scope, { ...sync, expectedRevision: row.revision }, request), /another session/);
  assert.deepEqual(await listProjectConnectorContext(db, scope), []);
});

test('pub.dev records only the current version and SDK, and rejects malformed resource names before fetching', async t => {
  const db = await Database.open({ file: ':memory:' });
  t.after(() => db.close());
  await db.migrate(PLATFORM_MIGRATIONS);
  const scope = { tenantId: 't', projectId: 'p' };
  const input = { kind: 'pubdev', action: 'sync', expectedRevision: null, resource: 'go_router' } as const;
  const [row] = await updateProjectConnector(db, scope, input, async url => {
    assert.equal(url, 'https://pub.dev/api/packages/go_router');
    return Response.json({ name: 'go_router', latest: { version: '12.0.0', pubspec: { environment: { sdk: '>=3.0.0 <4.0.0' } } } });
  });
  assert.equal(row.metadata.Version, '12.0.0');
  assert.equal(row.metadata['Dart SDK'], '>=3.0.0 <4.0.0');
  await assert.rejects(updateProjectConnector(db, scope, { ...input, resource: '../invalid' }, () => assert.fail('unexpected fetch')), /package name/);
});
