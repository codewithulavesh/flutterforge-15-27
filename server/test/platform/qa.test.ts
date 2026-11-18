import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dedupeDiagnostics,
  diagnosticsPromptBlock,
  fingerprint,
  groupByFile,
  parseDartAnalyzeJson,
  parseDartAnalyzeMachine,
  parseFlutterCompileErrors,
  parseTestOutput,
  rankDiagnostics,
  summarizeDiagnostics,
  MAX_BLOCKING,
  MAX_DIAGNOSTICS,
  type Diagnostic,
} from '../../platform/qa/diagnostics.js';
import {
  MAX_CONTRACT_BLOCKERS,
  stripDartCommentsAndStrings,
  verifyProjectContract,
} from '../../platform/qa/contract.js';
import {
  DEFAULT_REPAIR_POLICY,
  planRepair,
} from '../../platform/qa/healing.js';

function diag(partial: Partial<Diagnostic> & Pick<Diagnostic, 'path' | 'message'>): Diagnostic {
  return {
    line: 1,
    column: 1,
    severity: 'error',
    code: 'TEST_CODE',
    source: 'analyzer',
    ...partial,
  };
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

/* -------------------------------------------------------------------------- */
/* parseDartAnalyzeMachine                                                    */
/* -------------------------------------------------------------------------- */

test('machine parser: rejoins messages containing pipe characters', () => {
  const stdout = [
    "ERROR|STATIC_TYPE_WARNING|UNDEFINED_OPERATOR|lib/widgets/button.dart|12|5|7|The operand can't | be assigned| to 'num'",
    'WARNING|LINT|PREFER_FINAL_LOCALS|lib/main.dart|3|1|4|Prefer final| locals',
    'some non-diagnostic line',
  ].join('\n');

  const report = parseDartAnalyzeMachine(stdout);
  assert.equal(report.diagnostics.length, 2);
  assert.equal(report.diagnostics[0].message, "The operand can't | be assigned| to 'num'");
  assert.equal(report.diagnostics[0].line, 12);
  assert.equal(report.diagnostics[0].column, 5);
  assert.equal(report.diagnostics[0].endColumn, 12); // column 5 + length 7
  assert.equal(report.diagnostics[0].source, 'analyzer');
  assert.equal(report.diagnostics[0].severity, 'error');
  assert.equal(report.diagnostics[0].code, 'UNDEFINED_OPERATOR');

  assert.equal(report.diagnostics[1].message, 'Prefer final| locals');
  assert.equal(report.diagnostics[1].severity, 'warning');
  assert.equal(report.ignoredLines, 1);
  assert.deepEqual(report.parseErrors, []);
});

test('machine parser: invalid lines become parseErrors, never throw', () => {
  const stdout = [
    'ERROR|ONLY|FOUR|FIELDS',
    'ERROR|T|C|file.dart|notanumber|5|3|msg',
    'ERROR|T|C||5|3|3|file missing',
    '',
    'INFO|LINT|AAA|lib/a.dart|1|1|1|ok',
  ].join('\n');
  const report = parseDartAnalyzeMachine(stdout);
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.parseErrors.length, 3);
  assert.equal(report.diagnostics[0].code, 'AAA');
});

/* -------------------------------------------------------------------------- */
/* parseDartAnalyzeJson                                                       */
/* -------------------------------------------------------------------------- */

test('JSON parser: line-delimited analyzerDiagnostic event stream with root stripping', () => {
  const stdout = [
    '{"type":"analyzerStatus","isAnalyzing":true}',
    '{"type":"analyzerDiagnostic","error":{"severity":"ERROR","errorCode":"DEAD_CODE","problemMessage":"Dead code","location":{"file":"/repo/demo/lib/main.dart","startLine":42,"startColumn":7,"endLine":42,"endColumn":11}}}',
    '{"type":"analyzerStatus","isAnalyzing":false}',
  ].join('\n');
  const report = parseDartAnalyzeJson(stdout, '/repo/demo');
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0].path, 'lib/main.dart');
  assert.equal(report.diagnostics[0].line, 42);
  assert.equal(report.diagnostics[0].column, 7);
  assert.equal(report.diagnostics[0].severity, 'error');
  assert.equal(report.diagnostics[0].code, 'DEAD_CODE');
  assert.equal(report.diagnostics[0].message, 'Dead code');
});

