import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ProjectState, ScreenDefinition } from '../orchestrator/state';
import { runIntegrationAgent, findDartDelimiterIssues } from './integrationAgent';
import { runAppShellAgent } from './appShellAgent';

const { callLLMTextMock } = vi.hoisted(() => ({
  callLLMTextMock: vi.fn(),
}));

vi.mock('./llmClient', () => ({
  callLLMText: callLLMTextMock,
  parseFilesFromLLMOutput: (raw: string) => {
    const files: Array<{ path: string; language: string; content: string }> = [];
    const regex = /\/\/ FILE:\s*(\S+)\s*\n```(?:dart)?\s*([\s\S]*?)```/g;
    for (const match of raw.matchAll(regex)) {
      files.push({ path: match[1], language: 'dart', content: match[2].trim() });
    }
    return files;
  },
  agentModelFor: () => 'test-model',
}));

// ─── Fixtures ────────────────────────────────────────────────────────

function makeScreen(id: string, name: string, route: string, isAuthRequired = false): ScreenDefinition {
  return {
    id,
    name,
    route,
    purpose: `${name} purpose`,
    primaryAction: 'Continue',
    states: { loading: 'spinner', empty: 'CTA', error: 'retry', content: 'list' },
    widgets: ['Card'],
    isAuthRequired,
  };
}

function snakeFileName(name: string): string {
  const base = name.replace(/Screen$/i, '');
  const snake = base
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
  return `${snake || 'home'}_screen.dart`;
}

function screenDart(name: string): string {
  return `import 'package:flutter/material.dart';

class ${name} extends StatelessWidget {
  const ${name}({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold();
  }
}
`;
}

const PUBSPEC = `name: demo
description: Demo app
version: 1.0.0+1

environment:
  sdk: '>=3.3.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  go_router: ^14.6.2
  provider: ^6.1.2
  shared_preferences: ^2.3.2

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^4.0.0

flutter:
  uses-material-design: true
`;

interface StateOptions {
  screens: ScreenDefinition[];
  seedScreens?: ScreenDefinition[];
  tokens?: ProjectState['designTokens'];
}

function stateWith({ screens, seedScreens, tokens }: StateOptions): ProjectState {
  const generatedFiles = new Map<string, { path: string; action: 'created'; language: string; content: string }>();
  for (const screen of seedScreens ?? screens) {
    const fileName = snakeFileName(screen.name);
    const path = `lib/features/${screen.id}/screens/${fileName}`;
    generatedFiles.set(path, { path, action: 'created', language: 'dart', content: screenDart(screen.name) });
  }
  generatedFiles.set('pubspec.yaml', { path: 'pubspec.yaml', action: 'created', language: 'yaml', content: PUBSPEC });

  return {
    projectId: 'p1',
    userPrompt: 'build a demo app',
    status: 'generating',
    productBrief: {
      appName: 'Demo',
      oneLiner: 'A demo app',
      targetAudience: 'testers',
      primaryProblem: 'demo',
      platforms: ['android'],
      constraints: [],
    },
    screenGraph: { screens, userFlows: [] },
    designTokens: tokens === undefined
      ? {
          primaryColor: '#123ABC',
          secondaryColor: '#654DEF',
          accentColor: '#F59E0B',
          backgroundColor: '#FAFAFA',
          surfaceColor: '#FFFFFF',
          fontFamily: 'Inter',
          useMaterial3: true,
          isDarkPreferred: false,
          borderRadius: 16,
        }
      : tokens,
    architectureSpec: {
      stateManagement: 'provider',
      navigationType: 'tabs',
      features: ['home', 'tasks', 'profile'],
      packages: {},
      backendMode: 'none',
    },
    architecture: null,
    dataSchema: null,
    plan: null,
    generatedFiles,
    diagnostics: [],
    repairAttempts: 0,
    logs: [],
  };
}

/** Screens across 3 features with one duplicate route. */
function threeFeaturesWithDuplicate(): ScreenDefinition[] {
  return [
    makeScreen('home', 'HomeScreen', '/'),
    makeScreen('tasks', 'TasksScreen', '/tasks', true),
    makeScreen('profile', 'ProfileScreen', '/profile'),
    // Duplicate of '/tasks' — different screen, same route (also missing leading slash).
    makeScreen('tasks', 'TasksListScreen', 'tasks', true),
  ];
}

