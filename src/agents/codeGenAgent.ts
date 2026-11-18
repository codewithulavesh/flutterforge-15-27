/**
 * Code Gen Agent — generates pubspec.yaml, app theme, real Provider/Riverpod/Bloc
 * state classes, and all core infrastructure files needed before screens are built.
 *
 * Determinism contract:
 * - File ordering is stable (generatedFiles are re-keyed in sorted path order).
 * - Provider/notifier/cubit files are derived from the same model specs the
 *   data-models agent emits: `<Model>Provider` (provider) / `<Model>Notifier`
 *   + `<model>Provider` (riverpod) / `<Model>Cubit` (bloc). Every model in
 *   `state.dataSchema` gets exactly one provider file, synthesized locally if
 *   the LLM does not produce a valid one.
 * - `bloc` is only generated when `flutter_bloc` (or `bloc`) is actually
 *   declared in `architectureSpec.packages` — flutter_bloc is a known,
 *   published package (see KNOWN_VERSIONS in src/agent/preWriteValidator.ts,
 *   `flutter_bloc: '^8.1.6'`). Otherwise the agent falls back to provider and
 *   records a warning diagnostic. Riverpod does the same against
 *   `riverpod` / `flutter_riverpod`.
 * - LLM output is accepted only when it parses (balanced delimiters, no
 *   TODO/UnimplementedError, no `part of`, resolvable imports). Anything
 *   unparseable is replaced by a deterministic local synthesis of the file.
 * - Package name comes from pubspec (via state) or a sanitized appName,
 *   falling back to `flutterforge_app` — same rule as the data-models agent
 *   and src/agents/projectContract.ts.
 */
import type {
  GateDiagnostic,
  ProjectState,
  GeneratedFile,
  TableColumn,
  TableDefinition,
} from '../orchestrator/state';
import { callLLMText, parseFilesFromLLMOutput, agentModelFor } from './llmClient';

// Mirror of the relevant entries in src/agent/preWriteValidator.ts KNOWN_VERSIONS
// (flutter_bloc ^8.1.6 and bloc ^8.1.4 are known-published packages, verified there).
const KNOWN_PACKAGE_VERSIONS: Record<string, string> = {
  provider: '^6.1.2',
  riverpod: '^2.6.1',
  flutter_riverpod: '^2.6.1',
  bloc: '^8.1.4',
  flutter_bloc: '^8.1.6',
};

const RESERVED_LLM_PATHS = new Set([
  'pubspec.yaml',
  'analysis_options.yaml',
  'lib/main.dart',
  'lib/app/app.dart',
  'lib/app/app_theme.dart',
  'lib/core/constants/app_constants.dart',
]);

