import { useEffect, useRef, useState } from 'react';
import { Check, Copy, FileCode2, WrapText } from 'lucide-react';
import './chat.css';

export interface CodeBlockProps {
  /** Language label shown in the header (e.g. "tsx", "dart"). */
  language?: string;
  /** Raw source code. Rendered verbatim inside <pre><code>; never as HTML. */
  code: string;
  /** Optional filename shown next to the language label. */
  filename?: string;
  /** Max height of the scrollable code pane in px. Defaults to 400. */
  maxHeight?: number;
}

const COPY_FEEDBACK_MS = 1600;

/**
 * Copy to clipboard with a legacy fallback (textarea + execCommand) for
 * contexts where the async Clipboard API is unavailable or denied.
 * Returns whether the copy likely succeeded.
 */
async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    throw new Error('Clipboard API unavailable');
  } catch {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.top = '0';
      textarea.style.left = '0';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const succeeded = document.execCommand('copy');
      document.body.removeChild(textarea);
      return succeeded;
    } catch {
      return false;
    }
  }
}

/**
 * Monospace code block with a line-number gutter, copy-to-clipboard and a
 * word-wrap toggle. No syntax highlighting — the rendering stays honest and
 * dependency-free; rich highlighting is a caller-side concern.
 */
export function CodeBlock({ language, code, filename, maxHeight = 400 }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending "copied" reset on unmount so setState never lands on a
  // dead component.
  useEffect(
    () => () => {
      if (feedbackTimer.current !== null) {
        clearTimeout(feedbackTimer.current);
      }
    },
    [],
  );

  const lines = code.split('\n');

  const handleCopy = async () => {
    const succeeded = await writeToClipboard(code);
    if (!succeeded) return;
    setCopied(true);
    if (feedbackTimer.current !== null) {
      clearTimeout(feedbackTimer.current);
    }
    feedbackTimer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  };

  const languageLabel = language?.trim() || 'code';

  return (
    <div className="chat-codeblock">
      <div className="chat-codeblock-header">
        <div className="chat-codeblock-heading">
          <FileCode2 size={14} aria-hidden="true" className="chat-codeblock-heading-icon" />
          <span className="chat-codeblock-lang">{languageLabel}</span>
          {filename && (
            <span className="chat-codeblock-filename" title={filename}>
              {filename}
            </span>
          )}
        </div>
        <div className="chat-codeblock-actions">
          <button
            type="button"
            className="chat-codeblock-btn"
            data-testid="chat-codeblock-copy"
            data-copied={copied || undefined}
            aria-label={copied ? 'Copied to clipboard' : 'Copy code'}
            onClick={handleCopy}
          >
            {copied ? (
              <Check size={13} strokeWidth={3} aria-hidden="true" />
            ) : (
              <Copy size={13} aria-hidden="true" />
            )}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <button
            type="button"
            className="chat-codeblock-btn"
            data-testid="chat-codeblock-wrap"
            aria-pressed={wrapped}
            aria-label={wrapped ? 'Disable word wrap' : 'Enable word wrap'}
            onClick={() => setWrapped((value) => !value)}
          >
            <WrapText size={13} aria-hidden="true" />
            <span>Wrap</span>
          </button>
        </div>
      </div>
      <div
        className={`chat-codeblock-scroll${wrapped ? ' chat-codeblock--wrapped' : ''}`}
        style={{ maxHeight: `${maxHeight}px` }}
      >
        <div className="chat-codeblock-inner">
          <div className="chat-codeblock-gutter" aria-hidden="true">
            {lines.map((_, index) => (
              <span
                key={index}
                className="chat-codeblock-gutter-line"
                data-testid="chat-codeblock-gutter-line"
              >
                {index + 1}
              </span>
            ))}
          </div>
          <pre className="chat-codeblock-code" style={{ whiteSpace: wrapped ? 'pre-wrap' : 'pre' }}>
            <code>{code}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}
