/**
 * Local-first Supabase connection — user pastes project ref + personal
 * access token in Settings. They live only in localStorage and are sent to
 * the engine on each migrate/verify call, never to a hosted service.
 */
import { create } from 'zustand';

const REF_KEY = 'ff_supabase_ref';
const PAT_KEY = 'ff_supabase_pat';

export interface SupabaseConnection {
  projectRef: string;
  /** Never rendered in plain text. We surface only presence + errors. */
  connected: boolean;
  lastError: string | null;
  projectName: string | null;
  connecting: boolean;
}

function readLocal(): Pick<SupabaseConnection, 'connected' | 'projectRef'> {
  if (typeof localStorage === 'undefined') return { connected: false, projectRef: '' };
  try {
    const ref = localStorage.getItem(REF_KEY) ?? '';
    const pat = localStorage.getItem(PAT_KEY) ?? '';
    return { connected: ref.length > 0 && pat.length > 0, projectRef: ref };
  } catch {
    return { connected: false, projectRef: '' };
  }
}

interface SupabaseState extends SupabaseConnection {
  save(ref: string, pat: string): Promise<boolean>;
  disconnect(): void;
  applyMigration(sql: string, filePath?: string): Promise<{ ok: boolean; error?: string }>;
}

export const useSupabaseStore = create<SupabaseState>((set) => ({
  projectRef: readLocal().projectRef,
  connected: readLocal().connected,
  lastError: null,
  projectName: null,
  connecting: false,

  save: async (projectRef, pat) => {
    set({ connecting: true, lastError: null });
    try {
      const res = await fetch('/api/supabase/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRef, personalAccessToken: pat }),
      });
      const payload = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; project?: { name?: string } };
      if (!res.ok || !payload.ok) throw new Error(payload.error ?? `Verification failed (HTTP ${res.status}).`);
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(REF_KEY, projectRef);
          localStorage.setItem(PAT_KEY, pat);
        }
      } catch { /* best effort */ }
      set({
        connected: true,
        projectRef,
        projectName: payload.project?.name ?? null,
        connecting: false,
        lastError: null,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ connecting: false, lastError: message });
      return false;
    }
  },

  disconnect: () => {
    try {
      localStorage.removeItem(REF_KEY);
      localStorage.removeItem(PAT_KEY);
    } catch { /* best effort */ }
    set({ connected: false, projectRef: '', projectName: null, lastError: null });
  },

  applyMigration: async (sql, filePath) => {
    try {
      const ref = typeof localStorage !== 'undefined' ? localStorage.getItem(REF_KEY) ?? '' : '';
      const pat = typeof localStorage !== 'undefined' ? localStorage.getItem(PAT_KEY) ?? '' : '';
      if (!ref || !pat) return { ok: false, error: 'Connect a Supabase project first.' };
      set({ connecting: true, lastError: null });
      const res = await fetch('/api/supabase/apply-migration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRef: ref, personalAccessToken: pat, sql, migrationFile: filePath }),
      });
      const payload = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      set({ connecting: false });
      if (!res.ok || !payload.ok) throw new Error(payload.error ?? `Apply failed (HTTP ${res.status}).`);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ connecting: false, lastError: message });
      return { ok: false, error: message };
    }
  },
}));
