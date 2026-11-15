import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

/** Shared class strings so every dashboard section uses the same controls. */
export const primaryButtonClass =
  'inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-[var(--fb-ink)] px-4 text-[12px] font-semibold text-[var(--fb-bg)] transition-transform hover:-translate-y-px disabled:pointer-events-none disabled:opacity-50';

export const secondaryButtonClass =
  'inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-[var(--fb-line)] px-4 text-[12px] font-medium text-[var(--fb-muted)] transition-colors hover:border-[var(--fb-ink)] hover:text-[var(--fb-ink)] disabled:pointer-events-none disabled:opacity-50';

export const fieldClass =
  'h-11 w-full rounded-xl border border-[var(--fb-line)] bg-[var(--fb-bg)] px-3 text-[13.5px] text-[var(--fb-ink)] outline-none transition-colors placeholder:text-[var(--fb-dim)] focus:border-[var(--fb-ink)]';

export function SectionHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="inline-flex items-center gap-2 rounded-full border border-[var(--fb-line)] bg-[var(--fb-card)] px-3 py-1 font-mono text-[9.5px] font-semibold uppercase tracking-[0.15em] text-[var(--fb-muted)]">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--fb-magenta)]" />
          {eyebrow}
        </p>
        <h1 className="ffb-display ffb-caps mt-4 break-words text-[clamp(34px,5.4vw,60px)] leading-[0.86] tracking-[-0.035em]">
          {title}
        </h1>
        <p className="mt-3 max-w-2xl text-[13.5px] leading-relaxed text-[var(--fb-muted)]">
          {description}
        </p>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  id,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      className={cn(
        'scroll-mt-6 overflow-hidden rounded-[22px] border border-[var(--fb-line)] bg-[var(--fb-card)]',
        className,
      )}
      id={id}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--fb-line)] px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            {title && <h2 className="text-[13.5px] font-semibold text-[var(--fb-ink)]">{title}</h2>}
            {description && (
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--fb-dim)]">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatTile({
  label,
  value,
  hint,
  accent = 'plain',
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: 'plain' | 'lime';
  className?: string;
}) {
  const lime = accent === 'lime';
  return (
    <div
      className={cn(
        'flex flex-col justify-between rounded-[22px] border p-4 sm:p-5',
        lime
          ? 'border-transparent bg-[var(--fb-lime)] text-black'
          : 'border-[var(--fb-line)] bg-[var(--fb-card)]',
        className,
      )}
    >
      <p
        className={cn(
          'font-mono text-[9px] font-semibold uppercase tracking-[0.14em]',
          lime ? 'text-black/60' : 'text-[var(--fb-muted)]',
        )}
      >
        {label}
      </p>
      <p className="mt-5 flex items-end gap-2">
        <span
          className={cn(
            'ffb-display text-[40px] leading-none tabular-nums sm:text-[46px]',
            !lime && 'text-[var(--fb-ink)]',
          )}
        >
          {value}
        </span>
        {hint && (
          <span
            className={cn(
              'mb-1 text-[10px] font-medium',
              lime ? 'text-black/55' : 'text-[var(--fb-muted)]',
            )}
          >
            {hint}
          </span>
        )}
      </p>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-[18px] border border-[var(--fb-line)] bg-[var(--fb-soft)] text-[var(--fb-muted)]">
        {icon}
      </div>
      <h2 className="ffb-display ffb-caps text-[30px] leading-[0.9]">{title}</h2>
      <p className="mt-3 max-w-sm text-[13px] leading-relaxed text-[var(--fb-muted)]">{description}</p>
      {action && <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

export function StatusChip({
  tone,
  children,
}: {
  tone: 'live' | 'neutral' | 'warn';
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.1em]',
        tone === 'live' && 'bg-emerald-500/12 text-emerald-500',
        tone === 'neutral' && 'border border-[var(--fb-line)] text-[var(--fb-dim)]',
        tone === 'warn' && 'bg-amber-500/12 text-amber-500',
      )}
    >
      {children}
    </span>
  );
}

/** Shared page padding for every routed dashboard section. */
export function SectionBody({ children }: { children: ReactNode }) {
  return <div className="space-y-6">{children}</div>;
}
