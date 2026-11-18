/**
 * Typed platform configuration.
 *
 * Configuration is parsed once, validated eagerly, and frozen. Anything that
 * could silently weaken security (a short JWT secret, an open CORS origin, a
 * sandbox escape hatch) fails fast with a readable error instead of degrading
 * at request time.
 */
import path from 'node:path';
import { getProjectDataRoot } from '../../paths.js';
import type { LogLevel } from './logger.js';

export type AuthMode = 'local' | 'jwt';
export type SandboxMode = 'auto' | 'docker' | 'local';

export interface PlatformConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly dataDir: string;
  readonly dbPath: string;
  readonly logLevel: LogLevel;
  readonly auth: {
    readonly mode: AuthMode;
    readonly issuer?: string;
    readonly audience?: string;
    readonly hs256Secret?: string;
    readonly publicKeyPem?: string;
    readonly clockSkewSeconds: number;
    readonly localTenantId: string;
    readonly localUserId: string;
  };
  readonly http: {
    readonly maxBodyBytes: number;
    readonly requestTimeoutMs: number;
    readonly rateLimitEnabled: boolean;
    readonly allowedOrigins: readonly string[];
  };
  readonly workflow: {
    readonly maxConcurrentRuns: number;
    readonly leaseTtlMs: number;
    readonly pollIntervalMs: number;
    readonly defaultStepTimeoutMs: number;
    readonly retentionDays: number;
  };
  readonly sandbox: {
    readonly mode: SandboxMode;
    readonly dockerImage: string;
    readonly runtime: 'runc' | 'runsc';
    readonly maxConcurrent: number;
    readonly defaultTimeoutMs: number;
    readonly cpuCores: number;
    readonly memoryMb: number;
  };
  readonly patch: {
    readonly maxFiles: number;
    readonly maxFileBytes: number;
    readonly maxTotalBytes: number;
  };
  readonly secrets: {
    readonly masterKey?: string;
  };
  readonly metrics: { readonly enabled: boolean };
  readonly tracing: { readonly enabled: boolean; readonly sampleRatio: number };
}

