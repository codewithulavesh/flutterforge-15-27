/**
 * Real project terminal.
 *
 * Commands run on the server inside the project workspace only. There is no
 * shell: every argv is spawned directly, paths are resolved inside the
 * workspace, shell metacharacters are rejected, and output is capped. The
 * allowlist is intentionally small and readable-file oriented, with a few
 * workspace-scoped write commands and the real Flutter/Dart toolchain.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getProjectWorkspace } from './harness/run.js';
import { findDart } from './harness/flutter.js';
import { ensureFlutter } from './harness/managedFlutter.js';
import { runCommand } from './harness/dsh.js';
import { resolveInside } from './harness/workspace.js';
import {
  fixInvalidPlainScalars,
  getToolchainVersions,
  sanitizeFlutterConstraint,
  sanitizeSdkConstraint,
} from './harness/pubspecFix.js';

const MAX_OUTPUT = 64_000;
const MAX_GREP_MATCHES = 600;
const MAX_WALK_FILES = 20_000;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const TOOL_TIMEOUT_MS = 240_000;
const GIT_TIMEOUT_MS = 60_000;

type TerminalBody = { output?: string; code?: number; timedOut?: boolean; kind?: string; error?: string };

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

function tail(text: string, max = MAX_OUTPUT): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function ok(output: string, code = 0, timedOut = false): { statusCode: number; body: TerminalBody } {
  return { statusCode: 200, body: { output: tail(output), code, timedOut } };
}

function fail(message: string, code = 1): { statusCode: number; body: TerminalBody } {
  return { statusCode: 200, body: { output: `${message}\n`, code } };
}

/** A command that is rejected by policy (never executed) is a bad request. */
function reject(message: string): { statusCode: number; body: TerminalBody } {
  return { statusCode: 400, body: { error: message } };
}

function isDirectoryFlag(token: string): boolean {
  return token.startsWith('-');
}

function looksLikeEscape(token: string): boolean {
  return token.startsWith('/')
    || token.startsWith('~')
    || /^[A-Za-z]:[\\/]/.test(token)
    || token.split(/[\\/]/).includes('..');
}

function unsafeMetacharacters(raw: string): string | null {
  let quote: '"' | "'" | null = null;
  for (const character of raw) {
    if (character === '\0') return '\\0';
    if (character === '\n' || character === '\r') return 'newline';
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/[;&|<>`$(){}[\]*?!\\]/.test(character)) return character;
  }
  return quote ? 'unterminated quote' : null;
}

/**
 * Spawned toolchain/git commands may go through a Windows shell, so their
 * arguments must not contain any shell metacharacter even when quoted.
 */
function strictMetacharacter(raw: string): string | null {
  const match = raw.match(/[;&|<>`$(){}\[\]*?!\\\0\r\n]/);
  return match ? match[0] : null;
}

function resolvePath(workspace: string, token: string): string {
  return resolveInside(workspace, token);
}

async function statSafe(target: string): Promise<import('node:fs').Stats | null> {
  return fs.stat(target).catch(() => null);
}

async function readTextFile(target: string): Promise<string> {
  const stat = await statSafe(target);
  if (!stat || !stat.isFile()) throw new Error('not a file');
  if (stat.size > MAX_READ_BYTES) throw new Error(`file is larger than ${MAX_READ_BYTES} bytes`);
  const buffer = await fs.readFile(target);
  if (buffer.subarray(0, 4096).includes(0)) throw new Error('binary file');
  return buffer.toString('utf8');
}

interface WalkOptions {
  includeHidden?: boolean;
  maxFiles?: number;
}

async function walkFiles(root: string, options: WalkOptions = {}): Promise<string[]> {
  const results: string[] = [];
  const maxFiles = options.maxFiles ?? MAX_WALK_FILES;
  const ignored = new Set(['.dart_tool', 'build', 'node_modules', '.git', '.flutterforge']);
  const visit = async (directory: string, relative: string): Promise<void> => {
    if (results.length >= maxFiles) return;
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (entry.name === '.' || entry.name === '..') continue;
      if (ignored.has(entry.name)) continue;
      if (!options.includeHidden && entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (entry.isSymbolicLink()) continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name), childRelative);
      } else if (entry.isFile()) {
        results.push(childRelative);
      }
    }
  };
  await visit(root, '');
  return results;
}

