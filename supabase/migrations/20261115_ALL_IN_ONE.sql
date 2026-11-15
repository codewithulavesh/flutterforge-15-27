
-- 20261115_001_hardening.sql
-- 001 — Scale & hardening for ~10M users
-- Apply in Supabase SQL editor (one shot, or via `supabase db push`).
-- Idempotent: safe to re-run. Run as postgres / service_role.
--
-- Summary of changes
-- 1. Extensions + helper updated_at trigger
-- 2. Missing columns on profiles / projects / generation_tasks / dependencies
-- 3. Uniqueness + FK + hot-path indexes (dashboard, messages, versions, builds)
-- 4. updated_at triggers on every mutable table
-- 5. RLS rewritten with (SELECT auth.uid()) — evaluated once per query, not per row
-- 6. Anonymous share reads moved to security-definer RPC (no more list-all-shared)
-- 7. Partial/trigram indexes for public share + search

-- ── 0. Extensions ───────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;         -- fast ILIKE on project names
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;  -- slow-query visibility

-- ── 1. Helper trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ── 2. Missing columns ──────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS company text,
  ADD COLUMN IF NOT EXISTS onboarding_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_active_at timestamptz,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_opened_at timestamptz;

ALTER TABLE public.generation_tasks ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.dependencies      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.builds            ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.deployments       ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- ── 3. Constraints (guarded) ────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_plan_check') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_plan_check
      CHECK (plan IN ('free', 'pro', 'team'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_role_check') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
      CHECK (role IN ('user', 'admin'));
  END IF;
END $$;

-- Every project must have exactly one (project, path) — required for upserts
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'project_files_project_path_unq') THEN
    CREATE UNIQUE INDEX project_files_project_path_unq ON public.project_files (project_id, path);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'projects_share_slug_unq') THEN
    CREATE UNIQUE INDEX projects_share_slug_unq ON public.projects (share_slug) WHERE share_slug IS NOT NULL;
  END IF;
END $$;

-- ── 4. Hot-path indexes ─────────────────────────────────────────────────────
-- Dashboard list: owner's recent projects
CREATE INDEX IF NOT EXISTS projects_user_updated_idx ON public.projects (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS projects_user_pinned_idx  ON public.projects (user_id, pinned_at DESC NULLS LAST);

-- AI conversation timeline (per project, newest first)
CREATE INDEX IF NOT EXISTS ai_conversations_project_idx ON public.ai_conversations (project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ai_messages_conversation_idx ON public.ai_messages (conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS ai_messages_conversation_id_created_idx ON public.ai_messages (conversation_id, created_at DESC);
-- Partial: user's own last-10-messages lookups without scanning the table

-- Builds & deployments history
CREATE INDEX IF NOT EXISTS builds_project_created_idx ON public.builds (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deployments_project_created_idx ON public.deployments (project_id, created_at DESC);

-- Task monitoring (agent runs)
CREATE INDEX IF NOT EXISTS generation_tasks_project_status_idx ON public.generation_tasks (project_id, status, updated_at DESC);

-- Version restore / diff
CREATE INDEX IF NOT EXISTS project_versions_project_number_idx ON public.project_versions (project_id, version_number DESC);

-- Dependencies + embeddings lookups
CREATE INDEX IF NOT EXISTS dependencies_project_idx ON public.dependencies (project_id);
CREATE INDEX IF NOT EXISTS project_file_embeddings_project_idx ON public.project_file_embeddings (project_id);
CREATE INDEX IF NOT EXISTS project_file_embeddings_path_idx ON public.project_file_embeddings (project_id, file_path);

-- Public share + name search
CREATE INDEX IF NOT EXISTS projects_share_slug_idx ON public.projects (share_slug) WHERE is_shared;
CREATE INDEX IF NOT EXISTS projects_name_trgm_idx ON public.projects USING gin (name gin_trgm_ops);

-- ── 5. updated_at triggers everywhere mutable ───────────────────────────────
DROP TRIGGER IF EXISTS profiles_touch  ON public.profiles;
CREATE TRIGGER profiles_touch  BEFORE UPDATE ON public.profiles  FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();
DROP TRIGGER IF EXISTS projects_touch  ON public.projects;
CREATE TRIGGER projects_touch  BEFORE UPDATE ON public.projects  FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();
DROP TRIGGER IF EXISTS project_files_touch ON public.project_files;
CREATE TRIGGER project_files_touch BEFORE UPDATE ON public.project_files FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();
DROP TRIGGER IF EXISTS generation_tasks_touch ON public.generation_tasks;
CREATE TRIGGER generation_tasks_touch BEFORE UPDATE ON public.generation_tasks FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();
DROP TRIGGER IF EXISTS builds_touch ON public.builds;
CREATE TRIGGER builds_touch BEFORE UPDATE ON public.builds FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();
DROP TRIGGER IF EXISTS deployments_touch ON public.deployments;
CREATE TRIGGER deployments_touch BEFORE UPDATE ON public.deployments FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();
DROP TRIGGER IF EXISTS dependencies_touch ON public.dependencies;
CREATE TRIGGER dependencies_touch BEFORE UPDATE ON public.dependencies FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();

-- ── 6. RLS: evaluate auth.uid() once per statement instead of per row ───────
-- The common "select own X" policy, rewritten with an initplan.
DO $$ DECLARE
  policy record;
BEGIN
  FOR policy IN
    SELECT tablename, policyname
    FROM pg_policies WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy.policyname, policy.tablename);
  END LOOP;
END $$;

CREATE POLICY select_own_profile ON public.profiles FOR SELECT
  USING (id = (SELECT auth.uid()));
CREATE POLICY insert_own_profile ON public.profiles FOR INSERT
  WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY update_own_profile ON public.profiles FOR UPDATE
  USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()));

CREATE POLICY select_own_projects ON public.projects FOR SELECT
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY insert_own_projects ON public.projects FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY update_own_projects ON public.projects FOR UPDATE
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY delete_own_projects ON public.projects FOR DELETE
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY select_own_project_files ON public.project_files FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY insert_own_project_files ON public.project_files FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY update_own_project_files ON public.project_files FOR UPDATE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())))
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY delete_own_project_files ON public.project_files FOR DELETE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

