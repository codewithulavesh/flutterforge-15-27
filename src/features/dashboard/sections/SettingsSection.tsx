import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ArrowUpRight,
  Check,
  CreditCard,
  FolderKanban,
  LogOut,
  Moon,
  Rocket,
  Settings2,
  Sun,
} from 'lucide-react';
import type { Project } from '@/types';
import { useAuthStore } from '@/stores/auth.store';
import { useCreditsStore } from '@/stores/credits.store';
import { useThemeStore } from '@/stores/theme.store';
import { isPaidPlan, planLabel } from '@/utils/profile';
import { cn } from '@/utils/cn';
import {
  Panel,
  SectionBody,
  SectionHeader,
  StatusChip,
  primaryButtonClass,
  secondaryButtonClass,
} from './SectionShell';

function formatMemberSince(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function ThemeOption({
  active,
  icon,
  label,
  description,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        'flex flex-1 items-center gap-3 rounded-2xl border p-3 text-left transition-colors sm:p-4',
        active
          ? 'border-[var(--fb-ink)] bg-[var(--fb-soft)]'
          : 'border-[var(--fb-line)] hover:border-[var(--fb-ink)]/40',
      )}
      onClick={onClick}
      type="button"
    >
      <span
        className={cn(
          'grid h-10 w-10 shrink-0 place-items-center rounded-xl border',
          active
            ? 'border-transparent bg-[var(--fb-ink)] text-[var(--fb-bg)]'
            : 'border-[var(--fb-line)] bg-[var(--fb-soft)] text-[var(--fb-muted)]',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-semibold text-[var(--fb-ink)]">{label}</span>
        <span className="mt-0.5 block text-[11px] text-[var(--fb-dim)]">{description}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          'grid h-5 w-5 shrink-0 place-items-center rounded-full border',
          active
            ? 'border-[var(--fb-ink)] bg-[var(--fb-ink)] text-[var(--fb-bg)]'
            : 'border-[var(--fb-line)] text-transparent',
        )}
      >
        <Check size={12} />
      </span>
    </button>
  );
}

