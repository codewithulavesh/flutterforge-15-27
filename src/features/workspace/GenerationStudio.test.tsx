// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenerationStudio } from './GenerationStudio';
import {
  stopPolling,
  useGenerationStore,
  type AppSpec,
  type GenerationRun,
  type GenerationRunEvent,
  type GenerationRunStatus,
  type QualityReport,
  type SpecValidation,
} from '@/stores/generation.store';

const NOW = Date.now();

function makeSpec(overrides: Partial<AppSpec> = {}): AppSpec {
  const base: AppSpec = {
    version: 1,
    app: {
      name: 'Trail Notes',
      packageName: 'trail_notes',
      tagline: 'Field notes for the long way round.',
      description:
        'A calm note-taking app for hikers with offline drafts, pinned trips and trail search.',
      domain: 'travel',
    },
    audience: { primary: 'Hikers and backpackers' },
    entities: [
      {
        name: 'TrailNote',
        plural: 'trail_notes',
        description: 'A written observation captured on a trail.',
        fields: [
          { name: 'title', type: 'string', required: true, primary: true },
          { name: 'body', type: 'text', required: false },
          { name: 'pinned', type: 'bool', required: false },
        ],
      },
      {
        name: 'Trip',
        plural: 'trips',
        description: 'A multi-day journey that groups trail notes.',
        fields: [
          { name: 'name', type: 'string', required: true, primary: true },
          { name: 'startedAt', type: 'datetime', required: true },
          { name: 'status', type: 'enum', required: true, values: ['planned', 'active', 'done'] },
        ],
      },
    ],
    screens: [
      {
        id: 'trail_notes',
        title: 'Trail notes',
        route: '/notes',
        kind: 'list',
        purpose: 'Browse and search every note captured on the trail.',
        entity: 'TrailNote',
        primaryAction: 'New note',
        inNavigation: true,
      },
      {
        id: 'note_detail',
        title: 'Note detail',
        route: '/notes/:id',
        kind: 'detail',
        purpose: 'Read a note with its photos and trip context.',
        entity: 'TrailNote',
      },
      {
        id: 'note_form',
        title: 'New note',
        route: '/notes/new',
        kind: 'form',
        purpose: 'Capture a titled note, body and pin state.',
        entity: 'TrailNote',
        primaryAction: 'Save note',
      },
      {
        id: 'trips',
        title: 'Trips',
        route: '/trips',
        kind: 'dashboard',
        purpose: 'Track planned, active and completed journeys.',
        entity: 'Trip',
        inNavigation: true,
      },
      {
        id: 'settings',
        title: 'Settings',
        route: '/settings',
        kind: 'settings',
        purpose: 'Theme, offline storage and about information.',
        inNavigation: true,
      },
    ],
    flows: [
      {
        id: 'capture-note',
        name: 'Capture a trail note',
        steps: [
          { screenId: 'trail_notes', action: 'Open the note list' },
          { screenId: 'note_form', action: 'Create a note' },
          { screenId: 'note_detail', action: 'Review the saved note' },
        ],
      },
    ],
    design: {
      seedColor: '#26bac1',
      brightness: 'dark',
      spacing: [4, 8, 12, 16, 24],
      radii: { sm: 8, md: 12, lg: 16, xl: 24 },
      motionMs: 220,
      shape: 'soft',
    },
    requirements: [],
    backend: 'local',
    seedCount: 6,
  };
  return { ...base, ...overrides };
}

function makeQuality(overrides: Partial<QualityReport> = {}): QualityReport {
  const base: QualityReport = {
    total: 91,
    grade: 'A',
    categories: {
      architecture: 92,
      completeness: 90,
      design: 93,
      accessibility: 88,
      reliability: 91,
      testability: 89,
      performance: 94,
    },
    findings: [
      {
        category: 'accessibility',
        severity: 'warning',
        code: 'A11Y_ICON_LABEL',
        message: 'Two icon buttons need accessible labels.',
        path: 'lib/features/trail_notes/trail_notes_page.dart',
      },
      {
        category: 'design',
        severity: 'info',
        code: 'DESIGN_SCALE',
        message: 'Spacing scale is applied consistently.',
      },
      {
        category: 'reliability',
        severity: 'error',
        code: 'NULL_GUARD',
        message: 'One repository call lacks an error branch.',
      },
    ],
    stats: { files: 42, bytes: 310 * 1024, lines: 4_200, screens: 5, entities: 2, tests: 6 },
    generatedAt: NOW - 60_000,
  };
  return { ...base, ...overrides };
}

