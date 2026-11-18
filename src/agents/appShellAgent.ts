/**
 * App Shell Agent — per-app, LLM-generated product shell.
 *
 * Each generated app gets a different auth flow, onboarding, and settings page
 * because the LLM is given the same freedom Lovable's models have: complete,
 * domain-matched shell code written for this specific product.
 *
 * Deterministic-rails contract:
 *   - The LLM must produce the files listed in REQUIRED_SHELL_FILES.
 *   - The parser accepts ONLY // FILE: path/to.dart fenced output as valid.
 *   - After generation the artifact gate + repair loop handle malformed output.
 *   - lib/app/app.dart, lib/app/app_theme.dart (and lib/features/auth/
 *     presentation/auth_gate.dart when referenced) are written deterministically
 *     by this agent; the LLM never overrides them.
 *   - lib/core/router/app_router.dart is owned by the integration agent.
 */
import type { ProjectState, GeneratedFile } from '../orchestrator/state';
import { callLLMText, parseFilesFromLLMOutput, agentModelFor } from './llmClient';
import { enforceProjectContract } from './projectContract';

const REQUIRED_SHELL_FILES = [
  'lib/core/services/app_shell_client.dart',
  'lib/features/onboarding/presentation/onboarding_screen.dart',
  'lib/features/auth/presentation/sign_in_screen.dart',
  'lib/features/auth/presentation/sign_up_screen.dart',
  'lib/features/auth/presentation/forgot_password_screen.dart',
  'lib/features/settings/presentation/settings_screen.dart',
  'lib/features/account/presentation/account_screen.dart',
];

const APP_ROOT_PATH = 'lib/app/app.dart';
const THEME_PATH = 'lib/app/app_theme.dart';
const ROUTER_PATH = 'lib/core/router/app_router.dart';
const MAIN_PATH = 'lib/main.dart';
const AUTH_GATE_PATH = 'lib/features/auth/presentation/auth_gate.dart';
const SIGN_IN_PATH = 'lib/features/auth/presentation/sign_in_screen.dart';

/** Paths whose content is owned deterministically; LLM output there is dropped. */
const CONTRACT_OWNED_PATHS = new Set([
  APP_ROOT_PATH,
  THEME_PATH,
  ROUTER_PATH,
  MAIN_PATH,
  AUTH_GATE_PATH,
]);

const FORBIDDEN_OUTPUT = /TODO|FIXME|UnimplementedError|not implemented|coming soon/i;

