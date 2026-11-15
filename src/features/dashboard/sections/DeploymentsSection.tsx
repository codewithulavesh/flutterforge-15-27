import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Globe2, Plus, Rocket, Search, SearchX } from 'lucide-react';
import type { Project } from '@/types';
import { timeAgo } from '@/utils/time';
import {
  EmptyState,
  Panel,
  SectionBody,
  SectionHeader,
  StatTile,
  StatusChip,
  primaryButtonClass,
  secondaryButtonClass,
} from './SectionShell';

function isDeployed(project: Project) {
  return project.status === 'deployed' || Boolean(project.deployment_url);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function DeploymentsSection({
  projects,
  loading,
  onNewProject,
}: {
  projects: Project[];
  loading: boolean;
  onNewProject: () => void;
}) {
  const [query, setQuery] = useState('');
  const deployed = useMemo(
    () =>
      projects
        .filter(isDeployed)
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()),
    [projects],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return deployed;
    return deployed.filter(
      (project) =>
        project.name.toLowerCase().includes(needle) ||
        project.description?.toLowerCase().includes(needle) ||
        project.deployment_url?.toLowerCase().includes(needle),
    );
  }, [deployed, query]);

  const withUrl = deployed.filter((project) => Boolean(project.deployment_url));
  const lastDeploy = deployed[0]?.updated_at;

  return (
    <SectionBody>
      <SectionHeader
        actions={
          <>
            <button className={secondaryButtonClass} onClick={onNewProject} type="button">
              <Plus size={14} />
              New app
            </button>
            <Link className={primaryButtonClass} to="/dashboard">
              <Rocket size={14} />
              All projects
            </Link>
          </>
        }
        description="Every app with a live URL. Open the workspace to ship changes, or visit the production build."
        eyebrow="Workspace"
        title="Deployments"
      />

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile accent="lime" hint="live" label="Deployed apps" value={deployed.length} />
        <StatTile hint="with a URL" label="Public links" value={withUrl.length} />
        <StatTile
          className="col-span-2 sm:col-span-1"
          hint={lastDeploy ? timeAgo(lastDeploy) : undefined}
          label="Last deploy"
          value={deployed[0] ? <span className="text-[24px] sm:text-[28px]">{deployed[0].name}</span> : '—'}
        />
      </dl>

      <Panel
        actions={
          <div className="relative w-full sm:w-64">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--fb-dim)]"
              size={14}
            />
            <input
              aria-label="Search deployments"
              className="h-9 w-full rounded-full border border-[var(--fb-line)] bg-[var(--fb-bg)] pl-9 pr-3 text-[12px] outline-none transition-colors placeholder:text-[var(--fb-dim)] focus:border-[var(--fb-ink)]"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search deployments…"
              type="search"
              value={query}
            />
          </div>
        }
        description="Apps appear here after you publish them from the workspace Export tab."
        title="Live apps"
      >
        {loading ? (
          <div aria-busy="true" aria-label="Loading deployments" className="divide-y divide-[var(--fb-line)]">
            {Array.from({ length: 4 }).map((_, index) => (
              <div className="flex items-center gap-3 px-4 py-4 sm:px-5" key={index}>
                <div className="h-10 w-10 animate-pulse rounded-xl bg-[var(--fb-soft)]" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-40 animate-pulse rounded-full bg-[var(--fb-soft)]" />
                  <div className="h-2 w-64 max-w-full animate-pulse rounded-full bg-[var(--fb-soft)]" />
                </div>
              </div>
            ))}
          </div>
        ) : deployed.length === 0 ? (
          <EmptyState
            action={
              <>
                <button className={primaryButtonClass} onClick={onNewProject} type="button">
                  <Plus size={14} />
                  Create an app
                </button>
                <Link className={secondaryButtonClass} to="/dashboard">
                  Browse projects
                </Link>
              </>
            }
            description="Publish a project from its workspace and it will appear here with its live URL."
            icon={<Rocket size={24} />}
            title="Nothing shipped yet"
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            action={
              <button className={secondaryButtonClass} onClick={() => setQuery('')} type="button">
                Clear search
              </button>
            }
            description={`Nothing matches “${query.trim()}”. Try another keyword.`}
            icon={<SearchX size={24} />}
            title="No matches"
          />
        ) : (
          <>
            <ul className="divide-y divide-[var(--fb-line)]">
              {filtered.map((project) => (
                <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:px-5" key={project.id}>
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[var(--fb-line)] bg-[var(--fb-soft)] font-mono text-[11px] font-semibold text-[var(--fb-muted)]">
                    {project.name.slice(0, 2).toUpperCase()}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        className="truncate text-[13.5px] font-semibold text-[var(--fb-ink)] hover:underline"
                        to={`/project/${project.id}`}
                      >
                        {project.name}
                      </Link>
                      <StatusChip tone="live">
                        <span aria-hidden className="h-1 w-1 rounded-full bg-emerald-500" />
                        Live
                      </StatusChip>
                      <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--fb-dim)]">
                        {project.platform} · updated {timeAgo(project.updated_at)}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-1 text-[11.5px] text-[var(--fb-muted)]">
                      {project.description || 'No brief saved for this project.'}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2 sm:ml-4">
                    {project.deployment_url ? (
                      <a
                        className="inline-flex h-9 max-w-[220px] items-center gap-1.5 rounded-full border border-[var(--fb-line)] px-3 font-mono text-[10.5px] text-[var(--fb-muted)] transition-colors hover:border-[var(--fb-ink)] hover:text-[var(--fb-ink)]"
                        href={project.deployment_url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <Globe2 aria-hidden size={13} />
                        <span className="truncate">{hostOf(project.deployment_url)}</span>
                        <ArrowUpRight aria-hidden size={12} />
                      </a>
                    ) : (
                      <StatusChip tone="warn">Missing URL</StatusChip>
                    )}
                    <Link
                      className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--fb-ink)] px-3.5 text-[11.5px] font-semibold text-[var(--fb-bg)] transition-transform hover:-translate-y-px"
                      to={`/project/${project.id}`}
                    >
                      Open
                      <ArrowUpRight aria-hidden size={12} />
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
            <p className="border-t border-[var(--fb-line)] px-4 py-2.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--fb-dim)] sm:px-5">
              {filtered.length} of {deployed.length} deployment{deployed.length === 1 ? '' : 's'}
            </p>
          </>
        )}
      </Panel>
    </SectionBody>
  );
}
