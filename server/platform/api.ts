/**
 * Platform HTTP API.
 *
 * Namespaced under `/api/platform/*` so it can be mounted next to the legacy
 * engine API without interfering with any existing handler. Every route here
 * goes through the same pipeline: request id → tracing → auth → validation →
 * handler → (error mapping | audit | metrics). There is no route that touches
 * the workspace without going through the transactional patch engine, and no
 * response carries secret values.
 *
 * Authentication:
 *   local (default) — single-user desktop tenant (`owner` role). The Linux/
 *   Docker deployment must set `FLUTTERFORGE_AUTH_MODE=jwt` plus HS256 secret.
 *   jwt — bearer tokens verified by the gateway module; HS256 today via the
 *   built-in verifier, RS256/ES256/PS256 and JWKS via `createJwtVerifier`.
 *   Claims are mapped through `claimsToPrincipal`, then every handler authorises
 *   against the RBAC matrix in `server/platform/gateway`.
 */
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPlatform, type PlatformInstance } from './instance.js';
import { version } from './instance.js';
import { createPatchApplyWorkflow } from './workflow/patchWorkflow.js';
import { createVerifyHealWorkflow, createLiveVerifyHealDeps } from './qa/verifyAndHeal.js';
import { applyPatch, type PatchInput } from './patch/transaction.js';
import { getProjectWorkspace } from '../harness/run.js';
import {
  PlatformError,
  RateLimitError,
  ValidationError,
  toErrorBody,
  statusForError,
} from './kernel/errors.js';
import { createLogger } from './kernel/logger.js';
import { prefixedId } from './kernel/ids.js';
import { metrics, httpRequests, httpLatency, rateLimited } from './observability/metrics.js';
import { parseTraceparent, formatTraceparent } from './observability/tracing.js';
import type { RunStatus } from './workflow/engine.js';
import { verifyProjectContract } from './qa/contract.js';
import { validateDartFiles } from './dart/validate.js';
import { generateSbom } from './security/sbom.js';
import { promises as fs } from 'node:fs';
import {
  authorize,
  claimsToPrincipal,
  createHs256Verifier,
  extractBearerToken,
  isJwtError,
  AuthzError,
  PERMISSION_RESOURCE_TYPES,
  type Permission,
  type Principal,
} from './gateway/index.js';

let platformPromise: Promise<PlatformInstance> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

export function getPlatform(): Promise<PlatformInstance> {
  if (shuttingDown) {
    return Promise.reject(new PlatformError({ code: 'SHUTTING_DOWN', message: 'The server is shutting down.', statusCode: 503 }));
  }
  if (!platformPromise) {
    platformPromise = createPlatform().then((platform) => {
      platform.engine.register(createPatchApplyWorkflow(platform));
      platform.engine.register(createVerifyHealWorkflow(createLiveVerifyHealDeps({ audit: platform.audit })));
      // Resume any run whose lease expired while the process was down, and
      // execute submissions within one poll interval.
      const timer = setInterval(() => {
        void platform.engine.tick().catch((error) => {
          fallbackLogger.warn('workflow tick failed', { err: error instanceof Error ? error.message : String(error) });
        });
      }, platform.config.workflow.pollIntervalMs);
      timer.unref?.();
      pollTimer = timer;
      return platform;
    });
  }
  return platformPromise;
}

export async function closePlatform(): Promise<void> {
  shuttingDown = true;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!platformPromise) return;
  const platform = await platformPromise.catch(() => null);
  platformPromise = null;
  platform?.db.close();
}

const PLATFORM_PREFIX = '/api/platform/';

export function isPlatformPath(pathname: string): boolean {
  return pathname === '/api/platform/health'
    || pathname === '/api/platform/metrics'
    || pathname.startsWith(PLATFORM_PREFIX);
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Platform-Version': version,
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Platform-Version': version,
  });
  res.end(body);
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) {
      req.destroy();
      throw new ValidationError(`Request body exceeds the ${maxBytes}-byte limit.`, { limit: maxBytes });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<any> {
  const raw = await readBody(req, maxBytes);
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ValidationError('Request body is not valid JSON.', { detail: error instanceof Error ? error.message : 'parse error' });
  }
}

