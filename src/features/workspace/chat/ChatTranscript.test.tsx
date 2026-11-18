// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatTranscript, type TranscriptMessage } from './ChatTranscript';

afterEach(() => cleanup());

function makeMessages(count: number): TranscriptMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Message number ${index + 1}`,
    timestamp: Date.UTC(2026, 10, 18, 10, index),
  }));
}

/**
 * jsdom has no layout, so scroll metrics are zero by default. Tests install
 * explicit metrics on the scroll container to exercise the pin/unpin logic.
 */
function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    value: metrics.clientHeight,
  });
  element.scrollTop = metrics.scrollTop;
}

describe('ChatTranscript', () => {
  it('renders every message passed to it', () => {
    render(<ChatTranscript messages={makeMessages(4)} />);

    expect(screen.getByText('Message number 1')).toBeInTheDocument();
    expect(screen.getByText('Message number 2')).toBeInTheDocument();
    expect(screen.getByText('Message number 3')).toBeInTheDocument();
    expect(screen.getByText('Message number 4')).toBeInTheDocument();
  });

  it('exposes a polite live region with role="log"', () => {
    render(<ChatTranscript messages={makeMessages(1)} />);

    const log = screen.getByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(log).toHaveAttribute('aria-label', 'Chat transcript');
  });

  it('renders system messages with the dashed full-width style', () => {
    render(
      <ChatTranscript
        messages={[{ id: 'sys-1', role: 'system', content: 'Build finished in 4.2s' }]}
      />,
    );

    const system = screen.getByTestId('chat-message-system');
    expect(system).toBeInTheDocument();
    expect(screen.getByText('Build finished in 4.2s')).toBeInTheDocument();
  });

  it('marks streaming assistant messages as busy and generating', () => {
    render(
      <ChatTranscript
        messages={[{ id: 'a-1', role: 'assistant', content: '', isStreaming: true }]}
      />,
    );

    const article = screen.getByTestId('chat-message-assistant');
    expect(article).toHaveAttribute('aria-busy', 'true');
    expect(article).toHaveAttribute('aria-label', expect.stringContaining('generating'));
  });

  it('shows the jump-to-latest button after scrolling up, keeps it when messages arrive, and hides it after clicking', () => {
    const onScrollToBottom = vi.fn();
    const initial = makeMessages(2);
    const { rerender } = render(
      <ChatTranscript messages={initial} onScrollToBottom={onScrollToBottom} />,
    );

    const log = screen.getByRole('log');

    // Pinned at mount → no button.
    expect(screen.queryByTestId('chat-transcript-jump-bottom')).not.toBeInTheDocument();

    // Simulate a 1000px tall log with a 200px viewport, scrolled to the top
    // (800px away from the bottom → beyond the 200px threshold).
    setScrollMetrics(log, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    fireEvent.scroll(log);

    expect(screen.getByTestId('chat-transcript-jump-bottom')).toBeInTheDocument();

    // New message arrives while unpinned → button stays visible.
    rerender(
      <ChatTranscript
        messages={[...initial, { id: 'msg-3', role: 'assistant', content: 'Late arrival' }]}
        onScrollToBottom={onScrollToBottom}
      />,
    );
    expect(screen.getByTestId('chat-transcript-jump-bottom')).toBeInTheDocument();

    // Clicking re-pins, scrolls to the bottom and hides the button.
    fireEvent.click(screen.getByTestId('chat-transcript-jump-bottom'));

    expect(onScrollToBottom).toHaveBeenCalledTimes(1);
    expect(log.scrollTop).toBe(log.scrollHeight);
    expect(screen.queryByTestId('chat-transcript-jump-bottom')).not.toBeInTheDocument();
  });

  it('stays pinned to the bottom on new messages when not scrolled up', () => {
    const { rerender } = render(<ChatTranscript messages={makeMessages(2)} />);
    const log = screen.getByRole('log');

    setScrollMetrics(log, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });
    fireEvent.scroll(log);
    expect(screen.queryByTestId('chat-transcript-jump-bottom')).not.toBeInTheDocument();

    rerender(<ChatTranscript messages={makeMessages(3)} />);
    expect(log.scrollTop).toBe(log.scrollHeight);
    expect(screen.queryByTestId('chat-transcript-jump-bottom')).not.toBeInTheDocument();
  });
});
