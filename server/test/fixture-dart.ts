#!/usr/bin/env -S npx tsx
/**
 * Test double for the bundled Dart SDK analyzer.
 *
 * Emits a real machine-readable diagnostic for any Dart file containing the
 * marker `BROKEN_CODE`, so verification tests exercise the same JSON parsing
 * and gate logic as a real `dart analyze` run.
 *
 * Kept free of TypeScript-only syntax because the executable is copied to a
 * path without a `.ts` extension, where Node parses it as plain JavaScript.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('Dart SDK version: 9.9.9-fixture (stable)\n');
  process.exit(0);
}

if (args[0] !== 'analyze') {
  process.stderr.write(`fixture dart: unsupported args ${args.join(' ')}\n`);
  process.exit(1);
}

const root = process.cwd();
const diagnostics = [];

async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.dart_tool' || entry.name === 'build') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(absolute);
      continue;
    }
    if (!entry.name.endsWith('.dart')) continue;
    const content = await fs.readFile(absolute, 'utf8');
    if (!content.includes('BROKEN_CODE')) continue;
    const lines = content.split(/\r?\n/);
    const line = Math.max(1, lines.findIndex((value) => value.includes('BROKEN_CODE')) + 1);
    diagnostics.push({
      file: absolute,
      line,
      column: 1,
      severity: 'ERROR',
      code: 'fixture_error',
      problemMessage: 'Fixture analyzer error: BROKEN_CODE is not valid Dart',
    });
  }
}

await walk(path.join(root, 'lib')).catch(() => undefined);
process.stdout.write(`${JSON.stringify({ version: 1, diagnostics })}\n`);
process.exit(diagnostics.length > 0 ? 2 : 0);
