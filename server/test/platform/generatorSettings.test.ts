import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../../platform/storage/database.js';
import { PLATFORM_MIGRATIONS } from '../../platform/storage/schema.js';
import { loadGeneratorSettings, saveGeneratorSettings, projectSkillContext } from '../../platform/engine/generatorSettings.js';

test('generator settings isolate projects and tenants and preserve edits from another session', async () => {
  const db = await Database.open({ file: ':memory:' });
  try {
    await db.migrate(PLATFORM_MIGRATIONS);
    const defaults = await loadGeneratorSettings(db, 'a', 'one');
    assert.deepEqual(defaults.specialists, []);
    const update = { ...defaults, skills: ['accessibility'], specialists: ['reviewer'] };
    const saved = await saveGeneratorSettings(db, 'a', 'one', update);
    assert.equal(saved.revision, 1);
    await assert.rejects(saveGeneratorSettings(db, 'a', 'one', update), /another session/);
    assert.deepEqual(await loadGeneratorSettings(db, 'a', 'one'), saved);
    assert.deepEqual(await loadGeneratorSettings(db, 'b', 'one'), defaults);
    assert.deepEqual(await loadGeneratorSettings(db, 'a', 'two'), defaults);
    await assert.rejects(saveGeneratorSettings(db, 'a', 'one', { ...saved, skills: ['unknown'] }), /Invalid/);
    assert.match(projectSkillContext(saved.skills), /keyboard focus/);
    assert.doesNotMatch(projectSkillContext(saved.skills), /ColorScheme/);
    const cleared = await saveGeneratorSettings(db, 'a', 'one', { ...saved, skills: [], specialists: [] });
    assert.deepEqual(cleared.skills, []);
    assert.match(projectSkillContext(cleared.skills), /None selected/);
  } finally { await db.close(); }
});
