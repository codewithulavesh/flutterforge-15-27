// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentsSection } from './DeploymentsSection';
import { ProfileSection } from './ProfileSection';
import { SettingsSection } from './SettingsSection';
import { ShortcutsSection } from './ShortcutsSection';
import { UsageSection } from './UsageSection';
import { AgentsSection } from './AgentsSection';
import { BillingSection } from './BillingSection';
import type { Project } from '@/types';

const {
  updateProfileMock,
  resetPasswordMock,
  signOutMock,
  refreshMock,
  loadEventsMock,
  setThemeMock,
  toastMock,
} = vi.hoisted(() => ({
  updateProfileMock: vi.fn(),
  resetPasswordMock: vi.fn(),
  signOutMock: vi.fn(),
  refreshMock: vi.fn(),
  loadEventsMock: vi.fn(),
  setThemeMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: vi.fn(() => ({
    profile: {
      id: 'user-1',
      email: 'rai@example.com',
      full_name: 'Rai Bhai',
      avatar_url: null,
      plan: 'pro',
      created_at: '2026-01-10T00:00:00Z',
      updated_at: '2026-11-01T00:00:00Z',
    },
    updateProfile: updateProfileMock,
    resetPassword: resetPasswordMock,
    signOut: signOutMock,
  })),
}));

vi.mock('@/stores/credits.store', () => ({
  CREDIT_PACKS: [
    { id: 'pro', plan: 'pro', label: 'Pro', credits: 1000, pricePaise: 199900 },
    { id: 'team', plan: 'team', label: 'Team', credits: 5000, pricePaise: 499900 },
  ],
  useCreditsStore: vi.fn(() => ({
    wallet: {
      user_id: 'user-1',
      balance: 420,
      monthly_allowance: 1000,
      lifetime_used: 580,
      lifetime_purchased: 0,
      cycle_id: '2026-11',
      plan: 'pro',
      created_at: '',
      updated_at: '',
    },
    events: [
      {
        id: 'e1',
        kind: 'spend',
        label: 'Generated ShopFlow',
        amount: -4,
        model: 'openrouter/auto',
        balance_after: 420,
        created_at: '2026-11-14T10:00:00Z',
      },
    ],
    loading: false,
    error: null,
    refresh: refreshMock,
    loadEvents: loadEventsMock,
  })),
}));

vi.mock('@/stores/theme.store', () => ({
  useThemeStore: vi.fn(() => ({
    theme: 'dark',
    setTheme: setThemeMock,
    toggle: vi.fn(),
  })),
}));

vi.mock('@/components/ui/Toast', () => ({ toast: toastMock }));

const PROJECTS: Project[] = [
  {
    id: 'p1',
    user_id: 'user-1',
    name: 'ShopFlow',
    description: 'Commerce app',
    template: 'blank',
    status: 'deployed',
    flutter_version: '3.24.0',
    state_management: 'provider',
    theme_mode: 'dark',
    platform: 'web',
    config: {},
    preview_url: null,
    deployment_url: 'https://shopflow.example.com',
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-10T00:00:00Z',
  },
  {
    id: 'p2',
    user_id: 'user-1',
    name: 'Draft',
    description: null,
    template: 'blank',
    status: 'created',
    flutter_version: '3.24.0',
    state_management: 'provider',
    theme_mode: 'dark',
    platform: 'web',
    config: {},
    preview_url: null,
    deployment_url: null,
    created_at: '2026-11-02T00:00:00Z',
    updated_at: '2026-11-11T00:00:00Z',
  },
];

