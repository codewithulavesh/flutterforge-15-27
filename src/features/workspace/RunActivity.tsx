import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  FileCode2Icon,
  Loader2Icon,
  SparklesIcon,
  XCircleIcon,
  TerminalSquareIcon,
  ListChecksIcon,
} from 'lucide-react';
import {
  useActivityStore,
  type CheckpointActivity,
  type ErrorActivity,
  type FileActivity,
  type PhaseActivity,
  type ReasoningActivity,
  type TerminalActivity,
  type ToolActivity,
} from '@/stores/activity.store';
import {
  TestResults,
  TestResultsHeader,
  TestResultsProgress,
  TestResultsSummary,
} from '@/components/ai-elements/test-results';
import { Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources';
import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationSource,
  InlineCitationText,
} from '@/components/ai-elements/inline-citation';
import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemDescription,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from '@/components/ai-elements/queue';
import {
  StackTrace,
  StackTraceActions,
  StackTraceContent,
  StackTraceCopyButton,
  StackTraceError,
  StackTraceErrorMessage,
  StackTraceErrorType,
  StackTraceExpandButton,
  StackTraceHeader,
} from '@/components/ai-elements/stack-trace';
import {
  Plan,
  PlanAction,
  PlanContent,
  PlanDescription,
  PlanHeader,
  PlanTitle,
  PlanTrigger,
} from '@/components/ai-elements/plan';
import { Message, MessageContent } from '@/components/ai-elements/message';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { cn } from '@/utils/cn';

// Map pipeline phase IDs → human-friendly labels
const PHASE_LABELS: Record<string, string> = {
  intake: 'Product Intake — understanding your app',
  'ux-research': 'UX Research — designing screen flows',
  'design-system': 'Design System — Material 3 theme',
  architecture: 'Architecture — packages & project structure',
  'data-model': 'Database Schema — Supabase tables & RLS',
  'feature-planner': 'Feature Planning — build roadmap',
  'data-models': 'Dart Model Classes — fromJson / toJson',
  'code-gen': 'Core Code & Providers — state notifiers',
  'frontend-builder': 'Professional Screens — real UI code',
  'backend-api': 'Backend & API — CRUD services',
  integration: 'Integration & Routing — GoRouter + NavigationBar',
  'qa-validation': 'QA Validation — structural gates',
  repair: 'Auto-Repair — fixing issues',
  edit: 'Targeted fix — applying your change',
  ready: 'App Ready!',
};

const PHASE_EMOJI: Record<string, string> = {
  intake: '📋',
  'ux-research': '🔍',
  'design-system': '🎨',
  architecture: '🏗️',
  'data-model': '🗄️',
  'feature-planner': '📐',
  'data-models': '📦',
  'code-gen': '⚙️',
  'frontend-builder': '🖥️',
  'backend-api': '🔌',
  integration: '🔗',
  'qa-validation': '✅',
  repair: '🔧',
  edit: '✏️',
  ready: '🎉',
};

// Pipeline step definitions (matches PIPELINE_STEPS in graph.ts)
const ALL_PIPELINE_STEPS = [
  'intake', 'ux-research', 'design-system', 'architecture', 'data-model',
  'feature-planner', 'data-models', 'code-gen', 'frontend-builder', 'backend-api',
  'integration', 'qa-validation', 'repair',
] as const;

function humanizePhase(phase: string | null): string {
  if (!phase) return 'Working…';
  if (phase in PHASE_LABELS) return PHASE_LABELS[phase];
  const value = phase.toLowerCase();
  if (/intake|product/.test(value)) return PHASE_LABELS.intake;
  if (/ux|research|screen|flow/.test(value)) return PHASE_LABELS['ux-research'];
  if (/design|theme|color/.test(value)) return PHASE_LABELS['design-system'];
  if (/architect|package|struct/.test(value)) return PHASE_LABELS.architecture;
  if (/database|schema|supabase|sql/.test(value)) return PHASE_LABELS['data-model'];
  if (/feature|plan|roadmap/.test(value)) return PHASE_LABELS['feature-planner'];
  if (/model|dart|fromjson/.test(value)) return PHASE_LABELS['data-models'];
  if (/provider|notifier|codegen/.test(value)) return PHASE_LABELS['code-gen'];
  if (/frontend|screen|ui|widget/.test(value)) return PHASE_LABELS['frontend-builder'];
  if (/backend|api|crud|service/.test(value)) return PHASE_LABELS['backend-api'];
  if (/integrat|router|navigation/.test(value)) return PHASE_LABELS.integration;
  if (/valid|qa|gate/.test(value)) return PHASE_LABELS['qa-validation'];
  if (/repair|fix|heal/.test(value)) return PHASE_LABELS.repair;
  if (/build|preview|compil/.test(value)) return 'Building the preview';
  return phase.replace(/^\[[^\]]*\]\s*/, '').slice(0, 90);
}

