/**
 * Runtime ports: real adapters for database, artifacts, checkpoints, preview
 * and browser access. All persistence is confined to the project data dir and
 * all reads are tenant/project scoped by the caller.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Database } from '../storage/database.js';
import type {
  ArtifactPort,
  BrowserConsoleEntry,
  BrowserPort,
  BrowserSnapshot,
  CheckpointPort,
  CheckpointRecord,
  DatabasePort,
  PreviewPort,
  PreviewStatus,
} from './types.js';
import { isInside, stamp, truncate } from './util.js';
import { resolveInside } from './paths.js';
import { snapshotFiles } from '../../harness/workspace.js';
import { ChromeBrowser, UnavailableBrowser, resolveChromePath } from './browser.js';

const DENIED_TABLES = /(?:credential|user|account|auth|token|session|payment|razorpay|secret|api_key)/i;
const MAX_ROWS = 200;

export function createDatabasePort(db: Database): DatabasePort {
  return {
    async schema() {
      const tables = await db.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      );
      const result: Array<{ table: string; columns: string[] }> = [];
      for (const table of tables) {
        if (DENIED_TABLES.test(table.name)) continue;
        const columns = await db.all<{ name: string }>(`PRAGMA table_info(${JSON.stringify(table.name)})`);
        result.push({ table: table.name, columns: columns.map((column) => column.name) });
      }
      return result;
    },
    async query(sql: string, params: unknown[] = []) {
      const trimmed = String(sql ?? '').trim().replace(/;+\s*$/, '');
      if (trimmed === '') throw new Error('SQL is empty.');
      if (trimmed.includes(';')) throw new Error('Only one statement per query is allowed.');
      if (!/^(select|with|explain)\b/i.test(trimmed)) throw new Error('Only read-only SELECT/WITH/EXPLAIN queries are allowed.');
      if (/\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|replace)\b/i.test(trimmed)) {
        throw new Error('Write, DDL and PRAGMA statements are not allowed.');
      }
      for (const table of await db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)) {
        if (DENIED_TABLES.test(table.name) && new RegExp(`\\b${table.name}\\b`, 'i').test(trimmed)) {
          throw new Error(`Table "${table.name}" is not accessible through the engineer database tool.`);
        }
      }
      const wrapped = /^explain\b/i.test(trimmed) ? trimmed : `SELECT * FROM (${trimmed}) LIMIT ${MAX_ROWS + 1}`;
      const rows = await db.all<Record<string, unknown>>(wrapped, ...params);
      if (rows.length > MAX_ROWS) throw new Error(`Query returned more than ${MAX_ROWS} rows; add a WHERE clause or LIMIT.`);
      return rows;
    },
  };
}

/** Fallback used only when a runtime is constructed without a database. */
export function createEmptyDatabasePort(): DatabasePort {
  return {
    async schema() { return []; },
    async query() { throw new Error('No platform database is attached to this engine runtime.'); },
  };
}

export function createArtifactPort(dataDir: string, projectId: string): ArtifactPort {
  const key = createHash('sha256').update(projectId).digest('hex').slice(0, 16);
  const root = path.join(dataDir, 'engine', 'artifacts', key);
  return {
    async write(name, bytes, contentType = 'application/octet-stream') {
      await fs.mkdir(root, { recursive: true });
      const safe = String(name).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 160) || `artifact-${Date.now()}`;
      const file = path.join(root, safe);
      await fs.writeFile(file, bytes);
      await fs.writeFile(`${file}.meta.json`, JSON.stringify({ contentType, bytes: bytes.length, at: Date.now() }), 'utf8');
      return file;
    },
  };
}

interface CheckpointFile {
  id: string;
  label: string;
  createdAt: number;
  files: Record<string, string>;
}

