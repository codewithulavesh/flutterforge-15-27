import type { ProjectState, ArchitectureSpec, GateDiagnostic } from '../orchestrator/state';
import { callLLMJsonStrict, agentModelFor } from './llmClient';
import { validate } from './schema';
import { ArchitectureOutput } from './schemas';

const STATE_MANAGEMENT = ['provider', 'riverpod', 'bloc'] as const;
const NAVIGATION = ['tabs', 'drawer', 'stack'] as const;
const BACKEND_MODES = ['none', 'local', 'supabase'] as const;

function clampEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (v === null || v === undefined ? '' : String(v).trim()))
    .filter((v) => v.length > 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function asBool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

export async function runArchitectureAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const brief = state.productBrief;
  const intake = (state as Record<string, unknown>)._intakeData as Record<string, unknown> | undefined;
  const screens = state.screenGraph?.screens ?? [];
  const domain = str(intake?.domain, 'general');
  const needsSupabase = asBool(intake?.needsSupabase);
  const stateManagementHint = clampEnum(intake?.stateManagement, STATE_MANAGEMENT, 'provider');
  // Coordinate Supabase through ProductBrief.constraints only — the intake agent
  // records an explicit constraint when the user prompt asks for Supabase.
  const constraintsText = asStringArray(brief?.constraints).join(' ').toLowerCase();
  const constraintsWantSupabase = /\bsupabase\b/.test(constraintsText);
  const wantsSupabase = needsSupabase || constraintsWantSupabase;

  const diagnostics: GateDiagnostic[] = [];

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
Needs Supabase: ${wantsSupabase}
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
    if (wantsSupabase) {
      basePackages['supabase_flutter'] = '^2.6.0';
    }
    output = {
      stateManagement: stateManagementHint as 'provider' | 'riverpod' | 'bloc',
      navigationType: 'tabs',
      folderStructure: [
        'lib/core/theme/', 'lib/core/router/', 'lib/core/services/',
        ...screens.map((s) => `lib/features/${s.id || s.name.replace('Screen', '').toLowerCase()}/screens/`),
      ],
      features: asStringArray(screens.map((s) => s.id || s.name.replace('Screen', '').toLowerCase())),
      packages: basePackages,
      backendMode: wantsSupabase ? 'supabase' : 'local',
      rationale: 'Provider + GoRouter for simplicity and Flutter compatibility',
    };
  }

  // --- Hard-clamp enums before they reach shared state (never pass garbage through) ---
  const clampNotes: string[] = [];
  const trackClamp = <T extends string>(label: string, rawValue: unknown, clamped: T): T => {
    const raw = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue ?? '');
    if (raw.toLowerCase() !== clamped) {
      clampNotes.push(`${label}: "${raw || '(missing)'}" → ${clamped}`);
    }
    return clamped;
  };

  const stateManagement = trackClamp('stateManagement', output.stateManagement, clampEnum(output.stateManagement, STATE_MANAGEMENT, 'provider'));
  const navigationType = trackClamp('navigationType', output.navigationType, clampEnum(output.navigationType, NAVIGATION, 'tabs'));
  const backendMode = trackClamp(
    'backendMode',
    output.backendMode,
    (wantsSupabase
      ? 'supabase'
      : clampEnum(output.backendMode, BACKEND_MODES, 'none')) as ArchitectureSpec['backendMode'],
  );

  for (const note of clampNotes) {
    diagnostics.push({ gate: 'architecture', level: 'warning', message: `Enum clamp applied — ${note}` });
  }

  // Features and packages are tolerated only as clean string shapes; drop the rest.
  const features = asStringArray(output.features);
  const packages: Record<string, string> = {};
  if (isPlainObject(output.packages)) {
    for (const [key, value] of Object.entries(output.packages)) {
      const name = key.trim();
      const version = typeof value === 'string' ? value.trim() : '';
      if (name && version) packages[name] = version;
    }
  }

  const spec: ArchitectureSpec = {
    stateManagement,
    navigationType,
    features,
    packages,
    backendMode,
  };

  const clampLog = clampNotes.length > 0 ? ` | Clamped: ${clampNotes.join('; ')}` : '';

  return {
    architectureSpec: spec,
    diagnostics: [...state.diagnostics, ...diagnostics],
    logs: [
      ...state.logs,
      `[Architecture Agent] State: ${spec.stateManagement} | Nav: ${spec.navigationType} | Backend: ${spec.backendMode} | Packages: ${Object.keys(spec.packages).join(', ')}${clampLog}`,
    ],
  };
}
