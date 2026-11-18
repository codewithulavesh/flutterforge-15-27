// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsSection } from './ProjectsSection';
import type { Project } from '@/types';

const { deleteProjectMock, duplicateProjectMock, updateProjectMock } = vi.hoisted(() => ({
  deleteProjectMock: vi.fn(),
  duplicateProjectMock: vi.fn(),
  updateProjectMock: vi.fn(),
}));

vi.mock('@/stores/project.store', () => ({
  useProjectStore: Object.assign(
    vi.fn(() => ({
      deleteProject: deleteProjectMock,
      duplicateProject: duplicateProjectMock,
      updateProject: updateProjectMock,
    })),
    { getState: () => ({ error: null }) },
  ),
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

function renderSection({
  projects = PROJECTS,
  loading = false,
  onNewProject = vi.fn(),
}: {
  projects?: Project[];
  loading?: boolean;
  onNewProject?: () => void;
} = {}) {
  render(
    <MemoryRouter>
      <ProjectsSection
        firstName="Rai"
        loading={loading}
        onNewProject={onNewProject}
        projects={projects}
      />
    </MemoryRouter>,
  );
  return { onNewProject };
}

describe('ProjectsSection create card', () => {
  beforeEach(() => {
    deleteProjectMock.mockReset();
    duplicateProjectMock.mockReset();
    updateProjectMock.mockReset();
  });

  afterEach(() => cleanup());

  it('renders Create new app as the first card in the project grid', () => {
    renderSection();

    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings[0]).toHaveTextContent('Create new app');
    expect(headings[1]).toHaveTextContent('Draft');
    expect(headings[2]).toHaveTextContent('ShopFlow');
  });

  it('opens the project wizard from the create card', async () => {
    const user = userEvent.setup();
    const { onNewProject } = renderSection();

    await user.click(screen.getByRole('button', { name: /Create new app/i }));

    expect(onNewProject).toHaveBeenCalledTimes(1);
  });

  it('keeps the create card out of active search results', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.type(screen.getByLabelText('Search projects'), 'Shop');

    expect(screen.queryByRole('button', { name: /Create new app/i })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('ShopFlow');
  });

  it('keeps the first-app empty state when there are no projects', async () => {
    const user = userEvent.setup();
    const { onNewProject } = renderSection({ projects: [] });

    expect(screen.queryByRole('button', { name: /Create new app/i })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your first forge' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create your first app' }));
    expect(onNewProject).toHaveBeenCalledTimes(1);
  });
});
