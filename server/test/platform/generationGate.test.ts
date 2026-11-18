import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AppSpec,
  GeneratedFile,
  GateResult,
  QualityFinding,
  QualityReport,
} from '../../platform/generation/contracts.js';
import {
  DEFAULT_GENERATION_BUDGET,
  aggregateGates,
  analyzeGate,
  budgetGate,
  qualityGate,
  structuralGate,
  testGate,
  type AnalyzeGateDeps,
} from '../../platform/generation/gate/index.js';

// ── fixtures ───────────────────────────────────────────────────────────────

function baseSpec(): AppSpec {
  return {
    version: 1,
    app: {
      name: 'Trail Notes',
      packageName: 'trail_notes',
      tagline: 'Field notes for long hikes',
      description: 'Capture notes on the trail and find them again later.',
      domain: 'productivity',
    },
    audience: { primary: 'Hikers' },
    entities: [
      {
        name: 'Note',
        plural: 'notes',
        description: 'A single trail note.',
        fields: [
          { name: 'title', type: 'string', required: true, primary: true },
          { name: 'createdAt', type: 'datetime', required: true },
        ],
      },
    ],
    screens: [
      { id: 'home', title: 'Home', route: '/', kind: 'dashboard', purpose: 'Overview', inNavigation: true },
      {
        id: 'notes',
        title: 'Notes',
        route: '/notes',
        kind: 'list',
        purpose: 'Browse notes',
        entity: 'Note',
        inNavigation: true,
      },
      {
        id: 'note_detail',
        title: 'Note',
        route: '/notes/:id',
        kind: 'detail',
        purpose: 'Read a note',
        entity: 'Note',
      },
    ],
    flows: [
      {
        id: 'browse_notes',
        name: 'Browse notes',
        steps: [
          { screenId: 'home', action: 'open notes' },
          { screenId: 'notes', action: 'open a note' },
        ],
      },
    ],
    design: {
      seedColor: '#336699',
      brightness: 'light',
      spacing: [4, 8, 12, 16, 24, 32],
      radii: { sm: 4, md: 8, lg: 12, xl: 16 },
      motionMs: 200,
      shape: 'rounded',
    },
    requirements: [
      { id: 'req-notes', statement: 'Users can browse notes.', category: 'functional', verifiedBy: 'test' },
    ],
    backend: 'local',
    seedCount: 3,
  };
}

const PUBSPEC = `name: trail_notes
description: Field notes for long hikes
publish_to: "none"
version: 1.0.0+1

environment:
  sdk: ">=3.4.0 <4.0.0"

dependencies:
  flutter:
    sdk: flutter

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^4.0.0

flutter:
  uses-material-design: true
`;

const MAIN_DART = `import 'package:flutter/material.dart';

import 'app/app.dart';

void main() {
  runApp(const TrailNotesApp());
}
`;

const APP_DART = `import 'package:flutter/material.dart';

class TrailNotesApp extends StatelessWidget {
  const TrailNotesApp({super.key});

  @override
  Widget build(BuildContext context) => const MaterialApp(home: SizedBox());
}
`;

const SMOKE_TEST: GeneratedFile = {
  path: 'test/app/app_smoke_test.dart',
  content: `import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('app boots', (tester) async {
    await tester.pumpWidget(const SizedBox());
    expect(find.byType(SizedBox), findsOneWidget);
  });
}
`,
};

function unitTest(path: string, name: string): GeneratedFile {
  return {
    path,
    content: `import 'package:flutter_test/flutter_test.dart';

void main() {
  test('${name}', () {
    expect(1 + 1, 2);
  });
}
`,
  };
}

function baseFiles(): GeneratedFile[] {
  return [
    { path: 'pubspec.yaml', content: PUBSPEC },
    { path: 'analysis_options.yaml', content: 'include: package:flutter_lints/flutter.yaml\n' },
    { path: 'lib/main.dart', content: MAIN_DART },
    { path: 'lib/app/app.dart', content: APP_DART },
    { path: 'lib/app/router.dart', content: 'class AppRouter {\n  const AppRouter();\n}\n' },
    { path: 'lib/app/theme.dart', content: 'const double appRadius = 12;\n' },
    { path: 'lib/app/app_scope.dart', content: 'class AppScope {\n  const AppScope();\n}\n' },
    { path: 'lib/app/navigation.dart', content: 'const List<String> appRoutes = <String>[];\n' },
    SMOKE_TEST,
    unitTest('test/data/note_model_test.dart', 'note model round-trips'),
    unitTest('test/state/note_controller_test.dart', 'note controller loads'),
  ];
}