test('JSON parser: diagnostic event nests a `diagnostic` payload', () => {
  const stdout = '{"type":"diagnostic","diagnostic":{"severity":"WARNING","code":"LINT_1","message":"prefer const","file":"/r/lib/a.dart","line":4,"column":2}}';
  const report = parseDartAnalyzeJson(stdout, '/r');
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0].path, 'lib/a.dart');
  assert.equal(report.diagnostics[0].severity, 'warning');
});

test('JSON parser: array document form', () => {
  const stdout = JSON.stringify([
    { severity: 'ERROR', code: 'X1', problemMessage: 'boom', location: { file: 'lib/x.dart', startLine: 9, startColumn: 1 } },
    { severity: 'INFO', code: 'X2', problemMessage: 'fyi', location: { file: 'lib/y.dart', startLine: 1, startColumn: 1 } },
  ]);
  const report = parseDartAnalyzeJson(stdout, '/nonexistent-root');
  assert.equal(report.diagnostics.length, 2);
  assert.equal(report.diagnostics[0].path, 'lib/x.dart');
  assert.equal(report.diagnostics[0].line, 9);
  assert.equal(report.diagnostics[1].severity, 'info');
});

test('JSON parser: single object form with embedded diagnostics array', () => {
  const stdout = JSON.stringify({
    type: 'summary',
    diagnostics: [
      { severity: 'ERROR', code: 'S1', problemMessage: 'single', file: 'lib/s.dart', line: 2, column: 3 },
    ],
  });
  const report = parseDartAnalyzeJson(stdout);
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0].code, 'S1');
});

test('JSON parser: invalid JSON line is a parseError, not an exception', () => {
  const report = parseDartAnalyzeJson('{"type":"diagnostic",bad json\n{"type":"analyzerStatus"}');
  assert.equal(report.parseErrors.length, 1);
  assert.equal(report.ignoredLines, 1);
});

/* -------------------------------------------------------------------------- */
/* parseFlutterCompileErrors                                                  */
/* -------------------------------------------------------------------------- */

test('compiler parser: colon format', () => {
  const stderr = 'lib/main.dart:12:5: Error: The method \'foo\' isn\'t defined.\n';
  const report = parseFlutterCompileErrors(stderr);
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0].severity, 'error');
  assert.equal(report.diagnostics[0].line, 12);
  assert.equal(report.diagnostics[0].column, 5);
  assert.equal(report.diagnostics[0].source, 'compiler');
  assert.equal(report.diagnostics[0].code, 'COMPILER_ERROR');
});

test('compiler parser: paren format with code', () => {
  const stderr = 'lib/main.dart(21,8): error G0123: Expected an identifier\n';
  const report = parseFlutterCompileErrors(stderr);
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0].code, 'G0123');
  assert.equal(report.diagnostics[0].line, 21);
  assert.equal(report.diagnostics[0].column, 8);
});

test('compiler parser: Target dart2js failed', () => {
  const stderr = 'Some compiler noise\nTarget dart2js failed: Exception: package:app/main.dart\n';
  const report = parseFlutterCompileErrors(stderr);
  const target = report.diagnostics.find((d) => d.code === 'DART2JS_FAILED');
  assert.ok(target, 'expected a DART2JS_FAILED diagnostic');
  assert.equal(target.severity, 'error');
  assert.equal(report.ignoredLines, 1);
});

/* -------------------------------------------------------------------------- */
/* parseTestOutput                                                            */
/* -------------------------------------------------------------------------- */

test('test output parser: package:test failure block with Expected/Actual and file refs', () => {
  const text = [
    '00:03 +2 -1: renders the home page [E]',
    '  Expected: exactly one \'Home\' widget',
    '  Actual: <zero>',
    '  file:///workspace/demo/test/widget_test.dart:34:11\n',
    '00:04 +2 -1: another test\n',
  ].join('\n');
  const report = parseTestOutput(text);
  assert.equal(report.diagnostics.length, 1);
  const failure = report.diagnostics[0];
  assert.equal(failure.severity, 'error');
  assert.equal(failure.code, 'TEST_FAILURE');
  assert.equal(failure.source, 'test');
  assert.match(failure.message, /renders the home page/);
  assert.match(failure.message, /Expected: exactly one/);
  assert.match(failure.message, /Actual: <zero>/);
  assert.equal(failure.path, 'test/widget_test.dart');
  assert.equal(failure.line, 34);
  assert.equal(failure.column, 11);
});

