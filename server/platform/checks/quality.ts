/**
 * Quality agents — tests, the deterministic QA gate, security and performance.
 *
 * These are the agents allowed to say “no”. A blocker from any of them fails
 * the board and, when the `review.board` workflow is used, the run.
 */
import type { CheckDefinition, CheckFinding } from './types.js';
import { validateDartFiles } from '../dart/validate.js';
import {
  callBlocks,
  capFindings,
  countMatches,
  finding,
  libFiles,
  redactSecrets,
  stripDart,
  testFiles,
  truncate,
} from './shared.js';

const SECRET_PATTERNS: Array<{ code: string; label: string; pattern: RegExp }> = [
  { code: 'openrouter-key', label: 'OpenRouter/OpenAI key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { code: 'stripe-key', label: 'Stripe secret key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/ },
  { code: 'google-key', label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { code: 'jwt', label: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/ },
  { code: 'private-key', label: 'Private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { code: 'supabase-service', label: 'Supabase service-role key', pattern: /\b(?:SUPABASE_SERVICE_ROLE_KEY|service_role)\s*[:=]\s*['"][A-Za-z0-9._-]{20,}/i },
  { code: 'hardcoded-password', label: 'Hard-coded password', pattern: /\b(?:password|passwd|secret)\s*[:=]\s*['"][^'"]{6,}['"]/i },
];

export const testEngineerAgent: CheckDefinition = {
  id: 'test-engineer',
  name: 'Hana',
  title: 'Test Engineer',
  department: 'quality',
  description: 'Checks that models, controllers and screens have real tests — not placeholder files that assert nothing.',
  capabilities: ['unit-tests', 'widget-tests', 'assertion-quality', 'coverage-seams'],
  mode: 'deterministic',
  run(context) {
    const findings: CheckFinding[] = [];
    const tests = testFiles(context);
    if (tests.length === 0) {
      return [finding('TEST_NONE', 'blocker', 'The project has no tests at all.', {
        suggestion: 'Emit at least one widget smoke test and one model/controller unit test.',
      })];
    }

    const testCorpus = tests.map((file) => file.content).join('\n');
    if (!/\btestWidgets\s*\(/.test(testCorpus)) {
      findings.push(finding('TEST_NO_WIDGET_TEST', 'major', 'No widget test exists, so the app is never pumped end-to-end.', {
        file: tests[0].path,
        suggestion: 'Add a smoke test that pumps the root widget and asserts MaterialApp is present.',
      }));
    }
    if (!/\bexpect\s*\(/.test(testCorpus)) {
      findings.push(finding('TEST_NO_ASSERTIONS', 'blocker', 'Tests contain no expect() assertions — they cannot fail.', {
        file: tests[0].path,
      }));
    }

    const emptyTests = tests.filter((file) => /\b(?:test|testWidgets)\s*\(/.test(file.content) && !/\bexpect\s*\(/.test(file.content));
    for (const file of emptyTests.slice(0, 3)) {
      findings.push(finding('TEST_EMPTY_CASE', 'minor', 'Test file declares cases but never asserts anything.', { file: file.path }));
    }

    const modelFiles = libFiles(context).filter((file) => /\/data\/models\//.test(file.path));
    const testNames = new Set(tests.map((file) => file.path));
    for (const model of modelFiles) {
      const stem = model.path.split('/').pop()?.replace(/\.dart$/, '') ?? '';
      if (!stem) continue;
      const covered = [...testNames].some((path) => path.includes(`/${stem}_test.dart`) || path.includes(`/${stem}.test.dart`));
      if (!covered) {
        findings.push(finding('TEST_MODEL_UNCOVERED', 'major', `Model ${stem}.dart has no unit test.`, {
          file: model.path,
          suggestion: `Add test/data/${stem}_test.dart covering fromJson/toJson/copyWith round-trips.`,
        }));
      }
    }

    const controllerFiles = libFiles(context).filter((file) => /controller\.dart$/.test(file.path));
    const controllerTests = tests.filter((file) => /controller.*_test\.dart$/.test(file.path));
    if (controllerFiles.length > 0 && controllerTests.length === 0) {
      findings.push(finding('TEST_CONTROLLER_UNCOVERED', 'major', `${controllerFiles.length} controller(s) have no test.`, {
        file: controllerFiles[0].path,
        suggestion: 'Test loading → success → error transitions against a fake repository.',
      }));
    }

    return capFindings(findings);
  },
};

export const qaTesterAgent: CheckDefinition = {
  id: 'qa-tester',
  name: 'Victor',
  title: 'QA Tester',
  department: 'quality',
  description: 'Runs the deterministic structural gate over the real file set: entrypoint, pubspec, import resolution and delimiter integrity.',
  capabilities: ['structural-gate', 'entrypoint', 'contract-proof'],
  mode: 'deterministic',
  run(context) {
    const findings: CheckFinding[] = [];
    const packageName = context.packageName ?? '';
    if (!packageName) {
      findings.push(finding('QA_NO_PACKAGE_NAME', 'blocker', 'Cannot verify the project without a pubspec package name.'));
      return findings;
    }

    const result = validateDartFiles({
      files: context.files.map((file) => ({ path: file.path, content: file.content })),
      packageName,
      entrypoint: 'lib/main.dart',
    });
    if (!result.passed) {
      // Multiple `main` entrypoints are legal Dart (each library owns one), so
      // the generator-oriented duplicate check must not fail a project merely
      // because its test suites each declare `void main()`.
      const blockers = result.blockers.filter(
        (blocker) =>
          !(String(blocker.code ?? '') === 'DUPLICATE_DECLARATION' && /'main'/.test(String(blocker.message ?? ''))),
      );
      for (const blocker of blockers.slice(0, 4)) {
        findings.push(finding('QA_STRUCTURAL_BLOCKER', 'blocker', truncate(String(blocker.message ?? blocker.code ?? 'Structural gate failed.'), 220), {
          file: blocker.path ?? undefined,
          line: blocker.line ?? undefined,
        }));
      }
    }

    const main = context.files.find((file) => file.path === 'lib/main.dart');
    if (!main) {
      findings.push(finding('QA_NO_ENTRYPOINT', 'blocker', 'lib/main.dart is missing.', { file: 'lib/main.dart' }));
    } else {
      const code = stripDart(main.content);
      if (!/\brunApp\s*\(/.test(code)) {
        findings.push(finding('QA_NO_RUN_APP', 'blocker', 'lib/main.dart never calls runApp().', { file: 'lib/main.dart' }));
      }
    }

    const hasMaterialApp = libFiles(context).some((file) => /\bMaterialApp(?:\.router)?\s*\(/.test(stripDart(file.content)));
    if (!hasMaterialApp) {
      findings.push(finding('QA_NO_MATERIAL_APP', 'major', 'No MaterialApp/CupertinoApp root was found.', {
        suggestion: 'Wrap the app in a MaterialApp (or MaterialApp.router) so theme, routing and localization apply.',
      }));
    }

    if (result.warnings.length > 0) {
      findings.push(finding('QA_STRUCTURAL_WARNINGS', 'info', `${result.warnings.length} structural warning(s) from the deterministic gate.`));
    }

    return capFindings(findings);
  },
};

export const securityAuditorAgent: CheckDefinition = {
  id: 'security-auditor',
  name: 'Kai',
  title: 'Security Auditor',
  department: 'quality',
  description: 'Scans for committed credentials, insecure transport, TLS bypasses, SQL injection and unsafe secret storage.',
  capabilities: ['secrets', 'tls', 'injection', 'secure-storage'],
  mode: 'deterministic',
  run(context) {
    const findings: CheckFinding[] = [];

    let secretHits = 0;
    let secretFile: string | null = null;
    for (const file of context.files) {
      for (const secret of SECRET_PATTERNS) {
        const match = secret.pattern.exec(file.content);
        if (!match) continue;
        secretHits += 1;
        secretFile ??= file.path;
        findings.push(finding('SEC_HARDCODED_SECRET', 'blocker', `${secret.label} appears to be committed in source.`, {
          file: file.path,
          line: (() => {
            const before = file.content.slice(0, match.index);
            return before.split(/\r?\n/).length;
          })(),
          evidence: redactSecrets(truncate(match[0], 48)),
          suggestion: 'Revoke the credential, move it to the vault/env, and rotate it before shipping.',
        }));
        if (secretHits >= 4) break;
      }
      if (secretHits >= 4) break;
    }

    for (const file of context.files) {
      if (/^\.env(\.[^/]+)?$/.test(file.path) && !/\.example$/.test(file.path) && /\S+=\S+/.test(file.content)) {
        findings.push(finding('SEC_ENV_IN_PROJECT', 'blocker', 'A real .env file is part of the project snapshot.', {
          file: file.path,
          suggestion: 'Keep secrets out of the project tree; ship .env.example only.',
        }));
        break;
      }
    }

    for (const file of libFiles(context)) {
      const code = stripDart(file.content);
      if (/\bhttp:\/\//i.test(file.content) && !/localhost|127\.0\.0\.1/.test(file.content)) {
        findings.push(finding('SEC_INSECURE_TRANSPORT', 'major', 'A plaintext http:// endpoint is called.', {
          file: file.path,
          suggestion: 'Use https:// everywhere outside local development.',
        }));
      }
      if (/\bbadCertificateCallback\b|\bHttpOverrides\b|\bsetTrustedCertificates\s*\(/.test(code)) {
        findings.push(finding('SEC_TLS_BYPASS', 'blocker', 'TLS verification is bypassed or overridden.', {
          file: file.path,
          suggestion: 'Remove the override; pin certificates instead if you need extra assurance.',
        }));
      }
      if (/\b(?:query|rawQuery|execute|raw)\s*\(\s*['"][^'"]*\$\{?/.test(code) || /\b(?:query|execute)\s*\(\s*['"][^'"]*['"]\s*\+/.test(code)) {
        findings.push(finding('SEC_SQL_INJECTION', 'blocker', 'SQL is built by interpolation/concatenation.', {
          file: file.path,
          suggestion: 'Use parameterized queries or the Supabase query builder.',
        }));
      }
      if (/\bsetString\s*\(\s*['"][^'"]*(?:token|password|secret|api[_-]?key)/i.test(code)) {
        findings.push(finding('SEC_PLAINTEXT_TOKEN_STORAGE', 'major', 'A token/password is written to preferences in plaintext.', {
          file: file.path,
          suggestion: 'Use flutter_secure_storage (Keychain/Keystore) for credentials.',
        }));
      }
      const webviews = callBlocks(code, 'WebView');
      for (const block of webviews) {
        if (/javascriptMode\s*:\s*JavascriptMode\.unrestricted/.test(block.body) && !/navigationDelegate/.test(block.body)) {
          findings.push(finding('SEC_WEBVIEW_UNSAFE', 'major', 'WebView enables unrestricted JavaScript with no navigation delegate.', {
            file: file.path,
            suggestion: 'Restrict navigation and disable JS unless the content is trusted.',
          }));
          break;
        }
      }
    }

    return capFindings(findings);
  },
};

export const performanceAnalystAgent: CheckDefinition = {
  id: 'performance-analyst',
  name: 'Owen',
  title: 'Performance Analyst',
  department: 'quality',
  description: 'Finds list virtualization mistakes, shrink-wrapped scrollables, unbounded decodes and rebuild hazards.',
  capabilities: ['list-virtualization', 'const-usage', 'image-decoding', 'rebuild-cost'],
  mode: 'deterministic',
  run(context) {
    const findings: CheckFinding[] = [];
    const files = libFiles(context);
    if (files.length === 0) return findings;

    let eagerLists = 0;
    let eagerListFile: string | null = null;
    let shrinkWraps = 0;
    let shrinkWrapFile: string | null = null;
    let rawImages = 0;
    let rawImageFile: string | null = null;
    let constCount = 0;

    for (const file of files) {
      const code = stripDart(file.content);
      const listBlocks = callBlocks(code, 'ListView');
      for (const block of listBlocks) {
        if (/\bchildren\s*:/.test(block.body)) {
          eagerLists += 1;
          eagerListFile ??= file.path;
        }
      }
      shrinkWraps += countMatches(code, /\bshrinkWrap\s*:\s*true/g);
      if (shrinkWraps > 0) shrinkWrapFile ??= file.path;
      const imageBlocks = callBlocks(code, 'Image.network');
      for (const block of imageBlocks) {
        if (!/\b(cacheWidth|cacheHeight)\s*:/.test(block.body)) {
          rawImages += 1;
          rawImageFile ??= file.path;
        }
      }
      constCount += countMatches(code, /\bconst\s+[A-Z]/g);
    }

    if (eagerLists > 0) {
      findings.push(finding('PERF_EAGER_LIST', 'minor', `${eagerLists} ListView(s) build every child eagerly.`, {
        file: eagerListFile ?? undefined,
        suggestion: 'Use ListView.builder / .separated so off-screen rows are never built.',
      }));
    }
    if (shrinkWraps > 0) {
      findings.push(finding('PERF_SHRINKWRAP', 'minor', `${shrinkWraps} shrinkWrap: true usage(s) force full layout of scrollables.`, {
        file: shrinkWrapFile ?? undefined,
        suggestion: 'Use SliverList/CustomScrollView instead of nesting shrink-wrapped lists.',
      }));
    }
    if (rawImages > 0) {
      findings.push(finding('PERF_IMAGE_DECODE', 'minor', `${rawImages} network image(s) decode at full resolution.`, {
        file: rawImageFile ?? undefined,
        suggestion: 'Pass cacheWidth/cacheHeight (or use a caching image package) to bound memory.',
      }));
    }
    if (constCount === 0 && files.length > 5) {
      findings.push(finding('PERF_NO_CONST', 'minor', 'No const widget construction was found in a multi-file app.', {
        suggestion: 'Make immutable widgets const so rebuilds reuse identical instances.',
      }));
    }

    return capFindings(findings);
  },
};