function shortModel(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  return (modelId.split('/').pop() || modelId).replace(/:free$/, '').replace(/-/g, ' ');
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
}

function validationSummary(validation: { issues: Array<{ severity: string }> } | null) {
  if (!validation) return null;
  const issues = validation.issues ?? [];
  const failed = issues.filter((issue) => issue.severity === 'error').length;
  const skipped = issues.filter((issue) => issue.severity === 'warning').length;
  const total = Math.max(1, issues.length);
  const passed = Math.max(0, total - failed - skipped);
  return { failed, passed, skipped, total };
}

function FileSources({ files, onOpen }: { files: FileActivity[]; onOpen: (path: string) => void }) {
  if (files.length === 0) return null;
  return (
    <Sources>
      <SourcesTrigger count={files.length}>
        <InlineCitation>
          <InlineCitationText>Used {files.length} project sources</InlineCitationText>
        </InlineCitation>
        <ChevronDownIcon className="size-4" />
      </SourcesTrigger>
      <SourcesContent>
        {files.map((file) => (
          <InlineCitation key={file.path}>
            <InlineCitationCard>
              <InlineCitationCardTrigger
                onClick={() => file.action !== 'deleted' && onOpen(file.path)}
                sources={[file.path]}
                title={file.path}
              />
              <InlineCitationCardBody>
                <div className="space-y-2 p-3">
                  <InlineCitationSource
                    description={`${file.action} · ${file.language ?? 'dart'}`}
                    title={file.path}
                  />
                  {file.action !== 'deleted' && (
                    <Button onClick={() => onOpen(file.path)} size="sm" variant="outline">
                      Open file
                    </Button>
                  )}
                </div>
              </InlineCitationCardBody>
            </InlineCitationCard>
          </InlineCitation>
        ))}
      </SourcesContent>
    </Sources>
  );
}

/** Slim segmented pipeline progress — one segment per agent step. */
function StepSegments({ phases, running }: { phases: PhaseActivity[]; running: boolean }) {
  const doneIds = new Set(phases.map((phase) => phase.phase));
  const active = phases.length > 0 ? phases[phases.length - 1].phase : null;

  return (
    <div className="flex items-center gap-[3px]" aria-hidden="true">
      {ALL_PIPELINE_STEPS.map((step) => {
        const isDone = doneIds.has(step) && step !== active;
        const isActive = step === active && running;
        return (
          <div
            key={step}
            title={PHASE_LABELS[step] ?? step}
            className={cn(
              'h-1.5 flex-1 rounded-full transition-colors duration-500',
              isDone && 'bg-emerald-500',
              isActive && 'animate-pulse bg-[var(--fb-ink)]',
              !isDone && !isActive && 'bg-[var(--fb-soft)]',
            )}
          />
        );
      })}
    </div>
  );
}