export interface ConfigIssue {
  variable: string;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[]) {
    super(`Invalid platform configuration: ${issues.map((issue) => `${issue.variable}: ${issue.message}`).join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type Env = Record<string, string | undefined>;

function readString(env: Env, key: string, fallback?: string): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

function readInt(env: Env, key: string, fallback: number, issues: ConfigIssue[], bounds: { min: number; max: number }): number {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    issues.push({ variable: key, message: 'must be an integer' });
    return fallback;
  }
  if (parsed < bounds.min || parsed > bounds.max) {
    issues.push({ variable: key, message: `must be between ${bounds.min} and ${bounds.max}` });
    return fallback;
  }
  return parsed;
}

function readFloat(env: Env, key: string, fallback: number, issues: ConfigIssue[], bounds: { min: number; max: number }): number {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < bounds.min || parsed > bounds.max) {
    issues.push({ variable: key, message: `must be a number between ${bounds.min} and ${bounds.max}` });
    return fallback;
  }
  return parsed;
}

function readBool(env: Env, key: string, fallback: boolean, issues: ConfigIssue[]): boolean {
  const raw = readString(env, key)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  issues.push({ variable: key, message: 'must be a boolean (true/false)' });
  return fallback;
}

function readEnum<T extends string>(env: Env, key: string, fallback: T, allowed: readonly T[], issues: ConfigIssue[]): T {
  const raw = readString(env, key) as T | undefined;
  if (raw === undefined) return fallback;
  if (!allowed.includes(raw)) {
    issues.push({ variable: key, message: `must be one of ${allowed.join(', ')}` });
    return fallback;
  }
  return raw;
}

export function loadPlatformConfig(env: Env = process.env): PlatformConfig {
  const issues: ConfigIssue[] = [];
  const nodeEnv = readEnum(env, 'NODE_ENV', 'development', ['development', 'test', 'production'] as const, issues);
  const dataDir = path.resolve(readString(env, 'FLUTTERFORGE_DATA_DIR') || getProjectDataRoot());
  const logLevel = readEnum(env, 'FLUTTERFORGE_LOG_LEVEL', nodeEnv === 'production' ? 'info' : 'debug', ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const, issues);
  const authMode = readEnum(env, 'FLUTTERFORGE_AUTH_MODE', 'local', ['local', 'jwt'] as const, issues);

  const hs256Secret = readString(env, 'FLUTTERFORGE_JWT_SECRET');
  const publicKeyPem = readString(env, 'FLUTTERFORGE_JWT_PUBLIC_KEY')?.replaceAll('\\n', '\n');
  if (authMode === 'jwt') {
    if (!hs256Secret && !publicKeyPem) {
      issues.push({ variable: 'FLUTTERFORGE_JWT_SECRET', message: 'required when FLUTTERFORGE_AUTH_MODE=jwt' });
    }
    if (hs256Secret && hs256Secret.length < 32) {
      issues.push({ variable: 'FLUTTERFORGE_JWT_SECRET', message: 'must be at least 32 characters' });
    }
    if (!readString(env, 'FLUTTERFORGE_JWT_ISSUER')) {
      issues.push({ variable: 'FLUTTERFORGE_JWT_ISSUER', message: 'required when FLUTTERFORGE_AUTH_MODE=jwt' });
    }
  }

  const origins = (readString(env, 'FLUTTERFORGE_ALLOWED_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173') || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (nodeEnv === 'production' && origins.includes('*')) {
    issues.push({ variable: 'FLUTTERFORGE_ALLOWED_ORIGINS', message: 'wildcard CORS is not allowed in production' });
  }

  const maxBodyBytes = readInt(env, 'FLUTTERFORGE_MAX_BODY_BYTES', 64 * 1024 * 1024, issues, { min: 1024, max: 512 * 1024 * 1024 });
  const sampleRatio = readFloat(env, 'FLUTTERFORGE_TRACE_SAMPLE_RATIO', 0.1, issues, { min: 0, max: 1 });

  const config: PlatformConfig = Object.freeze({
    nodeEnv,
    dataDir,
    dbPath: path.resolve(readString(env, 'FLUTTERFORGE_PLATFORM_DB') || path.join(dataDir, 'platform', 'platform.sqlite')),
    logLevel,
    auth: Object.freeze({
      mode: authMode,
      issuer: readString(env, 'FLUTTERFORGE_JWT_ISSUER'),
      audience: readString(env, 'FLUTTERFORGE_JWT_AUDIENCE', 'flutterforge'),
      hs256Secret,
      publicKeyPem,
      clockSkewSeconds: readInt(env, 'FLUTTERFORGE_JWT_CLOCK_SKEW', 30, issues, { min: 0, max: 600 }),
      localTenantId: readString(env, 'FLUTTERFORGE_LOCAL_TENANT', 'local') as string,
      localUserId: readString(env, 'FLUTTERFORGE_LOCAL_USER', 'local-developer') as string,
    }),
    http: Object.freeze({
      maxBodyBytes,
      requestTimeoutMs: readInt(env, 'FLUTTERFORGE_REQUEST_TIMEOUT_MS', 120_000, issues, { min: 1000, max: 3_600_000 }),
      rateLimitEnabled: readBool(env, 'FLUTTERFORGE_RATE_LIMIT', true, issues),
      allowedOrigins: Object.freeze(origins),
    }),
    workflow: Object.freeze({
      maxConcurrentRuns: readInt(env, 'FLUTTERFORGE_WORKFLOW_CONCURRENCY', 4, issues, { min: 1, max: 64 }),
      leaseTtlMs: readInt(env, 'FLUTTERFORGE_WORKFLOW_LEASE_MS', 60_000, issues, { min: 5000, max: 3_600_000 }),
      pollIntervalMs: readInt(env, 'FLUTTERFORGE_WORKFLOW_POLL_MS', 1000, issues, { min: 50, max: 60_000 }),
      defaultStepTimeoutMs: readInt(env, 'FLUTTERFORGE_STEP_TIMEOUT_MS', 15 * 60_000, issues, { min: 1000, max: 24 * 3_600_000 }),
      retentionDays: readInt(env, 'FLUTTERFORGE_WORKFLOW_RETENTION_DAYS', 30, issues, { min: 1, max: 3650 }),
    }),
    sandbox: Object.freeze({
      mode: readEnum(env, 'FLUTTERFORGE_SANDBOX', 'auto', ['auto', 'docker', 'local'] as const, issues),
      dockerImage: readString(env, 'FLUTTERFORGE_SANDBOX_IMAGE', 'ghcr.io/flutterforge/build-env:3.24') as string,
      runtime: readEnum(env, 'FLUTTERFORGE_SANDBOX_RUNTIME', 'runc', ['runc', 'runsc'] as const, issues),
      maxConcurrent: readInt(env, 'FLUTTERFORGE_SANDBOX_CONCURRENCY', 4, issues, { min: 1, max: 32 }),
      defaultTimeoutMs: readInt(env, 'FLUTTERFORGE_SANDBOX_TIMEOUT_MS', 180_000, issues, { min: 1000, max: 3_600_000 }),
      cpuCores: readInt(env, 'FLUTTERFORGE_SANDBOX_CPUS', 2, issues, { min: 1, max: 64 }),
      memoryMb: readInt(env, 'FLUTTERFORGE_SANDBOX_MEMORY_MB', 4096, issues, { min: 256, max: 131_072 }),
    }),
    patch: Object.freeze({
      maxFiles: readInt(env, 'FLUTTERFORGE_PATCH_MAX_FILES', 500, issues, { min: 1, max: 10_000 }),
      maxFileBytes: readInt(env, 'FLUTTERFORGE_PATCH_MAX_FILE_BYTES', 2 * 1024 * 1024, issues, { min: 1024, max: 32 * 1024 * 1024 }),
      maxTotalBytes: readInt(env, 'FLUTTERFORGE_PATCH_MAX_TOTAL_BYTES', 64 * 1024 * 1024, issues, { min: 1024, max: 512 * 1024 * 1024 }),
    }),
    secrets: Object.freeze({
      masterKey: readString(env, 'FLUTTERFORGE_MASTER_KEY'),
    }),
    metrics: Object.freeze({ enabled: readBool(env, 'FLUTTERFORGE_METRICS', true, issues) }),
    tracing: Object.freeze({ enabled: readBool(env, 'FLUTTERFORGE_TRACING', true, issues), sampleRatio }),
  });

  if (issues.length > 0) throw new ConfigError(issues);
  return config;
}
