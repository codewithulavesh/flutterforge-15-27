import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer, type Server } from 'node:http';

// Isolate the whole platform into a temp tree before any module resolves paths.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flutterforge-api-'));
process.env.FLUTTERFORGE_DATA_DIR = dir;
process.env.FLUTTERFORGE_WORKSPACES = path.join(dir, 'workspaces');
process.env.FLUTTERFORGE_AUTH_MODE = 'local';
process.env.FLUTTERFORGE_WORKFLOW_POLL_MS = '50';
process.env.FLUTTERFORGE_LOG_LEVEL = 'fatal';

const { handlePlatformRequest, isPlatformPath, getPlatform, closePlatform } = await import('../../platform/api.js');

let server: Server;
let base = '';

before(async () => {
  await getPlatform(); // initialise composition root + daemon
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    if (isPlatformPath(url.pathname)) {
      await handlePlatformRequest(req, res, url);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePlatform();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

const json = (res: Response) => res.json() as Promise<any>;

test('unauthenticated local mode connects as owner without headers', async () => {
  const response = await fetch(`${base}/api/platform/health`);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.ok, true);
  assert.equal(body.platform, '2.0.0');
});

test('capabilities endpoint reports the implemented pillars', async () => {
  const response = await fetch(`${base}/api/platform/capabilities`);
  const body = await json(response);
  assert.equal(response.status, 200);
  const pillars = body.pillars as Array<{ pillar: string; status: string }>;
  assert.equal(pillars.length, 17);
  assert.equal(pillars.find((p) => p.pillar === '04')?.status, 'implemented');
  assert.equal(pillars.find((p) => p.pillar === '08')?.status, 'implemented');
  assert.equal(pillars.find((p) => p.pillar === '10b')?.status, 'implemented');
  assert.equal(pillars.find((p) => p.pillar === '15')?.status, 'implemented');
  const names = (body.workflows as Array<{ name: string }>).map((w) => w.name);
  assert.ok(names.includes('patch.apply'));
  assert.ok(names.includes('review.board'));
  assert.equal(body.agents?.count, 20);
});

test('metrics endpoint exposes Prometheus text', async () => {
  await fetch(`${base}/api/platform/health`); // ensure at least one counted series
  const response = await fetch(`${base}/api/platform/metrics`);
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.ok(text.includes('# HELP flutterforge_http_requests_total'));
});

test('full workflow lifecycle: approval-gated patch applies and audits', async () => {
  const start = await fetch(`${base}/api/platform/workflows/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'idempotency-key': 'itest-1' },
    body: JSON.stringify({
      definition: 'patch.apply',
      idempotencyKey: 'itest-1',
      projectId: 'itest-project',
      input: {
        projectId: 'itest-project',
        requireApproval: true,
        approvalReason: 'Writes into a fresh project',
        message: 'integration test patch',
        files: [
          { path: 'lib/main.dart', content: "void main() { runApp(const SizedBox()); }\n" },
          { path: 'pubspec.yaml', content: 'name: itest_app\n\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n' },
        ],
      },
    }),
  });
  assert.equal(start.status, 201);
  const started = await json(start);
  const runId = started.run.id as string;

  // The run parks for approval.
  await waitFor(async () => (await runStatus(runId)) === 'waiting_approval', 5000);

  const pending = await fetch(`${base}/api/platform/approvals/pending`);
  const pendingBody = await json(pending);
  const approval = pendingBody.approvals.find((entry: any) => entry.runId === runId);
  assert.ok(approval, 'expected a pending approval for the run');

  const decide = await fetch(`${base}/api/platform/approvals/${approval.id}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approved', note: 'verified by testers' }),
  });
  assert.equal(decide.status, 200);

  await waitFor(async () => (await runStatus(runId)) === 'succeeded', 10000);

  const projectDir = path.join(process.env.FLUTTERFORGE_WORKSPACES!, 'itest-project');
  const mainDart = await fs.readFile(path.join(projectDir, 'lib', 'main.dart'), 'utf8');
  assert.ok(mainDart.includes('runApp'));

  const verify = await fetch(`${base}/api/platform/audit/verify?limit=1000`);
  const verifyBody = await json(verify);
  assert.equal(verifyBody.verification.ok, true);

  // Idempotent replay returns the same run.
  const replay = await fetch(`${base}/api/platform/workflows/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      definition: 'patch.apply',
      idempotencyKey: 'itest-1',
      projectId: 'itest-project',
      input: {
        projectId: 'itest-project',
        files: [{ path: 'lib/main.dart', content: '// different\n' }],
      },
    }),
  });
  // same key, different input shape — the idempotency key is what matters.
  const replayBody = await json(replay);
  assert.equal(replayBody.run.id, runId);
  assert.equal(replayBody.created, false);

  async function runStatus(id: string): Promise<string> {
    const response = await fetch(`${base}/api/platform/workflows/runs/${id}`);
    const body = await json(response);
    return body.run.status;
  }
});

test('inline patch endpoint commits a transactional patch and records a revision', async () => {
  const response = await fetch(`${base}/api/platform/projects/itest-inline/patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [
        { path: 'lib/inline.dart', content: "void main() {}\n" },
        { path: 'README.md', content: '# inline\n' },
      ],
      message: 'inline patch test',
    }),
  });
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.ok, true);
  assert.ok(body.transactionId.startsWith('tx_'));
  assert.equal(body.result.filesWritten, 2);
  assert.ok(body.revision.id.startsWith('rev_'));

  const projectDir = path.join(process.env.FLUTTERFORGE_WORKSPACES!, 'itest-inline');
  assert.equal(await fs.readFile(path.join(projectDir, 'lib', 'inline.dart'), 'utf8'), "void main() {}\n");

  const revisions = await fetch(`${base}/api/platform/projects/itest-inline/revisions`);
  const revisionsBody = await json(revisions);
  assert.ok((revisionsBody.revisions as unknown[]).length >= 1);
});

test('unknown platform route is a structured 404, not a stack trace', async () => {
  const response = await fetch(`${base}/api/platform/definitely-not-real`);
  assert.equal(response.status, 404);
  const body = await json(response);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('sandbox status reports the configured isolation mode', async () => {
  const response = await fetch(`${base}/api/platform/sandbox`);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.ok, true);
  assert.ok(['local', 'docker'].includes(body.sandbox.mode));
  assert.ok(['auto', 'docker', 'local'].includes(body.sandbox.requestedMode));
});

test('sandbox exec runs an allowlisted command inside the project workspace', async () => {
  const response = await fetch(`${base}/api/platform/projects/itest-sandbox/sandbox/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ argv: ['echo', 'sandbox-ok'] }),
  });
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.ok, true);
  assert.equal(body.exitCode, 0);
  assert.match(body.stdout, /sandbox-ok/);
  const projectDir = path.join(process.env.FLUTTERFORGE_WORKSPACES!, 'itest-sandbox');
  assert.equal(await fs.access(projectDir).then(() => true).catch(() => false), true);
});

test('sandbox exec rejects executables outside the allowlist', async () => {
  const response = await fetch(`${base}/api/platform/projects/itest-sandbox/sandbox/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ argv: ['sh', '-c', 'id'] }),
  });
  assert.equal(response.status, 422);
  const body = await json(response);
  assert.equal(body.error.code, 'POLICY_DENIED');
});

test('patch with an invalid JSON body is a structured 400', async () => {
  const response = await fetch(`${base}/api/platform/projects/itest-bad/patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json{',
  });
  assert.equal(response.status, 400);
  const body = await json(response);
  assert.equal(body.error.code, 'VALIDATION_FAILED');
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
