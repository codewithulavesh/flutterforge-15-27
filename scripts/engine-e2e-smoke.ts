/** Real model + isolated Flutter acceptance test. No injected success fixtures. */
import '../server/env.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../server/platform/storage/database.js';
import { PLATFORM_MIGRATIONS } from '../server/platform/storage/schema.js';
import { EngineerRuntime } from '../server/platform/engine/runtime.js';
import { seedCredentialsFromEnv } from '../server/credentials.js';
seedCredentialsFromEnv();
const root = await mkdtemp(path.join(os.tmpdir(), 'ff-e2e-'));
const db = await Database.open({ file: path.join(root, 'control.sqlite') });
await db.migrate(PLATFORM_MIGRATIONS);
let runtime: EngineerRuntime | undefined;
try {
  runtime = await EngineerRuntime.create({ db, dataDir: root });
  const identity = { tenantId: 'acceptance', actor: 'acceptance', projectId: 'counter-app' };
  for (const prompt of [
    'Create a small complete Flutter web counter app in this empty workspace. Use flutter create to bootstrap, then build a polished Material 3 screen titled Focus Counter with a working increment button. Include a widget test that taps it and checks the count. Use only Flutter SDK dependencies. Run verify_project and start the preview. Do not ask questions.',
    'Change the title to Daily Focus and add a Reset button that resets the count to zero. Preserve the increment behavior. Update the widget test to verify reset, run verify_project and refresh the preview.',
  ]) {
    await runtime.start(identity, prompt);
    await runtime.wait(identity);
    const state = await runtime.state(identity);
    console.log(JSON.stringify({ status: state.status, error: state.error, files: state.changedFiles.length, verification: state.verification?.passed, usage: state.usage }));
    if (state.status !== 'completed' || !state.verification?.passed || !state.preview?.url) throw new Error('Live generation/build/preview acceptance failed.');
    const response = await fetch(state.preview.url);
    if (!response.ok || !(await response.text()).includes('flutter')) throw new Error('The compiled Flutter preview did not serve successfully.');
  }
  const files = await runtime.files(identity);
  if (!files.some(file => file.path.endsWith('.dart') && file.content.includes('Daily Focus'))) throw new Error('The follow-up change is missing.');
  console.log('PASS: live generation, verification, preview HTTP serving and follow-up edit. Browser interaction still needs separate validation.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
} finally {
  await runtime?.close(); db.close();
  if (process.env.FF_E2E_KEEP === '1') console.log(`Acceptance workspace retained: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