function makeRun(overrides: Partial<GenerationRun> = {}): GenerationRun {
  return {
    id: 'run_gen_01',
    definition: 'prompt.to.app',
    definitionVersion: 1,
    status: 'running',
    projectId: 'project-1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeEvent(
  seq: number,
  type: string,
  data: Record<string, unknown> = {},
): GenerationRunEvent {
  return { seq, type, data, createdAt: NOW + seq * 1_000 };
}

interface BuildCall {
  url: string;
  method: string;
  body: unknown;
}

interface RouterState {
  spec: AppSpec;
  validation: SpecValidation;
  failSpec: 'reject' | string | null;
  run: GenerationRun;
  runStatuses: GenerationRunStatus[];
  pollIndex: number;
  events: GenerationRunEvent[];
  quality: QualityReport | null;
  buildCalls: BuildCall[];
}

function makeRouter(state: RouterState) {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const parseBody = (): unknown => (init?.body ? JSON.parse(String(init.body)) : undefined);

    if (method === 'POST' && url === '/api/platform/generation/spec') {
      if (state.failSpec === 'reject') throw new Error('spec compiler offline');
      if (state.failSpec) {
        return json({ error: { code: 'COMPILER_DOWN', message: state.failSpec } }, 500);
      }
      return json({ ok: true, spec: state.spec, validation: state.validation });
    }

    if (method === 'POST' && url === '/api/platform/generation/build') {
      state.buildCalls.push({ url, method, body: parseBody() });
      return json({ ok: true, run: { ...state.run, status: 'running' } }, 202);
    }

    if (method === 'GET' && /^\/api\/platform\/workflows\/runs\/[^/]+$/.test(url)) {
      const status =
        state.runStatuses[Math.min(state.pollIndex, state.runStatuses.length - 1)] ?? 'running';
      state.pollIndex += 1;
      return json({ ok: true, run: { ...state.run, status } });
    }

    if (method === 'GET' && url.endsWith('/events')) {
      return json({ ok: true, events: state.events });
    }

    if (method === 'GET' && url.startsWith('/api/platform/generation/quality')) {
      if (!state.quality) {
        return json({ error: { code: 'NOT_FOUND', message: 'No quality report yet.' } }, 404);
      }
      return json({ ok: true, report: state.quality });
    }

    if (method === 'GET' && url === '/api/platform/generation/benchmarks') {
      return json({
        ok: true,
        benchmarks: [
          { id: 'notes', prompt: 'A calm note-taking app for hikers.', minScreens: 4 },
          { id: 'habits', prompt: 'A habit tracker with streaks and reviews.', minScreens: 4 },
        ],
      });
    }

    return json(
      { error: { code: 'NOT_FOUND', message: `Unmocked route: ${method} ${url}` } },
      404,
    );
  });
}

let state: RouterState;
let fetchMock: ReturnType<typeof makeRouter>;

async function flush(turns = 15): Promise<void> {
  await act(async () => {
    for (let index = 0; index < turns; index += 1) {
      await Promise.resolve();
    }
  });
}

beforeEach(() => {
  stopPolling();
  useGenerationStore.getState().reset();
  useGenerationStore.setState({
    benchmarks: [],
    benchmarksError: null,
    loadingBenchmarks: false,
  });
  state = {
    spec: makeSpec(),
    validation: { ok: true, errors: [] },
    failSpec: null,
    run: makeRun(),
    runStatuses: ['succeeded'],
    pollIndex: 0,
    events: [],
    quality: null,
    buildCalls: [],
  };
  fetchMock = makeRouter(state);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  stopPolling();
  useGenerationStore.getState().reset();
});