CREATE POLICY select_own_project_versions ON public.project_versions FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY insert_own_project_versions ON public.project_versions FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY delete_own_project_versions ON public.project_versions FOR DELETE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

CREATE POLICY select_own_conversations ON public.ai_conversations FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY insert_own_conversations ON public.ai_conversations FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY update_own_conversations ON public.ai_conversations FOR UPDATE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY delete_own_conversations ON public.ai_conversations FOR DELETE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

CREATE POLICY select_own_messages ON public.ai_messages FOR SELECT
  USING (conversation_id IN (
    SELECT ac.id FROM public.ai_conversations ac
    JOIN public.projects p ON p.id = ac.project_id
    WHERE p.user_id = (SELECT auth.uid())));
CREATE POLICY insert_own_messages ON public.ai_messages FOR INSERT
  WITH CHECK (conversation_id IN (
    SELECT ac.id FROM public.ai_conversations ac
    JOIN public.projects p ON p.id = ac.project_id
    WHERE p.user_id = (SELECT auth.uid())));
CREATE POLICY delete_own_messages ON public.ai_messages FOR DELETE
  USING (conversation_id IN (
    SELECT ac.id FROM public.ai_conversations ac
    JOIN public.projects p ON p.id = ac.project_id
    WHERE p.user_id = (SELECT auth.uid())));

CREATE POLICY select_own_tasks ON public.generation_tasks FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY insert_own_tasks ON public.generation_tasks FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY update_own_tasks ON public.generation_tasks FOR UPDATE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

CREATE POLICY select_own_builds ON public.builds FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY insert_own_builds ON public.builds FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY update_own_builds ON public.builds FOR UPDATE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

CREATE POLICY select_own_dependencies ON public.dependencies FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY insert_own_dependencies ON public.dependencies FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY update_own_dependencies ON public.dependencies FOR UPDATE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())))
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY delete_own_dependencies ON public.dependencies FOR DELETE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

CREATE POLICY select_own_deployments ON public.deployments FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY insert_own_deployments ON public.deployments FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY update_own_deployments ON public.deployments FOR UPDATE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

CREATE POLICY embeddings_owner ON public.project_file_embeddings FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

-- Shared projects: no blanket anon SELECT — reads go through SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.get_shared_project(p_slug text)
RETURNS SETOF public.projects LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.projects
  WHERE is_shared AND share_slug = p_slug AND archived_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.get_shared_project_files(p_slug text)
