import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFiles, balancedDelimiters } from '../../platform/workflow/patchWorkflow.js';

test('dart interpolation with braces and strings stays balanced', () => {
  const source = `
void main() {
  final map = {'}': 'brace', 'x': "y"};
  final label = 'value: \${map['}']} suffix ' + "$";
  final nested = """triple \\\${map['still braces']}""";
  print('\\' | escaped');
}
`;
  const findings = balancedDelimiters(source, 'lib/main.dart', true);
  assert.deepEqual(findings, []);
});

test('one extra closing brace is detected with its line number', () => {
  const findings = balancedDelimiters('class A {\n  void m() {\n  }\n  }\n  }\n', 'lib/a.dart', true);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'DELIMITER_IMBALANCE');
});

test('a single unclosed opening brace is detected', () => {
  const findings = balancedDelimiters('void main() {\n  final x = 1;\n', 'lib/main.dart', true);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'DELIMITER_IMBALANCE');
  assert.equal(findings[0].line, 1);
});

test('an unmatched closing paren is detected', () => {
  const findings = balancedDelimiters('void main() { print(1)); }', 'lib/main.dart', true);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'DELIMITER_IMBALANCE');
});

test('an unterminated string literal is an error', () => {
  const findings = balancedDelimiters("final s = 'abc\nfinal x = 1;\n", 'lib/main.dart', true);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'UNTERMINATED_LITERAL');
});

test('raw strings do not treat quotes as escapes', () => {
  const source = `final raw = r'back\\slash ' and 'quit'; // comment`;
  assert.deepEqual(balancedDelimiters(source, 'lib/raw.dart', true), []);
});

test('block comments nest and delimiters inside are ignored', () => {
  const source = 'void main() { /* outer /* inner } ] ( */ still comment */ print(1); }';
  assert.deepEqual(balancedDelimiters(source, 'lib/comments.dart', true), []);
});

test('secret scan flags live credentials but not placeholders', () => {
  const files = [
    { path: 'lib/config.dart', content: "const key = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789';\n" },
    { path: 'lib/ok.dart', content: "const key = 'YOUR_API_KEY';\nfinal k = Platform.environment['OPENAI_API_KEY'];\n" },
  ];
  const findings = validateFiles(files);
  assert.equal(findings.filter((f) => f.code === 'SECRET_IN_CODE' && f.severity === 'error').length, 1);
});

test('duplicate paths in one patch are an error', () => {
  const findings = validateFiles([
    { path: 'lib/a.dart', content: 'a' },
    { path: 'lib/a.dart', content: 'b' },
  ]);
  assert.ok(findings.some((f) => f.code === 'DUPLICATE_PATH'));
});

test('path traversal in a patch is rejected before any gate runs', () => {
  const findings = validateFiles([{ path: '../../evil.dart', content: 'x' }]);
  assert.ok(findings.some((f) => f.code === 'UNSAFE_PATH'));
});

test('pubspec with an invalid package name is an error', () => {
  const findings = validateFiles([{ path: 'pubspec.yaml', content: 'name: App-Invalid\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n' }]);
  assert.ok(findings.some((f) => f.code === 'PUBSPEC_NAME_INVALID' && f.severity === 'error'));
});

test('a well-formed patch passes the gate', () => {
  const findings = validateFiles([
    { path: 'pubspec.yaml', content: 'name: my_app\n\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\nflutter:\n  uses-material-design: true\n' },
    { path: 'lib/main.dart', content: "void main() { runApp(const SizedBox()); }\n" },
    { path: 'lib/deleted.dart', content: null },
  ]);
  assert.deepEqual(findings, []);
});
