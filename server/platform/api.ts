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
import { createReleaseBuildWorkflow } from './release/buildWorkflow.js';
import { createPromptToAppWorkflow } from './generation/promptToApp.js';
import { createAppForgeWorkflow, appForgeDefaultDeps } from './generation/forgeWorkflow.js';
import { createReviewBoardWorkflow, readProjectFiles } from './agents/reviewWorkflow.js';
import { createReviewContext, getAgentDefinition, listAgents, listAgentsByDepartment, runAgentCorps } from './agents/index.js';
import { compileSpec } from './generation/spec/index.js';
import { validateSpec } from './generation/emit/shared.js';
import { BENCHMARKS } from './generation/quality/index.js';
import { APP_DOMAINS, type AppDomain } from './generation/contracts.js';
import { MeteringService } from './metering/usage.js';
import {
  buildReleasePlan,
  checkReleaseReadiness,
  RELEASE_TARGETS,
  type ReleaseTarget,
} from './release/release.js';
import { gate as osvGate } from './security/osv.js';
import { OtlpExporter } from './observability/otel.js';
import { Tracer } from './observability/tracing.js';
import { createSandboxRunner, SandboxError, type CreatedSandboxRunner } from './sandbox/index.js';
import { sha256Hex } from './kernel/hash.js';
import { promises as fs } from 'node:fs';
import { buildStarterProject } from './generation/starter/index.js';
import { snapshotFiles } from '../harness/workspace.js';
import { verifyProject } from '../harness/verify.js';
import { applyPatch, type PatchInput } from './patch/transaction.js';
import { getProjectWorkspace, getWorkspacesRoot } from '../harness/run.js';
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
    platformPromise = createPlatform().then(async (platform) => {
      platform.engine.register(createPatchApplyWorkflow(platform));
      platform.engine.register(createVerifyHealWorkflow(createLiveVerifyHealDeps({ audit: platform.audit })));
      platform.engine.register(createReleaseBuildWorkflow({ dataDir: platform.config.dataDir }));
      platform.engine.register(createPromptToAppWorkflow({ dataDir: platform.config.dataDir, transactionRoot: platform.transactionRoot }));
      platform.engine.register(createAppForgeWorkflow(appForgeDefaultDeps({ dataDir: platform.config.dataDir, transactionRoot: platform.transactionRoot })));
      platform.engine.register(createReviewBoardWorkflow());
      // Warm the sandbox: in isolation-required deployments a missing Docker
      // daemon must abort startup, not first use. Everywhere else the probe
      // runs in the background so boot latency is unchanged.
      const sandboxReady = getSandbox(platform);
      if (platform.config.sandbox.requireIsolation) {
        await sandboxReady;
      } else {
        void sandboxReady.catch(() => undefined);
      }
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
  if (sandboxPromise) {
    const sandbox = await sandboxPromise.catch(() => null);
    await sandbox?.runner.dispose?.().catch(() => undefined);
    sandboxPromise = null;
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
// ----------------------------------------------------------------
// OTLP tracing (optional) + metering singleton
// ----------------------------------------------------------------
// Tracing ships nothing over the network by default. Set
// FLUTTERFORGE_OTLP_ENDPOINT (or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) to a
// collector URL and spans for platform requests flow there; unset means the
// Tracer runs in-process and export() is a no-op.
let platformTracer: Tracer | null = null;

function getTracer(): Tracer {
  if (platformTracer) return platformTracer;
  const endpoint = (process.env.FLUTTERFORGE_OTLP_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? '').trim();
  if (!endpoint) {
    platformTracer = new Tracer({ serviceName: 'flutterforge-platform', enabled: false, sampleRatio: 0 });
    return platformTracer;
  }
  const parsed = Number(process.env.FLUTTERFORGE_TRACE_SAMPLE_RATIO ?? '0.1');
  const otelExporter = new OtlpExporter({ endpoint, serviceName: 'flutterforge-platform', logger: fallbackLogger });
  platformTracer = new Tracer({
    serviceName: 'flutterforge-platform',
    enabled: true,
    sampleRatio: Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.1,
    exporter: otelExporter,
  });
  return platformTracer;
}

let meteringService: MeteringService | null = null;
function ensureMetering(platform: PlatformInstance): MeteringService {
  if (!meteringService) {
    meteringService = new MeteringService({ db: platform.db, clock: platform.clock, audit: platform.audit });
  }
  return meteringService;
}

let sandboxPromise: Promise<CreatedSandboxRunner> | null = null;

/**
 * Lazily created, process-wide sandbox runner. A failed construction (Docker
 * missing in isolation-required mode, unusable workspace root) clears the
 * cache so a later call can recover once the environment is fixed.
 */
function getSandbox(platform: PlatformInstance): Promise<CreatedSandboxRunner> {
  if (!sandboxPromise) {
    sandboxPromise = (async () => {
      const workspaceRoot = getWorkspacesRoot();
      await fs.mkdir(workspaceRoot, { recursive: true });
      const sandbox = platform.config.sandbox;
      const created = await createSandboxRunner({
        mode: sandbox.mode,
        workspaceRoot,
        image: sandbox.dockerImage,
        runtime: sandbox.runtime,
        limits: { cpuCores: sandbox.cpuCores, memoryMb: sandbox.memoryMb },
        maxConcurrent: sandbox.maxConcurrent,
        requireIsolation: sandbox.requireIsolation,
      });
      if (created.describe.warning) {
        platform.logger.warn('sandbox degraded: commands run without container isolation', {
          warning: created.describe.warning,
          requireIsolation: sandbox.requireIsolation,
        });
      }
      return created;
    })();
    sandboxPromise.catch(() => {
      sandboxPromise = null;
    });
  }
  return sandboxPromise;
}

const expensiveRouteBucket = new Bucket(10, 10 / 60); // 10 per minute per principal
const specRouteBucket = new Bucket(30, 30 / 60); // 30 per minute per principal

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
  const sandbox = await getSandbox(platform).catch(() => null);
  sendJson(res, 200, {
    ok: true,
    version,
    pillars: [
      { pillar: '01', name: 'Experience & Interaction', status: 'reused', notes: 'Existing React studio unchanged by this module.' },
      { pillar: '02', name: 'API Gateway & Identity', status: 'implemented', notes: 'Local/HS256 JWT mode, RBAC, tenant claim enforcement, rate limits, optional KMS vault at rest.' },
      { pillar: '03', name: 'Intent & Intelligence', status: 'ported', notes: 'Existing intent router remains; platform exposes typed diagnostics for repair turns.' },
      { pillar: '04', name: 'Orchestration Control Plane', status: 'implemented', notes: 'Durable DAG engine with leases, retries, suspension, compensation, idempotency.' },
      { pillar: '05', name: 'Human Governance', status: 'implemented', notes: 'Approval gates, risk levels, pending-approval API, immutable audit trail.' },
      { pillar: '06', name: 'Discovery & Planning', status: 'implemented', notes: 'Deterministic prompt→AppSpec compiler (domain inference, focus-corrected entities, screens/flows/design/requirements) plus starter synthesis and optional LLM enrichment (server-side, failure-safe).' },
      { pillar: '07', name: 'Engineering & Generation', status: 'implemented', notes: '`app.forge` durable DAG: spec → zero-dependency Flutter emit (models/repos/controllers/screens) → quality rubric (A ≥ 90) → real `flutter analyze` gate → 2PC seal; byte-deterministic re-emission. Legacy recipe DAG and agent pipeline remain.' },
      { pillar: '08', name: 'Transactional Patch Engine', status: 'implemented', notes: 'Two-phase commit, per-workspace mutex/file lock, crash recovery, content-addressed revisions.' },
      {
        pillar: '09',
        name: 'Execution Sandbox',
        status: sandbox ? (sandbox.describe.mode === 'docker' ? 'implemented' : 'degraded') : 'unavailable',
        notes: sandbox
          ? `effective=${sandbox.describe.mode} (requested=${sandbox.describe.requestedMode}), runtime=${platform.config.sandbox.runtime}, image=${platform.config.sandbox.dockerImage}; argv allowlist, host-path confinement, no-shell spawn, read-only container rootfs, ${platform.config.sandbox.cpuCores} CPU / ${platform.config.sandbox.memoryMb} MB caps; fail-closed with FLUTTERFORGE_SANDBOX_REQUIRE_ISOLATION=1.${sandbox.describe.warning ? ` WARNING: ${sandbox.describe.warning}` : ''}`
          : 'The sandbox runner could not be created; see server logs.',
      },
      { pillar: '10', name: 'QA & Self-Healing', status: 'implemented', notes: 'Dart-aware structural gate, analyzer diagnostic parsing, contract verifier, healing policy with oscillation detection, visual QA gate (token compliance, accessibility, responsiveness); `verify.heal` workflow runs the closed repair loop.' },
      { pillar: '10b', name: 'Agent Corps (review organization)', status: 'implemented', notes: '20 deterministic specialist agents across product, design, engineering, quality, delivery and intelligence; department-weighted scorecard; `review.board` durable DAG fails closed on blockers.' },
      { pillar: '11', name: 'Runtime & Preview', status: 'ported', notes: 'Preview service untouched.' },
      { pillar: '12', name: 'Release & Deployment', status: 'implemented', notes: 'release.build DAG (readiness → flutter build → artifact), artifact listing with sha256 manifests, GitHub branch/PR sync.' },
      { pillar: '13', name: 'Data & Persistence', status: 'implemented', notes: 'SQLite/WAL default + Postgres driver seam via FLUTTERFORGE_PLATFORM_DB_DRIVER=postgres; AES-256 vault for secrets; content-addressed revisions; audit chain.' },
      { pillar: '14', name: 'Security & Trust', status: 'implemented', notes: 'Vault (AES-256-GCM, scrypt), audit chain, redaction, sandbox policy, OSV vulnerability gate, tenant enforcement.' },
      { pillar: '15', name: 'Observability', status: 'implemented', notes: 'Structured JSON-L with redaction, W3C traceparent tracing, Prometheus metrics, opt-in OTLP export (FLUTTERFORGE_OTLP_ENDPOINT).' },
      { pillar: '16', name: 'Billing & Governance', status: 'implemented', notes: 'MeteringService with charge-before-LLM semantics, quota enforcement fail-closed in platform_settings, token_usage ledger.' },
    ],
    workflows: engines,
    agents: {
      count: listAgents().length,
      departments: listAgentsByDepartment().map((department) => ({
        department: department.department,
        label: department.label,
        weight: department.weight,
        count: department.agents.length,
      })),
    },
  });
});

add('GET', '/api/platform/sandbox', async ({ res, platform, principal }) => {
  requirePermission(principal, 'sandbox:execute');
  const sandbox = await getSandbox(platform);
  sendJson(res, 200, { ok: true, sandbox: sandbox.describe });
});

add('POST', '/api/platform/projects/:projectId/sandbox/exec', async ({ res, params, body, platform, principal }) => {
  requirePermission(principal, 'sandbox:execute', params.projectId);
  if (!expensiveRouteBucket.consume(`${principal.userId}:${params.projectId}:sandbox`).allowed) {
    rateLimited.inc({ tier: 'sandbox_exec' });
    throw new RateLimitError(60_000, { tier: 'sandbox_exec' });
  }

  const rawArgv = body?.argv;
  const argv = Array.isArray(rawArgv) ? rawArgv.map((item: unknown) => (typeof item === 'string' ? item : '')) : null;
  const argvValid = argv !== null
    && argv.length > 0
    && argv.length <= 64
    && argv.every((item) => item.length > 0 && item.length <= 4096 && !item.includes('\0'));
  if (!argvValid) {
    throw new ValidationError('`argv` must be a non-empty array of 1-64 non-empty strings (no NUL bytes).', { field: 'argv' });
  }

  const workspaceRoot = path.resolve(getWorkspacesRoot());
  const projectRoot = path.resolve(getProjectWorkspace(params.projectId));
  if (projectRoot !== workspaceRoot && !projectRoot.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new ValidationError('projectId resolves outside the workspace root.', { field: 'projectId' });
  }
  await fs.mkdir(projectRoot, { recursive: true });

  const sandbox = await getSandbox(platform);
  const startedAt = Date.now();
  let result;
  try {
    result = await sandbox.runner.run({
      argv,
      cwd: projectRoot,
      timeoutMs: typeof body?.timeoutMs === 'number' && Number.isFinite(body.timeoutMs) ? body.timeoutMs : undefined,
    });
  } catch (error) {
    if (error instanceof SandboxError) {
      throw new PlatformError({
        code: error.code,
        message: error.message,
        statusCode: error.code === 'UNAVAILABLE' ? 503 : error.code === 'TIMEOUT' ? 504 : 422,
        details: { ...error.details },
      });
    }
    throw error;
  }
  const durationMs = Date.now() - startedAt;

  // Audit records what ran, not the raw argv: arguments can carry deploy
  // tokens (for example a git remote URL), and the audit chain outlives them.
  await platform.audit.append({
    tenantId: principal.tenantId,
    actor: principal.userId,
    action: 'sandbox.exec',
    resourceType: 'project',
    resourceId: params.projectId,
    metadata: {
      command: argv[0],
      argCount: argv.length,
      argvHash: sha256Hex(JSON.stringify(argv)),
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs,
      mode: sandbox.describe.mode,
    },
  });

  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text);
  sendJson(res, 200, {
    ok: result.exitCode === 0,
    mode: sandbox.describe.mode,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs,
    stdout: clip(result.stdout, 200_000),
    stderr: clip(result.stderr, 100_000),
  });
});

