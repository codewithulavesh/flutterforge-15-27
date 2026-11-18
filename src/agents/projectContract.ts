/**
 * Project contract normalizer.
 *
 * The multi-agent pipeline is allowed to be creative about layout, but the
 * finished project must obey one deterministic contract before QA or the
 * compiler sees it:
 *
 *   lib/main.dart
 *   lib/app/app.dart          (single app root)
 *   lib/app/app_theme.dart    (light + dark ThemeData)
 *   lib/core/router/app_router.dart
 *   lib/features/<feature>/screens/<screen>_screen.dart
 *
 * Every `package:<app>/...` and relative import must resolve. Missing shell
 * files that the app imports are generated deterministically. This module is
 * intentionally boring: it never guesses business logic, it only enforces the
 * file/import graph so the real analyzer gate has a fair chance to pass.
 */
import type { GeneratedFile } from '../orchestrator/state';
import { pubspecPackageName, validateProjectFiles } from '../agent/preWriteValidator';

export interface ProjectContractResult {
  files: Map<string, GeneratedFile>;
  changes: string[];
  blockers: string[];
}

const APP_ROOT = 'lib/app/app.dart';
const LEGACY_APP_ROOT = 'lib/app.dart';
const THEME = 'lib/app/app_theme.dart';
const LEGACY_THEME = 'lib/core/theme/app_theme.dart';
const ROUTER = 'lib/core/router/app_router.dart';
const MAIN = 'lib/main.dart';
const SHELL_CLIENT = 'lib/core/services/app_shell_client.dart';
const SHELL_SCREEN_PATTERN = /^lib\/features\/(onboarding|auth|settings|account)\/presentation\/[^/]+\.dart$/;

const DART_IMPORT = /(import|export|part)\s+['"]([^'"]+)['"]/g;

