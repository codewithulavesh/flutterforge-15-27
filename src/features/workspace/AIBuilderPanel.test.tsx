// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AIBuilderPanel } from './AIBuilderPanel';
import { useTerminalStore } from '@/stores/terminal.store';
import { useActivityStore } from '@/stores/activity.store';

const { projectState, sendMessageMock } = vi.hoisted(() => {
  const sendMessageMock = vi.fn();
  return {
    sendMessageMock,
    projectState: {
      messages: [],
      sendMessage: sendMessageMock,
      currentProject: { id: 'project-1', name: 'Demo', description: 'A sample project.' },
      conversation: null,
      files: [],
      repairBuild: vi.fn(),
      stopRepair: vi.fn(),
      newConversation: vi.fn(),
      generatingIn: null,
    },
  };
});

vi.mock('./EngineerControls', () => ({ EngineerControls: () => <section aria-label="Engineer execution controls" /> }));

vi.mock('@/stores/project.store', () => {
  // Zustand-compatible stand-in: callable as a hook (with or without a
  // selector) plus the statics the panel uses (setState/getState).
  const useProjectStore = ((selector?: (state: typeof projectState) => unknown) => (
    typeof selector === 'function' ? selector(projectState) : projectState
  )) as unknown as {
    (selector?: (state: typeof projectState) => unknown): unknown;
    setState: (partial: unknown | ((state: typeof projectState) => Record<string, unknown>)) => void;
    getState: () => typeof projectState;
    subscribe: (listener: (state: typeof projectState) => void) => () => void;
  };
  useProjectStore.setState = (partial) => {
    const next = (typeof partial === 'function' ? partial(projectState) : partial) as Record<string, unknown>;
    Object.assign(projectState, next);
  };
  useProjectStore.getState = () => projectState;
  useProjectStore.subscribe = () => () => {};
  return { useProjectStore };
});
vi.mock('@/stores/workspace.store', () => ({
  useWorkspaceStore: () => ({ openFile: vi.fn(), activeFile: null }),
}));
vi.mock('@/stores/preview.store', () => ({
  usePreviewStore: () => ({ getSession: vi.fn(() => null) }),
}));
vi.mock('@/agent/chatContext', () => ({
  ChatContextHandler: { build: () => ({
    summary: 'A sample project.',
    fileCount: 0,
    screenCount: 0,
    backend: 'local',
    history: [],
    tokenEstimate: 10,
    activeFile: null,
  }) },
}));
vi.mock('@/components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('@/components/BrandLogo', () => ({ BrandLogo: () => <span>Logo</span> }));
vi.mock('@/features/workspace/AgentActivityPopover', () => ({ AgentActivityPopover: () => null }));
vi.mock('@/components/ui/Dropdown', () => ({
  Dropdown: ({ trigger, children }: { trigger: React.ReactNode; children: React.ReactNode }) => <>{trigger}{children}</>,
  DropdownItem: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-state">{JSON.stringify(location.state ?? {})}</output>;
}

// jsdom's ResizeObserver reports entries without borderBoxSize, which crashes
// Radix's useSize (entry.borderBoxSize[0].inlineSize). Stub it with a no-op.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  writable: true,
  value: NoopResizeObserver,
});

describe('AIBuilderPanel realtime chat', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    sendMessageMock.mockReset();
    projectState.messages = [];
    projectState.conversation = null;
    useTerminalStore.setState({
      isGenerating: false,
      isAnswering: false,
      currentPhase: null,
      generationError: null,
      lines: [],
      liveFiles: [],
    });
    useActivityStore.getState().clear();
  });

  afterEach(() => {
    cleanup();
    useActivityStore.getState().clear();
    useTerminalStore.setState({ isAnswering: false, isGenerating: false, currentPhase: null, generationError: null });
  });

  it('renders chat tokens before the send request finishes', async () => {
    let finishRequest: ((result: { mode: 'chat' }) => void) | undefined;
    sendMessageMock.mockImplementation((_projectId, _content, _progress, options) => {
      options.onToken('The answer is arriving ');
      return new Promise((resolve) => { finishRequest = resolve; });
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <AIBuilderPanel variant="page" />
      </MemoryRouter>,
    );

    await user.type(screen.getByPlaceholderText('Ask about the project, or describe what to build next…'), 'How does this project work?');
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(await screen.findByText('The answer is arriving')).toBeTruthy();
    expect(sendMessageMock).toHaveBeenCalledOnce();
    finishRequest?.({ mode: 'chat' });
    await waitFor(() => expect(useTerminalStore.getState().isAnswering).toBe(false));
  });

  it('starter suggestions populate an editable request without silently executing it', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><AIBuilderPanel variant="page" /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: 'Review this project' }));
    expect((screen.getByRole('textbox', { name: 'Message your AI engineer' }) as HTMLTextAreaElement).value).toContain('Inspect the existing code');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

