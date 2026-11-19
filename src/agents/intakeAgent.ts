import type { ProjectState, ProductBrief, GateDiagnostic } from '../orchestrator/state';
import { callLLMJsonStrict, agentModelFor } from './llmClient';
import { validate } from './schema';
import { IntakeLLMOutput as IntakeSchema } from './schemas';
import {
  analyzeBackendIntent,
  detectDomain,
  extractDarkTheme,
  extractExplicitAppName,
  extractPlatforms,
  extractStateManagement,
} from './promptIntent';

interface IntakeLLMOutput {
  appName: string;
  oneLiner: string;
  targetAudience: string;
  primaryProblem: string;
  domain: string;
  platforms: string[];
  constraints: string[];
  keyFeatures: string[];
  screens: string[];
  stateManagement: string;
  needsSupabase: boolean;
  colorPalette: string;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const VALID_PLATFORMS = new Set(['web', 'macos', 'windows', 'android', 'ios']);
const M3_NEUTRAL_PRIMARY = '#6750A4';
const SUPABASE_CONSTRAINT = 'Supabase backend requested (auth/database/realtime)';
const STATE_MANAGEMENT = new Set(['provider', 'riverpod', 'bloc']);

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (v === null || v === undefined ? '' : String(v).trim()))
    .filter((v) => v.length > 0);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function asBool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function sanitizeHexColor(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const v = value.trim();
    if (HEX_COLOR_RE.test(v)) return v;
  }
  return fallback;
}

function clampEnum(value: unknown, allowed: Set<string>, fallback: string): string {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return allowed.has(s) ? s : fallback;
}

