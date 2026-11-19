import { MessageResponse } from '@/components/ai-elements/message';
import type { ReactNode } from 'react';
import { Bot, Square } from 'lucide-react';
import './chat.css';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessageProps {
  role: ChatRole;
  content: string;
  isStreaming?: boolean;
  stopped?: boolean;
  timestamp?: string | number;
  /** Display name override (e.g. the agent persona). Defaults to a sensible label per role. */
  name?: string;
  /** Extra rendered content below the message body — e.g. file-change chips, tool receipts. */
  children?: ReactNode;
}

const DEFAULT_NAMES: Record<ChatRole, string> = {
  user: 'You',
  assistant: 'FlutterForge',
  system: 'System',
};

function toDate(timestamp: string | number): Date | null {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTimestamp(timestamp: string | number): string {
  const date = toDate(timestamp);
  if (!date) return String(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dateTimeAttr(timestamp: string | number): string | undefined {
  return toDate(timestamp)?.toISOString();
}

/**
 * A single chat message. Presentational: props in, DOM out.
 * Never renders raw HTML — `content` is always plain text (whitespace preserved);
 * Markdown/rich rendering is the caller's responsibility.
 */
export function ChatMessage({
  role,
  content,
  isStreaming = false,
  stopped = false,
  timestamp,
  name,
  children,
}: ChatMessageProps) {
  const displayName = name ?? DEFAULT_NAMES[role];
  const isAssistant = role === 'assistant';
  const isUser = role === 'user';
  const isSystem = role === 'system';

  const ariaLabel = [
    `${role} message`,
    isStreaming ? 'generating' : null,
    stopped ? 'stopped' : null,
  ]
    .filter(Boolean)
    .join(', ');

  const className = [
    'chat-message',
    `chat-message--${role}`,
    isStreaming ? 'chat-message--streaming' : null,
    stopped ? 'chat-message--stopped' : null,
  ]
    .filter(Boolean)
    .join(' ');

  if (isSystem) {
    return (
      <div
        className={className}
        role="article"
        aria-label={ariaLabel}
        aria-busy={isStreaming || undefined}
        data-testid="chat-message-system"
      >
        <div className="chat-system-bubble">
          <div className="chat-message-meta">
            <span className="chat-name">{displayName}</span>
            {timestamp !== undefined && (
              <time className="chat-timestamp" dateTime={dateTimeAttr(timestamp)}>
                {formatTimestamp(timestamp)}
              </time>
            )}
            {stopped && (
              <span className="chat-stopped-pill">
                <Square size={9} aria-hidden="true" fill="currentColor" />
                stopped
              </span>
            )}
          </div>
          <p className="chat-content">{content}</p>
          {children && <div className="chat-message-children">{children}</div>}
        </div>
      </div>
    );
  }

  return (
    <div
      className={className}
      role="article"
      aria-label={ariaLabel}
      aria-busy={isStreaming || undefined}
      data-testid={`chat-message-${role}`}
    >
      {isAssistant && (
        <div className="chat-avatar" aria-hidden="true">
          <Bot size={18} strokeWidth={2} />
        </div>
      )}
      <div className="chat-message-body">
        <div className="chat-message-meta">
          <span className="chat-name">{displayName}</span>
          {timestamp !== undefined && (
            <time className="chat-timestamp" dateTime={dateTimeAttr(timestamp)}>
              {formatTimestamp(timestamp)}
            </time>
          )}
          {stopped && (
            <span className="chat-stopped-pill">
              <Square size={9} aria-hidden="true" fill="currentColor" />
              stopped
            </span>
          )}
        </div>
        <div className={`chat-bubble ${isUser ? 'chat-bubble--user' : 'chat-bubble--assistant'}`}>
          {content !== '' && (isAssistant ? <MessageResponse>{content}</MessageResponse> : <p className="chat-content">{content}</p>)}
          {isStreaming && (
            <span className="chat-streaming" aria-hidden="true">
              <span className="chat-streaming-dot" />
              <span className="chat-streaming-dot" />
              <span className="chat-streaming-dot" />
            </span>
          )}
          {children && <div className="chat-message-children">{children}</div>}
        </div>
      </div>
    </div>
  );
}
