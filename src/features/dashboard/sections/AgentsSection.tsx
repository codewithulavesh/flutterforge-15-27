import { useEffect, useId, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Loader2,
  Palette,
  Plus,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useProjectStore } from '@/stores/project.store';
import {
  usePlatformStore,
  type CorpsFinding,
  type CorpsSeverity,
} from '@/stores/platform.store';
import { cn } from '@/utils/cn';
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

const EXAMPLES = [
  {
    label: 'Personal finance',
    prompt:
      'Build a personal finance app with category budgets, a monthly spending chart, and recurring bills.',
  },
  {
    label: 'Recipe planner',
    prompt: 'Create a recipe planner with a weekly meal calendar, grocery list, and dietary filters.',
  },
  {
    label: 'Fitness tracker',
    prompt: 'Design a fitness habit tracker with weekly progress, workout cards, and streaks.',
  },
];

const STEPS = [
  {
    title: 'Describe',
    body: 'Explain the screens, data and behavior you want. The agent turns your brief into a Flutter project.',
  },
  {
    title: 'Build',
    body: 'It writes the Dart files, runs the analyzer and opens a local preview as soon as the build passes.',
  },
  {
    title: 'Review',
    body: 'Twenty deterministic specialists audit the result — product, design, engineering, quality, delivery.',
  },
];

const PROMPT_GROUPS: Array<{
  id: string;
  label: string;
  icon: LucideIcon;
  description: string;
  prompts: string[];
}> = [
  {
    id: 'update',
    label: 'Update',
    icon: RefreshCw,
    description: 'Rename, reorder and rewrite what is already there.',
    prompts: [
      'Rename the app to "Orbit" everywhere — app title, splash text, settings and empty states.',
      'Reorganize the features section into a 2x3 grid of cards instead of a vertical list.',
      'Find every screen that says "2025" and update it to 2026.',
    ],
  },
  {
    id: 'restyle',
    label: 'Restyle',
    icon: Palette,
    description: 'Change colors, typography and components through the project theme.',
    prompts: [
      'Switch the whole app to dark mode with dark surfaces, light text and updated component colors.',
      'Update the app typography: Fraunces for headings and Inter for body text.',
      'Make every primary button fully rounded, filled with the brand color and white text.',
    ],
  },
  {
    id: 'add',
    label: 'Add',
    icon: Plus,
    description: 'New screens and flows with validation, loading and empty states.',
    prompts: [
      'Add a contact form screen with name, email and message fields, validation and a success state.',
      'Add an FAQ screen with six expandable questions read from a local JSON file.',
      'Add a settings screen with a theme switch, notification toggles and a sign-out confirmation.',
    ],
  },
  {
    id: 'fix',
    label: 'Fix',
    icon: Wrench,
    description: 'Repair analyzer errors and preview build failures.',
    prompts: [
      'Fix the analyzer error in home_screen.dart and rerun the preview build.',
      'The weekly chart overflows on small screens — make it responsive without losing the labels.',
      'The login form submits twice. Prevent duplicate submissions and show a loading state.',
    ],
  },
  {
    id: 'ship',
    label: 'Ship',
    icon: Rocket,
    description: 'Prepare exports, desktop runners and release notes.',
    prompts: [
      'Prepare macOS and Windows runner folders and add a README with build and signing steps.',
      'Add release notes for version 1.0.0 and update the app version in pubspec.yaml.',
    ],
  },
];

const SEVERITY_ORDER: Record<CorpsSeverity, number> = { blocker: 0, major: 1, minor: 2, info: 3 };

const SEVERITY_STYLES: Record<CorpsSeverity, string> = {
  blocker: 'bg-rose-500/12 text-rose-500',
  major: 'bg-amber-500/12 text-amber-600',
  minor: 'bg-sky-500/12 text-sky-500',
  info: 'bg-[var(--fb-soft)] text-[var(--fb-dim)]',
};