test('test output parser: package: URI references are normalized', () => {
  const text = [
    '01:00 +0 -1: arithmetic works [E]',
    '  test/unit_test.dart:8:5',
  ].join('\n');
  const report = parseTestOutput(text);
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0].path, 'test/unit_test.dart');
  assert.equal(report.diagnostics[0].line, 8);
});

/* -------------------------------------------------------------------------- */
/* fingerprint / dedupe / rank / summarize                                    */
/* -------------------------------------------------------------------------- */

test('fingerprint is stable across line moves and message digit churn', () => {
  const original = diag({ path: 'lib/a.dart', line: 10, column: 2, message: "Undefined name 'foo' at 10", code: 'X', source: 'analyzer' });
  const moved = diag({ path: 'lib/a.dart', line: 222, column: 9, message: "Undefined name 'foo' at 222", code: 'X', source: 'analyzer' });
  assert.equal(fingerprint(original), fingerprint(moved));
  // Location-aware fingerprinting does change.
  assert.notEqual(fingerprint(original, { includeLocation: true }), fingerprint(moved, { includeLocation: true }));
});

test('dedupeDiagnostics removes duplicates but keeps order', () => {
  const a = diag({ path: 'lib/a.dart', message: 'first' });
  const b = diag({ path: 'lib/a.dart', message: 'second', severity: 'warning' });
  const aDup = diag({ path: 'lib/a.dart', message: 'first', line: 99 });
  const deduped = dedupeDiagnostics([a, b, aDup]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].message, 'first');
  assert.equal(deduped[1].message, 'second');
});

test('rankDiagnostics orders errors first, then by file and line', () => {
  const diagnostics = [
    diag({ path: 'lib/b.dart', line: 5, severity: 'warning', message: 'b-warn' }),
    diag({ path: 'lib/a.dart', line: 30, message: 'a-30' }),
    diag({ path: 'lib/a.dart', line: 3, message: 'a-3' }),
    diag({ path: 'lib/b.dart', line: 1, severity: 'info', message: 'b-info' }),
  ];
  const ranked = rankDiagnostics(diagnostics);
  assert.deepEqual(
    ranked.map((d) => d.message),
    ['a-3', 'a-30', 'b-warn', 'b-info'],
  );
  assert.ok(ranked.every((d, i) => i === 0 || SEVERITY_ORDER[ranked[i - 1].severity] <= SEVERITY_ORDER[d.severity]));
});

test('groupByFile groups deterministically and summarizeDiagnostics caps blockers', () => {
  const diagnostics: Diagnostic[] = [];
  for (let i = 0; i < 30; i += 1) {
    diagnostics.push(diag({ path: 'lib/big.dart', line: i + 1, message: `error ${i}`, code: `E${i}` }));
  }
  diagnostics.push(diag({ path: 'lib/other.dart', message: 'warning here', severity: 'warning' }));
  const grouped = groupByFile(diagnostics);
  assert.deepEqual(Object.keys(grouped), ['lib/big.dart', 'lib/other.dart']);

  const summary = summarizeDiagnostics(diagnostics);
  assert.equal(summary.errors, 30);
  assert.equal(summary.warnings, 1);
  assert.equal(summary.blocking.length, MAX_BLOCKING);
  assert.equal(MAX_BLOCKING, 12);
  assert.equal(summary.blockingTotal, 30);
  assert.equal(summary.blockingTruncated, true);
  assert.equal(summary.bySeverity.error, 30);
});

test('diagnosticsPromptBlock is deterministic and bounded', () => {
  const diagnostics = [
    diag({ path: 'lib/a.dart', line: 1, column: 2, message: 'boom', code: 'B1' }),
    diag({ path: 'lib/b.dart', line: 3, column: 4, message: 'bam', code: 'B2', severity: 'warning' }),
  ];
  const block = diagnosticsPromptBlock(diagnostics, 500);
  assert.ok(block.length <= 500);
  assert.match(block, /lib\/a\.dart:1:2/);
  const tiny = diagnosticsPromptBlock(diagnostics, 20);
  assert.ok(tiny.length <= 20);
});

