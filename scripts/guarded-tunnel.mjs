#!/usr/bin/env node
/**
 * Guarded Cloudflare tunnel.
 *
 * The FlutterForge engine API on :8787 is UNAUTHENTICATED by design
 * (local-first). `cloudflared tunnel --url http://127.0.0.1:8787` publishes
 * that API to the public internet — anyone with the
 * trycloudflare.com URL could run /api/terminal/run or read /api/credentials.
 *
 * This wrapper refuses to start the tunnel unless the operator explicitly
 * opts in with FLUTTERFORGE_ALLOW_REMOTE=1, and prints a prominent warning.
 */
import { spawn } from 'node:child_process';

if (process.env.FLUTTERFORGE_ALLOW_REMOTE !== '1') {
  console.error('');
  console.error('Refusing to start the tunnel: the engine API on :8787 is unauthenticated.');
  console.error('');
  console.error('A public tunnel would expose these endpoints to the entire internet:');
  console.error('  POST /api/terminal/run     — allow-listed project terminal');
  console.error('  POST /api/credentials      — write stored provider keys');
  console.error('  DELETE /api/harness/session/:id — wipe project workspaces');
  console.error('  POST /api/preview/:id/build — burn your Flutter build budget');
  console.error('');
  console.error('Safest options:');
  console.error('  1. Keep the engine local and use the Electron desktop app.');
  console.error('  2. Put the engine behind an authenticated reverse proxy (oauth2-proxy, Cloudflare Access).');
  console.error('  3. If you accept the risk, re-run with: FLUTTERFORGE_ALLOW_REMOTE=1 npm run tunnel');
  console.error('');
  process.exit(1);
}

console.warn('[tunnel] FLUTTERFORGE_ALLOW_REMOTE=1 — exposing the UNAUTHENTICATED engine API to the public internet.');
console.warn('[tunnel] Anyone with the URL can use the terminal, credentials and workspace endpoints.');

const child = spawn('cloudflared', ['tunnel', '--url', 'http://127.0.0.1:8787'], { stdio: 'inherit' });
child.on('error', (error) => {
  if (error.code === 'ENOENT') {
    console.error('[tunnel] cloudflared not found. Install: brew install cloudflared (or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)');
    process.exit(1);
  }
  throw error;
});
child.on('exit', (code) => process.exit(code ?? 0));