RETURNS TABLE (path text, content text, file_type text, updated_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT pf.path, pf.content, pf.file_type, pf.updated_at
  FROM public.project_files pf
  JOIN public.projects p ON p.id = pf.project_id
  WHERE p.is_shared AND p.share_slug = p_slug AND p.archived_at IS NULL;
$$;

-- Grant anon/authenticated the RPC but nothing else beyond their own rows
GRANT EXECUTE ON FUNCTION public.get_shared_project(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_shared_project_files(text) TO anon, authenticated;

-- ── Restore policies dropped in the sweep above ────────────────────────────
-- code_patterns feeds the retriever. Writes are service-role only: the pattern
-- library is seeded by migrations/backfills, never by end users.
CREATE POLICY "Public read code patterns" ON public.code_patterns FOR SELECT USING (true);

-- Vector embeddings: full owner access (matches the previous blanket grant)
CREATE POLICY "Owner write file embeddings" ON public.project_file_embeddings FOR ALL
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())))
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

-- Analyze so the planner has fresh statistics after the rewrite
ANALYZE public.projects;
ANALYZE public.ai_messages;
ANALYZE public.ai_conversations;
ANALYZE public.project_files;

-- 20261115_002_credits.sql
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
-- 20261115_003_billing.sql
-- 003 — Billing: payments, subscriptions, webhook idempotency
-- Depends on 001 + 002. Idempotent; run as postgres.

-- ── Payments ledger (writes by server/service role only; owner reads) ───────
CREATE TABLE IF NOT EXISTS public.payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  razorpay_order_id   text UNIQUE NOT NULL,
  razorpay_payment_id text,
  plan                text NOT NULL CHECK (plan IN ('pro', 'team')),
  period              text NOT NULL DEFAULT 'monthly' CHECK (period IN ('monthly', 'yearly')),
  amount_paise        bigint NOT NULL CHECK (amount_paise > 0),
  currency            text NOT NULL DEFAULT 'INR',
  status              text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed', 'refunded')),
  signature_verified  boolean NOT NULL DEFAULT false,
  receipt             text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz
);
CREATE INDEX IF NOT EXISTS payments_user_created_idx ON public.payments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_status_idx ON public.payments (status);