/* -------------------------------------------------------------------------- */
/* verifyProjectContract                                                      */
/* -------------------------------------------------------------------------- */

const HAPPY_PUBSPEC = `name: happy_app
description: Demo
publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: '>=3.3.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.0

flutter:
  uses-material-design: true
  assets:
    - assets/icon.png
`;

const HAPPY_MAIN = [
  "import 'package:flutter/material.dart';",
  "import 'package:http/http.dart' as http;",
  '',
  'void main() {',
  '  runApp(const HappyApp());',
  '}',
  '',
  'class HappyApp extends StatelessWidget {',
  '  const HappyApp({super.key});',
  '  @override',
  '  Widget build(BuildContext context) => const Placeholder();',
  '}',
  '',
].join('\n');

const HAPPY_FILES = [
  { path: 'pubspec.yaml', content: HAPPY_PUBSPEC },
  { path: 'lib/main.dart', content: HAPPY_MAIN },
  { path: 'assets/icon.png', content: 'fake-png-bytes' },
];

test('contract happy path passes', () => {
  const result = verifyProjectContract({ files: HAPPY_FILES, packageName: 'happy_app' });
  assert.equal(result.passed, true);
  assert.deepEqual(result.blockers, []);
  assert.ok(result.checks.length >= 10);
  // Deterministic ordering: identical input, identical output.
  const again = verifyProjectContract({ files: HAPPY_FILES, packageName: 'happy_app' });
  assert.deepEqual(again, result);
});

test('contract: missing runApp is a blocker', () => {
  const files = [
    { path: 'pubspec.yaml', content: HAPPY_PUBSPEC },
    { path: 'lib/main.dart', content: 'void main() {\n  print("hi");\n}\n' },
    { path: 'assets/icon.png', content: 'fake-png-bytes' },
  ];
  const result = verifyProjectContract({ files, packageName: 'happy_app' });
  assert.equal(result.passed, false);
  const runAppCheck = result.checks.find((check) => check.id === 'main-runapp');
  assert.equal(runAppCheck?.passed, false);
  assert.ok(result.blockers.some((check) => check.id === 'main-runapp'));
});

test('contract: main only inside comment does not satisfy main-top-level', () => {
  const files = [
    { path: 'pubspec.yaml', content: HAPPY_PUBSPEC },
    { path: 'lib/main.dart', content: '// void main() {}\nvoid entry() {\n  runApp(const X());\n}\n' },
    { path: 'assets/icon.png', content: 'fake-png-bytes' },
  ];
  const result = verifyProjectContract({ files, packageName: 'happy_app' });
  const mainCheck = result.checks.find((check) => check.id === 'main-top-level');
  assert.equal(mainCheck?.passed, false);
});

test('contract: main only inside a string does not satisfy main-top-level', () => {
  const files = [
    { path: 'pubspec.yaml', content: HAPPY_PUBSPEC },
    { path: 'lib/main.dart', content: "const String s = 'void main() {}';\nvoid entry() {\n  runApp(const X());\n}\n" },
    { path: 'assets/icon.png', content: 'fake-png-bytes' },
  ];
  const result = verifyProjectContract({ files, packageName: 'happy_app' });
  const mainCheck = result.checks.find((check) => check.id === 'main-top-level');
  assert.equal(mainCheck?.passed, false);
});

test('contract: undeclared external dependency is a blocker', () => {
  const main = [
    "import 'package:flutter/material.dart';",
    "import 'package:unobtainium/unobtainium.dart';",
    'void main() {',
    '  runApp(const Placeholder());',
    '}',
  ].join('\n');
  const files = [
    { path: 'pubspec.yaml', content: HAPPY_PUBSPEC },
    { path: 'lib/main.dart', content: main },
    { path: 'assets/icon.png', content: 'fake-png-bytes' },
  ];
  const result = verifyProjectContract({ files, packageName: 'happy_app' });
  const check = result.checks.find((entry) => entry.id === 'imports-declared');
  assert.equal(check?.passed, false);
  assert.match(check?.message ?? '', /unobtainium/);
  assert.ok(result.blockers.some((entry) => entry.id === 'imports-declared'));
});

