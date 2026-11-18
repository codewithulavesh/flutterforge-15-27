import './chat.css';

export interface EmptyChatStateProps {
  /** Heading. Defaults to "Start a conversation". */
  title?: string;
  /** Supporting copy under the heading. */
  description?: string;
  /** Suggestion prompts rendered as chips in a wrapping row. */
  suggestions?: string[];
  /** Called with the chosen suggestion when a chip is activated. */
  onPickSuggestion?: (suggestion: string) => void;
}

const DEFAULT_TITLE = 'Start a conversation';
const DEFAULT_DESCRIPTION =
  'Ask FlutterForge to build, fix, refactor or explain anything in your project. ' +
  'It can create files, run analysis and report back right here.';

/**
 * Centered empty state shown before the first message. Pure CSS-and-text
 * illustration (no external assets); suggestion chips are real buttons in
 * natural tab order.
 */
export function EmptyChatState({
  title = DEFAULT_TITLE,
  description = DEFAULT_DESCRIPTION,
  suggestions = [],
  onPickSuggestion,
}: EmptyChatStateProps) {
  return (
    <div className="chat-empty" role="note" aria-label={title}>
      <div className="chat-empty-art" aria-hidden="true">
        <span className="chat-empty-glyph">✦</span>
      </div>
      <h2 className="chat-empty-title">{title}</h2>
      {description && <p className="chat-empty-description">{description}</p>}
      {suggestions.length > 0 && (
        <div className="chat-suggestions" role="group" aria-label="Suggested prompts">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="chat-suggestion"
              onClick={() => onPickSuggestion?.(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