add('GET', '/api/platform/agents', async ({ res, principal }) => {
  requirePermission(principal, 'project:read');
  sendJson(res, 200, {
    ok: true,
    count: listAgents().length,
    agents: listAgents(),
    departments: listAgentsByDepartment(),
  });
});

add('GET', '/api/platform/agents/:agentId', async ({ res, params, principal }) => {
  requirePermission(principal, 'project:read');
  const agent = getAgentDefinition(params.agentId);
  if (!agent) {
    throw new PlatformError({ code: 'AGENT_NOT_FOUND', message: `No agent with id "${params.agentId}".`, statusCode: 404 });
  }
  const { run: _run, ...summary } = agent;
  sendJson(res, 200, { ok: true, agent: summary });
});

function parseAgentIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
  return ids.length > 0 ? ids : undefined;
}

add('POST', '/api/platform/agents/review', async ({ res, body, platform, principal }) => {
  if (!specRouteBucket.consume(principal.userId).allowed) {
    rateLimited.inc({ tier: 'agent_review' });
    throw new RateLimitError(60_000, { tier: 'agent_review' });
  }
  requirePermission(principal, 'project:write');
  const files = body?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new ValidationError('`files[]` is required.', { field: 'files' });
  }
  const normalised = files.slice(0, 5000).map((file: any) => ({
    path: String(file?.path ?? ''),
    content: String(file?.content ?? ''),
  }));
  const projectId = typeof body?.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : 'inline';
  const prompt = typeof body?.prompt === 'string' ? body.prompt : undefined;

  let scorecard;
  try {
    scorecard = await runAgentCorps(createReviewContext({ projectId, files: normalised, prompt }), {
      agentIds: parseAgentIds(body?.agentIds),
      excludeInfo: body?.excludeInfo === true,
    });
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : String(error), { field: 'agentIds' });
  }

  await platform.audit.append({
    tenantId: principal.tenantId,
    actor: principal.userId,
    action: 'agents.review',
    resourceType: 'project',
    resourceId: projectId,
    metadata: {
      verdict: scorecard.verdict,
      score: scorecard.overallScore,
      agents: scorecard.stats.agents,
      findings: scorecard.stats.findings,
      blockers: scorecard.stats.blockers,
      files: scorecard.stats.filesReviewed,
    },
  });

  sendJson(res, 200, { ok: scorecard.verdict !== 'fail', scorecard });
});

