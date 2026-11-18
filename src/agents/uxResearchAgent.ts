import type { ProjectState, ScreenGraph, ScreenDefinition, GateDiagnostic } from '../orchestrator/state';
import { callLLMJsonStrict, agentModelFor } from './llmClient';
import { validate } from './schema';
import { UXResearchOutput } from './schemas';

const SCREEN_MIN = 3;
const SCREEN_MAX = 12;

const FALLBACK_SCREENS: Array<{ name: string; route: string; purpose: string }> = [
  { name: 'HomeScreen', route: '/', purpose: 'Main landing screen with key metrics and quick actions' },
  { name: 'ProfileScreen', route: '/profile', purpose: 'User profile and account settings' },
  { name: 'SettingsScreen', route: '/settings', purpose: 'App settings and preferences' },
];

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/screen$/i, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
  return slug || fallback;
}

function normalizeScreen(raw: unknown, index: number, usedIds: Set<string>): ScreenDefinition | null {
  if (!isPlainObject(raw)) return null;
  const name = str(raw.name);
  if (!name) return null;

  let id = str(raw.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
  if (!id) id = slugify(name, `screen_${index + 1}`);
  let candidate = id;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${id}_${suffix}`;
    suffix += 1;
  }
  id = candidate;
  usedIds.add(id);

  let route = str(raw.route);
  if (!route.startsWith('/')) route = index === 0 && id === 'home' ? '/' : `/${id}`;

  const statesRaw = isPlainObject(raw.states) ? raw.states : {};
  const widgets = asStringArray(raw.widgets);

  return {
    id,
    name,
    route,
    purpose: str(raw.purpose, `${name.replace(/Screen$/i, '')} functionality`),
    primaryAction: str(raw.primaryAction, 'Primary user action'),
    isAuthRequired: asBool(raw.isAuthRequired),
    widgets: widgets.length > 0 ? widgets : ['Scaffold', 'AppBar', 'ListView', 'Card'],
    states: {
      loading: str(statesRaw.loading, 'CircularProgressIndicator centered'),
      empty: str(statesRaw.empty, 'Empty state illustration with CTA'),
      error: str(statesRaw.error, 'Error message with Retry button'),
      content: str(statesRaw.content, `${name} content list with interactive items`),
    },
  };
}

export async function runUXResearchAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const brief = state.productBrief;
  const intake = (state as Record<string, unknown>)._intakeData as Record<string, unknown> | undefined;

  const appName = brief?.appName || 'App';
  const screens = asStringArray(intake?.screens).length > 0
    ? asStringArray(intake?.screens)
    : ['HomeScreen', 'ProfileScreen', 'SettingsScreen'];
  const keyFeatures = asStringArray(intake?.keyFeatures).length > 0
    ? asStringArray(intake?.keyFeatures)
    : ['Dashboard', 'Profile', 'Settings'];
  const domain = str(intake?.domain, 'general');

  const diagnostics: GateDiagnostic[] = [];

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
6. Design between ${SCREEN_MIN} and ${SCREEN_MAX} screens — no more, no less

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

  // --- Normalize + clamp the screen list before it reaches shared state ---
  const rawScreens = Array.isArray(output.screens) ? output.screens : [];
  const usedIds = new Set<string>();
  const normalized: ScreenDefinition[] = [];
  let droppedInvalid = 0;
  for (let i = 0; i < rawScreens.length; i++) {
    const screen = normalizeScreen(rawScreens[i], i, usedIds);
    if (!screen) {
      droppedInvalid += 1;
      continue;
    }
    normalized.push(screen);
  }
  if (droppedInvalid > 0) {
    diagnostics.push({
      gate: 'ux-research',
      level: 'warning',
      message: `Dropped ${droppedInvalid} invalid screen definition(s) from model output`,
    });
  }

  let clampedScreens: ScreenDefinition[];
  let screensCapNote: string | null = null;
  if (normalized.length > SCREEN_MAX) {
    screensCapNote = `ScreensCap: clamped to ${SCREEN_MAX} screens (model emitted ${normalized.length})`;
    diagnostics.push({ gate: 'ux-research', level: 'warning', message: screensCapNote });
    clampedScreens = normalized.slice(0, SCREEN_MAX);
  } else {
    clampedScreens = normalized;
  }

  if (clampedScreens.length < SCREEN_MIN) {
    const pads: ScreenDefinition[] = [];
    for (const fallback of FALLBACK_SCREENS) {
      if (clampedScreens.length >= SCREEN_MIN) break;
      const candidate = slugify(fallback.name, 'screen');
      if (usedIds.has(candidate)) continue;
      const screen: ScreenDefinition = {
        id: candidate,
        name: fallback.name,
        route: fallback.route,
        purpose: fallback.purpose,
        primaryAction: 'Primary user action',
        isAuthRequired: false,
        widgets: ['Scaffold', 'AppBar', 'ListView', 'Card', 'FloatingActionButton'],
        states: {
          loading: 'CircularProgressIndicator centered',
          empty: 'Empty state illustration with CTA',
          error: 'Error message with Retry button',
          content: `${fallback.name} content list with interactive items`,
        },
      };
      usedIds.add(candidate);
      clampedScreens = [...clampedScreens, screen];
      pads.push(screen);
    }
    if (pads.length > 0) {
      diagnostics.push({
        gate: 'ux-research',
        level: 'info',
        message: `ScreensCap: padded to minimum ${SCREEN_MIN} screens (model emitted ${normalized.length}) — added ${pads.map((p) => p.name).join(', ')}`,
      });
    }
  }

  const rawFlows = Array.isArray(output.userFlows) ? output.userFlows : [];
  const userFlows = rawFlows.flatMap((flow, i) => {
    if (!isPlainObject(flow)) return [];
    const name = str(flow.name);
    if (!name) return [];
    const steps = asStringArray(flow.steps);
    return [{
      id: str(flow.id, `flow_${i + 1}`),
      name,
      steps: steps.length > 0 ? steps : [name],
    }];
  });

  const navigation = str(output.navigation, 'bottom_tabs');

  const screenGraph: ScreenGraph = {
    screens: clampedScreens,
    userFlows,
  };

  const logs = [
    ...state.logs,
    `[UX Research Agent] Designed ${screenGraph.screens.length} screens with 4-state pattern. Navigation: ${navigation}. Flows: ${userFlows.map((f) => f.name).join(', ')}`,
  ];
  if (screensCapNote) {
    logs.push(`[UX Research Agent] ${screensCapNote}`);
  }

  return {
    screenGraph,
    diagnostics: [...state.diagnostics, ...diagnostics],
    logs,
    _uxNavigation: navigation,
  } as Partial<ProjectState>;
}
