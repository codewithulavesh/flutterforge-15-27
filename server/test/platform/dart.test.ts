import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenize,
  analyzeDart,
  buildImportGraph,
  validateDartFiles,
} from '../../platform/dart/index.js';

function makeFile(path: string, content: string): { path: string; content: string } {
  return { path, content };
}

const VALID_MAIN = `import 'package:flutter/material.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) => const MaterialApp(home: Text('ok'));
}
`;

const VALID_HELPER = `String helper() => 'helper';
`;

test('nested block comments and delimiters inside them are ignored', () => {
  const source = `class Widget {
  /* outer ( [ {
     /* nested } ] ) with \${} and "strings" */
     still outer with } ) ]
     /* deeper /* deepest { } */ still nested */
  */
  final int count = 1;
}
`;
  const lexed = tokenize(source);
  assert.deepEqual(lexed.errors, []);
  const commentTokens = lexed.tokens.filter((t) => t.kind === 'comment');
  assert.equal(commentTokens.length, 1); // the whole nested region is one comment token

  const result = validateDartFiles({
    packageName: 'myapp',
    files: [
      makeFile('lib/main.dart', VALID_MAIN.replace("import 'package:flutter/material.dart';\n", '') + source),
      makeFile('lib/helper.dart', VALID_HELPER),
    ],
  });
  const codes = result.diagnostics.map((d) => d.code);
  assert.ok(!codes.includes('DELIMITER_IMBALANCE'), `unexpected delimiter diagnostic: ${JSON.stringify(result.diagnostics)}`);
  assert.ok(!codes.includes('LEX_ERROR'), `unexpected lex diagnostic: ${JSON.stringify(result.diagnostics)}`);
});

test('triple-quoted and raw strings keep braces balanced', () => {
  const source = [
    'void main() {',
    "  final plain = '''",
    '    multiline } and } and { braces',
    "  ''';",
    '  final raw = r"raw } braces { even $notInterpolated }";',
    "  final rawTriple = r'''triple } braces''';",
    '  runApp(App());',
    '}',
    '',
    'class App {',
    '  const App();',
    '}',
    '',
  ].join('\\n');
  const analysis = analyzeDart(source);
  assert.deepEqual(analysis.errors, []);
  const result = validateDartFiles({
    packageName: 'myapp',
    files: [makeFile('lib/main.dart', source)],
  });
  const codes = result.diagnostics.map((d) => d.code);
  assert.ok(!codes.includes('DELIMITER_IMBALANCE'), `unexpected imbalance: ${JSON.stringify(result.diagnostics)}`);
  assert.ok(!codes.includes('LEX_ERROR'), `unexpected lex errors: ${JSON.stringify(result.diagnostics)}`);
});

test('string interpolation \${map[\'}\']} does not break delimiter balance', () => {
  const source = `import 'dart:core';

void main() {
  final map = <String, String>{'}': 'close'};
  final s = "value: \${map['}']} done";
  final t = "nested \${ {'a': map['}']} }";
  runApp(App(s, t));
}

class App {
  const App(String s, String t);
}
`;
  const analysis = analyzeDart(source);
  assert.deepEqual(analysis.errors, []);
  const strings = tokenize(source).tokens.filter((t) => t.kind === 'string');
  const interpolated = strings.filter((t) => (t.interpolations ?? []).some((ip) => ip.expression));
  assert.ok(interpolated.length >= 2, 'expected interpolated strings to be recognized');
  const result = validateDartFiles({
    packageName: 'myapp',
    files: [makeFile('lib/main.dart', source)],
  });
  const codes = result.diagnostics.map((d) => d.code);
  assert.ok(!codes.includes('DELIMITER_IMBALANCE'), `unexpected imbalance: ${JSON.stringify(result.diagnostics)}`);
  assert.ok(!codes.includes('LEX_ERROR'), `unexpected lex errors: ${JSON.stringify(result.diagnostics)}`);
});

