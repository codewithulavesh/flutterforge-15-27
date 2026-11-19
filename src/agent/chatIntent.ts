import { callLLMText, type LLMMessage } from './llmClient';
import {
  type AssistantIntent,
  type IntentDecision,
  BUILDER_INTENTS,
  PROJECT_AWARE_INTENTS,
} from './chatTypes';

export type ChatIntent = 'chat' | 'build';
export { BUILDER_INTENTS, PROJECT_AWARE_INTENTS };
export type { AssistantIntent, IntentDecision };

export interface IntentDetectionOptions {
  apiKey?: string;
  model?: string;
  signal?: AbortSignal;
  projectFiles?: string[];
  hasErrors?: boolean;
}

const GENERAL_PATTERNS: RegExp[] = [
  /^(hi|hello|hey|yo|namaste|good\s?(morning|afternoon|evening))\b[.!?]*$/i,
  /^(thanks?|thank\s?you|thx|much\s+appreciated)[.!?]*$/i,
  /^(bye|goodbye|see\s?you|cya)[.!?]*$/i,
  /^(ok|okay|cool|nice|great|awesome|understood|got\s+it)\b[.!?]*$/i,
  /^(who\s+are\s+you|what\s+are\s+you|what\s+can\s+you\s+do|help|what\s+is\s+flutterforge)\??$/i,
];

const EXPLANATION_PATTERNS: RegExp[] = [
  /\b(what\s+is|what\s+are|explain|how\s+does|difference\s+between|why\s+use|when\s+to\s+use)\b.*\b(flutter|dart|widget|stateful|stateless|inherited|buildcontext|future|stream|async|isolate|mixin|extension|keys?|renderobject)\b/i,
  /\b(how\s+(do|can)\s+i\s+(use|implement|learn))\b.*\b(in\s+(flutter|dart))\b/i,
  /\bexplain\s+(how|what|why)\b/i,
  /\bwhat\s+(is|are)\s+the\s+difference\b/i,
];

const ARCHITECTURE_PATTERNS: RegExp[] = [
  /\b(architecture|clean\s+architecture|folder\s+structure|project\s+structure|design\s+pattern|mvvm|layer(ed)?\s+architecture)\b/i,
  /\b(state\s+management\s+pattern|state\s+management|riverpod\s+(vs|or)\s+bloc|bloc\s+(vs|or)\s+riverpod|which\s+state\s+management)\b/i,
  /\bhow\s+(should|do)\s+(i|we)\s+(structure|architect|organize)\b/i,
  /\b(best\s+practices?\s+for\s+(architecture|state|folders?|navigation))\b/i,
];

const PROJECT_QUERY_PATTERNS: RegExp[] = [
  /\b(what|which)\s+(packages?|dependencies|plugins?|libraries|screens?|pages?|widgets?|routes?|models?|files?)\b.*\b(in|of|for)\s+(this|our|my)\s+(project|app|codebase)\b/i,
  /\b(show|list|tell)\s+(me\s+)?(the\s+)?(project\s+tree|directory\s+tree|files?|dependencies|screens?|routes?)\b/i,
  /\bwhat\s+does\s+this\s+(project|app)\s+do\b/i,
  /\bwhat\s+state\s+management\s+does\s+this\s+(project|app)\s+use\b/i,
  /\bhow\s+is\s+this\s+(project|app)\s+configured\b/i,
  /\bwhat\s+is\s+in\s+(pubspec\.yaml|main\.dart)\b/i,
];

const DEBUG_PATTERNS: RegExp[] = [
  /\b(fix|resolve|debug|repair|solve|troubleshoot)\b/i,
  /\b(error|bug|issue|exception|crash|failure|trace|broken|failing|null\s*pointer|nosuchmethod|rangeerror|typeerror)\b/i,
  /\b(preview|build|compile|compilation|analysis|analyzer)\b.*\b(failed|failure|error|crash|broken)\b/i,
  /\bwhy\s+(is|did)\s+(this|it|the\s+app|the\s+build|preview)\s+(failing|crash|broken|fail)\b/i,
  /error:\s+/i,
  /exception:\s+/i,
  /stack\s+trace/i,
];

