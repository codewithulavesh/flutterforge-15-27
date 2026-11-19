import { useState } from 'react';
import { Gamepad2, RotateCcw, X } from 'lucide-react';

const ordered = [1, 2, 3, 4, 5, 6, 7, 8, 0];
function adjacent(a: number, b: number) {
  return Math.abs(a % 3 - b % 3) + Math.abs(Math.floor(a / 3) - Math.floor(b / 3)) === 1;
}
function shuffle() {
  const board = [...ordered];
  let gap = 8, previous = -1;
  // Shuffle using legal moves so every starting position has a solution.
  for (let i = 0; i < 17; i++) {
    const choices = board.map((_, index) => index).filter(index => index !== previous && adjacent(index, gap));
    const next = choices[Math.floor(Math.random() * choices.length)];
    [board[next], board[gap]] = [board[gap], board[next]];
    previous = gap; gap = next;
  }
  return board;
}

export function BuildBreak({ activity }: { activity: string }) {
  const [open, setOpen] = useState(false);
  const [board, setBoard] = useState(shuffle);
  const [moves, setMoves] = useState(0);
  const solved = board.every((tile, index) => tile === ordered[index]);
  const gap = board.indexOf(0);
  const moveCount = `${moves} ${moves === 1 ? 'move' : 'moves'}`;
  function move(index: number) {
    if (solved || !adjacent(index, gap)) return;
    const next = [...board];
    [next[index], next[gap]] = [next[gap], next[index]];
    setBoard(next); setMoves(count => count + 1);
  }
  return <aside className="studio-build-break" aria-label="Build activity">
    <div className="studio-build-strip"><span className="studio-build-dot" /><span className="studio-build-activity" role="status">{activity}</span>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <X size={15} /> : <Gamepad2 size={16} />}{open ? 'Close game' : 'Play a game'}</button>
    </div>
    {open && <div className="studio-puzzle"><div><h3>Sliding tiles</h3><p>Slide a tile into the empty space. Arrange 1–8 in order.</p>
      <p aria-live="polite">{solved ? `Solved in ${moveCount}` : moveCount}</p>
      <button type="button" onClick={() => { setBoard(shuffle()); setMoves(0); }}><RotateCcw size={14} /> New game</button></div>
      <div className="studio-puzzle-board" aria-label="Sliding tile board">{board.map((tile, index) => tile === 0 ? <span key="gap" /> : <button key={tile} aria-label={`Tile ${tile}`} disabled={!adjacent(index, gap) || solved} onClick={() => move(index)}>{tile}</button>)}</div>
    </div>}
  </aside>;
}