test('contract: missing asset listed in pubspec is a blocker', () => {
  const files = [
    { path: 'pubspec.yaml', content: HAPPY_PUBSPEC },
    { path: 'lib/main.dart', content: HAPPY_MAIN },
  ];
  const result = verifyProjectContract({ files, packageName: 'happy_app' });
  const check = result.checks.find((entry) => entry.id === 'pubspec-assets');
  assert.equal(check?.passed, false);
  assert.match(check?.message ?? '', /assets\/icon\.png/);
});

const SUPABASE_NO_RLS = `-- enable pgcrypto
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  body text not null
);
`;

const SUPABASE_WITH_RLS = `${SUPABASE_NO_RLS}
alter table public.notes enable row level security;
`;

const SUPABASE_PUBSPEC = `name: supa_app
description: Demo
publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: '>=3.3.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  supabase_flutter: ^2.5.0

flutter:
  uses-material-design: true
`;

const SUPABASE_MAIN = "import 'package:flutter/material.dart';\nvoid main() {\n  runApp(const Placeholder());\n}\n";

test('contract: table-creating migration without RLS is a blocker', () => {
  const files = [
    { path: 'pubspec.yaml', content: SUPABASE_PUBSPEC },
    { path: 'lib/main.dart', content: SUPABASE_MAIN },
    { path: 'supabase/migrations/0001_init.sql', content: SUPABASE_NO_RLS },
  ];
  const result = verifyProjectContract({ files, packageName: 'supa_app', expectsSupabase: true });
  const check = result.checks.find((entry) => entry.id === 'supabase-migrations-rls');
  assert.equal(check?.passed, false);
  assert.ok(result.blockers.some((entry) => entry.id === 'supabase-migrations-rls'));
  assert.equal(result.passed, false);
});

test('contract: table-creating migration with RLS passes the RLS check', () => {
  const files = [
    { path: 'pubspec.yaml', content: SUPABASE_PUBSPEC },
    { path: 'lib/main.dart', content: SUPABASE_MAIN },
    { path: 'supabase/migrations/0001_init.sql', content: SUPABASE_WITH_RLS },
  ];
  const result = verifyProjectContract({ files, packageName: 'supa_app', expectsSupabase: true });
  const check = result.checks.find((entry) => entry.id === 'supabase-migrations-rls');
  assert.equal(check?.passed, true);
  assert.equal(result.passed, true);
});

test('contract: expectsSupabase without migrations warns but does not block', () => {
  const files = [
    { path: 'pubspec.yaml', content: SUPABASE_PUBSPEC },
    { path: 'lib/main.dart', content: SUPABASE_MAIN },
  ];
  const result = verifyProjectContract({ files, packageName: 'supa_app', expectsSupabase: true });
  const check = result.checks.find((entry) => entry.id === 'supabase-migrations-missing');
  assert.equal(check?.severity, 'warning');
  assert.equal(check?.passed, false);
  assert.equal(result.passed, true);
  assert.deepEqual(result.blockers, []);
});

test('contract: expectsSupabase without a supabase dependency blocks', () => {
  const files = [
    { path: 'pubspec.yaml', content: HAPPY_PUBSPEC.replace('happy_app', 'supa_app') },
    { path: 'lib/main.dart', content: SUPABASE_MAIN },
  ];
  const result = verifyProjectContract({ files, packageName: 'supa_app', expectsSupabase: true });
  assert.ok(result.blockers.some((entry) => entry.id === 'supabase-dependency'));
});

test('contract: hardcoded secret is a blocker', () => {
  const files = [
    { path: 'pubspec.yaml', content: HAPPY_PUBSPEC },
    { path: 'lib/main.dart', content: HAPPY_MAIN },
    { path: 'assets/icon.png', content: 'fake-png-bytes' },
    { path: 'lib/config.dart', content: "const apiKey = 'sk-or-v1-9f8e7d6c5b4a39281706f5e4d3c2b1a0';\n" },
  ];
  const result = verifyProjectContract({ files, packageName: 'happy_app' });
  const check = result.checks.find((entry) => entry.id === 'secrets');
  assert.equal(check?.passed, false);
  assert.ok(result.blockers.some((entry) => entry.id === 'secrets'));
});

