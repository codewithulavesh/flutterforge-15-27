import type { ProjectState, DesignTokens, GateDiagnostic } from '../orchestrator/state';
import { callLLMJsonStrict, agentModelFor } from './llmClient';
import { validate } from './schema';
import { DesignSystemOutput } from './schemas';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ALLOWED_FONTS = ['Inter', 'Satoshi', 'Panchang'] as const;
// Material 3 baseline (light) / Material 3 baseline (dark) neutral fallbacks.
const M3_FALLBACK = {
  light: {
    primaryColor: '#6750A4',
    secondaryColor: '#625B71',
    accentColor: '#7D5260',
    backgroundColor: '#FFFBFE',
    surfaceColor: '#F3EDF7',
  },
  dark: {
    primaryColor: '#D0BCFF',
    secondaryColor: '#CCC2DC',
    accentColor: '#EFB8C8',
    backgroundColor: '#1C1B1F',
    surfaceColor: '#1C1B1F',
  },
} as const;

function sanitizeHex(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const v = value.trim();
    if (HEX_COLOR_RE.test(v)) return v;
  }
  return fallback;
}

function sanitizeFont(value: unknown): string {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    const match = ALLOWED_FONTS.find((f) => f.toLowerCase() === v);
    if (match) return match;
  }
  return 'Inter';
}

function clampBorderRadius(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 12;
  return Math.min(60, Math.max(0, Math.round(n)));
}