function withoutTests(files: GeneratedFile[]): GeneratedFile[] {
  return files.filter((file) => !file.path.startsWith('test/'));
}

function qualityReport(overrides: Partial<QualityReport> = {}): QualityReport {
  return {
    total: 90,
    grade: 'A',
    categories: {
      architecture: 90,
      completeness: 90,
      design: 90,
      accessibility: 90,
      reliability: 90,
      testability: 90,
      performance: 90,
    },
    findings: [],
    stats: { files: 11, bytes: 2_000, lines: 400, screens: 3, entities: 1, tests: 3 },
    generatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function qualityError(code: string, message: string, path = 'lib/app/app.dart'): QualityFinding {
  return { category: 'reliability', severity: 'error', code, message, path };
}

type VerifyFn = NonNullable<AnalyzeGateDeps['verify']>;
type VerifyResult = Awaited<ReturnType<VerifyFn>>;

function depsReturning(result: VerifyResult): AnalyzeGateDeps {
  return { verify: async () => result };
}

function verifiedResult(overrides: Partial<VerifyResult> = {}): VerifyResult {
  return {
    verified: true,
    skipped: false,
    available: true,
    summary: 'Compile gate passed: 0 errors, 0 warning(s).',
    diagnostics: [],
    ...overrides,
  };
}

function skippedResult(overrides: Partial<VerifyResult> = {}): VerifyResult {
  return {
    verified: false,
    skipped: true,
    available: true,
    summary: 'Dependencies are not resolved yet; compile gate skipped until pub get runs.',
    diagnostics: [],
    ...overrides,
  };
}

// ── structure ──────────────────────────────────────────────────────────────

test('structuralGate passes a complete, consistent project', () => {
  const result = structuralGate({ spec: baseSpec(), files: baseFiles() });
  assert.equal(result.passed, true, result.blockers.join('\n'));
  assert.deepEqual(result.blockers, []);
  assert.equal(result.gate, 'structure');
  assert.match(result.detail ?? '', /11 files/);
});

test('structuralGate fails when pubspec.yaml is missing', () => {
  const files = baseFiles().filter((file) => file.path !== 'pubspec.yaml');
  const result = structuralGate({ spec: baseSpec(), files });
  assert.equal(result.passed, false);
  assert.ok(
    result.blockers.includes('STRUCTURE: missing required file: pubspec.yaml'),
    result.blockers.join('\n'),
  );
});

test('structuralGate fails on a duplicate file path exactly once', () => {
  const files = [...baseFiles(), { path: 'lib/app/theme.dart', content: '// duplicate\n' }];
  const result = structuralGate({ spec: baseSpec(), files });
  assert.equal(result.passed, false);
  const duplicates = result.blockers.filter((blocker) => blocker === 'STRUCTURE: duplicate path: lib/app/theme.dart');
  assert.equal(duplicates.length, 1);
});

test('structuralGate rejects path traversal', () => {
  const files = [...baseFiles(), { path: '../secrets.dart', content: '// escaped\n' }];
  const result = structuralGate({ spec: baseSpec(), files });
  assert.equal(result.passed, false);
  assert.ok(
    result.blockers.some((blocker) => blocker.includes('unsafe path') && blocker.includes('../secrets.dart')),
    result.blockers.join('\n'),
  );
});

test('structuralGate rejects a non-snake_case package name', () => {
  const spec = baseSpec();
  spec.app.packageName = 'Trail Notes!';
  const result = structuralGate({ spec, files: baseFiles() });
  assert.equal(result.passed, false);
  assert.ok(
    result.blockers.some((blocker) => blocker.includes('app.packageName')),
    result.blockers.join('\n'),
  );
});

test('structuralGate rejects a pubspec name that does not match the package', () => {
  const files = baseFiles().map((file) =>
    file.path === 'pubspec.yaml' ? { ...file, content: PUBSPEC.replace('name: trail_notes', 'name: other_app') } : file,
  );
  const result = structuralGate({ spec: baseSpec(), files });
  assert.equal(result.passed, false);
  assert.ok(
    result.blockers.includes('STRUCTURE: pubspec.yaml name does not match package trail_notes'),
    result.blockers.join('\n'),
  );
});

test('structuralGate requires at least one test file', () => {
  const result = structuralGate({ spec: baseSpec(), files: withoutTests(baseFiles()) });
  assert.equal(result.passed, false);
  assert.ok(
    result.blockers.includes('STRUCTURE: at least one test/**/*_test.dart file is required'),
    result.blockers.join('\n'),
  );
});

test('structuralGate requires main.dart to call runApp', () => {
  const files = baseFiles().map((file) =>
    file.path === 'lib/main.dart' ? { ...file, content: 'void main() {}\n' } : file,
  );
  const result = structuralGate({ spec: baseSpec(), files });
  assert.equal(result.passed, false);
  assert.ok(
    result.blockers.includes('STRUCTURE: lib/main.dart does not call runApp(...)'),
    result.blockers.join('\n'),
  );
});

test('structuralGate surfaces validateSpec failures', () => {
  const spec = baseSpec();
  spec.entities = [];
  spec.screens = [];
  const result = structuralGate({ spec, files: baseFiles() });
  assert.equal(result.passed, false);
  assert.ok(result.blockers.includes('STRUCTURE: at least one entity is required'));
  assert.ok(result.blockers.includes('STRUCTURE: at least two screens are required'));
});

test('structuralGate is deterministic', () => {
  const input = { spec: baseSpec(), files: baseFiles() };
  assert.deepEqual(structuralGate(input), structuralGate(input));
});

// ── quality ────────────────────────────────────────────────────────────────

test('qualityGate passes a clean report at the minimum', () => {
  const result = qualityGate(qualityReport({ total: 80, grade: 'B' }));
  assert.equal(result.passed, true, result.blockers.join('\n'));
  assert.deepEqual(result.blockers, []);
  assert.equal(result.gate, 'quality');
});

test('qualityGate fails a report below the threshold', () => {
  const result = qualityGate(qualityReport({ total: 79, grade: 'C' }));
  assert.equal(result.passed, false);
  assert.ok(result.blockers.includes('QUALITY: total 79 is below the minimum 80'));
});

test('qualityGate honours an explicit minimum', () => {
  const result = qualityGate(qualityReport({ total: 85 }), 90);
  assert.equal(result.passed, false);
  assert.ok(result.blockers.includes('QUALITY: total 85 is below the minimum 90'));
});

test('qualityGate fails on error findings and summarises worst categories', () => {
  const findings = [
    qualityError('E001', 'Undefined name foo.'),
    qualityError('E002', 'Missing return statement.'),
    qualityError('E003', 'Unused import.'),
    qualityError('E004', 'Invalid override.'),
    qualityError('E005', 'Missing required argument.'),
  ];
  const report = qualityReport({
    total: 90,
    categories: {
      architecture: 95,
      completeness: 60,
      design: 55,
      accessibility: 95,
      reliability: 95,
      testability: 50,
      performance: 95,
    },
    findings,
  });
  const result = qualityGate(report);
  assert.equal(result.passed, false);
  assert.ok(result.blockers.includes('QUALITY: 5 error finding(s) in the report'));
  assert.ok(
    result.blockers.includes('QUALITY: weakest categories — testability 50, design 55, completeness 60'),
    result.blockers.join('\n'),
  );
  const errorBlockers = result.blockers.filter((blocker) => blocker.startsWith('QUALITY: error finding'));
  assert.equal(errorBlockers.length, 3);
  assert.match(errorBlockers[0], /E001/);
  assert.match(errorBlockers[0], /Undefined name foo\./);
});

test('qualityGate fails closed when the report is missing', () => {
  const result = qualityGate(undefined as unknown as QualityReport);
  assert.equal(result.passed, false);
  assert.deepEqual(result.blockers, ['QUALITY: report missing']);
});

test('qualityGate ignores warning and info findings', () => {
  const report = qualityReport({
    findings: [
      { category: 'design', severity: 'warning', code: 'W1', message: 'Consider spacing.' },
      { category: 'performance', severity: 'info', code: 'I1', message: 'Nice.' },
    ],
  });
  const result = qualityGate(report);
  assert.equal(result.passed, true, result.blockers.join('\n'));
});

test('qualityGate is deterministic', () => {
  const report = qualityReport({ total: 60, findings: [qualityError('E001', 'Broken.')] });
  assert.deepEqual(qualityGate(report), qualityGate(report));
});

// ── budget ─────────────────────────────────────────────────────────────────

test('DEFAULT_GENERATION_BUDGET contains sane hard ceilings', () => {
  assert.deepEqual(DEFAULT_GENERATION_BUDGET, {
    maxFiles: 400,
    maxBytes: 2_500_000,
    maxFileBytes: 120_000,
    maxLines: 40_000,
  });
  assert.ok(DEFAULT_GENERATION_BUDGET.maxFileBytes < DEFAULT_GENERATION_BUDGET.maxBytes);
});

test('budgetGate passes a normal project', () => {
  const result = budgetGate({ spec: baseSpec(), files: baseFiles() });
  assert.equal(result.passed, true, result.blockers.join('\n'));
  assert.deepEqual(result.blockers, []);
  assert.equal(result.gate, 'budget');
});

test('budgetGate fails when maxFiles is exceeded', () => {
  const result = budgetGate({ spec: baseSpec(), files: baseFiles() }, { maxFiles: 5 });
  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((blocker) => /BUDGET: file count \d+ exceeds the limit of 5/.test(blocker)));
});

test('budgetGate fails when maxBytes is exceeded', () => {
  const result = budgetGate({ spec: baseSpec(), files: baseFiles() }, { maxBytes: 100 });
  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((blocker) => /BUDGET: total size \d+ bytes exceeds the limit of 100 bytes/.test(blocker)));
});

