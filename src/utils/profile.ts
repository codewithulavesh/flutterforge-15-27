/** Human labels shared by the dashboard sidebar and account dialogs. */
export function planLabel(plan?: string | null): string {
  const normalized = (plan || 'free').toLowerCase();
  if (normalized === 'pro') return 'Pro plan';
  if (normalized === 'team') return 'Team plan';
  return 'Free plan';
}

export function planName(plan?: string | null): string {
  const normalized = (plan || 'free').toLowerCase();
  if (normalized === 'pro') return 'Pro';
  if (normalized === 'team') return 'Team';
  return 'Free';
}

export function isPaidPlan(plan?: string | null): boolean {
  const normalized = (plan || 'free').toLowerCase();
  return normalized === 'pro' || normalized === 'team';
}
