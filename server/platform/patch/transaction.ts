/**
 * Transactional workspace patches (two-phase commit).
 *
 * The invariant: a set of generated file changes either lands completely or
 * not at all, even if the process is killed mid-write.
 *
 * Phase 1 (prepare) never touches project files. It durably writes staged
 * blobs, captures originals into backups, and flushes a `prepared` journal.
 * Phase 2 records a durable `committing` decision, then applies each file with
 * an atomic temp-file + fsync + rename. A crash before the decision rolls
 * back; a crash after the decision rolls forward on the next boot.
 *
 * Deletes and writes share one journal, so a failed patch cannot leave a
 * half-deleted feature directory behind.
 */
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ConflictError, PlatformError, ValidationError } from '../kernel/errors.js';
import { prefixedId } from '../kernel/ids.js';

export type PatchAction = 'put' | 'delete';
export type TransactionState = 'open' | 'prepared' | 'committing' | 'rolling_back' | 'committed' | 'rolled_back' | 'failed';

export interface PatchInput {
  path: string;
  /** `null` deletes the file. Buffers preserve binary assets byte-for-byte. */
  content: string | Buffer | null;
}

export interface PatchLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_PATCH_LIMITS: PatchLimits = {
  maxFiles: 500,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

export interface PatchChange {
  path: string;
  action: 'created' | 'modified' | 'deleted' | 'unchanged';
  beforeHash?: string;
  afterHash?: string;
  size: number;
}

export interface PatchResult {
  transactionId: string;
  workspaceRoot: string;
  state: 'committed';
  changes: PatchChange[];
  filesWritten: number;
  filesDeleted: number;
  durationMs: number;
}

interface JournalEntry {
  path: string;
  action: PatchAction;
  contentHash: string;
  size: number;
  stagedFile?: string;
  original: {
    existed: boolean;
    hash?: string;
    size?: number;
    mode?: number;
    backupFile?: string;
  };
}

interface Journal {
  version: 1;
  id: string;
  workspaceRoot: string;
  state: TransactionState;
  createdAt: number;
  updatedAt: number;
  actor: string;
  message: string;
  runId?: string;
  entries: JournalEntry[];
  error?: string;
}

export interface TransactionOptions {
  /** Directory holding all transaction journals, typically `<dataDir>/transactions`. */
  transactionRoot: string;
  workspaceRoot: string;
  actor: string;
  message: string;
  runId?: string;
  limits?: Partial<PatchLimits>;
  now?: () => number;
}

const JOURNAL_FILE = 'journal.json';
const BLOCKED_SEGMENTS = new Set(['.git', '.flutterforge', '.dsh', 'node_modules']);
const LOCK_STALE_MS = 10 * 60_000;

const activeWorkspaces = new Map<string, Promise<void>>();

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Normalize and validate a project-relative path (POSIX separators). */
export function normalizePatchPath(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ValidationError('Patch path must be a non-empty string.', { path: input });
  }
  const normalized = input.replaceAll('\\', '/').replace(/^\.\/+/, '').trim();
  if (normalized.includes('\0')) throw new ValidationError('Patch path contains a NUL byte.', { path: input });
  if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//')) {
    throw new ValidationError(`Patch path must be relative: ${input}`, { path: input });
  }
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) throw new ValidationError(`Patch path is empty: ${input}`, { path: input });
  if (segments.some((segment) => segment === '..')) {
    throw new ValidationError(`Patch path escapes the workspace: ${input}`, { path: input });
  }
  if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment))) {
    throw new ValidationError(`Patch path targets protected metadata: ${input}`, { path: input });
  }
  return segments.join('/');
}

