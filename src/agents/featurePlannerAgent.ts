import type { ProjectState, BuildPlan, PlannedFile } from '../orchestrator/state';
import { callLLMJsonStrict, agentModelFor } from './llmClient';
import { validate } from './schema';
import { FeaturePlannerOutput } from './schemas';

export async function runFeaturePlannerAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const brief = state.productBrief;
  const screens = state.screenGraph?.screens || [];
  const arch = state.architectureSpec;
  const dataSchema = state.dataSchema;
  const intake = (state as Record<string, unknown>)._intakeData as Record<string, unknown> | undefined;

  interface PlanOutput {
    files: Array<{ path: string; purpose: string; action: 'create' | 'edit' }>;
    phases: Array<{ id: string; label: string; files: string[]; gateAfter: string }>;
    dependencies: Record<string, string>;
    milestones: string[];
  }

  let output: PlanOutput;
  try {
    output = await callLLMJsonStrict<PlanOutput>(
      [
        {
          role: 'system',
          content: `You are the Feature Planner Agent for FlutterForge. You are a staff Flutter engineer.

Your job: Produce a complete, ordered build plan listing every file and build phase.

RULES:
1. List ALL files that must be created for the full app
2. Phases: foundation → core → features → integration → polish
3. Each file has a clear purpose
4. Dependencies must match the actual pubspec.yaml packages
5. Gate after each phase: what must be true before moving to the next phase

Return ONLY valid JSON:
{
  "files": [
    {"path": "pubspec.yaml", "purpose": "Package manifest and dependencies", "action": "create"},
    {"path": "lib/main.dart", "purpose": "App entry point", "action": "create"}
  ],
  "phases": [
    {
      "id": "foundation",
      "label": "Foundation — theme, routing, services",
      "files": ["pubspec.yaml", "lib/main.dart", "lib/app.dart", "lib/core/theme/app_theme.dart", "lib/core/router/app_router.dart"],
      "gateAfter": "App compiles and shows blank scaffold"
    }
  ],
  "dependencies": {"go_router": "^14.2.0"},
  "milestones": ["App boots", "Navigation works", "All screens render", "Data layer connected", "Auth works"]
}`,
        },
        {
          role: 'user',
          content: `Create the complete build plan for "${brief?.appName}".

Screens to build: ${screens.map((s) => `${s.name} (${s.route})`).join(', ')}
State management: ${arch?.stateManagement || 'provider'}
Backend: ${arch?.backendMode || 'local'}
Database tables: ${dataSchema?.tables?.map((t) => t.name).join(', ') || 'none'}
Features: ${(intake?.keyFeatures as string[] || []).join(', ')}

Plan every file needed. Be exhaustive — include ALL Dart files, SQL migrations, assets placeholder.`,
        },
      ],
      (data) => validate<PlanOutput>(FeaturePlannerOutput, data),
      {
        model: agentModelFor('feature-planner'),
        temperature: 0.2,
        maxTokens: 4000,
        responseFormat: 'json',
      }
    );
  } catch (err) {
    console.warn('[FeaturePlannerAgent] LLM failed, deriving plan structurally:', err);
    const baseFiles: Array<{ path: string; purpose: string; action: 'create' }> = [
      { path: 'pubspec.yaml', purpose: 'Package manifest', action: 'create' },
      { path: 'analysis_options.yaml', purpose: 'Lint configuration', action: 'create' },
      { path: 'lib/main.dart', purpose: 'Entry point', action: 'create' },
      { path: 'lib/app.dart', purpose: 'MaterialApp setup', action: 'create' },
      { path: 'lib/core/theme/app_theme.dart', purpose: 'Design tokens & theme', action: 'create' },
      { path: 'lib/core/router/app_router.dart', purpose: 'GoRouter configuration', action: 'create' },
      { path: 'lib/core/services/local_storage_service.dart', purpose: 'SharedPreferences wrapper', action: 'create' },
      ...screens.map((s) => {
        const featureName = s.id || s.name.replace('Screen', '').toLowerCase();
        const fileName = s.name.replace(/([A-Z])/g, (m, _, i) => (i === 0 ? m : `_${m}`)).toLowerCase();
        return { path: `lib/features/${featureName}/screens/${fileName}.dart`, purpose: s.purpose, action: 'create' as const };
      }),
    ];
    output = {
      files: baseFiles,
      phases: [
        { id: 'foundation', label: 'Foundation', files: baseFiles.slice(0, 3).map((f) => f.path), gateAfter: 'App boots' },
        { id: 'features', label: 'Features', files: baseFiles.slice(3).map((f) => f.path), gateAfter: 'All screens render' },
      ],
      dependencies: arch?.packages || {},
      milestones: ['App boots', 'Navigation works', 'All screens complete'],
    };
  }

  const plan: BuildPlan = {
    id: `plan_${Date.now()}`,
    appName: brief?.appName || 'App',
    files: output.files as PlannedFile[],
    phases: output.phases,
    dependencies: output.dependencies,
  };

  return {
    plan,
    logs: [
      ...state.logs,
      `[Feature Planner Agent] Build plan: ${plan.files.length} files across ${plan.phases.length} phases. Milestones: ${output.milestones?.join(' → ')}`,
    ],
  };
}
