import type { ProjectState, GeneratedFile, GateDiagnostic } from '../orchestrator/state';
import { callLLMText, parseFilesFromLLMOutput, agentModelFor } from './llmClient';

const LOGIN_ROUTE = '/auth/login';
const ROUTER_PATH = 'lib/core/router/app_router.dart';
const APP_ROOT_PATH = 'lib/app/app.dart';
const MAIN_PATH = 'lib/main.dart';

export async function runIntegrationAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const appName = state.productBrief?.appName || 'App';
  const pkgName = toPackageName(appName);
  const screens = state.screenGraph?.screens || [];
  const arch = state.architectureSpec || state.architecture;
  const needsSupabase = arch?.backendMode === 'supabase';
  const files = new Map<string, GeneratedFile>(state.generatedFiles ?? []);
  const navType = (state as Record<string, unknown>)._uxNavigation as string
    || arch?.navigationType
    || 'bottom_tabs';
  const diagnostics: GateDiagnostic[] = [];

  // ── 1. Normalize + dedupe screenGraph routes ──────────────────────
  // Every screen route in the router comes from screenGraph.screens[].route —
  // never from anything else. Paths are normalized (leading slash, no trailing
  // slash, unique). Duplicates are dropped with a diagnostic, never silently.
  const { routes, routeDiagnostics } = resolveScreenRoutes(screens, files);
  diagnostics.push(...routeDiagnostics);

  const tabLikeNav = /tab/i.test(navType);
  const tabRoutes = tabLikeNav ? routes.filter((route) => !routeHasPathParams(route.path)).slice(0, 5) : [];
  const homeRoute = tabRoutes[0]?.path ?? routes[0]?.path ?? LOGIN_ROUTE;

  // ── 2. LLM generation (validated; rejected output falls back) ─────
  let raw = '';
  try {
    raw = await callLLMText(
      [
        {
          role: 'system',
          content: `You are a senior Flutter integration developer. Generate production-quality Dart code.

RULES:
1. Use go_router for all navigation (ShellRoute for tabs, GoRoute for stack navigation)
2. Use Provider or Riverpod for state — consistent with the app's chosen state management
3. main.dart: initialize Supabase if needed, set up providers, run app
4. app.dart: MaterialApp.router with GoRouter, theme, providers. Never a home: property.
5. router.dart: complete GoRouter config with all routes, redirects for auth if needed
6. Navigation bar (tabs): NavigationBar widget with destinations for main screens
7. All imports must be correct and complete, resolving to files that exist in the project
8. No debug prints except initialization ones. No placeholders. No stub bodies.
9. The /auth/login route is never auth-required. Logged-in users hitting /auth/login go to the home route.
10. Every auth-required screen redirects unauthenticated users to /auth/login.

Output format:
// FILE: lib/core/router/app_router.dart
\`\`\`dart
...full Dart router code...
\`\`\`

// FILE: lib/app/app.dart
\`\`\`dart
...full Dart app code...
\`\`\`

// FILE: lib/main.dart
\`\`\`dart
...full Dart main code...
\`\`\``,
        },
        {
          role: 'user',
          content: `Generate the integration layer for "${appName}" (package: ${pkgName}).

Navigation type: ${navType}
State management: ${arch?.stateManagement || 'provider'}
Needs Supabase auth: ${needsSupabase}
Primary color: ${state.designTokens?.primaryColor || '#2563EB'}

Routes to implement:
${routes.map((r) => `  ${r.path} → ${r.screenClass} (auth required: ${r.isAuthRequired})`).join('\n')}
  /auth/login → SignInScreen (never auth required; logged-in users redirect to ${homeRoute})

Main tabs (bottom nav, max 5): ${tabRoutes.map((r) => r.screenClass).join(', ') || 'none — stack navigation'}

Generate:
1. app_router.dart — complete GoRouter with ${needsSupabase ? 'auth redirect guard' : 'simple routing'}
2. app.dart — MaterialApp.router with theme, providers wrap. No home: property.
3. main.dart — WidgetsFlutterBinding, ${needsSupabase ? 'Supabase.initialize(), ' : ''}runApp

${needsSupabase ? `
Supabase init in main.dart:
await Supabase.initialize(
  url: const String.fromEnvironment('SUPABASE_URL', defaultValue: ''),
  anonKey: const String.fromEnvironment('SUPABASE_ANON_KEY', defaultValue: ''),
);` : ''}`,
        },
      ],
      {
        model: agentModelFor('integration'),
        temperature: 0.15,
        maxTokens: 5000,
      }
    );
  } catch (err) {
    console.warn('[IntegrationAgent] LLM failed, using structural fallback:', err);
    raw = '';
  }

  const parsed = parseFilesFromLLMOutput(raw);

  const llmRouterRejected: string[] = [];
  for (const f of parsed) {
    if (typeof f.path !== 'string') continue;
    const cleanContent = f.content
      .replace(/^```(?:dart)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    const canonical = canonicalizeIntegrationPath(f.path);

    if (FORBIDDEN_OUTPUT.test(cleanContent)) {
      diagnostics.push({
        gate: 'integration-llm-output',
        level: 'warning',
        message: `LLM file ${f.path} contained placeholder markers; it was discarded.`,
        filePath: canonical,
        suggestion: 'Regenerate the file or rely on the deterministic fallback.',
      });
      continue;
    }

    if (canonical === ROUTER_PATH && !isUsableRouter(cleanContent, routes)) {
      llmRouterRejected.push('app_router.dart failed validation (missing route references, or unbalanced delimiters)');
      continue;
    }
    if (canonical === APP_ROOT_PATH && !isUsableAppRoot(cleanContent)) {
      llmRouterRejected.push('app.dart failed validation (needs MaterialApp.router + routerConfig, no home:)');
      continue;
    }
    if (canonical === MAIN_PATH && !isUsableMain(cleanContent)) {
      llmRouterRejected.push('main.dart failed validation (needs runApp())');
      continue;
    }

    files.set(canonical, {
      path: canonical,
      action: 'created',
      language: 'dart',
      content: cleanContent,
    });
  }

  if (llmRouterRejected.length > 0) {
    diagnostics.push({
      gate: 'integration-llm-output',
      level: 'warning',
      message: `Discarded invalid LLM output: ${llmRouterRejected.join('; ')}. Deterministic fallback was used instead.`,
      filePath: ROUTER_PATH,
      suggestion: 'Fix the generator prompt or let the deterministic fallback run.',
    });
  }

  // ── 3. Deterministic fallbacks for the three critical files ───────
  const routerFallback = generateRouterFallback(pkgName, routes, tabRoutes, tabLikeNav, homeRoute);
  const appFallback = generateAppFallback(pkgName, appName);
  const mainFallback = generateMainFallback(pkgName, needsSupabase);

  if (!files.has(ROUTER_PATH)) {
    files.set(ROUTER_PATH, {
      path: ROUTER_PATH,
      action: 'created',
      language: 'dart',
      content: routerFallback,
    });
  }

  if (!files.has(APP_ROOT_PATH)) {
    files.set(APP_ROOT_PATH, {
      path: APP_ROOT_PATH,
      action: 'created',
      language: 'dart',
      content: appFallback,
    });
  }

  if (!files.has(MAIN_PATH)) {
    files.set(MAIN_PATH, {
      path: MAIN_PATH,
      action: 'created',
      language: 'dart',
      content: mainFallback,
    });
  }

  // ── 4. Hard validation of the emitted critical files ──────────────
  // Fail loudly rather than emit corrupt Dart. Deterministic content passes
  // by construction; anything that reached this point from an LLM has already
  // been validated above, so a failure here means a generator bug.
  for (const critical of [ROUTER_PATH, APP_ROOT_PATH, MAIN_PATH]) {
    const file = files.get(critical);
    if (!file) {
      throw new Error(`[IntegrationAgent] ${critical} was not generated.`);
    }
    const issues = findDartDelimiterIssues(file.content);
    if (issues.length > 0) {
      throw new Error(`[IntegrationAgent] ${critical} failed Dart delimiter validation: ${issues.join('; ')}`);
    }
    if (FORBIDDEN_OUTPUT.test(file.content)) {
      throw new Error(`[IntegrationAgent] ${critical} contains placeholder markers. Refusing to emit corrupt output.`);
    }
  }

  return {
    generatedFiles: files,
    diagnostics: [...state.diagnostics, ...diagnostics],
    logs: [
      ...state.logs,
      `[Integration Agent] Wired ${routes.length} routes via GoRouter (${screens.length} declared, ${screens.length - routes.length} dropped — see diagnostics). Nav: ${navType}. AI files: ${parsed.length}. Supabase init: ${needsSupabase}`,
    ],
  };
}

// ─── Route normalization & screen resolution ─────────────────────────

interface ResolvedRoute {
  /** Route name derived from the screen definition (tab labels). */
  name: string;
  /** Normalized path: leading slash, no trailing slash, unique per app. */
  path: string;
  /** Widget class actually declared by the generated screen file. */
  screenClass: string;
  /** package: import path without the leading `package:` / `lib/` prefix. */
  importPath: string;
  isAuthRequired: boolean;
}

/** Leading slash, collapsed slashes, no trailing slash (root stays `/`). */
export function normalizeRoutePath(raw: string): string {
  let path = (raw ?? '').trim();
  if (path.length === 0) return '/';
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path.length === 0 ? '/' : path;
}

const PATH_PARAM = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/** Path parameters must be unique within a route; renames emit an issue. */
function ensureUniquePathParams(path: string, issues: GateDiagnostic[]): string {
  const seen = new Map<string, number>();
  const next = path.replace(PATH_PARAM, (match, name: string) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) return match;
    const unique = `${name}_${count + 1}`;
    issues.push({
      gate: 'integration-route-normalization',
      level: 'warning',
      message: `Duplicate path parameter ":${name}" in route "${path}" renamed to ":${unique}".`,
      filePath: ROUTER_PATH,
      suggestion: 'Use unique parameter names per route.',
    });
    return `:${unique}`;
  });
  return next;
}

function routeHasPathParams(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith(':'));
}

function toPackageName(appName: string): string {
  return appName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'app';
}

/** Same naming as the frontend builder: always `<name>_screen.dart`. */
function screenFileName(name: string): string {
  const base = name.replace(/Screen$/i, '');
  const snake = base
    .replace(/([A-Z])/g, (m, _, i) => (i === 0 ? m.toLowerCase() : `_${m.toLowerCase()}`))
    .replace(/^_+|_+$/g, '');
  return `${snake || 'home'}_screen.dart`;
}

function featureNameFor(screen: { id: string; name: string }): string {
  return screen.id || screen.name.replace(/Screen$/i, '').toLowerCase();
}

function classFromDartContent(content: string): string | null {
  const match = content.match(/\bclass\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+(?:StatelessWidget|StatefulWidget)\b/);
  return match?.[1] ?? null;
}

function pascalFromFileName(fileName: string): string {
  const base = fileName.replace(/\.dart$/, '').replace(/_screen$/, '');
  const name = base
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `${/^[A-Z]/.test(name) ? name : `App${name}`}Screen`;
}

/**
 * Resolve the screen file this run actually generated for a ScreenDefinition.
 * Never routes a feature whose screens were not generated.
 */
function resolveScreenFile(
  screen: { id: string; name: string },
  files: Map<string, GeneratedFile>,
): { path: string; className: string } | null {
  const featureName = featureNameFor(screen);
  const fileName = screenFileName(screen.name);
  const expected = `lib/features/${featureName}/screens/${fileName}`;

  let path = expected;
  let file = files.get(expected);
  if (!file) {
    const match = [...files.keys()].find((key) => key.endsWith(`/screens/${fileName}`));
    if (match) {
      path = match;
      file = files.get(match);
    }
  }
  if (!file) return null;

  const className = classFromDartContent(file.content) ?? pascalFromFileName(path.split('/').pop() ?? fileName);
  return { path, className };
}

function resolveScreenRoutes(
  screens: Array<{ id: string; name: string; route: string; isAuthRequired?: boolean }>,
  files: Map<string, GeneratedFile>,
): { routes: ResolvedRoute[]; routeDiagnostics: GateDiagnostic[] } {
  const routeDiagnostics: GateDiagnostic[] = [];
  const routes: ResolvedRoute[] = [];
  const seen = new Set<string>();

  for (const screen of screens) {
    const rawRoute = typeof screen.route === 'string' ? screen.route : '';
    const paramIssues: GateDiagnostic[] = [];
    const path = ensureUniquePathParams(normalizeRoutePath(rawRoute), paramIssues);
    routeDiagnostics.push(...paramIssues);

    if (rawRoute.trim().length === 0) {
      routeDiagnostics.push({
        gate: 'integration-route-normalization',
        level: 'warning',
        message: `Screen "${screen.name}" had an empty route; it was normalized to "/".`,
        filePath: ROUTER_PATH,
        suggestion: 'Give every screen an explicit route.',
      });
    }

    if (path === LOGIN_ROUTE) {
      routeDiagnostics.push({
        gate: 'integration-route-reserved',
        level: 'warning',
        message: `Route "${LOGIN_ROUTE}" is reserved for the auth shell and is never auth-required; the screenGraph entry for "${screen.name}" was skipped.`,
        filePath: ROUTER_PATH,
        suggestion: 'Route auth screens through the app shell instead of screenGraph.',
      });
      continue;
    }

    if (seen.has(path)) {
      routeDiagnostics.push({
        gate: 'integration-route-duplicate',
        level: 'warning',
        message: `Duplicate route "${path}" (screen "${screen.name}") was dropped; the first definition wins.`,
        filePath: ROUTER_PATH,
        suggestion: 'Give each screen a unique route.',
      });
      continue;
    }
    seen.add(path);

    const resolved = resolveScreenFile(screen, files);
    if (!resolved) {
      routeDiagnostics.push({
        gate: 'integration-route-missing-screen',
        level: 'warning',
        message: `Screen "${screen.name}" (${path}) has no generated screen file in this run; the route was not added.`,
        filePath: ROUTER_PATH,
        suggestion: 'Generate the feature screens before wiring the router.',
      });
      continue;
    }

    routes.push({
      name: screen.name.replace(/Screen$/i, '') || screen.name,
      path,
      screenClass: resolved.className,
      importPath: resolved.path.replace(/^lib\//, ''),
      isAuthRequired: screen.isAuthRequired === true,
    });
  }

  return { routes, routeDiagnostics };
}

// ─── LLM output validation ───────────────────────────────────────────

const FORBIDDEN_OUTPUT = /TODO|FIXME|UnimplementedError|not implemented|coming soon/i;
const MATERIAL_APP = /\bMaterialApp\b/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(haystack: string, needle: RegExp): number {
  return (haystack.match(needle) ?? []).length;
}

function isUsableRouter(content: string, routes: ResolvedRoute[]): boolean {
  if (FORBIDDEN_OUTPUT.test(content)) return false;
  if (findDartDelimiterIssues(content).length > 0) return false;
  for (const route of routes) {
    if (countOccurrences(content, new RegExp(`path:\\s*'${escapeRegExp(route.path)}'`, 'g')) !== 1) {
      return false;
    }
  }
  if (countOccurrences(content, new RegExp(`path:\\s*'${escapeRegExp(LOGIN_ROUTE)}'`, 'g')) !== 1) {
    return false;
  }
  if (/\bhome\s*:/.test(content)) return false;
  return true;
}

function isUsableAppRoot(content: string): boolean {
  if (FORBIDDEN_OUTPUT.test(content)) return false;
  if (findDartDelimiterIssues(content).length > 0) return false;
  if (!MATERIAL_APP.test(content)) return false;
  if (!/routerConfig\s*:/.test(content)) return false;
  if (/\bhome\s*:/.test(content)) return false;
  return true;
}

function isUsableMain(content: string): boolean {
  if (FORBIDDEN_OUTPUT.test(content)) return false;
  if (findDartDelimiterIssues(content).length > 0) return false;
  return /\brunApp\s*\(/.test(content);
}

// ─── Deterministic generators ────────────────────────────────────────

function escapeDartString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/[\x00-\x1F\x7F]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function dartString(value: string): string {
  return `'${escapeDartString(value)}'`;
}

function tabLabel(screenName: string): string {
  const base = screenName.replace(/Screen$/i, '');
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!words) return 'Tab';
  return words
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function uniqueTabLabels(routes: ResolvedRoute[]): string[] {
  const used = new Map<string, number>();
  return routes.map((route) => {
    const base = tabLabel(route.name);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base} ${seen + 1}`;
  });
}

