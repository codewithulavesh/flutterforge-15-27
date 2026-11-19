/**
 * Filesystem tools for the single engineer.
 *
 * Every path is validated by the same `safeRelativePath` / `resolveInside`
 * helpers used by the HTTP patch engine, so a model cannot escape the project
 * root with `..`, absolute paths or symlinked directories. Writes are atomic
 * (temp file + rename) to keep a crashed run from leaving half-written Dart.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  IGNORED_DIRS,
  languageForPath,
  shouldIncludeFile,
} from '../../../harness/workspace.js';
import type { EngineerToolSpec, ToolOutcome } from '../types.js';
import { resolveInside } from '../paths.js';
import { truncate } from '../util.js';

const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;

interface TreeEntry {
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

async function walk(root: string, relative: string, depth: number, limit: number, out: TreeEntry[]): Promise<void> {
  if (out.length >= limit || depth < 0) return;
  const absolute = relative === '' ? root : resolveInside(root, relative);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(absolute, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (entry.name.startsWith('.') && entry.name !== '.env.example' && entry.name !== '.gitignore') continue;
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push({ path: `${child}/`, type: 'dir' });
      await walk(root, child, depth - 1, limit, out);
    } else if (entry.isFile()) {
      const stat = await fs.stat(path.join(root, child)).catch(() => null);
      out.push({ path: child, type: 'file', size: stat?.size ?? 0 });
    }
  }
}

function formatTree(entries: TreeEntry[]): string {
  return entries.map((entry) => `${entry.type === 'dir' ? '  ' : '  '}${entry.path}${entry.size !== undefined ? ` (${entry.size} B)` : ''}`).join('\n');
}

async function readText(root: string, relative: string): Promise<{ absolute: string; content: string }> {
  const absolute = resolveInside(root, relative);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error(`Not a file: ${relative}`);
  if (stat.size > MAX_READ_BYTES) throw new Error(`File is too large to read directly (${stat.size} bytes > ${MAX_READ_BYTES}). Use startLine/endLine.`);
  return { absolute, content: await fs.readFile(absolute, 'utf8') };
}

async function writeAtomic(root: string, relative: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) throw new Error(`Refusing to write more than ${MAX_WRITE_BYTES} bytes to ${relative}.`);
  const absolute = resolveInside(root, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temp = `${absolute}.ff-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(temp, content, 'utf8');
  await fs.rename(temp, absolute);
}

function change(relative: string, action: 'created' | 'modified' | 'deleted', content?: string) {
  return { path: relative, action, ...(content !== undefined ? { content } : {}), language: languageForPath(relative) };
}

export function filesystemTools(): EngineerToolSpec[] {
  return [
    {
      name: 'project_overview',
      description: 'Summarize the project: bounded file tree, pubspec metadata, file counts. Call this before editing.',
      schema: z.object({ maxEntries: z.number().int().min(20).max(1000).optional() }),
      invoke: async (input, context): Promise<ToolOutcome> => {
        const entries: TreeEntry[] = [];
        await walk(context.projectRoot, '', 3, input?.maxEntries ?? 300, entries);
        const pubspec = await fs.readFile(path.join(context.projectRoot, 'pubspec.yaml'), 'utf8').catch(() => '');
        const dartFiles = entries.filter((entry) => entry.path.endsWith('.dart')).length;
        const totalBytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
        const overview = {
          projectId: context.projectId,
          fileCount: entries.filter((entry) => entry.type === 'file').length,
          dartFiles,
          totalBytes,
          pubspec: truncate(pubspec, 4000),
          tree: formatTree(entries.slice(0, input?.maxEntries ?? 300)),
        };
        return { content: JSON.stringify(overview), data: overview };
      },
    },
    {
      name: 'list_files',
      description: 'List project files and directories under a relative path. Hidden/build directories are skipped.',
      schema: z.object({
        path: z.string().optional(),
        depth: z.number().int().min(0).max(6).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      invoke: async (input, context): Promise<ToolOutcome> => {
        const raw = String(input?.path ?? '.').trim();
        const relative = raw === '.' || raw === './' ? '' : raw.replace(/^\.\/+/, '').replace(/\/+$/, '');
        if (relative !== '') {
          // Validate before walking; a bad path must fail loudly.
          resolveInside(context.projectRoot, relative);
        }
        const entries: TreeEntry[] = [];
        await walk(context.projectRoot, relative, input?.depth ?? 2, input?.limit ?? 400, entries);
        return {
          content: entries.length > 0 ? formatTree(entries) : 'Directory is empty.',
          data: { path: relative || '.', entries: entries.length },
        };
      },
    },
    {
      name: 'read_file',
      description: 'Read a project file. Use startLine/endLine for large files. Returns UTF-8 text with line numbers.',
      schema: z.object({
        path: z.string(),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      }),
      invoke: async (input, context): Promise<ToolOutcome> => {
        const { content } = await readText(context.projectRoot, input.path);
        const lines = content.split('\n');
        const start = Math.max(1, input.startLine ?? 1);
        const end = Math.min(lines.length, input.endLine ?? lines.length);
        if (start > end) throw new Error(`startLine ${start} is after endLine ${end}.`);
        const body = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n');
        return { content: truncate(body, 60_000), data: { path: input.path, startLine: start, endLine: end, totalLines: lines.length } };
      },
    },
    {
      name: 'search_files',
      description: 'Search project text files for a literal string or regular expression. Returns path:line matches.',
      schema: z.object({
        query: z.string().min(1),
        regex: z.boolean().optional(),
        include: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      invoke: async (input, context): Promise<ToolOutcome> => {
        const limit = input.limit ?? 60;
        let matcher: (line: string) => boolean;
        if (input.regex) {
          let compiled: RegExp;
          try {
            compiled = new RegExp(input.query, 'i');
          } catch (error) {
            throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
          }
          matcher = (line) => compiled.test(line);
        } else {
          const needle = input.query.toLowerCase();
          matcher = (line) => line.toLowerCase().includes(needle);
        }
        const include = typeof input.include === 'string' && input.include.trim() !== ''
          ? input.include.toLowerCase()
          : null;
        const matches: string[] = [];
        const queue: string[] = [''];
        while (queue.length > 0 && matches.length < limit) {
          const relative = queue.shift() as string;
          const absolute = relative === '' ? context.projectRoot : path.join(context.projectRoot, relative);
          let entries: import('node:fs').Dirent[];
          try {
            entries = await fs.readdir(absolute, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const entry of entries) {
            if (matches.length >= limit) break;
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
              if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
              queue.push(relative === '' ? entry.name : `${relative}/${entry.name}`);
              continue;
            }
            if (!entry.isFile()) continue;
            const rel = relative === '' ? entry.name : `${relative}/${entry.name}`;
            if (!shouldIncludeFile(rel)) continue;
            if (include && !rel.toLowerCase().includes(include)) continue;
            let safePath: string;
            try { safePath = resolveInside(context.projectRoot, rel); } catch { continue; }
            const stat = await fs.stat(safePath).catch(() => null);
            if (!stat || stat.size > 512 * 1024) continue;
            const content = await fs.readFile(safePath, 'utf8').catch(() => '');
            if (content === '') continue;
            const lines = content.split('\n');
            for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
              if (matcher(lines[index])) matches.push(`${rel}:${index + 1}: ${truncate(lines[index].trim(), 300)}`);
            }
          }
        }
        return { content: matches.length > 0 ? matches.join('\n') : 'No matches found.', data: { matches: matches.length, query: input.query } };
      },
    },
    {
      name: 'write_file',
      description: 'Create or fully replace a project file. Prefer edit_file for small changes. Writes are atomic.',
      schema: z.object({ path: z.string(), content: z.string() }),
      invoke: async (input, context): Promise<ToolOutcome> => {
        const existed = await fs.stat(resolveInside(context.projectRoot, input.path)).then(() => true).catch(() => false);
        await writeAtomic(context.projectRoot, input.path, input.content);
        return {
          content: `Wrote ${Buffer.byteLength(input.content, 'utf8')} bytes to ${input.path}.`,
          changedFiles: [change(input.path, existed ? 'modified' : 'created', input.content)],
        };
      },
    },
    {
      name: 'edit_file',
      description: 'Replace exact text in an existing file. Fails if the old text is missing or ambiguous (unless replaceAll is true).',
      schema: z.object({
        path: z.string(),
        oldText: z.string().min(1),
        newText: z.string(),
        replaceAll: z.boolean().optional(),
      }),
      invoke: async (input, context): Promise<ToolOutcome> => {
        const { content } = await readText(context.projectRoot, input.path);
        if (!content.includes(input.oldText)) throw new Error(`The oldText was not found in ${input.path}. Read the file first.`);
        const occurrences = content.split(input.oldText).length - 1;
        if (occurrences > 1 && !input.replaceAll) {
          throw new Error(`oldText appears ${occurrences} times in ${input.path}; supply more context or set replaceAll=true.`);
        }
        const updated = input.replaceAll
          ? content.split(input.oldText).join(input.newText)
          : content.replace(input.oldText, input.newText);
        await writeAtomic(context.projectRoot, input.path, updated);
        return {
          content: `Updated ${input.path} (${occurrences} occurrence${occurrences === 1 ? '' : 's'}).`,
          changedFiles: [change(input.path, 'modified', updated)],
        };
      },
    },
    {
      name: 'delete_file',
      description: 'Delete a project file. Requires human approval. Directories are only removed when empty.',
      schema: z.object({ path: z.string() }),
      approval: () => ({ required: true, risk: 'high', reason: 'Deleting project files is destructive.' }),
      invoke: async (input, context): Promise<ToolOutcome> => {
        const absolute = resolveInside(context.projectRoot, input.path);
        const stat = await fs.stat(absolute);
        if (stat.isDirectory()) {
          const entries = await fs.readdir(absolute);
          if (entries.length > 0) throw new Error(`Directory ${input.path} is not empty; refusing recursive delete.`);
          await fs.rmdir(absolute);
        } else {
          await fs.unlink(absolute);
        }
        return { content: `Deleted ${input.path}.`, changedFiles: [change(input.path, 'deleted')] };
      },
    },
    {
      name: 'move_file',
      description: 'Rename or move a project file. Refuses to overwrite an existing destination.',
      schema: z.object({ from: z.string(), to: z.string() }),
      invoke: async (input, context): Promise<ToolOutcome> => {
        const source = resolveInside(context.projectRoot, input.from);
        const destination = resolveInside(context.projectRoot, input.to);
        const existing = await fs.stat(destination).then(() => true).catch(() => false);
        if (existing) throw new Error(`Destination already exists: ${input.to}`);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.rename(source, destination);
        return {
          content: `Moved ${input.from} to ${input.to}.`,
          changedFiles: [change(input.from, 'deleted'), change(input.to, 'created')],
        };
      },
    },
  ];
}