async function fsyncDirectory(directory: string): Promise<void> {
  // Directory fsync is not supported on Windows; renaming is still atomic there.
  if (process.platform === 'win32') return;
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch {
    /* best effort: some filesystems refuse directory fsync */
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeFileDurable(file: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.open(file, 'w', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicReplace(target: string, content: string | Buffer, mode: number): Promise<void> {
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.ff-tx-${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(temporary, 'w', mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, target);
    await fsyncDirectory(directory);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function assertSafeTarget(root: string, relativePath: string): Promise<string> {
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, relativePath);
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new ValidationError(`Patch path escapes the workspace: ${relativePath}`, { path: relativePath });
  }

  // Reject symlinks at the target itself and at every existing ancestor, so a
  // pre-existing symlink cannot redirect a write outside the workspace.
  let cursor = absoluteRoot;
  for (const segment of relativePath.split('/')) {
    cursor = path.join(cursor, segment);
    const stat = await fs.lstat(cursor).catch(() => null);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new ValidationError(`Patch path traverses a symbolic link: ${relativePath}`, { path: relativePath });
    }
  }
  return target;
}

async function acquireWorkspaceLock(lockDirectory: string, workspaceRoot: string, transactionId: string, now: () => number): Promise<string> {
  await fs.mkdir(lockDirectory, { recursive: true });
  const lockFile = path.join(lockDirectory, `${sha256(path.resolve(workspaceRoot)).slice(0, 24)}.lock`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockFile, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, transactionId, acquiredAt: now() }));
      await handle.sync();
      await handle.close();
      return lockFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raw = await fs.readFile(lockFile, 'utf8').catch(() => '');
      let holder: { pid?: number; acquiredAt?: number; transactionId?: string } = {};
      try {
        holder = JSON.parse(raw);
      } catch {
        /* corrupt lock: treat as stale */
      }
      const age = now() - (holder.acquiredAt ?? 0);
      const alive = typeof holder.pid === 'number' && isProcessAlive(holder.pid);
      if (alive && age < LOCK_STALE_MS) {
        throw new ConflictError(
          'Another patch transaction is in progress for this workspace.',
          'WORKSPACE_LOCKED',
          { transactionId: holder.transactionId },
        );
      }
      await fs.unlink(lockFile).catch(() => undefined);
    }
  }
  throw new ConflictError('Could not acquire the workspace patch lock.', 'WORKSPACE_LOCKED');
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function releaseWorkspaceLock(lockFile: string | null): Promise<void> {
  if (!lockFile) return;
  await fs.unlink(lockFile).catch(() => undefined);
}

/**
 * Fail-fast in-process exclusion per workspace. Deliberately not a fair
 * queue: if a workspace is being patched, the caller gets WORKSPACE_LOCKED
 * immediately rather than waiting behind an unbounded pipeline (the same
 * contract the cross-process lock file enforces).
 */
function tryAcquireWorkspaceMutex(workspaceRoot: string): (() => void) | null {
  const key = path.resolve(workspaceRoot);
  if (activeWorkspaces.has(key)) return null;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  activeWorkspaces.set(key, gate);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    if (activeWorkspaces.get(key) === gate) activeWorkspaces.delete(key);
  };
}

export class PatchTransaction {
  private readonly journalPath: string;
  private readonly directory: string;
  private readonly limits: PatchLimits;
  private readonly now: () => number;
  private journal: Journal;
  private finished = false;
  private lockFile: string | null = null;
  private releaseMutex: (() => void) | null = null;

