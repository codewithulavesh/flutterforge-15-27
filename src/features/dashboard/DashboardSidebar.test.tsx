// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarProvider } from '@/components/ui/sidebar';
import { DashboardSidebar } from './DashboardSidebar';
import type { Project } from '@/types';

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: vi.fn(() => ({
    profile: {
      id: 'user-1',
      email: 'rai@example.com',
      full_name: 'Rai Bhai',
      avatar_url: null,
      plan: 'free',
      created_at: '',
      updated_at: '',
    },
    signOut: vi.fn(),
  })),
}));

vi.mock('@/stores/credits.store', () => ({
  useCreditsStore: vi.fn(() => ({
    wallet: {
      user_id: 'user-1',
      balance: 100,
      monthly_allowance: 100,
      lifetime_used: 0,
      lifetime_purchased: 0,
      cycle_id: '2026-11',
      plan: 'free',
      created_at: '',
      updated_at: '',
    },
    refresh: vi.fn(),
  })),
}));

vi.mock('@/stores/theme.store', () => ({
  useThemeStore: vi.fn(() => ({ theme: 'dark', toggle: vi.fn() })),
}));

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

function renderSidebar(overrides: Partial<Parameters<typeof DashboardSidebar>[0]> = {}) {
  const handlers = {
    onEditProfile: vi.fn(),
    onNewProject: vi.fn(),
    onOpenIntegrations: vi.fn(),
    onOpenPricing: vi.fn(),
    onOpenShortcuts: vi.fn(),
    onOpenUsage: vi.fn(),
    onShowDeployments: vi.fn(),
    onShowProjects: vi.fn(),
  };
  const view = render(
    <MemoryRouter>
      <SidebarProvider>
        <DashboardSidebar
          projects={PROJECTS}
          scope="deployed"
          searching={false}
          sortBy="updated"
          {...handlers}
          {...overrides}
        />
      </SidebarProvider>
    </MemoryRouter>,
  );
  return { ...view, handlers };
}

describe('DashboardSidebar sections', () => {
  afterEach(() => cleanup());

  it('renders the Platform, Workspace and Account groups', () => {
    renderSidebar();

    for (const label of ['Platform', 'Workspace', 'Account']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    for (const label of ['Usage & credits', 'Deployments', 'Integrations', 'Edit profile', 'Keyboard shortcuts', 'Support', "What's new"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('opens the account and workspace dialogs from the sidebar', async () => {
    const user = userEvent.setup();
    const { handlers } = renderSidebar();

    await user.click(screen.getByRole('button', { name: 'Edit profile' }));
    await user.click(screen.getByRole('button', { name: /^Usage & credits/ }));
    await user.click(screen.getByRole('button', { name: 'Integrations' }));
    await user.click(screen.getByRole('button', { name: /^Keyboard shortcuts/ }));

    expect(handlers.onEditProfile).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenUsage).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenIntegrations).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenShortcuts).toHaveBeenCalledTimes(1);
  });

  it('marks Deployments active and surfaces deployed counts and credits', () => {
    const { container } = renderSidebar();

    const active = container.querySelector('[data-active="true"]');
    expect(active?.textContent).toContain('Deployments');
    expect(screen.getByText('100')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('links Support and What’s new to the public repo', () => {
    renderSidebar();

    expect(screen.getByRole('link', { name: 'Support' }).getAttribute('href')).toBe(
      'https://github.com/codewithulavesh/flutterforge/issues',
    );
    expect(screen.getByRole('link', { name: "What's new" }).getAttribute('href')).toBe(
      'https://github.com/codewithulavesh/flutterforge/releases',
    );
  });
});