function normalizePosix(value: string): string {
  const out: string[] = [];
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function resolveRelative(fromFile: string, uri: string): string {
  const directory = fromFile.split('/').slice(0, -1).join('/');
  return normalizePosix(`${directory}/${uri}`);
}

function relativeImport(fromFile: string, target: string): string {
  const from = fromFile.split('/').slice(0, -1);
  const to = target.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared += 1;
  const up = Array.from({ length: from.length - shared }, () => '..');
  const down = to.slice(shared);
  const path = [...up, ...down].join('/');
  return path.startsWith('.') ? path : `./${path}`;
}

/** Every URI that is not `dart:`/`package:` is a project-relative file. */
function isRelativeUri(uri: string): boolean {
  return Boolean(uri) && !uri.startsWith('dart:') && !uri.startsWith('package:');
}

function classFromPath(filePath: string): string {
  const base = (filePath.split('/').pop() ?? 'screen.dart').replace(/\.dart$/, '');
  const name = base
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return /^[A-Z]/.test(name) ? name : `App${name}`;
}

function classFromContent(content: string, fallback: string): string {
  const match = content.match(/\bclass\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+(?:StatelessWidget|StatefulWidget)\b/);
  return match?.[1] ?? fallback;
}

function titleFromPath(filePath: string): string {
  return (filePath.split('/').pop() ?? 'App')
    .replace(/\.dart$/, '')
    .replace(/_screen$/, '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function put(files: Map<string, GeneratedFile>, filePath: string, content: string): void {
  const existing = files.get(filePath);
  files.set(filePath, {
    path: filePath,
    content,
    action: existing ? 'modified' : 'created',
    language: filePath.endsWith('.dart') ? 'dart' : filePath.endsWith('.yaml') ? 'yaml' : 'text',
  });
}

/** Rewrite package + relative imports that point at `from` so they point at `to`. */
function rewriteTarget(files: Map<string, GeneratedFile>, from: string, to: string): string[] {
  if (from === to) return [];
  const changed = new Set<string>();
  const fromNoLib = from.replace(/^lib\//, '');
  const toNoLib = to.replace(/^lib\//, '');
  for (const [filePath, file] of files) {
    if (!filePath.endsWith('.dart')) continue;
    let next = file.content;
    next = next.split(`/${fromNoLib}`).join(`/${toNoLib}`);
    next = next.replace(DART_IMPORT, (whole, keyword, uri) => {
      if (!isRelativeUri(uri)) return whole;
      const absolute = resolveRelative(filePath, uri);
      if (absolute === from || absolute === from.replace(/\.dart$/, '')) {
        return `${keyword} '${relativeImport(filePath, to)}'`;
      }
      return whole;
    });
    if (next !== file.content) {
      put(files, filePath, next);
      changed.add(filePath);
    }
  }
  return [...changed];
}

/** Move a file and fix both package and relative imports that pointed at it. */
function moveFile(files: Map<string, GeneratedFile>, from: string, to: string): string[] {
  const file = files.get(from);
  if (!file || from === to) return [];
  const changed = new Set<string>(rewriteTarget(files, from, to));
  files.delete(from);
  put(files, to, file.content);
  changed.add(to);
  return [...changed];
}

function themeFallback(): string {
  return `import 'package:flutter/material.dart';

/// Single source of truth for the app theme.
class AppTheme {
  AppTheme._();

  static const Color seed = Color(0xFF2563EB);

  static final ThemeData lightTheme = ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(seedColor: seed),
    visualDensity: VisualDensity.adaptivePlatformDensity,
  );

  static final ThemeData darkTheme = ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(seedColor: seed, brightness: Brightness.dark),
    visualDensity: VisualDensity.adaptivePlatformDensity,
  );
}
`;
}

function appRootFallback(pkg: string): string {
  return `import 'package:flutter/material.dart';
import 'package:${pkg}/app/app_theme.dart';
import 'package:${pkg}/core/router/app_router.dart';

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'FlutterForge App',
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

function mainFallback(pkg: string, usesSupabase: boolean): string {
  return usesSupabase
    ? `import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:${pkg}/app/app.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Supabase.initialize(
    url: const String.fromEnvironment('SUPABASE_URL', defaultValue: ''),
    anonKey: const String.fromEnvironment('SUPABASE_ANON_KEY', defaultValue: ''),
  );
  runApp(const App());
}
`
    : `import 'package:flutter/material.dart';
import 'package:${pkg}/app/app.dart';

void main() {
  runApp(const App());
}
`;
}

function shellClientFallback(): string {
  return `import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

class UserProfile {
  const UserProfile({required this.id, required this.name, required this.email});

  final String id;
  final String name;
  final String email;
}

/// Local account/session facade used by the generated shell screens.
///
/// It persists onboarding and profile preferences and keeps the UI responsive
/// without pretending a remote backend exists.
class AppShellClient extends ChangeNotifier {
  AppShellClient._();

  static final AppShellClient instance = AppShellClient._();
  static SharedPreferences? _prefs;

  UserProfile? _user;
  bool _onboarded = false;
  bool _notificationsEnabled = true;
  bool _busy = false;
  String? _error;

  UserProfile? get user => _user;
  bool get isSignedIn => _user != null;
  bool get onboarded => _onboarded;
  bool get notificationsEnabled => _notificationsEnabled;
  bool get busy => _busy;
  String? get error => _error;

  set onboarded(bool value) {
    if (_onboarded == value) return;
    _onboarded = value;
    _prefs?.setBool('ff_onboarded', value);
    notifyListeners();
  }

  set notificationsEnabled(bool value) {
    if (_notificationsEnabled == value) return;
    _notificationsEnabled = value;
    _prefs?.setBool('ff_notifications', value);
    notifyListeners();
  }

  static void init(SharedPreferences prefs) {
    _prefs = prefs;
    final client = AppShellClient.instance;
    client._onboarded = prefs.getBool('ff_onboarded') ?? false;
    client._notificationsEnabled = prefs.getBool('ff_notifications') ?? true;
    final name = prefs.getString('ff_user_name');
    final email = prefs.getString('ff_user_email');
    if (name != null && email != null && email.isNotEmpty) {
      client._user = UserProfile(id: email, name: name, email: email);
    }
    client.notifyListeners();
  }

  Future<bool> signIn(String email, String password) async {
    final normalized = email.trim();
    if (!_validCredentials(normalized, password)) {
      _error = 'Enter a valid email and a password of at least 6 characters.';
      notifyListeners();
      return false;
    }
    _busy = true;
    _error = null;
    notifyListeners();
    await Future<void>.delayed(const Duration(milliseconds: 350));
    final name = _prefs?.getString('ff_user_name') ?? normalized.split('@').first;
    _user = UserProfile(id: normalized, name: name, email: normalized);
    await _prefs?.setString('ff_user_email', normalized);
    await _prefs?.setString('ff_user_name', name);
    _busy = false;
    notifyListeners();
    return true;
  }

  Future<bool> signUp(String name, String email, String password) async {
    final normalizedName = name.trim();
    final normalizedEmail = email.trim();
    if (normalizedName.length < 2 || !_validCredentials(normalizedEmail, password)) {
      _error = 'Enter your name, a valid email, and a password of at least 6 characters.';
      notifyListeners();
      return false;
    }
    _busy = true;
    _error = null;
    notifyListeners();
    await Future<void>.delayed(const Duration(milliseconds: 350));
    _user = UserProfile(id: normalizedEmail, name: normalizedName, email: normalizedEmail);
    await _prefs?.setString('ff_user_email', normalizedEmail);
    await _prefs?.setString('ff_user_name', normalizedName);
    _busy = false;
    notifyListeners();
    return true;
  }

  Future<void> signOut() async {
    _user = null;
    await _prefs?.remove('ff_user_email');
    await _prefs?.remove('ff_user_name');
    notifyListeners();
  }

  bool _validCredentials(String email, String password) {
    return email.contains('@') && email.contains('.') && password.length >= 6;
  }
}
`;
}

function shellScreenFallback(filePath: string): string {
  const cls = classFromPath(filePath);
  const title = titleFromPath(filePath);
  if (filePath.includes('/onboarding/')) {
    return `import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:__PKG__/core/services/app_shell_client.dart';

class ${cls} extends StatelessWidget {
  const ${cls}({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Spacer(),
              Icon(Icons.auto_awesome_rounded, size: 56, color: theme.colorScheme.primary),
              const SizedBox(height: 24),
              Text('Welcome', style: theme.textTheme.displaySmall?.copyWith(fontWeight: FontWeight.w700)),
              const SizedBox(height: 12),
              Text(
                'Set up your workspace once. Everything you create stays available on this device.',
                style: theme.textTheme.bodyLarge?.copyWith(color: theme.colorScheme.onSurfaceVariant),
              ),
              const Spacer(),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: () async {
                    final prefs = await SharedPreferences.getInstance();
                    AppShellClient.init(prefs);
                    AppShellClient.instance.onboarded = true;
                    if (!context.mounted) return;
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('You are ready to continue.')),
                    );
                  },
                  child: const Padding(
                    padding: EdgeInsets.symmetric(vertical: 14),
                    child: Text('Get started'),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
`;
  }
  if (filePath.includes('/auth/')) {
    const isSignUp = filePath.includes('sign_up');
    const isForgot = filePath.includes('forgot');
    return `import 'package:flutter/material.dart';
import 'package:__PKG__/core/services/app_shell_client.dart';

class ${cls} extends StatefulWidget {
  const ${cls}({super.key});

  @override
  State<${cls}> createState() => _${cls}State();
}

class _${cls}State extends State<${cls}> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _submitting = false;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _submitting = true);
    final client = AppShellClient.instance;
    final ok = ${isForgot
      ? `client.signIn(_email.text, 'reset-password')`
      : isSignUp
        ? `client.signUp(_name.text, _email.text, _password.text)`
        : `client.signIn(_email.text, _password.text)`};
    if (!mounted) return;
    setState(() => _submitting = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(ok ? '${isForgot ? 'Reset link prepared for this device.' : isSignUp ? 'Account created.' : 'Signed in.'}' : client.error ?? 'Something went wrong.')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('${title}')),
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
                    Text('${title}', style: theme.textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w700)),
                    const SizedBox(height: 8),
                    Text('${isForgot ? 'Enter your account email to prepare a reset.' : isSignUp ? 'Create your account to keep your work in one place.' : 'Sign in to continue where you left off.'}',
                        style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
                    const SizedBox(height: 24),
                    ${isSignUp ? `TextFormField(
                      controller: _name,
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(labelText: 'Name'),
                      validator: (value) => (value ?? '').trim().length < 2 ? 'Enter your name' : null,
                    ),
                    const SizedBox(height: 12),` : ''}
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
                    if (!${isForgot ? 'true' : 'false'}) ...[
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: _password,
                        obscureText: true,
                        decoration: const InputDecoration(labelText: 'Password'),
                        validator: (value) => (value ?? '').length < 6 ? 'Use at least 6 characters' : null,
                      ),
                    ],
                    const SizedBox(height: 24),
                    FilledButton(
                      onPressed: _submitting ? null : _submit,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        child: _submitting
                            ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                            : Text('${isForgot ? 'Send reset link' : isSignUp ? 'Create account' : 'Sign in'}'),
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
  if (filePath.includes('/settings/')) {
    return `import 'package:flutter/material.dart';
import 'package:__PKG__/core/services/app_shell_client.dart';

class ${cls} extends StatelessWidget {
  const ${cls}({super.key});

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: AppShellClient.instance,
      builder: (context, _) {
        final client = AppShellClient.instance;
        return Scaffold(
          appBar: AppBar(title: const Text('Settings')),
          body: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              SwitchListTile(
                value: client.notificationsEnabled,
                onChanged: (value) => client.notificationsEnabled = value,
                title: const Text('Notifications'),
                subtitle: const Text('Reminders and product updates'),
              ),
              ListTile(
                leading: const Icon(Icons.person_outline_rounded),
                title: const Text('Account'),
                subtitle: Text(client.user?.email ?? 'Not signed in'),
              ),
              ListTile(
                leading: const Icon(Icons.info_outline_rounded),
                title: const Text('About'),
                subtitle: const Text('Generated with FlutterForge'),
              ),
            ],
          ),
        );
      },
    );
  }
}
`;
  }
  return `import 'package:flutter/material.dart';
import 'package:__PKG__/core/services/app_shell_client.dart';

class ${cls} extends StatelessWidget {
  const ${cls}({super.key});

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: AppShellClient.instance,
      builder: (context, _) {
        final client = AppShellClient.instance;
        final user = client.user;
        return Scaffold(
          appBar: AppBar(title: const Text('Account')),
          body: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              CircleAvatar(
                radius: 36,
                child: Text((user?.name.isNotEmpty ?? false) ? user!.name[0].toUpperCase() : '?'),
              ),
              const SizedBox(height: 12),
              Center(
                child: Text(
                  user?.name ?? 'Guest',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              Center(
                child: Text(
                  user?.email ?? 'Sign in to sync your profile',
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                ),
              ),
              const SizedBox(height: 24),
              if (user != null)
                OutlinedButton.icon(
                  onPressed: () => client.signOut(),
                  icon: const Icon(Icons.logout_rounded),
                  label: const Text('Sign out'),
                ),
            ],
          ),
        );
      },
    );
  }
}
`;
  return `import 'package:flutter/material.dart';

class ${cls} extends StatelessWidget {
  const ${cls}({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('${title}')),
      body: Center(
        child: Text('${title}', style: Theme.of(context).textTheme.headlineSmall),
      ),
    );
  }
}
`;
}

function genericScreenFallback(filePath: string): string {
  const cls = classFromPath(filePath);
  const title = titleFromPath(filePath);
  return `import 'package:flutter/material.dart';

class ${cls} extends StatelessWidget {
  const ${cls}({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('${title}')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.dashboard_customize_outlined, size: 56, color: theme.colorScheme.primary),
              const SizedBox(height: 16),
              Text('${title}', style: theme.textTheme.headlineSmall),
              const SizedBox(height: 8),
              Text(
                'This screen is connected to the app shell and ready for its feature implementation.',
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
`;
}

function screenRoute(filePath: string, index: number): string {
  const match = filePath.match(/^lib\/features\/([^/]+)\/screens\/([^/]+)\.dart$/);
  if (!match) return index === 0 ? '/' : `/screen-$index`;
  const feature = match[1];
  const base = match[2].replace(/_screen$/, '');
  if (base === 'home' || feature === 'home') return '/';
  if (base === feature || base === 'index') return `/${feature}`;
  return `/${feature}/${base}`;
}

function routerFallback(pkg: string, screens: Array<{ path: string; className: string }>): string {
  const imports = screens
    .map((screen) => `import 'package:${pkg}/${screen.path.replace(/^lib\//, '')}';`)
    .join('\n');

  const usedRoutes = new Set<string>();
  const routes = screens.map((screen, index) => {
    let route = screenRoute(screen.path, index);
    if (usedRoutes.has(route)) route = `${route.replace(/\/$/, '')}/view-${index}`;
    usedRoutes.add(route);
    return `    GoRoute(
      path: '${route}',
      builder: (context, state) => ${screen.className}(),
    ),`;
  }).join('\n');

  return `import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
${imports}

final appRouter = GoRouter(
  initialLocation: '/',
  routes: [
${routes}
  ],
);
`;
}

function listScreenFiles(files: Map<string, GeneratedFile>): Array<{ path: string; className: string }> {
  return [...files]
    .filter(([filePath]) => /^lib\/features\/[^/]+\/screens\/[^/]+\.dart$/.test(filePath))
    .map(([filePath, file]) => ({
      path: filePath,
      className: classFromContent(file.content, classFromPath(filePath)),
    }))
    .sort((a, b) => Number(!a.path.includes('home_screen')) - Number(!b.path.includes('home_screen')));
}

function ensureTheme(files: Map<string, GeneratedFile>, changes: string[]): void {
  let theme = files.get(THEME);
  if (!theme && files.has(LEGACY_THEME)) {
    changes.push(...moveFile(files, LEGACY_THEME, THEME));
    theme = files.get(THEME);
  }
  if (!theme) {
    put(files, THEME, themeFallback());
    changes.push(`created ${THEME}`);
    return;
  }
  if (!theme.content.includes('class AppTheme')) {
    put(files, THEME, themeFallback());
    changes.push(`repaired ${THEME}`);
  }
  if (files.has(LEGACY_THEME)) {
    if (files.has(THEME)) {
      changes.push(...rewriteTarget(files, LEGACY_THEME, THEME));
      files.delete(LEGACY_THEME);
      changes.push(`removed duplicate ${LEGACY_THEME}`);
    } else {
      changes.push(...moveFile(files, LEGACY_THEME, THEME));
    }
  }
}

function ensureAppRoot(files: Map<string, GeneratedFile>, pkg: string, changes: string[]): void {
  if (!files.has(APP_ROOT) && files.has(LEGACY_APP_ROOT)) {
    changes.push(...moveFile(files, LEGACY_APP_ROOT, APP_ROOT));
  }
  if (files.has(LEGACY_APP_ROOT) && files.has(APP_ROOT)) {
    changes.push(...rewriteTarget(files, LEGACY_APP_ROOT, APP_ROOT));
    files.delete(LEGACY_APP_ROOT);
    changes.push(`removed duplicate ${LEGACY_APP_ROOT}`);
  }
  const app = files.get(APP_ROOT);
  if (!app || !app.content.includes('MaterialApp')) {
    put(files, APP_ROOT, appRootFallback(pkg));
    changes.push(`wrote canonical ${APP_ROOT}`);
  }
}

function ensureMain(files: Map<string, GeneratedFile>, pkg: string, usesSupabase: boolean, changes: string[]): void {
  const main = files.get(MAIN);
  if (!main || !main.content.includes('runApp(')) {
    put(files, MAIN, mainFallback(pkg, usesSupabase));
    changes.push(`wrote canonical ${MAIN}`);
  }
}

function ensureShellClient(files: Map<string, GeneratedFile>, changes: string[]): void {
  const referenced = [...files.values()].some((file) => (
    file.path.endsWith('.dart')
    && (file.content.includes('core/services/app_shell_client.dart') || file.content.includes('AppShellClient'))
  ));
  if (!referenced) return;
  const client = files.get(SHELL_CLIENT);
  const usable = client
    && client.content.includes('class AppShellClient')
    && client.content.includes('instance')
    && /static\s+(?:Future<[^>]+>\s+)?void\s+init\s*\(/.test(client.content);
  if (!usable) {
    put(files, SHELL_CLIENT, shellClientFallback());
    changes.push(`wrote deterministic ${SHELL_CLIENT}`);
  }
}

function ensureScreen(files: Map<string, GeneratedFile>, filePath: string, pkg: string, changes: string[]): void {
  if (files.has(filePath)) return;
  const content = SHELL_SCREEN_PATTERN.test(filePath)
    ? shellScreenFallback(filePath).replace(/__PKG__/g, pkg)
    : genericScreenFallback(filePath);
  put(files, filePath, content);
  changes.push(`created missing screen ${filePath}`);
}

function ensureRouter(files: Map<string, GeneratedFile>, pkg: string, changes: string[]): void {
  if (!files.has(ROUTER)) {
    let screens = listScreenFiles(files);
    if (!screens.some((screen) => screenRoute(screen.path, 0) === '/')) {
      const home = 'lib/features/home/screens/home_screen.dart';
      if (!files.has(home)) {
        put(files, home, genericScreenFallback(home));
        changes.push(`created ${home}`);
      }
      screens = listScreenFiles(files);
    }
    put(files, ROUTER, routerFallback(pkg, screens));
    changes.push(`wrote deterministic ${ROUTER}`);
    return;
  }

  const router = files.get(ROUTER)!;
  let next = router.content;
  const matches = [...next.matchAll(/(package:)([A-Za-z0-9_]+)(\/[^'"\s]+)/g)];
  for (const match of matches) {
    const [, prefix, importedPkg, rest] = match;
    if (importedPkg !== pkg) continue;
    const rel = rest.replace(/^\/+/, '');
    const target = `lib/${rel}`;
    if (files.has(target)) continue;
    if (rel === 'app.dart') {
      next = next.split(`${prefix}${importedPkg}${rest}`).join(`${prefix}${pkg}/app/app.dart`);
      changes.push('rewrote router app import to lib/app/app.dart');
      continue;
    }
    if (rel.endsWith('_screen.dart') || rel.includes('/screens/') || rel.includes('/presentation/')) {
      ensureScreen(files, target, pkg, changes);
      continue;
    }
    const basename = target.split('/').pop() ?? '';
    const candidates = [...files.keys()].filter((path) => (path.split('/').pop() ?? '') === basename);
    if (candidates.length === 1) {
      next = next.split(`${prefix}${importedPkg}${rest}`).join(`${prefix}${pkg}/${candidates[0].replace(/^lib\//, '')}`);
      changes.push(`router import ${target} → ${candidates[0]}`);
    }
  }
  if (next !== router.content) put(files, ROUTER, next);
}

function repairAppImports(files: Map<string, GeneratedFile>, pkg: string, changes: string[]): void {
  for (const [filePath, file] of files) {
    if (!filePath.endsWith('.dart')) continue;
    let next = file.content;
    next = next.replace(/(package:)([A-Za-z0-9_]+)(\/[^'"\s]+)/g, (whole, prefix, importedPkg, rest) => {
      if (importedPkg !== pkg) return whole;
      const rel = rest.replace(/^\/+/, '');
      const target = `lib/${rel}`;
      if (files.has(target)) return whole;
      if (rel === 'app.dart') return `${prefix}${pkg}/app/app.dart`;
      if (rel === 'core/theme/app_theme.dart' && files.has(THEME)) return `${prefix}${pkg}/app/app_theme.dart`;
      const basename = target.split('/').pop() ?? '';
      const candidates = [...files.keys()].filter((path) => (path.split('/').pop() ?? '') === basename);
      if (candidates.length === 1) return `${prefix}${pkg}/${candidates[0].replace(/^lib\//, '')}`;
      if (rel.endsWith('_screen.dart') || rel.includes('/screens/') || rel.includes('/presentation/')) {
        ensureScreen(files, target, pkg, changes);
      }
      return whole;
    });
    if (next !== file.content) {
      put(files, filePath, next);
      changes.push(`repaired imports in ${filePath}`);
    }
  }
}

function repairRelativeImports(files: Map<string, GeneratedFile>, changes: string[]): void {
  for (const [filePath, file] of files) {
    if (!filePath.endsWith('.dart')) continue;
    const next = file.content.replace(DART_IMPORT, (whole, keyword, uri) => {
      if (!isRelativeUri(uri)) return whole;
      const target = resolveRelative(filePath, uri);
      const targetWithExtension = target.endsWith('.dart') ? target : `${target}.dart`;
      if (files.has(targetWithExtension) || files.has(`${target}/index.dart`)) return whole;
      const basename = (targetWithExtension.split('/').pop() ?? '');
      const candidates = [...files.keys()].filter((path) => (path.split('/').pop() ?? '') === basename);
      if (candidates.length === 1) {
        return `${keyword} '${relativeImport(filePath, candidates[0])}'`;
      }
      return whole;
    });
    if (next !== file.content) {
      put(files, filePath, next);
      changes.push(`repaired relative imports in ${filePath}`);
    }
  }
}

/**
 * Normalize the generated file graph. Deterministic, idempotent, no LLM.
 */
export function enforceProjectContract(
  input: Map<string, GeneratedFile>,
  options: { appName?: string; pkgName: string; usesSupabase?: boolean },
): ProjectContractResult {
  const files = new Map(input);
  const changes: string[] = [];
  const pubspec = files.get('pubspec.yaml')?.content ?? '';
  const pkg = pubspecPackageName(pubspec) || options.pkgName;

  ensureTheme(files, changes);
  ensureAppRoot(files, pkg, changes);
  ensureMain(files, pkg, Boolean(options.usesSupabase), changes);
  ensureShellClient(files, changes);
  ensureRouter(files, pkg, changes);
  repairAppImports(files, pkg, changes);
  repairRelativeImports(files, changes);
  ensureRouter(files, pkg, changes);

  const validation = validateProjectFiles([...files.values()]);
  for (const fix of validation.fixes) {
    const existing = files.get(fix.path);
    if (existing) put(files, fix.path, fix.content);
  }
  for (const change of validation.changes) changes.push(`validator: ${change}`);

  return {
    files,
    changes: [...new Set(changes)],
    blockers: validation.gate.blockers,
  };
}
