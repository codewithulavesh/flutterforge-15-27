import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { FolderOpen, Plus, Rocket, Search, SearchX, Sparkles, X } from 'lucide-react';
import { DashboardSidebar } from '@/features/dashboard/DashboardSidebar';
import { ProjectCard } from '@/features/dashboard/ProjectCard';
import { CreateProjectWizard } from '@/features/dashboard/CreateProjectWizard';
import { EditProfileModal } from '@/features/dashboard/EditProfileModal';
import { IntegrationsModal } from '@/features/dashboard/IntegrationsModal';
import { ShortcutsModal } from '@/features/dashboard/ShortcutsModal';
import { UsageModal } from '@/features/dashboard/UsageModal';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useProjectStore } from '@/stores/project.store';
import { useAuthStore } from '@/stores/auth.store';
import { HERO_PROMPT_KEY } from '@/utils/landing';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/utils/cn';

type SortBy = 'updated' | 'created' | 'name';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const SORT_LABELS: Record<SortBy, string> = {
  updated: 'Last updated',
  created: 'Newest first',
  name: 'Name A–Z',
};

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
            {/* Cover — mirrors the icon-tile cover of a real project card */}
            <div className="relative h-24 shrink-0 overflow-hidden border-b border-[var(--fb-line)] bg-[var(--fb-soft)]/60">
              <Skeleton
                rounded="md"
                className="absolute left-4 top-4 h-10 w-10"
                style={{ animationDelay: delay }}
              />
              <Skeleton
                rounded="sm"
                className="absolute bottom-3 left-4 h-2.5 w-24"
                style={{ animationDelay: delay }}
              />
              <Skeleton
                rounded="md"
                className="absolute right-3 top-3 h-8 w-8"
                style={{ animationDelay: delay }}
              />
            </div>

            {/* Body — name, status, brief, meta footer */}
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

