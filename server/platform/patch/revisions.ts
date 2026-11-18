/**
 * Immutable project revisions.
 *
 * Every committed patch can produce a revision: a manifest of
 * `{path, sha256, size, mode}` plus the blobs themselves in a content-addressed
 * store. Identical files are stored once; restoring any revision rewrites the
 * workspace through the transactional patch engine, so a bad restore is as
 * impossible as a bad commit.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prefixedId } from '../kernel/ids.js';
import type { Clock } from '../kernel/clock.js';
import { systemClock } from '../kernel/clock.js';
import { NotFoundError, PlatformError } from '../kernel/errors.js';
import type { Database } from '../storage/database.js';
import type { AuditLog } from '../audit/auditLog.js';
import {
  applyPatch,
  normalizePatchPath,
  type PatchResult,
} from './transaction.js';

const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', '.dart_tool', '.flutterforge', '.dsh', '.idea', '.vscode',
  '.gradle', '.cxx', '.symlinks', 'build', 'node_modules', 'Pods', 'ephemeral',
  '.plugin_symlinks', 'dist', 'dist-server', 'coverage', '.next',
]);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 5000;

export interface RevisionFile {
  path: string;
  hash: string;
  size: number;
  mode: number;
}

export interface RevisionManifest {
  files: RevisionFile[];
  totalBytes: number;
}

export interface Revision {
  id: string;
  tenantId: string;
  projectId: string;
  parentId?: string;
  message: string;
  actor: string;
  fileCount: number;
  totalBytes: number;
  createdAt: number;
}

export interface RevisionStoreOptions {
  db: Database;
  blobRoot: string;
  clock?: Clock;
  audit?: AuditLog;
}

export class RevisionStore {
  private readonly db: Database;
  private readonly blobRoot: string;
  private readonly clock: Clock;
  private readonly audit?: AuditLog;

  constructor(options: RevisionStoreOptions) {
    this.db = options.db;
    this.blobRoot = options.blobRoot;
    this.clock = options.clock ?? systemClock;
    this.audit = options.audit;
  }

  /** Snapshot a workspace and store any missing blobs. Does not create a revision row. */
  async snapshot(workspaceRoot: string): Promise<{ manifest: RevisionManifest; blobs: Map<string, string> }> {
    const root = path.resolve(workspaceRoot);
    const manifest: RevisionManifest = { files: [], totalBytes: 0 };
    const blobs = new Map<string, string>();

    const walk = async (directory: string): Promise<void> => {
      if (manifest.files.length >= MAX_FILES) return;
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
      for (const entry of entries) {
        if (manifest.files.length >= MAX_FILES) return;
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(root, absolute).replaceAll(path.sep, '/');

        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          await walk(absolute);
          continue;
        }
        if (!entry.isFile()) continue;

        let stat;
        try {
          stat = await fs.lstat(absolute);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;

        const content = await fs.readFile(absolute);
        const hash = createHash('sha256').update(content).digest('hex');
        manifest.files.push({ path: relative, hash, size: content.byteLength, mode: stat.mode & 0o777 });
        manifest.totalBytes += content.byteLength;
        blobs.set(relative, hash);
      }
    };

    await walk(root);
    manifest.files.sort((a, b) => a.path.localeCompare(b.path));
    return { manifest, blobs };
  }

  private blobPath(hash: string): string {
    return path.join(this.blobRoot, hash.slice(0, 2), hash);
  }

  async storeBlobs(workspaceRoot: string, manifest: RevisionManifest): Promise<void> {
    await fs.mkdir(this.blobRoot, { recursive: true });
    for (const file of manifest.files) {
      const target = this.blobPath(file.hash);
      try {
        const stat = await fs.stat(target);
        if (stat.size === file.size) continue; // content-addressed: same name means same content
      } catch {
        /* missing: store it */
      }
      const source = path.join(path.resolve(workspaceRoot), file.path);
      const content = await fs.readFile(source);
      const digest = createHash('sha256').update(content).digest('hex');
      if (digest !== file.hash) {
        throw new PlatformError({ code: 'REVISION_DIGEST_MISMATCH', message: `File changed while its revision was being created: ${file.path}. Retry the commit.` });
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(temporary, content);
      await fs.rename(temporary, target);
    }
  }

  async commitRevision(input: {
    tenantId: string;
    projectId: string;
    workspaceRoot: string;
    message: string;
    actor: string;
  }): Promise<Revision> {
    const { manifest } = await this.snapshot(input.workspaceRoot);
    await this.storeBlobs(input.workspaceRoot, manifest);

    const now = this.clock.now();
    const id = prefixedId('rev', now);
    const parent = await this.db.get<{ id: string }>(
      `SELECT id FROM project_revisions WHERE tenant_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 1`,
      input.tenantId, input.projectId,
    );

    await this.db.run(
      `INSERT INTO project_revisions
         (id, tenant_id, project_id, parent_id, message, actor, manifest_json, file_count, total_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.tenantId, input.projectId, parent?.id ?? null, input.message, input.actor,
      JSON.stringify(manifest), manifest.files.length, manifest.totalBytes, now,
    );

    await this.audit?.append({
      tenantId: input.tenantId,
      actor: input.actor,
      action: 'project.revision.create',
      resourceType: 'project_revision',
      resourceId: id,
      metadata: { projectId: input.projectId, fileCount: manifest.files.length, totalBytes: manifest.totalBytes, parentId: parent?.id ?? null, message: input.message },
    });

    return {
      id,
      tenantId: input.tenantId,
      projectId: input.projectId,
      parentId: parent?.id,
      message: input.message,
      actor: input.actor,
      fileCount: manifest.files.length,
      totalBytes: manifest.totalBytes,
      createdAt: now,
    };
  }

  async listRevisions(options: { tenantId: string; projectId: string; limit?: number }): Promise<Revision[]> {
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const rows = await this.db.all<any>(
      `SELECT * FROM project_revisions WHERE tenant_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT ?`,
      options.tenantId, options.projectId, limit,
    );
    return rows.map(mapRevision);
  }

  async getRevision(id: string): Promise<Revision | null> {
    const row = await this.db.get<any>('SELECT * FROM project_revisions WHERE id = ?', id);
    return row ? mapRevision(row) : null;
  }

  async getManifest(id: string): Promise<RevisionManifest> {
    const row = await this.db.get<{ manifest_json: string }>('SELECT manifest_json FROM project_revisions WHERE id = ?', id);
    if (!row) throw new NotFoundError('Revision', id);
    const parsed = JSON.parse(row.manifest_json);
    return { files: parsed.files ?? [], totalBytes: parsed.totalBytes ?? 0 };
  }

  /**
   * Restore a revision into `workspaceRoot` through the transactional patch
   * engine: every file in the manifest is written, every file currently in the
   * workspace but missing from the manifest is deleted, all in one atomic
   * transaction.
   */
  async restoreRevision(options: {
    revisionId: string;
    tenantId: string;
    actor: string;
    workspaceRoot: string;
    transactionRoot: string;
  }): Promise<PatchResult> {
    const revision = await this.getRevision(options.revisionId);
    if (!revision) throw new NotFoundError('Revision', options.revisionId);
    if (revision.tenantId !== options.tenantId) {
      throw new PlatformError({ code: 'TENANT_MISMATCH', message: 'This revision belongs to another tenant.', statusCode: 403 });
    }

    const manifest = await this.getManifest(options.revisionId);
    const desired = new Map(manifest.files.map((file) => [file.path, file]));

    // Read blobs before touching the workspace, so a missing blob aborts cleanly.
    const contents = new Map<string, Buffer>();
    for (const file of manifest.files) {
      const blob = this.blobPath(file.hash);
      const content = await fs.readFile(blob).catch(() => {
        throw new PlatformError({ code: 'REVISION_BLOB_MISSING', message: `Missing blob ${file.hash} for ${file.path}.` });
      });
      if (createHash('sha256').update(content).digest('hex') !== file.hash) {
        throw new PlatformError({ code: 'REVISION_BLOB_CORRUPT', message: `Blob ${file.hash} failed its integrity check.` });
      }
      contents.set(file.path, content);
    }

    const current = await this.snapshot(options.workspaceRoot);
    const files: Array<{ path: string; content: Buffer | null }> = [];

    for (const file of manifest.files) {
      files.push({ path: normalizePatchPath(file.path), content: contents.get(file.path)! });
    }
    for (const file of current.manifest.files) {
      if (!desired.has(file.path)) files.push({ path: file.path, content: null });
    }

    const result = await applyPatch({
      transactionRoot: options.transactionRoot,
      workspaceRoot: options.workspaceRoot,
      actor: options.actor,
      message: `restore:${options.revisionId}:${revision.message}`,
      files,
    });

    await this.audit?.append({
      tenantId: options.tenantId,
      actor: options.actor,
      action: 'project.revision.restore',
      resourceType: 'project_revision',
      resourceId: options.revisionId,
      metadata: { projectId: revision.projectId, filesWritten: result.filesWritten, filesDeleted: result.filesDeleted },
    });

    return result;
  }
}

function mapRevision(row: any): Revision {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    parentId: row.parent_id ?? undefined,
    message: row.message,
    actor: row.actor,
    fileCount: row.file_count,
    totalBytes: row.total_bytes,
    createdAt: row.created_at,
  };
}