function cannedShellOutput(): string {
  const file = (path: string, body: string) => `// FILE: ${path}\n\`\`\`dart\n${body}\n\`\`\``;
  const screen = (cls: string) => `import 'package:flutter/material.dart';

class ${cls} extends StatelessWidget {
  const ${cls}({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(appBar: AppBar(title: Text('${cls}')));
  }
}
`;
  return [
    file('lib/core/services/app_shell_client.dart', `import 'package:flutter/foundation.dart';

class UserProfile {
  const UserProfile({required this.id, required this.name, required this.email});
  final String id;
  final String name;
  final String email;
}

class AppShellClient extends ChangeNotifier {
  AppShellClient._();

  static final AppShellClient instance = AppShellClient._();

  UserProfile? _user;
  bool _onboarded = false;
  bool _notificationsEnabled = true;

  UserProfile? get user => _user;
  bool get isSignedIn => _user != null;
  bool get onboarded => _onboarded;
  set onboarded(bool value) { _onboarded = value; notifyListeners(); }
  bool get notificationsEnabled => _notificationsEnabled;
  set notificationsEnabled(bool value) { _notificationsEnabled = value; notifyListeners(); }
  String? error;

  static void init() {}

  Future<bool> signIn(String email, String password) async => true;
  Future<bool> signUp(String name, String email, String password) async => true;
  Future<void> signOut() async { _user = null; notifyListeners(); }
}
`),
    file('lib/features/onboarding/presentation/onboarding_screen.dart', screen('OnboardingScreen')),
    file('lib/features/auth/presentation/sign_in_screen.dart', `import 'package:flutter/material.dart';
import 'package:demo/core/services/app_shell_client.dart';

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key});

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final TextEditingController _email = TextEditingController();
  final TextEditingController _password = TextEditingController();

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Sign in')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          children: [
            TextField(controller: _email, decoration: const InputDecoration(labelText: 'Email')),
            TextField(controller: _password, decoration: const InputDecoration(labelText: 'Password'), obscureText: true),
            FilledButton(
              onPressed: () => AppShellClient.instance.signIn(_email.text, _password.text),
              child: const Text('Sign in'),
            ),
          ],
        ),
      ),
    );
  }
}
`),
    file('lib/features/auth/presentation/sign_up_screen.dart', screen('SignUpScreen')),
    file('lib/features/auth/presentation/forgot_password_screen.dart', screen('ForgotPasswordScreen')),
    file('lib/features/settings/presentation/settings_screen.dart', screen('SettingsScreen')),
    file('lib/features/account/presentation/account_screen.dart', screen('AccountScreen')),
  ].join('\n\n');
}

const UNIQUE_ROUTES = ['/', '/tasks', '/profile'];

function goRouteBlock(content: string, path: string): string {
  const anchor = content.indexOf(`path: '${path}'`);
  expect(anchor, `expected route ${path} in router`).toBeGreaterThanOrEqual(0);
  const end = content.indexOf('),', anchor);
  return content.slice(Math.max(0, anchor - 200), end === -1 ? anchor + 400 : end + 2);
}

// ─── Integration agent ───────────────────────────────────────────────

