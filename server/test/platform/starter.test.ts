import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStarterProject } from '../../platform/generation/starter/index.js';
import { validateDartFiles } from '../../platform/dart/validate.js';

const base = buildStarterProject({ appName: 'Tasksmith', packageName: 'tasksmith' });

test('emits pubspec, main, app, theme, analysis_options, README, .gitignore', () => {
  const paths = base.map((f) => f.path).sort();
  assert.deepEqual(paths, ['.gitignore', 'README.md', 'analysis_options.yaml', 'lib/app/app.dart', 'lib/app/theme.dart', 'lib/main.dart', 'pubspec.yaml']);
});

test('pubspec declares flutter, go_router, provider, equatable; no frozen packages', () => {
  const pubspec = base.find((f) => f.path === 'pubspec.yaml')?.content ?? '';
  assert.match(pubspec, /^\s+flutter:/m);
  assert.match(pubspec, /^\s+go_router:/m);
  assert.match(pubspec, /^\s+provider:/m);
  assert.match(pubspec, /^\s+equatable:/m);
  assert.doesNotMatch(pubspec, /freezed|json_serializable|build_runner/);
});

test('emitted Dart validates with zero errors and entrypoints pass', () => {
  const files = base.map((f) => ({ path: f.path, content: f.content }));
  const result = validateDartFiles({ files, packageName: 'tasksmith' });
  assert.equal(result.passed, true, result.diagnostics.map((d) => `${d.path}: ${d.message}`).join('\n'));
});

test('main.dart and theme.dart contain entrypoints and Material 3 flags', () => {
  const main = base.find((f) => f.path === 'lib/main.dart')!.content;
  const theme = base.find((f) => f.path === 'lib/app/theme.dart')!.content;
  assert.match(main, /runApp\(/);
  const app = base.find((f) => f.path === 'lib/app/app.dart')!.content;
  assert.match(app, /MaterialApp\(/);
  assert.match(app, /TasksmithApp extends StatelessWidget/);
  assert.match(theme, /useMaterial3: true/);
  assert.match(theme, /ColorScheme\.fromSeed/);
});

test('supabase backend adds supabase_flutter but default does not', () => {
  const local = buildStarterProject({ appName: 'Local', packageName: 'local_app', backend: 'local' });
  const cloud = buildStarterProject({ appName: 'Cloud', packageName: 'cloud_app', backend: 'supabase' });
  assert.doesNotMatch(local.find((f) => f.path === 'pubspec.yaml')!.content, /supabase_flutter/);
  assert.match(cloud.find((f) => f.path === 'pubspec.yaml')!.content, /supabase_flutter:/);
});

test('invalid starters are still deterministic given same input', () => {
  const a = buildStarterProject({ appName: 'Same', packageName: 'same_app' });
  const b = buildStarterProject({ appName: 'Same', packageName: 'same_app' });
  assert.deepEqual(a, b);
});

test('weird app names still produce a valid package name', () => {
  const result = buildStarterProject({ appName: '!!! Weird App !!!', packageName: '!!! Weird App !!!' });
  const pubspec = result.find((f) => f.path === 'pubspec.yaml')!.content;
  const match = pubspec.match(/^name: (\S+)/m);
  assert.ok(match, 'pubspec must declare a name');
  assert.match(match[1], /^[a-z][a-z0-9_]*$/);
});

test('seed color override lands in theme.dart as 0xFF hex', () => {
  const result = buildStarterProject({ appName: 'Brand', packageName: 'brand_app', seedColor: '#FF5733', darkColor: '#33FF57' });
  const theme = result.find((f) => f.path === 'lib/app/theme.dart')!.content;
  assert.match(theme, /0xFFFF5733|0xffff5733/i);
  assert.match(theme, /0xFF33FF57/i);
});

test('starter has zero warnings that would block a green verify', () => {
  const files = base.map((f) => ({ path: f.path, content: f.content }));
  const result = validateDartFiles({ files, packageName: 'tasksmith' });
  assert.equal(result.diagnostics.filter((d) => d.severity === 'error').length, 0);
});
