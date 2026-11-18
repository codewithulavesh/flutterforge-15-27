/**
 * Platform composition root.
 *
 * One process-wide instance per server. Construction order matters:
 *   config → logging → storage (migrate) → recovery → audit → stores → engine
 *
 * Anything that can resolve on boot (transaction journals, stale workflow
 * leases) is resolved before the HTTP layer starts accepting work. A failure
 * here aborts startup rather than serving a half-initialized platform.
 */
import path from 'node:path';
import { loadPlatformConfig, type PlatformConfig } from './kernel/config.js';
import { createLogger, type Logger } from './kernel/logger.js';
import { systemClock, type Clock } from './kernel/clock.js';
import { Database } from './storage/database.js';
import { PLATFORM_MIGRATIONS } from './storage/schema.js';
import { AuditLog } from './audit/auditLog.js';
import { RevisionStore } from './patch/revisions.js';
import { recoverTransactions } from './patch/transaction.js';
import { WorkflowEngine, type WorkflowDefinition } from './workflow/engine.js';
import { MetricsRegistry, metrics } from './observability/metrics.js';

export interface PlatformInstance {
  config: PlatformConfig;
  logger: Logger;
  clock: Clock;
  db: Database;
  audit: AuditLog;
  engine: WorkflowEngine;
  revisions: RevisionStore;
  metrics: MetricsRegistry;
  transactionRoot: string;
  blobRoot: string;
}

export interface PlatformOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  clock?: Clock;
  definitions?: WorkflowDefinition[];
}

export async function createPlatform(options: PlatformOptions = {}): Promise<PlatformInstance> {
  const config = loadPlatformConfig(options.env ?? process.env);
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createLogger({ level: config.logLevel, name: 'platform' });

  const db = await Database.open({ file: config.dbPath });
  const applied = await db.migrate(PLATFORM_MIGRATIONS);
  if (applied.length > 0) {
    logger.info('applied platform schema migrations', { applied });
  }

  // Unfinished patch transactions must be settled before any request can patch.
  const transactionRoot = path.join(config.dataDir, 'transactions');
  const recovery = await recoverTransactions(transactionRoot, { retainDays: 7 });
  if (recovery.failed.length > 0) {
    logger.warn('some transactions could not be recovered and require inspection', { transactionIds: recovery.failed });
  }
  if (recovery.recovered.length > 0 || recovery.rolledBack.length > 0) {
    logger.info('recovered interrupted transactions', {
      rolledForward: recovery.recovered.length,
      rolledBack: recovery.rolledBack.length,
    });
  }

  const audit = new AuditLog(db, clock);
  const engine = new WorkflowEngine({
    db,
    clock,
    logger: logger.child({}),
    audit,
    leaseTtlMs: config.workflow.leaseTtlMs,
    defaultStepTimeoutMs: config.workflow.defaultStepTimeoutMs,
    maxConcurrentRuns: config.workflow.maxConcurrentRuns,
  });
  const revisions = new RevisionStore({
    db,
    blobRoot: path.join(config.dataDir, 'blobs'),
    clock,
    audit,
  });

  for (const definition of options.definitions ?? []) engine.register(definition);

  const integrity = await db.integrityCheck();
  if (!integrity.ok) {
    logger.warn('database integrity check reported a problem', { detail: integrity.detail });
  }

  logger.info('platform initialized', {
    db: config.dbPath,
    dataDir: config.dataDir,
    authMode: config.auth.mode,
    recoveredTransactions: recovery.recovered.length + recovery.rolledBack.length,
  });

  return {
    config,
    logger,
    clock,
    db,
    audit,
    engine,
    revisions,
    metrics,
    transactionRoot,
    blobRoot: path.join(config.dataDir, 'blobs'),
  };
}

export const version = '2.0.0';