test('budgetGate fails when maxLines is exceeded', () => {
  const result = budgetGate({ spec: baseSpec(), files: baseFiles() }, { maxLines: 3 });
  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((blocker) => /BUDGET: total lines \d+ exceeds the limit of 3/.test(blocker)));
});

test('budgetGate fails a single oversized generated asset', () => {
  const files = [...baseFiles(), { path: 'assets/huge.bin', content: 'a'.repeat(50_000) }];
  const result = budgetGate(
    { spec: baseSpec(), files },
    { maxFileBytes: 10_000, maxBytes: 10_000_000, maxLines: 1_000_000 },
  );
  assert.equal(result.passed, false);
  assert.ok(
    result.blockers.includes(
      'BUDGET: assets/huge.bin is 50000 bytes, exceeding the per-file limit of 10000 bytes',
    ),
    result.blockers.join('\n'),
  );
});

test('budgetGate counts zero-byte files as findings', () => {
  const files = [...baseFiles(), { path: 'assets/empty.bin', content: '' }];
  const result = budgetGate({ spec: baseSpec(), files });
  assert.equal(result.passed, false);
  assert.ok(result.blockers.includes('BUDGET: empty file assets/empty.bin (0 bytes)'));
});

test('budgetGate merges partial overrides with defaults', () => {
  const result = budgetGate({ spec: baseSpec(), files: baseFiles() }, { maxFiles: 400 });
  assert.equal(result.passed, true, result.blockers.join('\n'));
  assert.equal(DEFAULT_GENERATION_BUDGET.maxBytes, 2_500_000);
});

