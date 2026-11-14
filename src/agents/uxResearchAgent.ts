import type { ProjectState, ScreenGraph, ScreenDefinition } from '../orchestrator/state';
import { callLLMJsonStrict, agentModelFor } from './llmClient';
import { validate } from './schema';
import { UXResearchOutput } from './schemas';

export async function runUXResearchAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const brief = state.productBrief;
  const intake = (state as Record<string, unknown>)._intakeData as Record<string, unknown> | undefined;

  const appName = brief?.appName || 'App';
  const screens = (intake?.screens as string[]) || ['HomeScreen', 'ProfileScreen', 'SettingsScreen'];
  const keyFeatures = (intake?.keyFeatures as string[]) || ['Dashboard', 'Profile', 'Settings'];
  const domain = (intake?.domain as string) || 'general';

  interface UXOutput {
    screens: Array<{
      id: string;
      name: string;
      route: string;
      purpose: string;
      primaryAction: string;
      isAuthRequired: boolean;
      widgets: string[];
      states: { loading: string; empty: string; error: string; content: string };
    }>;
    userFlows: Array<{ id: string; name: string; steps: string[] }>;
    navigation: string;
  }

  let output: UXOutput;
  try {
    output = await callLLMJsonStrict<UXOutput>(
      [
        {
          role: 'system',
          content: `You are the UX Research Agent for FlutterForge, an expert Flutter UX architect.

Your job: Design a complete, production-ready screen hierarchy and user flow for a ${domain} Flutter app.

RULES:
1. Every screen MUST have all 4 UI states: loading (skeleton/spinner), empty (illustration + CTA), error (message + retry), content (the real UI)
2. Every interactive control must have a real purpose and onTap/onPressed handler
3. No dead buttons. No "coming soon" placeholders.
4. Navigation must be logical: tabs for main sections, stack for detail screens
5. Each screen must list real Flutter widgets it uses

Return ONLY valid JSON:
{
  "screens": [
    {
      "id": "home",
      "name": "HomeScreen",
      "route": "/",
      "purpose": "Main landing with key metrics and quick actions",
      "primaryAction": "What the main FAB or primary button does",
      "isAuthRequired": false,
      "widgets": ["ListView", "Card", "RefreshIndicator", "FloatingActionButton"],
      "states": {
        "loading": "Show shimmer skeleton cards",
        "empty": "Illustration with 'Get Started' CTA",
        "error": "Error icon, message, Retry button",
        "content": "List of items with pull-to-refresh"
      }
    }
  ],
  "userFlows": [
    {
      "id": "onboarding",
      "name": "First-time user onboarding",
      "steps": ["SplashScreen → LoginScreen → HomeScreen"]
    }
  ],
  "navigation": "bottom_tabs" or "drawer" or "stack"
}`,
        },
        {
          role: 'user',
          content: `Design UX for the app "${appName}".
App brief: ${brief?.oneLiner}
Domain: ${domain}
Key features: ${keyFeatures.join(', ')}
Required screens (minimum): ${screens.join(', ')}

Design comprehensive UX with all screen states. Add any extra screens that make UX complete.`,
        },
      ],
      (data) => validate<UXOutput>(UXResearchOutput, data),
      {
        model: agentModelFor('ux-research'),
        temperature: 0.3,
        maxTokens: 4096,
        responseFormat: 'json',
      }
    );
  } catch (err) {
    console.warn('[UXResearchAgent] LLM failed, using structural fallback:', err);
    output = {
      screens: screens.map((name, i) => ({
        id: name.replace('Screen', '').toLowerCase(),
        name,
        route: i === 0 ? '/' : `/${name.replace('Screen', '').toLowerCase()}`,
        purpose: `${name.replace('Screen', '')} functionality`,
        primaryAction: 'Primary user action',
        isAuthRequired: i > 0,
        widgets: ['Scaffold', 'AppBar', 'ListView', 'Card', 'FloatingActionButton'],
        states: {
          loading: 'CircularProgressIndicator centered',
          empty: 'Empty state illustration with CTA',
          error: 'Error message with Retry button',
          content: `${name} content list with interactive items`,
        },
      })),
      userFlows: [
        { id: 'main', name: 'Main user flow', steps: screens.map((s) => s) },
      ],
      navigation: 'bottom_tabs',
    };
  }

  const screenGraph: ScreenGraph = {
    screens: output.screens.map(
      (s): ScreenDefinition => ({
        id: s.id,
        name: s.name,
        route: s.route,
        purpose: s.purpose,
        primaryAction: s.primaryAction,
        isAuthRequired: s.isAuthRequired,
        widgets: s.widgets,
        states: s.states,
      })
    ),
    userFlows: output.userFlows,
  };

  return {
    screenGraph,
    logs: [
      ...state.logs,
      `[UX Research Agent] Designed ${screenGraph.screens.length} screens with 4-state pattern. Navigation: ${output.navigation}. Flows: ${output.userFlows.map((f) => f.name).join(', ')}`,
    ],
    _uxNavigation: output.navigation,
  } as Partial<ProjectState>;
}