async function readLines(target: string): Promise<string[]> {
  return (await readTextFile(target)).split(/\r?\n/);
}

function formatter(relative: string, line: number, text: string, numbers: boolean): string {
  return numbers ? `${relative}:${line}:${text}` : `${relative}:${text}`;
}

/* ── Commands ─────────────────────────────────────────────────────────────── */

async function listCommand(workspace: string, tokens: string[]): Promise<{ statusCode: number; body: TerminalBody }> {
  const showHidden = tokens.some((token) => /^-(?:a|A|la|al|lah|alh|1a|a1)$/.test(token));
  const long = tokens.some((token) => /^-(?:l|la|al|lah|alh)$/.test(token));
  const targets = tokens.slice(1).filter((token) => !isDirectoryFlag(token));
  if (targets.length > 1) return reject('ls supports one path at a time');
  const target = targets[0] ? resolvePath(workspace, targets[0]) : workspace;
  try {
    const entries = await fs.readdir(target, { withFileTypes: true });
    const visible = entries
      .filter((entry) => showHidden || !entry.name.startsWith('.'))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    if (long) {
      const rows = await Promise.all(visible.map(async (entry) => {
        const absolute = path.join(target, entry.name);
        const stat = await statSafe(absolute);
        const mode = entry.isDirectory() ? 'd' : '-';
        const size = entry.isDirectory() ? '-' : String(stat?.size ?? 0);
        return `${mode}rw-r--r--  ${size.padStart(8)}  ${entry.name}${entry.isDirectory() ? '/' : ''}`;
      }));
      return ok(`${rows.join('\n')}${rows.length ? '\n' : ''}`);
    }
    const output = visible
      .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
      .join('\n');
    return ok(`${output}${output ? '\n' : ''}`);
  } catch (error) {
    return fail(`ls: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function catCommand(workspace: string, tokens: string[]): Promise<{ statusCode: number; body: TerminalBody }> {
  const targets = tokens.slice(1).filter((token) => !isDirectoryFlag(token));
  if (targets.length === 0) return reject('cat: file path required');
  const parts: string[] = [];
  let code = 0;
  for (const target of targets) {
    try {
      parts.push(await readTextFile(resolvePath(workspace, target)));
    } catch (error) {
      parts.push(`cat: ${target}: ${error instanceof Error ? error.message : String(error)}\n`);
      code = 1;
    }
  }
  return ok(parts.join(''), code);
}

async function headTailCommand(workspace: string, tokens: string[], head: boolean): Promise<{ statusCode: number; body: TerminalBody }> {
  let count = 10;
  const files: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-n') {
      const value = Number(tokens[index + 1]);
      if (!Number.isFinite(value) || value < 1) return reject(`${head ? 'head' : 'tail'}: invalid line count`);
      count = Math.min(Math.floor(value), 5000);
      index += 1;
      continue;
    }
    if (token === '-c') return reject(`${head ? 'head' : 'tail'}: -c is not supported; use -n <lines>`);
    if (/^-n?\d+$/.test(token)) {
      count = Math.min(Number(token.replace(/^-n?/, '')), 5000);
      continue;
    }
    if (token.startsWith('-')) return reject(`${head ? 'head' : 'tail'}: unsupported option ${token}`);
    files.push(token);
  }
  if (files.length === 0) return reject(`${head ? 'head' : 'tail'}: file path required`);
  const output: string[] = [];
  let code = 0;
  for (const file of files) {
    try {
      const lines = await readLines(resolvePath(workspace, file));
      const slice = head ? lines.slice(0, count) : lines.slice(-count);
      if (files.length > 1) output.push(`==> ${file} <==`);
      output.push(slice.join('\n'));
    } catch (error) {
      output.push(`${head ? 'head' : 'tail'}: ${file}: ${error instanceof Error ? error.message : String(error)}`);
      code = 1;
    }
  }
  return ok(`${output.join('\n')}\n`, code);
}

interface GrepOptions {
  pattern: string;
  targets: string[];
  recursive: boolean;
  ignoreCase: boolean;
  lineNumbers: boolean;
  filesOnly: boolean;
  countOnly: boolean;
  word: boolean;
  fixed: boolean;
}

function parseGrep(tokens: string[], commandName: string): { options?: GrepOptions; error?: string } {
  const options: GrepOptions = {
    pattern: '',
    targets: [],
    recursive: false,
    ignoreCase: false,
    lineNumbers: true,
    filesOnly: false,
    countOnly: false,
    word: false,
    fixed: false,
  };
  const positional: string[] = [];
  for (const token of tokens.slice(1)) {
    if (token === '-n') options.lineNumbers = true;
    else if (token === '-i') options.ignoreCase = true;
    else if (token === '-r' || token === '-R') options.recursive = true;
    else if (token === '-l') options.filesOnly = true;
    else if (token === '-c') options.countOnly = true;
    else if (token === '-w') options.word = true;
    else if (token === '-F') options.fixed = true;
    else if (token === '-E') options.fixed = false;
    else if (token === '-h') return { error: `${commandName}: -h is not supported in the terminal` };
    else if (token.startsWith('-')) return { error: `${commandName}: unsupported option ${token}` };
    else positional.push(token);
  }
  if (positional.length === 0) return { error: `${commandName}: pattern required` };
  options.pattern = positional.shift()!;
  options.targets = positional;
  if (options.filesOnly) options.lineNumbers = false;
  if (!options.fixed) {
    try {
      new RegExp(options.pattern, options.ignoreCase ? 'i' : '');
    } catch (error) {
      return { error: `${commandName}: invalid pattern: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { options };
}

async function grepCommand(workspace: string, tokens: string[], commandName: string): Promise<{ statusCode: number; body: TerminalBody }> {
  const parsed = parseGrep(tokens, commandName);
  if (!parsed.options) return reject(parsed.error ?? `${commandName}: invalid arguments`);
  const options = parsed.options;

  const pattern = options.pattern;
  // Catastrophic-backtracking guard: reject nested quantifiers over an inner
  // quantified group — the classic (a+)+$ bomb. Line-by-line execution applies
  // the pattern to up to 20k files, so an exponential pattern must never run.
  const nestedQuantifier = /\((?:[^()]|\\.)*(?:[+*]|\{\d+(,\d*)?\})(?:[^()]|\\.)*\)\s*(?:[+*]|\{\d+(,\d*)?\})/;
  if (!options.fixed && (pattern.length > 200 || nestedQuantifier.test(pattern))) {
    return reject(`${commandName}: pattern is too complex (nested quantifiers or length > 200). Use -F for literal search.`);
  }
  if (options.fixed && pattern.length > 1000) {
    return reject(`${commandName}: pattern is too long (max 1000 chars).`);
  }

  const compiled = options.fixed ? null : new RegExp(pattern, options.ignoreCase ? 'i' : '');
  const wordBoundary = (options.fixed && options.word)
    ? new RegExp(`\\b${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, options.ignoreCase ? 'i' : '')
    : null;

  const matcher = options.fixed
    ? (line: string) => {
      const haystack = options.ignoreCase ? line.toLowerCase() : line;
      const needle = options.ignoreCase ? pattern.toLowerCase() : pattern;
      if (!options.word) return haystack.includes(needle);
      return wordBoundary!.test(line);
    }
    : (line: string) => compiled!.test(line);

  const roots = options.targets.length > 0 ? options.targets : ['.'];
  const files: Array<{ relative: string; absolute: string }> = [];
  for (const root of roots) {
    const absolute = resolvePath(workspace, root);
    const stat = await statSafe(absolute);
    if (!stat) {
      files.push({ relative: root, absolute });
      continue;
    }
    if (stat.isDirectory()) {
      if (!options.recursive) return reject(`${commandName}: ${root} is a directory (use -r)`);
      for (const relative of await walkFiles(absolute)) {
        files.push({ relative: path.posix.join(root.replace(/^\.\/?/, ''), relative), absolute: path.join(absolute, relative) });
      }
    } else {
      files.push({ relative: root.replace(/^\.\/?/, ''), absolute });
    }
  }

  const output: string[] = [];
  let total = 0;
  let matchedFiles = 0;
  for (const file of files) {
    if (total >= MAX_GREP_MATCHES) break;
    let lines: string[];
    try {
      lines = await readLines(file.absolute);
    } catch {
      continue;
    }
    let fileMatches = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (!matcher(lines[index])) continue;
      fileMatches += 1;
      total += 1;
      if (options.filesOnly) break;
      if (!options.countOnly) output.push(formatter(file.relative, index + 1, lines[index], options.lineNumbers));
      if (total >= MAX_GREP_MATCHES) break;
    }
    if (fileMatches > 0) matchedFiles += 1;
    if (options.filesOnly && fileMatches > 0) output.push(file.relative);
    if (options.countOnly) output.push(`${file.relative}:${fileMatches}`);
  }
  if (total === 0) return ok('', 1);
  const suffix = total >= MAX_GREP_MATCHES ? `\n… output capped at ${MAX_GREP_MATCHES} matches\n` : '\n';
  return ok(`${output.join('\n')}${suffix}`, matchedFiles > 0 ? 0 : 1);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

async function findCommand(workspace: string, tokens: string[]): Promise<{ statusCode: number; body: TerminalBody }> {
  let root = '.';
  let name: string | null = null;
  let type: 'f' | 'd' | null = null;
  let maxDepth = Infinity;
  const positional: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-name' || token === '-iname') {
      name = tokens[index + 1] ?? null;
      if (!name) return reject('find: -name requires a pattern');
      index += 1;
    } else if (token === '-type') {
      const value = tokens[index + 1];
      if (value !== 'f' && value !== 'd') return reject('find: -type must be f or d');
      type = value;
      index += 1;
    } else if (token === '-maxdepth') {
      const value = Number(tokens[index + 1]);
      if (!Number.isFinite(value) || value < 0) return reject('find: -maxdepth requires a number');
      maxDepth = Math.floor(value);
      index += 1;
    } else if (token.startsWith('-')) {
      return reject(`find: unsupported option ${token}`);
    } else {
      positional.push(token);
    }
  }
  if (positional.length > 1) return reject('find: only one root path is supported');
  root = positional[0] ?? '.';
  const absoluteRoot = resolvePath(workspace, root);
  const stat = await statSafe(absoluteRoot);
  if (!stat || !stat.isDirectory()) return fail(`find: ${root}: not a directory`);

  const nameMatcher = name ? globToRegExp(name) : null;
  const results: string[] = [];
  const visit = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (results.length >= MAX_WALK_FILES || depth > maxDepth) return;
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= MAX_WALK_FILES) return;
      if (['.dart_tool', '.git', 'build', 'node_modules'].includes(entry.name)) continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const matchesName = !nameMatcher || nameMatcher.test(entry.name);
      if (entry.isDirectory()) {
        if ((!type || type === 'd') && matchesName) results.push(`${childRelative}/`);
        await visit(path.join(directory, entry.name), childRelative, depth + 1);
      } else if (entry.isFile() && (!type || type === 'f') && matchesName) {
        results.push(childRelative);
      }
    }
  };
  await visit(absoluteRoot, root === '.' ? '' : root.replace(/\/$/, ''), 0);
  return ok(`${results.join('\n')}${results.length ? '\n' : ''}`, results.length > 0 ? 0 : 1);
}

async function wcCommand(workspace: string, tokens: string[]): Promise<{ statusCode: number; body: TerminalBody }> {
  const flags = new Set<string>();
  const files: string[] = [];
  for (const token of tokens.slice(1)) {
    if (/^-[lwc]+$/.test(token)) for (const flag of token.slice(1)) flags.add(flag);
    else if (token.startsWith('-')) return reject(`wc: unsupported option ${token}`);
    else files.push(token);
  }
  if (files.length === 0) return reject('wc: file path required');
  const wanted = flags.size > 0 ? flags : new Set(['l', 'w', 'c']);
  const rows: string[] = [];
  let totalLines = 0;
  let totalWords = 0;
  let totalBytes = 0;
  for (const file of files) {
    try {
      const content = await readTextFile(resolvePath(workspace, file));
      const lines = content === '' ? 0 : content.split(/\r?\n/).length - (content.endsWith('\n') ? 1 : 0);
      const words = content.trim() ? content.trim().split(/\s+/).length : 0;
      const bytes = Buffer.byteLength(content, 'utf8');
      totalLines += lines;
      totalWords += words;
      totalBytes += bytes;
      const values = [
        wanted.has('l') ? String(lines) : null,
        wanted.has('w') ? String(words) : null,
        wanted.has('c') ? String(bytes) : null,
      ].filter(Boolean);
      rows.push(`${values.join(' ')} ${file}`);
    } catch (error) {
      rows.push(`wc: ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (files.length > 1 && wanted.size === 3) {
    rows.push(`${totalLines} ${totalWords} ${totalBytes} total`);
  }
  return ok(`${rows.join('\n')}\n`);
}

async function mkdirCommand(workspace: string, tokens: string[]): Promise<{ statusCode: number; body: TerminalBody }> {
  const recursive = tokens.slice(1).some((token) => token === '-p' || token === '--parents');
  const targets = tokens.slice(1).filter((token) => !token.startsWith('-'));
  if (targets.length === 0) return reject('mkdir: path required');
  for (const target of targets) {
    const absolute = resolvePath(workspace, target);
    await fs.mkdir(absolute, { recursive });
  }
  return ok('');
}

async function touchCommand(workspace: string, tokens: string[]): Promise<{ statusCode: number; body: TerminalBody }> {
  const targets = tokens.slice(1).filter((token) => !token.startsWith('-'));
  if (targets.length === 0) return reject('touch: path required');
  const now = new Date();
  for (const target of targets) {
    const absolute = resolvePath(workspace, target);
    const stat = await statSafe(absolute);
    if (stat) await fs.utimes(absolute, now, now);
    else await fs.writeFile(absolute, '', 'utf8');
  }
  return ok('');
}

async function rmCommand(workspace: string, tokens: string[]): Promise<{ statusCode: number; body: TerminalBody }> {
  if (tokens.length !== 2) {
    return reject('rm: exactly one file path is supported (no flags, no directories). Use the file explorer to delete folders.');
  }
  const target = tokens[1];
  if (target.startsWith('-')) return reject('rm: flags are not supported');
  const absolute = resolvePath(workspace, target);
  const stat = await statSafe(absolute);
  if (!stat) return fail(`rm: ${target}: no such file`);
  if (!stat.isFile()) return reject(`rm: ${target}: refusing to delete a directory`);
  await fs.rm(absolute, { force: false });
  return ok('');
}

/* ── Toolchain commands ───────────────────────────────────────────────────── */

const FLUTTER_ALLOWED = new Set([
  'analyze', 'test', 'pub', 'doctor', 'devices', 'clean', '--version', 'version',
  'build', 'run', 'format', 'gen-l10n',
]);
const FLUTTER_BLOCKED = new Set(['upgrade', 'downgrade', 'channel', 'precache', 'config', 'emulators', 'install', 'create']);
const DART_ALLOWED = new Set(['analyze', 'format', 'fix', 'test', 'pub', 'run', 'compile', 'info', '--version']);
const PUB_READ_ONLY = new Set(['get', 'upgrade', 'outdated', 'deps', 'add', 'remove']);

function validateToolchainArgs(executable: 'flutter' | 'dart', args: string[]): string | null {
  for (const arg of args) {
    if (looksLikeEscape(arg)) return `${executable}: paths outside the project are not allowed (${arg})`;
  }
  const subcommand = args[0] ?? '';
  if (executable === 'flutter') {
    if (FLUTTER_BLOCKED.has(subcommand)) return `flutter ${subcommand} is not available in the project terminal`;
    if (subcommand && !FLUTTER_ALLOWED.has(subcommand) && !subcommand.startsWith('-')) {
      return `flutter ${subcommand} is not on the terminal allowlist`;
    }
    if (subcommand === 'pub') {
      const verb = args[1] ?? '';
      if (verb === 'publish') return 'flutter pub publish is blocked: publishing must go through the Publish flow';
      if (verb && !PUB_READ_ONLY.has(verb)) return `flutter pub ${verb} is not on the terminal allowlist`;
    }
  }
  if (executable === 'dart') {
    if (subcommand && !DART_ALLOWED.has(subcommand) && !subcommand.startsWith('-')) {
      return `dart ${subcommand} is not on the terminal allowlist`;
    }
    if (subcommand === 'pub') {
      const verb = args[1] ?? '';
      if (verb === 'publish') return 'dart pub publish is blocked: publishing must go through the Publish flow';
      if (verb && !PUB_READ_ONLY.has(verb)) return `dart pub ${verb} is not on the terminal allowlist`;
    }
  }
  return null;
}

async function toolchainCommand(workspace: string, executable: string, args: string[]): Promise<{ statusCode: number; body: TerminalBody }> {
  const validation = validateToolchainArgs(executable as 'flutter' | 'dart', args);
  if (validation) return reject(validation);

  if (executable === 'flutter' && args[0] === 'build' && args[1] === 'web') {
    return ok('Use the Preview tab to build Flutter web (warm runner). `flutter analyze`, `flutter test`, and `flutter pub get` run here for real.\n');
  }
  if (executable === 'flutter' && args[0] === 'run') {
    return ok('Use the Preview tab to run the app. The terminal supports analyze, test, pub get, and build checks.\n');
  }

  let binary: string;
  try {
    const ensured = await ensureFlutter({ onProgress: (line) => console.log(`[toolchain] ${line}`) });
    binary = executable === 'flutter' ? ensured : findDart();
  } catch (error) {
    return fail(`Could not prepare the ${executable} toolchain: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const result = await runCommand(binary, args, { cwd: workspace, timeoutMs: TOOL_TIMEOUT_MS });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    return ok(`${output || (result.ok ? '✓ done' : 'Command failed')}\n`, result.code ?? (result.ok ? 0 : 1), Boolean(result.timedOut));
  } catch (error) {
    return fail(`${executable} failed to run: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ── Git (read-only) ──────────────────────────────────────────────────────── */

const GIT_READ_ONLY = new Set(['status', 'log', 'diff', 'show', 'branch', 'ls-files', 'rev-parse', 'blame', 'grep', 'tag', 'stash']);
const GIT_BLOCKED_ARGS = /^(?:-C|--git-dir|--work-tree|--exec-path|-c|--no-index)/;

function validateGitArgs(args: string[]): string | null {
  const subcommand = args[0] ?? '';
  if (!subcommand) return 'git: a read-only subcommand is required (status, log, diff, show, branch, ls-files, rev-parse, blame, grep)';
  if (!GIT_READ_ONLY.has(subcommand)) return `git ${subcommand} is not available in the project terminal (read-only git only)`;
  for (const arg of args) {
    if (GIT_BLOCKED_ARGS.test(arg)) return `git ${arg} is blocked in the project terminal`;
    if (looksLikeEscape(arg)) return `git: paths outside the project are not allowed (${arg})`;
  }
  if (subcommand === 'branch') {
    const positional = args.slice(1).filter((arg) => !arg.startsWith('-'));
    if (positional.length > 0) return 'git branch can only list branches here (creating or deleting branches is blocked)';
  }
  if (subcommand === 'stash') {
    const verb = args[1] ?? 'list';
    if (!['list', 'show'].includes(verb)) return 'git stash is read-only here (list or show only)';
  }
  if (subcommand === 'tag') {
    const positional = args.slice(1).filter((arg) => !arg.startsWith('-') && arg !== '-l' && arg !== '--list');
    if (positional.length > 0 && !args.includes('-l') && !args.includes('--list')) {
      return 'git tag can only list tags here';
    }
  }
  return null;
}

async function gitCommand(workspace: string, args: string[]): Promise<{ statusCode: number; body: TerminalBody }> {
  const validation = validateGitArgs(args);
  if (validation) return reject(validation);
  try {
    const result = await runCommand('git', args, { cwd: workspace, timeoutMs: GIT_TIMEOUT_MS });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (/not a git repository/i.test(output)) {
      return fail('This project workspace is not a git repository.');
    }
    return ok(`${output || '(no output)'}\n`, result.code ?? (result.ok ? 0 : 1), Boolean(result.timedOut));
  } catch (error) {
    return fail(`git failed to run: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ── Heal + dispatch ──────────────────────────────────────────────────────── */

async function healPubspec(workspace: string): Promise<void> {
  try {
    const pubspecPath = path.join(workspace, 'pubspec.yaml');
    const content = await fs.readFile(pubspecPath, 'utf8');
    const scalarFix = fixInvalidPlainScalars(content);
    let healed = scalarFix.content;
    let notes = [scalarFix.note];
    if (healed !== content) {
      const versions = await getToolchainVersions();
      const sdkFix = sanitizeSdkConstraint(healed, { dartVersion: versions.dartVersion });
      if (sdkFix.changed) healed = sdkFix.content;
      const flutterFix = sanitizeFlutterConstraint(healed, { flutterVersion: versions.flutterVersion });
      if (flutterFix.changed) healed = flutterFix.content;
      notes = [scalarFix.note, sdkFix.note, flutterFix.note];
      await fs.writeFile(pubspecPath, healed, 'utf8');
    }
    for (const note of notes) {
      if (note) console.log(`[terminal] ${note}`);
    }
  } catch {
    // No pubspec yet — toolchain commands will report their own error.
  }
}

const HELP = `Allowed commands (run inside the project workspace):
  flutter analyze | test | pub get | pub upgrade | pub outdated | pub deps
  dart analyze | format | fix | test | pub get
  git status | log | diff | show | branch | ls-files | rev-parse | blame
  ls [-a] [-l] [path]        pwd
  cat <file>                 head|tail [-n N] <file>
  grep|rg [-r] [-i] [-n] [-l] [-c] <pattern> [path]
  find [path] [-name glob] [-type f|d] [-maxdepth N]
  wc [-l|-w|-c] <file>
  mkdir [-p] <dir>           touch <file>           rm <file>
  help                       clear

No shell operators, pipes, globs, or paths outside this project.`;

export async function runTerminalCommand(projectId: string, command: string): Promise<{ statusCode: number; body: Record<string, any> }> {
  const raw = String(command ?? '').trim();
  if (!raw) return { statusCode: 400, body: { error: 'command is required' } };
  if (raw.length > 2000) return { statusCode: 400, body: { error: 'command is too long' } };

  const meta = unsafeMetacharacters(raw);
  if (meta) {
    return { statusCode: 400, body: { error: `Shell metacharacter "${meta}" is not allowed. Run one command at a time.` } };
  }

  const tokens = tokenize(raw);
  const executable = tokens[0]?.toLowerCase();
  if (!executable) return { statusCode: 400, body: { error: 'command is required' } };
  if (executable === 'help' || executable === 'clear') {
    return { statusCode: 200, body: { output: executable === 'help' ? HELP : '', kind: executable } };
  }

  const allowed = new Set([
    'flutter', 'dart', 'git', 'ls', 'pwd', 'cat', 'head', 'tail', 'grep', 'rg',
    'find', 'wc', 'mkdir', 'touch', 'rm',
  ]);
  if (!allowed.has(executable)) {
    return {
      statusCode: 400,
      body: { error: `Command not allowed. Try: flutter analyze, flutter test, dart format, git status, ls, cat <file>, help` },
    };
  }

  // Toolchain and git are spawned as real processes (and may pass through a
  // Windows shell). Reject metacharacters everywhere, including quoted text.
  if (['flutter', 'dart', 'git'].includes(executable)) {
    const strict = strictMetacharacter(raw);
    if (strict) {
      return { statusCode: 400, body: { error: `Shell metacharacter "${strict}" is not allowed for ${executable} commands.` } };
    }
  }

  const workspace = getProjectWorkspace(projectId);
  await fs.mkdir(workspace, { recursive: true });

  if (executable === 'flutter' || executable === 'dart') {
    try {
      await healPubspec(workspace);
    } catch (error) {
      return fail(`Could not prepare the project for the ${executable} toolchain (pubspec): ${error instanceof Error ? error.message : String(error)}`);
    }
    return toolchainCommand(workspace, executable, tokens.slice(1));
  }
  if (executable === 'git') return gitCommand(workspace, tokens.slice(1));
  if (executable === 'pwd') return ok(`${workspace}\n`);

  try {
    switch (executable) {
      case 'ls': return await listCommand(workspace, tokens);
      case 'cat': return await catCommand(workspace, tokens);
      case 'head': return await headTailCommand(workspace, tokens, true);
      case 'tail': return await headTailCommand(workspace, tokens, false);
      case 'grep':
      case 'rg': return await grepCommand(workspace, tokens, executable);
      case 'find': return await findCommand(workspace, tokens);
      case 'wc': return await wcCommand(workspace, tokens);
      case 'mkdir': return await mkdirCommand(workspace, tokens);
      case 'touch': return await touchCommand(workspace, tokens);
      case 'rm': return await rmCommand(workspace, tokens);
      default: return reject(`Command not allowed: ${executable}`);
    }
  } catch (error) {
    return fail(`${executable}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
