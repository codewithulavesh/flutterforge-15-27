import { describe, expect, it } from 'vitest';
import { enforceProjectContract } from './projectContract';
import { findUnresolvedImports } from '../agent/preWriteValidator';
import type { GeneratedFile } from '../orchestrator/state';

const PKG = 'nova_c7ee1b';

const pubspec = `name: ${PKG}
description: A focused task manager with projects, reminders, and a calm dashboard.
publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: '>=3.3.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  go_router: ^14.6.2
  shared_preferences: ^2.3.2

flutter:
  uses-material-design: true
`;

function file(path: string, content: string): GeneratedFile {
  return { path, content, action: 'created', language: path.endsWith('.yaml') ? 'yaml' : 'dart' };
}

function baseFiles(): Map<string, GeneratedFile> {
  return new Map<string, GeneratedFile>([
    ['pubspec.yaml', file('pubspec.yaml', pubspec)],
    ['lib/main.dart', file('lib/main.dart', `import 'package:${PKG}/app.dart';\n\nvoid main() => runApp(const App());\n`)],
    ['lib/app.dart', file('lib/app.dart', `import 'package:flutter/material.dart';
import 'package:${PKG}/core/theme/app_theme.dart';
import 'package:${PKG}/core/router/app_router.dart';

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(theme: AppTheme.lightTheme, routerConfig: appRouter);
  }
}
`)],
    ['lib/core/theme/app_theme.dart', file('lib/core/theme/app_theme.dart', `import 'package:flutter/material.dart';

class AppTheme {
  static final ThemeData lightTheme = ThemeData(useMaterial3: true);
  static final ThemeData darkTheme = ThemeData(useMaterial3: true, brightness: Brightness.dark);
}
`)],
    ['lib/core/router/app_router.dart', file('lib/core/router/app_router.dart', `import 'package:${PKG}/features/home/screens/home_screen.dart';

final appRouter = createRouter();

dynamic createRouter() => null;
`)],
  ]);
}

function contract(files: Map<string, GeneratedFile>) {
  return enforceProjectContract(files, { pkgName: PKG, appName: 'Nova' });
}

function paths(files: Map<string, GeneratedFile>): string[] {
  return [...files.keys()].sort();
}

describe('enforceProjectContract', () => {
  it('moves the legacy app root and theme to canonical paths', () => {
    const result = contract(baseFiles());

    expect(result.files.has('lib/app.dart')).toBe(false);
    expect(result.files.has('lib/core/theme/app_theme.dart')).toBe(false);
    expect(paths(result.files)).toContain('lib/app/app.dart');
    expect(paths(result.files)).toContain('lib/app/app_theme.dart');
    expect(result.files.get('lib/main.dart')!.content).toContain(`package:${PKG}/app/app.dart`);
    expect(result.files.get('lib/app/app.dart')!.content).toContain(`package:${PKG}/app/app_theme.dart`);
  });

  it('creates the app shell client when shell screens import it', () => {
    const files = new Map(baseFiles());
    files.set(
      'lib/features/auth/presentation/sign_in_screen.dart',
      file(
        'lib/features/auth/presentation/sign_in_screen.dart',
        `import 'package:flutter/material.dart';
import 'package:${PKG}/core/services/app_shell_client.dart';

class SignInScreen extends StatelessWidget {
  const SignInScreen({super.key});

  @override
  Widget build(BuildContext context) => const Scaffold(body: Text('Sign in'));
}
`,
      ),
    );

    const result = contract(files);

    const client = result.files.get('lib/core/services/app_shell_client.dart');
    expect(client).toBeDefined();
    expect(client!.content).toContain('class AppShellClient');
    expect(client!.content).toContain('static void init');
    expect(findUnresolvedImports([...result.files.values()])).toEqual([]);
  });

  it('creates screens the router imports instead of leaving dead imports', () => {
    const files = new Map(baseFiles());
    files.set(
      'lib/core/router/app_router.dart',
      file(
        'lib/core/router/app_router.dart',
        `import 'package:${PKG}/features/board/screens/board_screen.dart';

final appRouter = createRouter();

dynamic createRouter() => null;
`,
      ),
    );

    const result = contract(files);

    const screen = result.files.get('lib/features/board/screens/board_screen.dart');
    expect(screen).toBeDefined();
    expect(screen!.content).toContain('class BoardScreen');
    expect(findUnresolvedImports([...result.files.values()])).toEqual([]);
  });

  it('generates a router with a real home route when none exists', () => {
    const files = new Map(baseFiles());
    files.delete('lib/core/router/app_router.dart');
    files.set(
      'lib/features/dashboard/screens/dashboard_screen.dart',
      file(
        'lib/features/dashboard/screens/dashboard_screen.dart',
        `import 'package:flutter/material.dart';

class DashboardScreen extends StatelessWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context) => const Scaffold(body: Text('Dashboard'));
}
`,
      ),
    );

    const result = contract(files);

    const router = result.files.get('lib/core/router/app_router.dart');
    expect(router).toBeDefined();
    expect(router!.content).toContain('GoRouter(');
    expect(router!.content).toContain(`package:${PKG}/features/dashboard/screens/dashboard_screen.dart`);
    expect(router!.content).toContain("path: '/'");
    expect(result.files.has('lib/features/home/screens/home_screen.dart')).toBe(true);
    expect(findUnresolvedImports([...result.files.values()])).toEqual([]);
  });

  it('leaves a clean project unchanged when run a second time', () => {
    const first = contract(baseFiles());
    const second = enforceProjectContract(first.files, { pkgName: PKG, appName: 'Nova' });

    expect(paths(second.files)).toEqual(paths(first.files));
    for (const [path, file] of first.files) {
      expect(second.files.get(path)!.content).toBe(file.content);
    }
    expect(second.changes).toEqual([]);
  });

  it('reports no unresolved imports for the normalized graph', () => {
    const result = contract(baseFiles());
    expect(result.blockers).toEqual([]);
    expect(findUnresolvedImports([...result.files.values()])).toEqual([]);
  });
});
