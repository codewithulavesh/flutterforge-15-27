import type { ProjectState, ProductBrief, GateDiagnostic } from '../orchestrator/state';
import { callLLMJsonStrict, agentModelFor } from './llmClient';
import { validate } from './schema';
import { IntakeLLMOutput as IntakeSchema } from './schemas';

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

Be specific, accurate, and production-minded. Infer all missing details from the prompt context.`,
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
    // Fallback: derive from keywords
    const p = prompt.toLowerCase();
    const domain =
      p.match(/shop|store|e-commerce|cart|product|marketplace/) ? 'ecommerce' :
      p.match(/fitness|workout|gym|health|track|step|calor/) ? 'fitness' :
      p.match(/task|todo|project|kanban|board/) ? 'tasks' :
      p.match(/chat|message|social|community|feed|post/) ? 'social' :
      p.match(/finance|money|expense|wallet|budget|invest/) ? 'finance' :
      p.match(/food|recipe|restaurant|meal|diet/) ? 'food' :
      p.match(/music|audio|playlist|podcast|listen/) ? 'music' :
      p.match(/travel|trip|hotel|flight|map|navigation/) ? 'travel' :
      p.match(/learn|course|quiz|education|study/) ? 'education' : 'general';

    const colorMap: Record<string, string> = {
      ecommerce: '#7C3AED', fitness: '#059669', tasks: '#2563EB',
      social: '#DB2777', finance: '#0891B2', food: '#EA580C',
      music: '#7C3AED', travel: '#0284C7', education: '#16A34A', general: '#2563EB',
    };

    const rawName = prompt.match(/(?:build|create|make|design)\s+(?:an?\s+)?([A-Za-z0-9\s]{3,25})/i)?.[1]?.trim() || domain;
    const appName = rawName.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('').replace(/[^A-Za-z0-9]/g, '') || 'ForgeApp';

    output = {
      appName,
      oneLiner: prompt.slice(0, 120),
      targetAudience: 'General users on mobile and web',
      primaryProblem: prompt,
      domain,
      platforms: ['web', 'android', 'ios'],
      constraints: ['Material 3 compliance', 'Feature-first architecture', '4-state UI pattern'],
      keyFeatures: ['Dashboard', 'Data management', 'User profile', 'Settings', 'Notifications'],
      screens: ['SplashScreen', 'HomeScreen', 'DetailScreen', 'ProfileScreen', 'SettingsScreen'],
      stateManagement: 'provider',
      needsSupabase: p.includes('auth') || p.includes('login') || p.includes('account') || p.includes('database') || p.includes('realtime') || p.includes('supabase'),
      colorPalette: colorMap[domain] || '#2563EB',
    };
    console.warn('[IntakeAgent] LLM failed, using keyword fallback:', err);
  }

  // --- Sanitize model output before it reaches shared state ---
  const rawPlatforms = asStringArray(output.platforms).map((p) => p.toLowerCase());
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
  const constraints = asStringArray(output.constraints);
  // Coordinate Supabase with the architecture agent via ProductBrief.constraints only:
  // if the raw user prompt asks for Supabase, record it as a constraint so the
  // architecture agent can see it in its own input — never guess there.
  if (/supabase/i.test(prompt) && !constraints.some((c) => /supabase/i.test(c))) {
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
    platforms,
    constraints,
    screens: asStringArray(output.screens),
    keyFeatures: asStringArray(output.keyFeatures),
    stateManagement: clampEnum(output.stateManagement, STATE_MANAGEMENT, 'provider'),
    needsSupabase: asBool(output.needsSupabase),
    colorPalette: seedColor,
  };

  const brief: ProductBrief = {
    appName: str(output.appName, 'ForgeApp'),
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
    },
    diagnostics: [...state.diagnostics, ...diagnostics],
    logs: [
      ...state.logs,
      `[Intake Agent] Domain: "${str(output.domain, 'general')}" | App: "${brief.appName}" | Screens: ${intakeData.screens.join(', ')} | Supabase: ${intakeData.needsSupabase}`,
    ],
    // Pass intake analysis downstream via a custom field
    _intakeData: intakeData,
  } as Partial<ProjectState> & { _intakeData: typeof intakeData };
}
