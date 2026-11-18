-- Postgres bootstrap for the FlutterForge platform schema.
-- Apply against the service-grade database before first start:
--   psql "$FLUTTERFORGE_PLATFORM_DB_URL" -f server/platform/storage/migrations.postgres.sql
-- Statements are translated from storage/schema.ts (SQLite dialect) and keep
-- the same table names so repository code is byte-identical.

BEGIN;

CREATE TABLE IF NOT EXISTS workflow_runs (
  id               TEXT PRIMARY KEY,
  definition       TEXT NOT NULL,
  definition_version INTEGER NOT NULL,
  status           TEXT NOT NULL,
  input_json       TEXT NOT NULL,
  output_json      TEXT,
  error_json       TEXT,
  tenant_id        TEXT NOT NULL,
  project_id       TEXT,
  actor            TEXT NOT NULL,
  idempotency_key  TEXT,
  parent_run_id    TEXT,
  worker_id        TEXT,
  lease_expires_at BIGINT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  attempt          INTEGER NOT NULL DEFAULT 0,
  created_at       BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL,
  started_at       BIGINT,
  finished_at      BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency
  ON workflow_runs (tenant_id, definition, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_status_lease ON workflow_runs (status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_runs_project ON workflow_runs (tenant_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_finished ON workflow_runs (finished_at) WHERE finished_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_steps (
  run_id       TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id      TEXT NOT NULL,
  status       TEXT NOT NULL,
  attempt      INTEGER NOT NULL DEFAULT 0,
  output_json  TEXT,
  error_json   TEXT,
  started_at   BIGINT,
  finished_at  BIGINT,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (run_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_steps_run_status ON workflow_steps (run_id, status);

CREATE TABLE IF NOT EXISTS workflow_events (
  seq         BIGSERIAL PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  data_json   TEXT NOT NULL,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run_seq ON workflow_events (run_id, seq);

CREATE TABLE IF NOT EXISTS workflow_approvals (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id       TEXT NOT NULL,
  status        TEXT NOT NULL,
  risk          TEXT NOT NULL,
  reason        TEXT NOT NULL,
  summary_json  TEXT NOT NULL,
  requested_at  BIGINT NOT NULL,
  decided_at    BIGINT,
  decided_by    TEXT,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON workflow_approvals (status, requested_at);
CREATE INDEX IF NOT EXISTS idx_approvals_run ON workflow_approvals (run_id, status);

CREATE TABLE IF NOT EXISTS audit_log (
  seq           BIGSERIAL PRIMARY KEY,
  entry_id      TEXT NOT NULL UNIQUE,
  tenant_id     TEXT NOT NULL,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT,
  metadata_json TEXT NOT NULL,
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_seq ON audit_log (tenant_id, seq);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys (expires_at);

CREATE TABLE IF NOT EXISTS token_usage (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  project_id        TEXT,
  run_id            TEXT,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cached_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_micros       BIGINT NOT NULL DEFAULT 0,
  recorded_at       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_time ON token_usage (tenant_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_project ON token_usage (tenant_id, project_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS project_revisions (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  parent_id     TEXT,
  message       TEXT NOT NULL,
  actor         TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  file_count    INTEGER NOT NULL,
  total_bytes   BIGINT NOT NULL,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_project ON project_revisions (tenant_id, project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
-- No migrations bookkeeping here: the service-grade Postgres schema is a
-- peer of the SQLite schema in storage/schema.ts. Apply this file once per
-- environment; the Postgres driver (storage/drivers.ts) will still run the
-- shared PLATFORM_MIGRATIONS when FLUTTERFORGE_PLATFORM_DB_DRIVER=postgres.

COMMIT;
