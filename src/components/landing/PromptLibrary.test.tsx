import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PromptLibrary } from './PromptLibrary';

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduced-motion'), media: query,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
  }));
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, 'execCommand'); });

function PromptHarness() {
  const [prompt, setPrompt] = useState('');
  return <><PromptLibrary onUsePrompt={setPrompt} /><output aria-label="Selected prompt">{prompt}</output></>;
}

describe('Prompt library', () => {
  it('provides category navigation to each actual section', () => {
    render(<PromptHarness />);
    const navigation = screen.getByRole('navigation', { name: 'Explore what you can build' });
    const links = within(navigation).getAllByRole('link');
    expect(links).toHaveLength(5);
    expect(links[0]).toHaveAttribute('href', '#update');
    for (const link of links) {
      const section = document.querySelector(link.getAttribute('href')!);
      expect(section).not.toBeNull();
      expect(section?.querySelector('h2')).not.toBeNull();
    }
  });

  it('uses the full prompt rather than its visual truncation', async () => {
    const user = userEvent.setup();
    render(<PromptHarness />);
    await user.click(screen.getByRole('button', { name: /Use prompt: Rename the app to/ }));
    expect(screen.getByLabelText('Selected prompt')).toHaveTextContent(
      'Rename the app to "Orbit" everywhere - app title, splash text, settings, empty states and the README.',
    );
  });

  it('copies the complete prompt and announces completion', async () => {
    const user = userEvent.setup();
    render(<PromptHarness />);
    await user.click(screen.getByRole('button', { name: /Copy prompt: Rename the app to/ }));
    expect(await navigator.clipboard.readText()).toBe(
      'Rename the app to "Orbit" everywhere - app title, splash text, settings, empty states and the README.',
    );
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Prompt copied to clipboard.');
  });

  it('restores keyboard focus after the clipboard fallback', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Clipboard blocked'));
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => true });
    render(<PromptHarness />);
    const button = screen.getByRole('button', { name: /Copy prompt: Rename the app to/ });
    await user.click(button);
    expect(button).toHaveFocus();
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Prompt copied to clipboard.');
    Reflect.deleteProperty(document, 'execCommand');
  });

  it('keeps demos paused for reduced motion and allows explicit playback', async () => {
    const user = userEvent.setup();
    render(<PromptHarness />);
    const play = screen.getByRole('button', { name: 'Play Update the app demo' });
    await user.click(play);
    const pause = screen.getByRole('button', { name: 'Pause Update the app demo' });
    expect(pause).toBeInTheDocument();
    await user.click(pause);
    expect(screen.getByRole('button', { name: 'Play Update the app demo' })).toBeInTheDocument();
  });
});
