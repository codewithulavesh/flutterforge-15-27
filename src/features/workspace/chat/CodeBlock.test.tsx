// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeBlock } from './CodeBlock';

function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CodeBlock', () => {
  it('copies the code to the clipboard and shows checkmark feedback, then reverts after 1.6s', async () => {
    vi.useFakeTimers();
    const writeText = mockClipboard();

    render(<CodeBlock code="const answer = 42;" language="ts" />);

    const copyButton = screen.getByTestId('chat-codeblock-copy');
    expect(copyButton).toHaveAttribute('aria-label', 'Copy code');

    fireEvent.click(copyButton);
    // Flush the async clipboard write.
    await act(async () => {});

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('const answer = 42;');
    expect(copyButton).toHaveAttribute('aria-label', 'Copied to clipboard');
    expect(copyButton).toHaveAttribute('data-copied', 'true');

    // Feedback reverts after 1.6s.
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(copyButton).toHaveAttribute('aria-label', 'Copy code');
    expect(copyButton).not.toHaveAttribute('data-copied');
  });

  it('toggles word wrap with aria-pressed and changes the code pane whitespace', () => {
    mockClipboard();
    const { container } = render(<CodeBlock code="echo wrap me" language="bash" />);

    const wrapButton = screen.getByTestId('chat-codeblock-wrap');
    const pre = container.querySelector('.chat-codeblock-code');
    expect(pre).not.toBeNull();

    expect(wrapButton).toHaveAttribute('aria-pressed', 'false');
    expect(pre).toHaveStyle({ whiteSpace: 'pre' });

    fireEvent.click(wrapButton);
    expect(wrapButton).toHaveAttribute('aria-pressed', 'true');
    expect(pre).toHaveStyle({ whiteSpace: 'pre-wrap' });

    fireEvent.click(wrapButton);
    expect(wrapButton).toHaveAttribute('aria-pressed', 'false');
    expect(pre).toHaveStyle({ whiteSpace: 'pre' });
  });

  it('renders one gutter line per source line', () => {
    mockClipboard();
    const code = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n');
    render(<CodeBlock code={code} language="dart" />);

    const gutterLines = screen.getAllByTestId('chat-codeblock-gutter-line');
    expect(gutterLines).toHaveLength(30);
    expect(gutterLines[0]).toHaveTextContent('1');
    expect(gutterLines[29]).toHaveTextContent('30');
  });

  it('shows the filename when provided', () => {
    mockClipboard();
    render(<CodeBlock code="void main() {}" language="dart" filename="lib/main.dart" />);

    expect(screen.getByText('lib/main.dart')).toBeInTheDocument();
    expect(screen.getByText('dart')).toBeInTheDocument();
  });

  it('renders code verbatim without injecting HTML', () => {
    mockClipboard();
    const payload = '<img src=x onerror=alert(1) />';
    const { container } = render(<CodeBlock code={payload} language="html" />);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(payload)).toBeInTheDocument();
  });
});
