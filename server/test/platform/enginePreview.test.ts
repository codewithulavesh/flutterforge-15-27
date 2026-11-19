import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EngineerPreview } from '../../platform/engine/preview.js';

test('preview serves actual build files on a separate origin and rejects escaped files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ff-preview-test-'));
  const preview = new EngineerPreview('p', root);
  try {
    await assert.rejects(preview.publish(), /ENOENT/);
    const web = path.join(root, 'build/web'); await mkdir(web, { recursive: true });
    await writeFile(path.join(web, 'index.html'), '<html><head><base href="/"></head><body>Preview fixture</body></html>');
    await writeFile(path.join(web, 'main.js'), 'console.log("actual asset")');
    await writeFile(path.join(root, 'private.txt'), 'private'); await symlink(path.join(root, 'private.txt'), path.join(web, 'leak.txt'));
    const started = await preview.publish(); assert.equal(started.status, 'running');
    const html = await fetch(started.url!).then(r => r.text()); assert.match(html, /Preview fixture/); assert.ok(html.includes(new URL(started.url!).pathname));
    assert.equal(await fetch(`${started.url}main.js`).then(r => r.text()), 'console.log("actual asset")');
    assert.equal(await fetch(`${started.url}leak.txt`).then(r => r.status), 403);
    assert.equal(await fetch(new URL('/', started.url!)).then(r => r.status), 404);
    assert.equal(await fetch(started.url!, { method: 'POST' }).then(r => r.status), 405);
    await writeFile(path.join(web, 'main.js'), 'updated');
    assert.equal(await fetch(`${started.url}main.js`).then(r => r.text()), 'console.log("actual asset")');
    const next = await preview.publish(); assert.notEqual(next.url, started.url);
    assert.equal(await fetch(`${next.url}main.js`).then(r => r.text()), 'updated');
    preview.close(); assert.equal(preview.status()?.status, 'stopped');
  } finally { preview.close(); await rm(root, { recursive: true, force: true }); }
});
