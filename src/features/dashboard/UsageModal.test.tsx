// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageModal } from './UsageModal';

vi.mock('@/stores/credits.store', () => ({
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
    refresh: vi.fn(),
    loadEvents: vi.fn(),
  })),
}));

describe('UsageModal', () => {
  afterEach(() => cleanup());

  it('shows the plan balance and recent credit activity', () => {
    render(<UsageModal open onClose={vi.fn()} onOpenPricing={vi.fn()} />);

    expect(screen.getByText('420')).toBeTruthy();
    expect(screen.getByText('Pro plan')).toBeTruthy();
    expect(screen.getByText('Generated ShopFlow')).toBeTruthy();
    expect(screen.getByText('-4')).toBeTruthy();
  });

  it('hands plan management back to the dashboard', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onOpenPricing = vi.fn();

    render(<UsageModal open onClose={onClose} onOpenPricing={onOpenPricing} />);
    await user.click(screen.getByRole('button', { name: /Manage plan/i }));

    expect(onClose).toHaveBeenCalled();
    expect(onOpenPricing).toHaveBeenCalled();
  });
});
