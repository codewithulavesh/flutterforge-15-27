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
 */
import type { ProjectState, GeneratedFile } from '../orchestrator/state';
import { callLLMText, parseFilesFromLLMOutput, agentModelFor } from './llmClient';

const REQUIRED_SHELL_FILES = [
  'lib/core/services/app_shell_client.dart',
  'lib/features/onboarding/presentation/onboarding_screen.dart',
  'lib/features/auth/presentation/sign_in_screen.dart',
  'lib/features/auth/presentation/sign_up_screen.dart',
  'lib/features/auth/presentation/forgot_password_screen.dart',
  'lib/features/settings/presentation/settings_screen.dart',
  'lib/features/account/presentation/account_screen.dart',
  'lib/core/router/app_router.dart',
];

export async function runAppShellAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const brief = state.productBrief?.oneLiner || state.productBrief?.appName || 'A modern app';
  const appName = state.productBrief?.appName || 'FlutterForge';
  const pkg = appName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
  const tokens = state.designTokens;
  const intake = state._intakeData as Record<string, unknown> | undefined;
  const domain = (intake?.domain as string) || 'general';
  const files = new Map<string, GeneratedFile>(state.generatedFiles);

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
8. lib/core/router/app_router.dart

app_shell_client.dart MUST export:
  class AppShellClient extends ChangeNotifier with a single static member 'instance'; expose it
  field _user (UserProfile?), methods: signIn(email,password), signUp(name,email,password), signOut(), notificationsEnabled (bool getter)+setter, onboarded (bool getter)+setter
  Persist what matters (onboarding done, username, theme preference, notification preference) to SharedPreferences.

app_router.dart MUST be a GoRouter with:
  GoRoute('/', redirect based on onboard + auth),
  paths: /onboarding, /sign-in, /sign-up, /forgot-password, /settings, /account, /home,
  all importing features from package:${pkg}/features/....

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

Generate ALL 8 files above so this product feels like ITSELF, not a template.`;

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

  const parsed = parseFilesFromLLMOutput(raw);
  for (const f of parsed) {
    if (typeof f.path === 'string' && f.path.endsWith('.dart') && f.content && f.content.length > 40) {
      files.set(f.path, { path: f.path, action: 'created', language: 'dart', content: f.content });
    }
  }

  // Verify the shell files the LLM was required to produce.
  // Repair loops elsewhere in the pipeline will fix missing or broken files —
  // we do not inject a fake shell. If any are missing, the QA agent reports
  // them as errors and the user-visible build gets repaired before preview.
  const missingShellFiles = REQUIRED_SHELL_FILES.filter((path) => !files.has(path));
  if (missingShellFiles.length > 0) {
    console.warn(`[AppShellAgent] LLM missed ${missingShellFiles.length} shell file(s): ${missingShellFiles.join(', ')}. QA gate will handle retry.`);
  }

  return {
    generatedFiles: files,
    logs: [...state.logs, `[App Shell Agent] Shell generated for ${appName} — ${parsed.length} LLM file(s)${missingShellFiles.length ? `; ${missingShellFiles.length} missing` : ''}`],
  };
}

