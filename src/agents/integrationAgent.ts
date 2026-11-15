import type { ProjectState, GeneratedFile } from '../orchestrator/state';
import { callLLMText, parseFilesFromLLMOutput, agentModelFor } from './llmClient';

export async function runIntegrationAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const appName = state.productBrief?.appName || 'App';
  const pkgName = appName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
  const screens = state.screenGraph?.screens || [];
  const arch = state.architectureSpec;
  const needsSupabase = arch?.backendMode === 'supabase';
  const files = new Map<string, GeneratedFile>(state.generatedFiles);
  const navType = (state as Record<string, unknown>)._uxNavigation as string || 'bottom_tabs';

  // Build route list for GoRouter
  const routes = screens.map((s) => ({
    name: s.id || s.name.replace('Screen', '').toLowerCase(),
    path: s.route,
    screen: s.name,
    isAuthRequired: s.isAuthRequired || false,
  }));

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
4. app.dart (or app_shell.dart): MaterialApp.router with GoRouter, theme, providers
5. router.dart: complete GoRouter config with all routes, redirects for auth if needed
6. Navigation bar (tabs): NavigationBar widget with destinations for main screens
7. All imports must be correct and complete
8. No debug prints except initialization ones

Output format:
// FILE: lib/app/app_router.dart
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
${routes.map((r) => `  ${r.path} → ${r.screen} (auth required: ${r.isAuthRequired})`).join('\n')}

Main tabs (bottom nav): ${routes.filter((_, i) => i < 4).map((r) => r.screen).join(', ')}

Generate:
1. app_router.dart — complete GoRouter with ${needsSupabase ? 'auth redirect guard' : 'simple routing'}
2. app.dart — MaterialApp.router with theme, providers wrap
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
  for (const f of parsed) {
    const cleanContent = f.content
      .replace(/^```(?:dart)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    files.set(f.path, {
      path: f.path,
      action: 'created',
      language: 'dart',
      content: cleanContent,
    });
  }

  // Always ensure the 3 critical integration files exist
  if (!files.has('lib/core/router/app_router.dart')) {
    files.set('lib/core/router/app_router.dart', {
      path: 'lib/core/router/app_router.dart',
      action: 'created',
      language: 'dart',
      content: generateRouterFallback(pkgName, routes, navType, needsSupabase),
    });
  }

  if (!files.has('lib/app.dart')) {
    files.set('lib/app.dart', {
      path: 'lib/app.dart',
      action: 'created',
      language: 'dart',
      content: generateAppFallback(pkgName, appName, arch?.stateManagement || 'provider'),
    });
  }

  if (!files.has('lib/main.dart')) {
    files.set('lib/main.dart', {
      path: 'lib/main.dart',
      action: 'created',
      language: 'dart',
      content: generateMainFallback(pkgName, needsSupabase),
    });
  }

  return {
    generatedFiles: files,
    logs: [
      ...state.logs,
      `[Integration Agent] Wired ${routes.length} routes via GoRouter. Nav: ${navType}. AI files: ${parsed.length}. Supabase init: ${needsSupabase}`,
    ],
  };
}

function generateRouterFallback(
  pkgName: string,
  routes: Array<{ name: string; path: string; screen: string; isAuthRequired: boolean }>,
  navType: string,
  needsSupabase: boolean
): string {
  const tabRoutes = routes.filter((_, i) => i < 4);
  const stackRoutes = routes.filter((_, i) => i >= 4);

  const screenImports = routes
    .map((r) => {
      const featureName = r.name;
      const fileName = r.screen.replace(/([A-Z])/g, (m, _, i) => (i === 0 ? m : `_${m}`)).toLowerCase();
      return `import 'package:${pkgName}/features/${featureName}/screens/${fileName}.dart';`;
    })
    .join('\n');

  return `import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
${screenImports}

final _rootNavigatorKey = GlobalKey<NavigatorState>();
final _shellNavigatorKey = GlobalKey<NavigatorState>();

final appRouter = GoRouter(
  navigatorKey: _rootNavigatorKey,
  initialLocation: '/',
  debugLogDiagnostics: false,
  ${needsSupabase ? `redirect: (context, state) {
    // Add auth redirect logic here
    return null;
  },` : ''}
  routes: [
    ${navType === 'bottom_tabs' ? `ShellRoute(
      navigatorKey: _shellNavigatorKey,
      builder: (context, state, child) => AppShell(child: child),
      routes: [
        ${tabRoutes.map((r) => `GoRoute(
          path: '${r.path}',
          pageBuilder: (context, state) => const NoTransitionPage(
            child: ${r.screen}(),
          ),
        )`).join(',\n        ')},
      ],
    ),` : ''}
    ${stackRoutes.map((r) => `GoRoute(
      path: '${r.path}',
      builder: (context, state) => const ${r.screen}(),
    )`).join(',\n    ')},
  ],
);

class AppShell extends StatefulWidget {
  final Widget child;
  const AppShell({super.key, required this.child});

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int _selectedIndex = 0;

  final List<({String route, String label, IconData icon})> _destinations = [
    ${tabRoutes.map((r, i) => `(route: '${r.path}', label: '${r.name.charAt(0).toUpperCase() + r.name.slice(1)}', icon: ${_iconForIndex(i)})`).join(',\n    ')},
  ];

  void _onDestinationSelected(int index) {
    setState(() => _selectedIndex = index);
    context.go(_destinations[index].route);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: widget.child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _selectedIndex,
        onDestinationSelected: _onDestinationSelected,
        destinations: _destinations.map((d) => NavigationDestination(
          icon: Icon(d.icon),
          label: d.label,
        )).toList(),
      ),
    );
  }
}
`;
}

function _iconForIndex(i: number): string {
  const icons = ['Icons.home_rounded', 'Icons.search_rounded', 'Icons.add_circle_rounded', 'Icons.person_rounded', 'Icons.settings_rounded'];
  return icons[i] || 'Icons.circle_rounded';
}

function generateAppFallback(pkgName: string, appName: string, stateManagement: string): string {
  return `import 'package:flutter/material.dart';
