/**
 * Supabase Management API bridge (api.supabase.com).
 *
 * The user pastes their Supabase project ref + a personal access token (PAT).
 * The PAT is forwarded ONLY to the engine process on their machine — it never
 * lands in a file, never leaves the local network unless the engine itself
 * is deployed somewhere public.
 *
 * Docs: https://supabase.com/docs/guides/api#personal-access-tokens
 */
const SUPABASE_API = 'https://api.supabase.com';

interface VerifyResult {
  ok: boolean;
  project?: { ref: string; name?: string; status?: string; region?: string };
  error?: string;
}

async function api(path: string, pat: string, init?: RequestInit) {
  const res = await fetch(`${SUPABASE_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try { json = JSON.parse(text); } catch { /* leave as undefined */ }
  }
  return { res, text, json };
}

export async function verifySupabaseConnection(projectRef: string, personalAccessToken: string): Promise<VerifyResult> {
  const ref = projectRef.trim();
  const pat = personalAccessToken.trim();
  if (!ref || !/^[a-z0-9]{20}$/i.test(ref)) {
    return { ok: false, error: 'Project ref looks invalid — 20 lower-case alphanumeric chars, e.g. `abcdefghijklmnoprstuv`.' };
  }
  if (pat.length < 30) {
    return { ok: false, error: 'That does not look like a Supabase personal access token (sbp_…).' };
  }

  const { res, text, json } = await api(`/v1/projects/${encodeURIComponent(ref)}`, pat);
  if (res.status === 401) return { ok: false, error: 'Token is invalid or lacks the `projects:read` scope — regenerate it at supabase.com/dashboard/account/tokens.' };
  if (res.status === 403) return { ok: false, error: 'Token authenticates but lacks access to that project — check its scopes.' };
  if (res.status === 404) return { ok: false, error: `No project with ref ${ref}. Double-check the ref at supabase.com/dashboard/project/${ref}/settings/general.` };
  if (!res.ok) return { ok: false, error: `Supabase rejected verification (${res.status}). ${text.slice(0, 300)}` };

  const body = json as { name?: string; status?: string; region?: string } | undefined;
  return {
    ok: true,
    project: { ref, name: body?.name, status: body?.status, region: body?.region },
  };
}

export interface ApplyResult {
  ok: boolean;
  appliedStatements?: number;
  error?: string;
  migrationFile?: string;
}

export async function applySupabaseMigration(
  projectRef: string,
  personalAccessToken: string,
  sql: string,
  migrationFile = 'supabase/migrations/001_initial_schema.sql',
): Promise<ApplyResult> {
  if (!sql.trim()) return { ok: false, error: 'SQL is empty — generate the migration first.' };

  const verified = await verifySupabaseConnection(projectRef, personalAccessToken);
  if (!verified.ok) return { ok: false, error: verified.error };

  const { res, text } = await api(`/v1/projects/${encodeURIComponent(projectRef)}/database/query`, personalAccessToken, {
    method: 'POST',
    body: JSON.stringify({ query: sql }),
  });

  if (res.ok) {
    return { ok: true, migrationFile };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'Token rejected the query — the PAT needs `database:query` (or admin) scope.' };
  }
  if (res.status === 400) {
    return { ok: false, error: `SQL failed: ${text.slice(0, 400)}` };
  }
  return { ok: false, error: `Supabase query failed (${res.status}): ${text.slice(0, 400)}` };
}