function asBool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export async function runDesignSystemAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const brief = state.productBrief;
  const intake = (state as Record<string, unknown>)._intakeData as Record<string, unknown> | undefined;
  const domain = str(intake?.domain, 'general');
  const appName = brief?.appName || 'App';

  const diagnostics: GateDiagnostic[] = [];

  interface DesignOutput {
    primaryColor: string;
    secondaryColor: string;
    accentColor: string;
    backgroundColor: string;
    surfaceColor: string;
    fontFamily: string;
    useMaterial3: boolean;
    isDarkPreferred: boolean;
    borderRadius: number;
    colorRationale: string;
    typography: { display: string; headline: string; body: string; label: string };
    spacingScale: number[];
    componentStyle: string;
  }

  let output: DesignOutput;
  try {
    output = await callLLMJsonStrict<DesignOutput>(
      [
        {
          role: 'system',
          content: `You are the Design System Agent for FlutterForge. You are an expert Material Design 3 and Flutter UI design specialist.

Your job: Create a production-quality design system for a Flutter app. 

RULES:
1. Colors must pass WCAG AA contrast (4.5:1 for text on background)
2. Use Material 3 (useMaterial3: true always)
3. Font families: "Inter", "Satoshi", "Panchang" — pick what fits
4. borderRadius between 8-20 for the app vibe
5. Colors as full 6-digit hex (#RRGGBB)
6. Consider domain personality: fitness=energetic/green, finance=trust/blue, food=warm/orange, etc.

Return ONLY valid JSON:
{
  "primaryColor": "#2563EB",
  "secondaryColor": "#7C3AED",
  "accentColor": "#F59E0B",
  "backgroundColor": "#FAFAFA",
  "surfaceColor": "#FFFFFF",
  "fontFamily": "Inter",
  "useMaterial3": true,
  "isDarkPreferred": false,
  "borderRadius": 12,
  "colorRationale": "Why these colors were chosen",
  "typography": {
    "display": "32sp bold",
    "headline": "24sp semibold",
    "body": "16sp regular",
    "label": "12sp medium"
  },
  "spacingScale": [4, 8, 12, 16, 24, 32, 48],
  "componentStyle": "elevated or filled or outlined"
}`,
        },
        {
          role: 'user',
          content: `Create a design system for "${appName}" — a ${domain} app.
Brief: ${brief?.oneLiner}
Seed color hint: ${sanitizeHex(state.designTokens?.primaryColor, '#2563EB')}

Design a cohesive, professional design system that fits the ${domain} domain personality.`,
        },
      ],
      (data) => validate<DesignOutput>(DesignSystemOutput, data),
      {
        model: agentModelFor('design-system'),
        temperature: 0.4,
        maxTokens: 2048,
        responseFormat: 'json',
      }
    );
  } catch (err) {
    console.warn('[DesignSystemAgent] LLM failed, using domain defaults:', err);
    const domainDesigns: Record<string, Partial<DesignOutput>> = {
      ecommerce: { primaryColor: '#7C3AED', secondaryColor: '#A78BFA', accentColor: '#F59E0B', fontFamily: 'Inter', borderRadius: 16 },
      fitness: { primaryColor: '#059669', secondaryColor: '#10B981', accentColor: '#F97316', fontFamily: 'Inter', borderRadius: 12 },
      tasks: { primaryColor: '#2563EB', secondaryColor: '#3B82F6', accentColor: '#8B5CF6', fontFamily: 'Inter', borderRadius: 10 },
      social: { primaryColor: '#DB2777', secondaryColor: '#EC4899', accentColor: '#F59E0B', fontFamily: 'Satoshi', borderRadius: 20 },
      finance: { primaryColor: '#0891B2', secondaryColor: '#06B6D4', accentColor: '#10B981', fontFamily: 'Inter', borderRadius: 8 },
      food: { primaryColor: '#EA580C', secondaryColor: '#F97316', accentColor: '#FCD34D', fontFamily: 'Satoshi', borderRadius: 16 },
      music: { primaryColor: '#7C3AED', secondaryColor: '#8B5CF6', accentColor: '#EC4899', fontFamily: 'Panchang', borderRadius: 20 },
      travel: { primaryColor: '#0284C7', secondaryColor: '#0EA5E9', accentColor: '#F59E0B', fontFamily: 'Inter', borderRadius: 14 },
      education: { primaryColor: '#16A34A', secondaryColor: '#22C55E', accentColor: '#3B82F6', fontFamily: 'Inter', borderRadius: 12 },
    };
    const d = domainDesigns[domain] || {};
    output = {
      primaryColor: d.primaryColor || '#2563EB',
      secondaryColor: d.secondaryColor || '#3B82F6',
      accentColor: d.accentColor || '#F59E0B',
      backgroundColor: '#FAFAFA',
      surfaceColor: '#FFFFFF',
      fontFamily: d.fontFamily || 'Inter',
      useMaterial3: true,
      isDarkPreferred: false,
      borderRadius: d.borderRadius || 12,
      colorRationale: `Domain-appropriate colors for ${domain}`,
      typography: { display: '32sp bold', headline: '24sp semibold', body: '16sp regular', label: '12sp medium' },
      spacingScale: [4, 8, 12, 16, 24, 32, 48],
      componentStyle: 'filled',
    };
  }

  // --- Hard-clamp tokens before they reach shared state (never pass garbage through) ---
  const isDark = asBool(output.isDarkPreferred);
  const fallback = isDark ? M3_FALLBACK.dark : M3_FALLBACK.light;
  const discarded: string[] = [];
  const clampColor = (value: unknown, key: keyof typeof fallback): string => {
    const sanitized = sanitizeHex(value, fallback[key]);
    if (sanitized !== (typeof value === 'string' ? value.trim() : value)) {
      discarded.push(`${key}: "${String(value ?? '')}" → ${fallback[key]}`);
    }
    return sanitized;
  };

  const fontFamily = sanitizeFont(output.fontFamily);
  if (fontFamily !== str(output.fontFamily)) {
    discarded.push(`fontFamily: "${str(output.fontFamily)}" → Inter`);
  }

  const tokens: DesignTokens = {
    primaryColor: clampColor(output.primaryColor, 'primaryColor'),
    secondaryColor: clampColor(output.secondaryColor, 'secondaryColor'),
    accentColor: clampColor(output.accentColor, 'accentColor'),
    backgroundColor: clampColor(output.backgroundColor, 'backgroundColor'),
    surfaceColor: clampColor(output.surfaceColor, 'surfaceColor'),
    fontFamily,
    useMaterial3: true,
    isDarkPreferred: isDark,
    borderRadius: clampBorderRadius(output.borderRadius),
  };

  for (const note of discarded) {
    diagnostics.push({
      gate: 'design-system',
      level: 'warning',
      message: `Invalid design token discarded — ${note}`,
    });
  }

  const clampNote = discarded.length > 0
    ? ` | Clamped: ${discarded.length} invalid token(s) → Material 3 neutrals`
    : '';

  return {
    designTokens: tokens,
    diagnostics: [...state.diagnostics, ...diagnostics],
    logs: [
      ...state.logs,
      `[Design System Agent] Created design system: primary=${tokens.primaryColor}, font=${tokens.fontFamily}, radius=${tokens.borderRadius}px. Rationale: ${str(output.colorRationale, 'n/a')}${clampNote}`,
    ],
  };
}
