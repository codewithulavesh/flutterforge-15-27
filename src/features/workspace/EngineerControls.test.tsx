import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { EngineerControls } from './EngineerControls';
const { request, stream } = vi.hoisted(() => ({ request: vi.fn(), stream: vi.fn() }));
vi.mock('@/agent/engineClient', () => ({ engineerRequest: request, streamEngineerEvents: stream, EngineerRequestError: class extends Error {} }));
const approval = { threadId: 't', runId: 'r', status: 'awaiting_approval', changedFiles: [], approval: { id: 'approval-1', reason: 'Delete a source file', calls: [{ name: 'delete_file', args: { path: 'old.dart' } }] } };
describe('engine collaboration controls', () => {
  beforeEach(() => { request.mockReset(); request.mockImplementation(async () => approval); stream.mockImplementation(async (_id, _cursor, _callback, signal) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))); });
  afterEach(cleanup);
  it('submits the exact pending approval and an explicit rejection', async () => {
    render(<EngineerControls projectId="p" />); const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('p', 'resume', { approvalId: 'approval-1', approved: false }));
  });
  it('preserves an instruction when submission fails', async () => {
    request.mockImplementation(async (_id, operation) => { if (operation === 'instruction') throw new Error('Network unavailable'); return approval; });
    render(<EngineerControls projectId="p" />); const user = userEvent.setup();
    const input = await screen.findByRole('textbox', { name: 'Additional instructions' });
    await user.type(input, 'Keep the existing screen'); await user.click(screen.getByRole('button', { name: /^Send$/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Network unavailable'); expect((input as HTMLInputElement).value).toBe('Keep the existing screen');
  });
});
