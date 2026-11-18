import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { HERO_PROMPT_KEY } from '@/utils/landing';
import { AgentsLandingPage } from './AgentsLandingPage';

vi.mock('@/services/supabase', () => ({ isSupabaseConfigured: false, supabase: null }));

beforeEach(() => {
  useAuthStore.setState({ session: null, user: null, initialized: true });
  sessionStorage.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduced-motion'), media: query,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
  }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe(target: Element) {
      if (target.matches('.agents-header')) this.callback([{ isIntersecting: false }]);
    }
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

function Destination() {
  const location = useLocation();
  return <output aria-label="Destination">{location.pathname}: {location.state?.heroPrompt}</output>;
}

function renderPage() {
  return render(<MemoryRouter initialEntries={['/agents']}><Routes>
    <Route path="/agents" element={<AgentsLandingPage />} />
    <Route path="/" element={<Destination />} />
    <Route path="/signup" element={<Destination />} />
    <Route path="/dashboard" element={<Destination />} />
  </Routes></MemoryRouter>);
}

describe('Agents landing page', () => {
  it.each(['Agents navigation', 'Agents quick navigation'])('keeps home and section destinations reachable from %s', async name => {
    const user = userEvent.setup();
    renderPage();
    const nav = screen.getByRole('navigation', { name });
    expect(within(nav).getByRole('link', { name: 'Agents' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Prompts' })).toHaveAttribute('href', '#prompts');
    expect(within(nav).getByRole('link', { name: 'Plans' })).toHaveAttribute('href', '#pricing');
    for (const link of screen.getAllByRole('link')) {
      const href = link.getAttribute('href');
      if (href?.startsWith('#')) expect(document.querySelector(href)).not.toBeNull();
    }
    await user.click(within(nav).getByRole('link', { name: 'Home' }));
    expect(screen.getByLabelText('Destination')).toHaveTextContent('/');
  });

  it('moves a complete library prompt into the focused builder field', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Use prompt: Rename the app to/ }));
    const input = screen.getByRole('textbox', { name: 'Describe the app you want to build' });
    expect(input).toHaveValue('Rename the app to "Orbit" everywhere - app title, splash text, settings, empty states and the README.');
    expect(input).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Build this app' }));
    expect(screen.getByLabelText('Destination')).toHaveTextContent('/signup: Rename the app to "Orbit" everywhere');
  });

  it('keeps blank prompts from navigating and trims a valid brief', async () => {
    const user = userEvent.setup();
    renderPage();
    const input = screen.getByRole('textbox', { name: 'Describe the app you want to build' });
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Build this app' })).toBeDisabled();
    expect(sessionStorage.getItem(HERO_PROMPT_KEY)).toBeNull();
    fireEvent.change(input, { target: { value: '  Build a daily journal  ' } });
    await user.click(screen.getByRole('button', { name: 'Build this app' }));
    expect(screen.getByLabelText('Destination')).toHaveTextContent('/signup: Build a daily journal');
    expect(sessionStorage.getItem(HERO_PROMPT_KEY)).toBe('Build a daily journal');
  });

  it('keeps navigation state when storage is blocked', async () => {
    const user = userEvent.setup();
    renderPage();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
    await user.click(screen.getByRole('button', { name: 'Personal finance' }));
    await user.click(screen.getByRole('button', { name: 'Build this app' }));
    expect(screen.getByLabelText('Destination')).toHaveTextContent('/signup: Build a personal finance app with category budgets, a monthly spending chart, and recurring bills.');
  });

  it('opens the dashboard for an authenticated builder', async () => {
    useAuthStore.setState({ session: {
      access_token: 'local-test', refresh_token: 'local-test', expires_in: 3600, token_type: 'bearer',
      user: { id: 'test-builder', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-11-18T00:00:00Z' },
    } });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Recipe planner' }));
    await user.click(screen.getByRole('button', { name: 'Build this app' }));
    expect(screen.getByLabelText('Destination')).toHaveTextContent('/dashboard: Create a recipe planner');
  });

  it('keeps source and build views keyboard accessible', async () => {
    const user = userEvent.setup();
    renderPage();
    screen.getByRole('tab', { name: 'Preview' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Source' })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent("import 'package:flutter/material.dart'");
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Build log' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Illustration of the repair loop, not a live build.');
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Preview' })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Morning run');
  });
});