add('POST', '/api/platform/projects/:projectId/agents/review', async ({ res, params, body, platform, principal }) => {
  if (!specRouteBucket.consume(principal.userId).allowed) {
    rateLimited.inc({ tier: 'agent_review' });
    throw new RateLimitError(60_000, { tier: 'agent_review' });
  }
  requirePermission(principal, 'project:read', params.projectId);
  const files = await readProjectFiles(params.projectId).catch((error) => {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError({
      code: 'AGENT_REVIEW_SNAPSHOT_FAILED',
      message: error instanceof Error ? error.message : String(error),
      statusCode: 500,
    });
  });

  let scorecard;
  try {
    scorecard = await runAgentCorps(createReviewContext({
      projectId: params.projectId,
      files,
      prompt: typeof body?.prompt === 'string' ? body.prompt : undefined,
    }), {
      agentIds: parseAgentIds(body?.agentIds),
      excludeInfo: body?.excludeInfo === true,
    });
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : String(error), { field: 'agentIds' });
  }

  await platform.audit.append({
    tenantId: principal.tenantId,
    actor: principal.userId,
    action: 'agents.review',
    resourceType: 'project',
    resourceId: params.projectId,
    metadata: {
      verdict: scorecard.verdict,
      score: scorecard.overallScore,
      agents: scorecard.stats.agents,
      findings: scorecard.stats.findings,
      blockers: scorecard.stats.blockers,
      files: scorecard.stats.filesReviewed,
    },
  });

  sendJson(res, 200, { ok: scorecard.verdict !== 'fail', scorecard });
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
  const projectRow = await platform.db.get<{ project_id: string | null; tenant_id: string }>(
    'SELECT r.project_id, r.tenant_id FROM workflow_approvals a JOIN workflow_runs r ON r.id = a.run_id WHERE a.id = ?',
    params.approvalId,
  );
  if (projectRow) tenantScope(principal, projectRow.tenant_id);
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

add('POST', '/api/platform/projects/:projectId/starter', async ({ res, params, body, platform, principal }) => {
  requirePermission(principal, 'project:write', params.projectId);
  const workspace = getProjectWorkspace(params.projectId);
  const existing = await fs.readdir(workspace).catch(() => [] as string[]);
  const meaningful = existing.filter((entry) => entry !== '.flutterforge');
  if (meaningful.length > 0) {
    throw new PlatformError({
      code: 'STARTER_ALREADY_SCAFFOLDED',
      message: 'Starter scaffold refused: project already contains files. Use patch.apply to add or modify existing code.',
      statusCode: 409,
      details: { projectId: params.projectId, files: meaningful.slice(0, 10) },
    });
  }

  const appName = typeof body?.appName === 'string' && body.appName.trim() ? body.appName.trim() : params.projectId;
  const packageName = typeof body?.packageName === 'string' && body.packageName.trim()
    ? body.packageName.trim()
    : appName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'flutterforge_app';
  const seedColor = typeof body?.seedColor === 'string' ? body.seedColor : undefined;
  const darkColor = typeof body?.darkColor === 'string' ? body.darkColor : undefined;
  const backend = body?.backend === 'supabase' ? 'supabase' : 'local';
  const environmentSdk = typeof body?.environmentSdk === 'string' ? body.environmentSdk : undefined;

  const files = buildStarterProject({ appName, packageName, seedColor, darkColor, backend, environmentSdk });
  const result = await applyPatch({
    transactionRoot: platform.transactionRoot,
    workspaceRoot: workspace,
    actor: principal.userId,
    message: `starter.scaffold:${appName}`,
    files: files.map((file) => ({ path: file.path, content: file.content })),
  });

  // Cross-check the emitted source against the structural gate before sealing.
  const gate = validateDartFiles({ files, packageName, entrypoint: 'lib/main.dart' });
  const contract = verifyProjectContract({ files, packageName, expectations: { requiredDependencies: ['flutter', 'go_router', 'provider'] } });

  await platform.audit.append({
    tenantId: principal.tenantId,
    actor: principal.userId,
    action: 'starter.scaffold',
    resourceType: 'project',
    resourceId: params.projectId,
    metadata: { fileCount: result.filesWritten, transactionId: result.transactionId, gatePassed: gate.passed, contractPassed: contract.passed },
  });

  sendJson(res, 201, {
    ok: true,
    transactionId: result.transactionId,
    files: result.changes,
    gate: { passed: gate.passed, blockers: gate.blockers },
    contract: { passed: contract.passed, blockers: contract.blockers },
  });
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

add('POST', '/api/platform/projects/:projectId/revisions/:revisionId/restore', async ({ res, params, platform, principal }) => {
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

add('POST', '/api/platform/usage/record', async ({ res, body, platform, principal }) => {
  const metering = ensureMetering(platform);
  requirePermission(principal, 'project:write', typeof body?.projectId === 'string' ? body.projectId : undefined);
  const record = await metering.record({
    tenantId: principal.tenantId,
    projectId: typeof body?.projectId === 'string' && body.projectId.trim() ? body.projectId : undefined,
    runId: typeof body?.runId === 'string' && body.runId.trim() ? body.runId : undefined,
    provider: String(body?.provider ?? ''),
    model: String(body?.model ?? ''),
    promptTokens: Number(body?.promptTokens ?? 0),
    completionTokens: Number(body?.completionTokens ?? 0),
    cachedTokens: body?.cachedTokens === undefined ? undefined : Number(body.cachedTokens),
    ...(body?.costMicros === undefined ? {} : { costMicros: Number(body.costMicros) }),
  });
  sendJson(res, 201, { ok: true, id: record.id });
});

add('POST', '/api/platform/usage/charge', async ({ res, body, platform, principal }) => {
  const metering = ensureMetering(platform);
  requirePermission(principal, 'project:write', typeof body?.projectId === 'string' ? body.projectId : undefined);
  const charge = await metering.chargeFor({
    tenantId: principal.tenantId,
    projectId: typeof body?.projectId === 'string' && body.projectId.trim() ? body.projectId : undefined,
    runId: typeof body?.runId === 'string' && body.runId.trim() ? body.runId : undefined,
    provider: String(body?.provider ?? ''),
    model: String(body?.model ?? ''),
    promptTokens: Number(body?.promptTokens ?? 0),
    completionTokens: Number(body?.completionTokens ?? 0),
    cachedTokens: body?.cachedTokens === undefined ? undefined : Number(body.cachedTokens),
    ...(body?.costMicros === undefined ? {} : { costMicros: Number(body.costMicros) }),
  });
  if (charge.ok === false) {
    sendJson(res, 429, { ok: false, reason: charge.reason, quota: charge.quota });
    return;
  }
  sendJson(res, 201, { ok: true, usage: charge.usage, quota: charge.quota });
});

add('GET', '/api/platform/usage/summary', async ({ res, url, platform, principal }) => {
  const metering = ensureMetering(platform);
  requirePermission(principal, 'audit:read');
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? '30') || 30));
  const projectId = url.searchParams.get('projectId') ?? undefined;
  const sinceMs = Date.now() - days * 86_400_000;
  const summary = await metering.summary({ tenantId: principal.tenantId, projectId, sinceMs });
  sendJson(res, 200, { ok: true, days, summary });
});

add('GET', '/api/platform/usage/quota', async ({ res, platform, principal }) => {
  const metering = ensureMetering(platform);
  requirePermission(principal, 'project:read');
  const quota = await metering.checkQuota(principal.tenantId);
  sendJson(res, 200, { ok: quota.allowed, quota });
});

add('POST', '/api/platform/usage/quota', async ({ res, body, platform, principal }) => {
  const metering = ensureMetering(platform);
  requirePermission(principal, 'org:manage');
  const costBasis = body?.costBasis === 'tokens' ? 'tokens' : 'micros';
  const quota = await metering.setQuota({
    tenantId: principal.tenantId,
    windowMs: Number(body?.windowMs ?? 86_400_000),
    limitTokens: body?.limitTokens === undefined ? undefined : Number(body.limitTokens),
    limitMicros: body?.limitMicros === undefined ? undefined : Number(body.limitMicros),
    costBasis,
  });
  await platform.audit.append({
    tenantId: principal.tenantId,
    actor: principal.userId,
    action: 'metering.quota_set',
    resourceType: 'tenant',
    resourceId: principal.tenantId,
    metadata: { quota },
  });
  sendJson(res, 200, { ok: true, quota });
});

add('POST', '/api/platform/security/vulnerabilities', async ({ res, body, platform, principal }) => {
  const projectId = typeof body?.projectId === 'string' && body.projectId.trim() ? body.projectId : undefined;
  requirePermission(principal, 'project:write', projectId);

  let lock: string | null = null;
  if (projectId) {
    lock = await fs.readFile(path.join(getProjectWorkspace(projectId), 'pubspec.lock'), 'utf8').catch(() => null);
    if (!lock) throw new PlatformError({ code: 'PUBSPEC_LOCK_NOT_FOUND', message: 'This project has no pubspec.lock; run flutter pub get first.', statusCode: 422 });
  } else if (typeof body?.lock === 'string' && body.lock.trim()) {
    lock = body.lock;
  } else {
    throw new ValidationError('Provide `projectId` or `lock` (pubspec.lock contents).', { field: 'projectId' });
  }

  const policy = body?.policy === 'warn' ? 'warn' : 'block';
  const allowIds = Array.isArray(body?.allowIds) ? (body.allowIds as unknown[]).filter((v): v is string => typeof v === 'string') : undefined;
  const result = await osvGate({ lock, policy, ...(allowIds ? { allowIds } : {}) });

  await platform.audit.append({
    tenantId: principal.tenantId,
    actor: principal.userId,
    action: 'security.vulnerabilities',
    resourceType: 'project',
    resourceId: projectId ?? 'inline-lock',
    metadata: { policy, blocked: result.blocked, findings: result.vulnerabilities.length, errors: result.errors.length },
  });

  sendJson(res, result.blocked ? 422 : 200, {
    ok: !result.blocked,
    blocked: result.blocked,
    policy: result.policy,
    totalPackages: result.totalPackages,
    vulnerabilities: result.vulnerabilities.slice(0, 100),
    errors: result.errors,
    checkedAtMs: result.checkedAtMs,
  });
});

add('POST', '/api/platform/release/plan', async ({ res, body, principal }) => {
  const projectId = typeof body?.projectId === 'string' ? body.projectId.trim() : '';
  if (!projectId) throw new ValidationError('`projectId` is required.', { field: 'projectId' });
  const target = typeof body?.target === 'string' ? body.target : '';
  if (!(RELEASE_TARGETS as readonly string[]).includes(target)) {
    throw new ValidationError(`target must be one of: ${RELEASE_TARGETS.join(', ')}`, { field: 'target' });
  }
  requirePermission(principal, 'project:read', projectId);
  const workspace = getProjectWorkspace(projectId);
  const readiness = await checkReleaseReadiness({ target: target as ReleaseTarget, projectId, projectRoot: workspace });
  const plan = buildReleasePlan({ target: target as ReleaseTarget, projectId, artifactDir: path.join(getProjectWorkspace(projectId), '.releases'), projectRoot: workspace, tenantId: principal.tenantId, actor: principal.userId });
  sendJson(res, 200, { ok: readiness.ready, readiness, plan });
});

add('POST', '/api/platform/release/build', async ({ res, body, platform, principal }) => {
  if (!expensiveRouteBucket.consume(principal.userId).allowed) {
    rateLimited.inc({ tier: 'release_build' });
    throw new RateLimitError(60_000, { tier: 'release_build' });
  }
  const projectId = typeof body?.projectId === 'string' ? body.projectId.trim() : '';
  if (!projectId) throw new ValidationError('`projectId` is required.', { field: 'projectId' });
  const target = typeof body?.target === 'string' ? body.target : '';
  if (!(RELEASE_TARGETS as readonly string[]).includes(target)) {
    throw new ValidationError(`target must be one of: ${RELEASE_TARGETS.join(', ')}`, { field: 'target' });
  }
  requirePermission(principal, 'workflow:start', projectId);
  const osvPolicy = body?.osvPolicy === 'warn' ? 'warn' : 'block';
  const { run } = await platform.engine.start('release.build', {
    tenantId: principal.tenantId,
    projectId,
    actor: principal.userId,
    input: { projectId, target, osvPolicy },
    idempotencyKey: typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
  });
  sendJson(res, 202, { ok: true, run, created: true });
});


add('POST', '/api/platform/projects/:projectId/generate', async ({ res, params, body, platform, principal }) => {
  if (!expensiveRouteBucket.consume(principal.userId).allowed) {
    rateLimited.inc({ tier: 'workflow_start' });
    throw new RateLimitError(60_000, { tier: 'workflow_start' });
  }
  const projectId = params.projectId;
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new ValidationError('`prompt` is required.', { field: 'prompt' });
  requirePermission(principal, 'workflow:start', projectId);

  const { run } = await platform.engine.start('prompt.to.app', {
    tenantId: principal.tenantId,
    projectId,
    actor: principal.userId,
    input: {
      projectId,
      prompt,
      appName: typeof body?.appName === 'string' ? body.appName : undefined,
      packageName: typeof body?.packageName === 'string' ? body.packageName : undefined,
      seedColor: typeof body?.seedColor === 'string' ? body.seedColor : undefined,
      backend: body?.backend === 'supabase' ? 'supabase' : 'local',
      target: (typeof body?.target === 'string' ? body.target : 'web') as 'web' | 'zip' | 'android-apk' | 'android-aab' | 'ios-archive',
      recipeId: typeof body?.recipeId === 'string' ? body.recipeId : undefined,
    },
    idempotencyKey: typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
  });
  sendJson(res, 202, { ok: true, run, created: true });
});

add('GET', '/api/platform/release/artifacts', async ({ res, url, platform, principal }) => {
  const projectId = url.searchParams.get('projectId') ?? undefined;
  requirePermission(principal, 'project:read', projectId);
  const jobsDir = path.join(platform.config.dataDir, 'releases', 'jobs');
  const entries = await fs.readdir(jobsDir).catch(() => [] as string[]);
  const manifests: any[] = [];
  for (const entry of entries.slice(-200)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(jobsDir, entry), 'utf8'));
      if (projectId && manifest?.projectId !== projectId) continue;
      if (manifest?.tenantId && manifest.tenantId !== principal.tenantId) continue;
      manifests.push({
        jobId: manifest.jobId,
        projectId: manifest.projectId,
        target: manifest.target,
        status: manifest.status,
        size: manifest.artifact?.size ?? 0,
        sha256: manifest.artifact?.sha256,
        artifactName: manifest.artifact?.name,
        signingState: manifest.signingState,
        startedAtMs: manifest.startedAtMs,
        finishedAtMs: manifest.finishedAtMs,
      });
    } catch {
      // unreadable manifest: skip, don't fail the listing
    }
    if (manifests.length >= 50) break;
  }
  manifests.sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0));
  sendJson(res, 200, { ok: true, artifacts: manifests });
});