  private constructor(options: TransactionOptions, journal: Journal, directory: string) {
    this.directory = directory;
    this.journalPath = path.join(directory, JOURNAL_FILE);
    this.journal = journal;
    this.limits = { ...DEFAULT_PATCH_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
  }

  static async begin(options: TransactionOptions): Promise<PatchTransaction> {
    const workspaceRoot = path.resolve(options.workspaceRoot);
    const transactionRoot = path.resolve(options.transactionRoot);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(transactionRoot, { recursive: true });

    const id = prefixedId('tx', options.now?.() ?? Date.now());
    const directory = path.join(transactionRoot, id);
    const now = options.now ?? Date.now;
    const releaseMutex = tryAcquireWorkspaceMutex(workspaceRoot);
    if (!releaseMutex) {
      throw new ConflictError(
        'Another patch transaction is in progress for this workspace.',
        'WORKSPACE_LOCKED',
        { workspaceRoot },
      );
    }

    try {
      const lockFile = await acquireWorkspaceLock(path.join(transactionRoot, 'locks'), workspaceRoot, id, now);
      try {
        await fs.mkdir(path.join(directory, 'staged'), { recursive: true });
        await fs.mkdir(path.join(directory, 'backup'), { recursive: true });
        const journal: Journal = {
          version: 1,
          id,
          workspaceRoot,
          state: 'open',
          createdAt: now(),
          updatedAt: now(),
          actor: options.actor,
          message: options.message,
          runId: options.runId,
          entries: [],
        };
        const transaction = new PatchTransaction(options, journal, directory);
        transaction.lockFile = lockFile;
        transaction.releaseMutex = releaseMutex;
        await transaction.persist();
        return transaction;
      } catch (error) {
        await releaseWorkspaceLock(lockFile);
        throw error;
      }
    } catch (error) {
      releaseMutex();
      throw error;
    }
  }

  get id(): string {
    return this.journal.id;
  }

  get state(): TransactionState {
    return this.journal.state;
  }

  private async persist(): Promise<void> {
    this.journal.updatedAt = this.now();
    const body = JSON.stringify(this.journal, null, 2);
    const temporary = `${this.journalPath}.tmp`;
    await writeFileDurable(temporary, body);
    await fs.rename(temporary, this.journalPath);
    await fsyncDirectory(this.directory);
  }

  private findEntry(relativePath: string): JournalEntry | undefined {
    return this.journal.entries.find((entry) => entry.path === relativePath);
  }

  stagePut(filePath: string, content: string | Buffer): void {
    this.assertOpen();
    const safePath = normalizePatchPath(filePath);
    if (typeof content !== 'string' && !Buffer.isBuffer(content)) {
      throw new ValidationError(`Patch content must be a string or Buffer: ${safePath}`, { path: safePath });
    }
    const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
    if (bytes > this.limits.maxFileBytes) {
      throw new ValidationError(`File exceeds the ${this.limits.maxFileBytes}-byte patch limit: ${safePath}`, { path: safePath });
    }
    const total = this.totalStagedBytes() + bytes;
    if (total > this.limits.maxTotalBytes) {
      throw new ValidationError('Patch exceeds the total byte limit.', { limit: this.limits.maxTotalBytes });
    }

    const existing = this.findEntry(safePath);
    if (existing) {
      this.journal.entries = this.journal.entries.filter((entry) => entry.path !== safePath);
    }
    if (this.journal.entries.length >= this.limits.maxFiles) {
      throw new ValidationError(`Patch exceeds the ${this.limits.maxFiles}-file limit.`, { limit: this.limits.maxFiles });
    }

    const index = this.journal.entries.length;
    const stagedFile = path.posix.join('staged', `${String(index).padStart(4, '0')}-${randomBytes(4).toString('hex')}.blob`);
    this.journal.entries.push({
      path: safePath,
      action: 'put',
      contentHash: sha256(content),
      size: bytes,
      stagedFile,
      original: { existed: false },
    });
    // Store the bytes immediately so a crash during a long generation cannot
    // leave the journal referencing content that never existed.
    stagedContent.set(`${this.directory}:${stagedFile}`, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  }

  stageDelete(filePath: string): void {
    this.assertOpen();
    const safePath = normalizePatchPath(filePath);
    const existing = this.findEntry(safePath);
    if (existing) this.journal.entries = this.journal.entries.filter((entry) => entry.path !== safePath);
    if (this.journal.entries.length >= this.limits.maxFiles) {
      throw new ValidationError(`Patch exceeds the ${this.limits.maxFiles}-file limit.`, { limit: this.limits.maxFiles });
    }
    this.journal.entries.push({
      path: safePath,
      action: 'delete',
      contentHash: sha256(''),
      size: 0,
      original: { existed: false },
    });
  }

  /** Stage a set of opaque file changes, rejecting duplicate paths. */
  stageAll(files: PatchInput[]): void {
    const seen = new Set<string>();
    for (const file of files) {
      const safePath = normalizePatchPath(file.path);
      if (seen.has(safePath)) throw new ValidationError(`Duplicate patch path: ${safePath}`, { path: safePath });
      seen.add(safePath);
      if (file.content === null) this.stageDelete(safePath);
      else this.stagePut(safePath, file.content);
    }
  }

  /** Read back a staged file without touching disk. */
  stagedContent(filePath: string): Buffer | null {
    const safePath = normalizePatchPath(filePath);
    const entry = this.findEntry(safePath);
    if (!entry || entry.action === 'delete' || !entry.stagedFile) return null;
    const inMemory = stagedContent.get(`${this.directory}:${entry.stagedFile}`);
    return inMemory ?? null;
  }

  entries(): ReadonlyArray<{ path: string; action: PatchAction; content: Buffer | null }> {
    return this.journal.entries.map((entry) => ({
      path: entry.path,
      action: entry.action,
      content: entry.action === 'put' && entry.stagedFile
        ? stagedContent.get(`${this.directory}:${entry.stagedFile}`) ?? null
        : null,
    }));
  }

  /**
   * Phase 1. Captures originals, flushes staged blobs, runs the validation
   * callback, and records the prepared journal. No project file is modified.
   */
  async prepare(options: { validate?: (entries: ReadonlyArray<{ path: string; action: PatchAction; content: Buffer | null }>) => Promise<void> | void } = {}): Promise<void> {
    this.assertOpen();
    if (this.journal.entries.length === 0) {
      this.journal.state = 'prepared';
      await this.persist();
      return;
    }

    // Flush staged blobs first: a durable journal must never reference
    // content that is still only in memory.
    for (const entry of this.journal.entries) {
      if (entry.action !== 'put' || !entry.stagedFile) continue;
      const content = stagedContent.get(`${this.directory}:${entry.stagedFile}`);
      if (content === undefined) throw new PlatformError({ code: 'PATCH_STAGE_MISSING', message: `Staged content missing for ${entry.path}.` });
      const blobPath = path.join(this.directory, entry.stagedFile);
      await writeFileDurable(blobPath, content);
      const persisted = await fs.readFile(blobPath);
      if (sha256(persisted) !== entry.contentHash) {
        throw new PlatformError({ code: 'PATCH_STAGE_CORRUPT', message: `Staged content failed its integrity check: ${entry.path}.` });
      }
    }

    // Capture originals and backups before the decision point.
    for (const entry of this.journal.entries) {
      const target = await assertSafeTarget(this.journal.workspaceRoot, entry.path);
      const stat = await fs.lstat(target).catch(() => null);
      if (!stat) {
        entry.original = { existed: false };
        continue;
      }
      if (stat.isDirectory()) {
        throw new ValidationError(`Patch target is a directory, not a file: ${entry.path}`, { path: entry.path });
      }
      const original = await fs.readFile(target);
      const backupFile = path.posix.join('backup', `${String(this.journal.entries.indexOf(entry)).padStart(4, '0')}-${sha256(original).slice(0, 16)}.orig`);
      await writeFileDurable(path.join(this.directory, backupFile), original);
      entry.original = {
        existed: true,
        hash: sha256(original),
        size: original.byteLength,
        mode: stat.mode & 0o777,
        backupFile,
      };
    }

    if (options.validate) {
      const staging = this.journal.entries.map((entry) => ({
        path: entry.path,
        action: entry.action,
        content: entry.action === 'put' && entry.stagedFile
          ? stagedContent.get(`${this.directory}:${entry.stagedFile}`) ?? null
          : null,
      }));
      await options.validate(staging);
    }

    this.journal.state = 'prepared';
    await this.persist();
  }

  /** Phase 2. Records the commit decision, then applies every entry atomically. */
  async commit(): Promise<PatchResult> {
    this.assertOpen();
    if (this.journal.state === 'open') await this.prepare();
    if (this.journal.state !== 'prepared') {
      throw new PlatformError({ code: 'PATCH_BAD_STATE', message: `Cannot commit a ${this.journal.state} transaction.`, statusCode: 409 });
    }

    // Pre-apply precondition check. Files may have changed on disk since
    // prepare() hashed them (manual edit in the editor, a formatter, another
    // agent). Refuse to destroy that work: the commit decision is not yet
    // durable, so throwing here leaves the workspace untouched.
    for (const entry of this.journal.entries) {
      if (!entry.original.existed || !entry.original.hash) continue;
      const target = await assertSafeTarget(this.journal.workspaceRoot, entry.path);
      const current = await fs.readFile(target).catch(() => null);
      const currentHash = current ? sha256(current) : null;
      if (currentHash !== entry.original.hash) {
        throw new PlatformError({
          code: 'PATCH_TARGET_CHANGED',
          message: `${entry.path} changed on disk after it was staged; the patch was not applied. Re-read the file and retry.`,
          statusCode: 409,
          details: { path: entry.path },
        });
      }
    }

    const started = this.now();
    this.journal.state = 'committing';
    await this.persist();

    try {
      const changes = await applyJournal(this.journal, this.directory);
      this.journal.state = 'committed';
      await this.persist();

      const written = changes.filter((change) => change.action === 'created' || change.action === 'modified').length;
      const deleted = changes.filter((change) => change.action === 'deleted').length;
      this.finished = true;

      return {
        transactionId: this.journal.id,
        workspaceRoot: this.journal.workspaceRoot,
        state: 'committed',
        changes,
        filesWritten: written,
        filesDeleted: deleted,
        durationMs: this.now() - started,
      };
    } catch (error) {
      // The decision was durable; record an explicit rollback intent before
      // touching the workspace so crash recovery knows not to roll forward.
      this.journal.state = 'rolling_back';
      await this.persist().catch(() => undefined);
      const rollbackError = await rollbackJournal(this.journal, this.directory).catch((failure) => failure);
      this.journal.state = 'failed';
      this.journal.error = error instanceof Error ? error.message : String(error);
      await this.persist().catch(() => undefined);
      this.finished = true;
      if (rollbackError instanceof Error) {
        throw new PlatformError({
          code: 'PATCH_ROLLBACK_FAILED',
          message: 'The patch failed and automatic rollback also failed; manual recovery is required.',
          statusCode: 500,
          cause: rollbackError,
          details: { transactionId: this.journal.id },
        });
      }
      throw error instanceof PlatformError
        ? error
        : new PlatformError({
          code: 'PATCH_COMMIT_FAILED',
          message: 'The patch failed and was rolled back.',
          statusCode: 500,
          cause: error,
          details: { transactionId: this.journal.id },
        });
    } finally {
      await this.cleanupBlobs();
      await releaseWorkspaceLock(this.lockFile);
      this.lockFile = null;
      this.releaseMutex?.();
      this.releaseMutex = null;
    }
  }

  /** Abort a transaction that has not committed. Never throws for a clean abort. */
  async abort(reason?: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    try {
      if (this.journal.state === 'committing') {
        this.journal.state = 'rolling_back';
        await this.persist().catch(() => undefined);
        await rollbackJournal(this.journal, this.directory);
      }
      this.journal.state = 'rolled_back';
      if (reason) this.journal.error = reason;
      await this.persist();
    } finally {
      await this.cleanupBlobs();
      await releaseWorkspaceLock(this.lockFile);
      this.lockFile = null;
      this.releaseMutex?.();
      this.releaseMutex = null;
    }
  }

  private assertOpen(): void {
    if (this.finished) throw new PlatformError({ code: 'PATCH_FINISHED', message: 'This patch transaction is already finished.', statusCode: 409 });
  }

  private totalStagedBytes(): number {
    return this.journal.entries.reduce((sum, entry) => sum + (entry.action === 'put' ? entry.size : 0), 0);
  }

  private async cleanupBlobs(): Promise<void> {
    await fs.rm(path.join(this.directory, 'staged'), { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(path.join(this.directory, 'backup'), { recursive: true, force: true }).catch(() => undefined);
    const prefix = `${this.directory}:`;
    for (const key of stagedContent.keys()) {
      if (key.startsWith(prefix)) stagedContent.delete(key);
    }
  }
}

/**
 * Staged content is kept in memory keyed by transaction+blob path. This map is
 * deliberately module-local: it is the handoff between `stagePut` and
 * `prepare`, and it is cleared when a transaction finishes.
 */
const stagedContent = new Map<string, Buffer>();

async function applyJournal(journal: Journal, directory: string): Promise<PatchChange[]> {
  const changes: PatchChange[] = [];

  for (const entry of journal.entries) {
    const target = await assertSafeTarget(journal.workspaceRoot, entry.path);
    const beforeHash = entry.original.hash;

    if (entry.action === 'delete') {
      if (!entry.original.existed) {
        changes.push({ path: entry.path, action: 'unchanged', size: 0 });
        continue;
      }
      // Recovery replays 'committing' journals after a crash: a delete that
      // already happened must not fail the roll-forward.
      await fs.unlink(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return;
        throw error;
      });
      await fsyncDirectory(path.dirname(target));
      changes.push({ path: entry.path, action: 'deleted', ...(beforeHash ? { beforeHash } : {}), size: entry.original.size ?? 0 });
      continue;
    }

    if (!entry.stagedFile) throw new PlatformError({ code: 'PATCH_NO_STAGED_FILE', message: `No staged file for ${entry.path}.` });
    const content = await fs.readFile(path.join(directory, entry.stagedFile));
    if (sha256(content) !== entry.contentHash) {
      throw new PlatformError({ code: 'PATCH_STAGE_CORRUPT', message: `Staged content changed after prepare: ${entry.path}.` });
    }

    if (entry.original.existed && entry.original.hash === entry.contentHash) {
      changes.push({ path: entry.path, action: 'unchanged', beforeHash, afterHash: entry.contentHash, size: entry.size });
      continue;
    }

    const mode = entry.original.mode ?? 0o644;
    await atomicReplace(target, content, mode);
    changes.push({
      path: entry.path,
      action: entry.original.existed ? 'modified' : 'created',
      ...(beforeHash ? { beforeHash } : {}),
      afterHash: entry.contentHash,
      size: entry.size,
    });
  }

  return changes;
}

async function rollbackJournal(journal: Journal, directory: string): Promise<void> {
  for (const entry of [...journal.entries].reverse()) {
    const target = await assertSafeTarget(journal.workspaceRoot, entry.path);
    if (entry.original.existed && entry.original.backupFile) {
      const backup = await fs.readFile(path.join(directory, entry.original.backupFile));
      if (entry.original.hash && sha256(backup) !== entry.original.hash) {
        throw new PlatformError({ code: 'PATCH_BACKUP_CORRUPT', message: `Backup checksum mismatch for ${entry.path}.` });
      }
      await atomicReplace(target, backup, entry.original.mode ?? 0o644);
    } else {
      await fs.unlink(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await fsyncDirectory(path.dirname(target));
    }
  }
}

/**
 * Recover transactions interrupted by a crash.
 *
 * Call once at startup, before serving traffic.
 */
export async function recoverTransactions(transactionRoot: string, options: { retainDays?: number; now?: () => number } = {}): Promise<{
  recovered: string[];
  rolledBack: string[];
  failed: string[];
}> {
  const root = path.resolve(transactionRoot);
  const now = options.now ?? Date.now;
  const result = { recovered: [] as string[], rolledBack: [] as string[], failed: [] as string[] };
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'locks') continue;
    const directory = path.join(root, entry.name);
    const journalPath = path.join(directory, JOURNAL_FILE);
    let journal: Journal;
    try {
      journal = JSON.parse(await fs.readFile(journalPath, 'utf8')) as Journal;
    } catch {
      continue;
    }
    if (!journal || journal.version !== 1 || !Array.isArray(journal.entries)) continue;

    try {
      if (journal.state === 'committing') {
        // The commit decision is durable: roll forward, then verify hashes.
        await applyJournal(journal, directory);
        journal.state = 'committed';
        journal.updatedAt = now();
        await writeFileDurable(journalPath, JSON.stringify(journal, null, 2));
        result.recovered.push(journal.id);
      } else if (journal.state === 'rolling_back') {
        // A commit failed before the crash and rollback was in progress.
        await rollbackJournal(journal, directory);
        journal.state = 'rolled_back';
        journal.updatedAt = now();
        await writeFileDurable(journalPath, JSON.stringify(journal, null, 2));
        result.rolledBack.push(journal.id);
      } else if (journal.state === 'prepared' || journal.state === 'open') {
        // No commit decision was recorded. Nothing was applied, but backups
        // may exist; mark the transaction aborted so it is never replayed.
        journal.state = 'rolled_back';
        journal.updatedAt = now();
        journal.error = 'Recovered after an interrupted transaction.';
        await writeFileDurable(journalPath, JSON.stringify(journal, null, 2));
        result.rolledBack.push(journal.id);
      }

      await fs.rm(path.join(directory, 'staged'), { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(path.join(directory, 'backup'), { recursive: true, force: true }).catch(() => undefined);
    } catch {
      result.failed.push(journal.id);
    }
  }

  // Prune finished journals past retention.
  const retainDays = options.retainDays ?? 7;
  const cutoff = now() - retainDays * 86_400_000;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'locks') continue;
    const directory = path.join(root, entry.name);
    try {
      const journal = JSON.parse(await fs.readFile(path.join(directory, JOURNAL_FILE), 'utf8')) as Journal;
      const finished = ['committed', 'rolled_back', 'failed'].includes(journal.state);
      if (finished && journal.updatedAt < cutoff) await fs.rm(directory, { recursive: true, force: true });
    } catch {
      /* not a transaction directory */
    }
  }

  // Locks left by dead processes are harmless (they are stolen on demand),
  // but removing stale ones keeps the directory small.
  const lockDir = path.join(root, 'locks');
  for (const lock of await fs.readdir(lockDir).catch(() => [])) {
    const file = path.join(lockDir, lock);
    try {
      const holder = JSON.parse(await fs.readFile(file, 'utf8')) as { pid?: number; acquiredAt?: number };
      if (!holder.pid || (!isProcessAlive(holder.pid) && now() - (holder.acquiredAt ?? 0) > 60_000)) {
        await fs.unlink(file);
      }
    } catch {
      await fs.unlink(file).catch(() => undefined);
    }
  }

  return result;
}

/**
 * Convenience wrapper for one-shot patches: stage, validate, commit.
 * On any failure the workspace is restored and the error is rethrown.
 */
export async function applyPatch(options: TransactionOptions & {
  files: PatchInput[];
  validate?: (entries: ReadonlyArray<{ path: string; action: PatchAction; content: Buffer | null }>) => Promise<void> | void;
}): Promise<PatchResult> {
  const transaction = await PatchTransaction.begin(options);
  try {
    transaction.stageAll(options.files);
    await transaction.prepare({ validate: options.validate });
    return await transaction.commit();
  } catch (error) {
    await transaction.abort(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
