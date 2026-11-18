import type { ProjectState, BuildPlan, PlannedFile, GateDiagnostic } from '../orchestrator/state';
import type { ScreenDefinition } from '../orchestrator/state';
import { callLLMJsonStrict, agentModelFor } from './llmClient';
import { validate } from './schema';
import { FeaturePlannerOutput } from './schemas';

const MAX_FILES = 60;

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (v === null || v === undefined ? '' : String(v).trim()))
    .filter((v) => v.length > 0);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stable, content-derived 32-bit FNV-1a hash — deterministic plan ids, no randomness. */
function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildBaseFiles(screens: ScreenDefinition[]): Array<{ path: string; purpose: string; action: 'create' }> {
  return [
    { path: 'pubspec.yaml', purpose: 'Package manifest', action: 'create' },
    { path: 'analysis_options.yaml', purpose: 'Lint configuration', action: 'create' },
    { path: 'lib/main.dart', purpose: 'Entry point', action: 'create' },
    { path: 'lib/app/app.dart', purpose: 'MaterialApp setup', action: 'create' },
    { path: 'lib/app/app_theme.dart', purpose: 'Design tokens & theme', action: 'create' },
    { path: 'lib/core/router/app_router.dart', purpose: 'GoRouter configuration', action: 'create' },
    { path: 'lib/core/services/local_storage_service.dart', purpose: 'SharedPreferences wrapper', action: 'create' },
    ...screens.map((s) => {
      const featureName = s.id || s.name.replace('Screen', '').toLowerCase();
      const base = s.name.replace(/Screen$/i, '');
      const snake = base
        .replace(/([A-Z])/g, (m, _, i) => (i === 0 ? m.toLowerCase() : `_${m.toLowerCase()}`))
        .replace(/^_+|_+$/g, '');
      const fileName = `${snake || 'home'}_screen.dart`;
      return { path: `lib/features/${featureName}/screens/${fileName}`, purpose: s.purpose, action: 'create' as const };
    }),
  ];
}

export async function runFeaturePlannerAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const brief = state.productBrief;
  const screens = state.screenGraph?.screens || [];
  const arch = state.architectureSpec;
  const dataSchema = state.dataSchema;
  const intake = (state as Record<string, unknown>)._intakeData as Record<string, unknown> | undefined;

  const diagnostics: GateDiagnostic[] = [];

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
1. List ALL files that must be created for the full app (never more than ${MAX_FILES} files)
2. Phases: foundation → core → features → integration → polish
3. Each file has a clear purpose
4. Dependencies must match the actual pubspec.yaml packages
5. Gate after each phase: what must be true before moving to the next phase
6. Every phase's "files" list must reference files that appear in your "files" list — never phantom paths

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
      "files": ["pubspec.yaml", "lib/main.dart", "lib/app/app.dart", "lib/app/app_theme.dart", "lib/core/router/app_router.dart"],
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
Features: ${asStringArray(intake?.keyFeatures).join(', ')}

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
    const baseFiles = buildBaseFiles(screens);
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

  // --- Sanitize and clamp the file list ---
  const rawFiles = Array.isArray(output.files) ? output.files : [];
  const seenPaths = new Set<string>();
  let files: PlannedFile[] = [];
  for (const rawFile of rawFiles) {
    if (!isPlainObject(rawFile)) continue;
    const path = str(rawFile.path);
    if (!path) continue;
    if (seenPaths.has(path)) {
      diagnostics.push({
        gate: 'feature-planner',
        level: 'info',
        message: `Dropped duplicate planned file "${path}" — first entry wins`,
        filePath: path,
      });
      continue;
    }
    seenPaths.add(path);
    files.push({
      path,
      purpose: str(rawFile.purpose, `Purpose of ${path}`),
      action: rawFile.action === 'edit' ? 'edit' : 'create',
    });
  }

  if (files.length > MAX_FILES) {
    const modelEmitted = files.length;
    // Keep the first 60 files: the model is prompted foundation-first, so the
    // tail is the least critical for getting a working build.
    files = files.slice(0, MAX_FILES);
    diagnostics.push({
      gate: 'feature-planner',
      level: 'warning',
      message: `Build plan capped to ${MAX_FILES} files (model emitted ${modelEmitted}) — dropped ${modelEmitted - MAX_FILES} least critical file(s) to prevent runaway builds`,
    });
  }

  if (files.length === 0) {
    files = buildBaseFiles(screens);
    diagnostics.push({
      gate: 'feature-planner',
      level: 'warning',
      message: 'Model emitted no usable files — fell back to the structural base plan',
    });
  }

  const fileSet = new Set(files.map((f) => f.path));

  // --- Sanitize phases; every phase file target must exist in the plan's own file set ---
  const rawPhases = Array.isArray(output.phases) ? output.phases : [];
  const phases: BuildPlan['phases'] = [];
  for (const rawPhase of rawPhases) {
    if (!isPlainObject(rawPhase)) continue;
    const id = str(rawPhase.id, `phase_${phases.length + 1}`);
    const label = str(rawPhase.label, id);
    const refs = asStringArray(rawPhase.files);
    const kept: string[] = [];
    for (const ref of refs) {
      if (fileSet.has(ref)) {
        kept.push(ref);
      } else {
        diagnostics.push({
          gate: 'feature-planner',
          level: 'warning',
          message: `Phase "${id}" referenced file "${ref}" which is not in the plan's file set — pruned phantom dependency`,
          filePath: ref,
        });
      }
    }
    if (kept.length === 0) {
      diagnostics.push({
        gate: 'feature-planner',
        level: 'warning',
        message: `Phase "${id}" dropped — all of its file references were phantom (not in the plan's file set)`,
      });
      continue;
    }
    phases.push({ id, label, files: kept, gateAfter: str(rawPhase.gateAfter, 'Phase complete') });
  }

  if (phases.length === 0) {
    phases.push({
      id: 'foundation',
      label: 'Foundation — all planned files',
      files: files.map((f) => f.path),
      gateAfter: 'All files generated',
    });
    diagnostics.push({
      gate: 'feature-planner',
      level: 'info',
      message: 'No usable phases from model — synthesized a single foundation phase from the file set',
    });
  }

  // --- Dependencies: keep only clean string→string entries ---
  const dependencies: Record<string, string> = {};
  if (isPlainObject(output.dependencies)) {
    for (const [key, value] of Object.entries(output.dependencies)) {
      const name = key.trim();
      const version = typeof value === 'string' ? value.trim() : '';
      if (name && version) dependencies[name] = version;
    }
  }

  const milestones = asStringArray(output.milestones);
  const appName = str(brief?.appName, 'App');
  // Content-derived stable id — identical inputs produce identical plan ids.
  const planId = `plan_${stableHash(`${appName}|${files.map((f) => f.path).join(',')}|${phases.map((p) => p.id).join(',')}`)}`;

  const plan: BuildPlan = {
    id: planId,
    appName,
    files,
    phases,
    dependencies,
  };

  const capNote = files.length >= MAX_FILES ? ` (capped at ${MAX_FILES})` : '';

  return {
    plan,
    diagnostics: [...state.diagnostics, ...diagnostics],
    logs: [
      ...state.logs,
      `[Feature Planner Agent] Build plan: ${plan.files.length} files${capNote} across ${plan.phases.length} phases. Milestones: ${milestones.length > 0 ? milestones.join(' → ') : 'n/a'}`,
    ],
  };
}