describe('runIntegrationAgent', () => {
  beforeEach(() => {
    callLLMTextMock.mockReset();
    callLLMTextMock.mockResolvedValue('');
  });

  it('drops a duplicate route with a diagnostic instead of silently keeping it', async () => {
    const state = stateWith({ screens: threeFeaturesWithDuplicate() });
    const result = await runIntegrationAgent(state);

    const router = result.generatedFiles!.get('lib/core/router/app_router.dart')!.content;
    for (const route of UNIQUE_ROUTES) {
      expect(countOf(router, `path: '${route}'`)).toBe(1);
    }
    // The task-list screen lost the duplicate; /tasks appears exactly once.
    expect(countOf(router, "path: '/tasks'")).toBe(1);

    const duplicate = result.diagnostics!.find((d) => d.gate === 'integration-route-duplicate');
    expect(duplicate).toBeDefined();
    expect(duplicate!.level).toBe('warning');
    expect(duplicate!.message).toContain('/tasks');
  });

  it('references each unique route exactly once in the GoRouter', async () => {
    const state = stateWith({ screens: threeFeaturesWithDuplicate() });
    const result = await runIntegrationAgent(state);
    const router = result.generatedFiles!.get('lib/core/router/app_router.dart')!.content;

    for (const route of UNIQUE_ROUTES) {
      expect(countOf(router, `path: '${route}'`), `route ${route}`).toBe(1);
    }
    expect(router).toContain('ShellRoute');
    expect(router).toContain('final appRouter = GoRouter(');
    expect(findDartDelimiterIssues(router)).toEqual([]);
  });

  it('never marks /auth/login auth-required; protected screens redirect to it', async () => {
    const state = stateWith({ screens: threeFeaturesWithDuplicate() });
    const result = await runIntegrationAgent(state);
    const router = result.generatedFiles!.get('lib/core/router/app_router.dart')!.content;

    const loginBlock = goRouteBlock(router, '/auth/login');
    expect(loginBlock).not.toContain('_requireAuth');
    expect(loginBlock).toContain('_redirectAuthenticatedFromLogin');

    const protectedBlock = goRouteBlock(router, '/tasks');
    expect(protectedBlock).toContain('redirect: _requireAuth');

    const homeBlock = goRouteBlock(router, '/');
    expect(homeBlock).not.toContain('_requireAuth');
  });

  it('reserves /auth/login even when the screenGraph marks it auth-required', async () => {
    const screens = [
      ...threeFeaturesWithDuplicate(),
      makeScreen('auth', 'LegacyLoginScreen', '/auth/login', true),
    ];
    const state = stateWith({ screens, seedScreens: screens });
    const result = await runIntegrationAgent(state);
    const router = result.generatedFiles!.get('lib/core/router/app_router.dart')!.content;

    expect(countOf(router, "path: '/auth/login'")).toBe(1);
    expect(goRouteBlock(router, '/auth/login')).not.toContain('_requireAuth');
    expect(result.diagnostics!.some((d) => d.gate === 'integration-route-reserved')).toBe(true);
  });

  it('does not route features whose screens were not generated in this run', async () => {
    const screens = [
      makeScreen('home', 'HomeScreen', '/'),
      makeScreen('reports', 'ReportsScreen', '/reports'),
    ];
    const state = stateWith({ screens, seedScreens: screens.slice(0, 1) });
    const result = await runIntegrationAgent(state);
    const router = result.generatedFiles!.get('lib/core/router/app_router.dart')!.content;

    expect(router).not.toContain("path: '/reports'");
    expect(result.diagnostics!.some((d) => d.gate === 'integration-route-missing-screen')).toBe(true);
  });

  it('rejects LLM router output that contains placeholders and keeps the deterministic router', async () => {
    callLLMTextMock.mockResolvedValue(`// FILE: lib/core/router/app_router.dart
\`\`\`dart
// TODO: wire routes later
final appRouter = GoRouter(routes: []);
\`\`\`
`);
    const state = stateWith({ screens: threeFeaturesWithDuplicate() });
    const result = await runIntegrationAgent(state);
    const router = result.generatedFiles!.get('lib/core/router/app_router.dart')!.content;

    expect(router).not.toContain('TODO');
    expect(router).toContain('_requireAuth');
    expect(result.diagnostics!.some((d) => d.gate === 'integration-llm-output')).toBe(true);
    expect(findDartDelimiterIssues(router)).toEqual([]);
  });

  it('is deterministic: same input produces byte-identical output', async () => {
    const run = async () => {
      const state = stateWith({ screens: threeFeaturesWithDuplicate() });
      const result = await runIntegrationAgent(state);
      return [...result.generatedFiles!.entries()].map(([path, file]) => [path, file.content]);
    };
    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
  });
});

// ─── App shell agent ─────────────────────────────────────────────────

