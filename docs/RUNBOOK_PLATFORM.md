# Platform Runbook

**Audience:** operators · **Scope:** `server/platform/` mounted at `/api/platform/*` · **Version:** platform 2.0.0
See also `docs/PLATFORM_CONTROL_PLANE.md` (design) and `docs/RELEASE.md` (releases).

## Architecture in one paragraph

A browser/desktop client talks to the local or Dockerized FlutterForge server, which mounts the platform control plane ahead of the legacy harness handlers. Every request passes request-id → trace context → auth (local or JWT/RBAC) → rate limit → handler → audit/metrics. Workflow runs are durable DAGs persisted to SQLite (WAL) after every step; workspace mutations go through a two-phase-commit patch engine that stages blobs, takes a per-workspace lock, and fsyncs a journal before touching project files; every committed patch can be sealed as a content-addressed **revision** (blobs on disk + manifest in SQLite) with a hash-chained audit entry behind it.

```mermaid
sequenceDiagram
  participant B as Browser / Desktop
  participant P as /api/platform/* (gateway)
  participant E as WorkflowEngine (DAG)
  participant T as PatchTransaction (2PC)
  participant D as SQLite (WAL)
  participant R as RevisionStore (<dataDir>/blobs)

  B->>P: POST /api/platform/projects/:id/patch
  P->>P: request-id · auth · RBAC · rate limit
  P->>E: start('patch.apply') or applyPatch() directly
  E->>D: claim lease; steps: gateway → validate → apply → revise
  E->>T: applyPatch(files)
  T->>T: stage blobs → backup → journal=committing (fsync)
  T->>D: per-step rows (workflow_steps / workflow_events)
  T->>T: per file: temp → fsync → rename → dir fsync
  T->>R: storeBlobs(manifest) → blobs/<2>/<sha256>
  T->>D: journal=committed; INSERT project_revisions
  P->>B: 200 { transactionId, revision } (202 if approval required)
```

## Bootstrapping

Prerequisites: **Node 24 LTS** (the platform requires `node:sqlite`; Node 22.5+ works only with `--experimental-sqlite`; Node 20 will not boot the platform — `ci.yml` pins Node 24), a repo checkout, `npm ci`. Flutter SDK is optional at boot; the platform provisions its own managed stable SDK on first verify/publish (see *Flutter SDK missing*).

```bash
npm ci
npm run test:platform     # sanity: platform suite, zero network
npm run server            # serves http://127.0.0.1:8787 (HOST/PORT override)
```

**First-boot behavior** (code path `server/platform/instance.ts → createPlatform`, invoked lazily on the first `/api/platform/*` request via `server/platform/api.ts → getPlatform`):

1. `loadPlatformConfig` validates env eagerly — any issue throws `ConfigError` listing every bad variable; the process aborts.
2. `Database.open` on `FLUTTERFORGE_PLATFORM_DB` (default `<dataDir>/platform/platform.sqlite`), then `migrate(PLATFORM_MIGRATIONS)` applies pending ids in order, each in a transaction, recording `schema_migrations`.
3. `recoverTransactions(<dataDir>/transactions, { retainDays: 7 })` settles journals **before** the platform serves a patch: `committing` → rolled forward + marked `committed`; `rolling_back` → `rollbackJournal`; `prepared`/`open` → marked `rolled_back`; unrecoverable ids are logged (`some transactions could not be recovered`).
4. Definitions are registered (`patch.apply`, `verify.heal`), the sweeper starts (`setInterval(engine.tick, FLUTTERFORGE_WORKFLOW_POLL_MS)`), and an integrity check runs (warn-only).

The HTTP server listens immediately at boot; platform subsystems initialize on the first platform request. If config, migrations or recovery throw, the first platform request fails loudly and `getPlatform()` keeps rejecting — check stdout/stderr.

**Health checks.**