const TAB_ICONS = [
  'Icons.home_rounded',
  'Icons.search_rounded',
  'Icons.add_circle_rounded',
  'Icons.person_rounded',
  'Icons.settings_rounded',
];

function generateRouterFallback(
  pkgName: string,
  routes: ResolvedRoute[],
  tabRoutes: ResolvedRoute[],
  tabLikeNav: boolean,
  homeRoute: string,
): string {
  const emitShell = tabLikeNav && tabRoutes.length > 0;
  const screenImports = [...routes]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((route) => `import 'package:${pkgName}/${route.importPath}';`)
    .join('\n');

  const shellRoutes = new Set(tabRoutes);
  const stackOnly = routes.filter((route) => !shellRoutes.has(route));

  const tabLabels = uniqueTabLabels(tabRoutes);
  const tabDestinations = tabRoutes
    .map((route, index) => `  (route: ${dartString(route.path)}, label: ${dartString(tabLabels[index])}, icon: ${TAB_ICONS[index] ?? 'Icons.circle_rounded'}),`)
    .join('\n');

  const shellChild = (route: ResolvedRoute, indent: string) => `${indent}GoRoute(
${indent}  path: ${dartString(route.path)},
${route.isAuthRequired ? `${indent}  redirect: _requireAuth,\n` : ''}${indent}  pageBuilder: (context, state) => NoTransitionPage(
${indent}    child: ${route.screenClass}(),
${indent}  ),
${indent}),`;

  const stackChild = (route: ResolvedRoute, indent: string) => `${indent}GoRoute(
${indent}  path: ${dartString(route.path)},
${route.isAuthRequired ? `${indent}  redirect: _requireAuth,\n` : ''}${indent}  builder: (context, state) => const ${route.screenClass}(),
${indent}),`;

  return `import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:${pkgName}/core/services/app_shell_client.dart';
import 'package:${pkgName}/features/auth/presentation/sign_in_screen.dart';
${screenImports}

final _rootNavigatorKey = GlobalKey<NavigatorState>();
${emitShell ? 'final _shellNavigatorKey = GlobalKey<NavigatorState>();\n' : ''}
/// The login route is never auth-required.
const String _loginRoute = ${dartString(LOGIN_ROUTE)};
/// Home route for the authenticated shell.
const String _homeRoute = ${dartString(homeRoute)};

${emitShell ? `/// Shell tabs (max 5), unique label and icon.\nconst List<({String route, String label, IconData icon})> _kShellTabs = [\n${tabDestinations}\n];\n\n` : ''}/// Unauthenticated users hitting auth-required screens go to /auth/login.
String? _requireAuth(BuildContext context, GoRouterState state) {
  return AppShellClient.instance.isSignedIn ? null : _loginRoute;
}

/// Logged-in users hitting /auth/login go to the home route (shell).
String? _redirectAuthenticatedFromLogin(BuildContext context, GoRouterState state) {
  if (!AppShellClient.instance.isSignedIn) return null;
  return _homeRoute == _loginRoute ? null : _homeRoute;
}

final appRouter = GoRouter(
  navigatorKey: _rootNavigatorKey,
  initialLocation: ${dartString(routes.some((route) => route.path === '/') ? '/' : homeRoute)},
  debugLogDiagnostics: false,
  routes: [
    GoRoute(
      path: ${dartString(LOGIN_ROUTE)},
      redirect: _redirectAuthenticatedFromLogin,
      builder: (context, state) => const SignInScreen(),
    ),
${emitShell ? `    ShellRoute(
      navigatorKey: _shellNavigatorKey,
      builder: (context, state, child) => AppShell(child: child),
      routes: [
${tabRoutes.map((route) => shellChild(route, '        ')).join('\n')}
      ],
    ),
` : ''}${stackOnly.length > 0 ? `${stackOnly.map((route) => stackChild(route, '    ')).join('\n')}\n` : ''}  ],
);
${emitShell ? `
class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.child});

  final Widget child;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int _selectedIndex = 0;

  void _onDestinationSelected(int index) {
    setState(() => _selectedIndex = index);
    context.go(_kShellTabs[index].route);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: widget.child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _selectedIndex,
        onDestinationSelected: _onDestinationSelected,
        destinations: _kShellTabs
            .map((tab) => NavigationDestination(
                  icon: Icon(tab.icon),
                  label: tab.label,
                ))
            .toList(),
      ),
    );
  }
}
` : ''}`;
}

function generateAppFallback(pkgName: string, appName: string): string {
  return `import 'package:flutter/material.dart';
import 'package:${pkgName}/app/app_theme.dart';
import 'package:${pkgName}/core/router/app_router.dart';

/// Root widget. Wired to the GoRouter — no hardcoded home: route.
class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: ${dartString(appName)},
      debugShowCheckedModeBanner: false,
      theme: AppTheme.lightTheme,
      darkTheme: AppTheme.darkTheme,
      themeMode: ThemeMode.system,
      routerConfig: appRouter,
    );
  }
}
`;
}

function generateMainFallback(pkgName: string, needsSupabase: boolean): string {
  if (needsSupabase) {
    return `import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:${pkgName}/app/app.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Supabase.initialize(
    url: const String.fromEnvironment('SUPABASE_URL', defaultValue: ''),
    anonKey: const String.fromEnvironment('SUPABASE_ANON_KEY', defaultValue: ''),
  );
  runApp(const App());
}
`;
  }
  return `import 'package:flutter/material.dart';
