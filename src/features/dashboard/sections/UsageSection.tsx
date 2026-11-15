import { useEffect, useState } from 'react';
import { ArrowUpRight, CreditCard, Gauge, Sparkles } from 'lucide-react';
import { CREDIT_PACKS, useCreditsStore } from '@/stores/credits.store';
import { isPaidPlan, planLabel } from '@/utils/profile';
import { cn } from '@/utils/cn';
import {
  Panel,
  SectionBody,
  SectionHeader,
  StatTile,
  StatusChip,
  primaryButtonClass,
  secondaryButtonClass,
} from './SectionShell';

const PLAN_FACTS: Record<string, { price: string; credits: string; note: string }> = {
  free: { price: '₹0', credits: '100 credits / month', note: 'Enough to try a full build each month.' },
  pro: { price: '₹1,999', credits: '1,000 credits / month', note: 'For solo builders shipping every week.' },
  team: { price: '₹4,999', credits: '5,000 credits / month', note: 'For teams building client apps together.' },
};

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function planPrice(planId: string) {
  const pack = CREDIT_PACKS.find((entry) => entry.plan === planId);
  return pack ? `₹${(pack.pricePaise / 100).toLocaleString('en-IN')}` : '₹0';
}

export function UsageSection({ onOpenBilling }: { onOpenBilling: () => void }) {
  const { wallet, events, loading, error, refresh, loadEvents } = useCreditsStore();
  const [limit, setLimit] = useState(20);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void loadEvents(limit);
  }, [limit, loadEvents]);

  const plan = (wallet?.plan || 'free').toLowerCase();
  const allowance = wallet?.monthly_allowance ?? 0;
  const balance = wallet?.balance ?? 0;
  const remainingPct = allowance > 0 ? Math.max(0, Math.min(100, (balance / allowance) * 100)) : 0;
  const consumedPct = 100 - remainingPct;
  const paid = isPaidPlan(plan);
  const facts = PLAN_FACTS[plan] ?? PLAN_FACTS.free;

  return (
    <SectionBody>
      <SectionHeader
        actions={
          <>
            <button className={secondaryButtonClass} onClick={onOpenBilling} type="button">
              <ArrowUpRight size={14} />
              Compare plans
            </button>
            <button className={primaryButtonClass} onClick={onOpenBilling} type="button">
              <Sparkles size={14} />
              {paid ? 'Manage plan' : 'Upgrade to Pro'}
            </button>
          </>
        }
        description="Every generation, repair and build draws from your monthly credits. Purchased credits never expire before your cycle resets."
        eyebrow="Workspace"
        title="Usage & credits"
      />

      <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
        <Panel
          actions={
            <StatusChip tone={error ? 'warn' : 'neutral'}>
              {error ? 'Offline' : `Cycle ${wallet?.cycle_id ?? '—'}`}
            </StatusChip>
          }
          className="p-5 sm:p-6"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fb-dim)]">
                Credits remaining
              </p>
              <p className="ffb-display mt-2 flex flex-wrap items-baseline gap-2 text-[clamp(48px,9vw,76px)] leading-[0.85]">
                {loading && !wallet ? '—' : balance.toLocaleString()}
                <span className="text-[12px] font-medium tracking-normal text-[var(--fb-muted)]">
                  of {allowance.toLocaleString()} / month
                </span>
              </p>
            </div>
            <span className="rounded-full border border-[var(--fb-line)] bg-[var(--fb-bg)] px-2.5 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--fb-muted)]">
              {planLabel(plan)}
            </span>
          </div>

          <div
            aria-label={`${Math.round(remainingPct)}% of monthly credits remaining`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(remainingPct)}
            className="mt-6 h-2.5 overflow-hidden rounded-full bg-[var(--fb-line)]"
            role="progressbar"
          >
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-500',
                remainingPct <= 15 ? 'bg-amber-500' : 'bg-[var(--fb-lime)]',
              )}
              style={{ width: `${remainingPct}%` }}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--fb-dim)]">
            <span>{Math.round(consumedPct)}% used this cycle</span>
            <span>Resets with your monthly billing cycle</span>
          </div>

          <dl className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="rounded-xl border border-[var(--fb-line)] bg-[var(--fb-bg)]/40 p-3">
              <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--fb-dim)]">
                Used all time
              </dt>
              <dd className="mt-1.5 text-[20px] font-semibold tabular-nums">
                {(wallet?.lifetime_used ?? 0).toLocaleString()}
              </dd>
            </div>
            <div className="rounded-xl border border-[var(--fb-line)] bg-[var(--fb-bg)]/40 p-3">
              <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--fb-dim)]">
                Purchased
              </dt>
              <dd className="mt-1.5 text-[20px] font-semibold tabular-nums">
                {(wallet?.lifetime_purchased ?? 0).toLocaleString()}
              </dd>
            </div>
            <div className="col-span-2 rounded-xl border border-[var(--fb-line)] bg-[var(--fb-bg)]/40 p-3 sm:col-span-1">
              <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--fb-dim)]">
                Next reset
              </dt>
              <dd className="mt-1.5 text-[13px] font-semibold">Monthly cycle</dd>
            </div>
          </dl>
        </Panel>

        <Panel className="flex flex-col p-5 sm:p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fb-dim)]">
                Current plan
              </p>
              <h2 className="ffb-display ffb-caps mt-2 text-[34px] leading-[0.9]">{planLabel(plan)}</h2>
            </div>
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--fb-lime)] text-black">
              <CreditCard size={18} />
            </span>
          </div>

          <p className="mt-4 flex items-baseline gap-1.5">
            <span className="text-[30px] font-semibold leading-none">{facts.price}</span>
            <span className="text-[11px] text-[var(--fb-muted)]">{paid ? 'per month' : 'forever'}</span>
          </p>
          <p className="mt-1 text-[11.5px] text-[var(--fb-muted)]">{facts.credits}</p>
          <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--fb-dim)]">{facts.note}</p>

          <ul className="mt-4 space-y-1.5 text-[11.5px] text-[var(--fb-muted)]">
            <li>Unlimited projects and exports</li>
            <li>Live preview and compile repair</li>
            <li>Bring your own model keys anytime</li>
          </ul>

          <button
            className={cn(primaryButtonClass, 'mt-auto w-full justify-center')}
            onClick={onOpenBilling}
            type="button"
          >
            {paid ? 'Manage subscription' : 'Upgrade plan'}
          </button>
          <p className="mt-2 text-center text-[10px] text-[var(--fb-dim)]">
            Secure checkout via Razorpay · INR pricing
          </p>
        </Panel>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile hint="remaining" label="Balance" value={balance.toLocaleString()} />
        <StatTile hint="monthly" label="Allowance" value={allowance.toLocaleString()} />
        <StatTile
          className="col-span-2 sm:col-span-1"
          hint={planPrice(plan)}
          label="Plan value"
          value={<span className="text-[24px] sm:text-[28px]">{planLabel(plan)}</span>}
        />
      </dl>

      <Panel
        actions={
          <span className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--fb-dim)]">
            <Gauge aria-hidden size={12} />
            {events.length} loaded
          </span>
        }
        description="Newest first. Each row shows credits added or spent and the balance after the call."
        title="Credit activity"
      >
        {events.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] font-medium text-[var(--fb-ink)]">
              {loading ? 'Loading activity…' : 'No credit activity yet'}
            </p>
            <p className="mx-auto mt-1 max-w-sm text-[11.5px] leading-relaxed text-[var(--fb-dim)]">
              {error
                ? 'Could not reach the credits service. Check your connection and refresh.'
                : 'Start a build and every deduction will be listed here with the model that used it.'}
            </p>
          </div>
        ) : (
          <>
            <ul className="divide-y divide-[var(--fb-line)]">
              {events.map((event) => {
                const spend = event.kind.toLowerCase().includes('spend') || event.amount < 0;
                return (
                  <li className="flex items-center gap-3 px-4 py-3 sm:px-5" key={event.id}>
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--fb-line)] bg-[var(--fb-soft)] font-mono text-[10px] uppercase text-[var(--fb-muted)]">
                      {event.kind.slice(0, 2)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-[var(--fb-ink)]">
                        {event.label || event.kind}
                      </span>
                      <span className="block truncate text-[10.5px] text-[var(--fb-dim)]">
                        {formatDate(event.created_at)}
                        {event.model ? ` · ${event.model}` : ''}
                        {event.balance_after != null ? ` · balance ${event.balance_after}` : ''}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'shrink-0 font-mono text-[12px] font-semibold tabular-nums',
                        spend ? 'text-[var(--fb-muted)]' : 'text-emerald-500',
                      )}
                    >
                      {event.amount > 0 ? '+' : ''}
                      {event.amount}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--fb-line)] px-4 py-3 sm:px-5">
              <p className="text-[10.5px] text-[var(--fb-dim)]">
                {error ? 'Some activity may be unavailable offline.' : 'Activity is retained for the current billing year.'}
              </p>
              {events.length >= limit && (
                <button
                  className="inline-flex h-8 items-center rounded-full border border-[var(--fb-line)] px-3 text-[11px] font-medium text-[var(--fb-muted)] transition-colors hover:border-[var(--fb-ink)] hover:text-[var(--fb-ink)]"
                  onClick={() => setLimit((current) => current + 30)}
                  type="button"
                >
                  Load more
                </button>
              )}
            </div>
          </>
        )}
      </Panel>
    </SectionBody>
  );
}