export async function runAppShellAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const brief = state.productBrief?.oneLiner || state.productBrief?.appName || 'A modern app';
  const appName = state.productBrief?.appName || 'FlutterForge';
  const pkg = toPackageName(appName);
  const tokens = state.designTokens;
  const intake = state._intakeData as Record<string, unknown> | undefined;
  const domain = (intake?.domain as string) || 'general';
  const files = new Map<string, GeneratedFile>(state.generatedFiles ?? []);

  const systemPrompt = `You are a senior Flutter engineer shipping a complete product shell.
Output ONLY valid Dart files. No explanations. No markdown apologies. Each file MUST be complete and compilable.
All imports must use package:${pkg}/... with THIS EXACT package name. Use Material 3. Real widgets. Real handlers. No TODOs. No placeholders. No 'Item 1', no 'Your list here'.

Files to generate:
1. lib/core/services/app_shell_client.dart
2. lib/features/onboarding/presentation/onboarding_screen.dart
3. lib/features/auth/presentation/sign_in_screen.dart
4. lib/features/auth/presentation/sign_up_screen.dart
5. lib/features/auth/presentation/forgot_password_screen.dart
6. lib/features/settings/presentation/settings_screen.dart
7. lib/features/account/presentation/account_screen.dart

do NOT emit lib/core/router/app_router.dart, lib/app/app.dart, lib/app/app_theme.dart or lib/main.dart — those are produced deterministically by the pipeline and cannot be overridden.

app_shell_client.dart MUST export:
  class AppShellClient extends ChangeNotifier with a single static member 'instance'; expose it
  field _user (UserProfile?), methods: signIn(email,password), signUp(name,email,password), signOut(), notificationsEnabled (bool getter)+setter, onboarded (bool getter)+setter
  Persist what matters (onboarding done, username, theme preference, notification preference) to SharedPreferences.

SignInScreen must be declared as \`class SignInScreen extends StatelessWidget\` or \`class SignInScreen extends StatefulWidget\` in lib/features/auth/presentation/sign_in_screen.dart — the router depends on that exact class.

Horrified by generics — design each screen for THIS app. A fitness app gets a different hero, message, and CTA copy than a personal finance app. Never output boilerplate.`;

  const userPrompt = `App: ${appName}
Brief: ${brief}
Domain: ${domain}
Design tokens:
  primary: ${tokens?.primaryColor || '#2563EB'}
  secondary: ${tokens?.secondaryColor || '#7C3AED'}
  accent: ${tokens?.accentColor || '#F59E0B'}
  background: ${tokens?.backgroundColor || '#FAFAFA'}
  surface: ${tokens?.surfaceColor || '#FFFFFF'}
  fontFamily: ${tokens?.fontFamily || 'Inter'}
  borderRadius: ${tokens?.borderRadius ?? 12}
  prefersDark: ${tokens?.isDarkPreferred ? 'yes' : 'no'}
Product name: ${appName}

Generate ALL 7 files above so this product feels like ITSELF, not a template.`;

  let raw = '';
  try {
    raw = await callLLMText(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { model: agentModelFor('frontend-builder'), temperature: 0.4, maxTokens: 9000 },
    );
  } catch (err) {
    console.warn('[AppShellAgent] LLM shell failed — deterministic fallback required:', err);
    raw = '';
  }

  // ── 1. Merge LLM output, dropping contract-owned and invalid files ─
  const parsed = parseFilesFromLLMOutput(raw);
  const droppedFiles: string[] = [];
  for (const f of parsed) {
    if (typeof f.path !== 'string' || !f.path.endsWith('.dart')) continue;
    const normalizedPath = f.path.replace(/\\/g, '/');
    if (CONTRACT_OWNED_PATHS.has(normalizedPath.toLowerCase())) {
      droppedFiles.push(`${normalizedPath} (owned deterministically)`);
      continue;
    }
    if (!f.content || f.content.length <= 40) continue;
    if (FORBIDDEN_OUTPUT.test(f.content)) {
      droppedFiles.push(`${normalizedPath} (placeholder markers)`);
      continue;
    }
    files.set(normalizedPath, { path: normalizedPath, action: 'created', language: 'dart', content: f.content });
  }

  // ── 2. Deterministic shell files — always authoritative ────────────
  files.set(THEME_PATH, {
    path: THEME_PATH,
    action: 'created',
    language: 'dart',
    content: generateAppTheme(tokens),
  });

  files.set(APP_ROOT_PATH, {
    path: APP_ROOT_PATH,
    action: 'created',
    language: 'dart',
    content: generateAppRoot(pkg, appName),
  });

  // ── 3. The router imports sign_in_screen.dart by exact path and class ─
  // Keep it only when the LLM produced a conforming implementation;
  // otherwise write a deterministic one.
  ensureSignInScreen(files, pkg);

  // ── 4. auth_gate.dart — only when something references it ──────────
  const authGateWritten = ensureAuthGateIfReferenced(files, pkg, appName);

  // Verify the shell files the LLM was required to produce. The deterministic
  // contract below repairs the import/file graph (including app_shell_client)
  // before QA runs, so a free-tier model cannot leave the project unbuildable.
  const missingShellFiles = REQUIRED_SHELL_FILES.filter((path) => !files.has(path));
  if (missingShellFiles.length > 0) {
    console.warn(`[AppShellAgent] LLM missed ${missingShellFiles.length} shell file(s): ${missingShellFiles.join(', ')}. Contract normalizer will repair the graph.`);
  }

  const contract = enforceProjectContract(files, {
    appName,
    pkgName: pkg,
    usesSupabase: (state._intakeData as Record<string, unknown> | undefined)?.usesSupabase === true
      || [...files.values()].some((file) => file.content.includes('supabase_flutter')),
  });

  return {
    generatedFiles: contract.files,
    logs: [
      ...state.logs,
      `[App Shell Agent] Shell generated for ${appName} — ${parsed.length} LLM file(s); deterministic shell: app.dart, app_theme.dart${authGateWritten ? ', auth_gate.dart' : ''}${droppedFiles.length ? `; dropped ${droppedFiles.length} LLM file(s)` : ''}${missingShellFiles.length ? `; ${missingShellFiles.length} repaired by contract` : ''}`,
      ...(contract.changes.length > 0
        ? [`[Project Contract] ${contract.changes.slice(0, 8).join('; ')}${contract.changes.length > 8 ? ` (+${contract.changes.length - 8} more)` : ''}`]
        : []),
    ],
  };
}