describe('AIBuilderPanel retry and wizard handoff', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    sendMessageMock.mockReset();
    sendMessageMock.mockResolvedValue({ mode: 'generation', fileCount: 2, verified: true } as never);
    projectState.messages = [];
    projectState.files = [];
    projectState.conversation = { id: 'conv-1', project_id: 'project-1' } as never;
    localStorage.setItem('openrouter_api_key', 'test-key');
    useTerminalStore.setState({ lines: [], isGenerating: false, isAnswering: false, generationError: null });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('retries a generated project as a targeted repair, never a full rebuild', async () => {
    projectState.messages = [
      { id: 'm1', role: 'user', content: 'Build a habit tracker' },
      { id: 'm2', role: 'assistant', content: 'Generated the app' },
    ] as never;
    projectState.files = [{ path: 'lib/main.dart', content: 'void main() {}' }] as never;

    render(<MemoryRouter><AIBuilderPanel variant="page" /></MemoryRouter>);
    window.dispatchEvent(new Event('ff:retry-last'));

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledOnce());
    const options = sendMessageMock.mock.calls[0][3];
    expect(options.isRepair).toBe(true);
    expect(options.isInitialGeneration).toBe(false);
    expect(options.repairRound).toBe(1);
    expect(options.autoRepairBuild).toBe(true);
  });

  it('consumes the wizard handoff once for a brand-new project and clears route state', async () => {
    localStorage.setItem('ff-handoff:project-1', 'Build a habit tracker');

    render(
      <MemoryRouter initialEntries={[{ pathname: '/project/project-1', state: { richPrompt: 'Build a habit tracker' } }]}>
        <AIBuilderPanel variant="page" />
        <LocationProbe />
      </MemoryRouter>,
    );

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledOnce(), { timeout: 2000 });
    expect(sendMessageMock.mock.calls[0][3].isInitialGeneration).toBe(true);
    expect(localStorage.getItem('ff-handoff:project-1')).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('location-state').textContent).not.toContain('richPrompt');
    });
  });

  it('never auto-starts a handoff over an existing conversation with files', async () => {
    localStorage.setItem('ff-handoff:project-1', 'Build a habit tracker');
    projectState.messages = [{ id: 'm1', role: 'user', content: 'Build a habit tracker' }] as never;
    projectState.files = [{ path: 'lib/main.dart', content: 'void main() {}' }] as never;

    render(<MemoryRouter><AIBuilderPanel variant="page" /></MemoryRouter>);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('ff-handoff:project-1')).toBeNull();
  });
});
describe('AIBuilderPanel stop, keyboard and accessibility', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    sendMessageMock.mockReset();
    projectState.messages = [];
    projectState.files = [];
    projectState.conversation = { id: 'conv-1', project_id: 'project-1' } as never;
    localStorage.setItem('openrouter_api_key', 'test-key');
    useTerminalStore.setState({
      isGenerating: false,
      isAnswering: false,
      currentPhase: null,
      generationError: null,
      lines: [],
      liveFiles: [],
    });
    useActivityStore.getState().clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    useTerminalStore.setState({ isAnswering: false, isGenerating: false, currentPhase: null, generationError: null });
  });

  it('shows Stop only while streaming, cancels the request and retains the partial reply', async () => {
    sendMessageMock.mockImplementation((_projectId, _content, _progress, options) => {
      options.onToken('The answer is arriving ');
      return new Promise(() => {});
    });
    const user = userEvent.setup();

    render(<MemoryRouter><AIBuilderPanel variant="page" /></MemoryRouter>);

    // Idle: no stop control at all, only the submit control.
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    const textarea = screen.getByPlaceholderText('Ask about the project, or describe what to build next…');
    await user.type(textarea, 'How does this project work?');
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    // While the stream is in flight the stop control is visible and focusable.
    const stop = await screen.findByRole('button', { name: 'Stop' });
    expect(stop).toBeTruthy();
    stop.focus();
    expect(document.activeElement).toBe(stop);
    expect(await screen.findByText('The answer is arriving')).toBeTruthy();

    await user.click(stop);

    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(useTerminalStore.getState().isAnswering).toBe(false);
    expect(useTerminalStore.getState().isGenerating).toBe(false);

    // Cancellation retains streamed text visibly rather than inventing a completed reply.
    expect(screen.getByText('The answer is arriving')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Stopped');
    expect(sendMessageMock.mock.calls[0][3].signal.aborted).toBe(true);
  });

  it('sends on Enter and treats Shift+Enter as a newline, not a send', async () => {
    sendMessageMock.mockResolvedValue({ mode: 'chat' } as never);
    const user = userEvent.setup();

    render(<MemoryRouter><AIBuilderPanel variant="page" /></MemoryRouter>);
    const textarea = screen.getByPlaceholderText('Ask about the project, or describe what to build next…') as HTMLTextAreaElement;

    await user.type(textarea, 'first line{Shift>}{Enter}{/Shift}second line');
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(textarea.value).toContain('\n');

    await user.type(textarea, '{Enter}');
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledOnce());
    const content = sendMessageMock.mock.calls[0][1] as string;
    expect(content).toContain('first line');
    expect(content).toContain('second line');
  });

  it('closes an open popover or dialog with Escape', async () => {
    const user = userEvent.setup();

    render(<MemoryRouter><AIBuilderPanel variant="page" /></MemoryRouter>);

    // Panel-owned dialog (Escape handled by the panel's keydown listener).
    await user.click(screen.getByRole('button', { name: 'Manage agent capability skills' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Radix menu (Escape handled natively by the primitive).
    await user.click(screen.getByRole('button', { name: 'Attach a project file' }));
    expect(await screen.findByText('No project files yet.')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('No project files yet.')).toBeNull());
  });

  it('gives every icon-only button an accessible name', () => {
    projectState.messages = [
      { id: 'm1', role: 'user', content: 'Build a habit tracker' },
      {
        id: 'm2',
        role: 'assistant',
        content: 'Generated the app',
        tool_calls: null,
        changed_files: null,
        metadata: {},
        created_at: new Date().toISOString(),
      },
    ] as never;
    projectState.files = [{ path: 'pubspec.yaml', content: 'name: demo', is_directory: false }] as never;

    render(<MemoryRouter><AIBuilderPanel variant="page" /></MemoryRouter>);

    const buttons = screen.getAllByRole('button');
    const iconOnly = buttons.filter((button) => (button.textContent ?? '').trim().length === 0);
    expect(iconOnly.length).toBeGreaterThan(0);
    for (const button of iconOnly) {
      const label = button.getAttribute('aria-label') ?? '';
      expect(
        label.length,
        `icon-only button is missing an accessible name: ${button.outerHTML.slice(0, 160)}`,
      ).toBeGreaterThan(0);
    }
  });

  it('retries with the last USER message, never the assistant reply', async () => {
    sendMessageMock.mockResolvedValue({ mode: 'generation', fileCount: 1, verified: true } as never);
    projectState.messages = [
      { id: 'm1', role: 'user', content: 'USER_SENTINEL build a habit tracker' },
      { id: 'm2', role: 'assistant', content: 'ASSISTANT_SENTINEL generated everything' },
      { id: 'm3', role: 'user', content: 'USER_SENTINEL add dark mode' },
      { id: 'm4', role: 'assistant', content: 'ASSISTANT_SENTINEL dark mode shipped' },
    ] as never;
    projectState.files = [{ path: 'lib/main.dart', content: 'void main() {}' }] as never;

    render(<MemoryRouter><AIBuilderPanel variant="page" /></MemoryRouter>);
    window.dispatchEvent(new Event('ff:retry-last'));

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledOnce());
    const content = sendMessageMock.mock.calls[0][1] as string;
    expect(content).toBe('USER_SENTINEL add dark mode');
    expect(content).not.toContain('ASSISTANT_SENTINEL');
  });
});
