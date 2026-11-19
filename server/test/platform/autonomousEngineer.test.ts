import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { MemorySaver, Command } from '@langchain/langgraph';
import { z } from 'zod';
import { createEngineerGraph } from '../../platform/engine/graph.js';
import { EngineerToolRegistry } from '../../platform/engine/tools/index.js';
import { DEFAULT_BUDGET, type ToolContext } from '../../platform/engine/types.js';
import { resolveInside } from '../../platform/engine/paths.js';
import { EngineerRuntime } from '../../platform/engine/runtime.js';
import { Database } from '../../platform/storage/database.js';
import { PLATFORM_MIGRATIONS } from '../../platform/storage/schema.js';

const passed = { passed: true, summary: 'test verifier', errorCount: 0, warningCount: 0, diagnostics: [], evidence: ['test fixture'], at: 1 };
async function fixture(responses: AIMessage[], sensitive = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ff-engine-'));
  let executions = 0, verifications = 0;
  const events: unknown[] = [];
  const registry = new EngineerToolRegistry([{ name: 'write', description: 'Write test file', schema: z.object({}),
    approval: () => ({ required: sensitive, risk: sensitive ? 'high' : 'low' }),
    invoke: async () => { executions++; return { content: 'written', changedFiles: [{ path: 'lib/main.dart', action: 'modified' }] }; } }]);
  const context = { projectRoot: root, threadId: 't', projectId: 'p', actor: 'owner', cancelled: () => false, takeInstructions: () => [],
    verify: async () => { verifications++; return passed; }, emit: (e: unknown) => events.push(e) } as unknown as ToolContext;
  const graph = createEngineerGraph({ registry, model: { invoke: async () => responses.shift() ?? new AIMessage('done') } as any,
    checkpointer: new MemorySaver(), contextFor: () => context });
  const config = { configurable: { thread_id: 't' } };
  const input = { startedAt: Date.now(), budget: DEFAULT_BUDGET, verificationRequired: true };
  return { graph, config, input, root, context, executions: () => executions, verifications: () => verifications };
}
const call = (id: string) => ({ id, name: 'write', args: {} });
test('dynamic tools execute and completion runs actual verification port', async () => {
  const f = await fixture([new AIMessage({ content: '', tool_calls: [call('1')] }), new AIMessage('done')]);
  try { const state = await f.graph.invoke(f.input, f.config); assert.equal(state.status, 'completed'); assert.equal(f.executions(), 1); assert.equal(f.verifications(), 1); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});
test('tool budget applies within a model batch', async () => {
  const f = await fixture([new AIMessage({ content: '', tool_calls: [call('1'), call('2')] })]);
  try { const state = await f.graph.invoke({ ...f.input, budget: { ...DEFAULT_BUDGET, maxToolCalls: 1 } }, f.config); assert.equal(f.executions(), 1); assert.equal(state.status, 'failed'); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});
test('native approval persists and rejection never executes the tool', async () => {
  const f = await fixture([new AIMessage({ content: '', tool_calls: [call('1')] })], true);
  try {
    const state = await f.graph.invoke(f.input, f.config); assert.equal(state.status, 'awaiting_approval'); assert.equal(f.executions(), 0);
    await f.graph.invoke(new Command({ resume: { approvalId: state.approvalRequest!.id, approved: false } }), f.config);
    assert.equal(f.executions(), 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('filesystem rejects symlinks and secret files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ff-path-'));
  try { await symlink(os.tmpdir(), path.join(root, 'escape')); assert.throws(() => resolveInside(root, 'escape/data')); assert.throws(() => resolveInside(root, '.env')); assert.throws(() => resolveInside(root, '../data')); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test('runtime persists thread and approval across runtime restart with tenant isolation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ff-runtime-'));
  const db = await Database.open({ file: path.join(root, 'control.sqlite') }); await db.migrate(PLATFORM_MIGRATIONS);
  const identity = { tenantId: 'tenant-a', actor: 'owner', projectId: 'project' };
  let invoked = 0;
  const registry = new EngineerToolRegistry([{ name: 'write', description: 'write test', schema: z.object({}),
    approval: () => ({ required: true, risk: 'high' }), invoke: async (_input, ctx) => { invoked++; await writeFile(path.join(ctx.projectRoot, 'result.txt'), 'real'); return { content: 'written' }; } }]);
  const options = { db, dataDir: root, registry,
    sandbox: async () => ({ dispose: async () => {} }) as any,
    context: (ctx: ToolContext) => ({ ...ctx, verify: async () => passed }) };
  let runtime: EngineerRuntime | undefined;
  try {
    runtime = await EngineerRuntime.create({ ...options, model: { invoke: async () => new AIMessage({ content: '', tool_calls: [call('1')] }) } as any });
    await runtime.start(identity, 'write'); await runtime.wait(identity);
    const state = await runtime.state(identity); assert.equal(state.status, 'awaiting_approval'); assert.equal(invoked, 0);
    await assert.rejects(runtime.state({ ...identity, tenantId: 'tenant-b' }), /not found/);
    await assert.rejects(runtime.resume(identity, { approvalId: 'wrong', approved: true }), /matching approvalId/);
    await assert.rejects(runtime.editFile(identity, 'result.txt', 'edit', null), /Cancel or resume/);
    await runtime.close();
    runtime = await EngineerRuntime.create({ ...options, model: { invoke: async () => new AIMessage('done') } as any });
    await runtime.resume(identity, { approvalId: state.approval!.id, approved: true }); await runtime.wait(identity);
    assert.equal(invoked, 1); assert.equal((await runtime.state(identity)).status, 'completed');
    assert.equal((await runtime.files(identity)).find(f => f.path === 'result.txt')?.content, 'real');
    await assert.rejects(runtime.editFile(identity, 'result.txt', 'stale', 'old'), /Reload before saving/);
    await runtime.editFile(identity, 'result.txt', 'edited', 'real');
    await runtime.editFile(identity, 'nested/new.txt', 'created', null);
    await assert.rejects(runtime.editFile(identity, 'result.txt', null, 'edited', 'nested/new.txt'), /already exists/);
    await runtime.editFile(identity, 'result.txt', null, 'edited', 'nested/moved.txt');
    assert.equal((await runtime.files(identity)).find(f => f.path === 'nested/moved.txt')?.content, 'edited');
    await runtime.editFile(identity, 'nested/moved.txt', null, 'edited');
    assert.equal((await runtime.files(identity)).some(f => f.path === 'nested/moved.txt' || f.path === 'result.txt'), false);
    await assert.rejects(runtime.editFile(identity, '../outside.txt', 'escape', null), /path|traversal|Invalid/i);
  } finally { await runtime?.close(); db.close(); await rm(root, { recursive: true, force: true }); }
});

test('an answer without code changes does not require a compiler or sandbox', async () => {
  const f = await fixture([new AIMessage('This project has no files yet.')]);
  try { const state = await f.graph.invoke(f.input, f.config); assert.equal(state.status, 'completed'); assert.equal(f.verifications(), 0); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});
test('repeated identical tool failures terminate before consuming the entire budget', async () => {
  const f = await fixture(Array.from({ length: 10 }, (_, i) => new AIMessage({ content: '', tool_calls: [call(String(i))] })));
  // A real tool failure, not a simulated success.
  const registry = new EngineerToolRegistry([{ name: 'write', description: 'failure fixture', schema: z.object({}), invoke: async () => { throw new Error('Invalid path'); } }]);
  const graph = createEngineerGraph({ registry, checkpointer: new MemorySaver(), contextFor: () => f.context,
    model: { invoke: async () => new AIMessage({ content: '', tool_calls: [call('repeat')] }) } as any });
  try { const state = await graph.invoke(f.input, f.config); assert.equal(state.status, 'failed'); assert.equal(state.usage.toolCalls, 3); assert.match(state.error!, /same tool failed three times/); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test('command-created files are tracked even when the command reports failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ff-command-'));
  let turns = 0, verified = 0;
  const registry = new EngineerToolRegistry([{ name: 'run_command', description: 'fixture command', schema: z.object({}), invoke: async () => {
    await writeFile(path.join(root, 'main.dart'), 'void main() {}');
    throw new Error('command failed after writing');
  } }]);
  const context = { projectRoot: root, threadId: 'cmd', projectId: 'p', cancelled: () => false, takeInstructions: () => [], emit: () => {}, verify: async () => { verified++; return passed; } } as unknown as ToolContext;
  const graph = createEngineerGraph({ registry, checkpointer: new MemorySaver(), contextFor: () => context,
    model: { invoke: async () => turns++ === 0 ? new AIMessage({ content: '', tool_calls: [{ id: 'c', name: 'run_command', args: {} }] }) : new AIMessage('done') } as any });
  try {
    const result = await graph.invoke({ startedAt: Date.now(), budget: DEFAULT_BUDGET, verificationRequired: true }, { configurable: { thread_id: 'cmd' } });
    assert.equal(result.changedFiles[0]?.path, 'main.dart'); assert.equal(verified, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('opt-in specialists advise the lead once each and share the execution budget', async () => {
  const f = await fixture([]);
  const roles: string[] = [];
  const leadInputs: string[] = [];
  const graph = createEngineerGraph({
    registry: new EngineerToolRegistry([]),
    model: { invoke: async (messages: AIMessage[]) => {
      leadInputs.push(messages.map(message => message.text).join('\n'));
      return new AIMessage('Done');
    } } as any,
    specialistModel: { invoke: async (messages: AIMessage[], options: { tags: string[]; signal: AbortSignal }) => {
      assert.ok(options.signal instanceof AbortSignal);
      assert.match(messages[1].text, /\bObjective\b/);
      const role = options.tags[1];
      roles.push(role);
      return new AIMessage({
        content: role + ' advice',
        usage_metadata: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
        // Unrequested tool output must never reach the lead's tool executor.
        tool_calls: [call('ignored')],
      });
    } } as any,
    contextFor: () => f.context,
    checkpointer: new MemorySaver(),
  });
  const input = { ...f.input, objective: 'Objective', specialists: ['planner', 'reviewer'] as ('planner' | 'reviewer')[] };
  try {
    const result = await graph.invoke(input, f.config);
    assert.equal(result.status, 'completed');
    assert.deepEqual(roles, ['planner', 'reviewer']);
    assert.match(leadInputs[0], /planner advice/);
    assert.match(leadInputs[1], /reviewer advice/);
    assert.equal(result.usage.modelCalls, 4);
    assert.equal(result.usage.promptTokens, 14);
    assert.equal(result.usage.toolCalls, 0);
    assert.equal(result.specialistReports.length, 2);

    const limited = await graph.invoke({ ...input, budget: { ...DEFAULT_BUDGET, maxModelCalls: 1 } }, { configurable: { thread_id: 'limited' } });
    assert.equal(limited.usage.modelCalls, 1);
    assert.deepEqual(limited.specialistReports.map(report => report.status), ['skipped', 'skipped']);
    assert.equal(limited.status, 'completed');

    const ordinary = await graph.invoke(f.input, { configurable: { thread_id: 'ordinary' } });
    assert.equal(ordinary.usage.modelCalls, 1);
    assert.equal(ordinary.specialistReports.length, 0);
    assert.deepEqual(roles, ['planner', 'reviewer']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