export function DashboardPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { projects, loadProjects, loading } = useProjectStore();
  const { profile } = useAuthStore();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardDescription, setWizardDescription] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('updated');
  const [scope, setScope] = useState<'all' | 'deployed'>('all');
  const [profileOpen, setProfileOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const projectsTopRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Native menu / global command: open the creation wizard.
  useEffect(() => {
    const open = () => {
      setWizardDescription('');
      setWizardOpen(true);
    };
    window.addEventListener('ff:new-project', open);
    return () => window.removeEventListener('ff:new-project', open);
  }, []);

  // "/" focuses search, like most dev tools (ignored while typing in a field).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      event.preventDefault();
      searchRef.current?.querySelector('input')?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Prompt-first entry: a Hero prompt (via navigation state or sessionStorage
  // when it survived the signup hop) opens the wizard with it prefilled.
  useEffect(() => {
    const fromState = (location.state as { heroPrompt?: string } | null)?.heroPrompt?.trim();
    let fromStorage = '';
    try {
      fromStorage = (sessionStorage.getItem(HERO_PROMPT_KEY) || '').trim();
      sessionStorage.removeItem(HERO_PROMPT_KEY);
    } catch {
      // storage unavailable — state only
    }
    const heroPrompt = fromState || fromStorage;
    if (heroPrompt) {
      setWizardDescription(heroPrompt);
      setWizardOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deployedCount = useMemo(
    () => projects.filter((project) => project.status === 'deployed' || Boolean(project.deployment_url)).length,
    [projects],
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [...projects]
      .filter((p) => scope === 'all' || p.status === 'deployed' || Boolean(p.deployment_url))
      .filter((p) => !query
        || p.name.toLowerCase().includes(query)
        || p.description?.toLowerCase().includes(query))
      .sort((a, b) => {
        if (sortBy === 'name') return a.name.localeCompare(b.name);
        if (sortBy === 'created') return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });
  }, [projects, scope, search, sortBy]);

  const stats = useMemo(() => {
    const now = Date.now();
    const active = projects.filter((p) => now - new Date(p.updated_at).getTime() < WEEK_MS).length;
    const latest = [...projects].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    )[0];
    return { total: projects.length, active, latest: latest?.name ?? '—' };
  }, [projects]);

  const hasProjects = projects.length > 0;
  const searching = search.trim().length > 0;
  const firstName = profile?.full_name?.split(' ')[0];

  const openWizard = () => {
    setWizardDescription('');
    setWizardOpen(true);
  };

  const showProjects = (nextSort: SortBy) => {
    setSearch('');
    setScope('all');
    setSortBy(nextSort);
    window.setTimeout(() => {
      projectsTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  };

  const showDeployments = () => {
    setSearch('');
    setScope('deployed');
    setSortBy('updated');
    window.setTimeout(() => {
      projectsTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  };

  const openPricing = () => {
    navigate('/');
    window.setTimeout(() => {
      document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 320);
  };

  return (
    <div className="ff-bold min-h-[100dvh] bg-[var(--fb-bg)] sm:p-3 lg:p-4">
      <SidebarProvider collapsible="icon" storageKey="ff-dashboard-sidebar">
        <div className="ff-dash-shell mx-auto flex h-[100dvh] w-full max-w-[1500px] overflow-hidden border-[var(--fb-line)] bg-[var(--fb-bg)] sm:h-[calc(100dvh-1.5rem)] sm:rounded-2xl sm:border lg:h-[calc(100dvh-2rem)]">
          <DashboardSidebar
            onEditProfile={() => setProfileOpen(true)}
            onNewProject={openWizard}
            onOpenIntegrations={() => setIntegrationsOpen(true)}
            onOpenPricing={openPricing}
            onOpenShortcuts={() => setShortcutsOpen(true)}
            onOpenUsage={() => setUsageOpen(true)}
            onShowDeployments={showDeployments}
            onShowProjects={showProjects}
            projects={projects}
            scope={scope}
            searching={searching}
            sortBy={sortBy}
          />

          <div className="relative z-0 flex min-w-0 flex-1 flex-col">
            <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--fb-line)] px-3 sm:px-5">
              <SidebarTrigger />
              <span className="ml-1 hidden text-[13px] font-medium text-[var(--fb-muted)] sm:block">
                Dashboard
              </span>
              <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
                <ThemeToggle />
                <button
                  className="hidden h-9 items-center gap-1.5 rounded-full bg-[var(--fb-ink)] px-4 text-[12px] font-semibold text-[var(--fb-bg)] transition-transform hover:-translate-y-px sm:inline-flex"
                  onClick={openWizard}
                  type="button"
                >
                  <Plus size={14} />
                  New app
                </button>
              </div>
            </header>

            <main className="ff-scrollbar flex-1 overflow-y-auto">
              <div className="mx-auto max-w-[1200px] px-4 pb-28 pt-8 sm:px-8 sm:pb-16 sm:pt-10">
        {/* ── Welcome ────────────────────────────────────────────────── */}
        <section className="min-w-0">
          <div className="min-w-0">
            <p className="inline-flex items-center gap-2 rounded-full border border-[var(--fb-line)] bg-[var(--fb-card)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.15em] text-[var(--fb-muted)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--fb-magenta)]" />
              {greeting()}{firstName ? `, ${firstName}` : ''}
            </p>
            <h1 className="ffb-display ffb-caps mt-4 text-[clamp(40px,7vw,88px)] leading-[0.84] tracking-[-0.04em] break-words">
              Your workbench
            </h1>
            <p className="mt-3 max-w-xl text-[13.5px] leading-relaxed text-[var(--fb-muted)]">
              Every app you have briefed, generated and previewed — source, builds and live preview in one place.
            </p>
          </div>
        </section>

        {/* ── Stats ──────────────────────────────────────────────────── */}
        {hasProjects && !loading && (
          <dl className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="flex flex-col justify-between rounded-[24px] bg-[var(--fb-lime)] p-4 text-black sm:p-5">
              <dt className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-black/60">
                Projects
              </dt>
              <dd className="mt-6 flex items-end gap-2">
                <span className="ffb-display text-[46px] leading-none sm:text-[54px]">{stats.total}</span>
                <span className="mb-1.5 text-[10px] font-medium text-black/55">total</span>
              </dd>
            </div>

            <div className="flex flex-col justify-between rounded-[24px] border border-[var(--fb-line)] bg-[var(--fb-card)] p-4 sm:p-5">
              <dt className="flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--fb-muted)]">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--fb-magenta)]" />
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
          className="mt-6 flex scroll-mt-6 flex-col gap-2 rounded-[20px] border border-[var(--fb-line)] bg-[var(--fb-card)] p-2 transition-colors focus-within:border-[var(--fb-ink)] sm:flex-row sm:items-center"
          ref={projectsTopRef}
        >
          <div className="relative min-w-0 flex-1" ref={searchRef}>
            <Search
              aria-hidden
              size={15}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--fb-dim)]"
            />
            <input
              aria-label="Search projects"
              className="h-11 w-full rounded-full bg-transparent pl-10 pr-12 text-[13px] text-[var(--fb-ink)] outline-none placeholder:text-[var(--fb-dim)]"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearch('');
              }}
              placeholder="Search projects…"
              type="text"
              value={search}
            />
            {searching ? (
              <button
                aria-label="Clear search"
                className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-[var(--fb-dim)] transition-colors hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)]"
                onClick={() => setSearch('')}
                type="button"
              >
                <X size={14} />
              </button>
            ) : (
              <kbd className="pointer-events-none absolute right-3.5 top-1/2 hidden -translate-y-1/2 rounded border border-[var(--fb-line)] bg-[var(--fb-soft)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--fb-dim)] sm:block">
                /
              </kbd>
            )}
          </div>

          <div className="flex items-center gap-2 sm:border-l sm:border-[var(--fb-line)] sm:pl-2">
            <label className="sr-only" htmlFor="project-sort">Sort projects</label>
            <select
              id="project-sort"
              className="h-11 w-full min-w-0 rounded-full border border-[var(--fb-line)] bg-[var(--fb-soft)] px-3.5 text-[11.5px] font-medium text-[var(--fb-ink)] outline-none transition-colors focus-visible:border-[var(--fb-ink)] sm:w-auto"
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              value={sortBy}
            >
              <option value="updated">Last updated</option>
              <option value="created">Newest first</option>
              <option value="name">Name (A-Z)</option>
            </select>
          </div>
        </div>

        {/* ── Deployment filter ───────────────────────────────────────── */}
        {scope === 'deployed' && (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--fb-line)] bg-[var(--fb-card)] px-3 py-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--fb-soft)] text-[var(--fb-muted)]">
              <Rocket aria-hidden size={14} />
            </span>
            <span className="text-[12px] font-medium text-[var(--fb-ink)]">Showing deployed apps</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--fb-dim)]">
              {deployedCount} live
            </span>
            <button
              className="ml-auto rounded-lg px-2.5 py-1 text-[11.5px] font-medium text-[var(--fb-muted)] transition-colors hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)]"
              onClick={() => setScope('all')}
              type="button"
            >
              Show all projects
            </button>
          </div>
        )}

        {/* ── Result count ───────────────────────────────────────────── */}
        {!loading && hasProjects && (
          <div className="mb-3 mt-4 flex items-baseline justify-between gap-3">
            <p aria-live="polite" className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--fb-muted)]">
              {searching
                ? `${filtered.length} of ${projects.length} match “${search.trim()}”`
                : scope === 'deployed'
                  ? `${filtered.length} deployed app${filtered.length === 1 ? '' : 's'}`
                  : `${projects.length} project${projects.length === 1 ? '' : 's'}`}
            </p>
            <span className="hidden font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--fb-dim)] sm:block">
              {scope === 'deployed' ? 'Deployments' : SORT_LABELS[sortBy]}
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
              type="button"
              onClick={openWizard}
              className="mt-6 inline-flex h-11 items-center gap-2 rounded-full bg-[var(--fb-ink)] px-5 text-[12px] font-semibold text-[var(--fb-bg)] transition-transform hover:-translate-y-px"
            >
              <Sparkles size={15} />
              Create your first app
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="mx-auto flex max-w-xl flex-col items-center justify-center px-6 py-16 text-center">
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-[18px] border border-[var(--fb-line)] bg-[var(--fb-soft)] text-[var(--fb-muted)]">
              {scope === 'deployed' && !searching ? <Rocket size={24} /> : <SearchX size={24} />}
            </div>
            <h2 className="ffb-display ffb-caps text-[28px] leading-[0.9]">
              {scope === 'deployed' && !searching ? 'Nothing shipped yet' : 'No matches'}
            </h2>
            <p className="mt-3 max-w-sm text-[13px] leading-relaxed text-[var(--fb-muted)]">
              {scope === 'deployed' && !searching
                ? 'Publish a project from its workspace and it will appear here with its live URL.'
                : `Nothing matches “${search.trim()}”. Try another keyword.`}
            </p>
            <button
              type="button"
              onClick={() => {
                if (scope === 'deployed' && !searching) {
                  setScope('all');
                  return;
                }
                setSearch('');
              }}
              className="mt-6 inline-flex h-11 items-center rounded-full border border-[var(--fb-line)] px-4 text-[11.5px] font-medium text-[var(--fb-muted)] transition-colors hover:border-[var(--fb-ink)] hover:text-[var(--fb-ink)]"
            >
              {scope === 'deployed' && !searching ? 'Show all projects' : 'Clear search'}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((project, index) => (
              <ProjectCard key={project.id} project={project} index={index} />
            ))}
          </div>
        )}
              </div>
            </main>
          </div>
        </div>
      </SidebarProvider>

      {/* Mobile quick-create */}
      <button
        aria-label="New app"
        className={cn(
          'fixed right-4 z-30 flex h-12 items-center gap-2 rounded-full bg-[var(--fb-ink)] px-5 text-[12px] font-semibold text-[var(--fb-bg)] shadow-[0_18px_40px_-18px_rgba(0,0,0,0.55)] sm:hidden',
          'bottom-[max(1rem,env(safe-area-inset-bottom))]',
        )}
        onClick={openWizard}
        type="button"
      >
        <Plus size={17} /> New app
      </button>

      <CreateProjectWizard
        open={wizardOpen}
        initialDescription={wizardDescription}
        onClose={() => {
          setWizardOpen(false);
          setWizardDescription('');
        }}
      />

      <EditProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
      <UsageModal
        onClose={() => setUsageOpen(false)}
        onOpenPricing={openPricing}
        open={usageOpen}
      />
      <IntegrationsModal open={integrationsOpen} onClose={() => setIntegrationsOpen(false)} />
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
