/** Small, dependency-free helpers shared by the engineer runtime. */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { EngineerFileChange } from './types.js';

export function mergeChangedFiles(
  left: readonly EngineerFileChange[],
  right: readonly EngineerFileChange[],
): EngineerFileChange[] {
  const byPath = new Map<string, EngineerFileChange>();
  for (const change of left) byPath.set(change.path, change);
  for (const change of right) byPath.set(change.path, change);
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = Math.max(1, Math.floor(max * 0.6));
  const tail = Math.max(1, max - head - 40);
  return `${value.slice(0, head)}\n… [truncated ${value.length - head - tail} chars] …\n${value.slice(-tail)}`;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function redact(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, 'sk-***')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"',}]+/gi, '$1=***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer ***');
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    // Models frequently wrap JSON in a fenced block; recover that form only.
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[1]);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export function isInside(root: string, candidate: string): boolean {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(candidate);
  return absolute === absoluteRoot || absolute.startsWith(`${absoluteRoot}${path.sep}`);
}

/** ISO timestamp used in artifact names; filesystem safe. */
export function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