export function SettingsSection({
  projects,
  onOpenBilling,
  onSignOut,
}: {
  projects: Project[];
  onOpenBilling: () => void;
  onSignOut: () => void;
}) {
  const { profile } = useAuthStore();
  const { wallet } = useCreditsStore();
  const { theme, setTheme } = useThemeStore();
  const location = useLocation();

  useEffect(() => {
    if (location.hash !== '#billing') return;
    const timer = window.setTimeout(() => {
      document.getElementById('billing')?.scrollIntoView({ block: 'start' });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [location.hash]);

  const deployed = projects.filter(
    (project) => project.status === 'deployed' || Boolean(project.deployment_url),
  ).length;
  const plan = wallet?.plan || profile?.plan;
  const paid = isPaidPlan(plan);
  const allowance = wallet?.monthly_allowance ?? 0;
  const balance = wallet?.balance ?? 0;
  const remainingPct = allowance > 0 ? Math.max(0, Math.min(100, (balance / allowance) * 100)) : 0;

  return (
    <SectionBody>
      <SectionHeader
        actions={
          <Link className={secondaryButtonClass} to="/dashboard/usage">
            Usage &amp; credits
            <ArrowUpRight size={14} />
          </Link>
        }
        description="Preferences for this workspace, plus your plan, billing and session controls."
        eyebrow="Platform"
        title="Settings"
      />

      <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
        <div className="space-y-4">
          <Panel description="Applies instantly across the dashboard and workspace." title="Appearance">
            <div className="p-4 sm:p-5">
              <div className="flex flex-col gap-2 sm:flex-row">
                <ThemeOption
                  active={theme === 'light'}
                  description="Warm paper surfaces with dark ink."
                  icon={<Sun size={18} />}
                  label="Light"
                  onClick={() => setTheme('light')}
                />
                <ThemeOption
                  active={theme === 'dark'}
                  description="Near-black surfaces with bright ink."
                  icon={<Moon size={18} />}
                  label="Dark"
                  onClick={() => setTheme('dark')}
                />
              </div>
              <p className="mt-3 flex items-center gap-1.5 text-[10.5px] text-[var(--fb-dim)]">
                <Settings2 aria-hidden size={12} />
                Saved to this browser and applied before the app paints.
              </p>
            </div>
          </Panel>

          <Panel
            actions={<StatusChip tone={paid ? 'live' : 'neutral'}>{planLabel(plan)}</StatusChip>}
            description="Subscriptions and credit packs."
            id="billing"
            title="Plan & billing"
          >
            <div className="space-y-4 p-4 sm:p-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="ffb-display text-[42px] leading-none">
                    {balance.toLocaleString()}
                    <span className="ml-2 text-[12px] font-medium tracking-normal text-[var(--fb-muted)]">
                      credits remaining
                    </span>
                  </p>
                  <p className="mt-1 text-[11.5px] text-[var(--fb-muted)]">
                    {allowance.toLocaleString()} included each month on {planLabel(plan)}.
                  </p>
                </div>
                <StatusChip tone="neutral">{wallet?.cycle_id ?? 'Current cycle'}</StatusChip>
              </div>

              <div
                aria-label={`${Math.round(remainingPct)}% of monthly credits remaining`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={Math.round(remainingPct)}
                className="h-2 overflow-hidden rounded-full bg-[var(--fb-line)]"
                role="progressbar"
              >
                <div
                  className="h-full rounded-full bg-[var(--fb-lime)]"
                  style={{ width: `${remainingPct}%` }}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button className={primaryButtonClass} onClick={onOpenBilling} type="button">
                  <CreditCard size={14} />
                  {paid ? 'Manage subscription' : 'Upgrade plan'}
                </button>
                <button className={secondaryButtonClass} onClick={onOpenBilling} type="button">
                  Compare plans
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-[var(--fb-dim)]">
                Secure checkout via Razorpay. Prices are charged in INR; card details never touch FlutterForge
                servers.
              </p>
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel description="A quick snapshot of this account." title="Workspace">
            <dl className="divide-y divide-[var(--fb-line)]">
              <div className="flex items-center gap-3 px-4 py-3">
                <FolderKanban aria-hidden className="shrink-0 text-[var(--fb-dim)]" size={15} />
                <dt className="min-w-0 flex-1 text-[12px] text-[var(--fb-muted)]">Projects</dt>
                <dd className="text-[13px] font-semibold tabular-nums">{projects.length}</dd>
              </div>
              <div className="flex items-center gap-3 px-4 py-3">
                <Rocket aria-hidden className="shrink-0 text-[var(--fb-dim)]" size={15} />
                <dt className="min-w-0 flex-1 text-[12px] text-[var(--fb-muted)]">Deployed apps</dt>
                <dd className="text-[13px] font-semibold tabular-nums">{deployed}</dd>
              </div>
              <div className="flex items-center gap-3 px-4 py-3">
                <Settings2 aria-hidden className="shrink-0 text-[var(--fb-dim)]" size={15} />
                <dt className="min-w-0 flex-1 text-[12px] text-[var(--fb-muted)]">Member since</dt>
                <dd className="text-[12px] font-medium">{formatMemberSince(profile?.created_at)}</dd>
              </div>
            </dl>
          </Panel>

          <Panel description="Signed in on this browser." title="Session">
            <div className="space-y-3 p-4">
              <div className="rounded-xl border border-[var(--fb-line)] bg-[var(--fb-bg)]/40 px-3 py-2.5">
                <p className="truncate text-[12px] font-medium text-[var(--fb-ink)]">
                  {profile?.full_name || profile?.email?.split('@')[0] || 'Your account'}
                </p>
                <p className="truncate text-[11px] text-[var(--fb-dim)]">{profile?.email}</p>
              </div>
              <button
                className="flex h-10 w-full items-center gap-2.5 rounded-xl border border-[var(--fb-line)] px-3 text-left text-[12px] font-medium text-[var(--fb-muted)] transition-colors hover:border-red-500/40 hover:text-red-500"
                onClick={onSignOut}
                type="button"
              >
                <LogOut aria-hidden size={15} />
                Sign out
              </button>
              <p className="text-[10.5px] leading-relaxed text-[var(--fb-dim)]">
                Signing out clears this session on the device. Local projects stay in your workspace.
              </p>
            </div>
          </Panel>
        </div>
      </div>
    </SectionBody>
  );
}
