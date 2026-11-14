import type { ProjectState, ArchitectureSpec } from '../orchestrator/state';
import { callLLMJsonStrict, agentModelFor } from './llmClient';
import { validate } from './schema';
import { ArchitectureOutput } from './schemas';

export async function runArchitectureAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const brief = state.productBrief;
  const intake = (state as Record<string, unknown>)._intakeData as Record<string, unknown> | undefined;
  const screens = state.screenGraph?.screens ?? [];
  const domain = (intake?.domain as string) || 'general';
  const needsSupabase = (intake?.needsSupabase as boolean) ?? false;
  const stateManagementHint = (intake?.stateManagement as string) || 'provider';

  interface ArchOutput {
    stateManagement: 'provider' | 'riverpod' | 'bloc';
    navigationType: 'tabs' | 'drawer' | 'stack';
    folderStructure: string[];
    features: string[];
    packages: Record<string, string>;
    backendMode: 'none' | 'local' | 'supabase';
    rationale: string;
  }

  let output: ArchOutput;
  try {
    output = await callLLMJsonStrict<ArchOutput>(
      [
        {
          role: 'system',
          content: `You are the Architecture Agent for FlutterForge. You are a senior Flutter architect.

Your job: Design the complete technical architecture for a Flutter app.

RULES:
1. Use feature-first folder structure: lib/features/<feature>/screens/, lib/features/<feature>/widgets/, lib/features/<feature>/providers/
2. For state management: "provider" (simple), "riverpod" (reactive/complex), "bloc" (enterprise/event-driven)
3. Navigation: use go_router always
4. Include ONLY real pub.dev packages with correct current versions
5. backendMode: "supabase" if needs auth/db, "local" otherwise, "none" if truly offline
6. Features list should be granular (one per feature_first folder)

Return ONLY valid JSON:
{
  "stateManagement": "provider",
  "navigationType": "tabs",
  "folderStructure": [
    "lib/core/theme/",
    "lib/core/router/",
    "lib/core/services/",
    "lib/features/home/screens/",
    "lib/features/home/widgets/",
    "lib/features/home/providers/"
  ],
  "features": ["home", "profile", "settings", "auth"],
  "packages": {
    "provider": "^6.1.2",
    "go_router": "^14.2.0",
    "http": "^1.2.2",
    "shared_preferences": "^2.3.2"
  },
  "backendMode": "local",
  "rationale": "Why these choices were made"
}`,
        },
        {
          role: 'user',
          content: `Design architecture for "${brief?.appName}" — a ${domain} app.
Brief: ${brief?.oneLiner}
Screens: ${screens.map((s) => s.name).join(', ')}
Needs Supabase: ${needsSupabase}
Preferred state management: ${stateManagementHint}

Choose the best architecture. If Supabase is needed, include supabase_flutter package.`,
        },
      ],
      (data) => validate<ArchOutput>(ArchitectureOutput, data),
      {
        model: agentModelFor('architecture'),
        temperature: 0.2,
        maxTokens: 3000,
        responseFormat: 'json',
      }
    );
  } catch (err) {
    console.warn('[ArchitectureAgent] LLM failed, using defaults:', err);
    const basePackages: Record<string, string> = {
      provider: '^6.1.2',
      go_router: '^14.2.0',
      shared_preferences: '^2.3.2',
      http: '^1.2.2',
      cached_network_image: '^3.4.1',
      flutter_svg: '^2.0.10',
      intl: '^0.19.0',
    };
    if (needsSupabase) {
      basePackages['supabase_flutter'] = '^2.6.0';
    }
    output = {
      stateManagement: (stateManagementHint as 'provider' | 'riverpod' | 'bloc') || 'provider',
      navigationType: screens.length > 3 ? 'tabs' : 'stack',
      folderStructure: [
        'lib/core/theme/', 'lib/core/router/', 'lib/core/services/',
        ...screens.map((s) => `lib/features/${s.id || s.name.replace('Screen', '').toLowerCase()}/screens/`),
      ],
      features: screens.map((s) => s.id || s.name.replace('Screen', '').toLowerCase()),
      packages: basePackages,
      backendMode: needsSupabase ? 'supabase' : 'local',
      rationale: 'Provider + GoRouter for simplicity and Flutter compatibility',
    };
  }

  const spec: ArchitectureSpec = {
    stateManagement: output.stateManagement,
    navigationType: output.navigationType,
    features: output.features,
    packages: output.packages,
    backendMode: output.backendMode,
  };

  return {
    architectureSpec: spec,
    logs: [
      ...state.logs,
      `[Architecture Agent] State: ${spec.stateManagement} | Nav: ${spec.navigationType} | Backend: ${spec.backendMode} | Packages: ${Object.keys(spec.packages).join(', ')}`,
    ],
  };
}