test('contract: AWS access key id is a blocker', () => {
  const files = [
    { path: 'pubspec.yaml', content: HAPPY_PUBSPEC },
    { path: 'lib/main.dart', content: HAPPY_MAIN },
    { path: 'assets/icon.png', content: 'fake-png-bytes' },
    { path: 'lib/aws.dart', content: "const k = 'AKIAIOSFODNN7EXAMPLE';\n" },
  ];
  const result = verifyProjectContract({ files, packageName: 'happy_app' });
  assert.ok(result.blockers.some((entry) => entry.id === 'secrets'));
});

test('contract: placeholder markers are blockers', () => {
  const files = [
    { path: 'pubspec.yaml', content: HAPPY_PUBSPEC },
    { path: 'lib/main.dart', content: 'void main() {\n  // TODO: implement\n  runApp(const Placeholder());\n}\n' },
    { path: 'assets/icon.png', content: 'fake-png-bytes' },
  ];
  const result = verifyProjectContract({ files, packageName: 'happy_app' });
  assert.ok(result.blockers.some((entry) => entry.id === 'placeholders'));
});

test('contract: pubspec name mismatch with packageName blocks', () => {
  const result = verifyProjectContract({ files: HAPPY_FILES, packageName: 'other_app' });
  assert.ok(result.blockers.some((entry) => entry.id === 'pubspec-name-matches'));
});

test('contract: android applicationId must equal appId', () => {
  const gradle = `plugins {\n    id "com.android.application"\n}\nandroid {\n    defaultConfig {\n        applicationId "com.example.wrong"\n    }\n}\n`;
  const files = [
    ...HAPPY_FILES,
    { path: 'android/app/build.gradle', content: gradle },
  ];
  const mismatch = verifyProjectContract({ files, packageName: 'happy_app', appId: 'com.flutterforge.happy' });
  assert.ok(mismatch.blockers.some((entry) => entry.id === 'android-applicationId'));

  const fixed = [
    ...HAPPY_FILES,
    { path: 'android/app/build.gradle', content: gradle.replace('com.example.wrong', 'com.flutterforge.happy') },
  ];
  const match = verifyProjectContract({ files: fixed, packageName: 'happy_app', appId: 'com.flutterforge.happy' });
  assert.equal(match.checks.find((entry) => entry.id === 'android-applicationId')?.passed, true);
});

test('contract: self-package import with wrong name is a blocker', () => {
  const main = [
    "import 'package:happy_app/util.dart';",
    "import 'package:happy_ap/util.dart';", // typo of the self package — resolves to project lib/util.dart
    'void main() {',
    '  runApp(const Placeholder());',
    '}',
  ].join('\n');
  const files = [
    { path: 'pubspec.yaml', content: HAPPY_PUBSPEC },
    { path: 'lib/main.dart', content: main },
    { path: 'lib/util.dart', content: 'int x = 1;\n' },
    { path: 'assets/icon.png', content: 'fake-png-bytes' },
  ];
  const result = verifyProjectContract({ files, packageName: 'happy_app' });
  assert.ok(result.blockers.some((entry) => entry.id === 'self-package-import'));
});

test('contract: blockers are capped and deterministically ordered', () => {
  const result = verifyProjectContract({ files: [], packageName: 'nope' });
  assert.ok(result.blockers.length <= MAX_CONTRACT_BLOCKERS);
  const ids = result.checks.map((entry) => entry.id);
  assert.deepEqual([...new Set(ids)], ids, 'check ids must be emitted exactly once');
});

test('contract: malformed input never throws', () => {
  assert.doesNotThrow(() => verifyProjectContract({ files: 'not-an-array' as never, packageName: 'x' }));
  assert.doesNotThrow(() =>
    verifyProjectContract({
      files: [null, 42, { path: 1 } as never, { path: 'ok.dart', content: 123 as never }],
      packageName: '',
    }),
  );
  assert.doesNotThrow(() =>
    verifyProjectContract({ files: [{ path: 'pubspec.yaml', content: '\0\0\0name: x: : :' }], packageName: 'x' }),
  );
});

