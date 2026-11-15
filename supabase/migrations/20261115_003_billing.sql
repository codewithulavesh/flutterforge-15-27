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