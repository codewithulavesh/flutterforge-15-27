import type { ProjectState, DesignTokens } from '../orchestrator/state';
import { callLLMJsonStrict, agentModelFor } from './llmClient';
import { validate } from './schema';
import { DesignSystemOutput } from './schemas';

export async function runDesignSystemAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const brief = state.productBrief;
  const intake = (state as Record<string, unknown>)._intakeData as Record<string, unknown> | undefined;
  const domain = (intake?.domain as string) || 'general';
  const appName = brief?.appName || 'App';

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
3. Font families: "Inter", "Poppins", "Nunito", "Roboto", "Space Grotesk" — pick what fits
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
Seed color hint: ${state.designTokens?.primaryColor || '#2563EB'}

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
      ecommerce: { primaryColor: '#7C3AED', secondaryColor: '#A78BFA', accentColor: '#F59E0B', fontFamily: 'Poppins', borderRadius: 16 },
      fitness: { primaryColor: '#059669', secondaryColor: '#10B981', accentColor: '#F97316', fontFamily: 'Inter', borderRadius: 12 },
      tasks: { primaryColor: '#2563EB', secondaryColor: '#3B82F6', accentColor: '#8B5CF6', fontFamily: 'Inter', borderRadius: 10 },
      social: { primaryColor: '#DB2777', secondaryColor: '#EC4899', accentColor: '#F59E0B', fontFamily: 'Nunito', borderRadius: 20 },
      finance: { primaryColor: '#0891B2', secondaryColor: '#06B6D4', accentColor: '#10B981', fontFamily: 'Roboto', borderRadius: 8 },
      food: { primaryColor: '#EA580C', secondaryColor: '#F97316', accentColor: '#FCD34D', fontFamily: 'Nunito', borderRadius: 16 },
      music: { primaryColor: '#7C3AED', secondaryColor: '#8B5CF6', accentColor: '#EC4899', fontFamily: 'Poppins', borderRadius: 20 },
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

  const tokens: DesignTokens = {
    primaryColor: output.primaryColor,
    secondaryColor: output.secondaryColor,
    accentColor: output.accentColor,
    backgroundColor: output.backgroundColor,
    surfaceColor: output.surfaceColor,
    fontFamily: output.fontFamily,
    useMaterial3: true,
    isDarkPreferred: output.isDarkPreferred,
    borderRadius: output.borderRadius,
  };

  return {
    designTokens: tokens,
    logs: [
      ...state.logs,
      `[Design System Agent] Created design system: primary=${tokens.primaryColor}, font=${tokens.fontFamily}, radius=${tokens.borderRadius}px. Rationale: ${output.colorRationale}`,
    ],
  };
}
