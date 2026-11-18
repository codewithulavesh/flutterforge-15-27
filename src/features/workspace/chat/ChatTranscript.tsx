import { useEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { ChatMessage, type ChatRole } from './ChatMessage';
import './chat.css';

export interface TranscriptMessage {
  id: string;
  role: ChatRole;
  content: string;
  isStreaming?: boolean;
  stopped?: boolean;
  timestamp?: string | number;
}

export interface ChatTranscriptProps {
  messages: TranscriptMessage[];
  /** Called after the user activates "jump to latest". The integrator can use it to clear unread badges, etc. */
  onScrollToBottom?: () => void;
}

/** Distance (px) from the bottom within which the transcript stays pinned to the latest message. */
const BOTTOM_THRESHOLD_PX = 200;

/**
 * Scrollable chat transcript with stick-to-bottom behaviour.
 *
 * Auto-scrolls to the newest message whenever `messages` changes, unless the
 * user has scrolled up more than 200px from the bottom. While unpinned a
 * "jump to latest" button is shown; activating it re-pins and scrolls down.
 */
export function ChatTranscript({ messages, onScrollToBottom }: ChatTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = distanceFromBottom <= BOTTOM_THRESHOLD_PX;
    if (pinnedRef.current !== next) {
      pinnedRef.current = next;
      setPinned(next);
    }
  };

  // Keep the view pinned to the newest content while pinned. Runs on every
  // messages update — including streaming token bursts.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    pinnedRef.current = true;
    setPinned(true);
    onScrollToBottom?.();
  };

  const showJumpButton = !pinned && messages.length > 0;

  return (
    <div
      ref={scrollRef}
      className="chat-transcript"
      role="log"
      aria-live="polite"
      aria-label="Chat transcript"
      onScroll={handleScroll}
      tabIndex={0}
    >
      <div className="chat-transcript-inner">
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            role={message.role}
            content={message.content}
            isStreaming={message.isStreaming}
            stopped={message.stopped}
            timestamp={message.timestamp}
          />
        ))}
      </div>
      {showJumpButton && (
        <button
          type="button"
          className="chat-jump-bottom"
          data-testid="chat-transcript-jump-bottom"
          aria-label="Jump to latest message"
          onClick={jumpToBottom}
        >
          <ArrowDown size={14} strokeWidth={2.5} aria-hidden="true" />
          <span>Jump to latest</span>
        </button>
      )}
    </div>
  );
}