test('budgetGate is deterministic', () => {
  const input = { spec: baseSpec(), files: baseFiles() };
  assert.deepEqual(budgetGate(input), budgetGate(input));
});

// ── tests ──────────────────────────────────────────────────────────────────

test('testGate passes three declarative test files', () => {
  const result = testGate({ spec: baseSpec(), files: baseFiles() });
  assert.equal(result.passed, true, result.blockers.join('\n'));
  assert.equal(result.gate, 'tests');
});

test('testGate fails when no tests were generated', () => {
  const result = testGate({ spec: baseSpec(), files: withoutTests(baseFiles()) });
  assert.equal(result.passed, false);
  assert.ok(
    result.blockers.includes('TESTS: no Dart test files were generated (expected test/**/*_test.dart)'),
  );
});

test('testGate passes a comprehensive smoke test plus a model test', () => {
  const files = [
    ...withoutTests(baseFiles()),
    SMOKE_TEST,
    unitTest('test/data/note_model_test.dart', 'note model round-trips'),
  ];
  const result = testGate({ spec: baseSpec(), files });
  assert.equal(result.passed, true, result.blockers.join('\n'));
  assert.match(result.detail ?? '', /smoke comprehensive/);
});

test('testGate fails two tests without a smoke test', () => {
  const files = [
    ...withoutTests(baseFiles()),
    unitTest('test/data/note_model_test.dart', 'note model round-trips'),
    unitTest('test/state/note_controller_test.dart', 'note controller loads'),
  ];
  const result = testGate({ spec: baseSpec(), files });
  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((blocker) => blocker.includes('only 2 declarative Dart test file(s)')));
});

