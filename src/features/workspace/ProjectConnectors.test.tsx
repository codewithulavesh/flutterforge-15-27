// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectConnectors } from './ProjectConnectors';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/agent/engineClient', () => ({ engineerRequest: request }));
afterEach(() => { cleanup(); request.mockReset(); });

it('syncs a repository and sends the saved revision on disconnect', async () => {
  const snapshot = { kind: 'github', resource: 'flutter/flutter', revision: 'r1', syncedAt: '2026-11-19T00:00:00Z', metadata: { Language: 'Dart' } };
  request.mockResolvedValueOnce([]).mockResolvedValueOnce([snapshot]).mockResolvedValueOnce([]);
  const user = userEvent.setup();
  render(<ProjectConnectors projectId="counter" />);
  const card = within(screen.getByRole('heading', { name: 'GitHub' }).closest('article')!);
  await card.findByText('Disconnected');
  await user.type(card.getByRole('textbox', { name: 'Public repository' }), 'flutter/flutter');
  await user.click(card.getByRole('button', { name: 'Connect' }));
  expect(request).toHaveBeenCalledWith('counter', 'connectors', { action: 'sync', expectedRevision: null, kind: 'github', resource: 'flutter/flutter' }, expect.anything());
  expect(await card.findByText('Dart')).toBeTruthy();
  await user.click(card.getByRole('button', { name: 'Disconnect' }));
  expect(request).toHaveBeenCalledWith('counter', 'connectors', { action: 'disconnect', expectedRevision: 'r1', kind: 'github' }, expect.anything());
  expect(await card.findByText('Disconnected')).toBeTruthy();
});
