# Platform Control Plane

**Audience:** platform + security reviewers · **Scope:** `server/platform/` · **Status:** shipped in-repo, exercised by `demo` flows and `npm run test:platform`

The platform control plane turns FlutterForge from "an app that generates code" into the
control plane the Enterprise Architecture Plan describes: durable orchestration, transitory
safety at the disk boundary, deterministic verification, and an immutable audit trail behind
every action — without destabilising the existing harness, which remains the execution engine
for models today.

```
                        ┌─────────────────────────────────────────┐
 Browser / Electron ───▶│ /api/platform/*                         │
                        │  request-id · trace context · JWT/RBAC  │
                        │  rate limit · tenant scoping · metrics  │
                        └──────┬───────────────┬──────────────────┘
                               │               │
                ┌──────────────▼───┐   ┌───────▼───────────────┐
                │ WorkflowEngine   │   │ TransactionalWorkspace │
                │ DAGs, leases,    │   │ two-phase commit,     │
                │ retry/backoff,   │   │ crash recovery,       │
                │ approval gates,  │   │ per-workspace locks    │
                │ quotas, saga     │   │                       │
                └──────┬───────────┘   └───────┬───────────────┘
                       │                       │
                ┌──────▼───────────────────────▼────────┐
                │ SQLite (WAL) · hash-chained audit log  │
                │ content-addressed blob store           │
                │ revisions · idempotency · token_usage  │
                └───────────────────────────────────────┘
```

## Pillar coverage, honestly

| Pillar | Shipped | Where |
|---|---|---|
| 01 Experience | reused (unchanged) | `src/features/workspace` |
| 02 Gateway & Identity | **implemented (local + JWT-HS256)** | `server/platform/api.ts`, `server/platform/gateway/` |
| 03 Intent | reused + tokenized diagnostics | `src/agent/`, `server/platform/qa/diagnostics.ts` |
| 04 Durable Orchestration | **implemented** | `server/platform/workflow/engine.ts` |
| 05 Human Governance | **implemented** (approval gates, audit) | engine + `audit/auditLog.ts` |
| 06 Discovery/Planning | reused | `graph.ts` (legacy engine), unchanged |
| 07 Generation | reused | DeepSeek Harness, unchanged |
| 08 Transactional Patch | **implemented** (2PC + recovery + revisions) | `server/platform/patch/` |
| 09 Sandbox | **implemented** (policy + local + Docker runner) | `server/platform/sandbox/` |
| 10 QA / Self-Healing | **implemented** (deterministic gate + contract verifier + healing policy; `verify.heal` DAG) | `server/platform/qa/`, `workflow/patchWorkflow.ts`, `qa/verifyAndHeal.ts` |
| 11 Preview | reused | `server/preview.ts` |
| 12 Release & Deploy | reused | `server/publish.ts` |
| 13 Data & Persistence | **implemented** (SQLite WAL, blobs, revisions, audit) | `server/platform/storage/` |
| 14 Security & Trust | **implemented** (audit chain, redaction, SBOM) | `audit/`, `security/sbom.ts` |
| 15 Observability | **implemented** (JSON-L, W3C traces, Prometheus) | `observability/` |
| 16 Billing & Governance | schema ready (`token_usage`), enforcement pending | `storage/schema.ts` |
| QA parser corpora | 17/17 real-world fuzz & pub-cache | `server/test/platform/dart.test.ts` |

## The durable workflow engine (pillar 04)

Every run is a versioned DAG of typed steps. State transitions are committed to SQLite
(`workflow_runs`, `workflow_steps`, `workflow_events`, `workflow_approvals`) after every
step, so:

- **Crash recovery.** A worker that dies mid-step leaves the run `running` with an expired
  lease. The sweeper (every `FLUTTERFORGE_WORKFLOW_POLL_MS`) or the next boot re-claims it
  and re-runs only the unfinished step. Steps that succeeded are never re-executed.
- **Retries.** `RetryPolicy` is exponential backoff with full jitter (`maxAttempts`,
  `baseDelayMs`, `maxDelayMs`); a transient `ECONNRESET` retries, a permanent error fails
  immediately and triggers **saga compensation** of its successful predecessors in reverse
  dependency order.
- **Idempotency.** `POST /workflows/runs` accepts `idempotencyKey`; the unique index is the
  arbiter, so network retries can never duplicate an action (e.g. a deploy).
- **HITL gates.** `ctx.requestApproval()` parks the run in `waiting_approval`, writes a
  pending approval with a risk level, and resumes only after
  `POST /approvals/:id/decision` with `project:approve`. The approval is audited both ways.
- **Cancellation.** `POST /runs/:id/cancel` records intent and aborts the step signal; the
  loop terminates cleanly and the workspace stays consistent (the patch engine is atomic).

Built-in definitions: **`patch.apply` v1** — `gateway → validate → apply → revise`.
Validation enforces path safety, live-credential scan, comment/string/interpolation-aware
delimiter balance, and pubspec sanity; on any blocker nothing is written at all.