```bash
curl -s http://127.0.0.1:8787/health
# {"ok":true,"engine":"deepseek-harness","runtime":{"available":true,"version":"…"},"pid":1234,"uptime":10}

curl -s http://127.0.0.1:8787/api/platform/health
# {"ok":true,"platform":"2.0.0","node":"v24.0.0","uptimeSeconds":12,
#  "database":{"mode":"sqlite-wal","integrity":"ok"},"recovery":"journal-2pc"}

curl -s http://127.0.0.1:8787/api/platform/capabilities | jq '.ok, (.pillars | length), (.workflows | map(.name))'
# true
# 16
# ["patch.apply","verify.heal"]
```

Capabilities is the public pillar feature matrix plus registered workflow definitions — safe to use as a readiness gate in deploys.

## Configuration reference

Every `FLUTTERFORGE_*` variable read by `server/platform/kernel/config.ts`. **Bad values never degrade silently** — they are collected and startup aborts with `ConfigError` (variable + message). Ranges shown are enforced.

| Variable | Default | Effect |
|---|---|---|
| `FLUTTERFORGE_DATA_DIR` | `<repo>/.flutterforge` | Root for db, transactions, blobs, workspaces, publish output |
| `FLUTTERFORGE_PLATFORM_DB` | `<dataDir>/platform/platform.sqlite` | Control-plane database file |
| `FLUTTERFORGE_LOG_LEVEL` | `info` (prod) / `debug` | `trace`…`fatal`; bad enum → abort |
| `FLUTTERFORGE_AUTH_MODE` | `local` | `local` or `jwt`; bad enum → abort |
| `FLUTTERFORGE_JWT_SECRET` | — | Required ≥32 chars in `jwt`; shorter/missing → abort |
| `FLUTTERFORGE_JWT_PUBLIC_KEY` | — | PEM; `\n` unescaped. Startup OK; built-in gateway still verifies HS256 only (see Security) |
| `FLUTTERFORGE_JWT_ISSUER` | — | Required in `jwt`; exact `iss` match; bad/missing → abort or 401 |
| `FLUTTERFORGE_JWT_AUDIENCE` | `flutterforge` | Exact `aud` match; else 401 |
| `FLUTTERFORGE_JWT_CLOCK_SKEW` | `30` | 0–600 s leeway for exp/nbf/iat |
| `FLUTTERFORGE_LOCAL_TENANT` | `local` | Tenant id used in `local` mode |
| `FLUTTERFORGE_LOCAL_USER` | `local-developer` | User id used in `local` mode |
| `FLUTTERFORGE_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma list; `*` forbidden in production → abort |
| `FLUTTERFORGE_MAX_BODY_BYTES` | `67108864` (64 MiB) | 1024–512 MiB; over-limit → request destroyed (400/413) |
| `FLUTTERFORGE_REQUEST_TIMEOUT_MS` | `120000` | 1 s–1 h |
| `FLUTTERFORGE_RATE_LIMIT` | `true` | Boolean; `false` disables rate limiting |
| `FLUTTERFORGE_WORKFLOW_CONCURRENCY` | `4` | 1–64 max concurrent runs |
| `FLUTTERFORGE_WORKFLOW_LEASE_MS` | `60000` | 5 s–1 h step lease TTL |
| `FLUTTERFORGE_WORKFLOW_POLL_MS` | `1000` | 50–60000 sweeper interval |
| `FLUTTERFORGE_STEP_TIMEOUT_MS` | `900000` | 1 s–24 h default per-step timeout |
| `FLUTTERFORGE_WORKFLOW_RETENTION_DAYS` | `30` | 1–3650 days; used by prune endpoint |
| `FLUTTERFORGE_TRACE_SAMPLE_RATIO` | `0.1` | 0–1 sampled fraction of traces |
| `FLUTTERFORGE_SANDBOX` | `auto` | `auto`/`docker`/`local`; `auto` = docker if available |
| `FLUTTERFORGE_SANDBOX_IMAGE` | `ghcr.io/flutterforge/build-env:3.24` | Sandbox image |
| `FLUTTERFORGE_SANDBOX_RUNTIME` | `runc` | `runc` or `runsc` (gVisor) |
| `FLUTTERFORGE_SANDBOX_CONCURRENCY` | `4` | 1–32 |
| `FLUTTERFORGE_SANDBOX_TIMEOUT_MS` | `180000` | 1 s–1 h |
| `FLUTTERFORGE_SANDBOX_CPUS` | `2` | 1–64 cores |
| `FLUTTERFORGE_SANDBOX_MEMORY_MB` | `4096` | 256–131072 MB |
| `FLUTTERFORGE_PATCH_MAX_FILES` | `500` | 1–10000 files per patch |
| `FLUTTERFORGE_PATCH_MAX_FILE_BYTES` | `2097152` (2 MiB) | 1024–32 MiB per file |
| `FLUTTERFORGE_PATCH_MAX_TOTAL_BYTES` | `67108864` (64 MiB) | 1024–512 MiB per patch |
| `FLUTTERFORGE_MASTER_KEY` | — | Reserved; not consumed by current code paths |
| `FLUTTERFORGE_METRICS` | `true` | Metrics endpoint. Served when unset or exactly `true`; any other value → `# metrics disabled` |
| `FLUTTERFORGE_TRACING` | `true` | Span pipeline on/off |

