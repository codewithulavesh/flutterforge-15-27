/**
 * Release artifact engine tests.
 *
 * No Flutter SDK is required anywhere in this file: every build step is either
 * an injected fake `runCommand` or the real `node` executable used as a stand-in
 * process for the default runner's timeout/exit-code paths.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

import {
  RELEASE_STEPS,
  RELEASE_TARGETS,
  buildReleasePlan,
  checkReleaseReadiness,
  executeReleasePlan,
  defaultReleaseCommandRunner,
  type ReleasePlan,
  type ReleaseCommandResult,
} from '../../platform/release/index.js';
import { PlatformError } from '../../platform/kernel/errors.js';
import { sha256Hex } from '../../platform/kernel/hash.js';
import { createLogger, memorySink, type LogRecord } from '../../platform/kernel/logger.js';

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function mktemp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const fakeFlutter = () => '/fake/bin/flutter';
const missingFlutter = () => null;

function makeFlutterProject(overrides: {
  pubspec?: boolean;
  mainDart?: boolean;
  gradle?: boolean;
  gradleKts?: boolean;
  keyProperties?: boolean;
  ios?: boolean;
} = {}): string {
  const root = mktemp('ff-release-project-');
  const write = (relative: string, content: string | Buffer) => {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  if (overrides.pubspec !== false) write('pubspec.yaml', 'name: demo\nenvironment:\n  sdk: ^3.5.0\n');
  if (overrides.mainDart !== false) write('lib/main.dart', 'void main() {}\n');
  if (overrides.gradle) write('android/app/build.gradle', '// gradle\n');
  if (overrides.gradleKts) write('android/app/build.gradle.kts', '// gradle.kts\n');
  if (overrides.keyProperties) {
    write('android/upload.jks', 'fake-keystore-bytes');
    write('android/key.properties', 'storePassword=testset-by-fixture\nkeyPassword=testset-by-fixture\nkeyAlias=upload\nstoreFile=upload.jks\n');
  }
  if (overrides.ios) mkdirSync(path.join(root, 'ios'), { recursive: true });
  return root;
}

function readManifest(artifactsRoot: string, jobId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(artifactsRoot, 'jobs', `${jobId}.json`), 'utf8')) as Record<string, unknown>;
}

function readOnlyManifest(artifactsRoot: string): Record<string, unknown> {
  const [manifestName] = readdirSync(path.join(artifactsRoot, 'jobs'));
  return JSON.parse(readFileSync(path.join(artifactsRoot, 'jobs', manifestName), 'utf8')) as Record<string, unknown>;
}

describe('buildReleasePlan', () => {
  test('is deterministic and produces the documented web build argv', () => {
    const first = buildReleasePlan({ target: 'web', projectId: 'demo', artifactDir: '/tmp/ff-artifacts' });
    const second = buildReleasePlan({ target: 'web', projectId: 'demo', artifactDir: '/tmp/ff-artifacts' });
    assert.deepEqual(first, second);
    assert.equal(first.id, second.id);
    assert.equal(first.artifactName, 'demo-web.tar.gz');
    assert.deepEqual(first.steps.map((step) => step.argv), [
      ['flutter', 'build', 'web', '--release'],
    ]);
    // --wasm is deliberately absent: plain --release is the portable CanvasKit/JS artifact.
    assert.ok(!first.steps[0].argv.includes('--wasm=false'));
  });

  test('zip and apk plans carry the documented artifact names', () => {
    const zipPlan = buildReleasePlan({ target: 'zip', projectId: 'demo', artifactDir: '/tmp/ff-artifacts' });
    assert.equal(zipPlan.artifactName, 'demo-flutter-web.tar.gz');
    assert.deepEqual(zipPlan.steps[0].argv, ['flutter', 'build', 'web', '--release']);
    const apkPlan = buildReleasePlan({ target: 'android-apk', projectId: 'demo', artifactDir: '/tmp/ff-artifacts' });
    assert.equal(apkPlan.artifactName, 'demo-release.apk');
    assert.deepEqual(apkPlan.steps[0].argv, ['flutter', 'build', 'apk', '--release']);
    const aabPlan = buildReleasePlan({ target: 'android-aab', projectId: 'demo', artifactDir: '/tmp/ff-artifacts' });
    assert.deepEqual(aabPlan.steps[0].argv, ['flutter', 'build', 'appbundle', '--release']);
    const ipaPlan = buildReleasePlan({ target: 'ios-archive', projectId: 'demo', artifactDir: '/tmp/ff-artifacts' });
    assert.deepEqual(ipaPlan.steps[0].argv, ['flutter', 'build', 'ipa', '--release']);
  });

  test('embeds the project root as the step cwd when given', () => {
    const plan = buildReleasePlan({ target: 'web', projectId: 'demo', artifactDir: '/tmp/ff-artifacts', projectRoot: '.' });
    assert.equal(plan.projectRoot, path.resolve('.'));
    assert.equal(plan.steps[0].cwd, path.resolve('.'));
  });

  test('rejects unknown targets', () => {
    assert.throws(
      () => buildReleasePlan({ target: 'msi' as never, projectId: 'demo', artifactDir: '/tmp/ff-artifacts' }),
      (error: unknown) => error instanceof PlatformError && (error as PlatformError).code === 'RELEASE_TARGET_INVALID',
    );
  });

  test('RELEASE_STEPS covers every target with positive timeouts and flutter argv', () => {
    for (const target of RELEASE_TARGETS) {
      const steps = RELEASE_STEPS[target];
      assert.ok(steps.length >= 1, target);
      for (const step of steps) {
        assert.equal(step.argv[0], 'flutter', `${target}/${step.id}`);
        assert.ok(step.timeoutMs > 0, `${target}/${step.id} timeout`);
        assert.ok(step.id.length > 0 && step.description.length > 0);
      }
    }
  });
});

describe('checkReleaseReadiness', () => {
  test('missing pubspec is a blocker', async () => {
    const root = mktemp('ff-release-empty-');
    const result = await checkReleaseReadiness({ target: 'web', projectId: 'demo', projectRoot: root, env: {}, which: fakeFlutter });
    assert.equal(result.ready, false);
    assert.ok(result.blockers.some((blocker) => blocker.startsWith('PUBSPEC_MISSING')));
    assert.ok(result.blockers.some((blocker) => blocker.startsWith('MAIN_DART_MISSING')));
  });

  test('android without keystore or env is a blocker', async () => {
    const root = makeFlutterProject({ gradle: true });
    const result = await checkReleaseReadiness({ target: 'android-apk', projectId: 'demo', projectRoot: root, env: {}, which: fakeFlutter });
    assert.equal(result.ready, false);
    assert.ok(result.blockers.some((blocker) => blocker.startsWith('ANDROID_SIGNING_NOT_CONFIGURED')));
  });

  test('android with ANDROID_KEYSTORE_PATH pointing at a real file is ready', async () => {
    const root = makeFlutterProject({ gradle: true });
    const keystore = path.join(mktemp('ff-release-keystore-'), 'upload.jks');
    writeFileSync(keystore, 'fake-keystore');
    const result = await checkReleaseReadiness({
      target: 'android-apk', projectId: 'demo', projectRoot: root,
      env: { ANDROID_KEYSTORE_PATH: keystore }, which: fakeFlutter,
    });
    assert.deepEqual(result.blockers, []);
    assert.equal(result.ready, true);
  });

  test('android with ANDROID_KEYSTORE_PATH pointing at a missing file is a NOT_FOUND blocker', async () => {
    const root = makeFlutterProject({ gradle: true });
    const result = await checkReleaseReadiness({
      target: 'android-aab', projectId: 'demo', projectRoot: root,
      env: { ANDROID_KEYSTORE_PATH: path.join(root, 'does-not-exist.jks') }, which: fakeFlutter,
    });
    assert.equal(result.ready, false);
    assert.ok(result.blockers.some((blocker) => blocker.startsWith('ANDROID_KEYSTORE_NOT_FOUND')));
  });

  test('android with FLUTTERFORGE_ANDROID_KEYSTORE pointing at a real file is ready', async () => {
    const root = makeFlutterProject({ gradle: true });
    const keystore = path.join(mktemp('ff-release-keystore-'), 'upload.jks');
    writeFileSync(keystore, 'fake-keystore');
    const result = await checkReleaseReadiness({
      target: 'android-apk', projectId: 'demo', projectRoot: root,
      env: { FLUTTERFORGE_ANDROID_KEYSTORE: keystore }, which: fakeFlutter,
    });
    assert.equal(result.ready, true);
  });

  test('android key.properties with an existing storeFile is ready without env', async () => {
    const root = makeFlutterProject({ gradle: true, keyProperties: true });
    const result = await checkReleaseReadiness({ target: 'android-apk', projectId: 'demo', projectRoot: root, env: {}, which: fakeFlutter });
    assert.equal(result.ready, true, JSON.stringify(result.blockers));
  });

  test('android without signing accepted as unsigned degrades the blocker to a warning', async () => {
    const root = makeFlutterProject({ gradle: true });
    const result = await checkReleaseReadiness({ target: 'android-apk', projectId: 'demo', projectRoot: root, env: {}, which: fakeFlutter, unsigned: true });
    assert.equal(result.ready, true);
    assert.equal(result.blockers.length, 0);
    assert.ok(result.warnings.some((warning) => warning.includes('ANDROID_SIGNING_NOT_CONFIGURED')));
  });

  test('missing gradle build file is a blocker even with a keystore configured', async () => {
    const root = makeFlutterProject();
    const keystore = path.join(mktemp('ff-release-keystore-'), 'upload.jks');
    writeFileSync(keystore, 'fake-keystore');
    const result = await checkReleaseReadiness({
      target: 'android-apk', projectId: 'demo', projectRoot: root,
      env: { ANDROID_KEYSTORE_PATH: keystore }, which: fakeFlutter,
    });
    assert.equal(result.ready, false);
    assert.ok(result.blockers.some((blocker) => blocker.startsWith('ANDROID_BUILD_GRADLE_MISSING')));
  });

  test('build.gradle.kts is accepted', async () => {
    const root = makeFlutterProject({ gradleKts: true, keyProperties: true });
    const result = await checkReleaseReadiness({ target: 'android-apk', projectId: 'demo', projectRoot: root, env: {}, which: fakeFlutter });
    assert.equal(result.ready, true, JSON.stringify(result.blockers));
  });

  test('ios-archive on linux is a blocker even with a complete project', async () => {
    const root = makeFlutterProject({ ios: true });
    const result = await checkReleaseReadiness({ target: 'ios-archive', projectId: 'demo', projectRoot: root, env: {}, platform: 'linux', which: fakeFlutter });
    assert.equal(result.ready, false);
    assert.ok(result.blockers.some((blocker) => blocker.startsWith('IOS_REQUIRES_MACOS')));
  });

  test('ios-archive on darwin with an ios directory is ready', async () => {
    const root = makeFlutterProject({ ios: true });
    const result = await checkReleaseReadiness({ target: 'ios-archive', projectId: 'demo', projectRoot: root, env: {}, platform: 'darwin', which: fakeFlutter });
    assert.equal(result.ready, true, JSON.stringify(result.blockers));
  });

  test('web with an injected which() is ready; a missing flutter is a blocker', async () => {
    const root = makeFlutterProject();
    const ready = await checkReleaseReadiness({ target: 'web', projectId: 'demo', projectRoot: root, env: {}, which: fakeFlutter });
    assert.equal(ready.ready, true);
    const missing = await checkReleaseReadiness({ target: 'web', projectId: 'demo', projectRoot: root, env: {}, which: missingFlutter });
    assert.equal(missing.ready, false);
    assert.ok(missing.blockers.some((blocker) => blocker.startsWith('FLUTTER_NOT_AVAILABLE')));
  });

  test('blocker messages never include the keystore path that was set', async () => {
    const root = makeFlutterProject({ gradle: true });
    const secretPath = path.join(mktemp('ff-release-secret-'), 'upload-keystore-with-secret-name.jks');
    const result = await checkReleaseReadiness({
      target: 'android-apk', projectId: 'demo', projectRoot: root,
      env: { ANDROID_KEYSTORE_PATH: secretPath }, which: fakeFlutter,
    });
    assert.equal(result.ready, false);
    assert.ok(!JSON.stringify(result).includes(secretPath), 'readiness payload leaked the keystore path');
  });
});

describe('executeReleasePlan', () => {
  test('copies the APK artifact, hashes it and writes the manifest atomically', async () => {
    const root = makeFlutterProject({ gradle: true });
    const artifactsRoot = mktemp('ff-release-artifacts-');
    const apkBytes = Buffer.concat([Buffer.from('fake-apk-payload\x00\x01\x02'), Buffer.alloc(1024, 7)]);
    const plan = buildReleasePlan({ target: 'android-apk', projectId: 'demo', artifactDir: artifactsRoot, projectRoot: root, tenantId: 'tenant-1', actor: 'tester' });

    const calls: Array<{ argv: string[]; cwd?: string; timeoutMs: number }> = [];
    const runCommand = async (argv: string[], options: { cwd?: string; timeoutMs: number }): Promise<ReleaseCommandResult> => {
      calls.push({ argv, cwd: options.cwd, timeoutMs: options.timeoutMs });
      const outDir = path.join(root, 'build', 'app', 'outputs', 'flutter-apk');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, 'app-release.apk'), apkBytes);
      return { code: 0, stdout: 'ok', stderr: '' };
    };

    const result = await executeReleasePlan({ plan, runCommand, env: {} });
    assert.equal(result.job.status, 'succeeded');
    assert.equal(result.job.projectId, 'demo');
    assert.equal(result.job.tenantId, 'tenant-1');
    assert.equal(result.job.actor, 'tester');
    assert.deepEqual(calls.map((call) => call.argv), [['flutter', 'build', 'apk', '--release']]);
    assert.equal(calls[0].cwd, root);

    const expected = path.join(artifactsRoot, 'demo', result.job.id, 'demo-release.apk');
    assert.equal(result.artifact, expected);
    assert.equal(result.job.outputPath, expected);
    assert.deepEqual(readFileSync(expected), apkBytes);
    assert.equal(result.size, apkBytes.length);
    assert.equal(result.job.size, apkBytes.length);
    assert.equal(result.sha256, sha256Hex(apkBytes));
    assert.equal(result.job.sha256, result.sha256);

    const manifest = readManifest(artifactsRoot, result.job.id) as {
      version: number; planId: string; status: string;
      artifact: { name: string; sha256: string; size: number } | null;
      tenantId: string; actor: string; signingState: string;
    };
    assert.equal(manifest.version, 1);
    assert.equal(manifest.planId, plan.id);
    assert.equal(manifest.status, 'succeeded');
    assert.equal(manifest.tenantId, 'tenant-1');
    assert.equal(manifest.actor, 'tester');
    assert.equal(manifest.signingState, 'unsigned');
    assert.equal(manifest.artifact?.name, 'demo-release.apk');
    assert.equal(manifest.artifact?.sha256, result.sha256);
    assert.equal(manifest.artifact?.size, apkBytes.length);
  });

  test('nonzero exit throws RELEASE_BUILD_FAILED and records a failed manifest without an artifact', async () => {
    const root = makeFlutterProject({ gradle: true });
    const artifactsRoot = mktemp('ff-release-artifacts-');
    const plan = buildReleasePlan({ target: 'android-apk', projectId: 'demo', artifactDir: artifactsRoot, projectRoot: root });
    const runCommand = async (): Promise<ReleaseCommandResult> => ({ code: 2, stdout: '', stderr: 'FAILURE: gradle exploded' });

    await assert.rejects(
      executeReleasePlan({ plan, runCommand, env: {} }),
      (error: unknown) => {
        assert.ok(error instanceof PlatformError);
        assert.equal(error.code, 'RELEASE_BUILD_FAILED');
        assert.equal(error.details?.exitCode, 2);
        assert.match(String(error.details?.tail ?? ''), /gradle exploded/);
        return true;
      },
    );
    const manifest = readOnlyManifest(artifactsRoot) as { status: string; artifact: unknown };
    assert.equal(manifest.status, 'failed');
    assert.equal(manifest.artifact, null);
    assert.equal(existsSync(path.join(artifactsRoot, 'demo')), false, 'no artifact directory may be produced on failure');
  });

  test('default runner captures a nonzero exit as RELEASE_BUILD_FAILED', async () => {
    const root = makeFlutterProject();
    const artifactsRoot = mktemp('ff-release-artifacts-');
    const basePlan = buildReleasePlan({ target: 'web', projectId: 'demo', artifactDir: artifactsRoot, projectRoot: root });
    const plan: ReleasePlan = {
      ...basePlan,
      steps: [{ id: 'boom', description: 'exits with code 3', argv: [process.execPath, '-e', 'process.exit(3)'], timeoutMs: 10_000 }],
    };
    await assert.rejects(
      executeReleasePlan({ plan, env: {} }),
      (error: unknown) => {
        assert.ok(error instanceof PlatformError);
        assert.equal(error.code, 'RELEASE_BUILD_FAILED');
        assert.equal(error.details?.exitCode, 3);
        return true;
      },
    );
    const manifest = readOnlyManifest(artifactsRoot) as { status: string };
    assert.equal(manifest.status, 'failed');
  });

  test('default runner kills a step that exceeds its timeout and records a failed manifest', async () => {
    const root = makeFlutterProject();
    const artifactsRoot = mktemp('ff-release-artifacts-');
    const basePlan = buildReleasePlan({ target: 'web', projectId: 'demo', artifactDir: artifactsRoot, projectRoot: root });
    const plan: ReleasePlan = {
      ...basePlan,
      steps: [{ id: 'sleep', description: 'never finishes in time', argv: [process.execPath, '-e', 'setTimeout(() => {}, 10_000)'], timeoutMs: 200 }],
    };
    await assert.rejects(
      executeReleasePlan({ plan, env: {} }),
      (error: unknown) => {
        assert.ok(error instanceof PlatformError);
        assert.equal(error.code, 'TIMEOUT');
        return true;
      },
    );
    const manifest = readOnlyManifest(artifactsRoot) as { status: string };
    assert.equal(manifest.status, 'failed');
  });

  test('fake-runner timeout result is converted to TIMEOUT', async () => {
    const root = makeFlutterProject();
    const artifactsRoot = mktemp('ff-release-artifacts-');
    const plan = buildReleasePlan({ target: 'web', projectId: 'demo', artifactDir: artifactsRoot, projectRoot: root });
    const runCommand = async (): Promise<ReleaseCommandResult> => ({ code: null, stdout: '', stderr: 'killed', timedOut: true, signal: 'SIGTERM' });
    await assert.rejects(
      executeReleasePlan({ plan, runCommand, env: {} }),
      (error: unknown) => {
        assert.ok(error instanceof PlatformError);
        assert.equal(error.code, 'TIMEOUT');
        return true;
      },
    );
  });

  test('zip archives build/web into a tar.gz containing the web bundle bytes', async () => {
    const root = makeFlutterProject();
    const artifactsRoot = mktemp('ff-release-artifacts-');
    const indexHtml = '<!doctype html><html><title>demo</title>\n</html>\n';
    const appBytes = Buffer.concat([Buffer.from('bundle-bytes\n'), Buffer.alloc(512, 0x61)]);
    const plan = buildReleasePlan({ target: 'zip', projectId: 'demo', artifactDir: artifactsRoot, projectRoot: root });
    assert.equal(plan.artifactName, 'demo-flutter-web.tar.gz');

    // Simulated `flutter build web`: writes the bundle the archiver picks up.
    // No real flutter binary is needed for this path.
    const runCommand = async (): Promise<ReleaseCommandResult> => {
      const assetsDir = path.join(root, 'build', 'web', 'assets');
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(path.join(root, 'build', 'web', 'index.html'), indexHtml);
      writeFileSync(path.join(assetsDir, 'app.bin'), appBytes);
      return { code: 0, stdout: 'built', stderr: '' };
    };

    const result = await executeReleasePlan({ plan, runCommand, env: {} });
    assert.equal(result.job.status, 'succeeded');
    assert.match(result.artifact, /demo-flutter-web\.tar\.gz$/);

    const parsed = parseTarArchive(gunzipSync(readFileSync(result.artifact)));
    assert.equal(parsed.get('index.html')?.toString('utf8'), indexHtml);
    assert.deepEqual(parsed.get('assets/app.bin'), appBytes);

    assert.equal(result.sha256, sha256Hex(readFileSync(result.artifact)));
    const manifest = readManifest(artifactsRoot, result.job.id) as { artifact: { name: string; sha256: string } | null; status: string };
    assert.equal(manifest.status, 'succeeded');
    assert.equal(manifest.artifact?.name, 'demo-flutter-web.tar.gz');
    assert.equal(manifest.artifact?.sha256, result.sha256);
  });

  test('zip fails honestly when the web build produced no output', async () => {
    const root = makeFlutterProject();
    const artifactsRoot = mktemp('ff-release-artifacts-');
    const plan = buildReleasePlan({ target: 'zip', projectId: 'demo', artifactDir: artifactsRoot, projectRoot: root });
    const runCommand = async (): Promise<ReleaseCommandResult> => ({ code: 0, stdout: '', stderr: '' });
    await assert.rejects(
      executeReleasePlan({ plan, runCommand, env: {} }),
      (error: unknown) => {
        assert.ok(error instanceof PlatformError);
        assert.equal(error.code, 'RELEASE_ARTIFACT_MISSING');
        return true;
      },
    );
    const manifest = readOnlyManifest(artifactsRoot) as { status: string; artifact: unknown };
    assert.equal(manifest.status, 'failed');
    assert.equal(manifest.artifact, null);
  });

  test('keystore path and store password are scrubbed from job logs and the manifest', async () => {
    const root = makeFlutterProject({ gradle: true });
    const secretDir = mktemp('ff-release-secret-');
    const keystorePath = path.join(secretDir, 'upload-keystore-with-secret-name.jks');
    writeFileSync(keystorePath, 'fake-keystore-bytes');
    const storePassword = 'super-secret-store-password';
    const artifactsRoot = mktemp('ff-release-artifacts-');
    const plan = buildReleasePlan({ target: 'android-apk', projectId: 'demo', artifactDir: artifactsRoot, projectRoot: root });

    const records: LogRecord[] = [];
    const logger = createLogger({ level: 'debug', sink: memorySink(records), bindings: { component: 'release-test' } });
    const apkBytes = Buffer.from('apk-bytes');
    const runCommand = async (): Promise<ReleaseCommandResult> => {
      const outDir = path.join(root, 'build', 'app', 'outputs', 'flutter-apk');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, 'app-release.apk'), apkBytes);
      return { code: 0, stdout: `signing with ${keystorePath}`, stderr: `storePassword=${storePassword}` };
    };

    const result = await executeReleasePlan({
      plan, runCommand, logger,
      env: { ANDROID_KEYSTORE_PATH: keystorePath, ANDROID_STORE_PASSWORD: storePassword },
    });
    assert.equal(result.job.signingState, 'signed');

    const manifest = readFileSync(path.join(artifactsRoot, 'jobs', `${result.job.id}.json`), 'utf8');
    const everything = JSON.stringify({ jobLog: result.job.log, records, manifest: JSON.parse(manifest) });
    assert.ok(!everything.includes(keystorePath), 'keystore path leaked into logs/manifest');
    assert.ok(!everything.includes('upload-keystore-with-secret-name.jks'), 'keystore file name leaked into logs/manifest');
    assert.ok(!everything.includes(storePassword), 'store password leaked into logs/manifest');
    assert.ok(everything.includes('[REDACTED]'));
  });

  test('ios execution on a non-darwin host records a skipped job and throws before running any step', async () => {
    const root = makeFlutterProject({ ios: true });
    const artifactsRoot = mktemp('ff-release-artifacts-');
    let runnerCalled = false;
    const plan = buildReleasePlan({ target: 'ios-archive', projectId: 'demo', artifactDir: artifactsRoot, projectRoot: root });
    const runCommand = async (): Promise<ReleaseCommandResult> => {
      runnerCalled = true;
      return { code: 0, stdout: '', stderr: '' };
    };
    await assert.rejects(
      executeReleasePlan({ plan, runCommand, env: {}, platform: 'linux' }),
      (error: unknown) => {
        assert.ok(error instanceof PlatformError);
        assert.equal(error.code, 'IOS_REQUIRES_MACOS');
        assert.ok(typeof error.details?.jobId === 'string');
        return true;
      },
    );
    assert.equal(runnerCalled, false);
    const manifest = readOnlyManifest(artifactsRoot) as { status: string; artifact: unknown; signingState: string };
    assert.equal(manifest.status, 'skipped');
    assert.equal(manifest.artifact, null);
  });

  test('rejects a plan with no steps', async () => {
    const root = makeFlutterProject();
    const artifactsRoot = mktemp('ff-release-artifacts-');
    const plan = buildReleasePlan({ target: 'web', projectId: 'demo', artifactDir: artifactsRoot, projectRoot: root });
    await assert.rejects(
      executeReleasePlan({ plan: { ...plan, steps: [] }, env: {} }),
      (error: unknown) => error instanceof PlatformError && (error as PlatformError).code === 'RELEASE_PLAN_INVALID',
    );
  });

  test('defaultReleaseCommandRunner reports a spawn failure', async () => {
    await assert.rejects(
      defaultReleaseCommandRunner(['flutterforge-definitely-not-a-real-binary-xyz'], { timeoutMs: 1_000 }),
      (error: unknown) => error instanceof PlatformError && (error as PlatformError).code === 'RELEASE_SPAWN_FAILED',
    );
  });
});

/** Minimal ustar reader with header checksum verification; independent of the writer's assumptions. */
function parseTarArchive(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    assert.equal(readTarString(header, 257, 6).replace(/\0.*$/s, ''), 'ustar', 'ustar magic expected');
    const name = readTarString(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]);
    const prefix = readTarString(header, 345, 155);
    const storedChecksum = readOctal(header, 148, 8);
    let sum = 0;
    for (let index = 0; index < 512; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    assert.equal(sum, storedChecksum, `tar checksum mismatch for ${name}`);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + 512;
    if (typeflag === '0') {
      files.set(fullName, Buffer.from(buffer.subarray(dataStart, dataStart + size)));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
  const end = buffer.indexOf(0, offset);
  const stop = end === -1 || end > offset + length ? offset + length : end;
  return buffer.toString('utf8', offset, stop);
}

function readOctal(buffer: Buffer, offset: number, length: number): number {
  const raw = buffer.toString('utf8', offset, offset + length).replace(/[\0 ]/g, '').trim();
  return raw === '' ? 0 : Number.parseInt(raw, 8);
}