// ─── Deterministic writers ────────────────────────────────────────────

function toPackageName(appName: string): string {
  return appName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'app';
}

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

/** Parse a hex color (#RGB, #RRGGBB, #AARRGGBB, 0x...) with a safe fallback. */
function parseHexColor(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  let hex = value.trim();
  if (/^0x/i.test(hex)) hex = hex.slice(2);
  hex = hex.replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(hex)) return fallback;
  if (hex.length === 3) {
    hex = hex.split('').map((c) => c + c).join('');
  }
  if (hex.length === 6) hex = `FF${hex}`;
  if (hex.length !== 8) return fallback;
  const parsed = Number.parseInt(hex, 16);
  return Number.isFinite(parsed) ? parsed >>> 0 : fallback;
}

function hexLiteral(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

function clampRadius(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 12;
  return Math.min(64, Math.max(0, Math.round(value)));
}

const FALLBACK_PRIMARY = 0xFF2563EB;
const FALLBACK_SECONDARY = 0xFF7C3AED;
const FALLBACK_ACCENT = 0xFFF59E0B;
const FALLBACK_BACKGROUND = 0xFFFAFAFA;
const FALLBACK_SURFACE = 0xFFFFFFFF;

/**
 * Material 3 light + dark ThemeData. Colors come from the design tokens with
 * safe fallbacks — never from a hardcoded neon palette.
 */
export function generateAppTheme(tokens: ProjectState['designTokens']): string {
  const primary = hexLiteral(parseHexColor(tokens?.primaryColor, FALLBACK_PRIMARY));
  const secondary = hexLiteral(parseHexColor(tokens?.secondaryColor, FALLBACK_SECONDARY));
  const accent = hexLiteral(parseHexColor(tokens?.accentColor, FALLBACK_ACCENT));
  const background = hexLiteral(parseHexColor(tokens?.backgroundColor, FALLBACK_BACKGROUND));
  const surface = hexLiteral(parseHexColor(tokens?.surfaceColor, FALLBACK_SURFACE));
  const radius = clampRadius(tokens?.borderRadius);
  const fontFamily = escapeDartString((tokens?.fontFamily ?? '').toString().trim() || 'Inter');

  return `import 'package:flutter/material.dart';

/// Single source of truth for the app theme.
///
/// Light and dark Material 3 schemes are derived from the design tokens
/// captured for this app; when a token is missing a safe fallback is used.
const Color _seedPrimary = Color(${primary});
const Color _seedSecondary = Color(${secondary});
const Color _seedTertiary = Color(${accent});
const Color _lightBackground = Color(${background});
const Color _lightSurface = Color(${surface});
const double _radius = ${radius};
const String _fontFamily = '${fontFamily}';

ColorScheme _buildScheme(Brightness brightness, Color? surface) {
  return ColorScheme.fromSeed(
    seedColor: _seedPrimary,
    brightness: brightness,
    secondary: _seedSecondary,
    tertiary: _seedTertiary,
    surface: surface,
  );
}

ThemeData _buildTheme(ColorScheme scheme, Color scaffoldBackground) {
  final borderRadius = BorderRadius.circular(_radius);
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: scaffoldBackground,
    fontFamily: _fontFamily,
    appBarTheme: const AppBarTheme(
      centerTitle: false,
      elevation: 0,
      scrolledUnderElevation: 0,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      border: OutlineInputBorder(borderRadius: borderRadius),
      enabledBorder: OutlineInputBorder(borderRadius: borderRadius),
      focusedBorder: OutlineInputBorder(
        borderRadius: borderRadius,
        borderSide: BorderSide(color: scheme.primary, width: 2),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        shape: RoundedRectangleBorder(borderRadius: borderRadius),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        shape: RoundedRectangleBorder(borderRadius: borderRadius),
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      indicatorColor: scheme.secondaryContainer,
      labelBehavior: NavigationDestinationLabelBehavior.onlyShowSelected,
    ),
  );
}

class AppTheme {
  AppTheme._();

  static final ColorScheme lightColorScheme = _buildScheme(Brightness.light, _lightSurface);
  static final ColorScheme darkColorScheme = _buildScheme(Brightness.dark, null);

  static final ThemeData lightTheme = _buildTheme(lightColorScheme, _lightBackground);
  static final ThemeData darkTheme = _buildTheme(darkColorScheme, darkColorScheme.surface);
}
`;
}

/** Root widget — MaterialApp.router wired to the GoRouter. No hardcoded home:. */
export function generateAppRoot(pkg: string, appName: string): string {
  return `import 'package:flutter/material.dart';
import 'package:${pkg}/app/app_theme.dart';
import 'package:${pkg}/core/router/app_router.dart';

/// Root widget. Router and theme are wired here.
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

/**
 * The integration router imports this exact file and class. When the LLM
 * output is missing or unusable, a deterministic implementation is written.
 */
function ensureSignInScreen(files: Map<string, GeneratedFile>, pkg: string): void {
  const existing = files.get(SIGN_IN_PATH);
  const valid = existing
    && /class\s+SignInScreen\s+extends\s+(StatelessWidget|StatefulWidget)\b/.test(existing.content)
    && !FORBIDDEN_OUTPUT.test(existing.content);
  if (valid) return;
  files.set(SIGN_IN_PATH, {
    path: SIGN_IN_PATH,
    action: 'created',
    language: 'dart',
    content: deterministicSignInScreen(pkg),
  });
}

function deterministicSignInScreen(pkg: string): string {
  return `import 'package:flutter/material.dart';
import 'package:${pkg}/core/services/app_shell_client.dart';

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key});

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final GlobalKey<FormState> _formKey = GlobalKey<FormState>();
  final TextEditingController _email = TextEditingController();
  final TextEditingController _password = TextEditingController();
  bool _submitting = false;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _submitting = true);
    final client = AppShellClient.instance;
    final ok = await client.signIn(_email.text.trim(), _password.text);
    if (!mounted) return;
    setState(() => _submitting = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(ok ? 'Signed in.' : client.error ?? 'Unable to sign in.')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text('Sign in', style: theme.textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w700)),
                    const SizedBox(height: 8),
                    Text(
                      'Sign in to continue where you left off.',
                      style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                    ),
                    const SizedBox(height: 24),
                    TextFormField(
                      controller: _email,
                      keyboardType: TextInputType.emailAddress,
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(labelText: 'Email'),
                      validator: (value) {
                        final email = (value ?? '').trim();
                        return email.contains('@') && email.contains('.') ? null : 'Enter a valid email';
                      },
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _password,
                      obscureText: true,
                      textInputAction: TextInputAction.done,
                      decoration: const InputDecoration(labelText: 'Password'),
                      validator: (value) => (value ?? '').length < 6 ? 'Use at least 6 characters' : null,
                      onFieldSubmitted: (_) => _submit(),
                    ),
                    const SizedBox(height: 24),
                    FilledButton(
                      onPressed: _submitting ? null : _submit,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        child: _submitting
                            ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                            : const Text('Sign in'),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
`;
}

/**
 * auth_gate.dart is only generated when something in the generated file graph
 * references it. Never written speculatively.
 */
function ensureAuthGateIfReferenced(files: Map<string, GeneratedFile>, pkg: string, appName: string): boolean {
  const referenced = [...files.values()].some((file) => (
    file.path.endsWith('.dart')
    && (file.content.includes('auth_gate.dart') || /\bAuthGate\b/.test(file.content))
  ));
  if (!referenced) return false;

  const existing = files.get(AUTH_GATE_PATH);
  const valid = existing
    && /class\s+AuthGate\s+extends\s+(StatelessWidget|StatefulWidget)\b/.test(existing.content)
    && !FORBIDDEN_OUTPUT.test(existing.content);
  if (valid) return false;

  files.set(AUTH_GATE_PATH, {
    path: AUTH_GATE_PATH,
    action: 'created',
    language: 'dart',
    content: deterministicAuthGate(pkg, appName),
  });
  return true;
}

function deterministicAuthGate(pkg: string, appName: string): string {
  const commentName = appName.replace(/[\r\n]+/g, ' ');
  return `import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:${pkg}/core/services/app_shell_client.dart';

/// Gates [child] behind the signed-in session for ${commentName}.
///
/// Reacts to session changes via the shared AppShellClient listenable and
/// routes signed-out visitors to the login route.
class AuthGate extends StatelessWidget {
  const AuthGate({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: AppShellClient.instance,
      builder: (context, _) {
        if (AppShellClient.instance.isSignedIn) return child;
        return Scaffold(
          body: SafeArea(
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.lock_outline_rounded, size: 48, color: Theme.of(context).colorScheme.primary),
                  const SizedBox(height: 12),
                  Text('Sign in required', style: Theme.of(context).textTheme.titleLarge),
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed: () => context.go('/auth/login'),
                    child: const Text('Go to sign in'),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
`;
}
