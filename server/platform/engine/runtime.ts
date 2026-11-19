import { loadGeneratorSettings, projectSkillContext } from './generatorSettings.js';
import { listProjectConnectorContext } from '../connectors/projectConnectors.js';
import { EngineerPreview } from './preview.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Command, Overwrite } from '@langchain/langgraph';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { Database } from '../storage/database.js';
import { ConflictError, NotFoundError, ValidationError } from '../kernel/errors.js';
import { createSandboxRunner, type SandboxRunner } from '../sandbox/index.js';
import { createEngineerGraph } from './graph.js';
import { createEngineerToolRegistry, type EngineerToolRegistry } from './tools/index.js';
import { createEngineerModel, resolveModelConfig } from './model.js';
import { createEngineCheckpointer } from './checkpointer.js';
import { ServerKeyPool } from './keyPool.js';
import { EngineEventBus } from './events.js';
import { ProjectMemoryStore } from './memory.js';
import { createArtifactPort, createCheckpointPort, createEmptyDatabasePort, LazyBrowser, createPreviewPort } from './runtimePorts.js';
import { verifyWorkspace } from './verification.js';
import { DEFAULT_BUDGET, type ToolContext, type EngineBudgetLimits, type SpecialistRole } from './types.js';
import type { EngineerStateType } from './state.js';
import { resolveInside } from './paths.js';
import { getCredentialBundle } from '../../credentials.js';
import { redact } from './util.js';