/* -------------------------------------------------------------------------- */
/* stripDartCommentsAndStrings                                                */
/* -------------------------------------------------------------------------- */

test('stripDartCommentsAndStrings removes nested comments and strings', () => {
  const source = [
    "// comment with 'quotes' and main()",
    '/* outer /* inner */ still comment */',
    "final a = 'runApp(';",
    "final b = \"double \\\" quote with main(\";",
    "final c = '''triple ' quoted main( ''';",
    'final raw = r"raw \\n main( ";',
    'void main() {}',
  ].join('\n');
  const stripped = stripDartCommentsAndStrings(source);
  assert.doesNotMatch(stripped.split('void main() {}')[0], /main\(/);
  assert.match(stripped, /void main\(\) \{\}/);
});

/* -------------------------------------------------------------------------- */
/* planRepair                                                                 */
/* -------------------------------------------------------------------------- */

function repairDiag(path: string, message: string, line = 1, source: Diagnostic['source'] = 'analyzer'): Diagnostic {
  return diag({ path, message, line, code: 'E1', source, severity: 'error' });
}

const CYCLE_DIAGNOSTICS: Diagnostic[] = [
  repairDiag('lib/a.dart', 'Undefined name foo', 10),
  repairDiag('lib/b.dart', 'Type mismatch', 4),
  repairDiag('lib/a.dart', 'Missing semicolon', 12),
];

test('healing: plans repair with grouped targets and deterministic brief', () => {
  const plan = planRepair({ diagnostics: CYCLE_DIAGNOSTICS, cycle: 1, history: [] });
  assert.equal(plan.shouldRepair, true);
  assert.equal(plan.strategy, 'surgical');
  assert.equal(plan.stopReason, undefined);
  assert.deepEqual(
    plan.targets.map((target) => target.path),
    ['lib/a.dart', 'lib/b.dart'],
  );
  const aTarget = plan.targets.find((target) => target.path === 'lib/a.dart');
  assert.equal(aTarget?.diagnostics.length, 2);
  assert.match(plan.brief, /lib\/a\.dart/);
  assert.match(plan.brief, /10:1 \[E1\]/);
  assert.match(plan.brief, /minimal edits/i);
  assert.ok(plan.brief.length <= 2000);
});

test('healing: targets are capped at 5 files, worst errors first', () => {
  const diagnostics: Diagnostic[] = [];
  for (let i = 0; i < 7; i += 1) {
    // lib/file0.dart gets 3 errors, others 1
    const count = i === 0 ? 3 : 1;
    for (let j = 0; j < count; j += 1) {
      diagnostics.push(repairDiag(`lib/file${i}.dart`, `msg ${i}-${j}`, j + 1));
    }
  }
  const plan = planRepair({ diagnostics, cycle: 1, history: [] });
  assert.equal(plan.targets.length, 5);
  assert.equal(plan.targets[0].path, 'lib/file0.dart');
});

test('healing: stops with OSCILLATION when the fingerprint set repeats', () => {
  const current = [...new Set(CYCLE_DIAGNOSTICS.map((d) => fingerprint(d)))].sort();
  const plan = planRepair({
    diagnostics: CYCLE_DIAGNOSTICS,
    cycle: 2,
    history: [current, current],
  });
  assert.equal(plan.shouldRepair, false);
  assert.equal(plan.strategy, 'stop');
  assert.equal(plan.stopReason, 'OSCILLATION');

  // One repetition is not enough with the default maxSameFingerprint = 2.
  const proceed = planRepair({ diagnostics: CYCLE_DIAGNOSTICS, cycle: 2, history: [current] });
  assert.equal(proceed.shouldRepair, true);
});

test('healing: stops with MAX_CYCLES beyond the configured limit', () => {
  const plan = planRepair({ diagnostics: CYCLE_DIAGNOSTICS, cycle: 4, history: [] });
  assert.equal(plan.shouldRepair, false);
  assert.equal(plan.strategy, 'stop');
  assert.equal(plan.stopReason, 'MAX_CYCLES');

  const custom = planRepair({ diagnostics: CYCLE_DIAGNOSTICS, cycle: 2, history: [], policy: { maxCycles: 1 } });
  assert.equal(custom.stopReason, 'MAX_CYCLES');

  const atLimit = planRepair({ diagnostics: CYCLE_DIAGNOSTICS, cycle: 3, history: [] });
  assert.equal(atLimit.shouldRepair, true); // cycle 3 == maxCycles 3, still allowed
  assert.equal(DEFAULT_REPAIR_POLICY.maxCycles, 3);
  assert.equal(DEFAULT_REPAIR_POLICY.maxSameFingerprint, 2);
});

test('healing: unsafe targets (absolute or parent-escaping) are rejected', () => {
  const absolute = planRepair({ diagnostics: [repairDiag('/etc/passwd', 'boom')], cycle: 1, history: [] });
  assert.equal(absolute.shouldRepair, false);
  assert.equal(absolute.stopReason, 'UNSAFE_TARGET');

  const escaping = planRepair({ diagnostics: [repairDiag('../outside.dart', 'boom')], cycle: 1, history: [] });
  assert.equal(escaping.shouldRepair, false);
  assert.equal(escaping.stopReason, 'UNSAFE_TARGET');

  const windowsAbsolute = planRepair({ diagnostics: [repairDiag('C:\\repo\\lib\\main.dart', 'boom')], cycle: 1, history: [] });
  assert.equal(windowsAbsolute.stopReason, 'UNSAFE_TARGET');
});

test('healing: NOTHING_TO_REPAIR when there are no error/warning diagnostics', () => {
  const infos = [diag({ path: 'lib/a.dart', message: 'fyi', severity: 'info' })];
  const plan = planRepair({ diagnostics: infos, cycle: 1, history: [] });
  assert.equal(plan.shouldRepair, false);
  assert.equal(plan.stopReason, 'NOTHING_TO_REPAIR');

  const runtimeOnly = [diag({ path: 'lib/a.dart', message: 'boom', source: 'runtime' })];
  const blocked = planRepair({ diagnostics: runtimeOnly, cycle: 1, history: [] });
  assert.equal(blocked.shouldRepair, false);
  assert.equal(blocked.stopReason, 'NOTHING_TO_REPAIR');
});

test('healing: brief stays within ~2000 chars even for many diagnostics', () => {
  const diagnostics: Diagnostic[] = [];
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < 100; i += 1) {
    const tag = `${letters[Math.floor(i / 26)]}${letters[i % 26]}z`;
    diagnostics.push(repairDiag('lib/a.dart', `Distinctive diagnostic flavor ${tag} for this entry`, i + 1));
  }
  const plan = planRepair({ diagnostics, cycle: 1, history: [] });
  assert.equal(plan.shouldRepair, true);
  assert.ok(plan.brief.length <= 2000, `brief too long: ${plan.brief.length}`);
});

