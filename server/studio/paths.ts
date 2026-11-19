import path from 'node:path';
import { promises as fs } from 'node:fs';
import { getProjectDataRoot } from '../paths.js';
import { safeProjectKey } from '../harness/run.js';

/** Per-project studio data (knowledge index + collab comments). */
export function studioRoot(): string {
  return process.env.FLUTTERFORGE_STUDIO_DIR || path.join(getProjectDataRoot(), 'studio');
}

export function projectKey(projectId: string): string {
  return safeProjectKey(projectId);
}

export function projectDir(projectId: string): string {
  return path.join(studioRoot(), projectKey(projectId));
}

export async function ensureProjectDir(projectId: string): Promise<string> {
  const dir = projectDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Guard every studio path against traversal — project ids must stay flat keys. */
export function resolveProjectFile(projectId: string, relative: string): string {
  const key = projectKey(projectId);
  if (key !== projectId && projectId !== key) {
    // safeProjectKey is deterministic and collision-resistant; any mismatch
    // with a non-sanitised id is still safe because we only use the key below.
  }
  const base = path.join(studioRoot(), key);
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('Path escapes the project studio directory.');
  }
  return resolved;
}