export interface RuntimeIdentity { tenantId: string; actor: string; projectId: string }
interface ThreadRow { id: string; tenant_id: string; project_id: string; status: string; run_id: string; lease: string | null; expires: number; pause: number }
export interface RuntimeOptions {
  db: Database; dataDir: string; checkpointer?: BaseCheckpointSaver;
  model?: BaseChatModel; specialistModel?: BaseChatModel; registry?: EngineerToolRegistry;
  context?: (base: ToolContext) => ToolContext;
  sandbox?: (root: string) => Promise<SandboxRunner>;
}
const buildOnly = Symbol('buildOnly');
const emptyUsage = { modelCalls: 0, toolCalls: 0, iterations: 0, promptTokens: 0, completionTokens: 0 };
export class EngineerRuntime {
  readonly events: EngineEventBus;
  private readonly previews = new Map<string, EngineerPreview>();
  private readonly contexts = new Map<string, ToolContext>();
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private graph!: ReturnType<typeof createEngineerGraph>;
  private saver!: BaseCheckpointSaver;
  readonly registry: EngineerToolRegistry;
  private constructor(private readonly options: RuntimeOptions) {
    this.events = new EngineEventBus(options.db);
    this.registry = options.registry ?? createEngineerToolRegistry();
  }
  static async create(options: RuntimeOptions) {
    const self = new EngineerRuntime(options);
    await options.db.exec(`CREATE TABLE IF NOT EXISTS engineer_threads (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL,
      run_id TEXT NOT NULL, lease TEXT, expires INTEGER NOT NULL DEFAULT 0, pause INTEGER NOT NULL DEFAULT 0,
      UNIQUE(tenant_id, project_id));
      CREATE TABLE IF NOT EXISTS engine_events (thread_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
      type TEXT NOT NULL, payload_json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(thread_id, seq));
      CREATE TABLE IF NOT EXISTS engineer_instructions (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, content TEXT NOT NULL);`);
    self.saver = (await createEngineCheckpointer({ dataDir: options.dataDir, checkpointer: options.checkpointer })).saver;
    const credentials = getCredentialBundle();
    const config = resolveModelConfig({ ...process.env, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || credentials.openrouter, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || credentials.deepseek });
    if (!options.model && !config) throw new ValidationError('Configure a server-side model API key before starting the engineer.');
    const pool = config ? new ServerKeyPool(config.apiKeys ?? [config.apiKey]) : undefined;
    const model = options.model ?? createEngineerModel(config!, self.registry.langchainTools(), pool);
    const specialistModel = options.specialistModel ?? (config && !options.model ? createEngineerModel(config, [], pool, 700) : undefined);
    self.graph = createEngineerGraph({ registry: self.registry, model, specialistModel, checkpointer: self.saver,
      contextFor: id => { const context = self.contexts.get(id); if (!context) throw new Error('No active execution context.'); return context; } });
    return self;
  }
  threadId(identity: RuntimeIdentity) {
    return createHash('sha256').update(JSON.stringify([identity.tenantId, identity.projectId])).digest('hex');
  }
  async row(identity: RuntimeIdentity): Promise<ThreadRow> {
    const row = await this.options.db.get<ThreadRow>('SELECT * FROM engineer_threads WHERE id = ? AND tenant_id = ? AND project_id = ?', this.threadId(identity), identity.tenantId, identity.projectId);
    if (!row) throw new NotFoundError('Engineer thread');
    return row;
  }
  async state(identity: RuntimeIdentity) {
    const row = await this.row(identity);
    const snapshot = await this.graph.getState({ configurable: { thread_id: row.id } });
    const state = snapshot.values as EngineerStateType;
    const interrupts = snapshot.tasks.flatMap(t => t.interrupts ?? []);
    const latest = await this.options.db.get<{ payload_json: string }>("SELECT payload_json FROM engine_events WHERE thread_id = ? AND run_id = ? AND type IN ('status', 'failed', 'cancelled') ORDER BY seq DESC LIMIT 1", row.id, row.run_id);
    const event = latest ? JSON.parse(latest.payload_json) : null;
    return { threadId: row.id, runId: row.run_id, status: row.lease && row.expires < Date.now() ? 'interrupted' : row.status === 'reasoning' ? event?.status ?? row.status : row.status,
      objective: state.objective, summary: state.finalSummary, error: row.status === 'failed' ? event?.message ?? state.error : state.runId === row.run_id ? state.error : null, changedFiles: state.changedFiles ?? [],
      preview: this.previews.get(row.id)?.status() ?? null, verification: state.verification, specialistReports: state.runId === row.run_id ? state.specialistReports ?? [] : [], usage: state.usage, approval: state.approvalRequest, approvalHistory: state.approvalHistory ?? [], interrupts };
  }
  async start(identity: RuntimeIdentity, prompt: string, files: Array<{ path: string; content: string }> = [], budgets: Partial<EngineBudgetLimits> = {}, specialists?: SpecialistRole[]) {
    if (!prompt.trim() || prompt.length > 32000) throw new ValidationError('Prompt must contain 1–32000 characters.');
    const id = this.threadId(identity);
    await this.options.db.run('INSERT OR IGNORE INTO engineer_threads (id, tenant_id, project_id, status, run_id) VALUES (?, ?, ?, ?, ?)', id, identity.tenantId, identity.projectId, 'idle', '');
    const row = await this.row(identity);
    if (['awaiting_approval', 'paused', 'interrupted'].includes(row.status) || (row.lease && row.expires < Date.now())) throw new ConflictError('Resume or cancel the existing execution first.');
    const budget = { ...DEFAULT_BUDGET, ...budgets };
    for (const key of Object.keys(DEFAULT_BUDGET) as Array<keyof EngineBudgetLimits>) {
      if (!Number.isInteger(budget[key]) || budget[key] < 1 || budget[key] > DEFAULT_BUDGET[key]) throw new ValidationError(`Invalid ${key} budget.`);
    }
    const settings = await loadGeneratorSettings(this.options.db, identity.tenantId, identity.projectId);
    return this.launch(identity, async context => {
      const existing = await this.graph.getState({ configurable: { thread_id: id } });
      // Existing workspaces are authoritative; never overwrite them with a stale browser snapshot.
      if (!existing.values.project) {
        if (files.length > 3000 || files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) > 32 * 1024 * 1024) throw new ValidationError('Initial project snapshot is too large.');
        for (const file of files) {
          const target = resolveInside(context.projectRoot, file.path);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, file.content, { flag: 'wx' });
        }
      }
      await context.checkpoints.create('Before execution');
      return { messages: [...((existing.values.pendingToolCalls ?? []) as Array<{ id: string; name: string }>).map(call => new ToolMessage({ tool_call_id: call.id, name: call.name, content: 'Previous execution ended; this pending call was not executed.' })), new HumanMessage(prompt)], objective: prompt, threadId: id, runId: context.runId,
        tenantId: identity.tenantId, actor: identity.actor,
        project: { projectId: identity.projectId, root: context.projectRoot, framework: 'flutter', targets: ['web'] },
        specialists: [...new Set(specialists ?? settings.specialists)], specialistReports: new Overwrite([]),
        startedAt: Date.now(), budget, usage: new Overwrite(emptyUsage), changedFiles: new Overwrite([]), diagnostics: new Overwrite([]),
        toolCalls: new Overwrite([]), verification: null, verificationRequired: true, verifyAttempts: 0,
        pendingToolCalls: [], approvedToolCallIds: [], deniedToolCallIds: [], pendingInstructions: [], status: 'reasoning', error: null, finalSummary: '', cancellationRequested: false, approvalRequest: null,
        memoryContext: new Overwrite([...(await context.memory.list(identity.projectId)).map(m => m.content), ...await listProjectConnectorContext(this.options.db, identity), projectSkillContext(settings.skills)]) };
    });
  }
  async build(identity: RuntimeIdentity) {
    const row = await this.row(identity);
    if (['awaiting_approval', 'paused', 'interrupted'].includes(row.status) || row.lease) throw new ConflictError('Finish the current execution before building.');
    return this.launch(identity, async () => buildOnly);
  }
  async resume(identity: RuntimeIdentity, input: { approvalId?: string; approved?: boolean; instruction?: string } = {}) {
    const state = await this.state(identity);
    if (!['awaiting_approval', 'paused', 'interrupted'].includes(state.status)) throw new ConflictError('This execution is not resumable.');
    if (state.approval) {
      if (state.approval.id !== input.approvalId || typeof input.approved !== 'boolean') throw new ValidationError('An explicit decision and matching approvalId are required.');
    } else if (input.approvalId) throw new ValidationError('There is no pending approval.');
    await this.options.db.run('UPDATE engineer_threads SET pause = 0 WHERE id = ?', state.threadId);
    if (input.instruction) await this.instruct(identity, input.instruction);
    return this.launch(identity, async () => state.interrupts.length
      ? new Command({ resume: state.approval ? { approvalId: input.approvalId, approved: input.approved, actor: identity.actor } : true })
      : null, true);
  }
  async instruct(identity: RuntimeIdentity, content: string) {
    const row = await this.row(identity);
    if (!content.trim() || content.length > 8000) throw new ValidationError('Instruction must contain 1–8000 characters.');
    await this.options.db.run('INSERT INTO engineer_instructions (thread_id, content) VALUES (?, ?)', row.id, content);
  }
  async control(identity: RuntimeIdentity, action: 'pause' | 'cancel') {
    const row = await this.row(identity);
    if (action === 'pause') {
      await this.options.db.run('UPDATE engineer_threads SET pause = 1 WHERE id = ?', row.id);
    } else {
      await this.options.db.run("UPDATE engineer_threads SET status = 'cancelled' WHERE id = ?", row.id);
      const active = this.active.get(row.id);
      active?.abort.abort();
      if (active) await active.done;
    }
  }
  private async launch(identity: RuntimeIdentity, input: (context: ToolContext) => Promise<any>, continuing = false) {
    const id = this.threadId(identity), lease = randomUUID();
    if (this.active.has(id)) throw new ConflictError('A run already owns this project.');
    const previous = await this.row(identity);
    const runId = continuing ? previous.run_id : randomUUID();
    const claimed = await this.options.db.run("UPDATE engineer_threads SET lease = ?, expires = ?, status = 'reasoning', run_id = ? WHERE id = ? AND (lease IS NULL OR expires < ?)", lease, Date.now() + 120000, runId, id, Date.now());
    if (!claimed.changes) throw new ConflictError('A run already owns this project.');
    const abort = new AbortController();
    const done = this.execute(identity, id, runId, lease, abort, input).finally(() => this.active.delete(id));
    this.active.set(id, { abort, done });
    // Errors are persisted in execute; no unhandled background rejection.
    void done.catch(() => undefined);
    return { threadId: id, runId };
  }
  private async execute(identity: RuntimeIdentity, id: string, runId: string, lease: string, abort: AbortController, input: (context: ToolContext) => Promise<any>) {
    let context: ToolContext | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const deadline = setTimeout(() => abort.abort(), DEFAULT_BUDGET.maxWallMs);
    let pause = false;
    const queued: string[] = [];
    try {
      await this.events.prime(id);
      const root = path.join(this.options.dataDir, 'engine', 'projects', id);
      await fs.mkdir(root, { recursive: true });
      let worker: SandboxRunner | undefined;
      const sandbox: SandboxRunner = this.options.sandbox ? await this.options.sandbox(root) : {
        run: async (command, options) => {
          worker ??= (await createSandboxRunner({ workspaceRoot: root, mode: 'docker', requireIsolation: true, network: 'bridge', limits: { memoryMb: 2048, cpuCores: 2, pidsLimit: 256 } })).runner;
          return worker.run(command, options);
        },
        dispose: async () => { await worker?.dispose?.(); },
      };
      let preview = this.previews.get(id);
      if (!preview) { preview = new EngineerPreview(identity.projectId, root); this.previews.set(id, preview); }
      context = { ...identity, threadId: id, runId, projectRoot: root, artifactsDir: path.join(this.options.dataDir, 'engine', 'artifacts'),
        sandbox, signal: abort.signal, preview: createPreviewPort(null), memory: new ProjectMemoryStore(this.options.db, identity.tenantId),
        database: createEmptyDatabasePort(), artifacts: createArtifactPort(this.options.dataDir, id),
        checkpoints: createCheckpointPort(this.options.dataDir, id, root), browser: new LazyBrowser(abort.signal),
        verify: async () => verifyWorkspace(context!), takeInstructions: () => queued.splice(0), cancelled: () => abort.signal.aborted,
        paused: () => pause, emit: event => this.events.publish(id, runId, JSON.parse(redact(JSON.stringify(event)))) };
      context.preview = preview.bind(context);
      context.verify = async () => {
        const result = await verifyWorkspace(context!);
        if (result.passed) {
          const published = await preview!.publish();
          context!.emit({ type: 'progress', phase: 'preview', message: 'Verified web preview is running.', previewUrl: published.url });
        }
        return result;
      };
      if (this.options.context) context = this.options.context(context);
      this.contexts.set(id, context);
      const poll = async () => {
        const result = await this.options.db.run('UPDATE engineer_threads SET expires = ? WHERE id = ? AND lease = ?', Date.now() + 120000, id, lease);
        if (!result.changes) { abort.abort(); return; }
        const row = await this.row(identity);
        pause = row.pause === 1;
        if (row.status === 'cancelled') abort.abort();
        const rows = await this.options.db.all<{ id: number; content: string }>('SELECT id, content FROM engineer_instructions WHERE thread_id = ? ORDER BY id', id);
        if (rows.length) {
          queued.push(...rows.map(r => r.content));
          await this.options.db.run('DELETE FROM engineer_instructions WHERE thread_id = ? AND id <= ?', id, rows.at(-1)!.id);
        }
      };
      await poll();
      heartbeat = setInterval(() => { void poll().catch(() => abort.abort()); }, 1000);
      context.emit({ type: 'run_started', status: 'reasoning' });
      const graphInput = await input(context);
      if (graphInput === buildOnly) {
        context.emit({ type: 'status', status: 'verifying', message: 'Building the current source revision.' });
        const verification = await context.verify();
        const status = verification.passed ? 'completed' : 'failed';
        await this.graph.updateState({ configurable: { thread_id: id } }, {
          runId, verification, status, specialists: [], specialistReports: new Overwrite([]), error: verification.passed ? null : verification.summary,
          finalSummary: verification.summary, changedFiles: new Overwrite([]), usage: new Overwrite(emptyUsage),
        }, 'finalize');
        await this.options.db.run('UPDATE engineer_threads SET status = ? WHERE id = ? AND lease = ?', status, id, lease);
        context.emit({ type: 'status', status, message: verification.summary });
        return;
      }
      const result = await this.graph.invoke(graphInput, { configurable: { thread_id: id }, recursionLimit: DEFAULT_BUDGET.recursionLimit,
        signal: abort.signal, tags: ['flutterforge', 'single-engineer'], metadata: { projectId: identity.projectId, threadId: id, runId } });
      const snapshot = await this.graph.getState({ configurable: { thread_id: id } });
      const interrupted = snapshot.tasks.some(t => (t.interrupts?.length ?? 0) > 0);
      const status = interrupted ? (result.approvalRequest ? 'awaiting_approval' : 'paused') : result.status;
      await this.options.db.run('UPDATE engineer_threads SET status = ? WHERE id = ? AND lease = ?', status, id, lease);
      context.emit({ type: 'status', status });
    } catch (error) {
      const status = abort.signal.aborted ? 'cancelled' : 'failed';
      await this.options.db.run('UPDATE engineer_threads SET status = ? WHERE id = ? AND lease = ?', status, id, lease);
      this.events.publish(id, runId, { type: status, message: redact(error instanceof Error ? error.message : String(error)) });
    } finally {
      clearTimeout(deadline); if (heartbeat) clearInterval(heartbeat);
      await context?.browser.close().catch(() => undefined);
      await context?.sandbox.dispose?.().catch(() => undefined);
      this.contexts.delete(id);
      await this.events.flush();
      await this.options.db.run('UPDATE engineer_threads SET lease = NULL, expires = 0 WHERE id = ? AND lease = ?', id, lease);
    }
  }
  async editFile(identity: RuntimeIdentity, relative: string, content: string | null, expectedContent: string | null, destination?: string) {
    const row = await this.row(identity);
    if (['paused', 'awaiting_approval'].includes(row.status)) throw new ConflictError('Cancel or resume the pending execution before editing source.');
    const lease = randomUUID();
    const claimed = await this.options.db.run('UPDATE engineer_threads SET lease = ?, expires = ? WHERE id = ? AND lease IS NULL', lease, Date.now() + 120000, row.id);
    if (!claimed.changes) throw new ConflictError('Wait until the engineer finishes before saving source changes.');
    try {
      if (content !== null && Buffer.byteLength(content) > 2 * 1024 * 1024) throw new ValidationError('File exceeds the size limit.');
      const root = path.join(this.options.dataDir, 'engine', 'projects', row.id);
      const file = resolveInside(root, relative);
      const current = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (current !== expectedContent) throw new ConflictError('The file changed in the engine workspace. Reload before saving.');
      await createCheckpointPort(this.options.dataDir, row.id, root).create(`Before editing ${relative}`);
      if (destination) {
        const target = resolveInside(root, destination);
        if (await fs.stat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new ConflictError('A file already exists at the destination.');
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(file, target);
      } else if (content === null) {
        await fs.unlink(file);
      } else {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${lease}.tmp`; await fs.writeFile(temporary, content); await fs.rename(temporary, file);
      }
      const snapshot = await this.graph.getState({ configurable: { thread_id: row.id } });
      if (snapshot.values.project) await this.graph.updateState({ configurable: { thread_id: row.id } }, { verification: null });
      // Keep the last built revision available while edited source awaits verification.
    } finally { await this.options.db.run('UPDATE engineer_threads SET lease = NULL, expires = 0 WHERE id = ? AND lease = ?', row.id, lease); }
  }
  async files(identity: RuntimeIdentity) {
    await this.row(identity);
    const { snapshotFiles } = await import('../../harness/workspace.js');
    const root = path.join(this.options.dataDir, 'engine', 'projects', this.threadId(identity));
    return [...await snapshotFiles(root)].filter(([relative]) => { try { resolveInside(root, relative); return true; } catch { return false; } }).map(([path, file]) => ({ path, content: file.content }));
  }
  async wait(identity: RuntimeIdentity) { await this.active.get(this.threadId(identity))?.done; }
  async close() {
    for (const preview of this.previews.values()) preview.close();
    for (const active of this.active.values()) active.abort.abort();
    await Promise.allSettled([...this.active.values()].map(a => a.done));
    await this.events.flush();
    const saver = this.saver as BaseCheckpointSaver & { end?: () => Promise<void>; db?: { close: () => void } };
    await saver.end?.(); saver.db?.close();
  }
}
