import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  Check,
  CheckCircle2,
  ChefHat,
  CircleDashed,
  FileCode2,
  Gauge,
  GitBranch,
  Hammer,
  Info,
  Layers,
  ListChecks,
  Loader2,
  Palette,
  Receipt,
  RefreshCw,
  Repeat,
  RotateCcw,
  Route,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Star,
  StickyNote,
  Timer,
  Wand2,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { useProjectStore } from '@/stores/project.store';
import {
  MIN_TOP_APP_QUALITY,
  isRunActive,
  isRunSettled,
  stopPolling,
  useGenerationStore,
  type AppDomain,
  type AppSpec,
  type EntitySpec,
  type FieldType,
  type GenerationBackend,
  type GenerationBenchmark,
  type GenerationDomain,
  type GenerationRun,
  type GenerationRunEvent,
  type GenerationRunStatus,
  type GenerationTarget,
  type QualityCategory,
  type QualityFinding,
  type QualityReport,
  type QualitySeverity,
  type ScreenKind,
  type SpecValidation,
} from '@/stores/generation.store';

interface GenerationStudioProps {
  /** Falls back to the open project from the project store when omitted. */
  projectId?: string;
  className?: string;
}

/* ── constants ───────────────────────────────────────────────────────────── */

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ff-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ff-surface)]';

const PROMPT_LIMIT = 2_000;
const BUDGET_BYTES = 2 * 1024 * 1024;

const DOMAIN_OPTIONS: ReadonlyArray<{ value: GenerationDomain; label: string }> = [
  { value: 'auto', label: 'Auto — infer from brief' },
  { value: 'productivity', label: 'Productivity' },
  { value: 'commerce', label: 'Commerce' },
  { value: 'social', label: 'Social' },
  { value: 'finance', label: 'Finance' },
  { value: 'health', label: 'Health' },
  { value: 'education', label: 'Education' },
  { value: 'travel', label: 'Travel' },
  { value: 'media', label: 'Media' },
  { value: 'developer', label: 'Developer' },
  { value: 'custom', label: 'Custom' },
];

const BACKEND_OPTIONS: ReadonlyArray<{ value: GenerationBackend; label: string }> = [
  { value: 'local', label: 'Local — offline first' },
  { value: 'supabase', label: 'Supabase' },
];

const TARGET_OPTIONS: ReadonlyArray<{ value: GenerationTarget; label: string }> = [
  { value: 'web', label: 'Web app' },
  { value: 'android-apk', label: 'Android APK' },
  { value: 'android-aab', label: 'Android App Bundle' },
  { value: 'ios-archive', label: 'iOS archive' },
];

const EXAMPLES: ReadonlyArray<{ label: string; prompt: string; icon: LucideIcon }> = [
  {
    label: 'Notes',
    icon: StickyNote,
    prompt:
      'A calm note-taking app for hikers. Trail notes can hold photos and offline drafts, pin favourite trips, and search by trail name.',
  },
  {
    label: 'Habit tracker',
    icon: Repeat,
    prompt:
      'A habit tracker that builds streaks with gentle reminders, weekly reviews, and a calendar heatmap of completed days.',
  },
  {
    label: 'Expense splitter',
    icon: Receipt,
    prompt:
      'A shared expense splitter for trips: add expenses, split them per person, and settle balances at the end of the journey.',
  },
  {
    label: 'Recipe box',
    icon: ChefHat,
    prompt:
      'A recipe box for weeknight cooking: save recipes, plan the week, and turn the plan into a grouped shopping list.',
  },
];

const DOMAIN_LABEL: Record<AppDomain, string> = {
  productivity: 'Productivity',
  commerce: 'Commerce',
  social: 'Social',
  finance: 'Finance',
  health: 'Health',
  education: 'Education',
  travel: 'Travel',
  media: 'Media',
  developer: 'Developer',
  custom: 'Custom',
};

const FIELD_TONE: Record<FieldType, string> = {
  string: 'bg-[var(--ff-studio-blue)] text-[#0b3542]',
  text: 'bg-[var(--ff-studio-blue)] text-[#0b3542]',
  int: 'bg-[var(--ff-studio-mint)] text-[#0f3a2c]',
  double: 'bg-[var(--ff-studio-mint)] text-[#0f3a2c]',
  bool: 'bg-[var(--ff-studio-lavender)] text-[#2a1b4a]',
  datetime: 'bg-[var(--ff-studio-yellow)] text-[#4a3a00]',
  enum: 'bg-[var(--ff-studio-pink)] text-[#57112b]',
  stringList: 'bg-[var(--ff-studio-blue)] text-[#0b3542]',
  relation: 'bg-[var(--ff-studio-lavender)] text-[#2a1b4a]',
};

const SCREEN_KIND_TONE: Record<ScreenKind, string> = {
  dashboard: 'bg-[var(--ff-studio-yellow)] text-[#4a3a00]',
  list: 'bg-[var(--ff-studio-blue)] text-[#0b3542]',
  detail: 'bg-[var(--ff-studio-lavender)] text-[#2a1b4a]',
  form: 'bg-[var(--ff-studio-mint)] text-[#0f3a2c]',
  chat: 'bg-[var(--ff-studio-pink)] text-[#57112b]',
  profile: 'bg-[var(--ff-studio-blue)] text-[#0b3542]',
  settings: 'bg-[var(--ff-surface-2)] text-[var(--ff-text)]',
  onboarding: 'bg-[var(--ff-studio-yellow)] text-[#4a3a00]',
};

const QUALITY_CATEGORIES: ReadonlyArray<QualityCategory> = [
  'architecture',
  'completeness',
  'design',
  'accessibility',
  'reliability',
  'testability',
  'performance',
];

const CATEGORY_LABEL: Record<QualityCategory, string> = {
  architecture: 'Architecture',
  completeness: 'Completeness',
  design: 'Design',
  accessibility: 'Accessibility',
  reliability: 'Reliability',
  testability: 'Testability',
  performance: 'Performance',
};

const SEVERITY_META: Record<
  QualitySeverity,
  { label: string; icon: LucideIcon; chip: string; text: string }
> = {
  error: {
    label: 'Error',
    icon: XCircle,
    chip: 'bg-[var(--ff-studio-pink)] text-[#57112b]',
    text: 'text-[var(--ff-error)]',
  },
  warning: {
    label: 'Warning',
    icon: AlertTriangle,
    chip: 'bg-[var(--ff-studio-yellow)] text-[#4a3a00]',
    text: 'text-[var(--ff-warning)]',
  },
  info: {
    label: 'Info',
    icon: Info,
    chip: 'bg-[var(--ff-studio-blue)] text-[#0b3542]',
    text: 'text-[var(--ff-text-muted)]',
  },
};

const RUN_STATUS_META: Record<GenerationRunStatus, { label: string; chip: string }> = {
  pending: { label: 'Queued', chip: 'bg-[var(--ff-studio-yellow)] text-[#4a3a00]' },
  running: { label: 'Running', chip: 'bg-[var(--ff-studio-blue)] text-[#0b3542]' },
  waiting_approval: {
    label: 'Awaiting approval',
    chip: 'bg-[var(--ff-studio-lavender)] text-[#2a1b4a]',
  },
  compensating: {
    label: 'Compensating',
    chip: 'bg-[var(--ff-studio-yellow)] text-[#4a3a00]',
  },
  succeeded: { label: 'Sealed', chip: 'bg-[var(--ff-studio-mint)] text-[#0f3a2c]' },
  failed: { label: 'Failed', chip: 'bg-[var(--ff-studio-pink)] text-[#57112b]' },
  cancelled: {
    label: 'Cancelled',
    chip: 'bg-[var(--ff-surface-2)] text-[var(--ff-text-muted)]',
  },
};

const EVENT_LABELS: Record<string, string> = {
  'app.spec': 'Spec compiled',
  'app.emitted': 'Project emitted',
  'app.scored': 'Quality scored',
  'app.verified': 'Analyzer verified',
  'app.sealed': 'Workspace sealed',
  'run.failed': 'Failed',
  'run.started': 'Run started',
  'run.succeeded': 'Run completed',
};

type GateId = 'structure' | 'quality' | 'budget' | 'tests' | 'analyze';

interface GateRow {
  id: GateId;
  label: string;
  passed: boolean | null;
  blockers: string[];
  detail: string | null;
}