export async function runCodeGenAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const appName = state.productBrief?.appName || 'FlutterForge App';
  const pkg = guessPackageName(state);
  const tokens = state.designTokens;
  const arch = state.architectureSpec || state.architecture;
  const intake = state._intakeData as Record<string, unknown> | undefined;
  const domain = (intake?.domain as string) || 'general';
  const keyFeatures = (intake?.keyFeatures as string[]) || [];
  const needsSupabase = arch?.backendMode === 'supabase';
  const requestedStateManagement = arch?.stateManagement || 'provider';
  const files = new Map<string, GeneratedFile>(state.generatedFiles ?? new Map());

  const diagnostics: GateDiagnostic[] = [...state.diagnostics];
  const agentLogs: string[] = [];

  // ── 0. Resolve effective state management (bloc/riverpod only when their
  //       packages are actually declared; otherwise fall back to provider) ──
  const packages: Record<string, string> = { ...(arch?.packages || {}) };
  let stateManagement = requestedStateManagement;
  if (requestedStateManagement === 'bloc') {
    const declared = Boolean(packages['flutter_bloc'] || packages['bloc']);
    if (!declared) {
      stateManagement = 'provider';
      packages['provider'] = packages['provider'] || KNOWN_PACKAGE_VERSIONS.provider;
      diagnostics.push({
        gate: 'code-gen',
        level: 'warning',
        message:
          'architectureSpec requested bloc state management, but flutter_bloc is not declared in architectureSpec.packages; generated provider-style ChangeNotifier state instead.',
        suggestion: `Add flutter_bloc: '${KNOWN_PACKAGE_VERSIONS.flutter_bloc}' to architectureSpec.packages to enable bloc generation.`,
      });
      agentLogs.push(
        '[CodeGenAgent] bloc requested but flutter_bloc is missing from architectureSpec.packages — falling back to provider'
      );
    } else if (!packages['flutter_bloc']) {
      packages['flutter_bloc'] = KNOWN_PACKAGE_VERSIONS.flutter_bloc;
    }
  } else if (requestedStateManagement === 'riverpod') {
    const declared = Boolean(packages['flutter_riverpod'] || packages['riverpod']);
    if (!declared) {
      stateManagement = 'provider';
      packages['provider'] = packages['provider'] || KNOWN_PACKAGE_VERSIONS.provider;
      diagnostics.push({
        gate: 'code-gen',
        level: 'warning',
        message:
          'architectureSpec requested riverpod state management, but neither riverpod nor flutter_riverpod is declared in architectureSpec.packages; generated provider-style ChangeNotifier state instead.',
        suggestion: `Add flutter_riverpod: '${KNOWN_PACKAGE_VERSIONS.flutter_riverpod}' to architectureSpec.packages to enable riverpod generation.`,
      });
      agentLogs.push(
        '[CodeGenAgent] riverpod requested but no riverpod package is declared in architectureSpec.packages — falling back to provider'
      );
    }
  } else if (!packages['provider']) {
    packages['provider'] = KNOWN_PACKAGE_VERSIONS.provider;
  }

  const primaryHex = tokens?.primaryColor?.replace('#', '0xFF') || '0xFF2563EB';

  // ── 1. pubspec.yaml (always deterministic) ───────────────────────
  const depsYaml = Object.entries(packages)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([pkgName, ver]) => `  ${pkgName}: ${ver}`)
    .join('\n');

  files.set('pubspec.yaml', {
    path: 'pubspec.yaml',
    action: 'created',
    language: 'yaml',
    content: `name: ${pkg}
description: "${state.productBrief?.oneLiner?.slice(0, 100) || `${appName} — generated by FlutterForge`}"
publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: '>=3.3.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
${depsYaml}

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^4.0.0

flutter:
  uses-material-design: true
  assets:
    - assets/images/
    - assets/icons/
`,
  });

  // ── 1.5 Deterministic framework skeleton (the professional shell the LLM fills within) ──
  files.set('lib/main.dart', {
    path: 'lib/main.dart',
    action: 'created',
    language: 'dart',
    content: `import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:${pkg}/app/app.dart';
import 'package:${pkg}/core/network/dio_client.dart';
import 'package:${pkg}/core/storage/local_storage_service.dart';
import 'package:${pkg}/core/services/app_shell_client.dart';
${needsSupabase ? `import 'package:${pkg}/core/services/auth_service.dart';` : ''}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  DioClient.init();
  await LocalStorageService.instance.init();
  final prefs = await SharedPreferences.getInstance();
  AppShellClient.init(prefs);
  ${needsSupabase ? 'await AuthService.init();' : ''}
  runApp(const App());
}
`,
  });
  files.set('lib/app/app.dart', {
    path: 'lib/app/app.dart',
    action: 'created',
    language: 'dart',
    content: `import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:${pkg}/core/router/app_router.dart';
import 'package:${pkg}/app/app_theme.dart';

/// Root widget. Router + Theme are wired here so they work in every screen.
class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => ThemeNotifier()),
      ],
      child: Consumer<ThemeNotifier>(
        builder: (_, notifier, _) => MaterialApp.router(
          title: '${state.productBrief?.appName || 'App'}',
          debugShowCheckedModeBanner: false,
          routerConfig: appRouter,
          themeMode: notifier.mode,
          theme: AppTheme.lightTheme,
          darkTheme: AppTheme.darkTheme,
        ),
      ),
    );
  }
}
`,
  });
  files.set('lib/core/errors/failures.dart', {
    path: 'lib/core/errors/failures.dart',
    action: 'created',
    language: 'dart',
    content: `/// Sealed failure hierarchy used across repositories.
sealed class Failure {
  const Failure(this.message, {this.cause});
  final String message;
  final Object? cause;
}

final class NetworkFailure extends Failure { const NetworkFailure(super.message, {super.cause}); }
final class ServerFailure extends Failure { const ServerFailure(super.message, {super.cause}); }
final class UnknownFailure extends Failure { const UnknownFailure([super.message = 'Something went wrong']); }
`,
  });
  files.set('lib/core/network/dio_client.dart', {
    path: 'lib/core/network/dio_client.dart',
    action: 'created',
    language: 'dart',
    content: `import 'package:dio/dio.dart';

/// Shared Dio instance. Initialize once at app entry.
class DioClient {
  static late final Dio instance;

  static void init({String? baseUrl}) {
    instance = Dio(BaseOptions(baseUrl: baseUrl ?? '', connectTimeout: const Duration(seconds: 12), receiveTimeout: const Duration(seconds: 20)))
      ..interceptors.add(LogInterceptor(responseBody: false, requestBody: false));
  }
}
`,
  });
  files.set('lib/core/storage/local_storage_service.dart', {
    path: 'lib/core/storage/local_storage_service.dart',
    action: 'created',
    language: 'dart',
    content: `import 'package:shared_preferences/shared_preferences.dart';

/// Typed wrapper over SharedPreferences. Init once at app entry.
class LocalStorageService {
  LocalStorageService._();
  static final LocalStorageService instance = LocalStorageService._();
  late SharedPreferences _prefs;

  Future<void> init() async => _prefs = await SharedPreferences.getInstance();
  String? getString(String key) => _prefs.getString(key);
  Future<bool> setString(String key, String value) => _prefs.setString(key, value);
  Future<bool> remove(String key) => _prefs.remove(key);
}
`,
  });
  files.set('lib/core/utils/validators.dart', {
    path: 'lib/core/utils/validators.dart',
    action: 'created',
    language: 'dart',
    content: `class Validators {
  static String? email(String? v) {
    if (v == null || v.isEmpty) return 'Email is required';
    if (!RegExp(r'^[\\w\\.\\+\\-]+@[\\w\\-]+(\\.[a-z]{2,})+$').hasMatch(v.trim())) return 'Invalid email';
    return null;
  }

  static String? required(String? v, [String field = 'This field']) => (v == null || v.trim().isEmpty) ? '$field is required' : null;
}
`,
  });
  files.set('lib/core/widgets/empty_state.dart', {
    path: 'lib/core/widgets/empty_state.dart',
    action: 'created',
    language: 'dart',
    content: `import 'package:flutter/material.dart';

/// Empty state shown when a list/query has no data.
class EmptyState extends StatelessWidget {
  const EmptyState({required this.title, required this.message, this.icon, super.key});
  final String title;
  final String message;
  final IconData? icon;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
        Icon(icon ?? Icons.inbox_outlined, size: 56, color: Theme.of(context).colorScheme.outline),
        const SizedBox(height: 16),
        Text(title, style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        Text(message, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyMedium),
      ]),
    ),
  );
}
`,
  });
  files.set('lib/core/widgets/loading_overlay.dart', {
    path: 'lib/core/widgets/loading_overlay.dart',
    action: 'created',
    language: 'dart',
    content: `import 'package:flutter/material.dart';

/// Wraps a child and dims it with a spinner while [loading] is true.
class LoadingOverlay extends StatelessWidget {
  const LoadingOverlay({required this.loading, required this.child, super.key});
  final bool loading;
  final Widget child;

  @override
  Widget build(BuildContext context) => Stack(
    alignment: Alignment.center,
    children: [
      child,
      if (loading) const ColoredBox(color: Colors.black26, child: SizedBox.expand(child: Center(child: CircularProgressIndicator()))),
    ],
  );
}
`,
  });

  // ── 2. analysis_options.yaml ─────────────────────────────────────
  files.set('analysis_options.yaml', {
    path: 'analysis_options.yaml',
    action: 'created',
    language: 'yaml',
    content: `include: package:flutter_lints/flutter.yaml

analyzer:
  exclude:
    - '**/*.g.dart'
    - '**/*.freezed.dart'

linter:
  rules:
    prefer_const_constructors: true
    prefer_const_literals_to_create_immutables: true
    avoid_print: true
    use_key_in_widget_constructors: true
    sort_child_properties_last: true
    prefer_final_fields: true
`,
  });

  // ── 3. App Theme (AI generated — real M3 tokens) ─────────────────
  let themeRaw = '';
  try {
    themeRaw = await callLLMText(
      [
        {
          role: 'system',
          content: `You are a senior Flutter developer. Write PRODUCTION-QUALITY Flutter code ONLY.
No explanations. No markdown. Just the complete Dart file.
Never emit a \`part of\` directive and never use .g.dart files. No TODO markers.

Generate lib/app/app_theme.dart that:
1. Uses Material 3 (useMaterial3: true always)
2. ColorScheme.fromSeed with the given primary color
3. Full light + dark ThemeData
4. Custom text theme: headline uses ${tokens?.fontFamily || 'Roboto'}, consistent sizing
5. Consistent border radius (${tokens?.borderRadius || 12}px) on all components
6. CardThemeData with shadow and shape
7. FilledButtonTheme, OutlinedButtonTheme, TextButtonTheme all configured
8. InputDecorationTheme (outlined style, correct border radius)
9. AppBarTheme (no elevation on light, centerTitle false)
10. NavigationBarTheme (indicator color, label behavior)
11. ThemeNotifier ChangeNotifier for dark/light toggle with persistence
12. Exports: AppTheme.lightTheme, AppTheme.darkTheme, ThemeNotifier class`,
        },
        {
          role: 'user',
          content: `Create the complete app_theme.dart for "${appName}" (${domain} app):
Primary seed: ${tokens?.primaryColor || '#2563EB'} → 0xFF hex: ${primaryHex}
Font: ${tokens?.fontFamily || 'Roboto'}
Border radius: ${tokens?.borderRadius || 12}
${packages['google_fonts'] ? 'Uses google_fonts package — import and use GoogleFonts.' : 'No google_fonts — use fontFamily string.'}
${tokens?.isDarkPreferred ? 'Default theme mode: dark' : 'Default theme mode: light'}

Output ONLY the complete Dart file content:`,
        },
      ],
      { model: agentModelFor('code-gen'), temperature: 0.1, maxTokens: 3000 }
    );
    themeRaw = themeRaw.replace(/^```(?:dart)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  } catch { /* use fallback */ }

  if (!themeRaw || themeRaw.length < 50 || !validateDartSource(themeRaw).ok) {
    if (themeRaw && themeRaw.trim().length >= 1) {
      agentLogs.push('[CodeGenAgent] LLM parse failed for lib/app/app_theme.dart; used deterministic fallback');
    }
    themeRaw = generateThemeFallback(appName, primaryHex, tokens?.fontFamily || 'Roboto', tokens?.borderRadius || 12, tokens?.isDarkPreferred || false);
  }
  files.set('lib/app/app_theme.dart', { path: 'lib/app/app_theme.dart', action: 'created', language: 'dart', content: themeRaw });

  // ── 4. State Management Layer (AI-assisted, deterministically enforced) ──
  const screens = state.screenGraph?.screens || [];
  const tables = state.dataSchema?.tables ?? [];
  const modelSpecs = collectModelSpecs(state, tables, arch?.features);
  const modelNames = modelSpecs.map((s) => s.className);

  let stateRaw = '';
  try {
    stateRaw = await callLLMText(
      [
        {
          role: 'system',
          content: `You are a senior Flutter developer. Write PRODUCTION-QUALITY state classes.

RULES:
1. One state file per domain model, named <name>_provider.dart
2. No hardcoded data — use proper async loading patterns
3. ViewState enum: initial, loading, loaded, error
4. Classes hold: state enum, data list, error message, loading flag
5. Methods: load(), refresh(), create(), update(), delete() as appropriate
6. Error handling: catch exceptions, set error state
7. State management style for this app: ${stateManagement}
8. Realistic seed data that matches the domain — deterministic sample values
9. NEVER emit a \`part of\` directive. No TODO comments, no UnimplementedError.

Output format:
// FILE: lib/features/<feature>/providers/<name>_provider.dart
\`\`\`dart
...full Dart code...
\`\`\``,
        },
        {
          role: 'user',
          content: `Generate state management providers for "${appName}" (${domain} app).

Package: ${pkg}
State management: ${stateManagement}
Domain models available: ${modelNames.join(', ') || '(none)'}
Schema tables: ${tables.map((t) => t.name).join(', ') || '(none)'}
Screens: ${screens.map((s) => `${s.name} — ${s.purpose}`).join('\n')}
Key features: ${keyFeatures.join(', ')}

For each domain model, create a matching state class with:
- The model class imported via package:${pkg}/...
- Real async loading with Future.delayed simulation
- Proper error handling
- Create/Update/Delete operations

State management specifics: ${stateManagement === 'provider' ? 'ChangeNotifier + ChangeNotifierProvider' : stateManagement === 'riverpod' ? 'StateNotifier + StateNotifierProvider (riverpod 3.x style)' : 'Cubit (flutter_bloc)'}.`,
        },
      ],
      { model: agentModelFor('code-gen'), temperature: 0.3, maxTokens: 6000 }
    );
  } catch (err) {
    console.warn('[CodeGenAgent] Provider generation failed:', err);
    stateRaw = '';
  }

  // ── 4a. Validate + stage LLM provider files ───────────────────────────
  const parsedProviders = parseFilesFromLLMOutput(stateRaw);
  const llmProviders = new Map<string, string>();
  for (const f of parsedProviders) {
    const path = f.path.trim();
    const cleanContent = f.content.replace(/^```(?:dart)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    if (!isValidGeneratedPath(path) || !path.startsWith('lib/')) {
      agentLogs.push(`[CodeGenAgent] Skipping LLM state file at invalid path ${path || '(empty)'}`);
      continue;
    }
    if (RESERVED_LLM_PATHS.has(path)) {
      agentLogs.push(`[CodeGenAgent] Ignoring LLM output for deterministic file ${path}`);
      continue;
    }

    const validity = validateDartSource(cleanContent);
    if (!validity.ok || !/\bclass\s+[A-Za-z_][A-Za-z0-9_]*\b/.test(cleanContent)) {
      const reason = !validity.ok ? validity.reason : 'no class declaration';
      const spec = findSpecForProviderPath(modelSpecs, path, cleanContent);
      if (spec) {
        const providerPath = providerPathForModel(spec.path);
        if (!llmProviders.has(providerPath) && !files.has(providerPath)) {
          putGeneratedFile(files, providerPath, 'dart', synthesizeProviderContent(spec, pkg, stateManagement, packages));
        }
        agentLogs.push(`[CodeGenAgent] LLM parse failed for ${path}; used deterministic fallback`);
        diagnostics.push({
          gate: 'code-gen',
          level: 'info',
          file: path,
          message: `LLM output for ${path} failed validation (${reason}); replaced with deterministic synthesis for ${spec.className}.`,
        });
      } else {
        agentLogs.push(`[CodeGenAgent] Dropped unparseable LLM file ${path} (${reason}); no matching model to synthesize`);
      }
      continue;
    }
    llmProviders.set(path, cleanContent);
  }

  // ── 4b. Fixpoint: every package:<pkg> import must resolve ────────────
  for (let guard = 0; guard < 10; guard += 1) {
    let changed = false;
    for (const [path, content] of [...llmProviders].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const candidates = new Set<string>([...files.keys(), ...llmProviders.keys()]);
      const missing = unresolvedImports(content, path, candidates, pkg);
      if (missing.length === 0) continue;
      const spec = findSpecForProviderPath(modelSpecs, path, content);
      if (spec) {
        putGeneratedFile(files, providerPathForModel(spec.path), 'dart', synthesizeProviderContent(spec, pkg, stateManagement, packages));
        agentLogs.push(`[CodeGenAgent] LLM parse failed for ${path}; used deterministic fallback`);
        diagnostics.push({
          gate: 'code-gen',
          level: 'info',
          file: path,
          message: `LLM file ${path} imports ${missing.join(', ')} which do not exist; replaced with deterministic synthesis for ${spec.className}.`,
        });
      } else {
        agentLogs.push(`[CodeGenAgent] Dropped LLM file ${path}: unresolved imports (${missing.join(', ')})`);
      }
      llmProviders.delete(path);
      changed = true;
    }
    if (!changed) break;
  }
  for (const [path, content] of llmProviders) {
    putGeneratedFile(files, path, 'dart', content);
  }

  // ── 4c. Guarantee one provider file per model (deterministic) ──────────
  let synthesizedProviders = 0;
  for (const spec of [...modelSpecs].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const providerPath = providerPathForModel(spec.path);
    if (files.has(providerPath)) continue;
    putGeneratedFile(files, providerPath, 'dart', synthesizeProviderContent(spec, pkg, stateManagement, packages));
    synthesizedProviders += 1;
  }
  if (synthesizedProviders > 0) {
    agentLogs.push(`[CodeGenAgent] Synthesized ${synthesizedProviders} provider file(s) deterministically`);
  }

  // ── 5. Constants & utilities ──────────────────────────────────────
  files.set('lib/core/constants/app_constants.dart', {
    path: 'lib/core/constants/app_constants.dart',
    action: 'created',
    language: 'dart',
    content: `class AppConstants {
  AppConstants._();

  static const String appName = '${appName}';
  static const String appVersion = '1.0.0';
  ${needsSupabase ? `
  // Supabase — set via --dart-define at build time
  static const String supabaseUrl = String.fromEnvironment('SUPABASE_URL', defaultValue: '');
  static const String supabaseAnonKey = String.fromEnvironment('SUPABASE_ANON_KEY', defaultValue: '');
  ` : ''}
  // Shared Preferences keys
  static const String keyThemeMode = 'pref_theme_mode';
  static const String keyOnboardingDone = 'pref_onboarding_done';
  static const String keyUserId = 'pref_user_id';

  // Durations
  static const Duration animDuration = Duration(milliseconds: 300);
  static const Duration snackDuration = Duration(seconds: 3);
  static const Duration splashDuration = Duration(seconds: 2);

  // Pagination
  static const int pageSize = 20;
}
`,
  });

  // ── 6. Deterministic output ordering ────────────────────────────────
  const sortedFiles = sortFiles(files);
  const providerCount = [...sortedFiles.keys()].filter((k) => /\/providers\/[^/]+\.dart$/.test(k)).length;
  return {
    generatedFiles: sortedFiles,
    _providerFiles: [...sortedFiles.keys()].filter((k) => /\/providers\/[^/]+\.dart$/.test(k)),
    diagnostics,
    logs: [
      ...state.logs,
      ...agentLogs,
      `[Code Gen Agent] pubspec.yaml (${Object.keys(packages).length} deps) | app_theme.dart (M3, ${tokens?.primaryColor}) | ${providerCount} providers | state: ${stateManagement}`,
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Package name handling — same convention as the data-models agent and
// src/agents/projectContract.ts (pubspec name when known, sanitized appName,
// else flutterforge_app).
// ─────────────────────────────────────────────────────────────────────────

function sanitizePackageName(raw: string): string {
  let s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_');
  s = s.replace(/^_+|_+$/g, '').replace(/^[0-9_]+/, '');
  if (!s) return '';
  if (!/^[a-z]/.test(s)) s = `app_${s}`;
  return s.slice(0, 60);
}

function guessPackageName(state: ProjectState): string {
  const pubspec = state.generatedFiles?.get('pubspec.yaml')?.content;
  if (pubspec) {
    const match = pubspec.match(/^name\s*:\s*([^\r\n]+)/m);
    const fromPubspec = match?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
    const sanitized = sanitizePackageName(fromPubspec);
    if (sanitized) return sanitized;
  }
  return sanitizePackageName(state.productBrief?.appName ?? '') || 'flutterforge_app';
}

// ─────────────────────────────────────────────────────────────────────────
// Naming helpers
// ─────────────────────────────────────────────────────────────────────────

const SINGULAR_EXCEPTIONS = new Set([
  'series', 'species', 'news', 'information', 'equipment', 'sheep', 'fish',
  'means', 'crossroads', 'status', 'alias', 'analysis', 'basis', 'crisis',
]);

function singularizeWord(word: string): string {
  const w = word.toLowerCase();
  if (SINGULAR_EXCEPTIONS.has(w)) return w;
  if (/ies$/.test(w) && w.length > 3) return `${w.slice(0, -3)}y`;
  if (/(sses|ches|shes|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w) && !/ss$/.test(w) && w.length > 1) return w.slice(0, -1);
  return w;
}

function singularize(name: string): string {
  const parts = String(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return String(name);
  parts[parts.length - 1] = singularizeWord(parts[parts.length - 1]);
  return parts.join('_');
}

function slugify(value: string): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function toPascalCase(raw: string): string {
  const parts = String(raw).split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  if (!joined) return 'Record';
  return /^[A-Za-z]/.test(joined) ? joined : `Row${joined}`;
}

function toSnakeCase(raw: string): string {
  return String(raw)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function featureForTable(tableName: string, features?: string[] | null): string | null {
  if (!features || features.length === 0) return null;
  const t = slugify(tableName);
  const tSingular = slugify(singularize(tableName));
  for (const feature of features) {
    const f = slugify(feature);
    if (!f) continue;
    const fSingular = slugify(singularize(f));
    if (f === t || f === tSingular || fSingular === t || fSingular === tSingular) return f;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Type mapping (PostgreSQL/Supabase types → Dart)
// ─────────────────────────────────────────────────────────────────────────

function scalarDartType(t: string): string {
  const s = t.toLowerCase().trim();
  if (/^(bigint|int8|integer|int|int4|int2|smallint|serial|bigserial|smallserial|oid)/.test(s)) return 'int';
  if (s === 'double precision') return 'double';
  if (/^(numeric|decimal|real|double|float|money)/.test(s)) return 'double';
  if (/^(bool|boolean)/.test(s)) return 'bool';
  if (/timestamp|timestamptz|datetime/.test(s)) return 'DateTime';
  if (s === 'date' || s === 'time' || s.startsWith('timetz')) return 'DateTime';
  if (/^(json|jsonb)/.test(s) || s.includes('json')) return 'Map<String, dynamic>';
  if (/^(uuid|text|varchar|char|character|name|citext|bpchar|inet|cidr|macaddr|bytea|xml)/.test(s)) return 'String';
  if (s.includes('bool')) return 'bool';
  if (s.includes('int') || s.includes('serial')) return 'int';
  if (/numeric|decimal|double|float|real|money/.test(s)) return 'double';
  if (s.includes('text') || s.includes('char') || s.includes('string') || s.includes('uuid')) return 'String';
  return 'String';
}

function dartTypeForColumn(typeRaw: string | undefined): string {
  const raw = String(typeRaw ?? 'text').trim();
  const lower = raw.toLowerCase();
  let base = lower;
  let isArray = false;
  if (lower.endsWith('[]')) {
    isArray = true;
    base = lower.slice(0, -2);
  } else if (lower.endsWith(' array')) {
    isArray = true;
    base = lower.slice(0, -' array'.length).trim();
  } else if (lower.startsWith('_') && lower.length > 1) {
    isArray = true;
    base = lower.slice(1);
  }
  const scalar = scalarDartType(base);
  return isArray ? `List<${scalar}>` : scalar;
}

// ─────────────────────────────────────────────────────────────────────────
// Model specs (same derivation the data-models agent uses)
// ─────────────────────────────────────────────────────────────────────────

interface ModelField {
  column: TableColumn;
  field: string;
  dartBase: string;
  nullable: boolean;
  defaultLiteral?: string;
  required: boolean;
}

interface ModelSpec {
  table: string;
  className: string;
  fileBase: string;
  path: string;
  feature: string | null;
  fields: ModelField[];
}

function sqlLiteralToDart(dartBase: string, rawDefault: unknown): string | undefined {
  const v = String(rawDefault ?? '').trim();
  if (!v) return undefined;
  const single = v.replace(/^'(.*)'$/s, '$1').replace(/''/g, "'");
  const double = v.replace(/^"(.*)"$/s, '$1').replace(/""/g, '"');
  switch (dartBase) {
    case 'bool':
      if (/^(true|'true')$/i.test(v)) return 'true';
      if (/^(false|'false')$/i.test(v)) return 'false';
      if (/^'(t|f)'$/i.test(v)) return /t/i.test(v) ? 'true' : 'false';
      if (v === '0' || v === '1') return v === '1' ? 'true' : 'false';
      return undefined;
    case 'int':
      return /^-?\d+$/.test(v) ? v : undefined;
    case 'double': {
      if (!/^-?\d+(\.\d+)?$/.test(v)) return undefined;
      return v.includes('.') ? v : `${v}.0`;
    }
    case 'String':
      if (/^'(.*)'$/s.test(v)) return dartStringLiteral(single);
      if (/^"(.*)"$/s.test(v)) return dartStringLiteral(double);
      return undefined;
    case 'Map<String, dynamic>':
      if (/^\{.*\}$/s.test(v) || /^'\{.*\}'$/s.test(v)) return 'const <String, dynamic>{}';
      return undefined;
    default:
      if (dartBase.startsWith('List<')) return `const <${dartBase.slice('List<'.length, -1)}>[]`;
      return undefined;
  }
}

function zeroLiteral(dartBase: string): string | undefined {
  switch (dartBase) {
    case 'int': return '0';
    case 'double': return '0.0';
    case 'bool': return 'false';
    case 'Map<String, dynamic>': return 'const <String, dynamic>{}';
    default:
      if (dartBase.startsWith('List<')) return `const <${dartBase.slice('List<'.length, -1)}>[]`;
      return undefined;
  }
}

function dartStringLiteral(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\$/g, '\\$')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `'${escaped}'`;
}

const DART_KEYWORDS = new Set([
  'abstract', 'as', 'assert', 'async', 'await', 'break', 'case', 'catch', 'class',
  'const', 'continue', 'covariant', 'default', 'deferred', 'do', 'dynamic', 'else',
  'enum', 'export', 'extends', 'extension', 'external', 'factory', 'false', 'final',
  'finally', 'for', 'function', 'get', 'hide', 'if', 'implements', 'import', 'in',
  'interface', 'is', 'late', 'mixin', 'new', 'null', 'on', 'operator', 'part',
  'required', 'rethrow', 'return', 'set', 'show', 'static', 'super', 'switch',
  'sync', 'this', 'throw', 'true', 'try', 'typedef', 'var', 'void', 'while', 'with',
]);

function camelCase(raw: string): string {
  const parts = String(raw).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return 'value';
  const [head, ...rest] = parts;
  let camel = head.charAt(0).toLowerCase() + head.slice(1);
  for (const part of rest) {
    camel += part.charAt(0).toUpperCase() + part.slice(1);
  }
  if (/^[0-9]/.test(camel)) camel = `n${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
  if (DART_KEYWORDS.has(camel)) camel = `${camel}Value`;
  return camel;
}

function buildModelSpecs(tables: TableDefinition[], features?: string[] | null): ModelSpec[] {
  const specs: ModelSpec[] = [];
  const usedClasses = new Set<string>();
  const usedPaths = new Set<string>();

  tables.forEach((table, index) => {
    const rawTableName = String(table?.name ?? '').trim();
    if (!rawTableName) return;

    let base = toPascalCase(singularize(rawTableName));
    if (base.endsWith('Model')) base = base.slice(0, -'Model'.length) || 'Record';
    let className = `${base}Model`;
    if (usedClasses.has(className)) {
      className = `${toPascalCase(rawTableName)}Model`;
      if (usedClasses.has(className)) className = `${toPascalCase(rawTableName)}${index + 1}Model`;
    }
    usedClasses.add(className);

    const fileBase = toSnakeCase(className.slice(0, -'Model'.length)) || `table_${index + 1}`;
    const feature = featureForTable(rawTableName, features);
    let path = feature
      ? `lib/features/${feature}/data/models/${fileBase}_model.dart`
      : `lib/core/data/models/${fileBase}_model.dart`;
    if (usedPaths.has(path)) {
      let suffix = 2;
      while (usedPaths.has(path.replace(/_model\.dart$/, `_${suffix}_model.dart`))) suffix += 1;
      path = path.replace(/_model\.dart$/, `_${suffix}_model.dart`);
    }
    usedPaths.add(path);

    const fields: ModelField[] = [];
    const usedFields = new Set<string>();
    const columns = Array.isArray(table.columns) ? table.columns : [];
    for (const [colIndex, column] of columns.entries()) {
      const colName = String(column?.name ?? '').trim();
      if (!colName) continue;
      let field = camelCase(colName);
      if (usedFields.has(field)) field = `${field}${colIndex + 1}`;
      usedFields.add(field);

      const dartBase = dartTypeForColumn(column?.type);
      const nullable = column?.isNullable === true;
      const rawDefault = column?.defaultValue;
      const hasDefault = rawDefault !== undefined && String(rawDefault).trim() !== '';
      let defaultLiteral = hasDefault ? sqlLiteralToDart(dartBase, rawDefault) : undefined;
      if (hasDefault && defaultLiteral === undefined) {
        defaultLiteral = zeroLiteral(dartBase);
      }
      const required = !nullable && defaultLiteral === undefined;
      fields.push({
        column: { ...column, name: colName, type: String(column?.type ?? 'text') },
        field,
        dartBase,
        nullable,
        defaultLiteral,
        required,
      });
    }
    if (fields.length === 0) {
      fields.push({
        column: { name: 'id', type: 'text' },
        field: 'id',
        dartBase: 'String',
        nullable: false,
        required: true,
      });
    }

    specs.push({ table: rawTableName, className, fileBase, path, feature, fields });
  });

  return specs;
}

/**
 * Collect the model specs this pipeline works with: schema-derived when a
 * dataSchema exists, otherwise discovered from `_modelFiles` / generatedFiles.
 */
function collectModelSpecs(
  state: ProjectState,
  tables: TableDefinition[],
  features?: string[] | null
): ModelSpec[] {
  if (tables.length > 0) return buildModelSpecs(tables, features);

  const declared = Array.isArray(state._modelFiles) ? (state._modelFiles as string[]) : [];
  const discovered = [
    ...new Set(
      [...declared, ...[...(state.generatedFiles?.keys() ?? [])].filter((k) => /\/models\/[^/]+\.dart$/.test(k))]
    ),
  ].sort();

  return discovered.map((path) => {
    const base = path.split('/').pop()?.replace(/\.dart$/, '').replace(/_model$/, '') ?? 'record';
    const className = `${toPascalCase(base)}Model`;
    return {
      table: base,
      className,
      fileBase: toSnakeCase(base) || 'record',
      path,
      feature: null,
      fields: [],
    };
  });
}

function providerPathForModel(modelPath: string): string {
  const match = modelPath.match(/^lib\/(features\/[^/]+|core)\/data\/models\/([^/]+)\.dart$/);
  if (match) {
    const [, scope, file] = match;
    const base = file.replace(/_model$/, '');
    return `lib/${scope}/providers/${base}_provider.dart`;
  }
  const base = modelPath.split('/').pop()?.replace(/\.dart$/, '').replace(/_model$/, '') ?? 'model';
  return `lib/core/providers/${base}_provider.dart`;
}

function findSpecForProviderPath(
  specs: ModelSpec[],
  path: string,
  content: string
): ModelSpec | undefined {
  const byPath = specs.find((s) => providerPathForModel(s.path) === path);
  if (byPath) return byPath;
  return specs.find((s) => content.includes(s.className));
}

// ─────────────────────────────────────────────────────────────────────────
// Deterministic provider synthesis
// ─────────────────────────────────────────────────────────────────────────

function seedValueFor(field: ModelField, index: number): string {
  const i = index + 1;
  const name = field.field.toLowerCase();
  const base = field.dartBase;
  if (base === 'DateTime') return `'2026-02-${String(i).padStart(2, '0')}T09:30:00.000Z'`;
  if (base === 'bool') return i % 2 === 0 ? 'false' : 'true';
  if (base === 'int') {
    if (field.column.isPrimary || name === 'id') return `${100000000 + i * 7}`;
    return `${(i + 1) * 7}`;
  }
  if (base === 'double') return (((i + 1) * 19.5)).toFixed(1);
  if (base === 'Map<String, dynamic>') return '<String, dynamic>{}';
  if (base.startsWith('List<')) {
    const elem = base.slice('List<'.length, -1);
    if (elem === 'String') return `<String>['sample-${i}']`;
    if (elem === 'int') return `<int>[${i}]`;
    if (elem === 'double') return `<double>[${i}.0]`;
    if (elem === 'bool') return `<bool>[true]`;
    return `<${elem}>[]`;
  }
  if (field.column.isPrimary || name === 'id' || name.endsWith('id')) return `'00000000-0000-4000-8000-00000000000${i}'`;
  if (name.includes('email')) return `'sample${i}@example.com'`;
  if (name.includes('url') || name.includes('avatar') || name.includes('image')) return `'https://example.com/asset-${i}.png'`;
  if (name.includes('status')) return `'active'`;
  if (name.includes('color') || name.includes('colour')) return `'#2563EB'`;
  if (name.includes('priority')) return `'medium'`;
  if (name.includes('phone')) return `'+15555550${String(i).padStart(2, '0')}'`;
  if (name.includes('description') || name.includes('body') || name.includes('content') || name.includes('notes')) return `'Sample notes ${i}'`;
  if (name.includes('title') || name.endsWith('name') || name === 'name') return `'Sample ${i}'`;
  return `'Sample ${field.column.name} ${i}'`;
}

function seedJsonFor(spec: ModelSpec, index: number): string {
  const entries = spec.fields.map((field) => `'${field.column.name}': ${seedValueFor(field, index)},`);
  return `const <String, dynamic>{\n        ${entries.join('\n        ')}\n      }`;
}

function seedListFor(spec: ModelSpec): string {
  if (spec.fields.length === 0) return 'const []';
  const seeds = [seedJsonFor(spec, 0), seedJsonFor(spec, 1)];
  return `[\n      ${spec.className}.fromJson(${seeds.join(`),\n      ${spec.className}.fromJson(`)}),\n    ]`;
}

function keyFieldFor(spec: ModelSpec): ModelField | null {
  return (
    spec.fields.find((f) => f.column.isPrimary) ??
    spec.fields.find((f) => f.field === 'id') ??
    spec.fields.find((f) => f.dartBase === 'String' || f.dartBase === 'int') ??
    spec.fields[0] ??
    null
  );
}

function matchExpression(existing: string, item: string, keyField: ModelField | null): string {
  if (keyField) return `${existing}.${keyField.field} == ${item}.${keyField.field}`;
  return `identical(${existing}, ${item}) || ${existing} == ${item}`;
}

function keyParamType(keyField: ModelField | null): string {
  return keyField?.dartBase ?? 'String';
}

function canSeedFromJson(spec: ModelSpec): boolean {
  return spec.fields.length > 0;
}

function stateClassSource(className: string, modelParam: string): string[] {
  return [
    `class ${className}State {`,
    `  const ${className}State({this.items = const [], this.isLoading = false, this.error});`,
    ``,
    `  final List<${modelParam}> items;`,
    `  final bool isLoading;`,
    `  final String? error;`,
    ``,
    `  ${className}State copyWith({List<${modelParam}>? items, bool? isLoading, String? error, bool clearError = false}) =>`,
    `      ${className}State(`,
    `        items: items ?? this.items,`,
    `        isLoading: isLoading ?? this.isLoading,`,
    `        error: clearError ? null : (error ?? this.error),`,
    `      );`,
    `}`,
  ];
}

function synthesizeChangeNotifier(spec: ModelSpec, pkg: string, packages: Record<string, string>): string {
  const className = spec.className;
  const keyField = keyFieldFor(spec);
  const keyType = keyParamType(keyField);
  const matchExpr = matchExpression('existing', 'item', keyField);
  const modelUri = `package:${pkg}/${spec.path.replace(/^lib\//, '')}`;
  const hasProviderPkg = Boolean(packages['provider']);
  const seedLiteral = canSeedFromJson(spec) ? seedListFor(spec) : 'const []';

  const lines: string[] = [
    `import 'package:flutter/foundation.dart';`,
    ...(hasProviderPkg ? [`import 'package:provider/provider.dart';`] : []),
    `import '${modelUri}';`,
    ``,
    `enum ${className}ViewState { initial, loading, loaded, error }`,
    ``,
    `/// State controller for [${className}]. Loads, creates, updates and deletes [${className}] items.`,
    `class ${className}Provider extends ChangeNotifier {`,
    `  ${className}ViewState _state = ${className}ViewState.initial;`,
    `  List<${className}> _items = const [];`,
    `  String? _error;`,
    ``,
    `  ${className}ViewState get state => _state;`,
    `  List<${className}> get items => List<${className}>.unmodifiable(_items);`,
    `  String? get error => _error;`,
    `  bool get isLoading => _state == ${className}ViewState.loading;`,
    ``,
    `  Future<void> load() async {`,
    `    _state = ${className}ViewState.loading;`,
    `    _error = null;`,
    `    notifyListeners();`,
    `    try {`,
    `      await Future<void>.delayed(const Duration(milliseconds: 250));`,
    `      _items = _seed();`,
    `      _state = ${className}ViewState.loaded;`,
    `    } catch (err) {`,
    `      _error = err.toString();`,
    `      _state = ${className}ViewState.error;`,
    `    }`,
    `    notifyListeners();`,
    `  }`,
    ``,
    `  Future<void> refresh() => load();`,
    ``,
    `  Future<void> create(${className} item) async {`,
    `    _items = [..._items, item];`,
    `    _state = ${className}ViewState.loaded;`,
    `    notifyListeners();`,
    `  }`,
    ``,
    `  Future<void> update(${className} item) async {`,
    `    _items = [for (final existing in _items) ${matchExpr} ? item : existing];`,
    `    notifyListeners();`,
    `  }`,
    ``,
  ];

  if (keyField) {
    lines.push(`  Future<void> delete(${keyType} id) async {`);
    lines.push(`    _items = _items.where((existing) => existing.${keyField.field} != id).toList();`);
    lines.push(`    notifyListeners();`);
    lines.push(`  }`);
  } else {
    lines.push(`  Future<void> remove(${className} item) async {`);
    lines.push(`    _items = _items.where((existing) => existing != item).toList();`);
    lines.push(`    notifyListeners();`);
    lines.push(`  }`);
  }

  lines.push(``);
  lines.push(`  List<${className}> _seed() {`);
  lines.push(`    return ${seedLiteral};`);
  lines.push(`  }`);
  lines.push(`}`);

  if (hasProviderPkg) {
    lines.push(``);
    lines.push(`/// package:provider wiring for [${className}Provider].`);
    lines.push(`final ChangeNotifierProvider<${className}Provider> ${lowerFirst(className)}Provider =`);
    lines.push(`    ChangeNotifierProvider<${className}Provider>(create: (_) => ${className}Provider()..load());`);
  }
  lines.push(``);
  return lines.join('\n');
}

function synthesizeRiverpodNotifier(spec: ModelSpec, pkg: string, packages: Record<string, string>): string {
  const className = spec.className;
  const keyField = keyFieldFor(spec);
  const keyType = keyParamType(keyField);
  const matchExpr = matchExpression('existing', 'item', keyField);
  const modelUri = `package:${pkg}/${spec.path.replace(/^lib\//, '')}`;
  const importPkg = packages['flutter_riverpod'] ? 'flutter_riverpod' : 'riverpod';
  const seedLiteral = canSeedFromJson(spec) ? seedListFor(spec) : 'const []';

  const lines: string[] = [
    `import 'package:${importPkg}/${importPkg}.dart';`,
    `import '${modelUri}';`,
    ``,
    ...stateClassSource(className, className),
    ``,
    `/// 3.x-style StateNotifier for [${className}].`,
    `class ${className}Notifier extends StateNotifier<${className}State> {`,
    `  ${className}Notifier() : super(const ${className}State()) {`,
    `    load();`,
    `  }`,
    ``,
    `  Future<void> load() async {`,
    `    state = state.copyWith(isLoading: true, clearError: true);`,
    `    try {`,
    `      await Future<void>.delayed(const Duration(milliseconds: 250));`,
    `      state = state.copyWith(isLoading: false, items: _seed());`,
    `    } catch (err) {`,
    `      state = state.copyWith(isLoading: false, error: err.toString());`,
    `    }`,
    `  }`,
    ``,
    `  Future<void> refresh() => load();`,
    ``,
    `  void create(${className} item) {`,
    `    state = state.copyWith(items: [...state.items, item]);`,
    `  }`,
    ``,
    `  void updateItem(${className} item) {`,
    `    state = state.copyWith(items: [for (final existing in state.items) ${matchExpr} ? item : existing]);`,
    `  }`,
    ``,
  ];

  if (keyField) {
    lines.push(`  void removeItem(${keyType} id) {`);
    lines.push(`    state = state.copyWith(items: state.items.where((existing) => existing.${keyField.field} != id).toList());`);
    lines.push(`  }`);
  } else {
    lines.push(`  void removeItem(${className} item) {`);
    lines.push(`    state = state.copyWith(items: state.items.where((existing) => existing != item).toList());`);
    lines.push(`  }`);
  }

  lines.push(``);
  lines.push(`  List<${className}> _seed() {`);
  lines.push(`    return ${seedLiteral};`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`final ${lowerFirst(className)}Provider = StateNotifierProvider<${className}Notifier, ${className}State>((ref) => ${className}Notifier());`);
  lines.push(``);
  return lines.join('\n');
}

function synthesizeBlocCubit(spec: ModelSpec, pkg: string, packages: Record<string, string>): string {
  const className = spec.className;
  const keyField = keyFieldFor(spec);
  const keyType = keyParamType(keyField);
  const matchExpr = matchExpression('existing', 'item', keyField);
  const modelUri = `package:${pkg}/${spec.path.replace(/^lib\//, '')}`;
  const importPkg = packages['flutter_bloc'] ? 'flutter_bloc' : 'bloc';
  const seedLiteral = canSeedFromJson(spec) ? seedListFor(spec) : 'const []';

  const lines: string[] = [
    `import 'package:${importPkg}/${importPkg}.dart';`,
    `import '${modelUri}';`,
    ``,
    ...stateClassSource(className, className),
    ``,
    `/// Cubit for [${className}]. Pure business logic — pair with BlocBuilder/BlocConsumer at the call site.`,
    `class ${className}Cubit extends Cubit<${className}State> {`,
    `  ${className}Cubit() : super(const ${className}State()) {`,
    `    load();`,
    `  }`,
    ``,
    `  Future<void> load() async {`,
    `    emit(state.copyWith(isLoading: true, clearError: true));`,
    `    try {`,
    `      await Future<void>.delayed(const Duration(milliseconds: 250));`,
    `      emit(state.copyWith(isLoading: false, items: _seed()));`,
    `    } catch (err) {`,
    `      emit(state.copyWith(isLoading: false, error: err.toString()));`,
    `    }`,
    `  }`,
    ``,
    `  Future<void> refresh() => load();`,
    ``,
    `  Future<void> create(${className} item) async {`,
    `    emit(state.copyWith(items: [...state.items, item]));`,
    `  }`,
    ``,
    `  Future<void> updateItem(${className} item) async {`,
    `    emit(state.copyWith(items: [for (final existing in state.items) ${matchExpr} ? item : existing]));`,
    `  }`,
    ``,
  ];

  if (keyField) {
    lines.push(`  Future<void> removeItem(${keyType} id) async {`);
    lines.push(`    emit(state.copyWith(items: state.items.where((existing) => existing.${keyField.field} != id).toList()));`);
    lines.push(`  }`);
  } else {
    lines.push(`  Future<void> removeItem(${className} item) async {`);
    lines.push(`    emit(state.copyWith(items: state.items.where((existing) => existing != item).toList()));`);
    lines.push(`  }`);
  }

  lines.push(``);
  lines.push(`  List<${className}> _seed() {`);
  lines.push(`    return ${seedLiteral};`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);
  return lines.join('\n');
}

function synthesizeProviderContent(
  spec: ModelSpec,
  pkg: string,
  stateManagement: 'provider' | 'riverpod' | 'bloc',
  packages: Record<string, string>
): string {
  if (stateManagement === 'riverpod') return synthesizeRiverpodNotifier(spec, pkg, packages);
  if (stateManagement === 'bloc') return synthesizeBlocCubit(spec, pkg, packages);
  return synthesizeChangeNotifier(spec, pkg, packages);
}

// ─────────────────────────────────────────────────────────────────────────
// Output validation & hygiene
// ─────────────────────────────────────────────────────────────────────────

function stripCommentsOnly(src: string): string {
  let out = src;
  let prev = out;
  do {
    prev = out;
    out = out.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  } while (out !== prev);
  return out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function stripCommentsAndStrings(src: string): string {
  return stripCommentsOnly(src).replace(
    /r?'''[\s\S]*?'''|r?"""[\s\S]*?"""|r?'(?:\\.|[^'\\\n])*'|r?"(?:\\.|[^"\\\n])*"/g,
    (m) => ' '.repeat(m.length)
  );
}

function hasUnterminatedString(src: string): boolean {
  const s = stripCommentsOnly(src);
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch !== "'" && ch !== '"') {
      i += 1;
      continue;
    }
    const triple = s.startsWith(ch.repeat(3), i);
    const quote = triple ? ch.repeat(3) : ch;
    let j = i + quote.length;
    let closed = false;
    while (j < s.length) {
      const cj = s[j];
      if (!triple && cj === '\\') {
        j += 2;
        continue;
      }
      if (s.startsWith(quote, j)) {
        closed = true;
        j += quote.length;
        break;
      }
      if (!triple && (cj === '\n' || cj === '\r')) break;
      j += 1;
    }
    if (!closed) return true;
    i = j;
  }
  return false;
}

