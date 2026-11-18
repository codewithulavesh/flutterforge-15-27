/**
 * Sandbox layer tests. No Docker required: Docker behavior is verified through
 * the injected exec hook, which captures the argv that would be executed.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  evaluateCommand,
  assertAllowed,
  buildUlimitWrapper,
  DEFAULT_LIMITS,
  MAX_TIMEOUT_MS,
  LocalSandboxRunner,
  DockerSandboxRunner,
  SandboxError,
  createSandboxRunner,
  type SandboxCommand,
  type SandboxResult,
  type DockerExecHook,
  type DockerSandboxRunnerOptions,
} from '../../platform/sandbox/index.js';

let workspaceRoot: string;

before(() => {
  workspaceRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flutterforge-sandbox-test-')));
});

after(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

const evalCmd = (cmd: SandboxCommand, root = workspaceRoot) => evaluateCommand(cmd, { workspaceRoot: root });

describe('policy: allowlist', () => {
  test('allows flutter analyze', () => {
    const d = evalCmd({ argv: ['flutter', 'analyze'] });
    assert.equal(d.allowed, true, d.reason);
    assert.deepEqual(d.argv, ['flutter', 'analyze']);
  });

  test('allows flutter pub get / pub outdated / test / build / doctor / --version', () => {
    for (const argv of [
      ['flutter', 'pub', 'get'],
      ['flutter', 'pub', 'outdated'],
      ['flutter', 'test'],
      ['flutter', 'build', 'apk'],
      ['flutter', 'doctor'],
      ['flutter', '--version'],
      ['flutter', 'analyze', '--fatal-infos'],
    ]) {
      assert.equal(evalCmd({ argv }).allowed, true, argv.join(' '));
    }
    assert.equal(evalCmd({ argv: ['flutter', 'pub', 'add', 'http'] }).allowed, false);
    assert.equal(evalCmd({ argv: ['flutter', 'pub'] }).allowed, false);
    assert.equal(evalCmd({ argv: ['flutter', 'run'] }).allowed, false);
  });

  test('allows git status and other read-only git verbs', () => {
    for (const argv of [
      ['git', 'status'],
      ['git', 'diff'],
      ['git', 'log', '--oneline'],
      ['git', 'show', 'HEAD'],
      ['git', 'branch', '--show-current'],
      ['git', 'rev-parse', 'HEAD'],
      ['git', 'ls-files'],
      ['git', 'add', '.'],
      ['git', 'commit', '-m', 'msg'],
      ['git', 'stash'],
      ['git', 'checkout', 'main'],
    ]) {
      assert.equal(evalCmd({ argv }).allowed, true, argv.join(' '));
    }
  });

  test('denies git push and other write verbs', () => {
    for (const argv of [
      ['git', 'push'],
      ['git', 'push', '--force'],
      ['git', 'clone', 'https://example.com/repo.git'],
      ['git', 'remote', 'add', 'origin', 'x'],
      ['git', 'reset', '--hard'],
    ]) {
      assert.equal(evalCmd({ argv }).allowed, false, argv.join(' '));
    }
  });

  test('denies rm entirely — even rm -rf /', () => {
    const d = evalCmd({ argv: ['rm', '-rf', '/'] });
    assert.equal(d.allowed, false);
    assert.match(d.reason ?? '', /rm/i);
  });

  test('denies non-allowlisted executables', () => {
    for (const argv of [
      ['curl', 'https://example.com'],
      ['sh', '-c', 'id'],
      ['bash', '-i'],
      ['python3', '-c', 'print(1)'],
      ['/bin/rm', '-rf', '/'],
    ]) {
      assert.equal(evalCmd({ argv }).allowed, false, argv.join(' '));
    }
  });

  test('npm and npx are restricted to --version/--help', () => {
    assert.equal(evalCmd({ argv: ['npm', '--version'] }).allowed, true);
    assert.equal(evalCmd({ argv: ['npm', '--help'] }).allowed, true);
    assert.equal(evalCmd({ argv: ['npx', '--version'] }).allowed, true);
    assert.equal(evalCmd({ argv: ['npm', 'install'] }).allowed, false);
    assert.equal(evalCmd({ argv: ['npm', 'test'] }).allowed, false);
    assert.equal(evalCmd({ argv: ['npx', 'tsc', '--noEmit'] }).allowed, false);
  });

  test('node allows --version/--help and safe -e scripts', () => {
    assert.equal(evalCmd({ argv: ['node', '--version'] }).allowed, true);
    assert.equal(evalCmd({ argv: ['node', '--help'] }).allowed, true);
    assert.equal(evalCmd({ argv: ['node', '-e', 'console.log(1+1)'] }).allowed, true);
    assert.equal(evalCmd({ argv: ['node', 'script.js'] }).allowed, false);
  });

  test('node -e denies child_process/process.binding/fs.writeFile/net/eval', () => {
    const denied = [
      ['node', '-e', "require('child_process').exec('id')"],
      ['node', '-e', 'require("child_process").execSync("id")'],
      ['node', '-e', 'process.binding("fs")'],
      ['node', '-e', "require('fs').writeFileSync('/tmp/x', '1')"],
      ['node', '-e', "require('fs').writeFile('/tmp/x', '1', () => {})"],
      ['node', '-e', "require('net').createServer(() => {})"],
      ['node', '-e', 'net.connect(80, "example.com")'],
      ['node', '-e', 'eval("2+2")'],
    ];
    for (const argv of denied) {
      assert.equal(evalCmd({ argv }).allowed, false, argv.join(' '));
    }
  });

  test('assertAllowed throws SandboxError with POLICY_DENIED on denial', () => {
    assert.throws(
      () => assertAllowed({ argv: ['git', 'push'] }, { workspaceRoot }),
      (error: unknown) => error instanceof SandboxError && (error as SandboxError).code === 'POLICY_DENIED',
    );
  });
});

describe('policy: argv shape limits', () => {
  test('rejects argv containing NUL', () => {
    assert.equal(evalCmd({ argv: ['echo', 'a\0b'] }).allowed, false);
  });

  test('rejects argv longer than 4096 chars total', () => {
    assert.equal(evalCmd({ argv: ['echo', 'x'.repeat(5000)] }).allowed, false);
  });

  test('rejects more than 256 arguments', () => {
    assert.equal(evalCmd({ argv: ['echo', ...Array.from({ length: 256 }, () => 'a')] }).allowed, false);
    assert.equal(evalCmd({ argv: ['echo', ...Array.from({ length: 255 }, () => 'a')] }).allowed, true);
  });

  test('rejects timeout above 30 minutes', () => {
    assert.equal(evalCmd({ argv: ['echo', 'hi'], timeoutMs: MAX_TIMEOUT_MS + 1 }).allowed, false);
    assert.equal(evalCmd({ argv: ['echo', 'hi'], timeoutMs: MAX_TIMEOUT_MS }).allowed, true);
  });

  test('rejects empty argv', () => {
    assert.equal(evalCmd({ argv: [] }).allowed, false);
  });
});

describe('policy: cwd containment', () => {
  test('rejects cwd with .. escape', () => {
    const d = evalCmd({ argv: ['ls'], cwd: path.join(workspaceRoot, '..', '..', 'etc') });
    assert.equal(d.allowed, false);
    assert.match(d.reason ?? '', /outside|escape/i);
  });

  test('rejects absolute cwd outside workspaceRoot', () => {
    const d = evalCmd({ argv: ['ls'], cwd: '/' });
    assert.equal(d.allowed, false);
    assert.match(d.reason ?? '', /outside|escape/i);
  });

  test('accepts cwd inside workspaceRoot', () => {
    const d = evalCmd({ argv: ['pwd'], cwd: '.' });
    assert.equal(d.allowed, true, d.reason);
    assert.equal(d.cwd, workspaceRoot);
  });
});

describe('policy: environment filtering', () => {
  test('strips secret-shaped vars even when otherwise allowlisted', () => {
    const d = evalCmd({
      argv: ['env'],
      env: {
        CI: 'true',
        HOME: process.env.HOME ?? '/tmp',
        PUB_CACHE: '/custom/pub-cache',
        FLUTTER_STORAGE_BASE_URL: 'https://storage.example.com',
        MY_SECRET_TOKEN: 'leak-me',
        AWS_ACCESS_KEY_ID: 'leak-me',
        FLUTTER_APP_PASSWORD: 'leak-me',
        RANDOM_THING: 'leak-me',
        LC_ALL: 'C',
      },
    });
    // `env` is not allowlisted as an executable, so inspect via a decision built on an allowlisted tool.
    assert.equal(d.allowed, false);

    const d2 = evalCmd({
      argv: ['echo', 'ok'],
      env: {
        CI: 'true',
        PUB_CACHE: '/custom/pub-cache',
        MY_SECRET_TOKEN: 'leak-me',
        AWS_ACCESS_KEY_ID: 'leak-me',
        FLUTTER_APP_PASSWORD: 'leak-me',
        RANDOM_THING: 'leak-me',
        LC_ALL: 'C',
      },
    });
    assert.equal(d2.allowed, true, d2.reason);
    assert.equal(d2.env.CI, 'true');
    assert.equal(d2.env.PUB_CACHE, '/custom/pub-cache');
    assert.equal(d2.env.LC_ALL, 'C');
    for (const key of Object.keys(d2.env)) {
      assert.doesNotMatch(key, /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i);
    }
    assert.equal(d2.env.RANDOM_THING, undefined);
    assert.equal(d2.env.MY_SECRET_TOKEN, undefined);
  });

  test('strips any secret-shaped name even if injected through the allowlist pattern', () => {
    const d = evalCmd({ argv: ['echo', 'ok'], env: { CI: 'true', CI_TOKEN: 'leak-me' } });
    assert.equal(d.allowed, true);
    assert.equal(d.env.CI_TOKEN, undefined);
  });
});

describe('buildUlimitWrapper', () => {
  test('wraps argv in sh -c with exec "$@" on POSIX', () => {
    if (process.platform === 'win32') return;
    const wrapper = buildUlimitWrapper(['node', '--version'], DEFAULT_LIMITS);
    assert.ok(wrapper);
    assert.equal(wrapper.windows, false);
    assert.equal(wrapper.argv[0], 'sh');
    assert.equal(wrapper.argv[1], '-c');
    assert.match(wrapper.argv[2], /exec "\$@"/);
    assert.deepEqual(wrapper.argv.slice(3), ['flutterforge-sandbox', 'node', '--version']);
  });
});

describe('LocalSandboxRunner', () => {
  test('captures stdout and exitCode for node --version', { timeout: 15000 }, async () => {
    const runner = new LocalSandboxRunner({ workspaceRoot });
    const result = await runner.run({ argv: ['node', '--version'] });
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.killed, false);
    assert.match(result.stdout.trim(), /^v\d+\./);
    assert.equal(result.stdout.trim(), process.version);
    assert.ok(result.durationMs >= 0);
    assert.deepEqual(result.command, ['node', '--version']);
    await runner.dispose();
  });

  test('writes stdin to the child and reads it back', { timeout: 15000 }, async () => {
    const runner = new LocalSandboxRunner({ workspaceRoot });
    const result = await runner.run({
      argv: ['node', '-e', 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(d.toUpperCase()))'],
      stdin: 'ping',
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'PING');
    await runner.dispose();
  });

  test('timeout kills the child: timedOut=true signal=SIGTERM', { timeout: 15000 }, async () => {
    const runner = new LocalSandboxRunner({ workspaceRoot });
    const started = Date.now();
    const result = await runner.run({ argv: ['node', '-e', 'setTimeout(()=>{},10000)'], timeoutMs: 300 });
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.equal(result.killed, true);
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, 'SIGTERM');
    assert.ok(elapsed < 10_000, `took ${elapsed}ms`);
    await runner.dispose();
  });

  test('truncates stdout beyond the cap and keeps draining', { timeout: 15000 }, async () => {
    const runner = new LocalSandboxRunner({ workspaceRoot, maxOutputBytes: 1024 });
    const result = await runner.run({ argv: ['node', '-e', "process.stdout.write('x'.repeat(1024*1024))"] });
    assert.equal(result.truncated, true);
    assert.ok(result.stdout.length <= 1024, `stdout length ${result.stdout.length}`);
    assert.equal(result.stdout.length, 1024);
    assert.equal(result.exitCode, 0);
    await runner.dispose();
  });

  test('truncation cap is per-stream (stderr independent of stdout)', { timeout: 15000 }, async () => {
    const runner = new LocalSandboxRunner({ workspaceRoot, maxOutputBytes: 64 });
    const result = await runner.run({
      argv: ['node', '-e', "process.stdout.write('o'.repeat(1000));process.stderr.write('e'.repeat(1000))"],
    });
    assert.equal(result.truncated, true);
    assert.equal(result.stdout.length, 64);
    assert.equal(result.stderr.length, 64);
    await runner.dispose();
  });

  test('maxConcurrent=1 serializes concurrent runs FIFO', { timeout: 20000 }, async () => {
    const runner = new LocalSandboxRunner({ workspaceRoot, maxConcurrent: 1 });
    const started = Date.now();
    const [a, b] = await Promise.all([
      runner.run({ argv: ['node', '-e', 'setTimeout(()=>{},400)'] }),
      runner.run({ argv: ['node', '-e', 'setTimeout(()=>{},400)'] }),
    ]);
    const elapsed = Date.now() - started;
    assert.equal(a.exitCode, 0);
    assert.equal(b.exitCode, 0);
    assert.ok(elapsed >= 750, `expected serialization (>=750ms), got ${elapsed}ms`);
    await runner.dispose();
  });

  test('abort while queued releases the slot without running', { timeout: 15000 }, async () => {
    const runner = new LocalSandboxRunner({ workspaceRoot, maxConcurrent: 1 });
    const controller = new AbortController();

    const first = runner.run({ argv: ['node', '-e', 'setTimeout(()=>{},500)'] });
    // Give the first run a beat to occupy the slot.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(runner.slots, 1);

    const queued = runner.run({ argv: ['node', '--version'] }, { signal: controller.signal });
    controller.abort();
    const [firstResult, queuedResult] = await Promise.all([first, queued]);
    assert.equal(firstResult.exitCode, 0);
    assert.equal(queuedResult.killed, true);
    assert.equal(queuedResult.exitCode, null);
    await runner.dispose();
  });

  test('abort during run terminates the child process group', { timeout: 15000 }, async () => {
    const runner = new LocalSandboxRunner({ workspaceRoot });
    const controller = new AbortController();
    const promise = runner.run({ argv: ['node', '-e', 'setTimeout(()=>{},10000)'] }, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    const result = await promise;
    assert.equal(result.killed, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, 'SIGTERM');
    await runner.dispose();
  });

  test('run() throws SandboxError (not a crash) for policy denial', async () => {
    const runner = new LocalSandboxRunner({ workspaceRoot });
    await assert.rejects(
      () => runner.run({ argv: ['git', 'push'] }),
      (error: unknown) => error instanceof SandboxError && error.code === 'POLICY_DENIED',
    );
    await runner.dispose();
  });

  test('process-level failure is returned, not thrown', { timeout: 15000 }, async () => {
    const runner = new LocalSandboxRunner({ workspaceRoot });
    // The policy tolerates a not-yet-created cwd inside the workspace, so spawn fails with ENOENT.
    const result = await runner.run({ argv: ['node', '--version'], cwd: path.join(workspaceRoot, 'missing-dir-xyz') });
    assert.equal(result.exitCode, null);
    assert.match(result.stderr, /failed to spawn/i);
    await runner.dispose();
  });
});

describe('DockerSandboxRunner (argv construction via injected exec hook)', () => {
  function makeRunner(exec: (argv: string[]) => Promise<SandboxResult>, extra: Partial<DockerSandboxRunnerOptions> = {}) {
    return new DockerSandboxRunner({
      workspaceRoot,
      image: 'flutterforge/sandbox:test',
      limits: { cpuCores: 2, memoryMb: 512, pidsLimit: 256 },
      exec: exec as DockerExecHook,
      ...extra,
    });
  }

  const okResult: SandboxResult = {
    exitCode: 0,
    signal: null,
    stdout: 'hook-ran',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    killed: false,
    truncated: false,
    command: [],
  };

  test('docker run argv contains every hardening flag', async () => {
    let captured: string[] = [];
    const runner = makeRunner(async (argv) => {
      captured = argv;
      return okResult;
    });
    const result = await runner.run({ argv: ['node', '--version'] });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'hook-ran');

    const rootReal = realpathSync(workspaceRoot);
    for (const flag of [
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--user=1000:1000',
      '--memory=512m',
      '--cpus=2',
      '--pids-limit=256',
      '--rm',
    ]) {
      assert.ok(captured.includes(flag), `missing ${flag} in: ${captured.join(' ')}`);
    }
    const tmpfsIndex = captured.indexOf('--tmpfs');
    assert.ok(tmpfsIndex >= 0 && captured[tmpfsIndex + 1] === '/tmp:rw,noexec,nosuid,size=256m');

    const volumeFlag = captured.indexOf('-v');
    assert.ok(volumeFlag >= 0);
    assert.equal(captured[volumeFlag + 1], `${rootReal}:/workspace:rw`);

    const workdirFlag = captured.indexOf('-w');
    assert.equal(captured[workdirFlag + 1], '/workspace');

    // No shell: image and command travel as discrete argv entries at the tail.
    const imageIndex = captured.indexOf('flutterforge/sandbox:test');
    assert.ok(imageIndex > 0);
    assert.deepEqual(captured.slice(imageIndex + 1), ['node', '--version']);

    // Audit command on the result is the full docker argv.
    assert.deepEqual(result.command, captured);
    await runner.dispose();
  });

  test('--runtime=runsc is appended when configured', async () => {
    let captured: string[] = [];
    const runner = makeRunner(async (argv) => {
      captured = argv;
      return okResult;
    }, { runtime: 'runsc' });
    await runner.run({ argv: ['echo', 'hi'] });
    assert.ok(captured.includes('--runtime=runsc'));
    await runner.dispose();
  });

  test('mount=ro flips the workspace bind to read-only', async () => {
    let captured: string[] = [];
    const runner = makeRunner(async (argv) => {
      captured = argv;
      return okResult;
    }, { mount: 'ro' });
    await runner.run({ argv: ['echo', 'hi'] });
    const volumeFlag = captured.indexOf('-v');
    assert.ok(captured[volumeFlag + 1].endsWith(':/workspace:ro'));
    await runner.dispose();
  });

  test('network=bridge is honored when explicitly configured', async () => {
    let captured: string[] = [];
    const runner = makeRunner(async (argv) => {
      captured = argv;
      return okResult;
    }, { network: 'bridge' });
    await runner.run({ argv: ['echo', 'hi'] });
    assert.ok(captured.includes('--network=bridge'));
    assert.ok(!captured.includes('--network=none'));
    await runner.dispose();
  });

  test('policy is still enforced before the hook runs', async () => {
    let hookCalled = false;
    const runner = makeRunner(async () => {
      hookCalled = true;
      return okResult;
    });
    await assert.rejects(
      () => runner.run({ argv: ['rm', '-rf', '/'] }),
      (error: unknown) => error instanceof SandboxError && error.code === 'POLICY_DENIED',
    );
    assert.equal(hookCalled, false);
    await runner.dispose();
  });

  test('constructor rejects a workspace root containing a comma', () => {
    const commaRoot = path.join(workspaceRoot, 'with,comma');
    mkdirSync(commaRoot, { recursive: true });
    assert.throws(
      () => new DockerSandboxRunner({ workspaceRoot: commaRoot, image: 'img' }),
      (error: unknown) => error instanceof SandboxError && error.code === 'UNAVAILABLE',
    );
  });

  test('constructor rejects missing workspace directory', () => {
    assert.throws(
      () => new DockerSandboxRunner({ workspaceRoot: path.join(workspaceRoot, 'does-not-exist-xyz'), image: 'img' }),
      (error: unknown) => error instanceof SandboxError && error.code === 'UNAVAILABLE',
    );
  });

  test('constructor rejects relative workspace root', () => {
    assert.throws(
      () => new DockerSandboxRunner({ workspaceRoot: 'relative/path', image: 'img' }),
      (error: unknown) => error instanceof SandboxError && error.code === 'UNAVAILABLE',
    );
  });

  test('isAvailable resolves a boolean and caches for 30s', async () => {
    const runner = makeRunner(async () => okResult);
    const first = await runner.isAvailable();
    assert.equal(typeof first, 'boolean');
    const second = await runner.isAvailable();
    assert.equal(second, first);
    await runner.dispose();
  });
});

describe('createSandboxRunner factory', () => {
  test('mode=local returns a working local runner and matching describe', { timeout: 15000 }, async () => {
    const created = await createSandboxRunner({ mode: 'local', workspaceRoot });
    assert.equal(created.describe.mode, 'local');
    assert.equal(created.describe.requestedMode, 'local');
    assert.equal(created.describe.workspaceRoot, workspaceRoot);
    const result = await created.runner.run({ argv: ['echo', 'factory-ok'] });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /factory-ok/);
    await created.runner.dispose?.();
  });

  test('mode=docker falls back to local with a warning when docker is unavailable', async () => {
    const created = await createSandboxRunner({ mode: 'docker', workspaceRoot });
    if (created.describe.mode === 'local') {
      assert.match(created.describe.warning ?? '', /docker/i);
    } else {
      assert.equal(created.describe.mode, 'docker');
      assert.ok(created.describe.image);
    }
    await created.runner.dispose?.();
  });

  test('mode=auto returns a usable runner regardless of docker presence', { timeout: 15000 }, async () => {
    const created = await createSandboxRunner({ mode: 'auto', workspaceRoot });
    assert.ok(created.describe.mode === 'local' || created.describe.mode === 'docker');
    if (created.describe.mode === 'local') {
      const result = await created.runner.run({ argv: ['echo', 'auto-ok'] });
      assert.equal(result.exitCode, 0);
    }
    await created.runner.dispose?.();
  });
});

test('workspace root fixture exists', () => {
  assert.equal(existsSync(workspaceRoot), true);
});
