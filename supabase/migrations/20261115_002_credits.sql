-- 002 — Credits: wallets, partitioned ledger, guarded RPCs, backfill
-- Depends on 001 (extensions, helper trigger). Idempotent; run as postgres.

-- Match the app's ledger contract (see src/stores/credits.store.ts).

-- ── Plan allowances ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.plan_allowances (
  plan_id           text PRIMARY KEY,
  label             text NOT NULL,
  monthly_credits   integer NOT NULL CHECK (monthly_credits >= 0),
  price_paise       integer NOT NULL DEFAULT 0
);
INSERT INTO public.plan_allowances (plan_id, label, monthly_credits, price_paise) VALUES
  ('free', 'Free',  100, 0),
  ('pro',  'Pro',  1000, 199900),
  ('team', 'Team', 5000, 499900)
ON CONFLICT (plan_id) DO UPDATE
  SET monthly_credits = EXCLUDED.monthly_credits,
      price_paise = EXCLUDED.price_paise;

-- ── Wallets ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.credit_wallets (
  user_id               uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance               integer NOT NULL DEFAULT 100 CHECK (balance >= 0),
  monthly_allowance     integer NOT NULL DEFAULT 100 CHECK (monthly_allowance >= 0),
  lifetime_used         integer NOT NULL DEFAULT 0 CHECK (lifetime_used >= 0),
  lifetime_purchased    integer NOT NULL DEFAULT 0 CHECK (lifetime_purchased >= 0),
  cycle_id              text NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM'),
  plan                  text NOT NULL DEFAULT 'free',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ── Ledger: monthly partitions (hash-free, range on created_at) ─────────────
CREATE TABLE IF NOT EXISTS public.usage_events (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  label         text,
  amount        integer NOT NULL,
  model         text,
  balance_after integer,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS public.usage_events_2026_11 PARTITION OF public.usage_events
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS public.usage_events_2026_12 PARTITION OF public.usage_events
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS public.usage_events_2027_01 PARTITION OF public.usage_events
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS public.usage_events_2027_02 PARTITION OF public.usage_events
  FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS public.usage_events_default PARTITION OF public.usage_events DEFAULT;

-- Rolled-up daily usage (keeps dashboard queries O(1) even at 1B raw rows)
CREATE TABLE IF NOT EXISTS public.usage_daily (
  user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day       date NOT NULL DEFAULT CURRENT_DATE,
  credits_used integer NOT NULL DEFAULT 0,
  calls     integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS usage_events_user_created_idx ON public.usage_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_kind_idx ON public.usage_events (kind);
CREATE INDEX IF NOT EXISTS usage_daily_user_day_idx ON public.usage_daily (user_id, day DESC);

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.credit_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_daily    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_allowances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wallet_owner_reads_own_wallet   ON public.credit_wallets;
DROP POLICY IF EXISTS wallet_owner_updates_own_wallet ON public.credit_wallets;
DROP POLICY IF EXISTS events_owner_reads_own_events   ON public.usage_events;
DROP POLICY IF EXISTS daily_owner_reads_own_daily     ON public.usage_daily;
DROP POLICY IF EXISTS plan_catalog_read               ON public.plan_allowances;

DROP POLICY IF EXISTS "wallet_owner_reads_own_wallet" ON public.credit_wallets;
CREATE POLICY wallet_owner_reads_own_wallet ON public.credit_wallets FOR SELECT
  USING (user_id = (SELECT auth.uid()));
-- Deliberately NO update policy: clients cannot touch wallets directly — only the security-definer RPCs write.
DROP POLICY IF EXISTS "events_owner_reads_own_events" ON public.usage_events;
CREATE POLICY events_owner_reads_own_events ON public.usage_events FOR SELECT
  USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "daily_owner_reads_own_daily" ON public.usage_daily;
CREATE POLICY daily_owner_reads_own_daily ON public.usage_daily FOR SELECT
  USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "plan_catalog_read" ON public.plan_allowances;
CREATE POLICY plan_catalog_read ON public.plan_allowances FOR SELECT
  USING (true);

-- Wallets cannot be granted directly by clients; RPCs (security definer) are the only writers
CREATE OR REPLACE FUNCTION public._touch_wallet_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS credit_wallets_touch ON public.credit_wallets;
CREATE TRIGGER credit_wallets_touch
  BEFORE UPDATE ON public.credit_wallets
  FOR EACH ROW EXECUTE FUNCTION public._touch_wallet_updated_at();

-- ── Monthly partition helper (run via pg_cron on the 1st, or call by hand) ──
CREATE OR REPLACE FUNCTION public.create_usage_events_partition(target_month date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  month_start date := date_trunc('month', target_month)::date;
  next_month  date := (month_start + interval '1 month')::date;
  partition_name text := 'usage_events_' || to_char(month_start, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.usage_events FOR VALUES FROM (%L) TO (%L)',
    partition_name, month_start, next_month);
END;
$$;

-- ── Wallet lifecycle RPCs ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ensure_credit_wallet(p_user uuid, p_plan text)
RETURNS SETOF public.credit_wallets LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE return_row public.credit_wallets%ROWTYPE; a integer;
BEGIN
  SELECT monthly_credits INTO a FROM public.plan_allowances WHERE plan_id = lower(p_plan);
  IF a IS NULL THEN a := 100; END IF;
  INSERT INTO public.credit_wallets (user_id, monthly_allowance, balance, plan)
  VALUES (p_user, a, a, lower(COALESCE(p_plan, 'free')))
  ON CONFLICT (user_id) DO UPDATE
    SET monthly_allowance = EXCLUDED.monthly_allowance,
        plan = EXCLUDED.plan
  RETURNING * INTO return_row;
  RETURN NEXT return_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.ensure_cycle()
RETURNS SETOF public.credit_wallets LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  me public.credit_wallets%ROWTYPE;
  cycle text := to_char(now() AT TIME ZONE 'utc', 'YYYY-MM');
BEGIN
  -- The wallet is authoritative for billing; fall back to profiles.plan only
  -- for first-touch bootstrap. Drifting profiles do not re-rate existing users.
  PERFORM public.ensure_credit_wallet(
    auth.uid(),
    COALESCE(
      (SELECT plan FROM public.credit_wallets WHERE user_id = auth.uid()),
      (SELECT plan FROM public.profiles WHERE id = auth.uid()),
      'free'));
  SELECT * INTO me FROM public.credit_wallets WHERE user_id = auth.uid();
  IF me.cycle_id <> cycle THEN
    UPDATE public.credit_wallets
      SET balance = monthly_allowance,
          cycle_id = cycle,
          lifetime_used = 0
      WHERE user_id = auth.uid()
      RETURNING * INTO me;
    INSERT INTO public.usage_events (user_id, kind, label, amount, balance_after)
    VALUES (auth.uid(), 'cycle_reset', 'Monthly credit cycle reset', me.monthly_allowance, me.balance);
  END IF;
  RETURN NEXT me;
END;
$$;

CREATE OR REPLACE FUNCTION public.spend_credits(p_amount integer, p_kind text, p_label text, p_model text DEFAULT NULL)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE me public.credit_wallets%ROWTYPE;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;
  PERFORM public.ensure_cycle();
  SELECT * INTO me FROM public.credit_wallets WHERE user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wallet not found'; END IF;
  IF me.balance < p_amount THEN
    RETURN json_build_object('ok', false, 'reason', 'insufficient_credits', 'balance', me.balance);
  END IF;
  UPDATE public.credit_wallets
    SET balance = balance - p_amount,
        lifetime_used = lifetime_used + p_amount
    WHERE user_id = auth.uid()
  RETURNING * INTO me;

  INSERT INTO public.usage_events (user_id, kind, label, amount, model, balance_after)
  VALUES (auth.uid(), p_kind, p_label, -p_amount, p_model, me.balance);

  -- Keep the daily rollup hot
  INSERT INTO public.usage_daily (user_id, day, credits_used, calls, updated_at)
  VALUES (auth.uid(), CURRENT_DATE, p_amount, 1, now())
  ON CONFLICT (user_id, day) DO UPDATE
    SET credits_used = usage_daily.credits_used + EXCLUDED.credits_used,
        calls = usage_daily.calls + 1,
        updated_at = now();

  RETURN json_build_object('ok', true, 'balance', me.balance);
END;
$$;

-- Server-side fulfillment entry point (service role only)
CREATE OR REPLACE FUNCTION public.grant_plan_credits(target_user_id uuid, plan_name text, extra integer DEFAULT 0)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE me public.credit_wallets%ROWTYPE; a integer;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;
  SELECT monthly_credits INTO a FROM public.plan_allowances WHERE plan_id = lower(plan_name);
  IF a IS NULL THEN a := 100; END IF;
  PERFORM public.ensure_credit_wallet(target_user_id, plan_name);
  UPDATE public.credit_wallets
    SET balance = a + GREATEST(extra, 0),
        monthly_allowance = a,
        plan = lower(plan_name),
        lifetime_purchased = lifetime_purchased + a + GREATEST(extra, 0)
    WHERE user_id = target_user_id
  RETURNING * INTO me;
  INSERT INTO public.usage_events (user_id, kind, label, amount, balance_after, metadata)
  VALUES (target_user_id, 'grant_plan', 'Plan credits: ' || lower(plan_name), a + GREATEST(extra, 0), me.balance,
          jsonb_build_object('plan', lower(plan_name), 'extra', extra));
  RETURN json_build_object('ok', true, 'balance', me.balance);
END;
$$;

-- ── Backfill existing users ─────────────────────────────────────────────────
INSERT INTO public.credit_wallets (user_id, monthly_allowance, balance, plan)
SELECT u.id,
       COALESCE((SELECT monthly_credits FROM public.plan_allowances WHERE plan_id = lower(coalesce(pr.plan,'free'))), 100),
       COALESCE((SELECT monthly_credits FROM public.plan_allowances WHERE plan_id = lower(coalesce(pr.plan,'free'))), 100),
       lower(coalesce(pr.plan, 'free'))
FROM auth.users u
LEFT JOIN public.profiles pr ON pr.id = u.id
ON CONFLICT (user_id) DO NOTHING;