function validateDartSource(content: string): { ok: boolean; reason: string } {
  if (!content || content.trim().length < 20) return { ok: false, reason: 'empty output' };
  if (/\b(TODO|FIXME|XXX)\b/.test(content)) return { ok: false, reason: 'contains a TODO marker' };
  if (content.includes('UnimplementedError')) return { ok: false, reason: 'contains UnimplementedError' };
  if (/^\s*part\s+of\b/m.test(content)) return { ok: false, reason: 'contains a `part of` directive' };
  if (hasUnterminatedString(content)) return { ok: false, reason: 'unterminated string literal' };

  const stripped = stripCommentsAndStrings(content);
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  for (const ch of stripped) {
    if (ch === '{') braces += 1;
    else if (ch === '}') {
      braces -= 1;
      if (braces < 0) return { ok: false, reason: 'unbalanced braces' };
    } else if (ch === '(') parens += 1;
    else if (ch === ')') {
      parens -= 1;
      if (parens < 0) return { ok: false, reason: 'unbalanced parentheses' };
    } else if (ch === '[') brackets += 1;
    else if (ch === ']') {
      brackets -= 1;
      if (brackets < 0) return { ok: false, reason: 'unbalanced brackets' };
    }
  }
  if (braces !== 0 || parens !== 0 || brackets !== 0) {
    return { ok: false, reason: `unbalanced delimiters (braces ${braces}, parens ${parens}, brackets ${brackets})` };
  }
  return { ok: true, reason: 'ok' };
}

