import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { BuildBreak } from './BuildBreak';

afterEach(cleanup);

it('keeps the puzzle playable across build updates and resets on a new game', async () => {
  const user = userEvent.setup();
  const view = render(<BuildBreak activity="Checking source" />);
  await user.click(screen.getByRole('button', { name: 'Play a game' }));
  const tiles = screen.getAllByRole<HTMLButtonElement>('button', { name: /^Tile / });
  expect(tiles).toHaveLength(8);
  await user.click(tiles.find(tile => !tile.disabled)!);
  view.rerender(<BuildBreak activity="Running tests" />);
  expect(screen.getByText('1 move')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Close game' }));
  await user.click(screen.getByRole('button', { name: 'Play a game' }));
  expect(screen.getByText('1 move')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'New game' }));
  expect(screen.getByText('0 moves')).toBeTruthy();
});