Adjacent (read elsewhere, not in config.ts): `FLUTTERFORGE_WORKSPACES` (default `<dataDir>/workspaces`), `FLUTTERFORGE_VERIFICATIONS` (default `<dataDir>/verifications`), `FLUTTERFORGE_PUBLISH` (default `<dataDir>/publish`), `FLUTTERFORGE_PUBLISH_TIMEOUT_MS` (default `1200000`), `FLUTTERFORGE_PUB_GET_TIMEOUT_MS`, `FLUTTERFORGE_VERIFY_TIMEOUT_MS` (both `240000`), `FLUTTERFORGE_WEB_DIR`, `FLUTTERFORGE_PLATFORM_DB` (above), `HOST`/`PORT` (defaults `127.0.0.1`/`8787`), `FLUTTERFORGE_DSH_PROFILE`, `DSH_BIN`, `DSH_HOME`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`. Release env: `FLUTTERFORGE_ANDROID_KEYSTORE`, `FLUTTERFORGE_ANDROID_KEYSTORE_PASSWORD`, and the fallback pair `ANDROID_KEYSTORE_PATH`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_PASSWORD` — see `docs/RELEASE.md`; OSV/verify calls accept whatever egress is available to `https://api.osv.dev`; GitHub sync uses `FLUTTERFORGE_GITHUB_OWNER`, `FLUTTERFORGE_GITHUB_REPO`, `FLUTTERFORGE_GITHUB_TOKEN`, `FLUTTERFORGE_GITHUB_BASE_BRANCH` (default `main`). Optional OTLP export: `FLUTTERFORGE_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (unset → in-process no-op), sampling via `FLUTTERFORGE_TRACE_SAMPLE_RATIO`. `NODE_ENV` is read by config (`development`/`test`/`production`). Copy `.env.local.example` as the pattern: server-only secrets never get a `VITE_` prefix.

## Durability model

- **SQLite (WAL).** `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `wal_autocheckpoint=1000`, foreign keys on. Writes use `BEGIN IMMEDIATE`; `SQLITE_BUSY`/`SQLITE_LOCKED` retried 5× with 15 ms·2ⁿ + jitter backoff.
- **Patch journal.** `<dataDir>/transactions/tx_<id>/{journal.json, staged/, backup/}` plus `<dataDir>/transactions/locks/`. Every phase transition is fsynced (`prepared` → `committing` before any file changes). Recovery replays `committing`, inverts `rolling_back`, abandons `prepared`/`open` — see `recoverTransactions()` in `server/platform/patch/transaction.ts`, called from `createPlatform()` (`server/platform/instance.ts`). Finished journals older than 7 days and dead-pid locks are swept at boot.
- **Revisions.** A committed patch can be sealed: row in `project_revisions` (manifest of `path, sha256, size, mode`) + blobs in `<dataDir>/blobs/<first2>/<sha256>`. Restore is itself one transactional patch (writes manifest files, deletes files missing from it) — never half-applies; missing blob → `REVISION_BLOB_MISSING`, aborts before touching the workspace.
- **Audit log.** `audit_log` is append-only, SHA-256 hash-chained (`GENESIS_HASH = sha256('flutterforge:audit:genesis')`). `GET /api/platform/audit/verify` re-derives the chain and reports `firstBadSeq`. No update or delete API exists in this build — no endpoint removes audit rows.
- **Idempotency.** `workflow_runs.idempotency_key` has a unique index `(tenant_id, definition, idempotency_key)` — retries replay instead of duplicating (e.g. a deploy). Separate `idempotency_keys` table TTLs rows via `expires_at`.

