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