add('POST', '/api/platform/release/github/sync', async ({ res, params, body, platform, principal }) => {
  requirePermission(principal, 'org:manage');
  const projectId = params.projectId;
  const owner = process.env.FLUTTERFORGE_GITHUB_OWNER?.trim();
  const repo = process.env.FLUTTERFORGE_GITHUB_REPO?.trim();
  const token = process.env.FLUTTERFORGE_GITHUB_TOKEN?.trim();
  const missing = [owner ? null : 'FLUTTERFORGE_GITHUB_OWNER', repo ? null : 'FLUTTERFORGE_GITHUB_REPO', token ? null : 'FLUTTERFORGE_GITHUB_TOKEN'].filter(Boolean) as string[];
  if (missing.length > 0) {
    throw new PlatformError({
      code: 'GITHUB_NOT_CONFIGURED',
      message: `GitHub sync is not configured (missing ${missing.join(', ')}).`,
      statusCode: 503,
      details: { missing },
    });
  }

  const workspace = getProjectWorkspace(projectId);
  const snapshot = await snapshotFiles(workspace);
  const files = [...snapshot.entries()]
    .map(([filePath, entry]) => ({ path: filePath, content: entry.content, encoding: 'utf-8' as const }))
    .filter((file) => !/^\.env/i.test(file.path) && !/(^|\/)(credentials|secrets?|keys?)\./i.test(file.path))
    .slice(0, 100);
  if (files.length === 0) {
    throw new ValidationError('No project files to export.', { field: 'projectId' });
  }

  const { exportZipToBranch } = await import('./release/github.js');
  const slug = projectId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const branch = `flutterforge/release/${slug}-${stamp}`;
  const result = await exportZipToBranch({
    config: { owner, repo, token, baseBranch: process.env.FLUTTERFORGE_GITHUB_BASE_BRANCH?.trim() || 'main' },
    branch,
    files,
    title: typeof body?.title === 'string' ? body.title.slice(0, 200) : 'FlutterForge release export',
    body: typeof body?.body === 'string' ? body.body : 'FlutterForge export from the platform control plane.',
  });
  if (!result.ok) {
    throw new PlatformError({ code: 'GITHUB_SYNC_FAILED', message: 'message' in result ? String(result.message) : 'GitHub sync failed.', statusCode: 502, details: { status: 'status' in result ? result.status : 0 } });
  }

  await platform.audit.append({
    tenantId: principal.tenantId,
    actor: principal.userId,
    action: 'release.github_sync',
    resourceType: 'project',
    resourceId: projectId,
    metadata: { branch, commitSha: result.data.commitSha, prNumber: result.data.prNumber, prUrl: result.data.prUrl, files: files.length },
  });

  sendJson(res, 200, { ok: true, branch, commitSha: result.data.commitSha, prNumber: result.data.prNumber, prUrl: result.data.prUrl, filesCommitted: files.length, adjustments: result.data.adjustments });
});