const REFACTOR_PATTERNS: RegExp[] = [
  /\b(refactor|clean\s*up|optimize|restructure|extract|modularize|simplify|decouple)\b/i,
  /\bextract\s+.*\s+(into|to)\s+(a\s+)?(new\s+)?(widget|file|component|method|helper)\b/i,
  /\bmake\s+.*\s+(more\s+reusable|cleaner|faster|efficient)\b/i,
];

const MODIFY_PATTERNS: RegExp[] = [
  /\b(change|update|modify|edit|adjust|replace|remove|delete|rename|tweak|switch)\b.*\b(color|theme|text|title|style|padding|margin|font|icon|layout|route|label)\b/i,
  /\b(change|update|modify|edit|tweak|switch)\s+(the\s+)?(theme|appbar|navbar|header|button|card|background)\b/i,
  /\b(in\s+[\w./-]+\.dart\b.*(change|update|modify|replace|delete|add))\b/i,
];

const FEATURE_PATTERNS: RegExp[] = [
  /\b(add|create|implement|build|generate|integrate)\b.*\b(screen|page|feature|service|auth|login|signup|cart|settings|profile|dashboard|form|modal|dialog|drawer|table|supabase|api|feed)\b/i,
  /\bbuild\s+(a|an|the)\s+.*\s+(screen|page|app|feature|system)\b/i,
];

/**
 * Fast, deterministic structural heuristic intent classifier.
 */
export function detectIntentHeuristic(
  rawContent: string,
  context?: { projectFiles?: string[]; hasErrors?: boolean }
): IntentDecision {
  const content = (rawContent || '').trim();
  if (!content) {
    return {
      intent: 'general',
      confidence: 1.0,
      reason: 'Empty input defaults to general conversation.',
      source: 'structural',
    };
  }

  const lower = content.toLowerCase();

  // 1. Casual / Small talk
  if (GENERAL_PATTERNS.some((pattern) => pattern.test(lower))) {
    return {
      intent: 'general',
      confidence: 0.95,
      reason: 'Matched general conversational greeting or query.',
      source: 'structural',
    };
  }

  // 2. Active build/compile error diagnostics or explicit debug requests
  if (DEBUG_PATTERNS.some((pattern) => pattern.test(lower)) || (context?.hasErrors && /fix|repair|why|resolve/i.test(lower))) {
    return {
      intent: 'debug',
      confidence: 0.92,
      reason: 'Identified bug fix or error diagnostic request.',
      source: 'structural',
    };
  }

  // 3. Questions about THIS project
  if (PROJECT_QUERY_PATTERNS.some((pattern) => pattern.test(lower))) {
    return {
      intent: 'project',
      confidence: 0.9,
      reason: 'User is asking about this specific project structure or files.',
      source: 'structural',
    };
  }

  // 4. Architecture inquiries (conceptual / design)
  if (ARCHITECTURE_PATTERNS.some((pattern) => pattern.test(lower))) {
    return {
      intent: 'architecture',
      confidence: 0.88,
      reason: 'User is asking high-level architectural or structural question.',
      source: 'structural',
    };
  }

  // 5. Concept explanations (Flutter / Dart concepts)
  if (EXPLANATION_PATTERNS.some((pattern) => pattern.test(lower)) && !lower.startsWith('add ') && !lower.startsWith('create ')) {
    return {
      intent: 'explanation',
      confidence: 0.88,
      reason: 'User is asking for an educational explanation of Flutter/Dart concepts.',
      source: 'structural',
    };
  }

  // 6. Refactoring / Optimization
  if (REFACTOR_PATTERNS.some((pattern) => pattern.test(lower))) {
    return {
      intent: 'refactor',
      confidence: 0.85,
      reason: 'User requested refactoring or code optimization.',
      source: 'structural',
    };
  }

  // 7. Surgical code modifications
  if (MODIFY_PATTERNS.some((pattern) => pattern.test(lower))) {
    return {
      intent: 'modify',
      confidence: 0.85,
      reason: 'User requested a targeted modification to existing project code.',
      source: 'structural',
    };
  }

  // 8. New feature implementation
  if (FEATURE_PATTERNS.some((pattern) => pattern.test(lower))) {
    return {
      intent: 'feature',
      confidence: 0.85,
      reason: 'User requested implementing a new screen or feature.',
      source: 'structural',
    };
  }

  // 9. General question checks: ending with question mark and starting with question words
  if (lower.endsWith('?') && /^(what|how|why|can|is|are|should|where|which|who)\b/i.test(lower)) {
    // If it mentions specific project files or "my/this app", it's project-aware
    if (/\b(this|my|our)\s+(app|project|code)\b/i.test(lower) || /\b(pubspec|main\.dart|\.dart)\b/i.test(lower)) {
      return {
        intent: 'project',
        confidence: 0.75,
        reason: 'User asked a question referencing project context.',
        source: 'structural',
      };
    }
    return {
      intent: 'explanation',
      confidence: 0.7,
      reason: 'User asked a general Flutter/Dart question.',
      source: 'structural',
    };
  }

  // 10. Default heuristic: longer imperative sentences usually describe features or changes
  if (content.length > 80 || /^(make|build|add|implement|give me|put|setup|set up)\b/i.test(lower)) {
    return {
      intent: 'feature',
      confidence: 0.7,
      reason: 'Imperative phrasing indicative of building or creating features.',
      source: 'structural',
    };
  }

  return {
    intent: 'general',
    confidence: 0.5,
    reason: 'Ambiguous prompt defaulted to conversational assistance.',
    source: 'structural',
  };
}

