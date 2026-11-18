/**
 * Conversation Context Manager.
 *
 * Replaces fixed message slicing with a token-budget-aware history manager:
 * - Validates message roles ('user' | 'assistant').
 * - Preserves recent message flow.
 * - Extracts compact decision summaries from older messages.
 * - Enforces strict token budgets.
 * - Keeps conversation dialogue memory separate from project state.
 */

export interface RawChatMessage {
  role: string;
  content: string;
}

export interface ValidatedChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ManageHistoryOptions {
  /** Maximum token budget for the conversation history (default: 3000). */
  maxTokens?: number;
  /** Number of recent messages to prioritize preserving in full (default: 8). */
  recentMessageWindow?: number;
  /** Current user prompt being answered. */
  currentPrompt?: string;
}

export interface ManagedConversationHistory {
  messages: ValidatedChatMessage[];
  summary?: string;
  estimatedTokens: number;
  totalRawMessages: number;
  includedMessageCount: number;
}

/**
 * Fast token estimation: ~4 chars per token for prose, ~3 for code.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const hasCode = /```|\{|\}|class\s+|void\s+|import\s+/i.test(text);
  const factor = hasCode ? 3.2 : 4.0;
  return Math.max(1, Math.ceil(text.length / factor));
}

/**
 * Validate and sanitize chat message items.
 */
export function validateMessageRoles(raw: RawChatMessage[]): ValidatedChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const result: ValidatedChatMessage[] = [];

  for (const item of raw) {
    if (!item || typeof item.content !== 'string') continue;
    const content = item.content.trim();
    if (!content) continue;

    const role: 'user' | 'assistant' =
      item.role === 'assistant' ? 'assistant' : 'user';

    // Prevent duplicate adjacent messages with identical role and content
    const last = result[result.length - 1];
    if (last && last.role === role && last.content === content) {
      continue;
    }

    result.push({ role, content });
  }

  return result;
}

/**
 * Summarize older conversation messages to preserve decisions without bloating tokens.
 */
function summarizeOlderMessages(messages: ValidatedChatMessage[]): string | undefined {
  if (messages.length === 0) return undefined;

  const keyDecisions: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      const line = msg.content.split('\n')[0].trim().slice(0, 100);
      if (line) {
        keyDecisions.push(`- User asked: "${line}"`);
      }
    } else if (msg.role === 'assistant') {
      // Look for key actions in assistant responses (e.g., file changes or architectural choices)
      const firstSentence = msg.content.split(/[.\n]/)[0].trim().slice(0, 120);
      if (firstSentence && !firstSentence.startsWith('-')) {
        keyDecisions.push(`  → Assistant action: ${firstSentence}`);
      }
    }
  }

  if (keyDecisions.length === 0) return undefined;

  // Keep up to 6 most relevant older decision points
  const recentDecisions = keyDecisions.slice(-6).join('\n');
  return `Prior conversation summary and key decisions:\n${recentDecisions}`;
}

export class ConversationContextManager {
  /**
   * Process raw message history into a token-budget-aware, validated conversation context.
   */
  public static manage(
    rawMessages: RawChatMessage[],
    options: ManageHistoryOptions = {}
  ): ManagedConversationHistory {
    const maxTokens = options.maxTokens ?? 3000;
    const recentWindow = options.recentMessageWindow ?? 8;

    const validMessages = validateMessageRoles(rawMessages);
    const totalRawMessages = validMessages.length;

    if (totalRawMessages === 0) {
      return {
        messages: [],
        estimatedTokens: 0,
        totalRawMessages: 0,
        includedMessageCount: 0,
      };
    }

    // Split messages into older history and recent window
    const splitIndex = Math.max(0, totalRawMessages - recentWindow);
    const olderMessages = validMessages.slice(0, splitIndex);
    const recentCandidates = validMessages.slice(splitIndex);

    // Extract summary of older decisions
    const summary = olderMessages.length > 0 ? summarizeOlderMessages(olderMessages) : undefined;
    const summaryTokens = summary ? estimateTokens(summary) : 0;

    const availableTokens = Math.max(200, maxTokens - summaryTokens);

    // Fit recent messages from newest to oldest
    const selected: ValidatedChatMessage[] = [];
    let accumulatedTokens = 0;

    for (let i = recentCandidates.length - 1; i >= 0; i--) {
      const msg = recentCandidates[i];
      const tokens = estimateTokens(msg.content);

      if (accumulatedTokens + tokens <= availableTokens || selected.length === 0) {
        selected.unshift(msg);
        accumulatedTokens += tokens;
      } else {
        // If a message is too large, we can truncate it if it is the only one remaining
        if (selected.length < 2 && availableTokens > 150) {
          const charLimit = availableTokens * 3;
          selected.unshift({
            role: msg.role,
            content: `${msg.content.slice(0, charLimit)}… [truncated for context limit]`,
          });
          accumulatedTokens += availableTokens;
        }
        break;
      }
    }

    const totalEstimatedTokens = accumulatedTokens + summaryTokens;

    return {
      messages: selected,
      summary,
      estimatedTokens: totalEstimatedTokens,
      totalRawMessages,
      includedMessageCount: selected.length,
    };
  }
}