add('POST', '/api/platform/projects/:projectId/verify', async ({ res, params, body, platform, principal }) => {
  if (!expensiveRouteBucket.consume(principal.userId).allowed) {
    rateLimited.inc({ tier: 'verify_project' });
    throw new RateLimitError(60_000, { tier: 'verify_project' });
  }
  const projectId = params.projectId;
  requirePermission(principal, 'project:write', projectId);
  const workspace = getProjectWorkspace(projectId);
  const snapshot = await snapshotFiles(workspace);
  const files = [...snapshot.entries()].map(([filePath, entry]) => ({ path: filePath, content: entry.content }));
  if (files.length === 0) throw new ValidationError('Project workspace is empty.', { field: 'projectId' });

  const result = await verifyProject({ projectId, files, timeoutMs: typeof body?.timeoutMs === 'number' ? Math.min(600_000, Math.max(30_000, body.timeoutMs)) : undefined });

  await platform.audit.append({
    tenantId: principal.tenantId,
    actor: principal.userId,
    action: 'qa.verify_project',
    resourceType: 'project',
    resourceId: projectId,
    metadata: { verified: result.verified, skipped: result.skipped, errorCount: result.errorCount, gatePassed: result.gate.passed },
  });

  sendJson(res, 200, {
    ok: result.verified,
    verified: result.verified,
    skipped: result.skipped,
    ok_verify: result.ok,
    summary: result.summary,
    errorCount: result.errorCount,
    warningCount: result.warningCount,
    gate: result.gate,
    durationMs: result.durationMs,
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

// ── Generation Quality Program ─────────────────────────────────────────
add('POST', '/api/platform/generation/spec', async ({ res, body, principal }) => {
  if (!specRouteBucket.consume(principal.userId).allowed) {
    rateLimited.inc({ tier: 'generation_spec' });
    throw new RateLimitError(60_000, { tier: 'generation_spec' });
  }
  requirePermission(principal, 'project:read');
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new ValidationError('`prompt` is required.', { field: 'prompt' });
  if (prompt.length > 4_000) throw new ValidationError('`prompt` must be 4000 characters or fewer.', { field: 'prompt' });

  const domain = typeof body?.domain === 'string' && (APP_DOMAINS as readonly string[]).includes(body.domain)
    ? (body.domain as AppDomain)
    : undefined;
  const seedCount = typeof body?.seedCount === 'number' && Number.isFinite(body.seedCount)
    ? Math.max(0, Math.min(24, Math.trunc(body.seedCount)))
    : undefined;

  const spec = compileSpec({
    prompt,
    appName: typeof body?.appName === 'string' && body.appName.trim() ? body.appName.trim().slice(0, 80) : undefined,
    packageName: typeof body?.packageName === 'string' && body.packageName.trim() ? body.packageName.trim().slice(0, 40) : undefined,
    seedColor: typeof body?.seedColor === 'string' ? body.seedColor : undefined,
    backend: body?.backend === 'supabase' ? 'supabase' : 'local',
    domain,
    seedCount,
  });
  const validation = validateSpec(spec);
  if (!validation.ok) {
    throw new PlatformError({ code: 'GENERATION_SPEC_INVALID', message: validation.errors.slice(0, 6).join('; '), statusCode: 422, details: { errors: validation.errors } });
  }
  sendJson(res, 200, { ok: true, spec, validation });
});

add('POST', '/api/platform/generation/build', async ({ res, body, platform, principal }) => {
  if (!expensiveRouteBucket.consume(principal.userId).allowed) {
    rateLimited.inc({ tier: 'generation_build' });
    throw new RateLimitError(60_000, { tier: 'generation_build' });
  }
  const projectId = typeof body?.projectId === 'string' ? body.projectId.trim() : '';
  if (!projectId) throw new ValidationError('`projectId` is required.', { field: 'projectId' });
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new ValidationError('`prompt` is required.', { field: 'prompt' });
  if (prompt.length > 4_000) throw new ValidationError('`prompt` must be 4000 characters or fewer.', { field: 'prompt' });

  const domain = typeof body?.domain === 'string' && (APP_DOMAINS as readonly string[]).includes(body.domain)
    ? (body.domain as AppDomain)
    : undefined;
  const minQuality = typeof body?.minQuality === 'number' && Number.isFinite(body.minQuality)
    ? Math.max(0, Math.min(100, Math.trunc(body.minQuality)))
    : undefined;
  const seedCount = typeof body?.seedCount === 'number' && Number.isFinite(body.seedCount)
    ? Math.max(0, Math.min(24, Math.trunc(body.seedCount)))
    : undefined;

  requirePermission(principal, 'workflow:start', projectId);
  const { run } = await platform.engine.start('app.forge', {
    tenantId: principal.tenantId,
    projectId,
    actor: principal.userId,
    input: {
      projectId,
      prompt,
      appName: typeof body?.appName === 'string' && body.appName.trim() ? body.appName.trim().slice(0, 80) : undefined,
      packageName: typeof body?.packageName === 'string' && body.packageName.trim() ? body.packageName.trim().slice(0, 40) : undefined,
      seedColor: typeof body?.seedColor === 'string' ? body.seedColor : undefined,
      backend: body?.backend === 'supabase' ? 'supabase' : 'local',
      domain,
      seedCount,
      minQuality,
      force: body?.force === true,
    },
    idempotencyKey: typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
  });
  sendJson(res, 202, { ok: true, run, created: true });
});

add('GET', '/api/platform/generation/quality', async ({ res, url, platform, principal }) => {
  const projectId = url.searchParams.get('projectId')?.trim() ?? '';
  if (!projectId) throw new ValidationError('`projectId` is required.', { field: 'projectId' });
  requirePermission(principal, 'project:read', projectId);
  const runs = await platform.engine.listRuns({ tenantId: principal.tenantId, projectId, limit: 25 });
  const latest = runs.find((run) => run.definition === 'app.forge');
  if (!latest) {
    throw new PlatformError({ code: 'GENERATION_REPORT_NOT_FOUND', message: 'No app.forge run found for this project yet.', statusCode: 404 });
  }
  const output = (latest.output && typeof latest.output === 'object' ? latest.output : {}) as Record<string, unknown>;
  const score = output.score as { report?: unknown } | undefined;
  const verify = output.verify as { gate?: unknown } | undefined;
  const emit = output.emit as { fileCount?: number; bytes?: number; layers?: Record<string, number> } | undefined;
  const seal = output.seal as { transactionId?: string; workspace?: string; filesWritten?: number } | undefined;
  const plan = output.plan as { spec?: { app?: { name?: string; domain?: string; tagline?: string }; entities?: unknown[]; screens?: unknown[]; flows?: unknown[] }; enriched?: boolean } | undefined;
  sendJson(res, 200, {
    ok: true,
    run: { id: latest.id, status: latest.status, finishedAt: latest.finishedAt },
    quality: score?.report ?? null,
    gate: verify?.gate ?? null,
    emitted: emit ?? null,
    seal: seal ?? null,
    spec: plan?.spec
      ? {
          app: plan.spec.app,
          entities: Array.isArray(plan.spec.entities) ? plan.spec.entities.length : 0,
          screens: Array.isArray(plan.spec.screens) ? plan.spec.screens.length : 0,
          flows: Array.isArray(plan.spec.flows) ? plan.spec.flows.length : 0,
          enriched: plan.enriched === true,
        }
      : null,
  });
});

add('GET', '/api/platform/generation/benchmarks', async ({ res, principal }) => {
  requirePermission(principal, 'project:read');
  sendJson(res, 200, {
    ok: true,
    benchmarks: BENCHMARKS.map(({ id, prompt, expectation, weight }) => ({ id, prompt, expectation, weight: weight ?? 1 })),
  });
});

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

  // One span per platform request. No-op unless an OTLP endpoint is configured.
  const span = getTracer().startSpan(`${(req.method ?? 'GET').toUpperCase()} ${pathname.split('/').slice(0, 4).join('/')}`, {
    kind: 'server',
    ...(trace ? { traceparent: incomingTrace } : {}),
    attributes: { 'http.method': req.method ?? 'GET', 'http.target': pathname },
  });
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
  } finally {
    span.setAttribute('http.status_code', res.statusCode);
    if (res.statusCode >= 500) span.setStatus('error');
    span.end();
    getTracer().flush();
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