test('testGate fails a smoke test that does not pump the app', () => {
  const smokeWithoutPump: GeneratedFile = {
    path: 'test/app/app_smoke_test.dart',
    content: `import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('boots', (tester) async {
    expect(1 + 1, 2);
  });
}
`,
  };
  const files = [
    ...withoutTests(baseFiles()),
    smokeWithoutPump,
    unitTest('test/state/note_controller_test.dart', 'note controller loads'),
  ];
  const result = testGate({ spec: baseSpec(), files });
  assert.equal(result.passed, false);
  assert.ok(
    result.blockers.includes('TESTS: test/app/app_smoke_test.dart does not pump the app with pumpWidget(...)'),
    result.blockers.join('\n'),
  );
});

test('testGate requires a model/controller test alongside the smoke test', () => {
  const files = [...withoutTests(baseFiles()), SMOKE_TEST];
  const result = testGate({ spec: baseSpec(), files });
  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((blocker) => blocker.includes('requires at least one model/controller test')));
});

test('testGate rejects test files without test markers', () => {
  const files = [
    ...withoutTests(baseFiles()),
    { path: 'test/a_test.dart', content: 'void main() {}\n' },
    { path: 'test/b_test.dart', content: 'void main() {}\n' },
    { path: 'test/c_test.dart', content: 'void main() {}\n' },
  ];
  const result = testGate({ spec: baseSpec(), files });
  assert.equal(result.passed, false);
  assert.ok(
    result.blockers.some((blocker) => blocker.includes('declares no testWidgets(...) or test(...) case')),
    result.blockers.join('\n'),
  );
});

test('testGate is deterministic', () => {
  const input = { spec: baseSpec(), files: baseFiles() };
  assert.deepEqual(testGate(input), testGate(input));
});

// ── analyze ────────────────────────────────────────────────────────────────

test('analyzeGate passes when the analyzer verified the project', async () => {
  const result = await analyzeGate({
    projectId: 'proj-1',
    spec: baseSpec(),
    files: baseFiles(),
    deps: depsReturning(verifiedResult()),
  });
  assert.equal(result.passed, true, result.blockers.join('\n'));
  assert.deepEqual(result.blockers, []);
  assert.equal(result.detail, 'Compile gate passed: 0 errors, 0 warning(s).');
});