async function resolvePrincipal(req: IncomingMessage, platform: PlatformInstance): Promise<Principal> {
  if (platform.config.auth.mode === 'local') {
    return {
      userId: platform.config.auth.localUserId,
      tenantId: platform.config.auth.localTenantId,
      roles: ['owner'],
      projectRoles: {},
    };
  }

  const bearer = extractBearerToken(typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined);
  if (!bearer) {
    throw new PlatformError({ code: 'UNAUTHORIZED', message: 'A bearer token is required.', statusCode: 401 });
  }
  const secret = platform.config.auth.hs256Secret;
  if (!secret) {
    throw new PlatformError({ code: 'AUTH_MISCONFIGURED', message: 'JWT mode is enabled but FLUTTERFORGE_JWT_SECRET is not set.', statusCode: 500 });
  }

  const verifier = createHs256Verifier({
    secret,
    ...(platform.config.auth.issuer !== undefined ? { issuer: platform.config.auth.issuer } : {}),
    ...(platform.config.auth.audience !== undefined ? { audience: platform.config.auth.audience } : {}),
    clockSkewSeconds: platform.config.auth.clockSkewSeconds,
    now: () => Date.now(),
  });

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await verifier.verify(bearer));
  } catch (error) {
    if (isJwtError(error)) {
      throw new PlatformError({ code: error.code, message: error.message, statusCode: 401 });
    }
    throw error;
  }

  const principal = claimsToPrincipal(payload);
  if (!principal) {
    throw new PlatformError({ code: 'TENANT_CLAIM_MISSING', message: 'The token does not carry a usable tenant and subject.', statusCode: 403 });
  }
  return principal;
}

/**
 * Map a route-level permission to a tenant-scoped RBAC resource. Project-only
 * permissions carry a synthetic placeholder when the request has no project
 * (e.g. starting a run for an in-memory prompt), which preserves org-role
 * grants while never widening project-role grants.
 */
function resourceFor(principal: Principal, permission: Permission, projectId?: string) {
  const resourceType = PERMISSION_RESOURCE_TYPES[permission][0];
  if (resourceType === 'project' || resourceType === 'sandbox') {
    return { type: resourceType, tenantId: principal.tenantId, projectId: projectId ?? '_adhoc' } as const;
  }
  return { type: resourceType, tenantId: principal.tenantId } as const;
}

/** Throws AuthzError-derived PlatformError(403) on denial. */
function requirePermission(principal: Principal, permission: Permission, projectId?: string): void {
  try {
    authorize(principal, permission, resourceFor(principal, permission, projectId));
  } catch (error) {
    if (error instanceof AuthzError) {
      throw new PlatformError({ code: error.code, message: error.message, statusCode: 403 });
    }
    throw error;
  }
}

function tenantScope(principal: Principal, resourceTenant: string): void {
  if (resourceTenant !== principal.tenantId) {
    throw new PlatformError({ code: 'TENANT_MISMATCH', message: 'This resource belongs to another tenant.', statusCode: 403 });
  }
}

// A tiny in-process token bucket so the expensive routes can't be hammered.
class Bucket {
  private counters = new Map<string, { tokens: number; refreshedAt: number }>();
  constructor(private readonly capacity: number, private readonly refillPerSecond: number) {}
  consume(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const current = this.counters.get(key) ?? { tokens: this.capacity, refreshedAt: now };
    const elapsed = Math.max(0, (now - current.refreshedAt) / 1000);
    const tokens = Math.min(this.capacity, current.tokens + elapsed * this.refillPerSecond);
    if (tokens >= 1) {
      this.counters.set(key, { tokens: tokens - 1, refreshedAt: now });
      return { allowed: true, retryAfterMs: 0 };
    }
    this.counters.set(key, { tokens, refreshedAt: now });
    return { allowed: false, retryAfterMs: Math.ceil((1 - tokens) / this.refillPerSecond * 1000) };
  }
}
const expensiveRouteBucket = new Bucket(10, 10 / 60); // 10 per minute per principal