interface EventScore {
  total: number;
  grade: QualityReport['grade'];
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function gradeForScore(score: number): QualityReport['grade'] {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function isGrade(value: unknown): value is QualityReport['grade'] {
  return value === 'A' || value === 'B' || value === 'C' || value === 'D' || value === 'F';
}

function gradeColor(grade: QualityReport['grade'] | null): string {
  if (grade === 'A' || grade === 'B') return 'var(--ff-success)';
  if (grade === 'C') return 'var(--ff-warning)';
  if (grade === 'D' || grade === 'F') return 'var(--ff-error)';
  return 'var(--ff-primary)';
}

function scoreTone(value: number): string {
  if (value >= MIN_TOP_APP_QUALITY) return 'var(--ff-success)';
  if (value >= 65) return 'var(--ff-warning)';
  return 'var(--ff-error)';
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const kb = bytes / 1024;
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
}

function formatTime(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function timeAgo(value: number): string {
  const diff = Date.now() - value;
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 12)}…` : id;
}

function eventLabel(type: string): string {
  const known = EVENT_LABELS[type];
  if (known) return known;
  return type
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function qualityVerdict(total: number): string {
  if (total >= 95) return 'Exceptional — every hard gate has strong evidence.';
  if (total >= 90) return 'Excellent — sealed with clean verification evidence.';
  if (total >= MIN_TOP_APP_QUALITY) return 'Above the floor — ready to ship.';
  if (total >= 70) return 'Close — a few findings still hold back a top score.';
  return 'Needs another pass before this can be sealed.';
}

function scoreFromEvents(events: GenerationRunEvent[]): EventScore | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== 'app.scored') continue;
    const source = isRecord(event.data.quality) ? event.data.quality : event.data;
    const raw = numberValue(source.total) ?? numberValue(source.score);
    if (raw === null) continue;
    const total = clampScore(raw);
    const rawGrade = typeof source.grade === 'string' ? source.grade.toUpperCase() : null;
    return { total, grade: isGrade(rawGrade) ? rawGrade : gradeForScore(total) };
  }
  return null;
}

function eventDetail(event: GenerationRunEvent): string | null {
  const data = event.data;
  const pieces: string[] = [];

  switch (event.type) {
    case 'app.spec': {
      const name = stringValue(data.appName) ?? stringValue(data.name);
      if (name) pieces.push(name);
      const rawEntities = data.entities;
      const entities =
        numberValue(rawEntities) ?? (Array.isArray(rawEntities) ? rawEntities.length : null);
      const rawScreens = data.screens;
      const screens =
        numberValue(rawScreens) ?? (Array.isArray(rawScreens) ? rawScreens.length : null);
      if (entities !== null) pieces.push(`${entities} entities`);
      if (screens !== null) pieces.push(`${screens} screens`);
      break;
    }
    case 'app.emitted': {
      const rawFiles = data.fileCount ?? data.files;
      const files =
        numberValue(rawFiles) ?? (Array.isArray(rawFiles) ? rawFiles.length : null);
      if (files !== null) pieces.push(`${files} files`);
      const bytes = numberValue(data.bytes) ?? numberValue(data.totalBytes);
      if (bytes !== null) pieces.push(formatBytes(bytes));
      break;
    }
    case 'app.scored': {
      const source = isRecord(data.quality) ? data.quality : data;
      const total = numberValue(source.total) ?? numberValue(source.score);
      const grade = stringValue(source.grade);
      if (total !== null) pieces.push(`${clampScore(total)}/100`);
      if (grade) pieces.push(`grade ${grade.toUpperCase()}`);
      break;
    }
    case 'app.verified': {
      const errors = numberValue(data.errorCount) ?? numberValue(data.errors);
      const warnings = numberValue(data.warningCount) ?? numberValue(data.warnings);
      if (errors !== null) pieces.push(`${errors} errors`);
      if (warnings !== null) pieces.push(`${warnings} warnings`);
      break;
    }
    case 'app.sealed': {
      const files = numberValue(data.fileCount) ?? numberValue(data.files);
      if (files !== null) pieces.push(`${files} files`);
      const revision = stringValue(data.revisionId);
      if (revision) pieces.push(`revision ${shortId(revision)}`);
      break;
    }
    case 'run.failed': {
      const message =
        stringValue(data.message) ??
        (isRecord(data.error) ? stringValue(data.error.message) : null) ??
        stringValue(data.reason);
      if (message) pieces.push(message);
      break;
    }
    default: {
      const message =
        stringValue(data.message) ?? stringValue(data.detail) ?? stringValue(data.reason);
      if (message) pieces.push(message);
      break;
    }
  }

  if (pieces.length === 0) {
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        pieces.push(`${key}: ${String(value)}`);
        if (pieces.length >= 2) break;
      }
    }
  }

  return pieces.length > 0 ? pieces.join(' · ') : null;
}

function eventTone(type: string): string {
  if (type.includes('failed') || type.includes('error')) {
    return 'border-[var(--ff-border)] bg-[var(--ff-error)]';
  }
  if (
    type === 'app.sealed' ||
    type === 'app.verified' ||
    type === 'run.succeeded' ||
    type.endsWith('.succeeded')
  ) {
    return 'border-[var(--ff-border)] bg-[var(--ff-success)]';
  }
  return 'border-[var(--ff-border)] bg-[var(--ff-primary)]';
}

function gateIdFor(name: string): GateId | null {
  const normalized = name.toLowerCase();
  if (normalized.includes('struct')) return 'structure';
  if (normalized.includes('quality') || normalized.includes('score')) return 'quality';
  if (normalized.includes('budget') || normalized.includes('size')) return 'budget';
  if (normalized.includes('test')) return 'tests';
  if (normalized.includes('analy') || normalized.includes('verif')) return 'analyze';
  return null;
}

function explicitGates(
  events: GenerationRunEvent[],
  run: GenerationRun | null,
): Map<GateId, { passed: boolean; blockers: string[]; detail: string | null }> {
  const gates = new Map<GateId, { passed: boolean; blockers: string[]; detail: string | null }>();

  const ingest = (value: unknown): void => {
    if (!isRecord(value)) return;
    const name = stringValue(value.gate) ?? stringValue(value.name);
    const passed =
      typeof value.passed === 'boolean'
        ? value.passed
        : typeof value.ok === 'boolean'
          ? value.ok
          : null;
    if (!name || passed === null) return;
    const id = gateIdFor(name);
    if (!id) return;
    const blockers = Array.isArray(value.blockers)
      ? value.blockers.filter((blocker): blocker is string => typeof blocker === 'string')
      : [];
    gates.set(id, { passed, blockers, detail: stringValue(value.detail) });
  };

  if (run && isRecord(run.output) && Array.isArray(run.output.gates)) {
    run.output.gates.forEach(ingest);
  }
  for (const event of events) {
    if (Array.isArray(event.data.gates)) event.data.gates.forEach(ingest);
    if (
      (event.type.startsWith('gate.') || event.type.startsWith('app.gate.')) &&
      typeof event.data.passed === 'boolean'
    ) {
      ingest({ ...event.data, gate: event.data.gate ?? event.type.split('.').at(-1) });
    }
  }

  return gates;
}

function deriveGates(
  validation: SpecValidation | null,
  quality: QualityReport | null,
  events: GenerationRunEvent[],
  run: GenerationRun | null,
): GateRow[] {
  const explicit = explicitGates(events, run);
  const eventScore = scoreFromEvents(events);
  const qualityTotal = quality?.total ?? eventScore?.total ?? null;
  const verified = events.find((event) => event.type === 'app.verified');
  const analyzerErrors = verified
    ? numberValue(verified.data.errorCount) ?? numberValue(verified.data.errors)
    : null;
  const analyzerWarnings = verified
    ? numberValue(verified.data.warningCount) ?? numberValue(verified.data.warnings)
    : null;
  const structureFallback = validation ? validation.ok : null;
  const qualityFallback = qualityTotal !== null ? qualityTotal >= MIN_TOP_APP_QUALITY : null;
  const testsFallback = quality ? quality.stats.tests > 0 : null;
  const budgetFallback = quality ? quality.stats.bytes <= BUDGET_BYTES : null;
  const analyzeFallback = verified ? analyzerErrors === 0 : null;

  return [
    {
      id: 'structure',
      label: 'Structure',
      passed: explicit.get('structure')?.passed ?? structureFallback,
      blockers:
        explicit.get('structure')?.blockers ??
        (validation && !validation.ok ? validation.errors.slice(0, 4) : []),
      detail:
        explicit.get('structure')?.detail ??
        (validation?.ok ? 'Spec contract is complete and internally consistent.' : null),
    },
    {
      id: 'quality',
      label: 'Quality',
      passed: explicit.get('quality')?.passed ?? qualityFallback,
      blockers:
        explicit.get('quality')?.blockers ??
        (qualityTotal !== null && qualityTotal < MIN_TOP_APP_QUALITY
          ? [`Quality ${qualityTotal} is below the ${MIN_TOP_APP_QUALITY} floor.`]
          : []),
      detail:
        explicit.get('quality')?.detail ??
        (qualityTotal !== null ? `Scored ${qualityTotal}/100 against the top-app rubric.` : null),
    },
    {
      id: 'budget',
      label: 'Budget',
      passed: explicit.get('budget')?.passed ?? budgetFallback,
      blockers:
        explicit.get('budget')?.blockers ??
        (quality && quality.stats.bytes > BUDGET_BYTES
          ? [
              `Project is ${formatBytes(quality.stats.bytes)} — over the ${formatBytes(BUDGET_BYTES)} budget.`,
            ]
          : []),
      detail:
        explicit.get('budget')?.detail ??
        (quality
          ? `${formatBytes(quality.stats.bytes)} of ${formatBytes(BUDGET_BYTES)} used.`
          : null),
    },
    {
      id: 'tests',
      label: 'Tests',
      passed: explicit.get('tests')?.passed ?? testsFallback,
      blockers:
        explicit.get('tests')?.blockers ??
        (quality && quality.stats.tests === 0 ? ['No tests were emitted with the project.'] : []),
      detail:
        explicit.get('tests')?.detail ??
        (quality ? `${quality.stats.tests} test files emitted.` : null),
    },
    {
      id: 'analyze',
      label: 'Analyze',
      passed: explicit.get('analyze')?.passed ?? analyzeFallback,
      blockers:
        explicit.get('analyze')?.blockers ??
        (analyzerErrors !== null && analyzerErrors > 0
          ? [`Analyzer reported ${analyzerErrors} error${analyzerErrors === 1 ? '' : 's'}.`]
          : []),
      detail:
        explicit.get('analyze')?.detail ??
        (verified
          ? `${analyzerErrors ?? 0} errors · ${analyzerWarnings ?? 0} warnings from dart analyze.`
          : null),
    },
  ];
}

/* ── shared presentational pieces ────────────────────────────────────────── */

function PanelHeading({
  step,
  title,
  aside,
}: {
  step: string;
  title: string;
  aside?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-0.5">
      <span
        aria-hidden
        className="ff-label inline-flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)] text-[9px] font-bold text-[var(--ff-text-muted)]"
      >
        {step}
      </span>
      <h3 className="ff-display text-[12px] font-bold uppercase tracking-[0.06em] text-[var(--ff-text)]">
        {title}
      </h3>
      {aside && <div className="ml-auto flex items-center gap-1.5">{aside}</div>}
    </div>
  );
}

function SubHeading({
  icon: Icon,
  title,
  count,
}: {
  icon: LucideIcon;
  title: string;
  count?: number;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      <Icon size={12} aria-hidden className="shrink-0 text-[var(--ff-text-muted)]" />
      <h4 className="ff-label text-[9px] font-bold text-[var(--ff-text-muted)]">{title}</h4>
      {count !== undefined && (
        <span className="rounded-full border border-[var(--ff-border)] px-1.5 text-[8px] font-bold leading-4 text-[var(--ff-text-dim)]">
          {count}
        </span>
      )}
    </div>
  );
}

function SpecStat({ value, label }: { value: number; label: string }) {
  return (
    <div
      aria-label={`${value} ${label}`}
      className="rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-2.5 py-2 text-center"
    >
      <p className="ff-display text-xl font-bold leading-none text-[var(--ff-text)]">{value}</p>
      <p className="ff-label mt-1 text-[8px] font-bold text-[var(--ff-text-muted)]">{label}</p>
    </div>
  );
}

function StatusChip({ status }: { status: GenerationRunStatus }) {
  const meta = RUN_STATUS_META[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border-2 border-[var(--ff-border)] px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.1em]',
        meta.chip,
      )}
    >
      {isRunActive(status) && (
        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current" />
      )}
      {meta.label}
    </span>
  );
}

function GradeRing({ total, grade }: { total: number; grade: QualityReport['grade'] }) {
  const score = clampScore(total);
  const circumference = 2 * Math.PI * 50;
  const offset = circumference * (1 - score / 100);
  const color = gradeColor(grade);
  return (
    <div
      role="img"
      aria-label={`Quality score ${score} out of 100, grade ${grade}`}
      className="relative size-32 shrink-0"
    >
      <svg viewBox="0 0 120 120" className="size-full" aria-hidden focusable="false">
        <circle
          cx="60"
          cy="60"
          r="50"
          fill="none"
          stroke="var(--ff-border)"
          strokeWidth="9"
          opacity="0.3"
        />
        <circle
          cx="60"
          cy="60"
          r="50"
          fill="none"
          stroke={color}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 60 60)"
          style={{ transition: 'stroke-dashoffset 600ms ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="ff-display text-4xl font-bold leading-none" style={{ color }}>
          {grade}
        </span>
        <span className="ff-label mt-1 text-[9px] font-bold text-[var(--ff-text-muted)]">
          {score} / 100
        </span>
      </div>
    </div>
  );
}

/* ── spec preview ────────────────────────────────────────────────────────── */

function EntityCard({ entity }: { entity: EntitySpec }) {
  return (
    <article
      aria-label={`Entity ${entity.name}`}
      className="rounded-xl border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] p-2.5"
    >
      <div className="flex items-start gap-2">
        <Boxes size={13} aria-hidden className="mt-0.5 shrink-0 text-[var(--ff-text-muted)]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <h5 className="ff-display text-sm font-bold text-[var(--ff-text)]">{entity.name}</h5>
            <code className="font-mono text-[9px] text-[var(--ff-text-dim)]">{entity.plural}</code>
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-[var(--ff-text-muted)]">
            {entity.description}
          </p>
        </div>
      </div>
      {entity.fields.length === 0 ? (
        <p className="mt-2 text-[10px] text-[var(--ff-text-dim)]">Only the implicit id field.</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1">
          {entity.fields.map((field) => (
            <span
              key={field.name}
              title={[
                field.label ?? field.name,
                field.primary ? 'Primary field' : null,
                field.required ? 'Required' : null,
                field.target ? `References ${field.target}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              aria-label={`${field.name}, ${field.type}${field.primary ? ', primary' : ''}${
                field.required ? ', required' : ''
              }`}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border-2 border-[var(--ff-border)] px-1.5 py-0.5 text-[9px] font-semibold',
                FIELD_TONE[field.type],
              )}
            >
              {field.primary && (
                <Star size={8} aria-hidden strokeWidth={2.5} className="shrink-0" />
              )}
              <span className="font-mono">{field.name}</span>
              <span className="opacity-70">{field.type}</span>
              {field.values && field.values.length > 0 && (
                <span className="opacity-70">({field.values.join(' | ')})</span>
              )}
              {field.required && (
                <span aria-hidden className="font-black">
                  *
                </span>
              )}
              {field.primary && <span className="sr-only">primary field</span>}
              {field.required && <span className="sr-only">required</span>}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