test('unmatched bracket is reported with the correct line', () => {
  const source = `class A {
}
}
`;
  const result = validateDartFiles({
    packageName: 'myapp',
    files: [makeFile('lib/main.dart', VALID_MAIN), makeFile('lib/a.dart', source)],
  });
  const imbalance = result.diagnostics.find((d) => d.code === 'DELIMITER_IMBALANCE' && d.path === 'lib/a.dart');
  assert.ok(imbalance, `expected DELIMITER_IMBALANCE, got: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(imbalance.line, 3);

  const withParen = `void helper() {
  var x = (1 + 2;
}
`;
  const parenResult = validateDartFiles({
    packageName: 'myapp',
    files: [makeFile('lib/main.dart', VALID_MAIN), makeFile('lib/p.dart', withParen)],
  });
  const unclosed = parenResult.diagnostics.find((d) => d.code === 'DELIMITER_IMBALANCE' && /Unclosed/.test(d.message));
  assert.ok(unclosed, `expected unclosed-paren diagnostic, got: ${JSON.stringify(parenResult.diagnostics)}`);
  assert.equal(unclosed.line, 2);
});

test('class/method symbols: extraction, abstract, static, enclosing', () => {
  const source = `import 'dart:async';

abstract class Repository extends Base with Cache implements Comparable<Repository> {
  final String table = 'items';
  static int instanceCount = 0;
  static void warmUp() {}
  int get depth;
  Future<String> fetch(int id);
  operator [](int i) => i;
  Repository();
  factory Repository.fromConfig() => Repository();
}

class Base {}

mixin Cache {}

extension on int {
  int get triple => this * 3;
}
`;
  const analysis = analyzeDart(source);
  const byKindName = analysis.symbols.map((s) => `${s.kind}:${s.name}`);

  const repo = analysis.symbols.find((s) => s.kind === 'class' && s.name === 'Repository');
  assert.ok(repo);
  assert.equal(repo.abstract, true);
  assert.deepEqual(repo.extends, ['Base']);
  assert.deepEqual(repo.implements, ['Comparable']); // generics stripped
  assert.deepEqual(repo.with, ['Cache']);

  const members = analysis.symbols.filter((s) => s.enclosing === 'Repository');
  const memberMap = new Map(members.map((s) => [`${s.kind}:${s.name}`, s]));
  assert.equal(memberMap.get('field:table')?.isStatic, false);
  assert.equal(memberMap.get('field:instanceCount')?.isStatic, true);
  assert.equal(memberMap.get('method:warmUp')?.isStatic, true);
  assert.equal(memberMap.get('method:fetch')?.abstract, false);
  assert.equal(memberMap.get('getter:depth')?.enclosing, 'Repository');
  assert.equal(memberMap.get('operator:operator []')?.enclosing, 'Repository');
  assert.ok(memberMap.has('constructor:Repository'));
  assert.ok(memberMap.has('constructor:fromConfig'));

  const ext = analysis.symbols.find((s) => s.kind === 'extension');
  assert.ok(ext, 'unnamed extension should still be indexed');
  const triple = analysis.symbols.find((s) => s.name === 'triple');
  assert.equal(triple?.enclosing, ext.name);

  assert.ok(byKindName.includes('mixin:Cache'));
  assert.deepEqual(analysis.errors, []);
});

test('package:self and relative imports resolve; missing file reported', () => {
  const files = [
    makeFile('lib/main.dart', `import 'package:myapp/src/helper.dart';
import 'util/local.dart';
import 'package:myapp/does_not_exist.dart';
void main() => runApp(const App());
class App {}
`),
    makeFile('lib/src/helper.dart', VALID_HELPER),
    makeFile('lib/util/local.dart', "String localUtil() => 'u';\n"),
  ];
  const graph = buildImportGraph(files, 'myapp');
  const mainNode = graph.nodes.find((n) => n.path === 'lib/main.dart');
  assert.ok(mainNode);
  assert.deepEqual(mainNode.imports, ['lib/src/helper.dart', 'lib/util/local.dart']);

  const unresolved = graph.unresolved.find((u) => u.uri === 'package:myapp/does_not_exist.dart');
  assert.ok(unresolved, `expected unresolved diagnostic, got: ${JSON.stringify(graph.unresolved)}`);
  assert.equal(unresolved.line, 3);
  assert.match(unresolved.reason, /not found/i);

  const edge = graph.edges.find((e) => e.kind === 'import' && e.to === 'lib/src/helper.dart');
  assert.ok(edge);

  const validation = validateDartFiles({ packageName: 'myapp', files });
  assert.ok(validation.diagnostics.some((d) => d.code === 'UNRESOLVED_IMPORT' && /does_not_exist/.test(d.message)));
});

test('relative import escaping the project root is rejected', () => {
  const files = [
    makeFile('lib/src/deep/file.dart', `import '../../../../etc/passwd.dart';
void main() {}`),
  ];
  const graph = buildImportGraph(files, 'myapp');
  assert.equal(graph.unresolved.length, 1);
  assert.match(graph.unresolved[0].reason, /escapes/i);
});

test('import cycle detection is deterministic and sorted', () => {
  const files = [
    makeFile('lib/b.dart', "import 'a.dart';\nclass B {}\n"),
    makeFile('lib/a.dart', "import 'b.dart';\nclass A {}\n"),
    makeFile('lib/c.dart', "import 'a.dart';\nimport 'b.dart';\nclass C {}\n"),
  ];
  const graph = buildImportGraph(files, 'myapp');
  assert.deepEqual(graph.importCycles, [['lib/a.dart', 'lib/b.dart']]);
  // Determinism: same input twice yields identical output.
  const again = buildImportGraph([...files].reverse(), 'myapp');
  assert.deepEqual(again.importCycles, [['lib/a.dart', 'lib/b.dart']]);

  const validation = validateDartFiles({
    packageName: 'myapp',
    files: [makeFile('lib/main.dart', VALID_MAIN), ...files],
  });
  const cycles = validation.diagnostics.filter((d) => d.code === 'IMPORT_CYCLE');
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].severity, 'warning'); // cycles do not block (legal in Dart)
});

test('duplicate class across libraries and inside one linked library is flagged', () => {
  const files = [
    makeFile('lib/a.dart', 'class Duplicate {}\n'),
    makeFile('lib/b.dart', 'class Duplicate {}\n'),
  ];
  const result = validateDartFiles({
    packageName: 'myapp',
    files: [makeFile('lib/main.dart', VALID_MAIN), ...files],
  });
  const dups = result.diagnostics.filter((d) => d.code === 'DUPLICATE_DECLARATION');
  assert.equal(dups.length, 1);
  assert.equal(dups[0].path, 'lib/b.dart');

  // Same linked library: owner + part both declare the class.
  const linked = validateDartFiles({
    packageName: 'myapp',
    entrypoint: 'lib/core.dart',
    files: [
      makeFile('lib/core.dart', "part 'core.part.dart';\nclass Shared {}\nvoid main() => runApp(const App());\nclass App {}\n"),
      makeFile('lib/core.part.dart', "part of 'core.dart';\nclass Shared {}\n"),
    ],
  });
  const linkedDups = linked.diagnostics.filter((d) => d.code === 'DUPLICATE_DECLARATION');
  assert.equal(linkedDups.length, 1);
  assert.equal(linkedDups[0].path, 'lib/core.part.dart');

  // Private names in different libraries are not flagged.
  const privates = validateDartFiles({
    packageName: 'myapp',
    files: [
      makeFile('lib/x.dart', 'class _Secret {}\n'),
      makeFile('lib/y.dart', 'class _Secret {}\n'),
      makeFile('lib/main.dart', VALID_MAIN),
    ],
  });
  assert.equal(privates.diagnostics.filter((d) => d.code === 'DUPLICATE_DECLARATION').length, 0);
});

test('missing runApp is a blocker; present runApp passes', () => {
  const noRunApp = validateDartFiles({
    packageName: 'myapp',
    files: [makeFile('lib/main.dart', 'void main() {}\nclass App {}\n')],
  });
  const missingRunApp = noRunApp.diagnostics.find((d) => d.code === 'MISSING_RUN_APP');
  assert.ok(missingRunApp, `expected MISSING_RUN_APP, got: ${JSON.stringify(noRunApp.diagnostics)}`);
  assert.equal(noRunApp.passed, false);

  const missingMain = validateDartFiles({
    packageName: 'myapp',
    files: [makeFile('lib/other.dart', VALID_MAIN)],
  });
  assert.ok(missingMain.diagnostics.some((d) => d.code === 'MISSING_MAIN'));
  assert.equal(missingMain.passed, false);

  const ok = validateDartFiles({
    packageName: 'myapp',
    files: [makeFile('lib/main.dart', VALID_MAIN)],
  });
  assert.equal(ok.diagnostics.filter((d) => d.code === 'MISSING_RUN_APP').length, 0);
  assert.equal(ok.diagnostics.filter((d) => d.code === 'MISSING_MAIN').length, 0);
  assert.equal(ok.passed, true);
});

test('secret detection: live credentials flagged, placeholders and env lookups ignored', () => {
  const openAiKey = 'sk-T3stLiveKey4FlutterForgeProd9988aa';
  const googleKey = `AIza${'1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8'.slice(0, 35)}`;
  const awsKey = 'AKIAQ7RTMRXHZ9LMNOPQ';
  const privateKey = '-----BEGIN PRIVATE KEY-----\nMIIBLAHBLAHBLAHBLAKHBLAHBLAHKHBLA==\n-----END PRIVATE KEY-----';
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sIgPu8S7RNOixT6o6JuU4KPz0Y0vZ8V5K0v1Vl1u0s0';

  const flagged = validateDartFiles({
    packageName: 'myapp',
    files: [
      makeFile('lib/main.dart', VALID_MAIN),
      makeFile('lib/secrets.dart', `class Secrets {
  static const openAi = '${openAiKey}';
  static const google = '${googleKey}';
  static const aws = '${awsKey}';
  static const material = '''${privateKey}''';
  static const token = '${jwt}';
}
`),
    ],
  });
  const secretDiags = flagged.diagnostics.filter((d) => d.code === 'SECRET_IN_CODE');
  assert.ok(secretDiags.length >= 5, `expected >=5 secret diagnostics, got ${JSON.stringify(secretDiags)}`);
  const messages = secretDiags.map((d) => d.message).join(' | ');
  assert.match(messages, /OpenAI/);
  assert.match(messages, /Google/);
  assert.match(messages, /AWS/);
  assert.match(messages, /Private key block/);
  assert.match(messages, /JWT/);

  const placeholders = validateDartFiles({
    packageName: 'myapp',
    files: [
      makeFile('lib/main.dart', VALID_MAIN),
      makeFile('lib/placeholders.dart', `class Placeholders {
  static const openAi = 'sk-your-key-goes-here-000000000000';
  static const google = 'AIza000000000000000000000000000000000';
  static const aws = 'AKIA0000000000000000';
  static const envLookup = String.fromEnvironment('OPENAI_API_KEY');
  static const another = 'YOUR_KEY';
}
`),
    ],
  });
  const placeholderSecrets = placeholders.diagnostics.filter((d) => d.code === 'SECRET_IN_CODE');
  assert.deepEqual(placeholderSecrets, [], `placeholders must not be flagged: ${JSON.stringify(placeholderSecrets)}`);
});

test('environment-variable indirection alone never triggers SECRET_IN_CODE', () => {
  const source = `import 'dart:io';

void main() {
  final key = Platform.environment['OPENAI_API_KEY'];
  final def = String.fromEnvironment('GOOGLE_API_KEY', defaultValue: 'none');
  runApp(App(key, def));
}

class App {
  const App(String? a, String b);
}
`;
  const result = validateDartFiles({
    packageName: 'myapp',
    files: [makeFile('lib/main.dart', source)],
  });
  assert.equal(result.diagnostics.filter((d) => d.code === 'SECRET_IN_CODE').length, 0);
});

test('malformed input never throws and always produces a result', () => {
  const garbageInputs = [
    '',
    '$',
    '$$$$',
    'class {',
    'class }',
    'var x = "unterminated',
    'var y = "interp \${',
    'var z = "interp \${map[}"',
    '/* unterminated comment',
    '/* nested /* deeper } */',
    '}}}}}}',
    '(((((((((((((((((((((((((1',
    '\u0000\u0001\u0002\uFFFF',
    'typedef',
    'extension on',
    'import',
    '}'.repeat(500),
    `final t = "${'a'.repeat(10000)}";`,
    'class A<'.padEnd(2000, '<'),
  ];
  for (const garbage of garbageInputs) {
    assert.doesNotThrow(() => tokenize(garbage));
    assert.doesNotThrow(() => analyzeDart(garbage));
    assert.doesNotThrow(() => validateDartFiles({ packageName: 'myapp', files: [makeFile('lib/main.dart', garbage)] }));
    assert.doesNotThrow(() => buildImportGraph([makeFile('lib/main.dart', garbage)], 'myapp'));
  }
});

test('validation output is capped and deterministic', () => {
  const manyFiles = [makeFile('lib/main.dart', VALID_MAIN)];
  for (let i = 0; i < 250; i++) {
    manyFiles.push(makeFile(`lib/scratch_${String(i).padStart(3, '0')}.dart`, '}\n'));
  }
  const first = validateDartFiles({ packageName: 'myapp', files: manyFiles });
  assert.equal(first.truncated, true);
  assert.equal(first.diagnostics.length, 200);
  assert.ok(first.blockers.length <= 200);
  const second = validateDartFiles({ packageName: 'myapp', files: [...manyFiles].reverse() });
  assert.deepEqual(
    second.diagnostics.map((d) => `${d.path}:${d.line}:${d.column}:${d.code}`),
    first.diagnostics.map((d) => `${d.path}:${d.line}:${d.column}:${d.code}`),
  );
});

test('part directive linkage: missing target and missing part of are reported', () => {
  const missingTarget = validateDartFiles({
    packageName: 'myapp',
    files: [
      makeFile('lib/main.dart', VALID_MAIN),
      makeFile('lib/owner.dart', "part 'owner.part.dart';\nclass Owner {}\n"),
    ],
  });
  assert.ok(
    missingTarget.diagnostics.some((d) => d.code === 'MISSING_PART' && d.message.includes('owner.part.dart')),
    JSON.stringify(missingTarget.diagnostics),
  );

  const missingPartOf = validateDartFiles({
    packageName: 'myapp',
    files: [
      makeFile('lib/main.dart', VALID_MAIN),
      makeFile('lib/owner.dart', "part 'owner.part.dart';\nclass Owner {}\n"),
      makeFile('lib/owner.part.dart', 'class PartClass {}\n'),
    ],
  });
  assert.ok(
    missingPartOf.diagnostics.some((d) => d.code === 'PART_MISSING_OF' && d.path === 'lib/owner.part.dart'),
    JSON.stringify(missingPartOf.diagnostics),
  );
});

test('self-package mismatch reported as warning; foreign package imports do not block', () => {
  const result = validateDartFiles({
    packageName: 'myapp',
    files: [
      makeFile('lib/main.dart', VALID_MAIN),
      makeFile('lib/halluc.dart', "import 'package:production/app.dart';\nclass Uses {\n  final x = app;\n}\n"),
    ],
  });
  const mismatch = result.diagnostics.find((d) => d.code === 'SELF_PACKAGE_MISMATCH');
  assert.ok(mismatch, JSON.stringify(result.diagnostics));
  assert.equal(mismatch.severity, 'warning');
  assert.equal(result.passed, true);
});

test('empty file and comments-only file are reported', () => {
  const result = validateDartFiles({
    packageName: 'myapp',
    files: [
      makeFile('lib/main.dart', VALID_MAIN),
      makeFile('lib/empty.dart', '   \n\n'),
      makeFile('lib/comments_only.dart', '// only a comment\n/* and a block comment */\n'),
    ],
  });
  const empties = result.diagnostics.filter((d) => d.code === 'EMPTY_FILE');
  assert.deepEqual(empties.map((d) => d.path).sort(), ['lib/comments_only.dart', 'lib/empty.dart']);
});