## Failure scenarios

**Corrupted `platform.sqlite`.** `sqlite3 <FLUTTERFORGE_PLATFORM_DB> 'PRAGMA integrity_check;'` — prints `ok`, or a description of the first corrupt page (e.g. `row 812 missing from index idx_runs_idempotency`). Restore: stop the server, restore `platform.sqlite` (and `blobs/`, `transactions/`) from your last `tar` backup (see Backup), restart, re-run `PRAGMA integrity_check;` and `GET /api/platform/audit/verify`. Note: there is no tooling to rebuild the DB from blobs alone — blobs are content-addressed and self-verifying by filename, but revision *manifests* live only in `project_revisions`; without the db they are unrecoverable. Commit no writes after a failed integrity check: the boot path only warns, it does not refuse traffic.

**Stuck run in `waiting_approval`.** Find it: `curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:8787/api/platform/approvals/pending`. Decide: `curl -s -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"decision":"approved","note":"lgtm"}' http://127.0.0.1:8787/api/platform/approvals/<approvalId>/decision` (`rejected` finalizes the run as failed). Or cancel: `curl -s -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"reason":"superseded"}' http://127.0.0.1:8787/api/platform/workflows/runs/<runId>/cancel`. Approvals and cancellations are audited both ways. Omit the auth header in `local` mode.

**Transaction stuck in `committing`.** Do nothing to the workspace by hand. The commit decision is durable; recovery runs at next boot: `createPlatform()` → `recoverTransactions()` re-applies staged blobs and marks the journal `committed` (or `failed` and reports `transactionIds` in the log line `some transactions could not be recovered`). To force recovery now: restart `npm run server` and grep boot output for `recovered interrupted transactions`. Inspect a journal directly: `cat "$FLUTTERFORGE_DATA_DIR/transactions/<txId>/journal.json" | jq '.state, .entries | length'`.

**Metrics/tracing disabled.** Enable: `FLUTTERFORGE_METRICS=true npm run server` / `FLUTTERFORGE_TRACING=true`. Scrape output is frozen at `# metrics disabled` unless the variable is unset or exactly `true` (the handler checks the raw env var). During an incident, raise sampling: `FLUTTERFORGE_TRACE_SAMPLE_RATIO=1 npm run server`; revert after. Traces honor incoming `traceparent: 00-<32 hex>-<16 hex>-01`; when the request carried one, the response echoes an updated `traceparent` header.

**Flutter SDK missing.** `verify.heal` calls `verifyProject` → `ensureFlutter()` (`server/harness/managedFlutter.ts`). If neither `FLUTTER_BIN` nor a managed SDK exists and provisioning fails, verify returns `skipped: true, available: false` ("Flutter SDK is not available: …"). The `heal` step's guard only runs when the verdict is `failed`, so **the repair loop never runs** — the run completes with the `verify` step reporting `verdict: "skipped"`. Check the verify step output in `GET /api/platform/workflows/runs/:id` and the `verify.completed` event. Provisioning pointer: on first use, `ensureFlutter` downloads the pinned stable SDK (SHA-256 verified) into `<dataDir>/toolchains/flutter/<platform>-<arch>/flutter` and records `.flutterforge-managed-version`; later runs reuse it. Set `FLUTTER_BIN=/path/to/flutter` to use an existing SDK.