function ValidationBanner({ validation }: { validation: SpecValidation }) {
  if (validation.ok) {
    return (
      <div className="flex items-center gap-2 rounded-lg border-2 border-[var(--ff-success)] px-2.5 py-1.5">
        <ShieldCheck size={13} aria-hidden className="shrink-0 text-[var(--ff-success)]" />
        <p className="text-[10px] font-semibold text-[var(--ff-text)]">
          Spec validated — the contract is ready to forge.
        </p>
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="rounded-lg border-2 border-[var(--ff-warning)] px-2.5 py-2"
      style={{ background: 'color-mix(in srgb, var(--ff-warning) 10%, var(--ff-surface))' }}
    >
      <p className="flex items-center gap-1.5 text-[10px] font-bold text-[var(--ff-text)]">
        <ShieldAlert size={13} aria-hidden className="shrink-0 text-[var(--ff-warning)]" />
        Spec needs attention
      </p>
      <ul role="list" className="mt-1 space-y-0.5">
        {validation.errors.slice(0, 5).map((error) => (
          <li key={error} className="text-[10px] leading-snug text-[var(--ff-text-muted)]">
            · {error}
          </li>
        ))}
      </ul>
      {validation.errors.length > 5 && (
        <p className="mt-1 text-[9px] text-[var(--ff-text-dim)]">
          +{validation.errors.length - 5} more validation issues
        </p>
      )}
    </div>
  );
}

function SpecSkeleton() {
  return (
    <div
      role="status"
      aria-label="Compiling spec"
      className="space-y-2 rounded-xl border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] p-3"
    >
      <div className="h-5 w-2/3 animate-pulse rounded bg-[var(--ff-surface-2)]" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--ff-surface-2)]" />
      <div className="grid grid-cols-3 gap-2 pt-1">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="h-14 animate-pulse rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)]"
          />
        ))}
      </div>
      <div className="h-20 animate-pulse rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)]" />
      <p className="pt-1 text-center text-[10px] text-[var(--ff-text-muted)]">
        Reading the brief and compiling the app contract…
      </p>
    </div>
  );
}

interface SpecPreviewProps {
  spec: AppSpec | null;
  validation: SpecValidation | null;
  compiling: boolean;
  canCompile: boolean;
  onCompile: () => void;
}

