import { create } from 'zustand';
import { supabase, isSupabaseConfigured } from '@/services/supabase';

export interface CreditWallet {
  user_id: string;
  balance: number;
  monthly_allowance: number;
  lifetime_used: number;
  lifetime_purchased: number;
  cycle_id: string;
  plan: string;
  updated_at: string;
  created_at: string;
}

export interface CreditEvent {
  id: string;
  kind: string;
  label: string | null;
  amount: number;
  model: string | null;
  balance_after: number | null;
  created_at: string;
}

export const CREDIT_PACKS = [
  { id: 'pro', plan: 'pro', label: 'Pro — 1,000 credits/mo', credits: 1000, pricePaise: 199900 },
  { id: 'team', plan: 'team', label: 'Team — 5,000 credits/mo', credits: 5000, pricePaise: 499900 },
] as const;
export const FREE_MONTHLY = 100;

/** Credit weight of one LLM call, by model. Economy calls cost 1, frontier 4. */
export function creditWeightFor(modelId?: string | null): number {
  if (!modelId) return 1;
  const id = modelId.toLowerCase();
  if (/ultra|70b|deepseek-chat|qwen/.test(id)) return 4;
  return 1;
}

interface CreditsState {
  wallet: CreditWallet | null;
  events: CreditEvent[];
  loading: boolean;
  error: string | null;
  /** True while a spend RPC is in-flight — avoids double-debit on retries. */
  spending: boolean;

  refresh: () => Promise<void>;
  loadEvents: (limit?: number) => Promise<void>;
  spend: (amount: number, kind: string, label: string, model?: string | null) => Promise<{ ok: true; balance: number } | { ok: false; error: string }>;
  creditPlan: (plan: 'pro' | 'team', opts?: { orderId?: string; paymentId?: string; signature?: string }) => Promise<{ ok: boolean; error?: string }>;
}

function mapWallet(row: Record<string, unknown> | null | undefined): CreditWallet | null {
  if (!row) return null;
  return {
    user_id: String(row.user_id),
    balance: Number(row.balance) || 0,
    monthly_allowance: Number(row.monthly_allowance) || FREE_MONTHLY,
    lifetime_used: Number(row.lifetime_used) || 0,
    lifetime_purchased: Number(row.lifetime_purchased) || 0,
    cycle_id: String(row.cycle_id),
    plan: String(row.plan),
    updated_at: String(row.updated_at),
    created_at: String(row.created_at),
  };
}

/**
 * Serializes credit deductions. The RPC must not be called concurrently from
 * parallel agent batches (3–6 simultaneous LLM calls), and silently dropping
 * a deduction while another was in flight made metering a placebo. Deduction
 * calls are now executed one at a time, in order.
 */
let spendChain: Promise<unknown> = Promise.resolve();

export const useCreditsStore = create<CreditsState>((set, get) => ({
  wallet: null,
  events: [],
  loading: false,
  error: null,
  spending: false,

  refresh: async () => {
    if (!isSupabaseConfigured) {
      set({ wallet: null, loading: false });
      return;
    }
    set({ loading: true, error: null });
    try {
      const { data, error } = await supabase.rpc('ensure_cycle');
      if (error) throw error;
      const wallet = mapWallet(Array.isArray(data) ? data[0] : data);
      set({ wallet, loading: false });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      set({ error: message, loading: false });
    }
  },

  loadEvents: async (limit = 10) => {
    if (!isSupabaseConfigured) return;
    try {
      const { data, error } = await supabase
        .from('usage_events')
        .select('id, kind, label, amount, model, balance_after, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      set({ events: (data ?? []) as CreditEvent[] });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      set({ error: message });
    }
  },

  spend: (amount, kind, label, model) => {
    if (!isSupabaseConfigured) {
      // Engine off / no account: don't block local builds, but report it.
      console.warn('[credits] Supabase not configured — spending not recorded');
      return Promise.resolve({ ok: true, balance: Number.POSITIVE_INFINITY });
    }
    const run = spendChain.then(() => spendOnce());
    spendChain = run.catch(() => undefined);
    return run;

    async function spendOnce(): Promise<{ ok: true; balance: number } | { ok: false; error: string }> {
    set({ spending: true });
    try {
      const { data, error } = await supabase.rpc('spend_credits', {
        p_amount: Math.max(1, Math.floor(amount)),
        p_kind: kind,
        p_label: label,
        p_model: model ?? null,
      });
      if (error) throw error;
      const payload = data as { ok: boolean; balance?: number; reason?: string } | null;
      if (!payload?.ok) {
        const balance = payload?.balance ?? 0;
        set((state) => ({ spending: false, wallet: state.wallet ? { ...state.wallet, balance } : state.wallet }));
        return { ok: false, error: `Insufficient credits (balance: ${balance}). Upgrade to keep building.` };
      }
        set((state) => ({
          spending: false,
          wallet: state.wallet ? { ...state.wallet, balance: payload.balance ?? state.wallet.balance } : state.wallet,
        }));
        return { ok: true, balance: payload.balance ?? 0 };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      set({ spending: false, error: message });
      return { ok: false, error: message };
    }
    }
  },

  creditPlan: async (plan, opts) => {
    const payload = { plan, ...(opts ?? {}) };
    if (!payload.orderId || !payload.paymentId || !payload.signature) {
      return { ok: false, error: 'A Razorpay order id, payment id and signature are all required to grant plan credits.' };
    }
    try {
      // Fully server-authoritative: the engine re-verifies the signature,
      // re-fetches the order from Razorpay with Basic Auth, and only then
      // grants credits through the service-role RPC. The browser cannot use
      // this as a free-credit path.
      const res = await fetch('/api/payments/fulfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Fulfillment failed (HTTP ${res.status}).`);
      }
      await get().refresh();
      await get().loadEvents(10);
      return { ok: true };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, error: message };
    }
  },
}));