## Security operations

- **`local` vs `jwt`.** `local` (default): single-user desktop tenant (`FLUTTERFORGE_LOCAL_TENANT`/`FLUTTERFORGE_LOCAL_USER`), full `owner` role, no token — bind to `127.0.0.1` only. Docker/`docker-compose.yml` sets `HOST=0.0.0.0`, so hosted deployments **must** set `FLUTTERFORGE_AUTH_MODE=jwt`, `FLUTTERFORGE_JWT_SECRET` (≥32 chars), `FLUTTERFORGE_JWT_ISSUER`. `jwt` verifies HS256 + issuer/audience/expiry and requires a `tenant_id` claim (else `TENANT_CLAIM_MISSING`) and roles in `https://flutterforge.dev/roles` or flat `roles`. Note honestly: the built-in HTTP gateway resolves principals with HS256 only; RS256/ES256/PS256+JWKS are supported by `createJwtVerifier` in `server/platform/gateway/jwt.ts` but must be wired by the deployer — `FLUTTERFORGE_JWT_PUBLIC_KEY` passes startup validation yet is not consulted by the built-in path.
- **HS256 secret rotation (dual-key window).** The built-in verifier trusts exactly one secret, so a true overlap needs a code-level window: (1) `NEW=$(openssl rand -base64 48)`; (2) deploy with `FLUTTERFORGE_JWT_SECRET=$NEW` — effective immediately, all existing tokens die; (3) for a grace window, wire `createJwtVerifier({ algorithms:['HS256'], keyResolver: (h) => accepts(NEW, OLD, h.kid) })` in your deployment and keep `OLD` until max token lifetime elapses; (4) drop `OLD`, confirm 401s on old tokens, audit-read the platform. Rotation cadence: 90 days or on suspected leak; suspected leak → rotate immediately and verify audit log.
- **RBAC (effective matrix, `server/platform/gateway/rbac.ts`).** `owner > admin > lead_engineer > contributor > reviewer > viewer`. viewer: `project:read/export`. reviewer: +`project:approve`. contributor: +`project:write`, `workflow:start/cancel`. lead_engineer: +`project:rollback`, `sandbox:execute`, `audit:read`. admin: everything except `org:manage`. owner: everything (incl. `org:manage`, required for prune). Project-scoped roles elevate only the named project; cross-tenant access is rejected before any permission check (`TENANT_MISMATCH`).
- **Audit verification cadence.** Verify at least weekly, plus after any suspected tampering — report before regulators ask. `0 3 * * 0 root curl -sf -H "Authorization: Bearer $TOK" http://127.0.0.1:8787/api/platform/audit/verify | jq -e '.ok' >/dev/null || /usr/local/bin/alert-audit-broken` (omit the auth header in `local` mode). A broken chain means stop writes, snapshot the db, restore from backup.
- **Secret redaction scope.** The logger scrubs keys named like `password|secret|token|api_key|authorization|cookie|credential|private_key|session_id|client_secret|access_key|refresh_token|raw_key` (any depth ≤8, ≤200 entries) and values matching `sk-…`, `sk-or-v1-…`, `AIza…`, `AKIA…`, GitHub `gh*_`, Slack `xox*`, JWT-like `eyJ…`, PEM private-key blocks, `Bearer …`, and `postgres/mysql/mongodb/redis` URLs with credentials, before anything is written. It does not log file contents or plaintext API keys; it does log paths, statuses, durations, run/step ids — and audit metadata can carry target lists and file paths.

## Retention & GDPR