function SpecPreview({ spec, validation, compiling, canCompile, onCompile }: SpecPreviewProps) {
  return (
    <section aria-label="App spec" aria-busy={compiling ? true : undefined} className="space-y-2">
      <PanelHeading
        step="02"
        title="Spec"
        aside={
          compiling ? (
            <span
              role="status"
              className="inline-flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--ff-text-muted)]"
            >
              <Loader2 size={11} aria-hidden className="animate-spin" />
              Compiling
            </span>
          ) : spec ? (
            <span className="ff-label text-[8px] font-bold text-[var(--ff-text-dim)]">
              version {spec.version}
            </span>
          ) : null
        }
      />

      {!spec ? (
        compiling ? (
          <SpecSkeleton />
        ) : (
          <div className="rounded-xl border-2 border-dashed border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-4 py-8 text-center">
            <FileCode2 size={26} aria-hidden className="mx-auto mb-2 text-[var(--ff-text-dim)]" />
            <p className="text-sm font-semibold text-[var(--ff-text)]">No spec compiled yet</p>
            <p className="mx-auto mt-1 max-w-sm text-[11px] leading-snug text-[var(--ff-text-muted)]">
              Compile a brief to inspect the app contract — entities, screens, flows and design
              tokens — before the pipeline writes a single file.
            </p>
            <button
              type="button"
              onClick={onCompile}
              disabled={!canCompile}
              className={cn(
                'mt-3 inline-flex items-center gap-1.5 rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--ff-text)] transition-colors hover:bg-[var(--ff-surface-2)] disabled:cursor-not-allowed disabled:opacity-50',
                FOCUS_RING,
              )}
            >
              <Wand2 size={12} aria-hidden />
              Compile brief
            </button>
          </div>
        )
      ) : (
        <div className="overflow-hidden rounded-xl border-2 border-[var(--ff-border)] bg-[var(--ff-surface)]">
          <div className="border-b-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)] p-3">
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="ff-display text-lg font-bold leading-tight text-[var(--ff-text)]">
                    {spec.app.name}
                  </h3>
                  <span className="inline-flex items-center rounded-full border-2 border-[var(--ff-border)] bg-[var(--ff-studio-lavender)] px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.1em] text-[#2a1b4a]">
                    {DOMAIN_LABEL[spec.app.domain] ?? spec.app.domain}
                  </span>
                  {validation?.ok && (
                    <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.08em] text-[var(--ff-success)]">
                      <Check size={11} aria-hidden strokeWidth={3} />
                      Validated
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-snug text-[var(--ff-text-muted)]">
                  {spec.app.tagline}
                </p>
                <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--ff-text-dim)]">
                  {spec.app.packageName} · for {spec.audience.primary}
                </p>
              </div>
              {validation && !validation.ok && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border-2 border-[var(--ff-warning)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-[var(--ff-warning)]">
                  <ShieldAlert size={11} aria-hidden />
                  {validation.errors.length} issue{validation.errors.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <p className="mt-2 text-[11px] leading-snug text-[var(--ff-text-muted)]">
              {spec.app.description}
            </p>
          </div>

          <div className="space-y-3 p-3">
            {validation && <ValidationBanner validation={validation} />}

            <div className="grid grid-cols-3 gap-2">
              <SpecStat value={spec.entities.length} label="entities" />
              <SpecStat value={spec.screens.length} label="screens" />
              <SpecStat value={spec.flows.length} label="flows" />
            </div>

            <section aria-label="Entities">
              <SubHeading icon={Boxes} title="Entities" count={spec.entities.length} />
              {spec.entities.length === 0 ? (
                <p className="rounded-lg border-2 border-dashed border-[var(--ff-border)] px-3 py-3 text-center text-[10px] text-[var(--ff-text-muted)]">
                  No entities — this is a UI-only app.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {spec.entities.map((entity) => (
                    <EntityCard key={entity.name} entity={entity} />
                  ))}
                </div>
              )}
            </section>

            <section aria-label="Screens">
              <SubHeading icon={Layers} title="Screens" count={spec.screens.length} />
              <ul role="list" className="space-y-1.5">
                {spec.screens.map((screen) => (
                  <li
                    key={screen.id}
                    className="rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] px-2.5 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border-2 border-[var(--ff-border)] px-1.5 py-0.5 text-[8px] font-black uppercase tracking-[0.1em]',
                          SCREEN_KIND_TONE[screen.kind],
                        )}
                      >
                        {screen.kind}
                      </span>
                      <span className="min-w-0 truncate text-[11px] font-semibold text-[var(--ff-text)]">
                        {screen.title}
                      </span>
                      <code
                        className="ml-auto min-w-0 truncate font-mono text-[9px] text-[var(--ff-text-dim)]"
                        title={screen.route}
                      >
                        {screen.route}
                      </code>
                    </div>
                    <p className="mt-1 text-[10px] leading-snug text-[var(--ff-text-muted)]">
                      {screen.purpose}
                    </p>
                    {screen.primaryAction && (
                      <p className="mt-1 text-[9px] text-[var(--ff-text-dim)]">
                        <span className="ff-label font-bold">CTA</span> · {screen.primaryAction}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            <section aria-label="Flows">
              <SubHeading icon={GitBranch} title="Flows" count={spec.flows.length} />
              {spec.flows.length === 0 ? (
                <p className="rounded-lg border-2 border-dashed border-[var(--ff-border)] px-3 py-3 text-center text-[10px] text-[var(--ff-text-muted)]">
                  No explicit flows — navigation is screen-local.
                </p>
              ) : (
                <ul role="list" className="space-y-1.5">
                  {spec.flows.map((flow) => (
                    <li
                      key={flow.id}
                      className="rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] px-2.5 py-2"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Route size={12} aria-hidden className="shrink-0 text-[var(--ff-text-muted)]" />
                        <span className="text-[11px] font-semibold text-[var(--ff-text)]">
                          {flow.name}
                        </span>
                        <span className="ff-label ml-auto text-[8px] font-bold text-[var(--ff-text-dim)]">
                          {flow.steps.length} steps
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {flow.steps.map((step, index) => (
                          <span key={`${step.screenId}-${index}`} className="flex items-center gap-1">
                            <code
                              title={step.action}
                              className="rounded border border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-1.5 py-0.5 font-mono text-[8px] text-[var(--ff-text-muted)]"
                            >
                              {step.screenId}
                            </code>
                            {index < flow.steps.length - 1 && (
                              <ArrowRight
                                size={8}
                                aria-hidden
                                className="text-[var(--ff-text-dim)]"
                              />
                            )}
                          </span>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Design tokens">
              <SubHeading icon={Palette} title="Design tokens" />
              <div className="rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)] p-2.5">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="size-6 shrink-0 rounded-full border-2 border-[var(--ff-border)]"
                      style={{ background: spec.design.seedColor }}
                    />
                    <div className="min-w-0">
                      <p className="ff-label text-[8px] font-bold text-[var(--ff-text-dim)]">
                        Seed
                      </p>
                      <code className="font-mono text-[10px] font-semibold uppercase text-[var(--ff-text)]">
                        {spec.design.seedColor}
                      </code>
                    </div>
                  </div>
                  <div>
                    <p className="ff-label text-[8px] font-bold text-[var(--ff-text-dim)]">
                      Radii sm→xl
                    </p>
                    <p className="font-mono text-[10px] font-semibold text-[var(--ff-text)]">
                      {spec.design.radii.sm} / {spec.design.radii.md} / {spec.design.radii.lg} /{' '}
                      {spec.design.radii.xl} px
                    </p>
                  </div>
                  <div>
                    <p className="ff-label text-[8px] font-bold text-[var(--ff-text-dim)]">
                      Motion
                    </p>
                    <p className="flex items-center gap-1 font-mono text-[10px] font-semibold text-[var(--ff-text)]">
                      <Timer size={10} aria-hidden className="text-[var(--ff-text-muted)]" />
                      {spec.design.motionMs} ms
                    </p>
                  </div>
                  <div>
                    <p className="ff-label text-[8px] font-bold text-[var(--ff-text-dim)]">
                      Shape · theme
                    </p>
                    <p className="text-[10px] font-semibold capitalize text-[var(--ff-text)]">
                      {spec.design.shape} · {spec.design.brightness}
                    </p>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      )}
    </section>
  );
}

interface QualityEvidenceProps {
  report: QualityReport | null;
  eventScore: EventScore | null;
  loading: boolean;
  error: string | null;
  canLoad: boolean;
  onLoad: () => void;
}

const FINDING_FILTERS: ReadonlyArray<{ value: 'all' | QualitySeverity; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'error', label: 'Errors' },
  { value: 'warning', label: 'Warnings' },
  { value: 'info', label: 'Info' },
];

function QualityEvidence({
  report,
  eventScore,
  loading,
  error,
  canLoad,
  onLoad,
}: QualityEvidenceProps) {
  const [filter, setFilter] = useState<'all' | QualitySeverity>('all');
  const findings = useMemo(() => report?.findings ?? [], [report]);
  const total = report?.total ?? eventScore?.total ?? null;
  const grade = report?.grade ?? eventScore?.grade ?? null;

  const counts = useMemo(
    () => ({
      all: findings.length,
      error: findings.filter((finding) => finding.severity === 'error').length,
      warning: findings.filter((finding) => finding.severity === 'warning').length,
      info: findings.filter((finding) => finding.severity === 'info').length,
    }),
    [findings],
  );

  const visibleFindings = useMemo(
    () => (filter === 'all' ? findings : findings.filter((finding) => finding.severity === filter)),
    [filter, findings],
  );

  return (
    <section aria-label="Quality evidence" className="space-y-2">
      <PanelHeading
        step="03"
        title="Quality"
        aside={
          <>
            {report && (
              <span className="ff-label hidden text-[8px] font-bold text-[var(--ff-text-dim)] sm:inline">
                scored {timeAgo(report.generatedAt)}
              </span>
            )}
            <button
              type="button"
              onClick={onLoad}
              disabled={!canLoad || loading}
              aria-label="Refresh quality report"
              title="Refresh quality report"
              className={cn(
                'rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] p-1.5 text-[var(--ff-text)] transition-colors hover:bg-[var(--ff-surface-2)] disabled:opacity-50',
                FOCUS_RING,
              )}
            >
              <RefreshCw
                size={12}
                aria-hidden
                className={cn(loading && 'animate-spin')}
              />
            </button>
          </>
        }
      />

      <div
        aria-busy={loading ? true : undefined}
        className="rounded-xl border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] p-3"
      >
        {loading && total === null ? (
          <div aria-label="Loading quality report" className="space-y-2">
            <div className="flex items-center gap-3">
              <div className="size-28 shrink-0 animate-pulse rounded-full border-8 border-[var(--ff-surface-2)]" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--ff-surface-2)]" />
                <div className="h-3 w-full animate-pulse rounded bg-[var(--ff-surface-2)]" />
                <div className="h-3 w-4/5 animate-pulse rounded bg-[var(--ff-surface-2)]" />
              </div>
            </div>
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="h-8 animate-pulse rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)]"
              />
            ))}
            <p className="text-center text-[10px] text-[var(--ff-text-muted)]">
              Loading the quality report…
            </p>
          </div>
        ) : error && total === null ? (
          <div role="alert" className="rounded-lg border-2 border-[var(--ff-error)] px-3 py-2.5">
            <p className="flex items-start gap-2 text-[11px] font-medium leading-snug text-[var(--ff-text)]">
              <AlertTriangle
                size={13}
                aria-hidden
                className="mt-0.5 shrink-0 text-[var(--ff-error)]"
              />
              {error}
            </p>
            <button
              type="button"
              onClick={onLoad}
              disabled={!canLoad || loading}
              className={cn(
                'mt-2 inline-flex items-center gap-1.5 rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--ff-text)] transition-colors hover:bg-[var(--ff-surface)] disabled:opacity-50',
                FOCUS_RING,
              )}
            >
              <RefreshCw size={11} aria-hidden />
              Retry quality report
            </button>
          </div>
        ) : total === null || grade === null ? (
          <div className="flex flex-col items-center px-3 py-6 text-center">
            <Gauge size={27} aria-hidden className="mb-2 text-[var(--ff-text-dim)]" />
            <p className="text-sm font-semibold text-[var(--ff-text)]">No quality report yet</p>
            <p className="mx-auto mt-1 max-w-sm text-[11px] leading-snug text-[var(--ff-text-muted)]">
              Scoring runs after emission. Forge the app to collect architecture, design,
              reliability and test evidence against the top-app rubric.
            </p>
            {canLoad && (
              <button
                type="button"
                onClick={onLoad}
                disabled={loading}
                className={cn(
                  'mt-3 inline-flex items-center gap-1.5 rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--ff-text)] transition-colors hover:bg-[var(--ff-surface)] disabled:opacity-50',
                  FOCUS_RING,
                )}
              >
                {loading ? (
                  <Loader2 size={12} aria-hidden className="animate-spin" />
                ) : (
                  <Gauge size={12} aria-hidden />
                )}
                {loading ? 'Checking…' : 'Check for report'}
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <GradeRing total={total} grade={grade} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="ff-display text-lg font-bold text-[var(--ff-text)]">
                    Grade {grade}
                  </p>
                  <span
                    className="inline-flex items-center rounded-full border-2 border-[var(--ff-border)] px-2 py-0.5 text-[8px] font-black uppercase tracking-[0.1em]"
                    style={{ color: gradeColor(grade) }}
                  >
                    {total >= MIN_TOP_APP_QUALITY ? 'Above floor' : 'Below floor'}
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-snug text-[var(--ff-text-muted)]">
                  {qualityVerdict(total)}
                </p>
                {report ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {[
                      { label: 'files', value: report.stats.files },
                      { label: 'entities', value: report.stats.entities },
                      { label: 'screens', value: report.stats.screens },
                      { label: 'tests', value: report.stats.tests },
                      { label: 'size', value: formatBytes(report.stats.bytes) },
                    ].map((stat) => (
                      <span
                        key={stat.label}
                        className="inline-flex items-center gap-1 rounded-md border border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--ff-text-muted)]"
                      >
                        <span className="font-mono text-[10px] font-bold text-[var(--ff-text)]">
                          {stat.value}
                        </span>
                        {stat.label}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-[10px] text-[var(--ff-text-dim)]">
                    Score streamed from the run — load the full report for categories and
                    findings.{' '}
                    <button
                      type="button"
                      onClick={onLoad}
                      disabled={!canLoad || loading}
                      className={cn(
                        'font-bold text-[var(--ff-text)] underline underline-offset-2 disabled:opacity-50',
                        FOCUS_RING,
                      )}
                    >
                      Load report
                    </button>
                  </p>
                )}
              </div>
            </div>

            {report && (
              <div className="mt-3 border-t-2 border-[var(--ff-border)] pt-2.5">
                <SubHeading icon={ListChecks} title="Categories" count={QUALITY_CATEGORIES.length} />
                <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
                  {QUALITY_CATEGORIES.map((category) => {
                    const raw = report.categories[category];
                    const value = typeof raw === 'number' ? clampScore(raw) : 0;
                    return (
                      <div key={category} className="flex items-center gap-2">
                        <span className="w-[86px] shrink-0 text-[10px] font-medium text-[var(--ff-text-muted)]">
                          {CATEGORY_LABEL[category]}
                        </span>
                        <div
                          role="progressbar"
                          aria-label={`${CATEGORY_LABEL[category]} score`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={value}
                          className="h-2 min-w-0 flex-1 overflow-hidden rounded-full border border-[var(--ff-border)] bg-[var(--ff-surface-2)]"
                        >
                          <div
                            className="h-full rounded-full transition-[width] duration-500"
                            style={{ width: `${value}%`, background: scoreTone(value) }}
                          />
                        </div>
                        <span className="w-6 shrink-0 text-right font-mono text-[9px] font-bold text-[var(--ff-text)]">
                          {value}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {report && (
              <div className="mt-3 border-t-2 border-[var(--ff-border)] pt-2.5">
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="ff-label text-[9px] font-bold text-[var(--ff-text-muted)]">
                    Findings
                  </span>
                  {FINDING_FILTERS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setFilter(option.value)}
                      aria-pressed={filter === option.value}
                      className={cn(
                        'rounded-full border-2 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-[0.08em] transition-colors',
                        filter === option.value
                          ? 'border-[var(--ff-border)] bg-[var(--ff-primary)] text-[var(--ff-bg)]'
                          : 'border-transparent text-[var(--ff-text-muted)] hover:border-[var(--ff-border)] hover:text-[var(--ff-text)]',
                        FOCUS_RING,
                      )}
                    >
                      {option.label}{' '}
                      <span className="font-mono opacity-70">{counts[option.value]}</span>
                    </button>
                  ))}
                </div>

                {findings.length === 0 ? (
                  <p className="flex items-center gap-1.5 rounded-lg border-2 border-[var(--ff-success)] px-2.5 py-2 text-[10px] font-semibold text-[var(--ff-text)]">
                    <ShieldCheck size={12} aria-hidden className="text-[var(--ff-success)]" />
                    No findings — clean report.
                  </p>
                ) : visibleFindings.length === 0 ? (
                  <p className="rounded-lg border-2 border-dashed border-[var(--ff-border)] px-2.5 py-2 text-center text-[10px] text-[var(--ff-text-muted)]">
                    No {filter} findings. Switch the filter to see the other{' '}
                    {findings.length} finding{findings.length === 1 ? '' : 's'}.
                  </p>
                ) : (
                  <ul
                    role="list"
                    aria-label="Quality findings"
                    className="ff-scrollbar max-h-56 space-y-1 overflow-y-auto pr-0.5"
                  >
                    {visibleFindings.map((finding, index) => (
                      <FindingRow key={`${finding.code}-${index}`} finding={finding} />
                    ))}
                  </ul>
                )}
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border-2 border-[var(--ff-error)] px-2.5 py-1.5"
              >
                <AlertTriangle size={12} aria-hidden className="shrink-0 text-[var(--ff-error)]" />
                <p className="min-w-0 flex-1 text-[10px] text-[var(--ff-text)]">{error}</p>
                <button
                  type="button"
                  onClick={onLoad}
                  disabled={!canLoad || loading}
                  className={cn(
                    'rounded-md border-2 border-[var(--ff-border)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-[var(--ff-text)] disabled:opacity-50',
                    FOCUS_RING,
                  )}
                >
                  Retry
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function FindingRow({ finding }: { finding: QualityFinding }) {
  const meta = SEVERITY_META[finding.severity];
  const Icon = meta.icon;
  return (
    <li className="flex items-start gap-2 rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] px-2 py-1.5">
      <Icon size={12} aria-hidden className={cn('mt-0.5 shrink-0', meta.text)} />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] leading-snug text-[var(--ff-text)]">{finding.message}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[8px] text-[var(--ff-text-dim)]">
          <span className="ff-label font-bold">{CATEGORY_LABEL[finding.category]}</span>
          <code className="font-mono">{finding.code}</code>
          {finding.path && (
            <code className="min-w-0 truncate font-mono" title={finding.path}>
              {finding.path}
            </code>
          )}
        </p>
      </div>
      <span
        className={cn(
          'shrink-0 rounded-full border-2 border-[var(--ff-border)] px-1.5 py-0.5 text-[7px] font-black uppercase tracking-[0.1em]',
          meta.chip,
        )}
      >
        {meta.label}
      </span>
    </li>
  );
}

function GatePanel({ gates }: { gates: GateRow[] }) {
  const passed = gates.filter((gate) => gate.passed === true).length;
  const failed = gates.filter((gate) => gate.passed === false).length;

  return (
    <section aria-label="Hard gates" className="space-y-2">
      <PanelHeading
        step="04"
        title="Hard gates"
        aside={
          <span
            className={cn(
              'inline-flex items-center rounded-full border-2 border-[var(--ff-border)] px-2 py-0.5 text-[8px] font-black uppercase tracking-[0.1em]',
              failed > 0
                ? 'bg-[var(--ff-studio-pink)] text-[#57112b]'
                : passed === gates.length
                  ? 'bg-[var(--ff-studio-mint)] text-[#0f3a2c]'
                  : 'bg-[var(--ff-surface-2)] text-[var(--ff-text-muted)]',
            )}
          >
            {failed > 0 ? `${failed} blocked` : `${passed} / ${gates.length} passed`}
          </span>
        }
      />
      <ul
        role="list"
        aria-label="Gate results"
        className="divide-y-2 divide-[var(--ff-border)] overflow-hidden rounded-xl border-2 border-[var(--ff-border)] bg-[var(--ff-surface)]"
      >
        {gates.map((gate) => {
          const Icon =
            gate.passed === true ? CheckCircle2 : gate.passed === false ? XCircle : CircleDashed;
          return (
            <li key={gate.id} className="flex items-start gap-2 px-3 py-2">
              <Icon
                size={14}
                aria-hidden
                className={cn(
                  'mt-0.5 shrink-0',
                  gate.passed === true
                    ? 'text-[var(--ff-success)]'
                    : gate.passed === false
                      ? 'text-[var(--ff-error)]'
                      : 'text-[var(--ff-text-dim)]',
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-bold text-[var(--ff-text)]">{gate.label}</span>
                  <span
                    className={cn(
                      'ff-label text-[8px] font-bold',
                      gate.passed === true
                        ? 'text-[var(--ff-success)]'
                        : gate.passed === false
                          ? 'text-[var(--ff-error)]'
                          : 'text-[var(--ff-text-dim)]',
                    )}
                  >
                    {gate.passed === true
                      ? 'Passed'
                      : gate.passed === false
                        ? 'Failed'
                        : 'Awaiting evidence'}
                  </span>
                </div>
                {gate.blockers.length > 0 && (
                  <ul role="list" className="mt-1 space-y-0.5">
                    {gate.blockers.map((blocker, index) => (
                      <li
                        key={`${gate.id}-${index}`}
                        className="flex items-start gap-1 text-[10px] leading-snug text-[var(--ff-error)]"
                      >
                        <span aria-hidden className="font-bold">
                          ·
                        </span>
                        {blocker}
                      </li>
                    ))}
                  </ul>
                )}
                {gate.detail && gate.blockers.length === 0 && (
                  <p className="mt-0.5 text-[10px] leading-snug text-[var(--ff-text-muted)]">
                    {gate.detail}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface RunPanelProps {
  run: GenerationRun | null;
  events: GenerationRunEvent[];
  loadingEvents: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onRetryForge: () => void;
  retryDisabled: boolean;
}

function RunPanel({
  run,
  events,
  loadingEvents,
  refreshing,
  onRefresh,
  onRetryForge,
  retryDisabled,
}: RunPanelProps) {
  const timelineRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const node = timelineRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [events.length]);

  const live = run ? isRunActive(run.status) : false;

  return (
    <section aria-label="Workflow run" className="space-y-2">
      <PanelHeading
        step="05"
        title="Run"
        aside={
          <button
            type="button"
            onClick={onRefresh}
            disabled={!run || refreshing}
            aria-label="Refresh run and events"
            title="Refresh run and events"
            className={cn(
              'rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] p-1.5 text-[var(--ff-text)] transition-colors hover:bg-[var(--ff-surface-2)] disabled:opacity-50',
              FOCUS_RING,
            )}
          >
            <RefreshCw
              size={12}
              aria-hidden
              className={cn(refreshing && 'animate-spin')}
            />
          </button>
        }
      />

      <div
        aria-busy={loadingEvents || refreshing ? true : undefined}
        className="overflow-hidden rounded-xl border-2 border-[var(--ff-border)] bg-[var(--ff-surface)]"
      >
        {!run ? (
          <div className="px-4 py-6 text-center">
            <Hammer size={26} aria-hidden className="mx-auto mb-2 text-[var(--ff-text-dim)]" />
            <p className="text-sm font-semibold text-[var(--ff-text)]">No run yet</p>
            <p className="mx-auto mt-1 max-w-sm text-[11px] leading-snug text-[var(--ff-text-muted)]">
              Forge app starts a durable <code className="font-mono">prompt.to.app</code> run. Every
              stage emits evidence you can audit.
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-1">
              {['Spec', 'Emit', 'Score', 'Verify', 'Seal'].map((step, index) => (
                <span key={step} className="flex items-center gap-1">
                  <span className="rounded-full border-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-2 py-0.5 text-[8px] font-black uppercase tracking-[0.1em] text-[var(--ff-text-muted)]">
                    {step}
                  </span>
                  {index < 4 && (
                    <ArrowRight size={9} aria-hidden className="text-[var(--ff-text-dim)]" />
                  )}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-3 py-2">
              <StatusChip status={run.status} />
              {live && (
                <span className="inline-flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.08em] text-[var(--ff-success)]">
                  <span
                    aria-hidden
                    className="size-1.5 animate-pulse rounded-full bg-[var(--ff-success)]"
                  />
                  Live · polling every 2s
                </span>
              )}
              <code
                className="ml-auto min-w-0 truncate font-mono text-[9px] text-[var(--ff-text-dim)]"
                title={run.id}
              >
                {shortId(run.id)}
              </code>
              <span className="text-[9px] text-[var(--ff-text-dim)]">
                updated {timeAgo(run.updatedAt)}
              </span>
            </div>

            {run.status === 'failed' && (
              <div
                role="alert"
                className="mx-2.5 mt-2.5 rounded-lg border-2 border-[var(--ff-error)] px-2.5 py-2"
                style={{
                  background: 'color-mix(in srgb, var(--ff-error) 10%, var(--ff-surface))',
                }}
              >
                <p className="flex items-start gap-2 text-[11px] font-medium leading-snug text-[var(--ff-text)]">
                  <AlertTriangle
                    size={13}
                    aria-hidden
                    className="mt-0.5 shrink-0 text-[var(--ff-error)]"
                  />
                  {run.error?.message ?? 'The pipeline failed before sealing the workspace.'}
                </p>
                <button
                  type="button"
                  onClick={onRetryForge}
                  disabled={retryDisabled}
                  className={cn(
                    'mt-2 inline-flex items-center gap-1.5 rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--ff-text)] transition-colors hover:bg-[var(--ff-surface-2)] disabled:opacity-50',
                    FOCUS_RING,
                  )}
                >
                  <Hammer size={11} aria-hidden />
                  Retry forge
                </button>
              </div>
            )}

            {run.status === 'waiting_approval' && (
              <p className="mx-2.5 mt-2.5 flex items-start gap-2 rounded-lg border-2 border-[var(--ff-warning)] px-2.5 py-2 text-[10px] leading-snug text-[var(--ff-text)]">
                <ShieldAlert
                  size={13}
                  aria-hidden
                  className="mt-0.5 shrink-0 text-[var(--ff-warning)]"
                />
                This run is waiting for a human approval before it can continue.
              </p>
            )}

            {loadingEvents && events.length === 0 ? (
              <div aria-label="Loading run events" className="space-y-1.5 p-3">
                {[0, 1, 2, 3].map((index) => (
                  <div
                    key={index}
                    className="h-9 animate-pulse rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)]"
                  />
                ))}
                <p className="text-center text-[10px] text-[var(--ff-text-muted)]">
                  Waiting for pipeline events…
                </p>
              </div>
            ) : events.length === 0 ? (
              <p className="px-3 py-5 text-center text-[10px] leading-snug text-[var(--ff-text-muted)]">
                {run.status === 'succeeded'
                  ? 'Run sealed without recorded events.'
                  : run.status === 'failed'
                    ? 'No events were recorded before the failure.'
                    : run.status === 'cancelled'
                      ? 'Run cancelled before emitting events.'
                      : 'Pipeline is warming up — events will appear here.'}
              </p>
            ) : (
              <ol
                ref={timelineRef}
                role="list"
                aria-label="Run timeline"
                className="ff-scrollbar max-h-72 space-y-0 overflow-y-auto p-3"
              >
                {events.map((event, index) => {
                  const detail = eventDetail(event);
                  return (
                    <li
                      key={`${event.seq}-${event.type}-${index}`}
                      className="relative flex gap-2 pb-2.5 last:pb-0"
                    >
                      <div className="flex flex-col items-center">
                        <span
                          aria-hidden
                          className={cn(
                            'mt-1 size-2 shrink-0 rounded-full border-2',
                            eventTone(event.type),
                          )}
                        />
                        {index < events.length - 1 && (
                          <span
                            aria-hidden
                            className="mt-0.5 w-px flex-1 bg-[var(--ff-border)]"
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <p className="text-[11px] font-semibold leading-snug text-[var(--ff-text)]">
                            {eventLabel(event.type)}
                          </p>
                          <time
                            dateTime={new Date(event.createdAt).toISOString()}
                            className="ml-auto shrink-0 font-mono text-[8px] text-[var(--ff-text-dim)]"
                          >
                            {formatTime(event.createdAt)}
                          </time>
                        </div>
                        {detail && (
                          <p className="mt-0.5 text-[10px] leading-snug text-[var(--ff-text-muted)]">
                            {detail}
                          </p>
                        )}
                        <p className="mt-0.5 font-mono text-[8px] text-[var(--ff-text-dim)]">
                          {event.type}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-3 py-1.5">
              <span className="ff-label text-[8px] font-bold text-[var(--ff-text-dim)]">
                {run.definition}
              </span>
              <span className="ff-label text-[8px] font-bold text-[var(--ff-text-dim)]">
                {events.length} event{events.length === 1 ? '' : 's'} · {timeAgo(run.updatedAt)}
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

interface BenchmarkPanelProps {
  benchmarks: GenerationBenchmark[];
  loading: boolean;
  error: string | null;
  onLoad: () => void;
}

function BenchmarkPanel({ benchmarks, loading, error, onLoad }: BenchmarkPanelProps) {
  return (
    <section
      aria-label="Benchmark corpus"
      className="overflow-hidden rounded-xl border-2 border-[var(--ff-border)] bg-[var(--ff-surface)]"
    >
      <div className="flex items-center gap-2 border-b-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-3 py-2">
        <ListChecks size={13} aria-hidden className="shrink-0 text-[var(--ff-text-muted)]" />
        <h3 className="ff-label text-[9px] font-bold text-[var(--ff-text-muted)]">
          Benchmark corpus
        </h3>
        <span className="ff-studio-badge">{benchmarks.length}</span>
        <span className="ml-auto ff-label text-[8px] font-bold text-[var(--ff-text-dim)]">
          metadata only
        </span>
      </div>
      <div className="p-2.5">
        {loading && benchmarks.length === 0 ? (
          <div aria-label="Loading benchmark corpus" className="space-y-1.5">
            {[0, 1].map((index) => (
              <div
                key={index}
                className="h-6 animate-pulse rounded border border-[var(--ff-border)] bg-[var(--ff-surface-2)]"
              />
            ))}
          </div>
        ) : error ? (
          <div role="alert" className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-[10px] leading-snug text-[var(--ff-warning)]">
              {error}
            </p>
            <button
              type="button"
              onClick={onLoad}
              disabled={loading}
              className={cn(
                'rounded-md border-2 border-[var(--ff-border)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-[var(--ff-text)] transition-colors hover:bg-[var(--ff-surface-2)] disabled:opacity-50',
                FOCUS_RING,
              )}
            >
              Retry
            </button>
          </div>
        ) : benchmarks.length === 0 ? (
          <p className="text-[10px] text-[var(--ff-text-muted)]">
            No benchmark metadata published by this platform build.
          </p>
        ) : (
          <>
            <ul role="list" aria-label="Benchmark prompts" className="space-y-1">
              {benchmarks.slice(0, 3).map((benchmark) => (
                <li key={benchmark.id} className="flex items-start gap-2">
                  <code className="shrink-0 rounded border border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-1 py-0.5 font-mono text-[8px] text-[var(--ff-text-muted)]">
                    {benchmark.id}
                  </code>
                  <p
                    className="min-w-0 flex-1 truncate text-[10px] text-[var(--ff-text-muted)]"
                    title={benchmark.prompt}
                  >
                    {benchmark.prompt || 'No prompt metadata'}
                  </p>
                </li>
              ))}
            </ul>
            {benchmarks.length > 3 && (
              <p className="mt-1 text-[9px] text-[var(--ff-text-dim)]">
                +{benchmarks.length - 3} more prompts in the corpus
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function GenerationStudio({ projectId, className }: GenerationStudioProps) {
  const currentProject = useProjectStore((store) => store.currentProject);
  const prompt = useGenerationStore((state) => state.prompt);
  const appName = useGenerationStore((state) => state.appName);
  const seedColor = useGenerationStore((state) => state.seedColor);
  const backend = useGenerationStore((state) => state.backend);
  const domain = useGenerationStore((state) => state.domain);
  const target = useGenerationStore((state) => state.target);
  const spec = useGenerationStore((state) => state.spec);
  const validation = useGenerationStore((state) => state.validation);
  const quality = useGenerationStore((state) => state.quality);
  const run = useGenerationStore((state) => state.run);
  const events = useGenerationStore((state) => state.events);
  const benchmarks = useGenerationStore((state) => state.benchmarks);
  const error = useGenerationStore((state) => state.error);
  const qualityError = useGenerationStore((state) => state.qualityError);
  const benchmarksError = useGenerationStore((state) => state.benchmarksError);
  const failure = useGenerationStore((state) => state.failure);
  const compiling = useGenerationStore((state) => state.compiling);
  const forging = useGenerationStore((state) => state.forging);
  const refreshingRun = useGenerationStore((state) => state.refreshingRun);
  const loadingEvents = useGenerationStore((state) => state.loadingEvents);
  const loadingQuality = useGenerationStore((state) => state.loadingQuality);
  const loadingBenchmarks = useGenerationStore((state) => state.loadingBenchmarks);
  const updateOptions = useGenerationStore((state) => state.updateOptions);
  const setPrompt = useGenerationStore((state) => state.setPrompt);
  const compile = useGenerationStore((state) => state.compile);
  const forge = useGenerationStore((state) => state.forge);
  const refreshRun = useGenerationStore((state) => state.refreshRun);
  const loadQuality = useGenerationStore((state) => state.loadQuality);
  const loadBenchmarks = useGenerationStore((state) => state.loadBenchmarks);
  const reset = useGenerationStore((state) => state.reset);
  const clearError = useGenerationStore((state) => state.clearError);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const benchmarksRequested = useRef(false);
  const qualityRequestedFor = useRef<string | null>(null);

  const effectiveProjectId = projectId?.trim() || currentProject?.id || null;
  const runLive = run !== null && !isRunSettled(run.status);
  const canCompile = prompt.trim().length > 0 && !compiling;
  const canForge =
    prompt.trim().length > 0 && !forging && !runLive && Boolean(effectiveProjectId);
  const seedValid = /^#[0-9a-f]{6}$/i.test(seedColor.trim());

  const eventScore = useMemo(() => scoreFromEvents(events), [events]);
  const gates = useMemo(
    () => deriveGates(validation, quality, events, run),
    [validation, quality, events, run],
  );
  const readinessCopy = validation
    ? validation.ok
      ? 'Spec validated — ready to forge.'
      : `Compiled with ${validation.errors.length} structural issue${
          validation.errors.length === 1 ? '' : 's'
        }. Forge still runs the hard gates.`
    : effectiveProjectId
      ? '⌘/Ctrl + Enter compiles. Forge writes the app into the open project.'
      : '⌘/Ctrl + Enter compiles. Open a project to enable forging.';
  const retryLabel =
    failure === 'compile'
      ? 'Retry compile'
      : failure === 'forge'
        ? 'Retry forge'
        : failure === 'run'
          ? 'Refresh run'
          : 'Try again';

  useEffect(() => {
    if (benchmarksRequested.current) return;
    benchmarksRequested.current = true;
    void loadBenchmarks();
  }, [loadBenchmarks]);

  useEffect(() => {
    if (!effectiveProjectId || qualityRequestedFor.current === effectiveProjectId) return;
    qualityRequestedFor.current = effectiveProjectId;
    void loadQuality(effectiveProjectId);
  }, [effectiveProjectId, loadQuality]);

  useEffect(() => () => stopPolling(), []);

  function handleCompile(): void {
    void compile();
  }

  function handleForge(): void {
    if (!effectiveProjectId) return;
    void forge(effectiveProjectId);
  }

  function handleRetry(): void {
    if (failure === 'compile') {
      void compile();
      return;
    }
    if (failure === 'forge') {
      void forge(effectiveProjectId ?? '');
      return;
    }
    if (failure === 'run') void refreshRun();
  }

  function handleLoadQuality(): void {
    void loadQuality(effectiveProjectId ?? undefined);
  }

  function applyExample(examplePrompt: string): void {
    setPrompt(examplePrompt);
    textareaRef.current?.focus();
  }

  return (
    <section
      aria-label="Generation studio"
      className={cn(
        'ff-studio flex h-full min-h-0 flex-col overflow-hidden rounded-xl border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] text-[var(--ff-text)]',
        className,
      )}
      style={{ boxShadow: 'var(--ff-studio-shadow)' }}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-4 py-2.5">
        <Sparkles size={17} aria-hidden className="shrink-0 text-[var(--ff-text)]" />
        <h2 className="ff-display text-[15px] font-bold leading-none text-[var(--ff-text)]">
          Generation studio
        </h2>
        <span className="hidden items-center gap-1 text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--ff-text-dim)] sm:inline-flex">
          prompt <ArrowRight size={9} aria-hidden /> spec <ArrowRight size={9} aria-hidden /> seal
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {run && <StatusChip status={run.status} />}
          <button
            type="button"
            onClick={reset}
            disabled={!prompt && !spec && !run && !quality}
            aria-label="Start over with a new brief"
            title="Start over with a new brief"
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--ff-text-muted)] transition-colors hover:text-[var(--ff-text)] disabled:opacity-50',
              FOCUS_RING,
            )}
          >
            <RotateCcw size={12} aria-hidden />
            Start over
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(320px,0.82fr)_minmax(0,1.6fr)] lg:overflow-hidden">
        {/* ── Brief column ─────────────────────────────────────────── */}
        <div className="ff-scrollbar min-h-0 space-y-3 border-b-2 border-[var(--ff-border)] p-3 lg:overflow-y-auto lg:border-b-0 lg:border-r-2">
          <section aria-label="Brief composer" className="space-y-2">
            <PanelHeading
              step="01"
              title="Brief"
              aside={
                <span className="ff-label text-[8px] font-bold text-[var(--ff-text-dim)]">
                  plain language in
                </span>
              }
            />

            <div className="space-y-3 rounded-xl border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] p-3">
              <div>
                <label
                  htmlFor="ff-generation-prompt"
                  className="ff-label mb-1 block text-[9px] font-bold text-[var(--ff-text-muted)]"
                >
                  App brief
                </label>
                <textarea
                  id="ff-generation-prompt"
                  ref={textareaRef}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      handleCompile();
                    }
                  }}
                  maxLength={PROMPT_LIMIT}
                  aria-describedby="ff-generation-help ff-generation-count"
                  placeholder="A calm note-taking app for hikers: trail notes with photos, offline drafts, pinned trips and search by trail name."
                  className="ff-input ff-scrollbar min-h-[142px] w-full resize-y px-3 py-2.5 text-sm leading-relaxed placeholder:text-[var(--ff-text-dim)]"
                />
                <div className="mt-1 flex items-center justify-between gap-2">
                  <p id="ff-generation-help" className="text-[10px] leading-snug text-[var(--ff-text-muted)]">
                    Name the people, the core objects and the one job the app should do best.
                  </p>
                  <span
                    id="ff-generation-count"
                    className="ff-label shrink-0 text-[8px] font-bold text-[var(--ff-text-dim)]"
                  >
                    {prompt.length.toLocaleString()} / {PROMPT_LIMIT.toLocaleString()}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5" aria-label="Example briefs">
                <span className="ff-label text-[8px] font-bold text-[var(--ff-text-dim)]">
                  Try
                </span>
                {EXAMPLES.map((example) => {
                  const Icon = example.icon;
                  const active = prompt === example.prompt;
                  return (
                    <button
                      key={example.label}
                      type="button"
                      onClick={() => applyExample(example.prompt)}
                      aria-label={`Use ${example.label} example brief`}
                      aria-pressed={active}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border-2 px-2 py-0.5 text-[9px] font-bold transition-colors',
                        active
                          ? 'border-[var(--ff-border)] bg-[var(--ff-studio-yellow)] text-[#4a3a00]'
                          : 'border-[var(--ff-border)] bg-[var(--ff-surface-2)] text-[var(--ff-text-muted)] hover:text-[var(--ff-text)]',
                        FOCUS_RING,
                      )}
                    >
                      <Icon size={10} aria-hidden />
                      {example.label}
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="ff-generation-app-name"
                    className="ff-label mb-1 block text-[9px] font-bold text-[var(--ff-text-muted)]"
                  >
                    App name{' '}
                    <span className="font-medium normal-case tracking-normal text-[var(--ff-text-dim)]">
                      optional
                    </span>
                  </label>
                  <input
                    id="ff-generation-app-name"
                    value={appName}
                    onChange={(event) => updateOptions({ appName: event.target.value })}
                    maxLength={80}
                    placeholder="Trail Notes"
                    className="ff-input w-full px-2.5 py-2 text-xs"
                  />
                </div>

                <div>
                  <label
                    htmlFor="ff-generation-seed"
                    className="ff-label mb-1 block text-[9px] font-bold text-[var(--ff-text-muted)]"
                  >
                    Seed color
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      id="ff-generation-seed"
                      type="color"
                      value={seedValid ? seedColor : '#26bac1'}
                      onChange={(event) => updateOptions({ seedColor: event.target.value })}
                      aria-label="Seed color swatch"
                      className={cn(
                        'size-8 shrink-0 cursor-pointer rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] p-0.5',
                        FOCUS_RING,
                      )}
                    />
                    <input
                      value={seedColor}
                      onChange={(event) => updateOptions({ seedColor: event.target.value })}
                      maxLength={7}
                      spellCheck={false}
                      aria-label="Seed color hex"
                      aria-invalid={!seedValid}
                      className={cn(
                        'ff-input min-w-0 flex-1 px-2 py-1.5 font-mono text-[11px] uppercase',
                        !seedValid && 'border-[var(--ff-error)]',
                      )}
                    />
                  </div>
                  {!seedValid && (
                    <p className="mt-0.5 text-[9px] text-[var(--ff-error)]">
                      Use a six-digit hex such as #26bac1.
                    </p>
                  )}
                </div>

                <div>
                  <label
                    htmlFor="ff-generation-backend"
                    className="ff-label mb-1 block text-[9px] font-bold text-[var(--ff-text-muted)]"
                  >
                    Backend
                  </label>
                  <select
                    id="ff-generation-backend"
                    value={backend}
                    onChange={(event) =>
                      updateOptions({ backend: event.target.value as GenerationBackend })
                    }
                    className="ff-input w-full px-2.5 py-2 text-xs"
                  >
                    {BACKEND_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="ff-generation-target"
                    className="ff-label mb-1 block text-[9px] font-bold text-[var(--ff-text-muted)]"
                  >
                    Target
                  </label>
                  <select
                    id="ff-generation-target"
                    value={target}
                    onChange={(event) =>
                      updateOptions({ target: event.target.value as GenerationTarget })
                    }
                    className="ff-input w-full px-2.5 py-2 text-xs"
                  >
                    {TARGET_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label
                    htmlFor="ff-generation-domain"
                    className="ff-label mb-1 block text-[9px] font-bold text-[var(--ff-text-muted)]"
                  >
                    Domain
                  </label>
                  <select
                    id="ff-generation-domain"
                    value={domain}
                    onChange={(event) =>
                      updateOptions({ domain: event.target.value as GenerationDomain })
                    }
                    className="ff-input w-full px-2.5 py-2 text-xs"
                  >
                    {DOMAIN_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-2 py-1.5">
                <ShieldCheck size={12} aria-hidden className="shrink-0 text-[var(--ff-success)]" />
                <p className="text-[10px] leading-snug text-[var(--ff-text-muted)]">
                  Forge enforces a quality floor of{' '}
                  <strong className="font-bold text-[var(--ff-text)]">
                    {MIN_TOP_APP_QUALITY}
                  </strong>{' '}
                  before the workspace is sealed.
                </p>
              </div>

              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border-2 border-[var(--ff-error)] px-2.5 py-2"
                  style={{
                    background: 'color-mix(in srgb, var(--ff-error) 10%, var(--ff-surface))',
                  }}
                >
                  <AlertTriangle
                    size={13}
                    aria-hidden
                    className="mt-0.5 shrink-0 text-[var(--ff-error)]"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-medium leading-snug text-[var(--ff-text)]">
                      {error}
                    </p>
                    {failure && (
                      <button
                        type="button"
                        onClick={handleRetry}
                        className={cn(
                          'mt-1.5 inline-flex items-center gap-1 rounded-md border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-[var(--ff-text)] transition-colors hover:bg-[var(--ff-surface-2)]',
                          FOCUS_RING,
                        )}
                      >
                        <RefreshCw size={10} aria-hidden />
                        {retryLabel}
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={clearError}
                    aria-label="Dismiss error"
                    title="Dismiss error"
                    className={cn(
                      'shrink-0 rounded-md p-1 text-[var(--ff-text-muted)] transition-colors hover:text-[var(--ff-text)]',
                      FOCUS_RING,
                    )}
                  >
                    <X size={12} aria-hidden />
                  </button>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
                <button
                  type="button"
                  onClick={handleCompile}
                  disabled={!canCompile}
                  aria-busy={compiling}
                  className={cn(
                    'inline-flex items-center justify-center gap-1.5 rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--ff-text)] transition-colors hover:bg-[var(--ff-surface)] disabled:cursor-not-allowed disabled:opacity-50',
                    FOCUS_RING,
                  )}
                >
                  {compiling ? (
                    <Loader2 size={13} aria-hidden className="animate-spin" />
                  ) : (
                    <Wand2 size={13} aria-hidden />
                  )}
                  {compiling ? 'Compiling…' : 'Compile spec'}
                </button>
                <button
                  type="button"
                  onClick={handleForge}
                  disabled={!canForge}
                  aria-busy={forging}
                  className={cn(
                    'ff-btn-primary inline-flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.08em] disabled:cursor-not-allowed disabled:opacity-50',
                    FOCUS_RING,
                  )}
                >
                  {forging ? (
                    <Loader2 size={13} aria-hidden className="animate-spin" />
                  ) : (
                    <Hammer size={13} aria-hidden />
                  )}
                  {forging ? 'Forging…' : 'Forge app'}
                </button>
              </div>

              <p
                role="status"
                className={cn(
                  'flex items-start gap-1.5 text-[10px] leading-snug',
                  validation && !validation.ok
                    ? 'text-[var(--ff-warning)]'
                    : 'text-[var(--ff-text-muted)]',
                )}
              >
                {validation ? (
                  validation.ok ? (
                    <Check
                      size={11}
                      aria-hidden
                      strokeWidth={3}
                      className="mt-0.5 shrink-0 text-[var(--ff-success)]"
                    />
                  ) : (
                    <ShieldAlert
                      size={11}
                      aria-hidden
                      className="mt-0.5 shrink-0 text-[var(--ff-warning)]"
                    />
                  )
                ) : (
                  <span aria-hidden className="mt-1 size-1 shrink-0 rounded-full bg-current" />
                )}
                {readinessCopy}
              </p>
            </div>
          </section>

          <BenchmarkPanel
            benchmarks={benchmarks}
            loading={loadingBenchmarks}
            error={benchmarksError}
            onLoad={() => void loadBenchmarks()}
          />
        </div>

        {/* ── Evidence column ──────────────────────────────────────── */}
        <div className="ff-scrollbar min-h-0 space-y-3 p-3 lg:overflow-y-auto">
          <SpecPreview
            spec={spec}
            validation={validation}
            compiling={compiling}
            canCompile={canCompile}
            onCompile={handleCompile}
          />
          <QualityEvidence
            report={quality}
            eventScore={eventScore}
            loading={loadingQuality}
            error={qualityError}
            canLoad={Boolean(effectiveProjectId)}
            onLoad={handleLoadQuality}
          />
          <GatePanel gates={gates} />
          <RunPanel
            run={run}
            events={events}
            loadingEvents={loadingEvents}
            refreshing={refreshingRun}
            onRefresh={() => void refreshRun()}
            onRetryForge={handleForge}
            retryDisabled={!canForge}
          />
        </div>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-4 py-1.5">
        <span className="ff-label text-[8px] font-bold text-[var(--ff-text-dim)]">
          Durable pipeline · prompt.to.app · evidence before seal
        </span>
        <span className="ff-label text-[8px] font-bold text-[var(--ff-text-dim)]">
          {effectiveProjectId ? `project ${shortId(effectiveProjectId)}` : 'no project open'} ·
          local-first
        </span>
      </footer>
    </section>
  );
}




