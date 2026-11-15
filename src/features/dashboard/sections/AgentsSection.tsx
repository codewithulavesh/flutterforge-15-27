import { useId, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Palette,
  Plus,
  RefreshCw,
  Rocket,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { Panel, SectionBody, SectionHeader, StatusChip, primaryButtonClass } from './SectionShell';

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
    title: 'Refine',
    body: 'Ask for changes in plain language. Failed compiles feed diagnostics back for automatic repair.',
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

export function AgentsSection({ onNewProject }: { onNewProject: (prompt: string) => void }) {
  const [brief, setBrief] = useState('');
  const [activeGroupId, setActiveGroupId] = useState(PROMPT_GROUPS[0].id);
  const textareaId = useId();
  const activeGroup = PROMPT_GROUPS.find((group) => group.id === activeGroupId) ?? PROMPT_GROUPS[0];

  const start = (prompt: string) => {
    const text = prompt.trim();
    if (text) onNewProject(text);
  };

  return (
    <SectionBody>
      <SectionHeader
        description="Describe the app or the change. The agent writes real Flutter, repairs the build and keeps the preview running."
        eyebrow="Workspace"
        title="Agents"
      />

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
        Agents run on your configured model keys and never publish a project without you. Supabase is added
        automatically when the brief needs accounts, shared data or realtime.
      </p>
    </SectionBody>
  );
}
