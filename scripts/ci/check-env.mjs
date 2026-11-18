#!/usr/bin/env node
/**
 * scripts/ci/check-env.mjs
 * ---------------------------------------------------------------------------
 * CI environment sanity gate for the FlutterForge monorepo.
 *
 * What it verifies (hard failures -> exit 1):
 *   1. Node.js >= 20 (repo engines baseline; CI runs Node 24 for node:sqlite)
 *   2. cwd package.json exists and declares the expected npm scripts with
 *      non-empty command values: typecheck, test, test:server, build, lint,
 *      check
 *   3. Dependencies were installed (run after `npm ci`): node_modules must
 *      contain react and typescript
 *
 * Soft warnings (reported, non-fatal):
 *   - dist/ missing (expected before `npm run build`; fine on fresh CI checkout)
 *   - git identity not configured (user.name / user.email)
 *   - FLUTTERFORGE_AUTH_MODE not set (CI sets it to `local`; local dev may not)
 *
 * Pure Node ESM, zero dependencies. Exports nothing; run as a script:
 *   node scripts/ci/check-env.mjs
 *
 * Exit codes: 0 = pass (warnings allowed), 1 = hard failure.
 * ---------------------------------------------------------------------------
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The script resolves paths from cwd intentionally — npm scripts and CI both
// run from the repo root.
const cwd = process.cwd();

const REQUIRED_SCRIPTS = ['typecheck', 'test', 'test:server', 'build', 'lint', 'check'];
const REQUIRED_PACKAGES = ['react', 'typescript'];

const results = []; // { level: 'pass' | 'fail' | 'warn', label: string, detail?: string }
const fail = (label, detail) => results.push({ level: 'fail', label, detail });
const pass = (label, detail) => results.push({ level: 'pass', label, detail });
const warn = (label, detail) => results.push({ level: 'warn', label, detail });

// --- 1. Node version ---------------------------------------------------------
const nodeVersion = process.versions.node;
const nodeMajor = Number.parseInt(nodeVersion.split('.')[0] ?? '0', 10);
if (Number.isFinite(nodeMajor) && nodeMajor >= 20) {
  pass(`node ${nodeVersion} >= 20`);
} else {
  fail(`node ${nodeVersion} < 20`, 'FlutterForge requires Node.js >= 20 (see README / engines).');
}

// --- 2. package.json scripts --------------------------------------------------
const pkgPath = join(cwd, 'package.json');
let pkg = null;
if (!existsSync(pkgPath)) {
  fail('package.json not found in cwd', `expected ${pkgPath} — run from the repo root`);
} else {
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pass('package.json found and parses as JSON');
  } catch (err) {
    fail('package.json is not valid JSON', err instanceof Error ? err.message : String(err));
  }
}

if (pkg) {
  const scripts = pkg.scripts ?? {};
  for (const name of REQUIRED_SCRIPTS) {
    const value = scripts[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      pass(`script "${name}" present`);
    } else {
      fail(`script "${name}" missing or empty`, 'expected a non-empty command in package.json#scripts');
    }
  }
} else {
  for (const name of REQUIRED_SCRIPTS) {
    fail(`script "${name}" not verified`, 'package.json unreadable');
  }
}

// --- 3. node_modules presence (post npm ci) -----------------------------------
const nmPath = join(cwd, 'node_modules');
if (!existsSync(nmPath)) {
  fail('node_modules missing', 'run `npm ci` before this check');
  for (const name of REQUIRED_PACKAGES) {
    fail(`package "${name}" not installed`, 'node_modules is absent');
  }
} else {
  pass('node_modules present');
  for (const name of REQUIRED_PACKAGES) {
    const manifest = join(nmPath, name, 'package.json');
    if (existsSync(manifest)) {
      let version = 'unknown';
      try {
        version = JSON.parse(readFileSync(manifest, 'utf8')).version ?? 'unknown';
      } catch {
        /* keep 'unknown' — presence is what matters */
      }
      pass(`package "${name}" installed (${version})`);
    } else {
      fail(`package "${name}" missing from node_modules`, `expected ${manifest}`);
    }
  }
}

// --- Soft warnings (non-fatal) -------------------------------------------------
if (!existsSync(join(cwd, 'dist'))) {
  warn('dist/ missing', 'expected on a fresh checkout — produced by `npm run build`');
} else {
  pass('dist/ present');
}

try {
  const name = execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const email = execFileSync('git', ['config', 'user.email'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (name && email) {
    pass(`git identity configured (${name} <${email}>)`);
  } else {
    warn('git identity not configured', 'git user.name / user.email unset — commits will fail');
  }
} catch {
  warn('git identity not configured', 'git unavailable or user.name/user.email unset');
}

if (process.env.FLUTTERFORGE_AUTH_MODE && process.env.FLUTTERFORGE_AUTH_MODE.trim().length > 0) {
  pass(`FLUTTERFORGE_AUTH_MODE=${process.env.FLUTTERFORGE_AUTH_MODE}`);
} else {
  warn('FLUTTERFORGE_AUTH_MODE unset', 'CI sets it to "local"; local dev may leave it unset');
}

// --- Report --------------------------------------------------------------------
const failures = results.filter((r) => r.level === 'fail');
const warnings = results.filter((r) => r.level === 'warn');
const passes = results.filter((r) => r.level === 'pass');

console.log('FlutterForge CI — environment check');
console.log(`cwd: ${cwd}`);
console.log('');
for (const r of results) {
  const mark = r.level === 'pass' ? '✓' : r.level === 'warn' ? '!' : '✗';
  const detail = r.detail ? ` — ${r.detail}` : '';
  console.log(`  ${mark} ${r.label}${detail}`);
}
console.log('');
console.log(`summary: ${passes.length} passed, ${warnings.length} warning(s), ${failures.length} failure(s)`);

if (failures.length > 0) {
  console.error('check-env: FAIL');
  process.exit(1);
}
console.log('check-env: PASS');
process.exit(0);
