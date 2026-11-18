import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLUTTER_FIXTURE = path.join(HERE, 'fixture-flutter.ts');
const DART_FIXTURE = path.join(HERE, 'fixture-dart.ts');

const PUBSPEC = `name: verify_app
description: Verification fixture app.
publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: '>=3.3.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter

flutter:
  uses-material-design: true
`;

let tmp: string;
let verifyProject: typeof import('../harness/verify.js').verifyProject;

function target(projectId: string): string {
  return path.join(tmp, 'verifications', projectId);
}

async function seedResolved(projectId: string): Promise<void> {
  const directory = target(projectId);
  await fs.mkdir(path.join(directory, '.dart_tool'), { recursive: true });
  await fs.writeFile(
    path.join(directory, '.dart_tool', 'package_config.json'),
    JSON.stringify({ configVersion: 2, packages: [] }),
    'utf8',
  );
}

test.before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'flutterforge-verify-'));

  const bin = path.join(tmp, 'flutter', 'bin');
  const dartBin = path.join(bin, 'cache', 'dart-sdk', 'bin');
  await fs.mkdir(dartBin, { recursive: true });

  await fs.copyFile(FLUTTER_FIXTURE, path.join(bin, 'flutter'));
  await fs.chmod(path.join(bin, 'flutter'), 0o755);
  await fs.copyFile(DART_FIXTURE, path.join(dartBin, 'dart'));
  await fs.chmod(path.join(dartBin, 'dart'), 0o755);

  process.env.FLUTTER_BIN = path.join(bin, 'flutter');
  process.env.FLUTTERFORGE_VERIFICATIONS = path.join(tmp, 'verifications');
  process.env.FLUTTERFORGE_DATA_DIR = path.join(tmp, 'data');

  ({ verifyProject } = await import('../harness/verify.js'));
});

test.after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test('verifies a clean project with the analyzer', async () => {
  await seedResolved('verify-clean');
  const result = await verifyProject({
    projectId: 'verify-clean',
    files: [
      { path: 'pubspec.yaml', content: PUBSPEC },
      { path: 'lib/main.dart', content: 'void main() { print("ok"); }\n' },
    ],
  });

  assert.equal(result.verified, true);
  assert.equal(result.skipped, false);
  assert.equal(result.errorCount, 0);
  assert.equal(result.gate.passed, true);
  assert.deepEqual(result.gate.blockers, []);
  assert.equal(result.pubGet.ok, true);
});

test('fails verification with structured analyzer diagnostics', async () => {
  await seedResolved('verify-broken');
  const result = await verifyProject({
    projectId: 'verify-broken',
    files: [
      { path: 'pubspec.yaml', content: PUBSPEC },
      { path: 'lib/main.dart', content: 'void main() {\n  BROKEN_CODE\n}\n' },
    ],
  });

  assert.equal(result.verified, false);
  assert.equal(result.ok, false);
  assert.equal(result.errorCount, 1);
  assert.equal(result.gate.passed, false);
  assert.equal(result.diagnostics[0].filePath, 'lib/main.dart');
  assert.equal(result.diagnostics[0].code, 'fixture_error');
  assert.match(result.gate.blockers.join('\n'), /BROKEN_CODE/);
});

test('never reports verified when pubspec.yaml is missing', async () => {
  const result = await verifyProject({
    projectId: 'verify-no-pubspec',
    files: [{ path: 'lib/main.dart', content: 'void main() {}\n' }],
  });

  assert.equal(result.verified, false);
  assert.equal(result.skipped, true);
  assert.match(result.summary, /pubspec\.yaml/);
});

test('rejects unsafe paths before writing anything', async () => {
  const result = await verifyProject({
    projectId: 'verify-escape',
    files: [
      { path: 'pubspec.yaml', content: PUBSPEC },
      { path: '../../etc/passwd', content: 'x' },
    ],
  });

  assert.equal(result.verified, false);
  assert.equal(result.skipped, true);
  assert.match(result.summary, /escape|relative/i);
  await assert.rejects(fs.access(path.join(tmp, 'etc', 'passwd')));
});
