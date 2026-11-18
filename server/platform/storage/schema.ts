/**
 * Platform schema.
 *
 * Migrations are append-only. Never edit a shipped migration: add a new id.
 * The schema covers durable workflow state, approval gates, audit chains,
 * project revisions, token metering and idempotency.
 */
import type { Migration } from './database.js';

export const PLATFORM_MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_core_control_plane',
    up: `
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        definition TEXT NOT NULL,
        definition_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        error_json TEXT,
        tenant_id TEXT NOT NULL,
        project_id TEXT,
        actor TEXT NOT NULL,
        idempotency_key TEXT,
        parent_run_id TEXT,
        worker_id TEXT,
        lease_expires_at INTEGER,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency
        ON workflow_runs (tenant_id, definition, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_runs_status_lease
        ON workflow_runs (status, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_runs_project
        ON workflow_runs (tenant_id, project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS workflow_steps (
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        output_json TEXT,
        error_json TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, step_id)
      );
      CREATE INDEX IF NOT EXISTS idx_steps_run_status ON workflow_steps (run_id, status);

      CREATE TABLE IF NOT EXISTS workflow_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_run_seq ON workflow_events (run_id, seq);

      CREATE TABLE IF NOT EXISTS workflow_approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL,
        status TEXT NOT NULL,
        risk TEXT NOT NULL,
        reason TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT,
        decision_note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON workflow_approvals (status, requested_at);
      CREATE INDEX IF NOT EXISTS idx_approvals_run ON workflow_approvals (run_id, status);

      CREATE TABLE IF NOT EXISTS audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        metadata_json TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_tenant_seq ON audit_log (tenant_id, seq);

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys (expires_at);

      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        project_id TEXT,
        run_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        cost_micros INTEGER NOT NULL DEFAULT 0,
        recorded_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_tenant_time ON token_usage (tenant_id, recorded_at DESC);

      CREATE TABLE IF NOT EXISTS project_revisions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        message TEXT NOT NULL,
        actor TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        file_count INTEGER NOT NULL,
        total_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_revisions_project
        ON project_revisions (tenant_id, project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS platform_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    id: '0002_run_retention',
    up: `
      CREATE INDEX IF NOT EXISTS idx_runs_finished
        ON workflow_runs (finished_at)
        WHERE finished_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_usage_project
        ON token_usage (tenant_id, project_id, recorded_at DESC);
    `,
  },
];