/**
 * Intelligent intent classifier:
 * Evaluates structural rules and optionally consults a fast model for ambiguous queries.
 */
export async function detectChatIntent(
  content: string,
  options: IntentDetectionOptions = {}
): Promise<IntentDecision> {
  const heuristic = detectIntentHeuristic(content, {
    projectFiles: options.projectFiles,
    hasErrors: options.hasErrors,
  });

  // If high confidence or no API key, trust the structural classifier immediately
  if (heuristic.confidence >= 0.8 || !options.apiKey) {
    return heuristic;
  }

  // For ambiguous cases with an API key, run a fast structured classifier
  try {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are an intent classification engine for FlutterForge, a Flutter IDE and builder.
Classify the user's input into exactly one of these 8 intents:
- "general": Casual greetings, small talk, identity, general non-code chat
- "explanation": Flutter or Dart educational concept explanations
- "project": Questions inquiring about the current project structure, files, packages, screens
- "modify": Requests to edit, tweak, or update existing code, theme, or styles
- "feature": Requests to create, add, or build new screens, components, or capabilities
- "debug": Requests to diagnose and fix errors, bugs, or preview/build failures
- "refactor": Requests to optimize, clean up, or extract code without adding features
- "architecture": High-level questions about patterns, folder structures, or architecture design

Return ONLY valid JSON matching this schema:
{"intent": "general"|"explanation"|"project"|"modify"|"feature"|"debug"|"refactor"|"architecture", "confidence": number, "reason": "short explanation"}`,
      },
      {
        role: 'user',
        content: `User input: "${content}"`,
      },
    ];

    // Use a strict short timeout for classification so we never stall the chat
    const timeoutSignal = AbortSignal.timeout(3500);
    const combinedSignal = options.signal
      ? (AbortSignal.any ? AbortSignal.any([options.signal, timeoutSignal]) : options.signal)
      : timeoutSignal;

    const raw = await callLLMText(messages, {
      apiKey: options.apiKey,
      model: options.model || 'nvidia/nemotron-3.5-lightning:free',
      temperature: 0.1,
      maxTokens: 120,
      responseFormat: 'json',
      signal: combinedSignal,
    });

    const parsed = JSON.parse(raw.trim()) as { intent?: string; confidence?: number; reason?: string };
    const validIntents: AssistantIntent[] = [
      'general', 'explanation', 'project', 'modify', 'feature', 'debug', 'refactor', 'architecture'
    ];

    if (parsed.intent && validIntents.includes(parsed.intent as AssistantIntent)) {
      return {
        intent: parsed.intent as AssistantIntent,
        confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.9,
        reason: parsed.reason || 'Classified by LLM intent router.',
        source: 'classifier',
      };
    }
  } catch {
    // If classification fails or times out, safely return the heuristic decision
  }

  return heuristic;
}

/**
 * Backward-compatible helper for legacy callers expecting 'chat' | 'build'.
 */
export function classifyChatIntent(rawContent: string): ChatIntent {
  const decision = detectIntentHeuristic(rawContent);
  return BUILDER_INTENTS.has(decision.intent) ? 'build' : 'chat';
}
