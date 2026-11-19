import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { EngineerPreviewPanel } from './EngineerPreviewPanel';

const { request, refresh } = vi.hoisted(() => ({ request: vi.fn(), refresh: vi.fn() }));
vi.mock('@/agent/engineClient', () => ({ engineerRequest: request }));
vi.mock('./useEngineerSession', () => ({ useEngineerSession: () => ({
  state: { status: 'completed', preview: { status: 'running', url: 'http://localhost:6000/app/v1/' } },
  events: [], refresh,
}) }));
vi.mock('@/stores/workspace.store', () => ({ useWorkspaceStore: () => ({ setActiveView: vi.fn() }) }));
vi.mock('@/stores/project.store', () => ({ useProjectStore: () => ({
  currentProject: { id: 'p', name: 'Demo' }, files: [{ path: 'lib/main.dart' }, { path: 'pubspec.yaml' }],
}) }));
afterEach(cleanup);

it('changes device, orientation and zoom without reloading, then compiles the current source', async () => {
  render(<EngineerPreviewPanel />);
  const user = userEvent.setup();
  const frame = screen.getByTitle('Running Flutter application');
  expect(screen.getByText('1 Dart file')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'mobile preview' }));
  await user.click(screen.getByRole('button', { name: 'Rotate device' }));
  expect(frame.parentElement?.className).toContain('studio-landscape');
  await user.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(frame.style.transform).toBe('scale(1.1)');
  await user.click(screen.getByRole('button', { name: 'Reset zoom' }));
  expect(frame.style.transform).toBe('scale(1)');
  await user.click(screen.getByRole('button', { name: 'Compile' }));
  expect(request).toHaveBeenCalledWith('p', 'build', {});
  expect(refresh).toHaveBeenCalled();
  expect(screen.getByTitle('Running Flutter application')).toBe(frame);
  await user.click(screen.getByRole('button', { name: 'Refresh preview' }));
  expect(screen.getByTitle('Running Flutter application')).not.toBe(frame);
});
