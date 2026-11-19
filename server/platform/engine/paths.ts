import path from 'node:path';
import { lstatSync } from 'node:fs';
import { resolveInside as lexicalResolve } from '../../harness/workspace.js';

/** Reject symlinks in every existing component, including the target. */
export function resolveInside(root: string, relative: string): string {
  const target = lexicalResolve(root, relative);
  let current = path.resolve(root);
  for (const component of ['', ...path.relative(current, target).split(path.sep)]) {
    current = path.join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('Symlink access is forbidden in engineer workspaces.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (path.relative(root, target).split(path.sep).some(p => p === '.git' || /^\.env(?!\.example$)/.test(p))) {
    throw new Error('Engine tools cannot access credentials or Git internals.');
  }
  return target;
}
