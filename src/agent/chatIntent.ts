export type ChatIntent = 'chat' | 'build';

const CHAT_ONLY_PATTERNS: RegExp[] = [
  /^(hi|hello|hey|yo|namaste|good\s?(morning|afternoon|evening))\b[.!?]*$/i,
  /^(thanks?|thank\s?you|thx)[.!?]*$/i,
  /^(bye|goodbye|see\s?you)[.!?]*$/i,
  /^(ok|okay|cool|nice|great|awesome|understood)\b[.!?]*$/i,
  /^(who\sare\syou|what\sare\syou|what\scan\syou\sdo|help)\??$/i,
];

const HOW_TO_PATTERN: RegExp = /\bhow\s+(do\s+i|can\s+i|to|should\s+i)\b/i;

const BUILD_KEYWORDS: RegExp = new RegExp(
  [
    'add', 'create', 'generate', 'implement', 'change', 'update', 'modify',
    'edit', 'fix', 'repair', 'refactor', 'screen', 'widget', 'button', 'page',
    'layout', 'theme', 'dark mode', 'auth', 'login', 'signup', 'form', 'list',
    'card', 'modal', 'backend', 'supabase', 'database', 'table',
  ].join('|'),
  'i'
);

export function classifyChatIntent(rawContent: string): ChatIntent {
  const content = (rawContent || '').trim();
  if (!content) return 'chat';
  if (content.length > 500) return 'build';

  const lower = content.toLowerCase().trim();
  if (CHAT_ONLY_PATTERNS.some((re) => re.test(lower))) return 'chat';
  if (HOW_TO_PATTERN.test(lower) && !BUILD_KEYWORDS.test(lower)) return 'chat';
  if (BUILD_KEYWORDS.test(lower)) return 'build';
  if (lower.endsWith('?')) return 'chat';
  return 'build';
}

