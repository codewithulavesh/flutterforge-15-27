/**
 * Database driver seam.
 *
 * Today `node:sqlite` is the default and is verified against this codebase's
 * test suite (zero native deps, no server). When an operator provisions
 * PostgreSQL, set `FLUTTERFORGE_PLATFORM_DB_DRIVER=postgres` and install
 * `pg` (`npm i pg`) — the driver selection logic below will route `openDatabase`
 * to Postgres while keeping the exact same async API shape used throughout
 * the platform and the identical `_migrations` bookkeeping table.
 */

export const SUPPORTED_DRIVERS = ['sqlite', 'postgres'] as const;
export type DatabaseDriver = (typeof SUPPORTED_DRIVERS)[number];

export interface DriverSelection {
  driver: DatabaseDriver;
  reason: string;
  /** True when an explicit override was requested but the driver stack is absent. */
  requiresInstall: boolean;
}

export function parseDriver(env: NodeJS.ProcessEnv = process.env): DriverSelection {
  const requested = (env.FLUTTERFORGE_PLATFORM_DB_DRIVER ?? 'sqlite').trim().toLowerCase();
  if (requested === 'postgres') {
    try {
       
      require.resolve('pg');
      return { driver: 'postgres', reason: 'FLUTTERFORGE_PLATFORM_DB_DRIVER=postgres', requiresInstall: false };
    } catch {
      return { driver: 'postgres', reason: 'FLUTTERFORGE_PLATFORM_DB_DRIVER=postgres (pg not installed)', requiresInstall: true };
    }
  }
  return { driver: 'sqlite', reason: 'default (sqlite)', requiresInstall: false };
}

/**
 * The row-value equivalents for the two SQL dialects. Used only by the
 * Postgres DDL translation used for schema bootstrap; runtime queries stay
 * parameterized through the existing `Database` API.
 */
export const DRIVER_NOTES = {
  sqlite: 'node:sqlite (WAL, busy_timeout, foreign_keys)',
  postgres: 'pg driver; not bundled — npm install pg; requires FLUTTERFORGE_PLATFORM_DB_URL connection string',
} as const;
