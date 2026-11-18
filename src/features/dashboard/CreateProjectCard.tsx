import { ArrowUpRight, Plus } from 'lucide-react';

export function CreateProjectCard({ onClick }: { onClick: () => void }) {
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-[28px] border border-dashed border-[var(--fb-lime)]/40 bg-[var(--fb-card)] shadow-[0_20px_48px_-18px_rgba(0,16,30,0.4)] transition-all duration-200 focus-within:ring-2 focus-within:ring-[var(--fb-lime)] focus-within:ring-offset-2 focus-within:ring-offset-[var(--fb-bg)] hover:-translate-y-1 hover:border-solid hover:border-[var(--fb-lime)] hover:shadow-[0_24px_54px_-16px_rgba(0,16,30,0.5)]">
      {/* Cover */}
      <div
        className="relative h-24 shrink-0 overflow-hidden border-b border-dashed border-[var(--fb-line)]"
        style={{
          background: 'linear-gradient(135deg, rgba(197, 250, 117, 0.16) 0%, transparent 70%)',
        }}
      >
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background: 'radial-gradient(circle at 85% 15%, rgba(197, 250, 117, 0.24) 0%, transparent 55%)',
          }}
        />
        <span className="absolute left-4 top-4 flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--fb-lime)] text-[var(--fb-ink)] font-bold">
          <Plus size={18} />
        </span>
        <span className="absolute bottom-3 left-4 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--fb-lime)]">
          New project
        </span>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 flex-1 truncate ffb-display text-[15px] font-bold leading-tight tracking-[-0.02em] text-[var(--fb-ink)]">
            <button
              className="text-left outline-none after:absolute after:inset-0 after:rounded-[28px]"
              onClick={onClick}
              type="button"
            >
              Create new app
              <span className="sr-only"> — start a new project</span>
            </button>
          </h3>
        </div>

        <p className="mt-2 flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[var(--fb-muted)]">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--fb-lime)] ring-2 ring-[var(--fb-lime)]/30" />
          <span className="truncate">Start from a brief</span>
        </p>

        <p className="mt-3 line-clamp-2 min-h-[2.6em] text-[12.5px] leading-[1.7] text-[var(--fb-muted)]">
          Describe an app and FlutterForge will write, compile and preview it for you.
        </p>

        <div className="mt-auto flex items-center justify-between border-t border-[var(--fb-line)] pt-4">
          <span className="font-mono text-[10px] text-[var(--fb-dim)]">⌘N · New project</span>
          <span className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--fb-line)] text-[var(--fb-muted)] transition-colors group-hover:border-[var(--fb-lime)] group-hover:bg-[var(--fb-lime)] group-hover:text-[var(--fb-ink)]">
            <ArrowUpRight size={14} aria-hidden />
          </span>
        </div>
      </div>
    </article>
  );
}
