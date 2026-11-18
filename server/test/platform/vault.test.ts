import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVault } from '../../platform/security/vault.js';

process.env.FLUTTERFORGE_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-vault-'));

const master = 'a'.repeat(64);

test('set/get roundtrips plaintext across reopens', async () => {
  const file = path.join(process.env.FLUTTERFORGE_DATA_DIR!, 'v1.json');
  const v1 = await createVault({ file, masterKey: master });
  await v1.set('openrouter', 'sk-fake-key-1234');
  const v2 = await createVault({ file, masterKey: master });
  assert.equal(await v2.get('openrouter'), 'sk-fake-key-1234');
});

test('file is rotated: AES-256-GCM sealed, readable by owner only', async () => {
  const file = path.join(process.env.FLUTTERFORGE_DATA_DIR!, 'v2.json');
  const v = await createVault({ file, masterKey: master });
  await v.set('openai', 'sk-valid-key-5678');
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o077, 0, 'vault file must not be group/world readable');
  // The vault file must not contain plaintext.
  const raw = await fs.readFile(file, 'utf8');
  assert.equal(raw.includes('sk-valid-key-5678'), false);
  assert.equal(raw.includes('ciphertext'), true);
});

test('wrong master key detects tampering via GCM tag', async () => {
  const file = path.join(process.env.FLUTTERFORGE_DATA_DIR!, 'v3.json');
  const v = await createVault({ file, masterKey: master });
  await v.set('deepseek', 'sk-deepseek-7777');
  const attacker = await createVault({ file, masterKey: 'b'.repeat(64) });
  await assert.rejects(() => attacker.get('deepseek'), /integrity|VAULT|corrupt/i);
});

test('list returns names only — never values', async () => {
  const file = path.join(process.env.FLUTTERFORGE_DATA_DIR!, 'v4.json');
  const v = await createVault({ file, masterKey: master });
  await v.set('alpha', 'secret-alpha');
  await v.set('beta', 'secret-beta');
  const names = await v.list();
  assert.deepEqual(names, ['alpha', 'beta']);
  assert.equal(JSON.stringify(names).includes('secret'), false);
});

test('delete returns true only when a secret existed', async () => {
  const file = path.join(process.env.FLUTTERFORGE_DATA_DIR!, 'v5.json');
  const v = await createVault({ file, masterKey: master });
  await v.set('gone', 'token-1');
  assert.equal(await v.delete('gone'), true);
  assert.equal(await v.delete('gone'), false);
});

test('rotate re-encrypts keys under a new master secret', async () => {
  const file = path.join(process.env.FLUTTERFORGE_DATA_DIR!, 'v6.json');
  const v = await createVault({ file, masterKey: master });
  await v.set('legacy', 'opaque-blob-99');
  const before = await v.get('legacy');
  assert.equal(before, 'opaque-blob-99');
  await v.rotate('c'.repeat(64));
  const after = await createVault({ file, masterKey: 'c'.repeat(64) });
  assert.equal(await after.get('legacy'), 'opaque-blob-99');
});

test('weak master key is rejected with a typed error', async () => {
  await assert.rejects(() => createVault({ file: path.join(process.env.FLUTTERFORGE_DATA_DIR!, 'v7.json'), masterKey: 'short' }), /master key/i);
});

test('createVaultFromEnv returns null when no master key configured', async () => {
  const { createVaultFromEnv } = await import('../../platform/security/vault.js');
  const vault = await createVaultFromEnv({} as NodeJS.ProcessEnv);
  assert.equal(vault, null);
});

test('createVaultFromEnv builds a vault from FLUTTERFORGE_VAULT_KEY', async () => {
  const { createVaultFromEnv } = await import('../../platform/security/vault.js');
  const vault = await createVaultFromEnv({ FLUTTERFORGE_VAULT_KEY: master } as unknown as NodeJS.ProcessEnv, process.env.FLUTTERFORGE_DATA_DIR);
  assert.ok(vault);
});