import 'package:${pkgName}/app/app.dart';

void main() {
  runApp(const App());
}
`;
}

// ─── Local Dart syntax check (delimiter balance) ────────────────────

/**
 * Local, dependency-free sanity check for generated Dart. Strips strings and
 * comments, then verifies that (), {} and [] are balanced. Returns a list of
 * human-readable issues (empty when the file looks structurally sound).
 */
export function findDartDelimiterIssues(content: string): string[] {
  const issues: string[] = [];
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let i = 0;
  let line = 1;
  const n = content.length;

  const advanceLines = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) {
      if (content.charCodeAt(k) === 10) line += 1;
    }
  };

  while (i < n) {
    const ch = content[i];

    // Line comment
    if (ch === '/' && content[i + 1] === '/') {
      let j = i + 2;
      while (j < n && content[j] !== '\n') j += 1;
      advanceLines(i, j);
      i = j;
      continue;
    }

    // Block comment (Dart block comments nest)
    if (ch === '/' && content[i + 1] === '*') {
      const startLine = line;
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (content[j] === '/' && content[j + 1] === '*') { depth += 1; j += 2; continue; }
        if (content[j] === '*' && content[j + 1] === '/') { depth -= 1; j += 2; continue; }
        j += 1;
      }
      if (depth > 0) {
        issues.push(`Unterminated block comment starting at line ${startLine}`);
        advanceLines(i, n);
        i = n;
        continue;
      }
      advanceLines(i, j);
      i = j;
      continue;
    }

    // String literals (single/double quoted, raw strings, triple-quoted)
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const triple = content.startsWith(quote.repeat(3), i) ? quote.repeat(3) : quote;
      const raw = i > 0 && (content[i - 1] === 'r' || content[i - 1] === 'R');
      const startLine = line;
      let j = i + triple.length;
      let closed = false;
      while (j < n) {
        const c = content[j];
        if (!raw && c === '\\' && triple.length === 1) { j += 2; continue; }
        if (content.startsWith(triple, j)) { closed = true; j += triple.length; break; }
        if (triple.length === 1 && c === '\n') break;
        j += 1;
      }
      if (!closed) {
        issues.push(`Unterminated string literal starting at line ${startLine}`);
        advanceLines(i, n);
        i = n;
        continue;
      }
      advanceLines(i, j);
      i = j;
      continue;
    }

    if (ch === '\n') line += 1;
    else if (ch === '(') paren += 1;
    else if (ch === ')') paren -= 1;
    else if (ch === '{') brace += 1;
    else if (ch === '}') brace -= 1;
    else if (ch === '[') bracket += 1;
    else if (ch === ']') bracket -= 1;

    if (paren < 0) { issues.push(`Unmatched ')' at line ${line}`); paren = 0; }
    if (brace < 0) { issues.push(`Unmatched '}' at line ${line}`); brace = 0; }
    if (bracket < 0) { issues.push(`Unmatched ']' at line ${line}`); bracket = 0; }

    i += 1;
  }

  if (paren !== 0) issues.push(`Unbalanced parentheses (net ${paren > 0 ? 'unclosed' : 'extra'} ${Math.abs(paren)})`);
  if (brace !== 0) issues.push(`Unbalanced braces (net ${brace > 0 ? 'unclosed' : 'extra'} ${Math.abs(brace)})`);
  if (bracket !== 0) issues.push(`Unbalanced brackets (net ${bracket > 0 ? 'unclosed' : 'extra'} ${Math.abs(bracket)})`);

  return issues;
}

/** Force LLM-emitted integration files onto the canonical contract paths. */
function canonicalizeIntegrationPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('app_router')) return ROUTER_PATH;
  if (normalized.includes('app_theme')) return 'lib/app/app_theme.dart';
  if (normalized.includes('app_shell') || /\/app\.dart$/.test(normalized) || normalized === 'app.dart') {
    return APP_ROOT_PATH;
  }
  if (normalized.endsWith('main.dart')) return MAIN_PATH;
  if (normalized.includes('/screens/') || normalized.includes('/widgets/')) return rawPath.replace(/\\/g, '/');
  return rawPath.replace(/\\/g, '/');
}