export function createCheckpointPort(dataDir: string, projectId: string, projectRoot: string): CheckpointPort {
  const key = createHash('sha256').update(projectId).digest('hex').slice(0, 16);
  const root = path.join(dataDir, 'engine', 'checkpoints', key);

  function recordFor(file: CheckpointFile, filePath: string): CheckpointRecord {
    return { id: file.id, label: file.label, files: Object.keys(file.files).length, createdAt: file.createdAt, path: filePath };
  }

  return {
    async create(label) {
      const snapshot = await snapshotFiles(projectRoot);
      const files: Record<string, string> = {};
      let bytes = 0;
      for (const [filePath, entry] of snapshot) {
        bytes += entry.content.length;
        if (bytes > 64 * 1024 * 1024) throw new Error('Project is too large for an engine checkpoint (64 MiB limit).');
        files[filePath] = entry.content;
      }
      const record: CheckpointFile = {
        id: `${Date.now().toString(36)}-${createHash('sha1').update(`${projectId}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 8)}`,
        label: String(label ?? 'manual checkpoint').slice(0, 200),
        createdAt: Date.now(),
        files,
      };
      await fs.mkdir(root, { recursive: true });
      const filePath = path.join(root, `${record.id}.json`);
      await fs.writeFile(filePath, JSON.stringify(record), 'utf8');
      return recordFor(record, filePath);
    },
    async list() {
      await fs.mkdir(root, { recursive: true });
      const names = (await fs.readdir(root)).filter((name) => name.endsWith('.json'));
      const records: CheckpointRecord[] = [];
      for (const name of names) {
        const filePath = path.join(root, name);
        try {
          const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as CheckpointFile;
          records.push(recordFor(parsed, filePath));
        } catch {
          // A corrupt checkpoint must not hide the healthy ones.
        }
      }
      return records.sort((a, b) => b.createdAt - a.createdAt);
    },
    async restore(id) {
      const safe = String(id).replace(/[^A-Za-z0-9._-]+/g, '');
      const filePath = path.join(root, `${safe}.json`);
      if (!isInside(root, filePath)) throw new Error('Invalid checkpoint id.');
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as CheckpointFile;
      const current = await snapshotFiles(projectRoot);
      let restored = 0;
      let deleted = 0;
      for (const [relative, content] of Object.entries(parsed.files)) {
        const absolute = resolveInside(projectRoot, relative);
        if (!isInside(projectRoot, absolute)) continue;
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, content, 'utf8');
        restored += 1;
      }
      for (const relative of current.keys()) {
        if (parsed.files[relative] !== undefined) continue;
        const absolute = resolveInside(projectRoot, relative);
        if (!isInside(projectRoot, absolute)) continue;
        await fs.rm(absolute, { force: true });
        deleted += 1;
      }
      return { id: safe, restored, deleted };
    },
  };
}

interface PreviewServiceLike {
  startBuild(projectId: string, files: Array<{ path: string; content: string }>, meta?: Record<string, unknown>): Promise<{ statusCode: number; body: any }>;
  statusForProject(projectId: string): any;
  sessionStatus(sessionId: string): any;
  stop(sessionId: string): boolean;
  reload(projectId: string, options?: { restart?: boolean }): { ok: boolean; statusCode: number; body: any };
}

export function createPreviewPort(service: PreviewServiceLike | null): PreviewPort {
  function toStatus(raw: any): PreviewStatus | null {
    if (!raw) return null;
    return {
      sessionId: String(raw.sessionId ?? ''),
      projectId: String(raw.projectId ?? ''),
      status: raw.status === 'running' || raw.status === 'building' || raw.status === 'failed' || raw.status === 'stopped'
        ? raw.status
        : 'stopped',
      url: typeof raw.url === 'string' ? raw.url : null,
      port: typeof raw.port === 'number' ? raw.port : null,
      logs: Array.isArray(raw.logs) ? raw.logs.map((line: unknown) => truncate(String(line), 1000)) : [],
      diagnostics: Array.isArray(raw.diagnostics)
        ? raw.diagnostics.map((item: any) => ({
            severity: item?.severity === 'error' ? 'error' : item?.severity === 'warning' ? 'warning' : 'info',
            message: String(item?.message ?? ''),
            file: item?.path ? String(item.path) : undefined,
            line: typeof item?.line === 'number' ? item.line : undefined,
          }))
        : undefined,
    };
  }

  return {
    async start(projectId, files) {
      if (!service) throw new Error('Preview service is not attached to this engine runtime.');
      const result = await service.startBuild(projectId, files);
      if (result.statusCode !== 202) {
        const message = typeof result.body?.error === 'string' ? result.body.error : 'Preview build could not start.';
        throw new Error(message);
      }
      return {
        sessionId: String(result.body?.sessionId ?? ''),
        status: String(result.body?.status ?? 'building'),
        url: typeof result.body?.url === 'string' ? result.body.url : null,
      };
    },
    status(projectId) {
      if (!service) return null;
      return toStatus(service.statusForProject(projectId));
    },
    stop(sessionId) {
      if (!service) return false;
      return service.stop(sessionId);
    },
    reload(projectId, options) {
      if (!service) return { ok: false, body: { error: 'Preview service is not attached.' } };
      const result = service.reload(projectId, options);
      return { ok: result.ok, body: { ...result.body, statusCode: result.statusCode } };
    },
  };
}

/** Launches Chrome on first use and closes it when the run ends. */
export class LazyBrowser implements BrowserPort {
  private browser: BrowserPort | null = null;
  private starting: Promise<BrowserPort> | null = null;

  constructor(private readonly signal?: AbortSignal) {}

  private async browserPort(): Promise<BrowserPort> {
    if (this.browser) return this.browser;
    if (!this.starting) {
      if (!resolveChromePath()) {
        this.starting = Promise.resolve(new UnavailableBrowser(
          'Chrome/Chromium was not found. Set FLUTTERFORGE_CHROME_PATH to enable browser inspection.',
        ));
      } else {
        this.starting = ChromeBrowser.launch({ signal: this.signal }).then((browser) => {
          this.browser = browser;
          return browser;
        }).catch((error) => {
          this.starting = null;
          throw error;
        });
      }
    }
    return this.starting;
  }

  async navigate(url: string): Promise<BrowserSnapshot> { return (await this.browserPort()).navigate(url); }
  async snapshot(): Promise<BrowserSnapshot> { return (await this.browserPort()).snapshot(); }
  async click(input: { selector?: string; x?: number; y?: number }): Promise<string> { return (await this.browserPort()).click(input); }
  async typeText(input: { text: string; selector?: string; submit?: boolean }): Promise<string> { return (await this.browserPort()).typeText(input); }
  async pressKey(key: string): Promise<string> { return (await this.browserPort()).pressKey(key); }
  async screenshot(name: string): Promise<string> { return (await this.browserPort()).screenshot(name); }
  async console(): Promise<BrowserConsoleEntry[]> { return (await this.browserPort()).console(); }
  async close(): Promise<void> {
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.starting = null;
  }
}

export function artifactStamp(): string {
  return stamp();
}
