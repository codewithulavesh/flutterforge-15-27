// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
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

function renderSidebar(initialEntry = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SidebarProvider>
        <DashboardSidebar
          onNewProject={vi.fn()}
          onOpenPricing={vi.fn()}
          projects={PROJECTS}
        />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

describe('DashboardSidebar navigation', () => {
  afterEach(() => cleanup());

  it('renders the Platform, Workspace and Account groups', () => {
    renderSidebar();

    for (const label of ['Platform', 'Workspace', 'Account']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    for (const label of [
      'Usage & credits',
      'Deployments',
      'Integrations',
      'Edit profile',
      'Keyboard shortcuts',
      'Support',
      "What's new",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('links each section to its own dashboard route', () => {
    renderSidebar();

    expect(screen.getByRole('link', { name: /^All projects$/ }).getAttribute('href')).toBe('/dashboard');
    expect(screen.getByRole('link', { name: /^Recent$/ }).getAttribute('href')).toBe(
      '/dashboard?sort=created',
    );
    expect(screen.getByRole('link', { name: /^Deployments/ }).getAttribute('href')).toBe(
      '/dashboard/deployments',
    );
    expect(screen.getByRole('link', { name: /^Usage & credits/ }).getAttribute('href')).toBe(
      '/dashboard/usage',
    );
    expect(screen.getByRole('link', { name: 'Integrations' }).getAttribute('href')).toBe(
      '/dashboard/integrations',
    );
    expect(screen.getByRole('link', { name: /^Edit profile/ }).getAttribute('href')).toBe(
      '/dashboard/profile',
    );
    expect(screen.getByRole('link', { name: /^Keyboard shortcuts/ }).getAttribute('href')).toBe(
      '/dashboard/shortcuts',
    );
  });

  it('marks the current section active from the URL', () => {
    const { container } = renderSidebar('/dashboard/deployments');

    const activeRows = [...container.querySelectorAll('[data-active="true"]')].map((row) =>
      row.textContent?.trim(),
    );
    expect(activeRows.some((label) => label?.includes('Deployments'))).toBe(true);
  });

  it('distinguishes All projects from Recent in the sidebar', () => {
    const all = renderSidebar('/dashboard');
    expect(all.container.querySelector('[aria-current="page"]')?.textContent).toContain('All projects');
    all.unmount();

    const recent = renderSidebar('/dashboard?sort=created');
    expect(recent.container.querySelector('[aria-current="page"]')?.textContent).toContain('Recent');
  });

  it('surfaces credit and deployment counts', () => {
    renderSidebar();

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