test('analyzeGate fails closed when verification was skipped', async () => {
  const result = await analyzeGate({
    projectId: 'proj-1',
    spec: baseSpec(),
    files: baseFiles(),
    deps: depsReturning(skippedResult()),
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.blockers, ['ANALYZE: Flutter toolchain unavailable — verification did not run']);
});

test('analyzeGate fails closed when the toolchain is unavailable', async () => {
  const result = await analyzeGate({
    projectId: 'proj-1',
    spec: baseSpec(),
    files: baseFiles(),
    deps: depsReturning(
      skippedResult({ available: false, summary: 'Flutter SDK is not available: not found.' }),
    ),
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.blockers, ['ANALYZE: Flutter toolchain unavailable — verification did not run']);
});

test('analyzeGate allows skipped verification only with the env opt-in', async (t) => {
  const previous = process.env.FLUTTERFORGE_ALLOW_UNVERIFIED_GENERATION;
  process.env.FLUTTERFORGE_ALLOW_UNVERIFIED_GENERATION = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.FLUTTERFORGE_ALLOW_UNVERIFIED_GENERATION;
    else process.env.FLUTTERFORGE_ALLOW_UNVERIFIED_GENERATION = previous;
  });

  const result = await analyzeGate({
    projectId: 'proj-1',
    spec: baseSpec(),
    files: baseFiles(),
    deps: depsReturning(skippedResult()),
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.detail, 'skipped by policy');
});

test('analyzeGate reports analyzer errors with file:line formatting and a cap of 12', async () => {
  const diagnostics = Array.from({ length: 14 }, (_, index) => ({
    severity: 'error',
    message: `Undefined name 'missing${index}'.`,
    file: 'lib/main.dart',
    line: index + 2,
  }));
  diagnostics.push({ severity: 'warning', message: 'Unused import.', file: 'lib/app/app.dart', line: 1 });

  const result = await analyzeGate({
    projectId: 'proj-1',
    spec: baseSpec(),
    files: baseFiles(),
    deps: depsReturning(
      verifiedResult({
        verified: false,
        summary: 'Compile gate failed: 14 error(s), 1 warning(s).',
        diagnostics,
      }),
    ),
  });

  assert.equal(result.passed, false);
  assert.equal(result.blockers.length, 12);
  assert.equal(result.blockers[0], "lib/main.dart:2 — Undefined name 'missing0'.");
  assert.equal(result.blockers[11], "lib/main.dart:13 — Undefined name 'missing11'.");
});

test('analyzeGate truncates each diagnostic blocker to 240 chars', async () => {
  const result = await analyzeGate({
    projectId: 'proj-1',
    spec: baseSpec(),
    files: baseFiles(),
    deps: depsReturning(
      verifiedResult({
        verified: false,
        diagnostics: [
          { severity: 'error', message: 'x'.repeat(500), file: 'lib/main.dart', line: 10 },
        ],
      }),
    ),
  });
  assert.equal(result.passed, false);
  assert.equal(result.blockers.length, 1);
  assert.ok(result.blockers[0].length <= 240, `length ${result.blockers[0].length}`);
  assert.ok(result.blockers[0].startsWith('lib/main.dart:10 — '));
});

test('analyzeGate fails closed when verification throws', async () => {
  const result = await analyzeGate({
    projectId: 'proj-1',
    spec: baseSpec(),
    files: baseFiles(),
    deps: {
      verify: async () => {
        throw new Error('toolchain exploded');
      },
    },
  });
  assert.equal(result.passed, false);
  assert.equal(result.blockers.length, 1);
  assert.ok(result.blockers[0].startsWith('ANALYZE_INTERNAL:'));
  assert.match(result.blockers[0], /toolchain exploded/);
});

test('analyzeGate invents a blocker when verification failed without error diagnostics', async () => {
  const result = await analyzeGate({
    projectId: 'proj-1',
    spec: baseSpec(),
    files: baseFiles(),
    deps: depsReturning(
      verifiedResult({
        verified: false,
        summary: 'flutter pub get failed (exit 1); the project was not verified.',
        diagnostics: [],
      }),
    ),
  });
  assert.equal(result.passed, false);
  assert.equal(result.blockers.length, 1);
  assert.ok(result.blockers[0].startsWith('ANALYZE: verification failed'));
  assert.match(result.blockers[0], /flutter pub get failed/);
});

// ── aggregation ────────────────────────────────────────────────────────────

test('aggregateGates applies AND semantics', () => {
  const gates: GateResult[] = [
    { gate: 'structure', passed: true, blockers: [] },
    { gate: 'quality', passed: true, blockers: [] },
  ];
  const result = aggregateGates(gates);
  assert.equal(result.passed, true);
  assert.deepEqual(result.blockers, []);
});

test('aggregateGates flattens blockers in deterministic gate order with prefixes', () => {
  const gates: GateResult[] = [
    { gate: 'structure', passed: false, blockers: ['missing pubspec.yaml', 'STRUCTURE: duplicate path: lib/main.dart'] },
    { gate: 'quality', passed: true, blockers: [] },
    { gate: 'tests', passed: false, blockers: ['no tests'] },
    { gate: 'analyze', passed: false, blockers: ['ANALYZE_INTERNAL: boom'] },
  ];
  const result = aggregateGates(gates);
  assert.equal(result.passed, false);
  assert.deepEqual(result.blockers, [
    'STRUCTURE: missing pubspec.yaml',
    'STRUCTURE: duplicate path: lib/main.dart',
    'TESTS: no tests',
    'ANALYZE_INTERNAL: boom',
  ]);
});

test('aggregateGates surfaces a failed gate with no blockers', () => {
  const result = aggregateGates([{ gate: 'budget', passed: false, blockers: [] }]);
  assert.equal(result.passed, false);
  assert.deepEqual(result.blockers, ['BUDGET: gate failed without a reported blocker']);
});

test('aggregateGates fails closed for an empty gate list', () => {
  const result = aggregateGates([]);
  assert.equal(result.passed, false);
  assert.deepEqual(result.blockers, ['GATES: no gates were evaluated']);
});

test('aggregateGates is deterministic and preserves gate results', () => {
  const gates: GateResult[] = [
    { gate: 'structure', passed: false, blockers: ['bad'] },
    { gate: 'quality', passed: false, blockers: ['QUALITY: total 10 is below the minimum 80'] },
  ];
  const first = aggregateGates(gates);
  const second = aggregateGates(gates);
  assert.deepEqual(first, second);
  assert.equal(first.gates.length, 2);
  assert.equal(first.gates[0].blockers[0], 'bad');
});
