# Service-grade deployment overlay

This overlay is what makes FlutterForge deployable as an internet-facing service instead of a
desktop-first local tool. It adds:

- **PostgreSQL 17** (`pg` inspected at boot via `server/platform/storage/drivers.ts`) as the
  project datastore. The existing SQLite file stays the default.
- **MinIO** as an S3-compatible object store for release artifacts (`POST /api/platform/release/*`)
  and future CI/CD staging.
- **Encrypted vault** (`server/platform/security/vault.ts`) for model/SSH/cloud key material —
  AES-256-GCM with scrypt-derived keys, mode 0o600, atomic write+fsync.

## Quick start

### Prerequisites

- Docker + Docker Compose
- `FLUTTERFORGE_VAULT_KEY` set to ≥ 32 bytes of randomness (one-time: `openssl rand -hex 32`)
- `POSTGRES_PASSWORD` and `MINIO_ROOT_PASSWORD` set in the environment

```bash
docker compose -f docker-compose.yml -f docker-compose.service.yml --profile service up --build
```

Open `http://127.0.0.1:8787/api/platform/capabilities`:

```json
{ "pillars": [ ...,
  { "pillar": "13", "name": "Data & Persistence", "status": "implemented" },
  ...
]}
```

By default the app still boots against SQLite; setting `FLUTTERFORGE_PLATFORM_DB_DRIVER=postgres`
or using the service compose is what enables the Postgres lane.

## Security posture

| Layer | Mechanism | Enforced by |
|---|---|---|
| Transport | operator TLS termination (not bundled) | your LB / reverse proxy |
| App auth | local mode by default; JWT available (`FLUTTERFORGE_AUTH_MODE=jwt`) | `api/platform/api.ts` + `gateway/` |
| Authorization | RBAC, tenant-scoped, project-scoped | RBAC matrix in `platform/gateway/rbac.ts` |
| Secrets at rest | AES-256-GCM sealed vault, scrypt KDF | `platform/security/vault.ts` |
| Supply chain | Pub lock parsed, `POST /api/platform/security/vulnerabilities` (OSV) | `platform/security/osv.ts` |
| Audit | SHA-256 chained append-only entries, any row edit breaks verification | `platform/audit/auditLog.ts` |
| Sandbox | policies for flutter/dart/git/npm/node + Docker executor | `platform/sandbox/` |
| Metering | `metering/usage.ts` — quota checks fail closed on storage errors | `platform/metering/usage.ts` |

## Multi-tenancy

Every table carries `tenant_id`. The tenant filter is applied at the API boundary from the
verified JWT claims (or the local-dev owner identity in `local` mode). Workspaces and artifacts
are keyed by tenant path (`/data/.flutterforge/workspaces/<tenant>/<project>/`). PostgreSQL
policies are encoded in the schema as `tenant_id` columns; enabling Postgres RLS is a production
follow-up documented in `RUNBOOK_PLATFORM.md`.

## Production SLOs

| Metric | Target |
|---|---|
| Platform startup | < 30 s |
| 2PC transaction durability | 0 partial writes |
| Audit chain verification | detect tampering within 1 row |
| OSV window | < 5 s for typical 100–200 package lockfile |
| Backup recovery | `restore` from a revision tarball ≤ 5 min |

## Known limits

- TLS termination is NOT included — put a reverse proxy in front.
- Multi-replica deployments need Postgres as the shared store; SQLite is single-node.
- The vault is single-node, filesystem-backed; multi-region requires a shared KMS.
- OSV advisory detail enrichment for > 200 distinct CVEs per gate call will fail closed by design
  (see release notes for the limit and how to override).
