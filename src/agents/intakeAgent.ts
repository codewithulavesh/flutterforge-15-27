import type { ProjectState, ProductBrief } from '../orchestrator/state';
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

export async function runIntakeAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const prompt = state.userPrompt.trim();

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
      needsSupabase: p.includes('auth') || p.includes('login') || p.includes('account') || p.includes('database') || p.includes('realtime'),
      colorPalette: colorMap[domain] || '#2563EB',
    };
    console.warn('[IntakeAgent] LLM failed, using keyword fallback:', err);
  }

  const brief: ProductBrief = {
    appName: output.appName,
    oneLiner: output.oneLiner,
    targetAudience: output.targetAudience,
    primaryProblem: output.primaryProblem,
    platforms: (output.platforms as ProductBrief['platforms']) ?? ['web', 'android', 'ios'],
    constraints: output.constraints,
  };

  return {
    productBrief: brief,
    // Store extra intake data in designTokens seed for downstream agents
    designTokens: {
      ...(state.designTokens ?? {
        primaryColor: '#2563EB', secondaryColor: '#3B82F6', accentColor: '#F59E0B',
        backgroundColor: '#FAFAFA', surfaceColor: '#FFFFFF', fontFamily: 'Inter',
        useMaterial3: true, isDarkPreferred: false, borderRadius: 12,
      }),
      primaryColor: output.colorPalette,
    },
    logs: [
      ...state.logs,
      `[Intake Agent] Domain: "${output.domain}" | App: "${output.appName}" | Screens: ${output.screens?.join(', ')} | Supabase: ${output.needsSupabase}`,
    ],
    // Pass intake analysis downstream via a custom field
    _intakeData: output,
  } as Partial<ProjectState> & { _intakeData: IntakeLLMOutput };
}
