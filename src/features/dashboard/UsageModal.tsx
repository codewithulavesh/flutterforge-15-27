import { useEffect } from 'react';
import { ArrowUpRight, Gauge, Sparkles } from 'lucide-react';
import { DashboardDialog } from './DashboardDialog';
import { useCreditsStore } from '@/stores/credits.store';
import { isPaidPlan, planLabel } from '@/utils/profile';
import { cn } from '@/utils/cn';

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function eventTone(kind: string) {
  const normalized = kind.toLowerCase();
  if (normalized.includes('spend') || normalized.includes('usage')) return 'text-[var(--fb-muted)]';
  return 'text-emerald-500';
}

export function UsageModal({
  open,
  onClose,
  onOpenPricing,
}: {
  open: boolean;
  onClose: () => void;
  onOpenPricing: () => void;
}) {
  const { wallet, events, loading, error, refresh, loadEvents } = useCreditsStore();

  useEffect(() => {
    if (!open) return;
    void refresh();
    void loadEvents(6);
  }, [loadEvents, open, refresh]);

  const plan = wallet?.plan;
  const allowance = wallet?.monthly_allowance ?? 0;
  const balance = wallet?.balance ?? 0;
  const remainingPct = allowance > 0 ? Math.max(0, Math.min(100, (balance / allowance) * 100)) : 0;
  const paid = isPaidPlan(plan);

  return (
    <DashboardDialog
      description="Every generation, repair and build draws from your monthly credits."
      footer={
        <>
          <button
            className="mr-auto inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium text-[var(--fb-muted)] transition-colors hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)]"
            onClick={() => {
              onClose();
              onOpenPricing();
            }}
            type="button"
          >
            <ArrowUpRight size={14} />
            Compare plans
          </button>
          <button
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--fb-ink)] px-4 text-[12.5px] font-semibold text-[var(--fb-bg)] transition-transform hover:-translate-y-px"
            onClick={() => {
              onClose();
              onOpenPricing();
            }}
            type="button"
          >
            <Sparkles size={14} />
            {paid ? 'Manage plan' : 'Upgrade to Pro'}
          </button>
        </>
      }
      icon={<Gauge size={18} />}
      onClose={onClose}
      open={open}
      title="Usage & credits"
    >
      <div className="space-y-4">
        <div className="rounded-2xl border border-[var(--fb-line)] bg-[var(--fb-soft)]/60 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fb-dim)]">
                Credits remaining
              </p>
              <p className="ffb-display mt-1 flex items-baseline gap-2 text-[44px] leading-none">
                {loading && !wallet ? '—' : balance.toLocaleString()}
                <span className="text-[12px] font-medium tracking-normal text-[var(--fb-muted)]">
                  of {allowance.toLocaleString()}/mo
                </span>
              </p>
            </div>
            <span className="shrink-0 rounded-full border border-[var(--fb-line)] bg-[var(--fb-bg)] px-2.5 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--fb-muted)]">
              {planLabel(plan)}
            </span>
          </div>

          <div
            aria-label={`${Math.round(remainingPct)}% of monthly credits remaining`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(remainingPct)}
            className="mt-4 h-2 overflow-hidden rounded-full bg-[var(--fb-line)]"
            role="progressbar"
          >
            <div
              className="h-full rounded-full bg-[var(--fb-lime)] transition-[width] duration-500"
              style={{ width: `${remainingPct}%` }}
            />
          </div>
          <p className="mt-2 text-[11px] text-[var(--fb-dim)]">
            Credits reset with your monthly billing cycle. Larger builds can use several credits.
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-[var(--fb-line)] p-3">
            <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--fb-dim)]">
              Used all time
            </dt>
            <dd className="mt-1.5 text-[18px] font-semibold tabular-nums">
              {(wallet?.lifetime_used ?? 0).toLocaleString()}
            </dd>
          </div>
          <div className="rounded-xl border border-[var(--fb-line)] p-3">
            <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--fb-dim)]">
              Purchased
            </dt>
            <dd className="mt-1.5 text-[18px] font-semibold tabular-nums">
              {(wallet?.lifetime_purchased ?? 0).toLocaleString()}
            </dd>
          </div>
        </dl>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[12.5px] font-semibold">Recent activity</h3>
            {error && <span className="text-[10.5px] text-[var(--fb-dim)]">Unavailable offline</span>}
          </div>
          {events.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[var(--fb-line)] px-3 py-6 text-center text-[12px] text-[var(--fb-dim)]">
              {loading ? 'Loading activity…' : 'No credit activity yet. Start a build to see it here.'}
            </p>
          ) : (
            <ul className="divide-y divide-[var(--fb-line)] overflow-hidden rounded-xl border border-[var(--fb-line)]">
              {events.map((event) => (
                <li className="flex items-center gap-3 px-3 py-2.5" key={event.id}>
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--fb-soft)] font-mono text-[10px] text-[var(--fb-muted)]">
                    {event.kind.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium">
                      {event.label || event.kind}
                    </span>
                    <span className="block truncate text-[10.5px] text-[var(--fb-dim)]">
                      {formatDate(event.created_at)}
                      {event.model ? ` · ${event.model}` : ''}
                    </span>
                  </span>
                  <span className={cn('shrink-0 font-mono text-[11.5px] tabular-nums', eventTone(event.kind))}>
                    {event.amount > 0 ? '+' : ''}
                    {event.amount}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </DashboardDialog>
  );
}