Retention: `POST /api/platform/maintenance/prune` with `{"retentionDays": N}` (default `FLUTTERFORGE_WORKFLOW_RETENTION_DAYS`, 30) deletes finished runs (`succeeded|failed|cancelled` with `finished_at` older than cutoff) and returns `{ "ok": true, "pruned": <count> }`. Requires `org:manage` (owner). Deleting a run cascades to its steps, events and approvals (`ON DELETE CASCADE`); the audit log is never pruned.

Deletion paths for a tenant/project erasure request:
1. Workspace: `rm -rf "${FLUTTERFORGE_WORKSPACES:-$FLUTTERFORGE_DATA_DIR/workspaces}/<projectKey>"` or `curl -X DELETE http://127.0.0.1:8787/api/harness/session/<projectId>` (calls `resetProject`).
2. Publish output: `rm -rf "${FLUTTERFORGE_PUBLISH:-$FLUTTERFORGE_DATA_DIR/publish}/<projectKey>"`.
3. Verification scratch: `rm -rf "${FLUTTERFORGE_VERIFICATIONS:-$FLUTTERFORGE_DATA_DIR/verifications}/<projectKey>"`.
4. Revisions/blobs: there is no delete API. Delete `project_revisions` rows via `sqlite3 "$FLUTTERFORGE_PLATFORM_DB" "DELETE FROM project_revisions WHERE project_id='<id>';"`; the blob files are deterministic — read each manifest hash (`SELECT manifest_json FROM project_revisions`) *before* deleting, then `rm` the blobs (and any now-unreferenced siblings). Missing blobs for remaining revisions break restore (`REVISION_BLOB_MISSING`) — verify none are shared.
5. Audit log: append-only; an erasure is recorded as an audit entry, never by rewriting rows.

Prove deletion: `sqlite3` counts return 0 for the project across `workflow_runs`, `project_revisions`, `token_usage`; `ls` of the directories shows gone; `GET /api/platform/audit/verify` still returns `ok:true` (chain intact); the `audit_log` contains the deletion/erasure record. For a hard erasure, destroy `platform.sqlite` and `blobs/` outright — but then audit verification is impossible; log the destruction (receipt + hashes) externally.

## Upgrades

Migrations are **append-only** — never edit a shipped `up`. To add `0003`: append `{ id: '0003_<name>', up: '…sql…' }` to `PLATFORM_MIGRATIONS` in `server/platform/storage/schema.ts`; `Database.migrate()` applies it in a transaction and records it in `schema_migrations`. Verify after upgrade: restart and grep boot log for `applied platform schema migrations`; `npm run test:platform`; `curl -s http://127.0.0.1:8787/api/platform/audit/verify` (`"ok":true`); smoke: `/api/platform/capabilities`, `/api/platform/workflows/definitions`, and a dry `POST /api/platform/gate/analyze` with one Dart file.

## Backup & restore

```bash
DATA_DIR="${FLUTTERFORGE_DATA_DIR:-.flutterforge}"
tar -czf flutterforge-backup-$(date +%F).tgz -C "$DATA_DIR" platform blobs transactions workspaces publish
```

(`toolchains/` is excluded — it re-downloads; `verifications/` is scratch.) Restore: stop server; `mkdir -p "$DATA_DIR" && tar -xzf flutterforge-backup-*.tgz -C "$DATA_DIR"`; `npm run server`; verify: `/api/platform/health` → `integrity":"ok"`, `audit/verify` → `checked ≥ your last head, ok true`, and `/api/platform/projects/<id>/revisions` lists sealed revisions (listing is the dry check — do not call restore unless you mean it, it rewrites the workspace). If audit verify fails after restore, the backup was inconsistent or tampered — do not serve.

## Observability

Prometheus scrape (metrics requires `audit:read`; local mode needs no token):

```yaml
scrape_configs:
  - job_name: flutterforge
    static_configs:
      - targets: ["127.0.0.1:8787"]
    metrics_path: /api/platform/metrics
    # jwt mode only:
    # authorization:
    #   type: Bearer
    #   credentials: <HS256-issued token with audit:read>
```