/** Blinking-caret chat line that always shows the newest log line. */
function LiveLogLine({ lines, running }: { lines: string[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  const latest = lines[lines.length - 1];
  if (!latest) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--fb-line)] bg-black/80 font-mono text-emerald-300/90">
      <div className="flex items-center gap-2 px-3 py-2">
        <TerminalSquareIcon className="size-3.5 shrink-0 text-emerald-400" />
        <span key={`${lines.length}-${latest.slice(0, 40)}`} className="min-w-0 flex-1 truncate text-[10.5px]">
          {latest}
          {running && <span className="ml-0.5 inline-block h-3 w-[6px] translate-y-[2px] animate-pulse bg-emerald-300/80 align-baseline" />}
        </span>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[9px] font-semibold uppercase tracking-[0.1em] text-emerald-400/80 transition-colors hover:bg-white/5 hover:text-emerald-300"
          aria-expanded={open}
        >
          Live logs · {lines.length} line{lines.length === 1 ? '' : 's'}
          {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
        </button>
      </div>
      {open && (
        <div className="max-h-40 overflow-y-auto border-t border-white/10 px-3 py-2 text-[10px] leading-relaxed text-emerald-200/80">
          {lines.slice(-60).map((line, index) => (
            <div key={index} className="whitespace-pre-wrap">{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RunActivity({
  page = false,
  onOpen,
}: {
  page?: boolean;
  onOpen: (path: string) => void;
}) {
  const run = useActivityStore((state) => state.run);
  const events = useActivityStore((state) => state.events);
  const filesMap = useActivityStore((state) => state.files);
  const plan = useActivityStore((state) => state.plan);
  const validation = useActivityStore((state) => state.validation);
  const [now, setNow] = useState(() => Date.now());
  const [showAllSteps, setShowAllSteps] = useState(false);
  const reduceMotion = useReducedMotion();

  const running = run?.status === 'running';

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const phases = useMemo(
    () => events.filter((event): event is PhaseActivity => event.kind === 'phase'),
    [events],
  );
  const reasoning = useMemo(
    () => events.filter((event): event is ReasoningActivity => event.kind === 'reasoning').slice(-1),
    [events],
  );
  const tools = useMemo(
    () => events.filter((event): event is ToolActivity => event.kind === 'tool').slice(-4),
    [events],
  );
  const checkpoints = useMemo(
    () => events.filter((event): event is CheckpointActivity => event.kind === 'checkpoint').slice(-3),
    [events],
  );
  const terminalLines = useMemo(
    () => events
      .filter((event): event is TerminalActivity => event.kind === 'terminal')
      .slice(-200)
      .map((event) => event.text),
    [events],
  );
  const errors = useMemo(
    () => events.filter((event): event is ErrorActivity => event.kind === 'error'),
    [events],
  );
  const files = useMemo(
    () => Object.values(filesMap).sort((left, right) => left.at - right.at),
    [filesMap],
  );
  const summary = useMemo(() => validationSummary(validation), [validation]);
  const runningTools = useMemo(
    () => tools.filter((tool) => tool.status === 'running'),
    [tools],
  );
  const pendingFiles = useMemo(() => {
    if (!plan) return [];
    const produced = new Set(Object.keys(filesMap));
    return plan.filesToCreate.filter((path) => !produced.has(path));
  }, [plan, filesMap]);

  if (!run && events.length === 0) return null;

  const elapsed = run
    ? Math.max(1, Math.floor(((run.endedAt ?? now) - run.startedAt) / 1000))
    : 0;
  const latestPhase = phases.length > 0 ? phases[phases.length - 1].message : run?.phase ?? null;
  const lastError = errors.length > 0 ? errors[errors.length - 1] : null;
  const currentStep = run?.step ?? phases.length;
  const totalSteps = run?.totalSteps ?? 0;
  const isPipeline = totalSteps >= 10;

  const visiblePhases = showAllSteps ? phases : phases.slice(-6);
  const hiddenPhaseCount = phases.length - visiblePhases.length;

  const bubbleEnter = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.12 } }
    : {
        initial: { opacity: 0, y: 14, scale: 0.98 },
        animate: { opacity: 1, y: 0, scale: 1 },
        transition: { type: 'spring' as const, stiffness: 380, damping: 32 },
      };

  return (
    <Message className="max-w-full" from="assistant">
      <MessageContent className="w-full">
        <div
          className={cn(
            'overflow-hidden rounded-2xl border border-[rgba(248,255,248,0.12)] bg-[linear-gradient(135deg,#001424_0%,#091d30_100%)] text-[#f8fff8] shadow-[0_14px_40px_-30px_rgba(0,0,0,0.8)]',
            page && 'rounded-[22px]',
          )}
        >
          {/* ── Agent identity row ─────────────────────────────────── */}
          <div className="flex items-center gap-2.5 border-b border-[rgba(248,255,248,0.08)] bg-[rgba(248,255,248,0.02)] px-3 py-2.5 sm:px-4">
            <div className="relative grid size-8 shrink-0 place-items-center rounded-full bg-[rgba(197,250,117,0.12)] border border-[rgba(197,250,117,0.30)] text-[#c5fa75]">
              <SparklesIcon className="size-4" />
              {running && (
                <span className="absolute -right-0.5 -top-0.5 flex size-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex size-2.5 rounded-full border-2 border-[#001424] bg-emerald-500" />
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-semibold leading-tight text-[#f8fff8]">
                FlutterForge Agent
              </p>
              <p className="truncate font-mono text-[9px] tracking-[0.1em] text-[#748ea0]">
                {shortModel(run?.model) ?? 'agent'}
              </p>
            </div>
            {running && (
              <span className="shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 font-mono text-[8.5px] font-semibold uppercase tracking-[0.14em] text-emerald-400">
                working
              </span>
            )}
            <span className="shrink-0 rounded-full border border-[rgba(248,255,248,0.12)] bg-[rgba(248,255,248,0.04)] px-2 py-0.5 font-mono text-[10px] tabular-nums text-[#748ea0]">
              {formatElapsed(elapsed * 1000)}
            </span>
          </div>

          <div className="space-y-2.5 px-3 py-3 sm:px-4" role="log" aria-live="polite" aria-label="Agent activity">
            {/* ── Compact pipeline stepper ─────────────────────────── */}
            {isPipeline && (
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[#748ea0]">
                    {running ? `Step ${currentStep} of ${totalSteps}` : `${totalSteps} steps complete`}
                  </span>
                  <span className="truncate font-mono text-[9px] text-[#748ea0]">
                    {humanizePhase(latestPhase)}
                  </span>
                </div>
                <StepSegments phases={phases} running={Boolean(running)} />
              </div>
            )}


            {/* ── Chat-style step feed ─────────────────────────────── */}
            {phases.length > 0 && (
              <div className="overflow-hidden rounded-xl border border-[rgba(248,255,248,0.10)] bg-[rgba(0,16,30,0.50)]">
                <button
                  type="button"
                  onClick={() => setShowAllSteps((value) => !value)}
                  className="flex w-full items-center justify-between gap-2 border-b border-[rgba(248,255,248,0.08)] bg-[rgba(248,255,248,0.03)] px-3 py-2 text-left transition-colors hover:bg-[rgba(248,255,248,0.06)]"
                  aria-expanded={showAllSteps}
                >
                  <span className="flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[#748ea0]">
                    <ListChecksIcon className="size-3.5 text-[#c5fa75]" />
                    Agent timeline · {phases.length} step{phases.length === 1 ? '' : 's'}
                    {files.length > 0 && (
                      <span className="rounded-full bg-emerald-500/15 border border-emerald-500/25 px-1.5 py-0.5 text-[8.5px] text-emerald-400">
                        {files.length} files
                      </span>
                    )}
                  </span>
                  <ChevronDownIcon className={cn('size-3.5 text-[#748ea0] transition-transform duration-300', showAllSteps && 'rotate-180')} />
                </button>
                <ol className="divide-y divide-[rgba(248,255,248,0.06)]">
                  {hiddenPhaseCount > 0 && (
                    <li className="px-3 py-1.5 text-center font-mono text-[9px] uppercase tracking-[0.12em] text-[#748ea0]">
                      + {hiddenPhaseCount} earlier steps
                    </li>
                  )}
                  <AnimatePresence initial={false}>
                    {visiblePhases.map((phase, index) => {
                      const isLast = index === visiblePhases.length - 1 && phases[phases.length - 1] === phase;
                      const active = running && isLast;
                      const emoji = PHASE_EMOJI[phase.phase] ?? '•';
                      return (
                        <motion.li
                          key={phase.id}
                          layout="position"
                          {...bubbleEnter}
                          className={cn(
                            'flex items-start gap-2 px-3 py-2',
                            active && 'bg-[rgba(197,250,117,0.08)]',
                          )}
                        >
                          <span className="mt-0.5 grid size-5 shrink-0 place-items-center">
                            {active ? (
                              <Loader2Icon className="size-3.5 animate-spin text-[#c5fa75]" />
                            ) : (
                              <CheckCircle2Icon className="size-3.5 text-emerald-400" />
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={cn('block text-[11.5px] leading-snug', active ? 'font-medium text-[#f8fff8]' : 'text-[rgba(248,255,248,0.70)]')}>
                              <span aria-hidden className="mr-1">{emoji}</span>
                              {phase.message}
                            </span>
                            {phase.step != null && (
                              <span className="mt-0.5 block font-mono text-[8.5px] uppercase tracking-[0.12em] text-[#748ea0]">
                                Step {phase.step}{phase.totalSteps ? `/${phase.totalSteps}` : ''}
                              </span>
                            )}
                          </span>
                        </motion.li>
                      );
                    })}
                  </AnimatePresence>
                </ol>
              </div>
            )}

            {/* ── Files popping in as they're written ──────────────── */}
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <AnimatePresence initial={false}>
                  {files.map((file) => (
                    <motion.button
                      key={file.path}
                      type="button"
                      layout
                      {...bubbleEnter}
                      onClick={() => file.action !== 'deleted' && onOpen(file.path)}
                      title={file.path}
                      className={cn(
                        'group inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-[var(--fb-line)] bg-[var(--fb-soft)] pl-2 pr-2.5 font-mono text-[9.5px] text-[var(--fb-muted)] transition-colors',
                        file.action !== 'deleted' && 'hover:border-[var(--fb-ink)] hover:text-[var(--fb-ink)]',
                      )}
                    >
                      <FileCode2Icon className="size-3 shrink-0 text-emerald-500" />
                      <span className="max-w-[150px] truncate sm:max-w-[220px]">{file.path.split('/').pop()}</span>
                      <span className="hidden text-[8px] uppercase tracking-wide text-[var(--fb-dim)] sm:inline">
                        {file.action === 'created' ? 'new' : file.action}
                      </span>
                    </motion.button>
                  ))}
                </AnimatePresence>
              </div>
            )}

            {/* ── Citation-style sources list ─────────────────────── */}
            <FileSources files={files} onOpen={onOpen} />

            {/* ── Thinking shimmer while the model writes ──────────── */}
            {running && reasoning.length > 0 && (
              <p className="flex items-center gap-2 px-1 text-[11px] text-[var(--fb-muted)]">
                <span className="size-1.5 animate-pulse rounded-full bg-[var(--fb-ink)]" />
                <span className="truncate">{reasoning[reasoning.length - 1].text.slice(0, 120)}</span>
              </p>
            )}

            {/* ── Tool calls as compact inline pills ───────────────── */}
            {tools.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {tools.map((tool) => (
                  <span
                    key={tool.id}
                    title={tool.output ?? tool.title}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[9px]',
                      tool.status === 'error'
                        ? 'border-red-500/40 bg-red-500/10 text-red-500'
                        : tool.status === 'running'
                          ? 'border-[var(--fb-ink)]/30 bg-[var(--fb-soft)] text-[var(--fb-ink)]'
                          : 'border-[var(--fb-line)] bg-[var(--fb-soft)] text-[var(--fb-muted)]',
                    )}
                  >
                    {tool.status === 'running' ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : tool.status === 'error' ? (
                      <XCircleIcon className="size-3" />
                    ) : (
                      <CheckCircle2Icon className="size-3 text-emerald-500" />
                    )}
                    <span className="max-w-[180px] truncate">{tool.title}</span>
                  </span>
                ))}
              </div>
            )}

            {/* ── Checkpoints (repairs, verification gates) ────────── */}
            {checkpoints.map((checkpoint) => (
              <p key={checkpoint.id} className="flex items-center gap-2 px-1 text-[10.5px] text-[var(--fb-dim)]">
                <CircleIcon className="size-2 fill-current" />
                <span className="truncate">{checkpoint.label}</span>
              </p>
            ))}

            {/* ── Live terminal tail ───────────────────────────────── */}
            <LiveLogLine lines={terminalLines} running={Boolean(running)} />

            {/* ── Queued files / running tools ─────────────────────── */}
            {running && (runningTools.length > 0 || pendingFiles.length > 0) && (
              <Queue>
                <QueueSection defaultOpen>
                  <QueueSectionTrigger>
                    <QueueSectionLabel
                      count={runningTools.length + pendingFiles.length}
                      label="in progress"
                    />
                  </QueueSectionTrigger>
                  <QueueSectionContent>
                    <QueueList>
                      {runningTools.map((tool) => (
                        <QueueItem key={tool.id}>
                          <div className="flex items-start gap-2">
                            <QueueItemIndicator />
                            <div className="min-w-0 flex-1">
                              <QueueItemContent>{tool.title}</QueueItemContent>
                              <QueueItemDescription>{tool.tool}</QueueItemDescription>
                            </div>
                          </div>
                        </QueueItem>
                      ))}
                      {pendingFiles.slice(0, 20).map((path) => (
                        <QueueItem key={path}>
                          <div className="flex items-start gap-2">
                            <QueueItemIndicator />
                            <div className="min-w-0 flex-1">
                              <QueueItemContent className="font-mono text-xs">{path}</QueueItemContent>
                              <QueueItemDescription>Queued file</QueueItemDescription>
                            </div>
                          </div>
                        </QueueItem>
                      ))}
                    </QueueList>
                  </QueueSectionContent>
                </QueueSection>
              </Queue>
            )}

            {/* ── QA gates summary ─────────────────────────────────── */}
            {summary && (
              <TestResults summary={summary}>
                <TestResultsHeader>
                  <TestResultsSummary />
                </TestResultsHeader>
                <TestResultsProgress />
              </TestResults>
            )}

            {/* ── Generated app plan (collapsed by default) ────────── */}
            {plan && (
              <Plan defaultOpen={false}>
                <PlanHeader>
                  <div className="min-w-0">
                    <PlanTitle>{plan.appName}</PlanTitle>
                    <PlanDescription>{plan.appDescription || ''}</PlanDescription>
                  </div>
                  <PlanAction>
                    <PlanTrigger />
                  </PlanAction>
                </PlanHeader>
                <PlanContent className="space-y-3 text-sm">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="secondary">{plan.architecture.replaceAll('_', ' ')}</Badge>
                    <Badge variant="outline">{plan.stateManagement.replaceAll('_', ' ')}</Badge>
                    <Badge variant="outline">{plan.screens.length} screens</Badge>
                    <Badge variant="outline">{plan.filesToCreate.length} files</Badge>
                  </div>
                  {plan.screens.length > 0 && (
                    <div className="space-y-1">
                      {plan.screens.slice(0, 8).map((screen) => (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground" key={screen.routePath}>
                          <CircleIcon className="size-2" />
                          <span className="text-foreground">{screen.name}</span>
                          <span className="truncate font-mono">{screen.filePath}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </PlanContent>
              </Plan>
            )}

            {/* ── Error stack (click a path to open the file) ──────── */}
            {lastError && (
              <StackTrace
                defaultOpen={false}
                onFilePathClick={(path) => onOpen(path)}
                trace={lastError.stack || lastError.message}
              >
                <StackTraceHeader>
                  <StackTraceError>
                    <StackTraceErrorType />
                    <StackTraceErrorMessage />
                  </StackTraceError>
                  <StackTraceActions>
                    <StackTraceCopyButton />
                    <StackTraceExpandButton />
                  </StackTraceActions>
                </StackTraceHeader>
                <StackTraceContent>
                  <pre className="whitespace-pre-wrap p-3 font-mono text-xs">{lastError.stack || lastError.message}</pre>
                </StackTraceContent>
              </StackTrace>
            )}

            {/* ── Done footer ──────────────────────────────────────── */}
            {!running && run && (
              <div className="flex items-center gap-2 border-t border-[var(--fb-line)] pt-2.5 text-[11px] text-[var(--fb-muted)]">
                {run.status === 'success' ? (
                  <>
                    <CheckCircle2Icon className="size-4 text-emerald-500" />
                    <span>
                      Done in {formatElapsed(elapsed * 1000)}
                      {files.length > 0 ? ` · ${files.length} files written` : ''}
                      {lastError ? ' · with errors — see above' : ' · all gates passed'}
                    </span>
                  </>
                ) : (
                  <>
                    <XCircleIcon className="size-4 text-red-400" />
                    <span>Run {run.status} after {formatElapsed(elapsed * 1000)}{lastError ? ' — see the error above' : ''}</span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}