-- Webhook idempotency: never double-grant the same Razorpay event
CREATE TABLE IF NOT EXISTS public.webhook_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id    text UNIQUE,
  event_type  text NOT NULL,
  payload     jsonb NOT NULL,
  processed   boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- ── Subscriptions (monthly reset, no auto-charge mandate) ───────────────────
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan               text NOT NULL CHECK (plan IN ('pro', 'team')),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'cancelled', 'expired')),
  period_start       timestamptz NOT NULL DEFAULT now(),
  period_end         timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_active_per_user_idx
  ON public.subscriptions (user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS subscriptions_period_end_idx ON public.subscriptions (period_end);
DROP TRIGGER IF EXISTS subscriptions_touch ON public.subscriptions;
CREATE TRIGGER subscriptions_touch
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payments_owner_reads ON public.payments;
DROP POLICY IF EXISTS "payments_owner_reads" ON public.payments;
CREATE POLICY payments_owner_reads ON public.payments FOR SELECT
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS subscriptions_owner_reads ON public.subscriptions;
DROP POLICY IF EXISTS "subscriptions_owner_reads" ON public.subscriptions;
CREATE POLICY subscriptions_owner_reads ON public.subscriptions FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- Webhook events & payment writes: service role only (no client access)
-- (no permissive policies created for either table)

-- ── record_payment: atomic insert + grant ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_payment(
  p_user_id uuid,
  p_razorpay_order_id text,
  p_razorpay_payment_id text,
  p_plan text,
  p_period text,
  p_amount_paise bigint,
  p_receipt text
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  pay public.payments%ROWTYPE;
  sub public.subscriptions%ROWTYPE;
  grant_result json;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;

  INSERT INTO public.payments (user_id, razorpay_order_id, razorpay_payment_id, plan, period,
                               amount_paise, currency, status, signature_verified, receipt, paid_at)
  VALUES (p_user_id, p_razorpay_order_id, p_razorpay_payment_id, lower(p_plan), lower(p_period),
          p_amount_paise, 'INR', 'paid', true, p_receipt, now())
  ON CONFLICT (razorpay_order_id) DO UPDATE
    SET razorpay_payment_id = EXCLUDED.razorpay_payment_id,
        status = 'paid',
        signature_verified = true,
        paid_at = now()
  RETURNING * INTO pay;

  -- One active subscription per user: renew period
  INSERT INTO public.subscriptions (user_id, plan, status, period_start, period_end)
  VALUES (p_user_id, lower(p_plan), 'active', now(),
          now() + (CASE lower(p_period) WHEN 'yearly' THEN interval '1 year' ELSE interval '1 month' END))
  ON CONFLICT (user_id) WHERE status = 'active' DO UPDATE
    SET plan = EXCLUDED.plan,
        period_start = now(),
        period_end = EXCLUDED.period_end,
        cancel_at_period_end = false
  RETURNING * INTO sub;

  -- Keep profiles.plan in sync for UI badges; the wallet remains authoritative
  UPDATE public.profiles SET plan = lower(p_plan) WHERE id = p_user_id;

  grant_result := public.grant_plan_credits(p_user_id, lower(p_plan), 0);

  RETURN json_build_object(
    'ok', true,
    'payment_id', pay.id,
    'subscription_id', sub.id,
    'period_end', sub.period_end,
    'credits', grant_result -> 'balance'
  );
END;
$$;

-- ── Revoke / cancel (user self-service) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_my_subscription()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.subscriptions
    SET cancel_at_period_end = true, updated_at = now()
    WHERE user_id = auth.uid() AND status = 'active';
END;
$$;

-- ── Cheap index for billing dashboards ──────────────────────────────────────
DROP INDEX IF EXISTS public.payments_plan_month_idx;
CREATE INDEX IF NOT EXISTS payments_paid_at_idx     ON public.payments (paid_at DESC);
CREATE INDEX IF NOT EXISTS payments_plan_paid_at_idx ON public.payments (plan, paid_at DESC);
-- 20261115_004_admin_ops.sql
-- 004 — Admin access, analytics, ops helpers
-- Depends on 001–003. Run as postgres.

-- ── Role helper used by admin policies / RPCs ───────────────────────────────
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin');
$$;

-- ── Admin RPCs (read-only aggregates; guarded) ──────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_overview()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN json_build_object(
    'users',          (SELECT count(*) FROM public.profiles),
    'projects',       (SELECT count(*) FROM public.projects),
    'active_subs',    (SELECT count(*) FROM public.subscriptions WHERE status = 'active'),
    'paid_payments',  (SELECT count(*) FROM public.payments WHERE status = 'paid'),
    'revenue_paise',  (SELECT coalesce(sum(amount_paise), 0) FROM public.payments WHERE status = 'paid'),
    'credits_spent',  (SELECT coalesce(sum(-amount), 0) FROM public.usage_events WHERE kind = 'llm_call'),
    'llm_calls',      (SELECT count(*) FROM public.usage_events WHERE kind = 'llm_call')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_top_consumers(p_limit integer DEFAULT 25)
RETURNS TABLE (
  user_id uuid, email text, plan text, credits_used integer,
  llm_calls bigint, balance integer, last_active timestamptz
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN QUERY
  SELECT u.id, u.email, coalesce(pr.plan, 'free'),
         coalesce(w.lifetime_used, 0),
         count(e.id) FILTER (WHERE e.kind = 'llm_call'),
         coalesce(w.balance, 0),
         max(e.created_at)
  FROM auth.users u
  LEFT JOIN public.profiles pr ON pr.id = u.id
  LEFT JOIN public.credit_wallets w ON w.user_id = u.id
  LEFT JOIN public.usage_events e ON e.user_id = u.id
  GROUP BY u.id, u.email, pr.plan, w.lifetime_used, w.balance
  ORDER BY coalesce(w.lifetime_used, 0) DESC
  LIMIT GREATEST(1, LEAST(p_limit, 200));
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_recent_payments(p_limit integer DEFAULT 50)
RETURNS TABLE (
  id uuid, email text, plan text, amount_paise bigint,
  status text, paid_at timestamptz, razorpay_order_id text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN QUERY
  SELECT p.id, u.email, p.plan, p.amount_paise, p.status, p.paid_at, p.razorpay_order_id
  FROM public.payments p
  LEFT JOIN auth.users u ON u.id = p.user_id
  ORDER BY p.created_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 500));
END;
$$;

-- ── Ops: retention for raw events (keep 14 months, then roll up) ────────────
CREATE OR REPLACE FUNCTION public.prune_usage_events_before(p_before timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE deleted_count integer;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  WITH d AS (
    DELETE FROM public.usage_events WHERE created_at < p_before RETURNING 1
  )
  SELECT count(*) INTO deleted_count FROM d;
  RETURN deleted_count;
END;
$$;

-- ── Housekeeping: digest of unpaid subscription expirations ─────────────────
CREATE OR REPLACE FUNCTION public.expire_lapsed_subscriptions()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  UPDATE public.subscriptions
    SET status = 'expired', updated_at = now()
    WHERE status = 'active' AND period_end < now() AND NOT cancel_at_period_end;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;