describe('runAppShellAgent', () => {
  beforeEach(() => {
    callLLMTextMock.mockReset();
    callLLMTextMock.mockResolvedValue('');
  });

  it('app.dart uses routerConfig with no home: property', async () => {
    const base = stateWith({ screens: threeFeaturesWithDuplicate() });
    const integration = await runIntegrationAgent(base);
    const merged = { ...base, ...integration, generatedFiles: integration.generatedFiles! };
    const result = await runAppShellAgent(merged);

    const app = result.generatedFiles!.get('lib/app/app.dart')!.content;
    expect(app).toContain('MaterialApp.router');
    expect(app).toContain('routerConfig: appRouter');
    expect(app).not.toMatch(/\bhome\s*:/);
  });

  it('app_theme.dart sets useMaterial3: true with light + dark themes', async () => {
    const base = stateWith({ screens: threeFeaturesWithDuplicate() });
    const integration = await runIntegrationAgent(base);
    const merged = { ...base, ...integration, generatedFiles: integration.generatedFiles! };
    const result = await runAppShellAgent(merged);

    const theme = result.generatedFiles!.get('lib/app/app_theme.dart')!.content;
    expect(theme).toContain('useMaterial3: true');
    expect(theme).toContain('class AppTheme');
    expect(theme).toContain('lightTheme');
    expect(theme).toContain('darkTheme');
    expect(theme).toContain('ColorScheme.fromSeed');
    // Tokens are honored — the custom primary is used as the seed.
    expect(theme).toContain('0xFF123ABC');
  });

  it('theme falls back safely when design tokens are missing', async () => {
    const base = stateWith({ screens: threeFeaturesWithDuplicate(), tokens: null });
    const result = await runAppShellAgent(base);
    const theme = result.generatedFiles!.get('lib/app/app_theme.dart')!.content;

    expect(theme).toContain('useMaterial3: true');
    expect(theme).toContain('0xFF2563EB'); // pipeline default, never a neon palette
    expect(theme).toContain('ColorScheme.fromSeed');
  });

  it('keeps a conforming LLM sign-in screen at the exact path the router imports', async () => {
    callLLMTextMock.mockResolvedValue(cannedShellOutput());
    const base = stateWith({ screens: threeFeaturesWithDuplicate() });
    const integration = await runIntegrationAgent(base);
    const merged = { ...base, ...integration, generatedFiles: integration.generatedFiles! };
    const result = await runAppShellAgent(merged);

    const signIn = result.generatedFiles!.get('lib/features/auth/presentation/sign_in_screen.dart')!.content;
    expect(signIn).toContain('class SignInScreen extends StatefulWidget');
    const router = result.generatedFiles!.get('lib/core/router/app_router.dart')!.content;
    expect(router).toContain("package:demo/features/auth/presentation/sign_in_screen.dart");
    expect(router).toContain('SignInScreen()');
  });

  it('writes a deterministic sign-in screen when the LLM output is missing', async () => {
    const base = stateWith({ screens: threeFeaturesWithDuplicate() });
    const integration = await runIntegrationAgent(base);
    const merged = { ...base, ...integration, generatedFiles: integration.generatedFiles! };
    const result = await runAppShellAgent(merged);

    const signIn = result.generatedFiles!.get('lib/features/auth/presentation/sign_in_screen.dart')!.content;
    expect(signIn).toContain('class SignInScreen extends StatefulWidget');
    expect(findDartDelimiterIssues(signIn)).toEqual([]);
    expect(signIn).not.toMatch(/TODO|UnimplementedError/);
  });

  it('never emits TODO markers in any generated file', async () => {
    callLLMTextMock.mockResolvedValue(cannedShellOutput());
    const base = stateWith({ screens: threeFeaturesWithDuplicate() });
    const integration = await runIntegrationAgent(base);
    const merged = { ...base, ...integration, generatedFiles: integration.generatedFiles! };
    const result = await runAppShellAgent(merged);

    for (const [path, file] of result.generatedFiles!) {
      expect(file.content, `file ${path}`).not.toMatch(/TODO|FIXME|UnimplementedError/);
    }
  });

  it('is deterministic: same input produces byte-identical shell files', async () => {
    const run = async () => {
      const base = stateWith({ screens: threeFeaturesWithDuplicate() });
      const integration = await runIntegrationAgent(base);
      const merged = { ...base, ...integration, generatedFiles: integration.generatedFiles! };
      const result = await runAppShellAgent(merged);
      return [...result.generatedFiles!.entries()]
        .map(([path, file]) => [path, file.content])
        .sort(([a], [b]) => String(a).localeCompare(String(b)));
    };
    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
  });
});

// ─── Dart delimiter checker ──────────────────────────────────────────

describe('findDartDelimiterIssues', () => {
  it('accepts balanced code', () => {
    const code = `import 'package:flutter/material.dart';

class Demo extends StatelessWidget {
  const Demo({super.key});
  @override
  Widget build(BuildContext context) {
    final items = ['(', ')', '{']; // brackets inside strings and comments are ignored
    return Scaffold(body: Text(items.join('')));
  }
}
`;
    expect(findDartDelimiterIssues(code)).toEqual([]);
  });

  it('rejects unbalanced braces', () => {
    expect(findDartDelimiterIssues('class A { Widget build(BuildContext c) { return const SizedBox(); ').length).toBeGreaterThan(0);
  });

  it('rejects unterminated strings', () => {
    expect(findDartDelimiterIssues("const label = 'oops;\n").length).toBeGreaterThan(0);
  });

  it('ignores braces inside comments', () => {
    expect(findDartDelimiterIssues('// {{{ ((( \nfinal x = 1;')).toEqual([]);
    expect(findDartDelimiterIssues('/* { ( [ */ final x = 1;')).toEqual([]);
  });
});

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
