/**
 * Generation smoke harness (developer tool).
 *
 *   node --import tsx/esm scripts/generation-emit.ts "Build a notes app" /tmp/ff-app
 *   node --import tsx/esm scripts/generation-emit.ts "..." /tmp/ff-app --analyze
 *
 * Compiles a prompt, emits the full project, writes it to a directory and
 * prints structural problems. `--analyze` runs `flutter pub get` + `dart
 * analyze` in that directory — the same gate the platform uses, without
 * needing a running server.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { compileSpec } from '../server/platform/generation/spec/index.js';
import { emitAndCheck } from '../server/platform/generation/emit/index.js';
import { scoreProject } from '../server/platform/generation/quality/index.js';
import { aggregateGates, structuralGate, budgetGate, testGate, qualityGate } from '../server/platform/generation/gate/index.js';

async function main(): Promise<void> {
  const [, , promptArg, outArg, ...flags] = process.argv;
  const prompt = promptArg || 'Build a notes app with tags, search and pinning';
  const outDir = path.resolve(outArg || '/tmp/flutterforge-generated');
  const analyze = flags.includes('--analyze');

  const spec = compileSpec({ prompt });
  const { files, problems } = emitAndCheck(spec);
  const quality = scoreProject(spec, files);
  const gates = aggregateGates([
    structuralGate({ spec, files, quality }),
    budgetGate({ spec, files }),
    testGate({ spec, files }),
    qualityGate(quality, 80),
  ]);

  await fs.rm(outDir, { recursive: true, force: true });
  for (const file of files) {
    const target = path.join(outDir, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, 'utf8');
  }

  process.stdout.write(`prompt: ${prompt}\n`);
  process.stdout.write(`app: ${spec.app.name} (${spec.app.packageName}) · ${spec.entities.length} entities · ${spec.screens.length} screens\n`);
  process.stdout.write(`files: ${files.length} · bytes: ${files.reduce((n, f) => n + Buffer.byteLength(f.content), 0)}\n`);
  process.stdout.write(`quality: ${quality.total} (${quality.grade}) ${JSON.stringify(quality.categories)}\n`);
  process.stdout.write(`gates: ${gates.passed ? 'PASS' : 'FAIL'}\n`);
  for (const gate of gates.gates) {
    process.stdout.write(`  ${gate.passed ? '✓' : '✗'} ${gate.gate}${gate.blockers.length ? ` — ${gate.blockers.slice(0, 3).join(' | ')}` : ''}\n`);
  }
  if (problems.length > 0) {
    process.stdout.write(`structural problems:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  }
  if (quality.findings.length > 0) {
    process.stdout.write(`top findings:\n${quality.findings.slice(0, 8).map((f) => `  - [${f.severity}] ${f.code}: ${f.message}${f.path ? ` (${f.path})` : ''}`).join('\n')}\n`);
  }
  process.stdout.write(`written: ${outDir}\n`);

  if (analyze) {
    const pub = await run('flutter', ['pub', 'get'], outDir);
    if (pub !== 0) {
      process.stdout.write('flutter pub get failed\n');
      process.exitCode = 1;
      return;
    }
    const code = await run('dart', ['analyze'], outDir);
    process.stdout.write(`dart analyze: ${code === 0 ? 'clean' : `failed (${code})`}\n`);
    process.exitCode = code;
  }
}

function run(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
