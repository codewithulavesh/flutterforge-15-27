import type { ProjectState, GeneratedFile } from '../orchestrator/state';
import { callLLMText, parseFilesFromLLMOutput, agentModelFor } from './llmClient';

export async function runRepairAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const files = new Map<string, GeneratedFile>(state.generatedFiles);
  const errorDiags = state.diagnostics.filter((d) => d.level === 'error');

  if (errorDiags.length === 0) {
    return {
      repairAttempts: state.repairAttempts + 1,
      logs: [...state.logs, `[Repair Agent] No errors to repair.`],
    };
  }

  const appName = state.productBrief?.appName || 'App';
  const pkgName = appName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
  const repaired: string[] = [];

  // For each error diagnostic, attempt LLM-driven repair
  for (const diag of errorDiags) {
    const filePath = diag.filePath;
    if (!filePath) continue;

    const existing = filePath ? files.get(filePath)?.content || '' : '';

    try {
      const raw = await callLLMText(
        [
          {
            role: 'system',
            content: `You are the Repair Agent for FlutterForge. Fix Flutter/Dart code issues.

RULES:
1. Output ONLY the corrected file content — no explanations, no markdown fences
2. The file must compile cleanly
3. Keep all existing functionality — only fix the specific error
4. Use correct Flutter/Dart imports`,
          },
          {
            role: 'user',
            content: `Repair this Flutter file for "${appName}" (package: ${pkgName}).

File path: ${filePath}
Error: ${diag.message}
Suggestion: ${diag.suggestion}

Current content:
${existing || '(empty — create from scratch)'}

Output the complete, fixed Dart file content:`,
          },
        ],
        {
          model: agentModelFor('repair'),
          temperature: 0.1,
          maxTokens: 3000,
        }
      );

      const cleanContent = raw
        .replace(/^```(?:dart|yaml|sql)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();

      if (cleanContent.length > 20) {
        files.set(filePath, {
          path: filePath,
          content: cleanContent,
          action: existing ? 'modified' : 'created',
          language: filePath.endsWith('.dart') ? 'dart' : filePath.endsWith('.yaml') ? 'yaml' : 'sql',
        });
        repaired.push(filePath);
      }
    } catch (err) {
      console.warn(`[RepairAgent] LLM repair failed for ${filePath}:`, err);
      // Structural fallback repairs
      await applyStructuralRepair(files, filePath, diag, appName, pkgName);
      repaired.push(`${filePath} (structural)`);
    }
  }

  // Also check for critical missing files and backfill
  const critical = [
    'pubspec.yaml',
    'lib/main.dart',
    'lib/app.dart',
    'lib/core/router/app_router.dart',
    'lib/core/theme/app_theme.dart',
  ];
  for (const c of critical) {
    if (!files.has(c) || (files.get(c)?.content || '').trim().length < 20) {
      const content = getMinimalFallback(c, appName, pkgName);
      if (content) {
        files.set(c, { path: c, content, action: 'created', language: c.endsWith('.dart') ? 'dart' : 'yaml' });
        repaired.push(`${c} (backfilled)`);
      }
    }
  }

  // Ensure at least one home screen exists if missing
  const hasScreens = [...files.keys()].some((k) => k.startsWith('lib/features/') && k.endsWith('_screen.dart'));
  if (!hasScreens) {
    const homeScreenPath = 'lib/features/home/screens/home_screen.dart';
    const content = getMinimalFallback(homeScreenPath, appName, pkgName);
    if (content) {
      files.set(homeScreenPath, { path: homeScreenPath, content, action: 'created', language: 'dart' });
      repaired.push(`${homeScreenPath} (backfilled)`);
    }
  }

  // Ensure SupabaseService exists if supabase is referenced
  const usesSupabase = [...files.values()].some((f) => f.content.includes('supabase_flutter') || f.content.includes('Supabase.initialize'));
  if (usesSupabase && !files.has('lib/core/services/supabase_service.dart')) {
    const supabaseServicePath = 'lib/core/services/supabase_service.dart';
    const content = getMinimalFallback(supabaseServicePath, appName, pkgName);
    if (content) {
      files.set(supabaseServicePath, { path: supabaseServicePath, content, action: 'created', language: 'dart' });
      repaired.push(`${supabaseServicePath} (backfilled)`);
    }
  }

  return {
    generatedFiles: files,
    diagnostics: state.diagnostics.filter((d) => d.level !== 'error'),
    repairAttempts: state.repairAttempts + 1,
    logs: [
      ...state.logs,
      `[Repair Agent] Cycle ${state.repairAttempts + 1}: Repaired ${repaired.length} files: ${repaired.join(', ')}`,
    ],
  };
}

async function applyStructuralRepair(
  files: Map<string, GeneratedFile>,
  filePath: string,
  diag: { gate: string; message: string },
  appName: string,
  pkgName: string
): Promise<void> {
  // Fix missing runApp
  if (diag.gate === 'G2-runapp' && filePath === 'lib/main.dart') {
    const existing = files.get('lib/main.dart')?.content || '';
    if (!existing.includes('runApp(')) {
      files.set('lib/main.dart', {
        path: 'lib/main.dart',
        content: `import 'package:flutter/material.dart';\nimport 'package:${pkgName}/app.dart';\n\nvoid main() async {\n  WidgetsFlutterBinding.ensureInitialized();\n  runApp(const App());\n}\n`,
        action: 'modified',
        language: 'dart',
      });
    }
  }

  // Fix missing MaterialApp
  if (diag.gate === 'G3-materialapp' && filePath === 'lib/app.dart') {
    files.set('lib/app.dart', {
      path: 'lib/app.dart',
      content: `import 'package:flutter/material.dart';\nimport 'package:${pkgName}/core/router/app_router.dart';\nimport 'package:${pkgName}/core/theme/app_theme.dart';\n\nclass App extends StatelessWidget {\n  const App({super.key});\n  @override\n  Widget build(BuildContext context) {\n    return MaterialApp.router(\n      title: '${appName}',\n      debugShowCheckedModeBanner: false,\n      theme: AppTheme.lightTheme,\n      darkTheme: AppTheme.darkTheme,\n      routerConfig: appRouter,\n    );\n  }\n}\n`,
      action: 'modified',
      language: 'dart',
    });
  }
}

function getMinimalFallback(path: string, appName: string, pkgName: string): string | null {
  if (path === 'lib/main.dart') {
    return "import 'package:flutter/material.dart';\nimport 'package:" + pkgName + "/app.dart';\n\nvoid main() async {\n  WidgetsFlutterBinding.ensureInitialized();\n  runApp(const App());\n}\n";
  }
  if (path === 'lib/app.dart') {
    return "import 'package:flutter/material.dart';\nimport 'package:" + pkgName + "/core/router/app_router.dart';\nimport 'package:" + pkgName + "/core/theme/app_theme.dart';\n\nclass App extends StatelessWidget {\n  const App({super.key});\n  @override\n  Widget build(BuildContext context) {\n    return MaterialApp.router(\n      title: '" + appName + "',\n      debugShowCheckedModeBanner: false,\n      theme: AppTheme.lightTheme,\n      darkTheme: AppTheme.darkTheme,\n      routerConfig: appRouter,\n    );\n  }\n}\n";
  }
  if (path === 'lib/core/router/app_router.dart') {
    return "import 'package:flutter/material.dart';\nimport 'package:go_router/go_router.dart';\nimport 'package:" + pkgName + "/features/home/screens/home_screen.dart';\n\nfinal appRouter = GoRouter(\n  initialLocation: '/',\n  routes: [\n    GoRoute(\n      path: '/',\n      name: 'home',\n      builder: (context, state) => const HomeScreen(),\n    ),\n  ],\n);\n";
  }
  if (path === 'lib/core/theme/app_theme.dart') {
    return "import 'package:flutter/material.dart';\n\nclass AppTheme {\n  static final ThemeData lightTheme = ThemeData(\n    useMaterial3: true,\n    colorScheme: ColorScheme.fromSeed(\n      seedColor: const Color(0xFF2563EB),\n      brightness: Brightness.light,\n    ),\n  );\n  static final ThemeData darkTheme = ThemeData(\n    useMaterial3: true,\n    colorScheme: ColorScheme.fromSeed(\n      seedColor: const Color(0xFF2563EB),\n      brightness: Brightness.dark,\n    ),\n  );\n}\n";
  }
  if (path === 'lib/core/services/supabase_service.dart' || path === 'lib/core/services/auth_service.dart') {
    return "import 'package:flutter/foundation.dart';\n\nclass SupabaseService {\n  static bool get isConfigured => false;\n  static Future<void> initialize() async {\n    debugPrint('[SupabaseService] Initialized (local mode)');\n  }\n}\n";
  }
  if (path === 'lib/features/home/screens/home_screen.dart') {
    return "import 'package:flutter/material.dart';\n\nclass HomeScreen extends StatelessWidget {\n  const HomeScreen({super.key});\n  @override\n  Widget build(BuildContext context) {\n    final theme = Theme.of(context);\n    return Scaffold(\n      appBar: AppBar(\n        title: Text('" + appName + "'),\n        centerTitle: false,\n      ),\n      body: Center(\n        child: Column(\n          mainAxisAlignment: MainAxisAlignment.center,\n          children: [\n            Icon(Icons.check_circle_outline, size: 64, color: theme.colorScheme.primary),\n            const SizedBox(height: 16),\n            Text('" + appName + "', style: theme.textTheme.headlineMedium),\n            const SizedBox(height: 8),\n            Text('Generated by FlutterForge', style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.outline)),\n          ],\n        ),\n      ),\n    );\n  }\n}\n";
  }
  if (path === 'pubspec.yaml') {
    return "name: " + pkgName + "\ndescription: Generated by FlutterForge\npublish_to: none\nversion: 1.0.0+1\n\nenvironment:\n  sdk: '>=3.3.0 <4.0.0'\n\ndependencies:\n  flutter:\n    sdk: flutter\n  go_router: ^14.2.0\n  provider: ^6.1.2\n\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n  flutter_lints: ^4.0.0\n\nflutter:\n  uses-material-design: true\n";
  }
  return null;
}
