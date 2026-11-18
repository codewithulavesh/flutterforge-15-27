import { RotateCcw, TriangleAlert, X } from 'lucide-react';
import './chat.css';

export interface ErrorBannerProps {
  /** Human-readable error description. */
  message: string;
  /** When provided, renders a primary "Retry" button. Focus is left to the caller. */
  onRetry?: () => void;
  /** When provided, renders a dismiss button (accessible name: "Dismiss error"). */
  onDismiss?: () => void;
}

/**
 * Full-width tinted error banner for chat-level failures (send errors, stream
 * aborts, provider outages). Announces itself via role="alert".
 * Deliberately NOT autofocused — the caller owns focus management.
 */
export function ErrorBanner({ message, onRetry, onDismiss }: ErrorBannerProps) {
  return (
    <div className="chat-error-banner" role="alert">
      <TriangleAlert size={18} strokeWidth={2.25} className="chat-error-icon" aria-hidden="true" />
      <p className="chat-error-message">{message}</p>
      <div className="chat-error-actions">
        {onRetry && (
          <button type="button" className="chat-btn chat-btn--primary" onClick={onRetry}>
            <RotateCcw size={13} strokeWidth={2.5} aria-hidden="true" />
            <span>Retry</span>
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            className="chat-btn chat-btn--ghost"
            onClick={onDismiss}
            aria-label="Dismiss error"
          >
            <X size={14} strokeWidth={2.5} aria-hidden="true" />
            <span>Dismiss</span>
          </button>
        )}
      </div>
    </div>
  );
}