**`verify.heal` v1** — `verify → heal (analyze → plan → repair → re-analyze) → revise`.
The `verify` step runs the real `flutter pub get` + `dart analyze` gate against an isolated
checkout (or a supplied file list), `heal` loops ≤ `maxCycles` repair turns using the
healing policy (oscillation/unsafe-target/budget stops) and re-verifies after each turn,
and `revise` is a marker recommending a sealed revision once the tree is green. The default
is a dry run that emits the repair brief without touching the model path; `invokeRepair:
true` wires it to the harness repair turn (`runGeneration` in edit mode). Every cycle is
an audited, ordered event (`heal.cycle`, `heal.reverified`), and the run fails with
`HEAL_EXHAUSTED`/`HEAL_OSCILLATION`/`HEAL_UNSAFE_TARGET` rather than looping forever.

## The transactional patch engine (pillar 08)

1. **Stage.** Content is written to `<txDir>/staged/` and hashed; originals are copied to
   `backup/` with mode bits. The `journal.json` records the intended state and is fsynced
   at every phase transition.
2. **Commit decision** is a single atomic journal write (`committing`) **before** any
   project file changes. Recovery re-applies staged blobs if the decision exists.
3. **Apply.** Each file: temp file in the target directory → write → fsync → rename → fsync
   the directory. Deletes and writes travel in the same journal.
4. **Rollback.** A failure during apply restores every backup (or unlinks creates) and
   records the transaction `failed` with a complete error record.

Per-workspace mutual exclusion holds across the whole transaction (in-process mutex plus a
journal lock file carrying pid + timestamp, stolen once stale). A multi-file patch that
contains a validation fault, a mid-commit crash, or two concurrent writers is therefore
provably impossible to observe half-applied.

`RevisionStore` layers over it: every committed patch can seal a **revision** — a manifest
of `(path, sha256, size, mode)` with the blobs content-addressed in `<dataDir>/blobs/`.
Restoring is itself one transactional patch (write manifest files, delete files missing from
it), so a restore can never half-apply either.

## Security model (pillars 02, 14)

- **Auth modes.** `local` (single-user desktop, `owner` role) or `jwt`. JWT mode verifies
  HS256 with issuer/audience/expiry and enforces `https://flutterforge.dev/roles` (or flat
  `roles`); `tenant_id` is mandatory or the request is refused with
  `TENANT_CLAIM_MISSING`. RS256/ES256/PS256 + JWKS are handled by the same verifier
  interface (`createJwtVerifier`) and the RBAC enforcer below.
- **RBAC.** Role hierarchy `owner > admin > lead_engineer > contributor > reviewer > viewer`
  with an explicit frozen permission matrix; project-scoped roles elevate only their named
  project. Every route declares its required permission; cross-tenant resources are rejected
  before any permission check (`TENANT_MISMATCH`).
- **Redaction.** The structured logger scrubs credential shapes (OpenAI/OpenRouter/Anthropic
  key patterns, JWTs, private-key blocks, connection strings, bearer tokens) from both keys
  and values, depth-bounded, before output.
- **Audit.** `audit_log` is an append-only SHA-256 hash chain (`entry_id`, `prev_hash`,
  `hash`). `GET /api/platform/audit/verify` re-derives the chain and reports the first
  broken entry; tampering is detectable and every platform route is recorded.

## Observability (pillar 15)

- **Logs**: one JSON object per line; correlation via `requestId`/`traceId`; fields
  carry `path`, `status`, `duration`, run/step ids for engine flows.
- **Traces**: W3C `traceparent` propagation, sampled by `FLUTTERFORGE_TRACE_SAMPLE_RATIO`,
  in-memory/OTLP-compatible exporter interface (`Tracer.withSpan`).
- **Metrics** (Prometheus exposition at `GET /api/platform/metrics`):
  `flutterforge_http_requests_total`, `flutterforge_http_request_duration_seconds`,
  `flutterforge_workflow_runs_total`, `flutterforge_workflow_step_duration_seconds`,
  `flutterforge_llm_tokens_total`, `flutterforge_patch_operations_total`,
  `flutterforge_rate_limited_total`, `flutterforge_active_workflow_runs`.
  Cardinality is capped (max 2000 series per metric) so a misconfigured label cannot OOM
  the process.