function isValidGeneratedPath(path: string): boolean {
  return (
    /^lib\/[A-Za-z0-9_.\-/]+\.dart$/.test(path) &&
    !path.includes('..') &&
    !path.includes('//') &&
    !/\s/.test(path)
  );
}

function normalizePosix(value: string): string {
  const out: string[] = [];
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** Import/export URIs in `content` that do not resolve against `candidates`. */
function unresolvedImports(
  content: string,
  filePath: string,
  candidates: Set<string>,
  pkg: string
): string[] {
  const missing: string[] = [];
  const re = /(?:import|export)\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const uri = match[1];
    if (uri.startsWith('dart:')) continue;
    if (uri.startsWith(`package:${pkg}/`)) {
      const target = `lib/${uri.slice(`package:${pkg}/`.length)}`;
      if (!candidates.has(target)) missing.push(uri);
      continue;
    }
    if (uri.startsWith('package:')) continue; // external dependency — assumed installed
    const dir = filePath.split('/').slice(0, -1).join('/');
    const resolved = normalizePosix(`${dir}/${uri}`);
    if (candidates.has(resolved)) continue;
    if (!resolved.endsWith('.dart') && candidates.has(`${resolved}.dart`)) continue;
    if (candidates.has(`${resolved}/index.dart`)) continue;
    missing.push(uri);
  }
  return missing;
}

