/**
 * Reads *explicit* product intent from the raw user prompt.
 *
 * The discovery LLMs are good at describing features but unreliable at
 * honoring negations: "no auth", "do NOT use Supabase", "Backend: None".
 * These helpers derive unambiguous signals from the prompt itself so the
 * intake and architecture agents can override a model guess that contradicts
 * the user's literal instructions.
 */

const NEGATION =
  /\b(?:no|not|never|without|don'?t|do not|doesn'?t|isn'?t|aren'?t|avoid|skip|exclude|local[- ]only|offline)\b/i;

/** Text between the previous clause boundary and a match, used for negation checks. */
function clauseBefore(text: string, index: number): string {
  const chunk = text.slice(Math.max(0, index - 90), index);
  let boundary = -1;
  for (const separator of ['.', ';', '!', '?', '\n', ',']) {
    boundary = Math.max(boundary, chunk.lastIndexOf(separator));
  }
  return chunk.slice(boundary + 1);
}

/** True when at least one match has (or lacks) a nearby negation word. */
function anyMention(text: string, pattern: RegExp, wantNegated: boolean): boolean {
  for (const match of text.matchAll(pattern)) {
    const negated = NEGATION.test(clauseBefore(text, match.index ?? 0));
    if (negated === wantNegated) return true;
  }
  return false;
}

export interface BackendIntent {
  /** The prompt explicitly rules out a backend/database/auth (local-only, offline). */
  localOnly: boolean;
  /** The prompt explicitly asks for Supabase (or auth/database) and does not rule it out. */
  wantsSupabase: boolean;
}

export function analyzeBackendIntent(prompt: string): BackendIntent {
  const text = String(prompt ?? '');

  const localOnly =
    anyMention(text, /\b(?:local[- ]?only|offline[- ]?(?:first|only)|fully offline)\b/gi, false) ||
    anyMention(text, /\b(?:backend|database|db|sql|supabase|server|auth(?:entication)?)\b/gi, true);

  const supabaseRequested = anyMention(text, /\bsupabase\b/gi, false);
  const backendRequested = anyMention(
    text,
    /\b(?:auth(?:entication)?|database|realtime|backend|sql)\b/gi,
    false,
  );

  return {
    localOnly,
    wantsSupabase: !localOnly && (supabaseRequested || backendRequested),
  };
}

/** Extracts a name only when the prompt states it explicitly ("Project: X", 'called "X"'). */
export function extractExplicitAppName(prompt: string): string | null {
  const patterns = [
    /\bproject\s*:\s*([A-Za-z][A-Za-z0-9]*(?:[ \t]+[A-Za-z0-9]+){0,3})/i,
    /\b(?:app|application)\s+(?:called|named)\s+"?([A-Za-z][A-Za-z0-9]*(?:[ \t]+[A-Za-z0-9]+){0,3})/i,
    /\bcalled\s+"?([A-Za-z][A-Za-z0-9]*(?:[ \t]+[A-Za-z0-9]+){0,3})/i,
    /\bnamed\s+"?([A-Za-z][A-Za-z0-9]*(?:[ \t]+[A-Za-z0-9]+){0,3})/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(prompt);
    if (!match) continue;
    const pascal = match[1]
      .split(/[ \t]+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('')
      .replace(/[^A-Za-z0-9]/g, '');
    if (pascal.length >= 2) return pascal;
  }
  return null;
}

/** Keyword domain fallback with word boundaries, so "production-grade" is not "product". */
export function detectDomain(prompt: string): string | null {
  const text = String(prompt ?? '').toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/\b(?:shop|store|storefront|e-?commerce|cart|checkout|marketplace|products?)\b/, 'ecommerce'],
    [/\b(?:fitness|workout|gym|steps?|calories?|exercise)\b/, 'fitness'],
    [/\b(?:finance|money|expense|wallet|budget|invest|banking)\b/, 'finance'],
    [/\b(?:task|todo|kanban|board)\b/, 'tasks'],
    [/\b(?:chat|message|social|community|feed|post)\b/, 'social'],
    [/\b(?:food|recipe|restaurant|meal|diet)\b/, 'food'],
    [/\b(?:music|audio|playlist|podcast|listen)\b/, 'music'],
    [/\b(?:travel|trip|hotel|flight|map|navigation)\b/, 'travel'],
    [/\b(?:learn|course|quiz|education|study)\b/, 'education'],
    [/\b(?:health|medical|patient|clinic)\b/, 'health'],
    [/\b(?:admin|dashboard|analytics|audit|management console|control panel)\b/, 'general'],
  ];
  for (const [pattern, domain] of rules) {
    if (pattern.test(text)) return domain;
  }
  return null;
}

const VALID_PLATFORM_NAMES = ['web', 'android', 'ios', 'macos', 'windows'] as const;

export function extractPlatforms(prompt: string): string[] | null {
  const match = /\bplatform\s*:\s*([^\n\r,;]+)/i.exec(prompt);
  if (!match) return null;
  const found = VALID_PLATFORM_NAMES.filter((name) =>
    new RegExp(`\\b${name}\\b`, 'i').test(match[1]),
  );
  return found.length > 0 ? [...found] : null;
}

export function extractStateManagement(prompt: string): string | null {
  const match = /\bstate\s*management\s*:\s*(provider|riverpod|bloc)\b/i.exec(prompt);
  return match ? match[1].toLowerCase() : null;
}

export function extractDarkTheme(prompt: string): boolean | null {
  if (/\b(?:theme\s*mode\s*:\s*dark|theme\s*:\s*dark|dark\s+theme)\b/i.test(prompt)) return true;
  if (/\b(?:theme\s*mode\s*:\s*light|theme\s*:\s*light|light\s+theme)\b/i.test(prompt)) return false;
  return null;
}