| Metric | Type / labels | Meaning |
|---|---|---|
| `flutterforge_http_requests_total` | counter `{method, route, status}` | HTTP traffic by route class |
| `flutterforge_http_request_duration_seconds` | histogram `{method, route}` | Request latency (status-class split is on the counter) |
| `flutterforge_workflow_runs_total` | counter `{definition, status}` | Terminal runs by definition and status |
| `flutterforge_workflow_step_duration_seconds` | histogram `{definition, step, status}` | Step latency tail analysis |
| `flutterforge_llm_tokens_total` | counter `{provider, model, direction}` | Token spend; direction = prompt/completion |
| `flutterforge_patch_operations_total` | counter `{result}` | Transactional patch outcomes |
| `flutterforge_rate_limited_total` | counter `{tier}` | 429s on expensive routes (workflow_start, patch_apply) |
| `flutterforge_active_workflow_runs` | gauge | Runs currently executing |

Logs are JSON-L on stdout. Correlation via `requestId`/`traceId`. Useful greps: `docker logs flutterforge | jq -c 'select(.level=="error" or .level=="warn")'`; `… | jq -c 'select(.msg=="platform request failed")'`; `… | jq -c 'select(.msg | test("lease lost|tick failed|could not be recovered"))'`; `… | jq -c 'select(.path=="/api/platform/projects/:projectId/patch")'`. Trace propagation in: `curl -H "traceparent: 00-$(openssl rand -hex 16)-$(openssl rand -hex 8)-01" …` — the response echoes an updated `traceparent` header when one was supplied.

