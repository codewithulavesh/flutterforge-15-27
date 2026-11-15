// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditProfileModal } from './EditProfileModal';

const { updateProfileMock, toastMock } = vi.hoisted(() => ({
  updateProfileMock: vi.fn(),
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
      created_at: '',
      updated_at: '',
    },
    updateProfile: updateProfileMock,
  })),
}));

vi.mock('@/components/ui/Toast', () => ({ toast: toastMock }));

describe('EditProfileModal', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    updateProfileMock.mockReset();
    toastMock.mockReset();
  });

  it('saves the display name and clears an empty avatar', async () => {
    updateProfileMock.mockResolvedValueOnce({ error: null });
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<EditProfileModal open onClose={onClose} />);

    const name = screen.getByLabelText('Display name');
    await user.clear(name);
    await user.type(name, 'Rai B');
    await user.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() =>
      expect(updateProfileMock).toHaveBeenCalledWith({ full_name: 'Rai B', avatar_url: null }),
    );
    expect(onClose).toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith('success', 'Profile updated');
  });

  it('rejects an invalid avatar URL without saving', async () => {
    const user = userEvent.setup();
    render(<EditProfileModal open onClose={vi.fn()} />);

    await user.type(screen.getByLabelText('Avatar URL'), 'not-a-url');
    await user.click(screen.getByRole('button', { name: /Save changes/i }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Enter a valid image URL, or leave it blank.',
    );
    expect(updateProfileMock).not.toHaveBeenCalled();
  });

  it('shows the store error and keeps the dialog open', async () => {
    updateProfileMock.mockResolvedValueOnce({ error: 'Row level security blocked the update.' });
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<EditProfileModal open onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: /Save changes/i }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Row level security blocked the update.',
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