export async function runIntakeAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const prompt = state.userPrompt.trim();
  const diagnostics: GateDiagnostic[] = [];

  let output: IntakeLLMOutput;
  try {
    output = await callLLMJsonStrict<IntakeLLMOutput>(
      [
        {
          role: 'system',
          content: `You are the Product Intake Agent for FlutterForge — a Lovable-style Flutter app generation system.

Your job: Deeply analyze the user's prompt and produce a structured product brief in JSON.

You must return a valid JSON object with these exact fields:
{
  "appName": "PascalCase app name, 1-2 words",
  "oneLiner": "One sentence describing the app value proposition",
  "targetAudience": "Who uses this app",
  "primaryProblem": "What pain does it solve",
  "domain": one of ["ecommerce","fitness","social","finance","tasks","education","health","travel","food","music","general"],
  "platforms": ["web","android","ios","macos","windows"],
  "constraints": ["list of technical constraints and quality requirements"],
  "keyFeatures": ["5-8 core features the app must have"],
  "screens": ["list all screen names in PascalCase, e.g. HomeScreen, ProductDetailScreen"],
  "stateManagement": one of ["provider","riverpod","bloc"],
  "needsSupabase": true if needs auth/database/realtime, false for local-only apps,
  "colorPalette": "Hex seed color that fits the domain, e.g. #2563EB"
}

CRITICAL RULES — the user's literal words override your inferences:
- Honor negations and explicit fields. "no backend", "local only", "no auth", "no database", "do NOT use Supabase", "Backend: None" all mean needsSupabase: false. Never set needsSupabase true because a feature merely sounds like it needs a server; "user management" or "role-based access" can be modeled locally with static roles.
- Take appName from explicit declarations like "Project: X" or "app called X". Do NOT use generic words such as "Production" from "production-grade".
- Take platforms and stateManagement from explicit "Platform:" and "State Management:" fields when present.
- Use domain "general" for admin dashboards, control panels, analytics and audit tools; do not classify them as ecommerce just because they mention products or management.
- "Theme Mode: dark" means a dark theme is preferred.
Be specific, accurate, and production-minded. Infer only details the prompt does not state.`,
        },
        {
          role: 'user',
          content: `Analyze this app idea and return the JSON brief:\n\n"${prompt}"`,
        },
      ],
      (data) => validate<IntakeLLMOutput>(IntakeSchema, data),
      {
        model: agentModelFor('intake'),
        temperature: 0.2,
        maxTokens: 2048,
        responseFormat: 'json',
      }
    );
  } catch (err) {
    // Fallback: derive from the explicit prompt intent, then keywords.
    const intent = analyzeBackendIntent(prompt);
    const domain = detectDomain(prompt) ?? 'general';

    const colorMap: Record<string, string> = {
      ecommerce: '#7C3AED', fitness: '#059669', tasks: '#2563EB',
      social: '#DB2777', finance: '#0891B2', food: '#EA580C',
      music: '#7C3AED', travel: '#0284C7', education: '#16A34A', health: '#059669', general: '#2563EB',
    };

    const explicitName = extractExplicitAppName(prompt);
    const rawName = explicitName
      ?? prompt.match(/(?:build|create|make|design)\s+(?:an?\s+)?([A-Za-z][A-Za-z0-9]{2,24})/i)?.[1]?.trim()
      ?? domain;
    const appName = explicitName
      ?? rawName.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('').replace(/[^A-Za-z0-9]/g, '')
      ?? 'ForgeApp';

    output = {
      appName,
      oneLiner: prompt.slice(0, 120),
      targetAudience: 'General users on mobile and web',
      primaryProblem: prompt,
      domain,
      platforms: extractPlatforms(prompt) ?? ['web', 'android', 'ios'],
      constraints: ['Material 3 compliance', 'Feature-first architecture', '4-state UI pattern'],
      keyFeatures: ['Dashboard', 'Data management', 'User profile', 'Settings', 'Notifications'],
      screens: ['SplashScreen', 'HomeScreen', 'DetailScreen', 'ProfileScreen', 'SettingsScreen'],
      stateManagement: extractStateManagement(prompt) ?? 'provider',
      needsSupabase: intent.wantsSupabase,
      colorPalette: colorMap[domain] || '#2563EB',
    };
    console.warn('[IntakeAgent] LLM failed, using keyword fallback:', err);
  }

  // --- Explicit prompt intent wins over model guesses ---
  // The model may misread "production-grade" as the app name, "dashboard" as
  // ecommerce, or "no auth / do NOT use Supabase" as a backend request.
  const intent = analyzeBackendIntent(prompt);
  const explicitName = extractExplicitAppName(prompt);
  const detectedDomain = detectDomain(prompt);
  const resolvedAppName = explicitName ?? str(output.appName, 'ForgeApp');
  const resolvedDomain = detectedDomain ?? str(output.domain, 'general');
  const resolvedPlatforms = extractPlatforms(prompt) ?? asStringArray(output.platforms);
  const resolvedStateManagement = extractStateManagement(prompt)
    ?? clampEnum(output.stateManagement, STATE_MANAGEMENT, 'provider');
  let resolvedNeedsSupabase = asBool(output.needsSupabase);
  if (intent.localOnly) resolvedNeedsSupabase = false;
  else if (intent.wantsSupabase) resolvedNeedsSupabase = true;

  if (explicitName && explicitName.toLowerCase() !== str(output.appName).toLowerCase()) {
    diagnostics.push({
      gate: 'intake',
      level: 'info',
      message: `App name taken from prompt: "${resolvedAppName}" (model said "${str(output.appName, 'n/a')}")`,
    });
  }
  if (detectedDomain && detectedDomain !== str(output.domain).toLowerCase()) {
    diagnostics.push({
      gate: 'intake',
      level: 'info',
      message: `Domain derived from prompt: "${detectedDomain}" (model said "${str(output.domain, 'n/a')}")`,
    });
  }
  if (resolvedNeedsSupabase !== asBool(output.needsSupabase)) {
    diagnostics.push({
      gate: 'intake',
      level: 'warning',
      message: intent.localOnly
        ? 'Backend disabled: prompt explicitly asks for a local-only / no-backend app.'
        : 'Backend enabled: prompt explicitly requests a backend or Supabase.',
    });
  }

  // --- Sanitize model output before it reaches shared state ---
  const rawPlatforms = resolvedPlatforms.map((p) => p.toLowerCase());
  const platformSet = new Set<ProductBrief['platforms'][number]>();
  for (const p of rawPlatforms) {
    if (VALID_PLATFORMS.has(p)) platformSet.add(p as ProductBrief['platforms'][number]);
  }
  let platforms = [...platformSet];
  if (platforms.length === 0) {
    if (rawPlatforms.length > 0) {
      diagnostics.push({
        gate: 'intake',
        level: 'warning',
        message: `Model emitted unknown platforms [${rawPlatforms.join(', ')}] — defaulting to ['android']`,
      });
    }
    platforms = ['android'];
  } else if (platforms.length !== rawPlatforms.length) {
    const dropped = rawPlatforms.filter((p) => !VALID_PLATFORMS.has(p));
    diagnostics.push({
      gate: 'intake',
      level: 'info',
      message: `Discarded invalid platform(s): ${dropped.join(', ')}`,
    });
  }

  // Constraints always exist (never undefined/null downstream).
  let constraints = asStringArray(output.constraints);
  // Coordinate Supabase with the architecture agent via ProductBrief.constraints,
  // but only when the prompt actually asks for it. "Do NOT use Supabase" and
  // "no backend" must never be turned into a Supabase constraint.
  if (intent.localOnly) {
    constraints = constraints.filter((c) => !/supabase/i.test(c));
  } else if (intent.wantsSupabase && !constraints.some((c) => /supabase/i.test(c))) {
    constraints.push(SUPABASE_CONSTRAINT);
  }

  const paletteRaw = typeof output.colorPalette === 'string' ? output.colorPalette.trim() : '';
  const seedColor = sanitizeHexColor(paletteRaw, M3_NEUTRAL_PRIMARY);
  if (seedColor !== paletteRaw) {
    diagnostics.push({
      gate: 'intake',
      level: 'warning',
      message: `Invalid color palette "${paletteRaw || '(empty)'}" — falling back to Material 3 neutral ${M3_NEUTRAL_PRIMARY}`,
    });
  }

  // Sanitize the side-channel intake data consumed by downstream agents.
  const intakeData = {
    ...output,
    appName: resolvedAppName,
    domain: resolvedDomain,
    platforms,
    constraints,
    screens: asStringArray(output.screens),
    keyFeatures: asStringArray(output.keyFeatures),
    stateManagement: resolvedStateManagement,
    needsSupabase: resolvedNeedsSupabase,
    colorPalette: seedColor,
  };

  const brief: ProductBrief = {
    appName: resolvedAppName,
    oneLiner: str(output.oneLiner, prompt.slice(0, 120)),
    targetAudience: str(output.targetAudience),
    primaryProblem: str(output.primaryProblem, prompt),
    platforms,
    constraints,
  };

  return {
    productBrief: brief,
    // Store extra intake data in designTokens seed for downstream agents
    designTokens: {
      ...(state.designTokens ?? {
        primaryColor: seedColor, secondaryColor: '#3B82F6', accentColor: '#F59E0B',
        backgroundColor: '#FFFBFE', surfaceColor: '#F3EDF7', fontFamily: 'Inter',
        useMaterial3: true, isDarkPreferred: false, borderRadius: 12,
      }),
      primaryColor: seedColor,
      isDarkPreferred: extractDarkTheme(prompt) ?? state.designTokens?.isDarkPreferred ?? false,
    },
    diagnostics: [...state.diagnostics, ...diagnostics],
    logs: [
      ...state.logs,
      `[Intake Agent] Domain: "${resolvedDomain}" | App: "${brief.appName}" | Screens: ${intakeData.screens.join(', ')} | Supabase: ${intakeData.needsSupabase}`,
    ],
    // Pass intake analysis downstream via a custom field
    _intakeData: intakeData,
  } as Partial<ProjectState> & { _intakeData: typeof intakeData };
}
