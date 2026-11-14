import { afterEach, describe, expect, it } from 'vitest';
import { validateProjectFiles, pubspecPackageName, declaredDependencies } from './preWriteValidator';

const pubspec = (name: string, extra = '') => `name: ${name}
description: A modern e-commerce app with cart, checkout, and orders.
publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
${extra}
flutter:
  uses-material-design: true
`;

describe('preWriteValidator', () => {
  it('quotes an unsafe description value', () => {
    const files = [
      {
        path: 'pubspec.yaml',
        content: pubspec('shopflow_9d4055').replace(
          'description: A modern e-commerce app with cart, checkout, and orders.',
          'description: A modern e-commerce app: fast cart, checkout & orders with 100% promo codes',
        ),
      },
      { path: 'lib/main.dart', content: 'void main() {}' },
    ];
    const result = validateProjectFiles(files);
    const fix = result.fixes.find((f) => f.path === 'pubspec.yaml');
    expect(fix?.content).toContain('description: "A modern e-commerce app: fast cart, checkout & orders with 100% promo codes"');
  });

  it('rewrites hallucinated package namespaces to the pubspec name', () => {
    const files = [
      { path: 'pubspec.yaml', content: pubspec('shopflow_9d4055') },
      { path: 'lib/main.dart', content: 'import \'package:production/app.dart\';\nvoid main() {}' },
    ];
    const result = validateProjectFiles(files);
    const fix = result.fixes.find((f) => f.path === 'lib/main.dart');
    expect(fix?.content).toContain("package:shopflow_9d4055/app.dart");
  });

  it('injects missing known dependencies (provider) from imports', () => {
    const files = [
      { path: 'pubspec.yaml', content: pubspec('shopflow_9d4055') },
      {
        path: 'lib/main.dart',
        content: 'import \'package:provider/provider.dart\';\nvoid main() { Provider.of(context); }',
      },
    ];
    const result = validateProjectFiles(files);
    const pubspecFix = result.fixes.find((f) => f.path === 'pubspec.yaml');
    expect(pubspecFix?.content).toContain('provider: ^6.1.2');
    expect(pubspecFix?.content).toContain('flutter:\n    sdk: flutter');
  });

  it('rewrites an app-namespace import to the closest existing file', () => {
    const files = [
      { path: 'pubspec.yaml', content: pubspec('shopflow_9d4055') },
      { path: 'lib/providers/app_provider.dart', content: 'class AppProvider {}' },
      { path: 'lib/main.dart', content: 'import \'package:shopflow_9d4055/provider.dart\';\nvoid main() {}' },
    ];
    const result = validateProjectFiles(files);
    const fix = result.fixes.find((f) => f.path === 'lib/main.dart');
    expect(fix?.content).toContain("package:shopflow_9d4055/providers/app_provider.dart");
  });

  it('reports an unresolvable app import as an issue instead of guessing', () => {
    const files = [
      { path: 'pubspec.yaml', content: pubspec('shopflow_9d4055') },
      { path: 'lib/main.dart', content: 'import \'package:shopflow_9d4055/screens/ghost_screen.dart\';\nvoid main() {}' },
    ];
    const result = validateProjectFiles(files);
    expect(result.issues.some((i) => i.message.includes('ghost_screen.dart'))).toBe(true);
  });

  it('normalizes an invalid pubspec package name and rewrites imports', () => {
    const files = [
      { path: 'pubspec.yaml', content: pubspec('ShopFlow App') },
      { path: 'lib/main.dart', content: 'import \'package:production/app.dart\';\nvoid main() {}' },
    ];
    const result = validateProjectFiles(files);
    const pubspecFix = result.fixes.find((f) => f.path === 'pubspec.yaml');
    expect(pubspecFix?.content).toMatch(/^name: shopflow_app$/m);
    expect(pubspecPackageName(pubspecFix!.content)).toBe('shopflow_app');
    const dartFix = result.fixes.find((f) => f.path === 'lib/main.dart');
    expect(dartFix?.content).toContain('package:shopflow_app/app.dart');
  });

  it('parses declared dependencies correctly', () => {
    const text = pubspec('demo', '  provider: ^6.1.2\n  go_router: ^14.6.2\n');
    expect(declaredDependencies(text)).toEqual(new Set(['flutter', 'provider', 'go_router']));
  });
});

describe('artifact gate', () => {
  const clean = () => [
    { path: 'pubspec.yaml', content: 'name: demo_9d4055\ndescription: ok\npublish_to: none\nversion: 1.0.0+1\n\ndependencies:\n  flutter:\n    sdk: flutter\nflutter:\n  uses-material-design: true\n' },
    { path: 'lib/main.dart', content: 'void main() { print("ok"); }' },
  ];

  it('passes a clean project', () => {
    expect(validateProjectFiles(clean()).gate.passed).toBe(true);
  });

  it('fails when lib/main.dart is missing', () => {
    const files = clean().filter((f) => f.path !== 'lib/main.dart');
    const gate = validateProjectFiles(files).gate;
    expect(gate.passed).toBe(false);
    expect(gate.blockers.join('\n')).toMatch(/lib\/main\.dart/);
  });

  it('fails on truncated Dart (unbalanced braces)', () => {
    const files = [
      ...clean().filter((f) => f.path !== 'lib/main.dart'),
      { path: 'lib/main.dart', content: 'class App extends StatelessWidget {\n  Widget build() {\n    return Container(\n' },
    ];
    const gate = validateProjectFiles(files).gate;
    expect(gate.passed).toBe(false);
    expect(gate.blockers.join('\n')).toMatch(/unbalanced delimiters/);
  });

  it('fails on unresolved app-namespace imports', () => {
    const files = [
      ...clean(),
      { path: 'lib/screens/home.dart', content: 'import \'package:demo_9d4055/screens/ghost_screen.dart\';' },
    ];
    const gate = validateProjectFiles(files).gate;
    expect(gate.passed).toBe(false);
    expect(gate.blockers.join('\n')).toMatch(/ghost_screen/);
  });
});