function renderInRouter(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

beforeEach(() => {
  updateProfileMock.mockReset();
  resetPasswordMock.mockReset();
  signOutMock.mockReset();
  refreshMock.mockReset();
  loadEventsMock.mockReset();
  setThemeMock.mockReset();
  toastMock.mockReset();

  // The embedded pricing block animates cards into view with motion.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
});

afterEach(() => cleanup());

describe('DeploymentsSection', () => {
  it('lists only deployed apps with workspace and live links', () => {
    renderInRouter(<DeploymentsSection loading={false} onNewProject={vi.fn()} projects={PROJECTS} />);

    expect(screen.getAllByText('ShopFlow').length).toBeGreaterThan(0);
    expect(screen.queryByText('Draft')).toBeNull();
    expect(screen.getByRole('link', { name: 'shopflow.example.com' }).getAttribute('href')).toBe(
      'https://shopflow.example.com',
    );
    expect(screen.getByRole('link', { name: /Open/ }).getAttribute('href')).toBe('/project/p1');
    expect(screen.getAllByText('Deployed apps').length).toBeGreaterThan(0);
  });

  it('shows an empty state when nothing is deployed', () => {
    renderInRouter(
      <DeploymentsSection
        loading={false}
        onNewProject={vi.fn()}
        projects={PROJECTS.filter((project) => project.id === 'p2')}
      />,
    );

    expect(screen.getByText('Nothing shipped yet')).toBeTruthy();
  });
});

describe('UsageSection', () => {
  it('shows the balance, plan and recent credit activity', () => {
    render(<UsageSection onOpenBilling={vi.fn()} />);

    expect(screen.getAllByText('420').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Pro plan').length).toBeGreaterThan(0);
    expect(screen.getByText('Generated ShopFlow')).toBeTruthy();
    expect(screen.getByText('-4')).toBeTruthy();
    expect(refreshMock).toHaveBeenCalled();
    expect(loadEventsMock).toHaveBeenCalledWith(20);
  });

  it('hands plan management to the embedded billing page', async () => {
    const user = userEvent.setup();
    const onOpenBilling = vi.fn();
    render(<UsageSection onOpenBilling={onOpenBilling} />);

    await user.click(screen.getByRole('button', { name: /Manage subscription/i }));
    expect(onOpenBilling).toHaveBeenCalled();
  });
});

describe('ProfileSection', () => {
  it('saves the display name and avatar', async () => {
    updateProfileMock.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    render(<ProfileSection onSignOut={vi.fn()} />);

    const name = screen.getByLabelText('Display name');
    await user.clear(name);
    await user.type(name, 'Rai B');
    await user.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() =>
      expect(updateProfileMock).toHaveBeenCalledWith({ full_name: 'Rai B', avatar_url: null }),
    );
    expect(toastMock).toHaveBeenCalledWith('success', 'Profile updated');
  });

  it('rejects an invalid avatar URL without saving', async () => {
    const user = userEvent.setup();
    render(<ProfileSection onSignOut={vi.fn()} />);

    await user.type(screen.getByLabelText('Avatar URL'), 'not-a-url');
    await user.click(screen.getByRole('button', { name: /Save changes/i }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Enter a valid image URL, or leave it blank.',
    );
    expect(updateProfileMock).not.toHaveBeenCalled();
  });

  it('sends a password reset email', async () => {
    resetPasswordMock.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    render(<ProfileSection onSignOut={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Send password reset email/i }));
    expect(resetPasswordMock).toHaveBeenCalledWith('rai@example.com');
    expect(toastMock).toHaveBeenCalledWith('success', 'Password reset link sent to rai@example.com');
  });
});

describe('SettingsSection', () => {
  it('switches the dashboard theme', async () => {
    const user = userEvent.setup();
    renderInRouter(
      <SettingsSection onOpenBilling={vi.fn()} onSignOut={vi.fn()} projects={PROJECTS} />,
    );

    await user.click(screen.getByRole('button', { name: /^Light/ }));
    expect(setThemeMock).toHaveBeenCalledWith('light');
  });

  it('shows plan billing controls and signs out', async () => {
    const user = userEvent.setup();
    const onOpenBilling = vi.fn();
    const onSignOut = vi.fn();
    renderInRouter(
      <SettingsSection onOpenBilling={onOpenBilling} onSignOut={onSignOut} projects={PROJECTS} />,
    );

    expect(screen.getByText('credits remaining')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Manage subscription/i }));
    expect(onOpenBilling).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Sign out/i }));
    expect(onSignOut).toHaveBeenCalled();
  });
});

describe('ShortcutsSection', () => {
  it('lists dashboard and workspace shortcuts', () => {
    render(<ShortcutsSection />);

    expect(screen.getByText('Dashboard', { selector: 'h2' })).toBeTruthy();
    expect(screen.getByText('Workspace', { selector: 'h2' })).toBeTruthy();
    expect(screen.getByText('Focus project search')).toBeTruthy();
    expect(screen.getAllByText('Open the command palette').length).toBeGreaterThan(0);
  });
});

describe('AgentsSection', () => {
  it('opens the wizard with a typed brief', async () => {
    const user = userEvent.setup();
    const onNewProject = vi.fn();
    render(<AgentsSection onNewProject={onNewProject} />);

    await user.type(
      screen.getByLabelText('Describe the app you want to build'),
      'A habit tracker with streaks',
    );
    await user.click(screen.getByRole('button', { name: /Build this app/i }));

    expect(onNewProject).toHaveBeenCalledWith('A habit tracker with streaks');
  });

  it('starts from a prompt library entry', async () => {
    const user = userEvent.setup();
    const onNewProject = vi.fn();
    render(<AgentsSection onNewProject={onNewProject} />);

    await user.click(screen.getByRole('button', { name: /Rename the app to "Orbit"/i }));

    expect(onNewProject).toHaveBeenCalledWith(expect.stringContaining('Rename the app to "Orbit"'));
  });
});

describe('BillingSection', () => {
  it('shows the current plan and keeps plan changes inside the dashboard', () => {
    renderInRouter(<BillingSection />);

    expect(screen.getByText('Compare plans')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Current plan/i })).toHaveProperty('disabled', true);
    expect(screen.getByRole('link', { name: 'Free plan' }).getAttribute('href')).toBe('/dashboard');
  });
});
