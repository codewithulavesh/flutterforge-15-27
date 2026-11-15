# FlutterForge Database — Apply & Operate

Files (apply in order):
1. `20261115_001_hardening.sql` — indexes, constraints, RLS rewrite, embeddings/shared
2. `20261115_002_credits.sql` — wallets, partitioned ledger, plan catalog, RPCs, backfill
3. `20261115_003_billing.sql` — payments, subscriptions, webhook idempotency, RPCs
4. `20261115_004_admin_ops.sql` — admin RPCs (is_admin, overview, top consumers, retention)

## Apply

Paste each file into Supabase → SQL editor → Run, in order. Or `supabase db push`
if your project is linked via CLI. Run as `postgres` (default SQL editor role).
All four are idempotent — re-run freely.

## Verification

```sql
-- Indexes present
select tablename, indexname from pg_indexes where schemaname = 'public' order by tablename;

-- Every project can be upserted (project_files uniqueness)
select indexname from pg_indexes where indexname = 'project_files_project_path_unq';

-- RLS smoke: what can a random user see?
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000000"}';
select count(*) from projects;          -- expect 0 (no such user)
select public.admin_overview();          -- expect ERROR: forbidden
reset role;

-- Credits flow
select ensure_cycle();
select spend_credits(3, 'llm_call', 'Smoke test', 'nvidia/nemotron-3.5-lightning:free');
select * from credit_wallets limit 3;
```

## Recommended settings for 10M-scale posture

- **Connection pooling**: Supavisor in "transaction mode" (or PgBouncer), pool size
  20–50 per app instance. PostgREST-direct doesn't pool; client goes through `supabase` client anyway.
- **Partition maintenance**: `select create_usage_events_partition(date_trunc('month', now()))`
  monthly + one quarter ahead. pg_cron example:

  ```sql
  select cron.schedule('monthly-partitions', '0 3 1 * *',
    $$ select public.create_usage_events_partition(date_trunc('month', now()) + interval '2 months') $$);
  select cron.schedule('daily-subscription-expiry', '15 4 * * *',
    $$ select public.expire_lapsed_subscriptions() $$);
  select cron.schedule('weekly-vacuum', '30 3 * * 0', $$vacuum analyze public.usage_events$$);
  ```

- **Retention**: keep 14 months of raw events, then `select prune_usage_events_before(now() - interval '14 months');`.
  Daily rollups make total aggregation O(days).
- **Hotspots to watch**: `usage_events` insert rate (millions/day at full scale).
  The `usage_daily` rollup keeps dashboards flat; do **not** aggregate raw events in the app.

## Intended architecture notes

- **Writes to wallets/ledger:** only through security-definer RPCs (`spend_credits`,
  `grant_plan_credits`, `record_payment`). No client-side INSERT/UPDATE on either table.
- **Shared projects**: the old "USING (is_shared)" anon policy is gone. Public share links
  must call the security-definer RPCs below (server can also call them during SSR):

  ```sql
  select * from public.get_shared_project('abcdef');
  select * from public.get_shared_project_files('abcdef');
  ```

  The React client that renders a share page should be updated to call these RPCs instead
  of `supabase.from('projects').select(...).eq('share_slug', slug)` — the blanket
  "select every shared project" grant is revoked by 001.

## Scale checkpoints (before 10M users)

| Milestone | Action |
|-----------|--------|
| >100k projects | Move `project_files.content` to object storage (S3) + keep `project_files` as pointers |
| >1M messages/mo | Partition `ai_messages` by month (same pattern as usage_events) |
| >50M rows in `usage_events` | Add weekly partition partitions + retention pruning |
| Sustained read pressure | read replicas + routing reads through `pg_read_footer` |

## Files for the app layer (unchanged)

The app's contracts (`spend_credits`, `ensure_cycle`, `grant_plan_credits`,
`record_payment`) match `src/stores/credits.store.ts` and the Razorpay webhook/fulfillment
paths end-to-end. Apply order: 001 → 002 → app restart → smoke test → deploy → 003/004.