function putGeneratedFile(
  files: Map<string, GeneratedFile>,
  path: string,
  language: string,
  content: string
): 'created' | 'modified' | 'kept' {
  const existing = files.get(path);
  if (existing && existing.content === content) return 'kept';
  files.set(path, {
    path,
    content,
    action: existing ? 'modified' : 'created',
    language,
  });
  return existing ? 'modified' : 'created';
}

function sortFiles(files: Map<string, GeneratedFile>): Map<string, GeneratedFile> {
  return new Map([...files.entries()].sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1)));
}

function generateThemeFallback(appName: string, primaryHex: string, font: string, radius: number, darkPreferred: boolean): string {
  return `import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

class ThemeNotifier extends ChangeNotifier {
  ThemeMode _mode = ${darkPreferred ? 'ThemeMode.dark' : 'ThemeMode.light'};
  ThemeMode get mode => _mode;

  ThemeNotifier() {
    _loadTheme();
  }

  Future<void> _loadTheme() async {
    final prefs = await SharedPreferences.getInstance();
    final isDark = prefs.getBool('pref_theme_mode') ?? ${darkPreferred ? 'true' : 'false'};
    _mode = isDark ? ThemeMode.dark : ThemeMode.light;
    notifyListeners();
  }

  Future<void> toggle() async {
    _mode = _mode == ThemeMode.dark ? ThemeMode.light : ThemeMode.dark;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('pref_theme_mode', _mode == ThemeMode.dark);
    notifyListeners();
  }

  bool get isDark => _mode == ThemeMode.dark;
}

class AppTheme {
  AppTheme._();

  static const Color _seed = Color(${primaryHex});
  static const double _radius = ${radius};

  static ThemeData get lightTheme => _buildTheme(Brightness.light);
  static ThemeData get darkTheme => _buildTheme(Brightness.dark);

  static ThemeData _buildTheme(Brightness brightness) {
    final cs = ColorScheme.fromSeed(seedColor: _seed, brightness: brightness);
    return ThemeData(
      useMaterial3: true,
      colorScheme: cs,
      fontFamily: '${font}',
      scaffoldBackgroundColor: cs.surface,
      appBarTheme: AppBarTheme(
        backgroundColor: cs.surface,
        foregroundColor: cs.onSurface,
        elevation: 0,
        scrolledUnderElevation: 1,
        centerTitle: false,
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(_radius),
          side: BorderSide(color: cs.outlineVariant, width: 1),
        ),
        color: cs.surfaceContainerLowest,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(_radius)),
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(_radius)),
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(_radius)),
        filled: true,
        fillColor: cs.surfaceContainerHighest.withValues(alpha: 0.5),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      ),
      navigationBarTheme: NavigationBarThemeData(
        indicatorColor: cs.primaryContainer,
        labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
        height: 72,
      ),
      listTileTheme: ListTileThemeData(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(_radius)),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(_radius)),
      ),
      textTheme: const TextTheme(
        displayLarge: TextStyle(fontSize: 57, fontWeight: FontWeight.w400),
        displayMedium: TextStyle(fontSize: 45, fontWeight: FontWeight.w400),
        headlineLarge: TextStyle(fontSize: 32, fontWeight: FontWeight.w700),
        headlineMedium: TextStyle(fontSize: 28, fontWeight: FontWeight.w600),
        headlineSmall: TextStyle(fontSize: 24, fontWeight: FontWeight.w600),
        titleLarge: TextStyle(fontSize: 22, fontWeight: FontWeight.w600),
        titleMedium: TextStyle(fontSize: 16, fontWeight: FontWeight.w500),
        bodyLarge: TextStyle(fontSize: 16, fontWeight: FontWeight.w400),
        bodyMedium: TextStyle(fontSize: 14, fontWeight: FontWeight.w400),
        labelLarge: TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
        labelMedium: TextStyle(fontSize: 12, fontWeight: FontWeight.w500),
      ),
    );
  }
}
`;
}
