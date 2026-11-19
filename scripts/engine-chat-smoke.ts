import '../server/env.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../server/platform/storage/database.js';
import { PLATFORM_MIGRATIONS } from '../server/platform/storage/schema.js';
import { EngineerRuntime } from '../server/platform/engine/runtime.js';
import { seedCredentialsFromEnv } from '../server/credentials.js';
seedCredentialsFromEnv();
const root = await mkdtemp(path.join(os.tmpdir(), 'ff-live-chat-'));
const db = await Database.open({ file: path.join(root, 'control.sqlite') });
await db.migrate(PLATFORM_MIGRATIONS);
let runtime: EngineerRuntime | undefined;
try {
  runtime = await EngineerRuntime.create({ db, dataDir: root });
  const identity = { tenantId: 'smoke', actor: 'smoke', projectId: 'chat-check' };
  await runtime.start(identity, 'Inspect this empty project using project_overview once. Explain briefly what you can verify and what is missing. Do not write files, run commands or use other tools.', [], { maxModelCalls: 4, maxToolCalls: 4, maxIterations: 4 });
  await runtime.wait(identity);
  const state = await runtime.state(identity);
  const events = await runtime.events.history(state.threadId, 0, 2000);
  console.log(JSON.stringify({ status: state.status, summary: state.summary, error: state.error, usage: state.usage,
    toolEvents: events.filter(e => e.type === 'tool_end').map(e => ({ tool: e.tool, ok: e.ok })),
    streamedChunks: events.filter(e => e.type === 'token').length, files: (await runtime.files(identity)).length }, null, 2));
  if (state.status !== 'completed' || !state.summary?.trim()) process.exitCode = 1;
} finally { await runtime?.close(); db.close(); await rm(root, { recursive: true, force: true }); }