function verdictTone(verdict: 'pass' | 'warn' | 'fail'): 'live' | 'warn' | 'danger' {
  return verdict === 'pass' ? 'live' : verdict === 'warn' ? 'warn' : 'danger';
}

function SeverityChip({ severity }: { severity: CorpsSeverity }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.1em]',
        SEVERITY_STYLES[severity],
      )}
    >
      {severity}
    </span>
  );
}

function FindingRow({ finding }: { finding: CorpsFinding & { agent: string } }) {
  return (
    <li className="flex gap-3 px-4 py-3 sm:px-5">
      <SeverityChip severity={finding.severity} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-mono text-[10px] font-semibold text-[var(--fb-ink)]">{finding.code}</span>
          <span className="text-[10px] text-[var(--fb-dim)]">{finding.agent}</span>
          {finding.file && (
            <span className="truncate font-mono text-[9.5px] text-[var(--fb-dim)]">
              {finding.file}
              {finding.line ? `:${finding.line}` : ''}
            </span>
          )}
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--fb-muted)]">{finding.message}</p>
        {finding.suggestion && (
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--fb-dim)]">{finding.suggestion}</p>
        )}
      </div>
    </li>
  );
}

export function AgentsSection({ onNewProject }: { onNewProject: (prompt: string) => void }) {
  const [brief, setBrief] = useState('');
  const [activeGroupId, setActiveGroupId] = useState(PROMPT_GROUPS[0].id);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const textareaId = useId();
  const selectId = useId();
  const activeGroup = PROMPT_GROUPS.find((group) => group.id === activeGroupId) ?? PROMPT_GROUPS[0];

  const projects = useProjectStore((state) => state.projects);
  const {
    corpsRoster,
    rosterLoaded,
    fetchCorpsRoster,
    scorecard,
    reviewing,
    reviewError,
    reviewProject,
    clearReview,
  } = usePlatformStore();

  useEffect(() => {
    if (!rosterLoaded) void fetchCorpsRoster();
  }, [fetchCorpsRoster, rosterLoaded]);

  const projectId = selectedProjectId || projects[0]?.id || '';
  const agentCount = corpsRoster.reduce((sum, group) => sum + group.agents.length, 0);

  const findings = useMemo(() => {
    if (!scorecard) return [];
    return scorecard.reports
      .flatMap((report) =>
        report.findings.map((finding) => ({ ...finding, agent: `${report.name} · ${report.title}` })),
      )
      .sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
          a.code.localeCompare(b.code) ||
          (a.file ?? '').localeCompare(b.file ?? ''),
      );
  }, [scorecard]);

  const start = (prompt: string) => {
    const text = prompt.trim();
    if (text) onNewProject(text);
  };

  const runReview = () => {
    if (!projectId || reviewing) return;
    void reviewProject(projectId);
  };

  return (
    <SectionBody>
      <SectionHeader
        description="Describe the app or the change. The agent writes real Flutter, repairs the build — then a board of twenty specialists reviews it before you ship."
        eyebrow="Workspace"
        title="Agents"
      />

      <Panel
        actions={
          <div className="flex items-center gap-2">
            {scorecard && <StatusChip tone={verdictTone(scorecard.verdict)}>{scorecard.verdict}</StatusChip>}
            <button
              className={secondaryButtonClass}
              disabled={!projectId || reviewing}
              onClick={runReview}
              type="button"
            >
              {reviewing ? <Loader2 className="animate-spin" size={14} /> : <ShieldCheck size={14} />}
              {reviewing ? 'Reviewing…' : scorecard ? 'Re-run review' : 'Run board review'}
            </button>
          </div>
        }
        description="A deterministic review of the project's current files. Same snapshot, same verdict — safe to gate a release on."
        title="Review board"
      >
        <div className="flex flex-col gap-3 border-b border-[var(--fb-line)] px-4 py-3.5 sm:flex-row sm:items-end sm:justify-between sm:px-5">
          <div className="min-w-0 sm:max-w-xs">
            <label
              className="mb-1.5 block font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--fb-dim)]"
              htmlFor={selectId}
            >
              Project
            </label>
            <select
              className="h-10 w-full rounded-xl border border-[var(--fb-line)] bg-[var(--fb-bg)] px-3 text-[12.5px] text-[var(--fb-ink)] outline-none transition-colors focus:border-[var(--fb-ink)]"
              id={selectId}
              onChange={(event) => {
                setSelectedProjectId(event.target.value);
                clearReview();
              }}
              value={projectId}
            >
              {projects.length === 0 && <option value="">No projects yet</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <p className="text-[11px] leading-relaxed text-[var(--fb-dim)] sm:max-w-sm sm:text-right">
            {projects.length === 0
              ? 'Create or generate a project first — the board reviews real workspace files.'
              : 'The board reads lib/, test/, pubspec.yaml, platforms and docs, then scores every department.'}
          </p>
        </div>

        {reviewError && (
          <p className="flex items-start gap-2 border-b border-[var(--fb-line)] bg-rose-500/5 px-4 py-3 text-[11.5px] leading-relaxed text-rose-500 sm:px-5">
            <AlertTriangle className="mt-0.5 shrink-0" size={13} />
            {reviewError}
          </p>
        )}

        {!scorecard && !reviewing && (
          <EmptyState
            description={
              projectId
                ? 'Run the board to get an overall score, per-department grades and a findings list you can act on.'
                : 'Generate a project, then run the board to see how it scores before anyone ships it.'
            }
            icon={<ShieldCheck size={22} />}
            title="No review yet"
          />
        )}

        {reviewing && !scorecard && (
          <div className="flex items-center gap-3 px-4 py-10 text-[12px] text-[var(--fb-muted)] sm:px-5">
            <Loader2 className="animate-spin text-[var(--fb-dim)]" size={15} />
            Twenty specialists are reading the project…
          </div>
        )}

        {scorecard && (
          <>
            <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-4">
              <StatTile
                accent={scorecard.verdict === 'pass' ? 'lime' : 'plain'}
                hint="/100"
                label="Overall score"
                value={scorecard.overallScore}
              />
              <StatTile hint="agents" label="Blockers" value={scorecard.stats.blockers} />
              <StatTile hint="agents" label="Majors" value={scorecard.stats.majors} />
              <StatTile
                hint={`${scorecard.stats.findings} findings`}
                label="Files reviewed"
                value={scorecard.stats.filesReviewed}
              />
            </div>

            <div className="grid gap-3 border-t border-[var(--fb-line)] p-4 sm:p-5 md:grid-cols-2 xl:grid-cols-3">
              {scorecard.departments.map((department) => (
                <div
                  className="rounded-[18px] border border-[var(--fb-line)] bg-[var(--fb-bg)] p-3.5"
                  key={department.department}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-semibold text-[var(--fb-ink)]">{department.label}</span>
                    <span className="font-mono text-[10px] tabular-nums text-[var(--fb-muted)]">
                      {department.score}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--fb-soft)]">
                    <div
                      className={cn(
                        'h-full rounded-full transition-[width] duration-500',
                        department.status === 'pass' && 'bg-emerald-500',
                        department.status === 'warn' && 'bg-amber-500',
                        department.status === 'fail' && 'bg-rose-500',
                      )}
                      style={{ width: `${Math.max(2, Math.min(100, department.score))}%` }}
                    />
                  </div>
                  <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--fb-dim)]">
                    {department.agentIds.length} agents · weight {department.weight}
                  </p>
                </div>
              ))}
            </div>

            <div className="border-t border-[var(--fb-line)]">
              {findings.length === 0 ? (
                <p className="flex items-center gap-2 px-4 py-5 text-[11.5px] text-[var(--fb-muted)] sm:px-5">
                  <CheckCircle2 className="text-emerald-500" size={14} />
                  No findings. Every department passed on this snapshot.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--fb-line)]">
                  {findings.slice(0, 12).map((finding, index) => (
                    <FindingRow finding={finding} key={`${finding.code}-${finding.file ?? ''}-${index}`} />
                  ))}
                </ul>
              )}
              {findings.length > 12 && (
                <p className="border-t border-[var(--fb-line)] px-4 py-2.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-[var(--fb-dim)] sm:px-5">
                  +{findings.length - 12} more findings · fix the top blockers first
                </p>
              )}
            </div>
          </>
        )}
      </Panel>

      <Panel
        actions={<StatusChip tone="neutral">{agentCount || 20} specialists</StatusChip>}
        description="Six departments, one weighted scorecard. Every agent is deterministic and runs without tokens."
        title="The board"
      >
        {!rosterLoaded && (
          <div className="flex items-center gap-3 px-4 py-8 text-[12px] text-[var(--fb-muted)] sm:px-5">
            <Loader2 className="animate-spin" size={14} />
            Loading the roster…
          </div>
        )}
        {rosterLoaded && corpsRoster.length === 0 && (
          <p className="px-4 py-6 text-[11.5px] text-[var(--fb-muted)] sm:px-5">
            Roster unavailable. The engine may still be starting — refresh in a moment.
          </p>
        )}
        {corpsRoster.length > 0 && (
          <div className="grid gap-px bg-[var(--fb-line)] sm:grid-cols-2 xl:grid-cols-3">
            {corpsRoster.map((group) => (
              <div className="bg-[var(--fb-card)] p-4 sm:p-5" key={group.department}>
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-[12.5px] font-semibold text-[var(--fb-ink)]">{group.label}</h3>
                  <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--fb-dim)]">
                    {group.weight}%
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--fb-dim)]">{group.remit}</p>
                <ul className="mt-3 space-y-2">
                  {group.agents.map((agent) => (
                    <li className="flex gap-2.5" key={agent.id}>
                      <span className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--fb-soft)] font-mono text-[9px] font-semibold text-[var(--fb-ink)]">
                        {agent.name.slice(0, 1)}
                      </span>
                      <div className="min-w-0">
                        <p className="text-[11.5px] font-medium leading-tight text-[var(--fb-ink)]">
                          {agent.name}
                          <span className="ml-1.5 text-[10px] font-normal text-[var(--fb-dim)]">{agent.title}</span>
                        </p>
                        <p className="mt-0.5 text-[10.5px] leading-relaxed text-[var(--fb-muted)]">
                          {agent.description}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        description="Describe a screen, a tool, or the app you keep wishing existed."
        title="Start with an idea"
      >
        <form
          className="p-4 sm:p-5"
          onSubmit={(event) => {
            event.preventDefault();
            start(brief);
          }}
        >
          <label className="sr-only" htmlFor={textareaId}>
            Describe the app you want to build
          </label>
          <textarea
            className="min-h-[118px] w-full resize-y rounded-2xl border border-[var(--fb-line)] bg-[var(--fb-bg)] p-4 text-[13.5px] leading-relaxed text-[var(--fb-ink)] outline-none transition-colors placeholder:text-[var(--fb-dim)] focus:border-[var(--fb-ink)]"
            id={textareaId}
            maxLength={2000}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="A habit tracker with weekly goals, streaks and a simple stats screen…"
            value={brief}
          />

          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--fb-dim)]">
                Try
              </span>
              {EXAMPLES.map((example) => (
                <button
                  className="rounded-full border border-[var(--fb-line)] px-2.5 py-1 text-[10.5px] font-medium text-[var(--fb-muted)] transition-colors hover:border-[var(--fb-ink)] hover:text-[var(--fb-ink)]"
                  key={example.label}
                  onClick={() => setBrief(example.prompt)}
                  type="button"
                >
                  {example.label}
                </button>
              ))}
            </div>

            <div className="flex shrink-0 items-center justify-end gap-3">
              <span className="font-mono text-[9.5px] tabular-nums text-[var(--fb-dim)]">
                {brief.length}/2000
              </span>
              <button className={primaryButtonClass} disabled={!brief.trim()} type="submit">
                <Sparkles size={14} />
                Build this app
                <ArrowRight size={13} />
              </button>
            </div>
          </div>
        </form>
      </Panel>

      <dl className="grid gap-3 sm:grid-cols-3">
        {STEPS.map((step, index) => (
          <div
            className="rounded-[22px] border border-[var(--fb-line)] bg-[var(--fb-card)] p-4 sm:p-5"
            key={step.title}
          >
            <dt className="flex items-center gap-2">
              <span className="font-mono text-[9px] font-semibold tracking-[0.12em] text-[var(--fb-dim)]">
                0{index + 1}
              </span>
              <span className="text-[13px] font-semibold text-[var(--fb-ink)]">{step.title}</span>
            </dt>
            <dd className="mt-2 text-[11.5px] leading-relaxed text-[var(--fb-muted)]">{step.body}</dd>
          </div>
        ))}
      </dl>

      <Panel
        actions={<StatusChip tone="neutral">{PROMPT_GROUPS.length} agent skills</StatusChip>}
        description="Pick a starting point. The brief opens in the wizard so you can edit it before building."
        title="Prompt library"
      >
        <div className="border-b border-[var(--fb-line)] px-3 py-2">
          <div
            aria-label="Prompt categories"
            className="flex flex-wrap gap-1"
            role="tablist"
          >
            {PROMPT_GROUPS.map((group) => {
              const Icon = group.icon;
              const selected = group.id === activeGroup.id;
              return (
                <button
                  aria-controls={`agent-panel-${group.id}`}
                  aria-selected={selected}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium transition-colors',
                    selected
                      ? 'bg-[var(--fb-ink)] text-[var(--fb-bg)]'
                      : 'text-[var(--fb-muted)] hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)]',
                  )}
                  id={`agent-tab-${group.id}`}
                  key={group.id}
                  onClick={() => setActiveGroupId(group.id)}
                  role="tab"
                  type="button"
                >
                  <Icon aria-hidden size={13} />
                  {group.label}
                </button>
              );
            })}
          </div>
        </div>

        <div
          aria-labelledby={`agent-tab-${activeGroup.id}`}
          id={`agent-panel-${activeGroup.id}`}
          role="tabpanel"
        >
          <p className="px-4 pt-4 text-[11.5px] leading-relaxed text-[var(--fb-muted)] sm:px-5">
            {activeGroup.description}
          </p>
          <ul className="mt-1 divide-y divide-[var(--fb-line)]">
            {activeGroup.prompts.map((prompt) => (
              <li key={prompt}>
                <button
                  className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--fb-soft)] sm:px-5"
                  onClick={() => start(prompt)}
                  type="button"
                >
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-[var(--fb-line)] bg-[var(--fb-bg)] text-[var(--fb-dim)] transition-colors group-hover:border-[var(--fb-ink)] group-hover:text-[var(--fb-ink)]">
                    <ArrowUpRight size={13} />
                  </span>
                  <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-[var(--fb-muted)] transition-colors group-hover:text-[var(--fb-ink)]">
                    {prompt}
                  </span>
                  <span className="hidden shrink-0 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--fb-dim)] sm:block">
                    Use prompt
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </Panel>

      <p className="text-[11px] leading-relaxed text-[var(--fb-dim)]">
        Generation and repair run on your configured model keys. The review board is deterministic and free — it
        never publishes a project, and no agent can clear a blocker without changing the code. Supabase is added
        automatically when the brief needs accounts, shared data or realtime.
      </p>
    </SectionBody>
  );
}