Traces can also be exported as OTLP/JSON: `server/platform/observability/otel.ts` (`OtlpExporter`) converts spans to the OTLP `/v1/traces` wire format — dependency-free, at-most-once per batch (drops after `maxRetries`, counts `failedExports`), `flush()` drains on shutdown. It is plugged into `Tracer` as a `SpanExporter`; in this build nothing constructs one — wire it in your composition root (point it at your collector's `…/v1/traces`) or rely on the default in-memory exporter plus JSON-L stdout. Export failures never break the request path.

## Troubleshooting

| Symptom | Likely cause | Confirm | Fix |
|---|---|---|---|
| `ALREADY_RUNNING` | A generation is active for this project (in-memory `ACTIVE_PROJECTS` in `server/harness/run.ts`) | SSE `error` event with `code: "ALREADY_RUNNING"` on `/api/harness/stream` (documented contract: 409 — see README) | Wait for completion or restart server (clears the in-memory lock — safe, it is not durable) |
| `WORKSPACE_LOCKED`, HTTP 409 | Patch mutex or lock file `<txRoot>/locks/<sha24>.lock` held (stale after 10 min with dead pid) | Body `details.transactionId`; `ps -p <pid>` on the holder pid recorded in the lock file | If holder alive: wait. If dead: stale locks are stolen/removed at boot; delete the lock file only after confirming the pid is dead |
| `PATCH_COMMIT_FAILED` | Apply failed mid-commit; rolled back automatically | Journal `<dataDir>/transactions/<txId>/journal.json` state `failed`; log line with `transactionId` | Workspace already restored; diff and re-apply; fix the underlying cause (validation, disk) |
| `PATCH_ROLLBACK_FAILED` | Rollback also failed — manual recovery | Error body `code: "PATCH_ROLLBACK_FAILED"` | Copy every `backup/*.orig` back over `entries[].path` in order; verify with the project's SCM; open an incident |
| `HEAL_EXHAUSTED` (422) | `verify.heal` hit `maxCycles` (default 3, max 5) without a green gate | `heal.cycle` / `heal.reverified` events; `error.details.remainingBlockers` | Fix blockers by hand, or re-run with higher `maxCycles`; do not loop blindly |
| `HEAL_OSCILLATION` (422) | Same diagnostic fingerprints recur across cycles | Repeated identical `heal.cycle` fingerprints | Stop; break the loop manually; inspect the brief attached to the error |
| `HEAL_UNSAFE_TARGET` (422) | Repair plan targets a path outside the workspace | Error `details.brief` | No change was made; review the brief — usually a symlinked/mis-rooted workspace |
| Lease lost; run "sticks" | Holder died; lease `FLUTTERFORGE_WORKFLOW_LEASE_MS` (60 s) not yet expired | Log `lease lost; another worker will continue this run`; `lease_expires_at` in `workflow_runs` | Wait for expiry — sweeper re-claims; for very long steps raise lease; check clock sync |
| Audit chain broken | Tampering, or partial restore | `audit/verify` → `ok:false`, `firstBadSeq`, `reason` | Stop writes; snapshot; restore from backup; treat `firstBadSeq` entry as evidence |
| `RATE_LIMITED`, HTTP 429 | Expensive-route bucket exhausted (`workflow_start` / `patch_apply`) | Metric `flutterforge_rate_limited_total`; body `retryAfterMs` | Back off the window; find the caller; buckets are code-fixed (60 s), not configurable |
| `QUOTA_EXCEEDED` | Pillar 16 wires `server/platform/metering/usage.ts` (`MeteringService`: `checkQuota` standing state, `chargeFor` pre-flight; quotas in `platform_settings` as `quota:<tenantId>`, sliding window, inclusive limits, fails **closed** on `QUOTA_CHECK_FAILED`). Enforced at `POST /api/platform/usage/charge` and visible at `GET /api/platform/usage/quota` | Provider 429s surface in generation logs; key-pool failover / template path per README | Cap usage at the provider; watch `flutterforge_llm_tokens_total`; set a tenant quota via `POST /api/platform/usage/quota` before promising quotas |
| `OSV_UNAVAILABLE` | OSV gate (`server/platform/security/osv.ts`) failed **closed**: network/HTTP/protocol/parse failure, or an advisory it cannot enrich | Via `gate()` → `errors[]` like `OSV_QUERY_FAILED <pkg>@<version>: OSV_UNAVAILABLE: …` with `blocked: true` under policy `block` — never silently allows. Over HTTP: `POST /api/platform/security/vulnerabilities` returns 422 with the error list; direct library call still available | Check egress to `https://api.osv.dev`; retry later; Pub ecosystem only; max 500 hosted packages; failing closed is by design |
| `TENANT_MISMATCH` / `TENANT_CLAIM_MISSING` | JWT issued for another tenant, or missing `tenant_id` | 401/403 body; `iss`/`aud` config | Re-issue tokens from a trusted issuer with `tenant_id` + `sub`; do not widen roles |

## Capacity guidance

Single-node SQLite WAL is the designed shape (desktop/self-hosted). Practical ceiling: serialized writes (`BEGIN IMMEDIATE`), so plan for sustained hundreds of committed transactions/second at most; `workflow_events` is the hot table — high churn runs (heal loops) dominate. Tune first: `FLUTTERFORGE_WORKFLOW_CONCURRENCY` (default 4), `FLUTTERFORGE_SANDBOX_CONCURRENCY`, NVMe disk, and keep `busy_timeout` at 5000 ms. Move to Postgres when any of these hold: more than one writer process/host; event volume sustained >~10⁵ rows/day with tail-latency pain; read replicas needed for audit queries. The seam is the `Database` interface in `server/platform/storage/database.ts` (`getPlatformDatabase` shared handle, `PLATFORM_MIGRATIONS`, `integrityCheck()`) — the audit chain, revisions and idempotency semantics carry over unchanged (see `docs/PLATFORM_CONTROL_PLANE.md`, "Limitations"). Vertical scaling notes: SQLite does not parallelize writes; add cores only up to `FLUTTERFORGE_WORKFLOW_CONCURRENCY` usefulness, add RAM for page cache (default `cache_size`), fast disk for WAL checkpoints. Metrics cardinality is capped at 2000 series/metric — a bad label cannot OOM the process.
