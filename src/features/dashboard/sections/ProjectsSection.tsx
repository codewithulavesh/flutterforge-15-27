import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FolderOpen, Search, SearchX, Sparkles, X } from 'lucide-react';
import { ProjectCard } from '../ProjectCard';
import { CreateProjectCard } from '../CreateProjectCard';
import { Skeleton } from '@/components/ui/Skeleton';
import type { Project } from '@/types';

type SortBy = 'updated' | 'created' | 'name';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const SORT_LABELS: Record<SortBy, string> = {
  updated: 'Last updated',
  created: 'Newest first',
  name: 'Name A–Z',
};

function parseSort(value: string | null): SortBy {
  return value === 'created' || value === 'name' ? value : 'updated';
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function ProjectSkeletons() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading projects"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4"
    >
      {Array.from({ length: 8 }).map((_, index) => {
        const delay = `${index * 80}ms`;
        return (
          <div
            aria-hidden
            className="flex flex-col overflow-hidden rounded-[20px] border border-[var(--fb-line)] bg-[var(--fb-card)] shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_12px_32px_-16px_rgba(0,0,0,0.6)]"
            key={index}
          >
            <div className="relative h-24 shrink-0 overflow-hidden border-b border-[var(--fb-line)] bg-[var(--fb-soft)]/60">
              <Skeleton rounded="md" className="absolute left-4 top-4 h-10 w-10" style={{ animationDelay: delay }} />
              <Skeleton rounded="sm" className="absolute bottom-3 left-4 h-2.5 w-24" style={{ animationDelay: delay }} />
              <Skeleton rounded="md" className="absolute right-3 top-3 h-8 w-8" style={{ animationDelay: delay }} />
            </div>
            <div className="flex flex-1 flex-col gap-2.5 p-5">
              <Skeleton rounded="full" className="h-3.5 w-2/3" style={{ animationDelay: delay }} />
              <Skeleton rounded="full" className="h-2 w-28" style={{ animationDelay: delay }} />
              <div className="mt-0.5 flex flex-col gap-2">
                <Skeleton rounded="full" className="h-2 w-full" style={{ animationDelay: delay }} />
                <Skeleton rounded="full" className="h-2 w-4/5" style={{ animationDelay: delay }} />
              </div>
              <div className="mt-auto flex items-center justify-between gap-3 border-t border-[var(--fb-line)] pt-4">
                <Skeleton rounded="full" className="h-2 w-28" style={{ animationDelay: delay }} />
                <Skeleton rounded="md" className="h-8 w-8" style={{ animationDelay: delay }} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ProjectsSection({
  projects,
  loading,
  firstName,
  onNewProject,
}: {
  projects: Project[];
  loading: boolean;
  firstName?: string;
  onNewProject: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const sortBy = parseSort(params.get('sort'));
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLDivElement>(null);

  // "/" focuses search, like most dev tools (ignored while typing in a field).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      searchRef.current?.querySelector('input')?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [...projects]
      .filter(
        (project) =>
          !query ||
          project.name.toLowerCase().includes(query) ||
          project.description?.toLowerCase().includes(query),
      )
      .sort((a, b) => {
        if (sortBy === 'name') return a.name.localeCompare(b.name);
        if (sortBy === 'created') return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });
  }, [projects, search, sortBy]);

  const stats = useMemo(() => {
    const now = Date.now();
    const active = projects.filter((project) => now - new Date(project.updated_at).getTime() < WEEK_MS).length;
    const latest = [...projects].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    )[0];
    return { total: projects.length, active, latest: latest?.name ?? '—' };
  }, [projects]);

  const hasProjects = projects.length > 0;
  const searching = search.trim().length > 0;

  const changeSort = (next: SortBy) => {
    const nextParams = new URLSearchParams(params);
    if (next === 'updated') nextParams.delete('sort');
    else nextParams.set('sort', next);
    setParams(nextParams, { replace: true });
  };

  return (
    <div>
      {/* ── Welcome ────────────────────────────────────────────────── */}
      <section className="min-w-0">
        <p className="inline-flex items-center gap-2.5 rounded-full border border-[var(--fb-line)] bg-white/80 backdrop-blur-sm px-4 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--fb-ink)] shadow-sm">
          <span className="size-2 rounded-full bg-[var(--fb-lime)] ring-2 ring-[var(--fb-ink)]/20" />
          {greeting()}
          {firstName ? `, ${firstName}` : ''}
        </p>
        <h1 className="ffb-display ffb-caps mt-4 break-words text-[clamp(40px,7vw,88px)] leading-[0.84] tracking-[-0.04em]">
          Your workbench
        </h1>
        <p className="mt-3 max-w-xl text-[14.5px] leading-relaxed text-[var(--fb-muted)]">
          Every app you have briefed, generated and previewed — source, builds and live preview in one place.
        </p>
      </section>

      {/* ── Stats ──────────────────────────────────────────────────── */}
      {hasProjects && !loading && (
        <dl className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="flex flex-col justify-between rounded-[24px] border border-[var(--fb-line)] bg-[var(--fb-card)] p-4 sm:p-5">
            <dt className="flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--fb-lime)]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--fb-lime)] ring-2 ring-[var(--fb-lime)]/30" />
              Projects
            </dt>
            <dd className="mt-6 flex items-end gap-2">
              <span className="ffb-display text-[46px] leading-none text-[var(--fb-lime)] sm:text-[54px]">{stats.total}</span>
              <span className="mb-1.5 text-[10px] font-medium text-[var(--fb-muted)]">total</span>
            </dd>
          </div>

          <div className="flex flex-col justify-between rounded-[24px] border border-[var(--fb-line)] bg-[var(--fb-card)] p-4 sm:p-5">
            <dt className="flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--fb-muted)]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--fb-lime)]" />
              Active · 7d
            </dt>
            <dd className="mt-6 flex items-end gap-2">
              <span className="ffb-display text-[46px] leading-none text-[var(--fb-ink)] sm:text-[54px]">
                {stats.active}
              </span>
              <span className="mb-1.5 text-[10px] font-medium text-[var(--fb-muted)]">this week</span>
            </dd>
          </div>

          <div className="col-span-2 flex min-w-0 flex-col justify-between rounded-[24px] border border-[var(--fb-line)] bg-[var(--fb-card)] p-4 sm:col-span-1 sm:p-5">
            <dt className="flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--fb-muted)]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--fb-cyan)]" />
              Latest
            </dt>
            <dd className="mt-4 min-w-0">
              <span
                className="ffb-display block truncate text-[20px] leading-tight text-[var(--fb-ink)]"
                title={stats.latest}
              >
                {stats.latest}
              </span>
              <span className="mt-1 block font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--fb-dim)]">
                Most recent update
              </span>
            </dd>
          </div>
        </dl>
      )}

      {/* ── Search + sort ──────────────────────────────────────────── */}
      <div
        className="mt-6 flex scroll-mt-6 flex-col gap-2 rounded-[28px] border border-[rgba(0,16,30,0.12)] bg-white/70 backdrop-blur-md p-2 transition-all focus-within:border-[var(--fb-ink)] focus-within:bg-white focus-within:shadow-[0_8px_30px_rgba(0,16,30,0.08)] sm:flex-row sm:items-center"
        ref={searchRef}
      >
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--fb-ink)]/60"
            size={16}
          />
          <input
            aria-label="Search projects"
            className="h-11 w-full rounded-full bg-transparent pl-11 pr-12 text-[14px] text-[var(--fb-ink)] outline-none placeholder:text-[var(--fb-ink)]/40 font-medium"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setSearch('');
            }}
            placeholder="Search projects…"
            type="text"
            value={search}
          />
          {searching ? (
            <button
              aria-label="Clear search"
              className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-[var(--fb-ink)]/60 transition-colors hover:bg-[var(--fb-ink)]/10 hover:text-[var(--fb-ink)]"
              onClick={() => setSearch('')}
              type="button"
            >
              <X size={14} />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded border border-[var(--fb-line)] bg-black/5 px-2 py-0.5 font-mono text-[9px] font-bold text-[var(--fb-ink)]/60 sm:block">
              /
            </kbd>
          )}
        </div>

        <div className="flex items-center gap-2 sm:border-l sm:border-[var(--fb-line)] sm:pl-3">
          <label className="sr-only" htmlFor="project-sort">
            Sort projects
          </label>
          <select
            className="h-10 w-full min-w-0 rounded-full border border-[var(--fb-line)] bg-white/80 px-4 text-[11.5px] font-bold text-[var(--fb-ink)] uppercase tracking-wider outline-none transition-colors focus-visible:border-[var(--fb-ink)] sm:w-auto"
            id="project-sort"
            onChange={(event) => changeSort(event.target.value as SortBy)}
            value={sortBy}
          >
            <option value="updated">Last updated</option>
            <option value="created">Newest first</option>
            <option value="name">Name (A-Z)</option>
          </select>
        </div>
      </div>

      {/* ── Result count ───────────────────────────────────────────── */}
      {!loading && hasProjects && (
        <div className="mb-3 mt-4 flex items-baseline justify-between gap-3">
          <p aria-live="polite" className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--fb-muted)]">
            {searching
              ? `${filtered.length} of ${projects.length} match “${search.trim()}”`
              : `${projects.length} project${projects.length === 1 ? '' : 's'}`}
          </p>
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--fb-dim)] sm:block">
            {SORT_LABELS[sortBy]}
          </span>
        </div>
      )}

      {/* ── Projects ───────────────────────────────────────────────── */}
      {loading ? (
        <ProjectSkeletons />
      ) : !hasProjects ? (
        <div className="mx-auto flex max-w-xl flex-col items-center justify-center rounded-[28px] border border-dashed border-[var(--fb-line)] bg-[var(--fb-card)] px-6 py-16 text-center">
          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-[18px] bg-[var(--fb-lime)] text-black">
            <FolderOpen size={26} />
          </div>
          <h2 className="ffb-display ffb-caps text-[34px] leading-[0.9]">Your first forge</h2>
          <p className="mt-3 max-w-sm text-[13px] leading-relaxed text-[var(--fb-muted)]">
            Describe an app and FlutterForge will write, compile and preview it for you.
          </p>
          <button
            className="mt-6 inline-flex h-11 items-center gap-2 rounded-full bg-[var(--fb-ink)] px-5 text-[12px] font-semibold text-[var(--fb-bg)] transition-transform hover:-translate-y-px"
            onClick={onNewProject}
            type="button"
          >
            <Sparkles size={15} />
            Create your first app
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="mx-auto flex max-w-xl flex-col items-center justify-center px-6 py-16 text-center">
          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-[18px] border border-[var(--fb-line)] bg-[var(--fb-soft)] text-[var(--fb-muted)]">
            <SearchX size={24} />
          </div>
          <h2 className="ffb-display ffb-caps text-[28px] leading-[0.9]">No matches</h2>
          <p className="mt-3 max-w-sm text-[13px] leading-relaxed text-[var(--fb-muted)]">
            Nothing matches “{search.trim()}”. Try another keyword.
          </p>
          <button
            className="mt-6 inline-flex h-11 items-center rounded-full border border-[var(--fb-line)] px-4 text-[11.5px] font-medium text-[var(--fb-muted)] transition-colors hover:border-[var(--fb-ink)] hover:text-[var(--fb-ink)]"
            onClick={() => setSearch('')}
            type="button"
          >
            Clear search
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
          {!searching && <CreateProjectCard onClick={onNewProject} />}
          {filtered.map((project, index) => (
            <ProjectCard index={index} key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}