describe('GenerationStudio', () => {
  it('compiles a brief and renders the app spec with entity and screen counts', async () => {
    const user = userEvent.setup();
    render(<GenerationStudio projectId="project-1" />);

    await user.type(
      screen.getByLabelText('App brief'),
      'A calm trail journal for hikers with offline photos and pinned trips.',
    );
    await user.click(screen.getByRole('button', { name: 'Compile spec' }));

    expect(await screen.findByText('Trail Notes')).toBeInTheDocument();
    expect(screen.getByText('Field notes for the long way round.')).toBeInTheDocument();
    expect(screen.getByLabelText('2 entities')).toBeInTheDocument();
    expect(screen.getByLabelText('5 screens')).toBeInTheDocument();
    expect(screen.getByLabelText('1 flows')).toBeInTheDocument();
    expect(screen.getByLabelText('Entity TrailNote')).toBeInTheDocument();
    expect(screen.getByText('Validated')).toBeInTheDocument();

    const specCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === '/api/platform/generation/spec' && init?.method === 'POST',
    );
    expect(specCall).toBeDefined();
    const body = JSON.parse(String(specCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      prompt: 'A calm trail journal for hikers with offline photos and pinned trips.',
      backend: 'local',
      seedColor: '#26bac1',
    });
    expect(body).not.toHaveProperty('domain');
    expect(body).not.toHaveProperty('appName');
  });

  it('forges, posts the right body, streams run events and lands the quality report', async () => {
    vi.useFakeTimers();
    state.runStatuses = ['running', 'succeeded'];
    state.events = [makeEvent(1, 'app.spec', { appName: 'Trail Notes', entities: 2, screens: 5 })];

    render(<GenerationStudio projectId="project-1" />);
    await flush();

    const prompt = 'A calm trail journal for hikers with offline photos and pinned trips.';
    // fireEvent (not userEvent) keeps fake timers from starving userEvent's own
    // timer-driven typing loop while a setInterval poll is active.
    fireEvent.change(screen.getByLabelText('App brief'), { target: { value: prompt } });
    fireEvent.click(screen.getByRole('button', { name: 'Forge app' }));
    await flush(20);

    expect(state.buildCalls).toHaveLength(1);
    expect(state.buildCalls[0]).toMatchObject({
      url: '/api/platform/generation/build',
      method: 'POST',
      body: {
        projectId: 'project-1',
        prompt,
        target: 'web',
        minQuality: 80,
      },
    });
    expect(screen.getByText('Spec compiled')).toBeInTheDocument();
    expect(screen.getByText('Live · polling every 2s')).toBeInTheDocument();

    // The next poll settles the run and publishes the scored report.
    state.events = [
      makeEvent(1, 'app.spec', { appName: 'Trail Notes', entities: 2, screens: 5 }),
      makeEvent(2, 'app.emitted', { fileCount: 42, bytes: 310 * 1024 }),
      makeEvent(3, 'app.scored', { total: 91, grade: 'A' }),
      makeEvent(4, 'app.verified', { errorCount: 0, warningCount: 2 }),
      makeEvent(5, 'app.sealed', { fileCount: 42 }),
    ];
    state.quality = makeQuality();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flush(25);

    expect(
      screen.getByLabelText('Quality score 91 out of 100, grade A'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Architecture score')).toHaveAttribute(
      'aria-valuenow',
      '92',
    );
    expect(screen.getByText('Quality scored')).toBeInTheDocument();
    expect(screen.getByText('Workspace sealed')).toBeInTheDocument();
    expect(screen.getAllByText('Sealed').length).toBeGreaterThan(0);
  });

  it('surfaces a failed fetch as human text with a retry action and does not crash', async () => {
    state.failSpec = 'reject';
    const user = userEvent.setup();
    render(<GenerationStudio projectId="project-1" />);

    await user.type(screen.getByLabelText('App brief'), 'A trail journal for hikers.');
    await user.click(screen.getByRole('button', { name: 'Compile spec' }));

    expect(await screen.findByText('spec compiler offline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry compile' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Generation studio' })).toBeInTheDocument();
    expect(screen.getByLabelText('App brief')).toBeInTheDocument();
  });

  it('disables Forge without a prompt and while a run is active', async () => {
    state.runStatuses = ['running'];
    const user = userEvent.setup();
    render(<GenerationStudio projectId="project-1" />);

    const forgeButton = screen.getByRole('button', { name: 'Forge app' });
    expect(forgeButton).toBeDisabled();

    await user.type(screen.getByLabelText('App brief'), 'A trail journal for hikers.');
    expect(forgeButton).toBeEnabled();

    await user.click(forgeButton);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Forge app' })).toBeDisabled(),
    );
    expect(screen.getAllByText('Running').length).toBeGreaterThan(0);
  });

  it('fills the brief from an example chip', async () => {
    const user = userEvent.setup();
    render(<GenerationStudio projectId="project-1" />);

    await user.click(screen.getByRole('button', { name: 'Use Notes example brief' }));

    const textarea = screen.getByLabelText('App brief') as HTMLTextAreaElement;
    expect(textarea.value).toContain('note-taking app for hikers');
    expect(screen.getByRole('button', { name: 'Use Notes example brief' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