import 'package:${pkgName}/core/router/app_router.dart';
import 'package:${pkgName}/core/theme/app_theme.dart';
${stateManagement === 'provider' ? `import 'package:provider/provider.dart';` : ''}

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return ${stateManagement === 'provider' ? `ChangeNotifierProvider(
      create: (_) => ThemeNotifier(),
      child: Consumer<ThemeNotifier>(
        builder: (context, themeNotifier, _) => MaterialApp.router(
          title: '${appName}',
          debugShowCheckedModeBanner: false,
          theme: AppTheme.lightTheme,
          darkTheme: AppTheme.darkTheme,
          themeMode: themeNotifier.mode,
          routerConfig: appRouter,
        ),
      ),
    )` : `MaterialApp.router(
      title: '${appName}',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.lightTheme,
      darkTheme: AppTheme.darkTheme,
      routerConfig: appRouter,
    )`};
  }
}
`;
}

function generateMainFallback(pkgName: string, needsSupabase: boolean): string {
  return `import 'package:flutter/material.dart';
${needsSupabase ? `import 'package:supabase_flutter/supabase_flutter.dart';` : ''}
import 'package:${pkgName}/app.dart';
${needsSupabase ? `import 'package:${pkgName}/core/services/local_storage_service.dart';` : `import 'package:${pkgName}/core/services/local_storage_service.dart';`}

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
${needsSupabase ? `
  await Supabase.initialize(
    url: const String.fromEnvironment('SUPABASE_URL', defaultValue: ''),
    anonKey: const String.fromEnvironment('SUPABASE_ANON_KEY', defaultValue: ''),
  );
` : `
  await LocalStorageService.init();
`}
  runApp(const App());
}
`;
}
