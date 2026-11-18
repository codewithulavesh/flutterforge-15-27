/**
 * UI layer emitter tests — these assert on emitted Dart source, not on a
 * Flutter toolchain, so they run in the fast unit suite. The real analyzer
 * gate is `generationE2E.test.ts` (opt-in).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSpec } from '../../platform/generation/spec/index.js';
import { emitUiLayer } from '../../platform/generation/emit/ui/index.js';
import { emitComponents } from '../../platform/generation/emit/ui/components.js';
import { SCREEN_KINDS } from '../../platform/generation/contracts.js';
import { snake } from '../../platform/generation/emit/shared.js';

const PROMPTS = [
  'Build a notes app with tags, search and pinning',
  'Build a community chat app for a field research team',
  'Build an onboarding flow for a new personal health app for new parents',
];

const RAW_COLOR = /0x[0-9A-Fa-f]{8}/;
const DEPRECATED = /withOpacity\(|surfaceVariant|MaterialState|ColorScheme\.background|ColorScheme\.onBackground/;
const PLACEHOLDER = /\b(TODO|FIXME|PLACEHOLDER)\b/i;

const pagesFor = (prompt: string) => {
  const spec = compileSpec({ prompt });
  return { spec, files: emitUiLayer({ spec }) };
};

for (const prompt of PROMPTS) {
  test(`emits exactly one page per spec screen: ${prompt}`, () => {
    const { spec, files } = pagesFor(prompt);
    for (const screen of spec.screens) {
      const snakeId = snake(screen.id);
      const page = files.find((file) => file.path === `lib/features/${snakeId}/${snakeId}_page.dart`);
      assert.ok(page, `missing page for ${screen.id}`);
      assert.ok(page.content.includes(`class ${screen.id
        .split('_')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('')}Page`), `wrong class name in ${page.path}`);
      assert.ok(page.content.length > 400, `${page.path} is suspiciously small`);
    }
    assert.equal(files.filter((file) => file.path.endsWith('_page.dart')).length, spec.screens.length);
  });

  test(`no raw colors, deprecated APIs, prints or placeholders: ${prompt}`, () => {
    const { files } = pagesFor(prompt);
    for (const file of files) {
      assert.equal(RAW_COLOR.test(file.content), false, `raw color in ${file.path}`);
      assert.equal(DEPRECATED.test(file.content), false, `deprecated API in ${file.path}`);
      assert.equal(PLACEHOLDER.test(file.content), false, `placeholder in ${file.path}`);
      assert.ok(!/\bprint\s*\(/.test(file.content), `print( in ${file.path}`);
    }
  });
}

test('every emitted Dart file is non-empty and uniquely pathed', () => {
  for (const prompt of PROMPTS) {
    const { files } = pagesFor(prompt);
    const paths = new Set(files.map((file) => file.path));
    assert.equal(paths.size, files.length, 'duplicate paths in UI layer');
    for (const file of files) {
      assert.ok(file.content.trim().length > 0, `empty file ${file.path}`);
      assert.ok(!file.content.includes('\0'), `NUL bytes in ${file.path}`);
    }
  }
});

test('component files are all present and referenced by at least one screen', () => {
  const { files } = pagesFor(PROMPTS[0]);
  const components = emitComponents();
  assert.ok(components.length >= 5, 'expected the shared component set');
  const allScreens = files.map((file) => file.content).join('\n');
  for (const component of components) {
    const name = component.path.split('/').pop()!;
    assert.ok(allScreens.includes(name), `${name} is not referenced by any screen`);
  }
});

test('entity-bound screens read state from AppScope and rebuild with ListenableBuilder', () => {
  for (const prompt of PROMPTS) {
    const { spec, files } = pagesFor(prompt);
    for (const screen of spec.screens) {
      if (!screen.entity) continue;
      if (screen.id === 'chat' || screen.kind === 'chat') continue; // local demo conversation, see chat test below
      const page = files.find((file) => file.path.endsWith(`${snake(screen.id)}_page.dart`));
      assert.ok(page, `missing page for ${screen.id}`);
      assert.ok(page.content.includes('AppScope.of(context)'), `${screen.id} does not use AppScope`);
      assert.ok(page.content.includes('ListenableBuilder'), `${screen.id} does not rebuild via ListenableBuilder`);
    }
  }
});

test('data screens render loading, error and empty states', () => {
  for (const prompt of PROMPTS) {
    const { spec, files } = pagesFor(prompt);
    for (const screen of spec.screens) {
      if (screen.kind !== 'list' && screen.kind !== 'detail' && screen.kind !== 'dashboard') continue;
      const page = files.find((file) => file.path.endsWith(`${snake(screen.id)}_page.dart`));
      assert.ok(page, `missing page for ${screen.id}`);
      assert.ok(/AppAsyncView|CircularProgressIndicator/.test(page.content), `${screen.id} has no loading state`);
      assert.ok(/error|Error/.test(page.content), `${screen.id} has no error state`);
      assert.ok(/empty|Empty|Nothing/i.test(page.content), `${screen.id} has no empty state`);
    }
  }
});

test('forms carry validation, a save action and at least one typed control', () => {
  for (const prompt of PROMPTS) {
    const { spec, files } = pagesFor(prompt);
    for (const screen of spec.screens) {
      if (screen.kind !== 'form') continue;
      const page = files.find((file) => file.path.endsWith(`${snake(screen.id)}_page.dart`));
      assert.ok(page, `missing form page ${screen.id}`);
      assert.ok(page.content.includes('TextFormField'), `${screen.id} has no text fields`);
      assert.ok(page.content.includes('validator:'), `${screen.id} has no validators`);
      assert.ok(/GlobalKey<FormState>/.test(page.content), `${screen.id} has no FormState key`);
      assert.ok(/FilledButton|ElevatedButton|Save/i.test(page.content), `${screen.id} has no save action`);
    }
  }
});

test('chat screen is an honest local demo with a composer and optimistic send', () => {
  const chatPrompt = 'Build a community chat app for a field research team';
  const { spec, files } = pagesFor(chatPrompt);
  const screen = spec.screens.find((item) => item.kind === 'chat');
  assert.ok(screen, 'expected a chat screen');
  const page = files.find((file) => file.path.endsWith(`${screen?.id}_page.dart`));
  assert.ok(page);
  assert.ok(page.content.includes('TextField'), 'no composer');
  assert.ok(/Local demo conversation/.test(page.content), 'demo scope must be stated in the UI copy');
  assert.ok(/isMine|isOwn|author/i.test(page.content), 'no author alignment');
  assert.ok(/Semantics|tooltip:/.test(page.content), 'no accessible send control');
});

test('onboarding screen is paged and accessible', () => {
  const prompt = 'Build an onboarding flow for a new personal health app for new parents';
  const { spec, files } = pagesFor(prompt);
  const screen = spec.screens.find((item) => item.kind === 'onboarding');
  assert.ok(screen, 'expected an onboarding screen');
  const page = files.find((file) => file.path.endsWith(`${screen?.id}_page.dart`));
  assert.ok(page);
  assert.ok(/PageView/.test(page.content), 'not paged');
  assert.ok(/Skip|Get started|Continue/i.test(page.content), 'no progression or skip affordance');
  assert.ok(/Semantics/.test(page.content), 'no semantics labels');
});

test('settings screen wires the app-level theme control', () => {
  const { spec, files } = pagesFor(PROMPTS[0]);
  const screen = spec.screens.find((item) => item.kind === 'settings');
  assert.ok(screen);
  const page = files.find((file) => file.path.endsWith(`${screen?.id}_page.dart`));
  assert.ok(page);
  assert.ok(/ThemeMode|themeMode/.test(page.content), 'no app-level theme control');
  assert.ok(/AppScope\.of\(context\)/.test(page.content), 'theme control not wired to scope');
});

test('every ScreenKind is covered by at least one emitter path', () => {
  const allKinds = new Set<string>();
  for (const prompt of PROMPTS) {
    const { spec } = pagesFor(prompt);
    for (const screen of spec.screens) allKinds.add(screen.kind);
  }
  for (const kind of SCREEN_KINDS) {
    assert.ok(allKinds.has(kind), `no fixture exercises the ${kind} archetype`);
  }
});

test('emission is deterministic for identical input', () => {
  const first = pagesFor(PROMPTS[0]).files;
  const second = pagesFor(PROMPTS[0]).files;
  assert.equal(first.length, second.length);
  for (let index = 0; index < first.length; index += 1) {
    assert.equal(first[index].path, second[index].path);
    assert.equal(first[index].content, second[index].content);
  }
});