// ------------------------------------------------------------------
// Route table
// ------------------------------------------------------------------

type PathHandler = (args: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: any;
  platform: PlatformInstance;
  principal: Principal;
  requestId: string;
}) => Promise<void>;

function route(table: Array<{ method: string; pattern: string; regex: RegExp; keys: string[]; handler: PathHandler }>, method: string, pathname: string) {
  for (const entry of table) {
    if (entry.method !== method) continue;
    const match = entry.regex.exec(pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    entry.keys.forEach((key, index) => { params[key] = decodeURIComponent(match[index + 1] ?? ''); });
    return { handler: entry.handler, params, pattern: entry.pattern };
  }
  return null;
}

function compilePattern(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = pattern.split('/').map((segment) => {
    if (segment.startsWith(':')) {
      keys.push(segment.slice(1));
      return '([^/]+)';
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { regex: new RegExp(`^${source}$`), keys };
}

const table: Array<{ method: string; pattern: string; regex: RegExp; keys: string[]; handler: PathHandler }> = [];
function add(method: string, pattern: string, handler: PathHandler): void {
  const { regex, keys } = compilePattern(pattern);
  table.push({ method, pattern, regex, keys, handler });
}

add('GET', '/api/platform/health', async ({ res, platform }) => {
  const integrity = await platform.db.integrityCheck().catch(() => ({ ok: false, detail: 'check failed' }));
  sendJson(res, 200, {
    ok: integrity.ok,
    platform: version,
    node: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    database: { mode: 'sqlite-wal', integrity: integrity.detail },
    recovery: 'journal-2pc',
  });
});

add('GET', '/api/platform/metrics', async ({ res, principal }) => {
  requirePermission(principal, 'audit:read');
  if (!metrics || !process.env.FLUTTERFORGE_METRICS || process.env.FLUTTERFORGE_METRICS === 'true') {
    sendText(res, 200, metrics.render(), 'text/plain; version=0.0.4; charset=utf-8');
    return;
  }
  sendText(res, 200, '# metrics disabled\n', 'text/plain; version=0.0.4; charset=utf-8');
});

add('GET', '/api/platform/capabilities', async ({ res, platform }) => {
  const engines = platform.engine.listDefinitions();
  sendJson(res, 200, {
    ok: true,
    version,
    pillars: [
      { pillar: '01', name: 'Experience & Interaction', status: 'reused', notes: 'Existing React studio unchanged by this module.' },
      { pillar: '02', name: 'API Gateway & Identity', status: 'partial', notes: `auth=${platform.config.auth.mode}; JWT-HS256 built in; RBAC/expiry/audit enforced. RS256/JWKS pending gateway module.` },
      { pillar: '03', name: 'Intent & Intelligence', status: 'ported', notes: 'Existing intent router remains; platform exposes typed diagnostics for repair turns.' },
      { pillar: '04', name: 'Orchestration Control Plane', status: 'implemented', notes: 'Durable DAG engine with leases, retries, suspension, compensation, idempotency.' },
      { pillar: '05', name: 'Human Governance', status: 'implemented', notes: 'Approval gates, risk levels, pending-approval API, immutable audit trail.' },
      { pillar: '06', name: 'Discovery & Planning', status: 'ported', notes: 'Existing discovery agents unchanged in this increment.' },
      { pillar: '07', name: 'Engineering & Generation', status: 'ported', notes: 'Generation engine untouched; platform governs change safety.' },
      { pillar: '08', name: 'Transactional Patch Engine', status: 'implemented', notes: 'Two-phase commit, per-workspace mutex/file lock, crash recovery, content-addressed revisions.' },
      { pillar: '09', name: 'Execution Sandbox', status: 'configurable', notes: `mode=${platform.config.sandbox.mode}; policy allowlist module in flight (server/platform/sandbox).` },
      { pillar: '10', name: 'QA & Self-Healing', status: 'implemented', notes: 'Dart-aware structural gate, analyzer diagnostic parsing, contract verifier, healing policy with oscillation detection; `verify.heal` workflow runs the closed repair loop.' },
      { pillar: '11', name: 'Runtime & Preview', status: 'ported', notes: 'Preview service untouched.' },
      { pillar: '12', name: 'Release & Deployment', status: 'ported', notes: 'Existing export pipeline unchanged in this increment.' },
      { pillar: '13', name: 'Data & Persistence', status: 'implemented', notes: 'SQLite/WAL migrations, hash-chained audit log, content-addressed blobs, project revisions.' },
      { pillar: '14', name: 'Security & Trust', status: 'partial', notes: 'Audit chain + secret redaction + tenant claim enforcement. Vault/KMS envelope pending.' },
      { pillar: '15', name: 'Observability', status: 'implemented', notes: 'Structured JSON-L with redaction, W3C traceparent tracing, Prometheus metrics endpoint.' },
      { pillar: '16', name: 'Billing & Governance', status: 'partial', notes: 'Token metering schema present (token_usage); quota enforcement pending.' },
    ],
    workflows: engines,
  });
});

add('GET', '/api/platform/workflows/definitions', async ({ res, platform, principal }) => {
  requirePermission(principal, 'project:read');
  sendJson(res, 200, { ok: true, definitions: platform.engine.listDefinitions() });
});

add('GET', '/api/platform/workflows/runs', async ({ res, url, platform, principal }) => {
  requirePermission(principal, 'project:read', url.searchParams.get('project_id') ?? undefined);
  const status = url.searchParams.get('status') as RunStatus | null;
  const projectId = url.searchParams.get('project_id') ?? undefined;
  const limit = Number(url.searchParams.get('limit') ?? '50');
  const runs = await platform.engine.listRuns({ tenantId: principal.tenantId, status: status ?? undefined, projectId, limit });
  sendJson(res, 200, { ok: true, runs });
});

add('POST', '/api/platform/workflows/runs', async ({ res, body, platform, principal }) => {
  if (!expensiveRouteBucket.consume(principal.userId).allowed) {
    rateLimited.inc({ tier: 'workflow_start' });
    throw new RateLimitError(60_000, { tier: 'workflow_start' });
  }
  const { definition, input, idempotencyKey, projectId, parentRunId } = body ?? {};
  requirePermission(principal, 'workflow:start', typeof projectId === 'string' ? projectId : undefined);
  if (typeof definition !== 'string' || definition.trim() === '') {
    throw new ValidationError('`definition` is required.', { field: 'definition' });
  }
  const { run, created } = await platform.engine.start(definition, {
    tenantId: principal.tenantId,
    projectId,
    actor: principal.userId,
    input: input ?? {},
    idempotencyKey,
    parentRunId,
  });
  sendJson(res, created ? 201 : 200, { ok: true, run, created });
});

add('GET', '/api/platform/workflows/runs/:runId', async ({ res, params, platform, principal }) => {
  const run = await platform.engine.getRun(params.runId);
  if (!run) throw new PlatformError({ code: 'RUN_NOT_FOUND', message: 'Run not found.', statusCode: 404 });
  tenantScope(principal, run.tenantId);
  requirePermission(principal, 'project:read', run.projectId);
  const steps = await platform.engine.loadSteps(run.id);
  sendJson(res, 200, { ok: true, run, steps });
});

add('GET', '/api/platform/workflows/runs/:runId/events', async ({ res, url, params, platform, principal }) => {
  const run = await platform.engine.getRun(params.runId);
  if (!run) throw new PlatformError({ code: 'RUN_NOT_FOUND', message: 'Run not found.', statusCode: 404 });
  tenantScope(principal, run.tenantId);
  requirePermission(principal, 'project:read', run.projectId);
  const after = Number(url.searchParams.get('after') ?? '0');
  const limit = Number(url.searchParams.get('limit') ?? '500');
  const events = await platform.engine.eventsAfter(run.id, after, limit);
  sendJson(res, 200, { ok: true, events });
});

add('POST', '/api/platform/workflows/runs/:runId/cancel', async ({ res, params, body, platform, principal }) => {
  const run = await platform.engine.getRun(params.runId);
  if (!run) throw new PlatformError({ code: 'RUN_NOT_FOUND', message: 'Run not found.', statusCode: 404 });
  tenantScope(principal, run.tenantId);
  requirePermission(principal, 'workflow:cancel', run.projectId);
  const updated = await platform.engine.cancel(run.id, principal.userId, body?.reason);
  sendJson(res, 200, { ok: true, run: updated });
});

add('GET', '/api/platform/approvals/pending', async ({ res, url, platform, principal }) => {
  requirePermission(principal, 'project:read');
  const limit = Number(url.searchParams.get('limit') ?? '100');
  const approvals = await platform.engine.listPendingApprovals({ tenantId: principal.tenantId, limit });
  sendJson(res, 200, { ok: true, approvals });
});

add('POST', '/api/platform/approvals/:approvalId/decision', async ({ res, params, body, platform, principal }) => {
  const projectRow = await platform.db.get<{ project_id: string | null }>(
    'SELECT r.project_id FROM workflow_approvals a JOIN workflow_runs r ON r.id = a.run_id WHERE a.id = ?',
    params.approvalId,
  );
  requirePermission(principal, 'project:approve', projectRow?.project_id ?? undefined);
  const decision = body?.decision === 'approved' || body?.decision === 'rejected' ? body.decision : null;
  if (!decision) throw new ValidationError('decision must be "approved" or "rejected".', { field: 'decision' });
  const note = typeof body?.note === 'string' ? body.note.slice(0, 2000) : undefined;
  const approval = await platform.engine.decideApproval(params.approvalId, decision, principal.userId, note);
  // Resume the run if a human approved; rejection already finalised by the engine.
  if (decision === 'approved') {
    void platform.engine.tick().catch(() => undefined);
  }
  sendJson(res, 200, { ok: true, approval });
});

add('POST', '/api/platform/projects/:projectId/patch', async ({ res, params, body, platform, principal }) => {
  if (!expensiveRouteBucket.consume(principal.userId).allowed) {
    rateLimited.inc({ tier: 'patch_apply' });
    throw new RateLimitError(60_000, { tier: 'patch_apply' });
  }
  requirePermission(principal, 'project:write', params.projectId);

  const projectId = params.projectId;
  const files = body?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new ValidationError('`files[]` is required.', { field: 'files' });
  }
  const normalised: PatchInput[] = files.map((file: any) => ({
    path: String(file?.path ?? ''),
    content: file?.content === null ? null : String(file?.content ?? ''),
  }));
  const message = typeof body?.message === 'string' ? body.message.slice(0, 500) : 'Platform patch';
  const requireApproval = body?.requireApproval === true;

  if (requireApproval) {
    const { run, created } = await platform.engine.start('patch.apply', {
      tenantId: principal.tenantId,
      projectId,
      actor: principal.userId,
      input: { projectId, files: normalised, message, requireApproval: true, approvalReason: typeof body?.reason === 'string' ? body.reason : undefined },
    });
    sendJson(res, 202, { ok: true, pendingApproval: true, run, created });
    return;
  }

  const workspace = getProjectWorkspace(projectId);
  const result = await applyPatch({
    transactionRoot: platform.transactionRoot,
    workspaceRoot: workspace,
    actor: principal.userId,
    message,
    files: normalised,
  });

  let revision = null;
  if (body?.createRevision !== false) {
    revision = await platform.revisions.commitRevision({
      tenantId: principal.tenantId,
      projectId,
      workspaceRoot: workspace,
      message,
      actor: principal.userId,
    });
  }

  sendJson(res, 200, { ok: true, transactionId: result.transactionId, result, revision });
});

add('GET', '/api/platform/projects/:projectId/sbom', async ({ res, params, platform, principal }) => {
  requirePermission(principal, 'project:read', params.projectId);
  const workspace = getProjectWorkspace(params.projectId);
  const pubspecPath = path.join(workspace, 'pubspec.yaml');
  const pubspec = await fs.readFile(pubspecPath, 'utf8').catch(() => null);
  if (!pubspec) {
    throw new PlatformError({ code: 'PUBSPEC_NOT_FOUND', message: 'pubspec.yaml is not present in this project yet.', statusCode: 404 });
  }
  const pubspecLock = await fs.readFile(path.join(workspace, 'pubspec.lock'), 'utf8').then((content) => content as string | null).catch(() => null);
  const started = Date.now();
  const result = generateSbom({ pubspec, pubspecLock });

  await platform.audit.append({
    tenantId: principal.tenantId,
    actor: principal.userId,
    action: 'sbom.generate',
    resourceType: 'project',
    resourceId: params.projectId,
    metadata: { total: result.stats.total, direct: result.stats.direct, durationMs: Date.now() - started },
  });

  sendJson(res, 200, { ok: true, sbom: result.sbom, stats: result.stats, warnings: result.warnings, packages: result.packages });
});

add('GET', '/api/platform/projects/:projectId/revisions', async ({ res, url, params, platform, principal }) => {
  requirePermission(principal, 'project:read', params.projectId);
  const limit = Number(url.searchParams.get('limit') ?? '50');
  const revisions = await platform.revisions.listRevisions({ tenantId: principal.tenantId, projectId: params.projectId, limit });
  sendJson(res, 200, { ok: true, revisions });
});

add('POST', '/api/platform/projects/:projectId/revisions/:revisionId/restore', async ({ res, params, body, platform, principal }) => {
  requirePermission(principal, 'project:rollback', params.projectId);
  const run = await platform.revisions.restoreRevision({
    revisionId: params.revisionId,
    tenantId: principal.tenantId,
    actor: principal.userId,
    workspaceRoot: getProjectWorkspace(params.projectId),
    transactionRoot: platform.transactionRoot,
  });
  sendJson(res, 200, { ok: true, result: run });
});

add('GET', '/api/platform/audit/verify', async ({ res, url, platform, principal }) => {
  requirePermission(principal, 'audit:read');
  const limit = Number(url.searchParams.get('limit') ?? '10000');
  const verification = await platform.audit.verify({ tenantId: principal.tenantId, limit });
  sendJson(res, 200, { ok: verification.ok, verification });
});

add('GET', '/api/platform/audit/entries', async ({ res, url, platform, principal }) => {
  requirePermission(principal, 'audit:read');
  const limit = Number(url.searchParams.get('limit') ?? '100');
  const afterSeq = Number(url.searchParams.get('after') ?? '0');
  const entries = await platform.audit.list({ tenantId: principal.tenantId, limit, afterSeq });
  sendJson(res, 200, { ok: true, entries });
});

add('POST', '/api/platform/qa/verify-project', async ({ res, body, platform, principal }) => {
  requirePermission(principal, 'project:write');
  const files = body?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new ValidationError('`files[]` is required.', { field: 'files' });
  }
  const normalised = files.slice(0, 5000).map((file: any) => ({ path: String(file?.path ?? ''), content: typeof file?.content === 'string' ? file.content : String(file?.content ?? '') }));
  const packageName = String(body?.packageName ?? '').trim();
  if (!packageName) throw new ValidationError('`packageName` is required.', { field: 'packageName' });

  const started = Date.now();
  const result = verifyProjectContract({
    files: normalised,
    packageName,
    appId: typeof body?.appId === 'string' ? body.appId : undefined,
    expectsSupabase: body?.expectsSupabase === true,
    expectations: typeof body?.expectations === 'object' && body.expectations !== null ? body.expectations : undefined,
  });

  await platform.audit.append({
    tenantId: principal.tenantId,
    actor: principal.userId,
    action: 'qa.verify_project',
    resourceType: 'project',
    resourceId: packageName,
    metadata: { passed: result.passed, blockers: result.blockers.length, checks: result.checks.length, durationMs: Date.now() - started },
  });

  sendJson(res, 200, { ok: result.passed, checks: result.checks, blockers: result.blockers });
});

add('POST', '/api/platform/gate/analyze', async ({ res, body, principal }) => {
  requirePermission(principal, 'project:write');
  const files = body?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new ValidationError('`files[]` is required.', { field: 'files' });
  }
  const normalised = files.slice(0, 5000).map((file: any) => ({ path: String(file?.path ?? ''), content: String(file?.content ?? '') }));
  const packageName = String(body?.packageName ?? '').trim();
  if (!packageName) throw new ValidationError('`packageName` is required.', { field: 'packageName' });

  const result = validateDartFiles({
    files: normalised,
    packageName,
    entrypoint: typeof body?.entrypoint === 'string' ? body.entrypoint : undefined,
  });

  sendJson(res, 200, {
    ok: result.passed,
    passed: result.passed,
    blockers: result.blockers,
    warnings: result.warnings,
    diagnostics: result.diagnostics,
    truncated: result.truncated,
  });
});

add('POST', '/api/platform/maintenance/prune', async ({ res, body, platform, principal }) => {
  requirePermission(principal, 'org:manage');
  const days = Number(body?.retentionDays ?? platform.config.workflow.retentionDays);
  const pruned = await platform.engine.pruneRetention(Number.isFinite(days) ? days : 30);
  sendJson(res, 200, { ok: true, pruned });
});

// ------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------

export async function handlePlatformRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const pathname = url.pathname;
  if (!isPlatformPath(pathname)) return false;

  securityHeaders(res);
  const started = process.hrtime.bigint();
  const requestId = prefixedId('req');
  const incomingTrace = typeof req.headers.traceparent === 'string' ? req.headers.traceparent : undefined;
  const trace = parseTraceparent(incomingTrace);
  res.setHeader('x-request-id', requestId);
  if (trace) res.setHeader('traceparent', formatTraceparent(trace.traceId, trace.parentSpanId, true));

  try {
    const platform = await getPlatform();
    const principal = await resolvePrincipal(req, platform);
    const parsed = route(table, req.method ?? 'GET', pathname);
    if (!parsed) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown platform route.', requestId } });
      observe(`unmatched:${scrubPath(pathname)}`, req.method, 404, started);
      return true;
    }

    // Requests with a meaningful body get bounded parsing.
    let body: any = {};
    if (['POST', 'PUT', 'PATCH'].includes(req.method ?? '')) {
      body = await readJsonBody(req, platform.config.http.maxBodyBytes);
    }

    await parsed.handler({ req, res, url, params: parsed.params, body, platform, principal, requestId });
    observe(parsed.pattern, req.method, res.statusCode, started);
    platform.logger.debug('platform request complete', { path: parsed.pattern, status: res.statusCode });
    return true;
  } catch (error) {
    fallbackLogger.warn('platform request failed', { path: url.pathname, err: error instanceof Error ? error.message : String(error) });
    const status = statusForError(error);
    const body = toErrorBody(error, requestId);
    sendJson(res, status, body);
    observe(scrubPath(pathname), req.method, status, started);
    return true;
  }
}

const fallbackLogger = createLogger({ name: 'platform', level: 'warn' });

function scrubPath(pathname: string): string {
  return pathname.replace(/[0-9A-Za-z]{16,}/g, ':id').slice(0, 96);
}

function observe(route: string, method: string | undefined, status: number, startedNs: bigint): void {
  const routeLabel = route.slice(0, 96);
  const statusClass = `${Math.floor(status / 100)}xx`;
  try {
    httpRequests.inc({ method: (method ?? 'GET').toUpperCase(), route: routeLabel, status: statusClass });
    httpLatency.observeMs(Number(process.hrtime.bigint() - startedNs) / 1e6, { method: (method ?? 'GET').toUpperCase(), route: routeLabel });
  } catch {
    /* never fail a request because metrics degraded */
  }
}