## API reference

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/platform/health` | public | liveness + db integrity |
| GET | `/api/platform/metrics` | `audit:read` | Prometheus exposition |
| GET | `/api/platform/capabilities` | public | pillar feature matrix |
| GET | `/api/platform/workflows/definitions` | `project:read` | list registered DAGs |
| GET | `/api/platform/workflows/runs` | `project:read` | list/filter runs |
| POST | `/api/platform/workflows/runs` | `workflow:start` | start a run (idempotent) |
| GET | `/api/platform/workflows/runs/:id` | `project:read` | run + steps |
| GET | `/api/platform/workflows/runs/:id/events` | `project:read` | ordered event log |
| POST | `/api/platform/workflows/runs/:id/cancel` | `workflow:cancel` | cancel a run |
| GET | `/api/platform/approvals/pending` | `project:read` | human queue |
| POST | `/api/platform/approvals/:id/decision` | `project:approve` | grant/refuse |
| POST | `/api/platform/projects/:id/patch` | `project:write` | direct transactional patch (202 when approval requested) |
| GET | `/api/platform/projects/:id/revisions` | `project:read` | revision history |
| POST | `/api/platform/projects/:id/revisions/:rev/restore` | `project:rollback` | atomic restore |
| GET | `/api/platform/projects/:id/sbom` | `project:read` | SPDX 2.3 SBOM from lockfile |
| GET | `/api/platform/audit/verify` | `audit:read` | hash-chain verification |
| GET | `/api/platform/audit/entries` | `audit:read` | paged audit trail |
| POST | `/api/platform/qa/verify-project` | `project:write` | contract verification of a file set |
| POST | `/api/platform/gate/analyze` | `project:write` | Dart-aware structural gate |
| POST | `/api/platform/maintenance/prune` | `org:manage` | retention of finished runs |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `FLUTTERFORGE_PLATFORM_DB` | `<dataDir>/platform/platform.sqlite` | control-plane database |
| `FLUTTERFORGE_WORKFLOW_POLL_MS` | `1000` | sweeper interval (min 50) |
| `FLUTTERFORGE_WORKFLOW_LEASE_MS` | `60000` | step lease TTL |
| `FLUTTERFORGE_WORKFLOW_CONCURRENCY` | `4` | max concurrent runs |
| `FLUTTERFORGE_WORKFLOW_RETENTION_DAYS` | `30` | finished-run retention |
| `FLUTTERFORGE_AUTH_MODE` | `local` | `local` or `jwt` |
| `FLUTTERFORGE_JWT_SECRET` | — | HS256 secret (min 32 chars) when jwt |
| `FLUTTERFORGE_JWT_ISSUER` / `_AUDIENCE` | — / `flutterforge` | claim expectations |
| `FLUTTERFORGE_JWT_CLOCK_SKEW` | `30` | seconds of leeway |
| `FLUTTERFORGE_METRICS` | `true` | metrics endpoint |
| `FLUTTERFORGE_TRACING` | `true` | span pipeline |
| `FLUTTERFORGE_TRACE_SAMPLE_RATIO` | `0.1` | sampling fraction |
| `FLUTTERFORGE_SANDBOX` | `auto` | `auto`/`docker`/`local` |
| `FLUTTERFORGE_SANDBOX_RUNTIME` | `runc` | set `runsc` for gVisor |

Startup behaviour matters: opening the database runs migrations, unfinished transactions
are rolled forward or back from their journals **before the HTTP server accepts traffic**,
and the sweeper starts only after both succeed. A database that fails its integrity check
or a config that fails validation aborts startup, loudly.

## Limitations and explicit non-goals (today)

- **Sandboxing is defense-in-depth**, not gVisor/Firecracker: `docker --network=none`,
  read-only rootfs, dropped capabilities, non-root uid, pid/memory limits. For hard
  multi-tenancy deploy behind a gVisor (`runsc`) or Kata runtime.
- **Auth is HS256-only in the built-in verifier.** The verifier accepts a `keyResolver`
  for RS256/ES256/PS256 and JWKS — wire `createJwtVerifier` with an RSA/EC PEM in the
  deployment environment; RBAC itself is complete.
- **Single-node durability.** SQLite WAL is excellent for the desktop/self-hosted shape.
  For fleet deployments move the same schema to Postgres (the `Database` interface is the
  seam) and the audit/revision semantics carry over unchanged.
- **Pillars 06/07/11/12 (planner, generator, preview, release) are not re-implemented**
  here — the DeepSeek Harness generation path remains the executor. This increment proves
  the control plane can govern that execution with transactional safety and an approval
  model; replacing its internals with native DAG steps is the next increment.
- **Pillar 16 (metering/quota) ships the schema only** (`token_usage`); enforcement and
  Stripe/Razorpay wiring ride with the existing billing stack.

## Extending

Write a module under `server/platform/<area>/`, export its API from `index.ts` if it has a
public concept, register a workflow definition in `patchApply`-style in
`instance.ts`/`api.ts`, and add tests under `server/test/platform/`. Nothing else in the
repo needs to change for a new DAG to be schedulable, observable and audited.

## Verification matrix

```
npm run test:platform   # 230+ platform tests, zero network, zero Docker required
npm run test:server     # full legacy suite + platform suite, 274+ tests
npm run typecheck       # src/ unchanged semantics
```

Every engine ships with failure-path tests: crash recovery, lock contention,
gate rejection, saga compensation, approval rejection, tampered audit rows,
unterminated literals, cyclic DAGs and path traversal.
