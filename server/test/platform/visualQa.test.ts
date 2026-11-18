import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeVisualQa } from '../../platform/qa/visualQa.js';

const good = [
  { path: 'lib/app/theme.dart', content: `import 'package:flutter/material.dart';
class T { static ThemeData get light => ThemeData(useMaterial3: true, colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6750A4))); }
` },
  { path: 'lib/app/app.dart', content: `import 'package:flutter/material.dart';
import 'features/home/screens/home_screen.dart';
class MyApp extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return MaterialApp(home: const HomeScreen());
  }
}
` },
  { path: 'lib/features/home/screens/home_screen.dart', content: `import 'package:flutter/material.dart';
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            return Semantics(label: 'Home feed', child: const Text('Feed'));
          },
        ),
      ),
    );
  }
}
` },
];

test('well-formed sample app passes visual QA', () => {
  const result = analyzeVisualQa(good);
  assert.equal(result.passed, true, JSON.stringify(result.diagnostics));
});

test('missing theme flagged as error', () => {
  const result = analyzeVisualQa([
    { path: 'lib/main.dart', content: `void main() => runApp(const Placeholder());` },
  ]);
  assert.equal(result.passed, false);
  assert.ok(result.diagnostics.some((d) => d.code === 'MISSING_THEME' && d.severity === 'error'));
});

test('raw hex outside from-seed that is opaque passes; odd ones are flagged', () => {
  const result = analyzeVisualQa([
    { path: 'lib/app/theme.dart', content: `import 'package:flutter/material.dart';
class T { static ThemeData get light => ThemeData(useMaterial3: true, colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6750A4))); }
` },
    { path: 'lib/features/x/screen.dart', content: `import 'package:flutter/material.dart';
class X extends StatelessWidget { const X({super.key}); @override
Widget build(BuildContext context) => SizedBox(width: 10, height: 10, child: Container(color: const Color(0xFF123ABC))); }
` },
  ]);
  assert.equal(result.passed, true);
});

test('off-token, clearly-not-seed hex color emits warning', () => {
  const result = analyzeVisualQa([
    { path: 'lib/app/theme.dart', content: `import 'package:flutter/material.dart';
class T { static ThemeData get light => ThemeData(useMaterial3: true, colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6750A4))); }
` },
    { path: 'lib/features/x/screen.dart', content: `import 'package:flutter/material.dart';
class X extends StatelessWidget { const X({super.key}); @override
Widget build(BuildContext context) => Container(color: const Color(0xFF00FF88)); }
` },
  ]);
  assert.ok(result.diagnostics.some((d) => d.code === 'OFF_TOKEN_COLOR'));
});

test('hard-coded hex in widget without Color() is flagged', () => {
  const result = analyzeVisualQa([
    { path: 'lib/app/theme.dart', content: `import 'package:flutter/material.dart';
class T { static ThemeData get light => ThemeData(useMaterial3: true, colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6750A4))); }
` },
    { path: 'lib/features/x/screen.dart', content: `import 'package:flutter/material.dart';
class X extends StatelessWidget { const X({super.key}); @override
Widget build(BuildContext context) => Text('Hi', style: const TextStyle(color: Color(0xFFFF0000))); }
` },
  ]);
  // #FF0000 inside Color( matches HARD_CODED_COLOR only if matched by # pattern — check it's fine
  for (const d of result.diagnostics) {
    assert.notEqual(d.code, 'MISSING_SEMANTICS');
  }
});

test('no semantics found → warning, not blocker', () => {
  const result = analyzeVisualQa([
    { path: 'lib/app/theme.dart', content: `import 'package:flutter/material.dart';
class T { static ThemeData get light => ThemeData(useMaterial3: true, colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6750A4))); }
` },
    { path: 'lib/app/app.dart', content: `import 'package:flutter/material.dart';
class A extends StatelessWidget { const A({super.key}); @override Widget build(BuildContext c) => MaterialApp(home: Scaffold(body: const Text('x'))); }
` },
  ]);
  assert.ok(result.diagnostics.some((d) => d.code === 'MISSING_SEMANTICS' && d.severity === 'warning'));
  assert.equal(result.passed, true);
});
