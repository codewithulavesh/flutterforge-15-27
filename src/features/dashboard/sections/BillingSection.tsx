import { Link } from 'react-router-dom';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import { Pricing } from '@/components/blocks/pricing';
import { LANDING_PLANS } from '@/components/blocks/pricing-plans';
import { useAuthStore } from '@/stores/auth.store';
import { useCreditsStore } from '@/stores/credits.store';
import { planLabel } from '@/utils/profile';
import {
  SectionBody,
  SectionHeader,
  StatTile,
  secondaryButtonClass,
} from './SectionShell';

/** The signed-in workspace never sends people back to the marketing plans. */
const PLANS = LANDING_PLANS.map((plan) =>
  plan.id === 'free' ? { ...plan, buttonText: 'Free plan', href: '/dashboard' } : plan,
);

export function BillingSection() {
  const { profile } = useAuthStore();
  const { wallet, refresh } = useCreditsStore();

  const plan = (wallet?.plan || profile?.plan || 'free').toLowerCase();
  const balance = wallet?.balance ?? 0;
  const allowance = wallet?.monthly_allowance ?? 0;
  const cycle = wallet?.cycle_id;

  return (
    <SectionBody>
      <SectionHeader
        actions={
          <Link className={secondaryButtonClass} to="/dashboard/usage">
            Usage &amp; credits
            <ArrowUpRight size={14} />
          </Link>
        }
        description="Your subscription, monthly credits and secure checkout — all inside the studio."
        eyebrow="Workspace"
        title="Plans & billing"
      />

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile
          accent="lime"
          hint="active"
          label="Current plan"
          value={<span className="text-[26px] sm:text-[32px]">{planLabel(plan)}</span>}
        />
        <StatTile hint="remaining" label="Credits" value={balance.toLocaleString()} />
        <StatTile
          className="col-span-2 sm:col-span-1"
          hint={cycle ? `cycle ${cycle}` : 'monthly'}
          label="Allowance"
          value={allowance.toLocaleString()}
        />
      </dl>

      <div>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="ffb-display ffb-caps text-[28px] leading-none">Compare plans</h2>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--fb-muted)]">
              Every plan writes real Flutter source. Paid tiers add more monthly credits and longer build sessions.
            </p>
          </div>
          <p className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--fb-dim)]">
            <ShieldCheck aria-hidden size={12} />
            Razorpay · INR
          </p>
        </div>

        <Pricing
          className="px-0 py-0 sm:px-0"
          currentPlanId={plan}
          description="Switch or cancel anytime. Monthly allowances reset at the start of each billing cycle."
          eyebrow="Plans"
          note="Payments are processed securely by Razorpay in INR. Card details never touch FlutterForge servers."
          onPurchaseComplete={() => void refresh()}
          plans={PLANS}
          showHeading={false}
          title="Choose a plan"
        />
      </div>
    </SectionBody>
  );
}
