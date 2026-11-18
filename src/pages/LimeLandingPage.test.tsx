import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { HERO_PROMPT_KEY } from '@/utils/landing';
import { LimeLandingPage } from './LimeLandingPage';
import App from '@/App';

vi.mock('@/services/supabase', () => ({ isSupabaseConfigured: false, supabase: null }));

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  useAuthStore.setState({ session: null, user: null, initialized: true });
  sessionStorage.clear();
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
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Destination() {
  const location = useLocation();
  return <output aria-label="Destination">{location.pathname}: {location.state?.heroPrompt}</output>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<LimeLandingPage />} />
        <Route path="/signup" element={<Destination />} />
        <Route path="/dashboard" element={<Destination />} />
        <Route path="/agents" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Homepage', () => {
  it.each(['/', '/landing-v2'])('shows the new design at the canonical home URL when entering %s', async (path) => {
    window.history.replaceState({}, '', path);
    render(<App />);
    expect(await screen.findByRole('navigation', { name: 'Landing navigation' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByRole('link', { name: 'Landing 2' })).not.toBeInTheDocument();
  });

  it('links navigation to current sections without retired-homepage links', () => {
    renderPage();
    const nav = screen.getByRole('navigation', { name: 'Landing navigation' });
    expect(within(nav).getByRole('link', { name: 'Questions' })).toHaveAttribute('href', '#lv-questions');
    for (const link of screen.getAllByRole('link')) {
      const href = link.getAttribute('href');
      if (href?.startsWith('#')) expect(document.querySelector(href)).not.toBeNull();
      expect(href).not.toBe('/#pricing');
    }
    expect(screen.queryByRole('link', { name: /original|Landing 2/i })).not.toBeInTheDocument();
  });

  it.each(['Landing navigation', 'Quick navigation'])('opens the Agents page from %s', async (navigation) => {
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe(target: Element) {
        if (target.matches('.lv-header')) this.callback([{ isIntersecting: false }]);
      }
      unobserve() {}
      disconnect() {}
    });
    const user = userEvent.setup();
    renderPage();
    const nav = screen.getByRole('navigation', { name: navigation });
    const agents = within(nav).getByRole('link', { name: 'Agents' });
    expect(agents).toHaveAttribute('href', '/agents');
    await user.click(agents);
    expect(screen.getByLabelText('Destination')).toHaveTextContent('/agents');
  });

  it('updates the Pro monthly equivalent and annual total when billing changes', async () => {
    const user = userEvent.setup();
    renderPage();
    const pro = screen.getByRole('article', { name: 'Pro plan' });
    expect(pro).toHaveTextContent('₹1,999');
    await user.click(screen.getByRole('button', { name: 'Yearly' }));
    expect(pro).toHaveTextContent('₹1,599');
    expect(pro).toHaveTextContent('₹19,188 billed yearly');
    expect(screen.getByRole('button', { name: 'Yearly' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('article', { name: 'Free plan' })).toHaveTextContent('Free');
    await user.click(screen.getByRole('button', { name: 'Monthly' }));
    expect(pro).toHaveTextContent('₹1,999');
    expect(pro).not.toHaveTextContent('₹19,188 billed yearly');
  });

  it('carries a trimmed app idea through signup in navigation state and session storage', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByRole('textbox', { name: 'Your app idea' }), '  Build a meal planner with a grocery list  ');
    await user.click(screen.getByRole('button', { name: 'Make it real' }));
    expect(screen.getByLabelText('Destination')).toHaveTextContent('/signup: Build a meal planner with a grocery list');
    expect(sessionStorage.getItem(HERO_PROMPT_KEY)).toBe('Build a meal planner with a grocery list');
  });

  it('keeps a whitespace-only idea on the page and explains what to enter', () => {
    renderPage();
    fireEvent.change(screen.getByRole('textbox', { name: 'Your app idea' }), { target: { value: '   ' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Start with an idea' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Describe the app you want to build.');
    expect(screen.queryByLabelText('Destination')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(HERO_PROMPT_KEY)).toBeNull();
  });

  it('still forwards the idea if browser storage is blocked', async () => {
    const user = userEvent.setup();
    renderPage();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage blocked', 'SecurityError'); });
    await user.type(screen.getByRole('textbox', { name: 'Your app idea' }), 'Build a running log');
    await user.click(screen.getByRole('button', { name: 'Make it real' }));
    expect(screen.getByLabelText('Destination')).toHaveTextContent('/signup: Build a running log');
  });

  it('sends signed-in builders to their dashboard instead of signup', async () => {
    useAuthStore.setState({ session: {
      access_token: 'local-test', refresh_token: 'local-test', expires_in: 3600, token_type: 'bearer',
      user: { id: 'test-builder', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-11-18T00:00:00Z' },
    } });
    const user = userEvent.setup();
    renderPage();
    expect(screen.getAllByRole('link', { name: /Open studio/i })[0]).toHaveAttribute('href', '/dashboard');
    await user.type(screen.getByRole('textbox', { name: 'Your app idea' }), 'Build a workout timer');
    await user.click(screen.getByRole('button', { name: 'Make it real' }));
    expect(screen.getByLabelText('Destination')).toHaveTextContent('/dashboard: Build a workout timer');
  });
});