test('healing: malformed input never throws', () => {
  assert.doesNotThrow(() => planRepair(null as never));
  assert.doesNotThrow(() => planRepair(undefined as never));
  assert.doesNotThrow(() => planRepair({ diagnostics: 'nope' } as never));
  assert.doesNotThrow(() => planRepair({ diagnostics: [{ bogus: true }, null, { path: 'x.dart', severity: 'error', code: 'C', message: 'm', source: 'analyzer', line: 'x' }] as never, cycle: Number.NaN }));
  assert.doesNotThrow(() => planRepair({ diagnostics: [], cycle: -3, history: 'junk' as never }));
});

test('parsers never exceed MAX_DIAGNOSTICS and never throw', () => {
  const machine = Array.from({ length: MAX_DIAGNOSTICS + 25 }, (_, i) => `ERROR|T|C|lib/f${i}.dart|1|1|1|m`).join('\n');
  const report = parseDartAnalyzeMachine(machine);
  assert.equal(report.diagnostics.length, MAX_DIAGNOSTICS);
  assert.ok(report.parseErrors.some((entry) => entry.line === 0));

  assert.doesNotThrow(() => parseDartAnalyzeMachine(null as never));
  assert.doesNotThrow(() => parseDartAnalyzeJson('[\xff\xfe garbage' as never));
  assert.doesNotThrow(() => parseFlutterCompileErrors(undefined as never));
  assert.doesNotThrow(() => parseTestOutput(123 as never));
});
