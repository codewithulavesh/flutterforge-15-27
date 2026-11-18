/**
 * Minimal .env/.env.local loader for the server process.
 *
 * The Vite dev server loads .env.local for the FRONTEND, but `npm run server`
 * and Electron-spawned engines start with a bare shell environment. Without
 * this module, keys placed in .env.local (Razorpay, DSH_*, OPENROUTER_API_KEY)
 * silently never reach the server — and `create-order` answered 503 even with
 * the keys present.
 *
 * Precedence (first write wins):
 *   1. variables already present in process.env
 *   2. .env.local (developer overrides — wins over .env)
 *   3. .env
 *
 * Best-effort: a malformed file never takes the server down. Missing files
 * are fine. Values may be quoted or bare; `# comments` are supported.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_ROOT = process.env.FLUTTERFORGE_DATA_ROOT || process.cwd();

export function loadEnvFiles(root?: string): void {
  const base = root || DEFAULT_ROOT;
  for (const name of ['.env.local', '.env']) {
    const file = path.join(base, name);
    if (!existsSync(file)) continue;
    try {
      for (const raw of readFileSync(file, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
          value = value.slice(1, -1);
        } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
          value = value.slice(1, -1);
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    } catch {
      // Swallow — a bad .env file must not block server startup.
    }
  }
}

loadEnvFiles();
