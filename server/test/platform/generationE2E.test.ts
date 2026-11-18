/**
 * End-to-end proof of the "any prompt → top app" lane.
 *
 * Fast assertions (always run): every representative prompt compiles to a
 * valid AppSpec and emits a structurally complete project — every screen,
 * model, repository, controller and test file present, every import resolved.
 *
 * Real-toolchain assertions (opt-in, `FLUTTERFORGE_E2E_FLUTTER=1`): the emitted
 * project is materialized into an isolated workspace, dependencies are
 * resolved, and the actual Dart analyzer must report zero errors. Set
 * `FLUTTERFORGE_E2E_FLUTTER_TESTS=1` to additionally run the emitted widget
 * tests. These are slow and require Flutter on PATH; CI without a toolchain
 * must not silently pass them, which is why they are skipped explicitly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { compileSpec } from '../../platform/generation/spec/index.js';
import { emitAndCheck } from '../../platform/generation/emit/index.js';
import { validateSpec } from '../../platform/generation/emit/shared.js';
import { verifyProject } from '../../harness/verify.js';

const PROMPTS = [
  'Build a notes app with tags, search and pinning',
  'Habit tracker with streaks and daily check-ins',
  'Split expenses with friends and settle balances',
  'Recipe box with ingredients, steps and cook time',
  'Workout log with exercises, sets and personal records',
  'Trip planner with itinerary and packing list',
  'CRM leads with pipeline stages and follow-ups',
  'Invoice manager with line items, tax and status',
];

test('representative prompts compile to valid specs', () => {
  for (const prompt of PROMPTS) {
    const spec = compileSpec({ prompt });
    const validation = validateSpec(spec);
    assert.equal(validation.ok, true, `${prompt}: ${validation.errors.join('; ')}`);
    assert.ok(spec.entities.length >= 1 && spec.entities.length <= 4, `${prompt}: entity count ${spec.entities.length}`);
    assert.ok(spec.screens.length >= 3 && spec.screens.length <= 8, `${prompt}: screen count ${spec.screens.length}`);
    assert.ok(spec.flows.length >= 1, `${prompt}: no flows`);
    assert.ok(spec.app.name.length >= 2, `${prompt}: empty app name`);
    assert.equal(spec.app.packageName, spec.app.packageName.toLowerCase());
  }
});

test('emitted projects are structurally complete and import-clean', () => {
  for (const prompt of PROMPTS) {
    const spec = compileSpec({ prompt });
    const { files, problems } = emitAndCheck(spec);
    assert.deepEqual(problems, [], `${prompt}: ${problems.join('; ')}`);

    const paths = new Set(files.map((file) => file.path));
    for (const screen of spec.screens) {
      assert.ok(paths.has(`lib/features/${screen.id}/${screen.id}_page.dart`), `${prompt}: missing screen ${screen.id}`);
    }
    for (const entity of spec.entities) {
      const snake = entity.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      assert.ok(paths.has(`lib/data/models/${snake}.dart`), `${prompt}: missing model ${snake}`);
      assert.ok(paths.has(`lib/data/repositories/${snake}_repository.dart`), `${prompt}: missing repository ${snake}`);
      assert.ok(paths.has(`lib/state/${snake}_controller.dart`), `${prompt}: missing controller ${snake}`);
    }
    assert.ok(paths.has('test/app/app_smoke_test.dart'));
    assert.ok(paths.has('README.md'));

    // Top-app markers — reject toy output.
    const all = files.map((file) => file.content).join('\n');
    assert.ok(/ScrollView|ListView|CustomScrollView/.test(all), `${prompt}: no scrollable content`);
    assert.ok(/Semantics|tooltip:|semanticLabel:/.test(all), `${prompt}: no accessibility markers`);
    assert.ok(/validator:/.test(all), `${prompt}: no form validation`);
    assert.ok(/empty|No .* yet|Nothing here/i.test(all), `${prompt}: no empty state`);
    assert.ok(!/Hello, World|Hello World|A new Flutter project|counter \+= 1/i.test(all), `${prompt}: toy scaffold detected`);
    assert.ok(!/\b(TODO|FIXME|PLACEHOLDER)\b/i.test(all), `${prompt}: placeholder content detected`);
  }
});

test(
  'emitted project passes the real Flutter analyzer',
  { skip: process.env.FLUTTERFORGE_E2E_FLUTTER !== '1', timeout: 600_000 },
  async () => {
    const spec = compileSpec({ prompt: 'Build a notes app with tags, search and pinning' });
    const { files, problems } = emitAndCheck(spec);
    assert.deepEqual(problems, []);
    const projectId = `e2e-${Date.now()}`;
    const result = await verifyProject({
      projectId,
      files: files.map((file) => ({ path: file.path, content: file.content })),
      timeoutMs: 480_000,
    });
    const blockers = result.diagnostics.filter((d) => d.severity === 'error').slice(0, 12);
    assert.equal(
      result.verified,
      true,
      `analyzer rejected ${projectId}: ${result.summary}\n${blockers.map((d) => `${d.file ?? '?'}:${d.line ?? '?'} ${d.message}`).join('\n')}`,
    );

    if (process.env.FLUTTERFORGE_E2E_FLUTTER_TESTS === '1') {
      const code = await runFlutterTest(result.workspace);
      assert.equal(code, 0, `flutter test failed in ${result.workspace}`);
    }
  },
);

function runFlutterTest(cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FLUTTER_BIN || 'flutter', ['test'], { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
