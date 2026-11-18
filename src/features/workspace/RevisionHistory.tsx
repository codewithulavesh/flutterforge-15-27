import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  GitCommitHorizontal,
  GitCompare,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import {
  usePlatformStore,
  type ApprovalDecision,
  type PlatformApproval,
  type PlatformAuditEntry,
  type PlatformAuditVerification,
  type PlatformRevision,
} from '@/stores/platform.store';
import { useProjectStore } from '@/stores/project.store';

interface RevisionHistoryProps {
  /** Falls back to the open project from the project store when omitted. */
  projectId?: string;
  className?: string;
  onClose?: () => void;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function relativeTime(value: number | string): string {
  const time = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(time)) return 'unknown';
  const diff = Date.now() - time;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatKB(bytes: number): string {
  const kb = (Number(bytes) || 0) / 1024;
  return kb >= 100 ? `${Math.round(kb)} KB` : `${kb.toFixed(1)} KB`;
}

const shortHash = (id: string): string => id.slice(0, 10);

/** Pastel risk chips: lime → yellow → rose (critical is filled rose). */
const RISK_CHIP: Record<PlatformApproval['risk'], string> = {
  low: 'border-[var(--ff-border)] bg-[#e2f7a8] text-[#37420c]',
  medium: 'border-[var(--ff-border)] bg-[var(--ff-studio-yellow)] text-[#4a3a00]',
  high: 'border-[var(--ff-border)] bg-[var(--ff-studio-pink)] text-[#57112b]',
  critical: 'border-[var(--ff-border)] bg-[var(--ff-error)] text-[var(--ff-bg)]',
};

const RISK_LABEL: Record<PlatformApproval['risk'], string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
  critical: 'Critical risk',
};

/* ── component ───────────────────────────────────────────────────────────── */

export function RevisionHistory({ projectId, className, onClose }: RevisionHistoryProps) {
  const { currentProject } = useProjectStore();
  const effectiveProjectId = projectId ?? currentProject?.id ?? null;
  const revisions = usePlatformStore((s) => s.revisions);
  const approvals = usePlatformStore((s) => s.approvals);
  const loading = usePlatformStore((s) => s.loading);
  const error = usePlatformStore((s) => s.error);
  const lastFetchMs = usePlatformStore((s) => s.lastFetchMs);
  const refreshRevisions = usePlatformStore((s) => s.refreshRevisions);
  const refreshApprovals = usePlatformStore((s) => s.refreshApprovals);
  const restore = usePlatformStore((s) => s.restore);
  const decideApproval = usePlatformStore((s) => s.decideApproval);
  const fetchAudit = usePlatformStore((s) => s.fetchAudit);
  const verifyAudit = usePlatformStore((s) => s.verifyAudit);
  const clearError = usePlatformStore((s) => s.clearError);

  const [view, setView] = useState<'revisions' | 'audit'>('revisions');
  /** null → automatic: open whenever approvals are pending, collapsed otherwise. */
  const [approvalsToggled, setApprovalsToggled] = useState<boolean | null>(null);
  const approvalsOpen = approvalsToggled ?? approvals.length > 0;

  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [confirmDecision, setConfirmDecision] = useState<{ id: string; decision: ApprovalDecision } | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const [auditEntries, setAuditEntries] = useState<PlatformAuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verification, setVerification] = useState<PlatformAuditVerification | null>(null);

  // Initial + project-switch load.
  useEffect(() => {
    if (effectiveProjectId) void refreshRevisions(effectiveProjectId);
    void refreshApprovals();
    setConfirmRestoreId(null);
    setConfirmDecision(null);
  }, [effectiveProjectId, refreshRevisions, refreshApprovals]);

  // Escape closes the panel when the shell provides onClose.
  useEffect(() => {
    if (!onClose) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Load the audit tail when the audit view opens.
  useEffect(() => {
    if (view !== 'audit') return undefined;
    let cancelled = false;
    setAuditLoading(true);
    void fetchAudit(10).then((entries) => {
      if (cancelled) return;
      setAuditEntries(entries);
      setAuditLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [view, fetchAudit]);

  if (!effectiveProjectId) {
    return (
      <section aria-label="Project revisions" className="flex h-full min-h-0 flex-col items-center justify-center gap-3 rounded-xl border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] p-8 text-center">
        <History size={28} className="text-[var(--ff-text-dim)]" />
        <p className="text-sm font-semibold text-[var(--ff-text)]">No project open</p>
        <p className="text-xs text-[var(--ff-text-dim)]">Open a project to review its platform revisions.</p>
      </section>
    );
  }

  async function handleRefresh() {
    await Promise.allSettled([...(effectiveProjectId ? [refreshRevisions(effectiveProjectId)] : []), refreshApprovals()]);
    if (view === 'audit') {
      setAuditLoading(true);
      const entries = await fetchAudit(10);
      setAuditEntries(entries);
      setAuditLoading(false);
    }
  }

  async function handleConfirmRestore(revision: PlatformRevision) {
    setRestoringId(revision.id);
    if (!effectiveProjectId) return;
    const result = await restore(effectiveProjectId, revision.id);
    setRestoringId(null);
    setConfirmRestoreId(null);
    if (result.ok && effectiveProjectId) await refreshRevisions(effectiveProjectId);
  }

  async function handleConfirmDecision(approval: PlatformApproval) {
    if (!confirmDecision || confirmDecision.id !== approval.id) return;
    setDecidingId(approval.id);
    const result = await decideApproval(approval.id, confirmDecision.decision);
    setDecidingId(null);
    setConfirmDecision(null);
    if (result.ok) await refreshApprovals();
  }

  async function handleVerify() {
    setVerifying(true);
    const result = await verifyAudit();
    setVerification(result);
    setVerifying(false);
  }

  return (
    <section
      aria-label="Project revisions"
      className={cn(
        'ff-studio flex h-full min-h-0 flex-col overflow-hidden rounded-xl border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] text-[var(--ff-text)]',
        className,
      )}
      style={{ boxShadow: 'var(--ff-studio-shadow)' }}
    >
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-4 py-2.5">
        <History size={17} aria-hidden className="shrink-0 text-[var(--ff-text)]" />
        <h2 className="ff-display text-[15px] font-bold leading-none text-[var(--ff-text)]">
          Project revisions
        </h2>
        <span className="ff-studio-badge" aria-label={`${revisions.length} revisions`}>
          {revisions.length}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={loading}
            aria-label="Refresh revisions and approvals"
            title="Refresh revisions and approvals"
            className="rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] p-1.5 text-[var(--ff-text)] transition-colors hover:bg-[var(--ff-surface-2)] disabled:opacity-50"
          >
            <RefreshCw size={13} aria-hidden className={cn(loading && 'animate-spin')} />
          </button>
          <button
            type="button"
            onClick={() => setView((current) => (current === 'audit' ? 'revisions' : 'audit'))}
            aria-pressed={view === 'audit'}
            aria-label={view === 'audit' ? 'Back to revisions' : 'View audit log'}
            className="inline-flex items-center gap-1.5 rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--ff-text-muted)] transition-colors hover:text-[var(--ff-text)]"
          >
            <ScrollText size={12} aria-hidden />
            {view === 'audit' ? 'Revisions' : 'Audit'}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close revision history"
              title="Close revision history"
              className="rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] p-1.5 text-[var(--ff-text)] transition-colors hover:bg-[var(--ff-surface-2)]"
            >
              <X size={13} aria-hidden />
            </button>
          )}
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 ff-scrollbar">
        {/* Error banner */}
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border-2 border-[var(--ff-error)] px-3 py-2"
            style={{ background: 'color-mix(in srgb, var(--ff-error) 10%, var(--ff-surface))' }}
          >
            <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0 text-[var(--ff-error)]" />
            <p className="min-w-0 text-xs font-medium leading-snug text-[var(--ff-text)]">{error}</p>
            <button
              type="button"
              onClick={clearError}
              aria-label="Dismiss error"
              title="Dismiss error"
              className="ml-auto shrink-0 rounded-md p-1 text-[var(--ff-text-muted)] transition-colors hover:text-[var(--ff-text)]"
            >
              <X size={13} aria-hidden />
            </button>
          </div>
        )}

        {view === 'audit' ? (
          /* ── Audit view ─────────────────────────────────────── */
          <section aria-label="Audit log" className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 px-0.5">
              <p className="ff-label text-[9px] font-bold text-[var(--ff-text-dim)]">
                Last {auditEntries.length} entries
              </p>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {verification &&
                  (verification.ok ? (
                    <span
                      role="status"
                      title={`Checked ${verification.checked} entries`}
                      className="inline-flex items-center gap-1.5 rounded-full border-2 border-[var(--ff-success)] bg-[var(--ff-success)] px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.1em] text-white"
                    >
                      <Check size={11} aria-hidden strokeWidth={3} />
                      Chain verified
                    </span>
                  ) : (
                    <span
                      role="status"
                      title={`First bad seq ${verification.firstBadSeq ?? 'unknown'}`}
                      className="inline-flex max-w-56 items-center gap-1.5 rounded-full border-2 border-[var(--ff-error)] bg-[var(--ff-error)] px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.1em] text-white"
                    >
                      <X size={11} aria-hidden strokeWidth={3} />
                      <span className="truncate">Chain broken{verification.reason ? `: ${verification.reason}` : ''}</span>
                    </span>
                  ))}
                <button
                  type="button"
                  onClick={() => void handleVerify()}
                  disabled={verifying}
                  aria-label="Verify audit chain"
                  title="Verify audit chain"
                  className="inline-flex items-center gap-1.5 rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--ff-text-muted)] transition-colors hover:text-[var(--ff-text)] disabled:opacity-50"
                >
                  {verifying ? (
                    <Loader2 size={12} aria-hidden className="animate-spin" />
                  ) : (
                    <ShieldCheck size={12} aria-hidden />
                  )}
                  Verify chain
                </button>
              </div>
            </div>

            {auditLoading ? (
              <div aria-busy="true" aria-label="Loading audit entries" className="space-y-1.5">
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-9 animate-pulse rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)]"
                  />
                ))}
              </div>
            ) : auditEntries.length === 0 ? (
              <p className="rounded-xl border-2 border-dashed border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-4 py-6 text-center text-xs text-[var(--ff-text-muted)]">
                No audit entries yet — every platform action seals one.
              </p>
            ) : (
              <ul role="list" aria-label="Audit entries" className="space-y-1.5">
                {auditEntries.slice(0, 10).map((entry) => (
                  <li
                    key={entry.seq}
                    role="listitem"
                    className="flex items-center gap-2 rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] px-2.5 py-1.5"
                  >
                    <span className="ff-label shrink-0 text-[8px] font-bold text-[var(--ff-text-dim)]">
                      #{entry.seq}
                    </span>
                    <span
                      className="min-w-0 shrink truncate font-mono text-[10px] font-semibold text-[var(--ff-text)]"
                      title={entry.action}
                    >
                      {entry.action}
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate text-right text-[10px] text-[var(--ff-text-muted)]"
                      title={entry.actor}
                    >
                      {entry.actor}
                    </span>
                    <span className="shrink-0 text-[9px] text-[var(--ff-text-dim)]">
                      {relativeTime(entry.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <>
            {/* ── Pending approvals (collapsible) ──────────────── */}
            <section
              aria-label="Pending approvals"
              className="overflow-hidden rounded-xl border-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)]"
            >
              <button
                type="button"
                onClick={() => setApprovalsToggled(!approvalsOpen)}
                aria-expanded={approvalsOpen}
                aria-controls="ff-approvals-panel"
                className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--ff-surface)]"
              >
                <ShieldAlert size={13} aria-hidden className="shrink-0 text-[var(--ff-text)]" />
                <span className="ff-label text-[9px] font-bold text-[var(--ff-text-muted)]">
                  Pending approvals
                </span>
                <span className="ff-studio-badge" aria-label={`${approvals.length} pending approvals`}>
                  {approvals.length}
                </span>
                <ChevronDown
                  size={13}
                  aria-hidden
                  className={cn('ml-auto shrink-0 text-[var(--ff-text-muted)] transition-transform', approvalsOpen && 'rotate-180')}
                />
              </button>
              {approvalsOpen && (
                <div id="ff-approvals-panel" className="border-t-2 border-[var(--ff-border)] p-2">
                  {approvals.length === 0 ? (
                    <p className="px-2 py-2 text-[11px] text-[var(--ff-text-muted)]">
                      Nothing needs your sign-off right now.
                    </p>
                  ) : (
                    <ul role="list" aria-label="Pending approval requests" className="space-y-1.5">
                      {approvals.map((approval) => {
                        const confirming = confirmDecision?.id === approval.id ? confirmDecision : null;
                        return (
                          <li
                            key={approval.id}
                            role="listitem"
                            className="rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] p-2"
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={cn(
                                  'inline-flex shrink-0 items-center rounded-full border-2 px-2 py-0.5 text-[8px] font-black uppercase leading-tight tracking-[0.14em]',
                                  RISK_CHIP[approval.risk],
                                )}
                                title={RISK_LABEL[approval.risk]}
                                aria-label={RISK_LABEL[approval.risk]}
                              >
                                {approval.risk}
                              </span>
                              <span
                                className="min-w-0 flex-1 truncate text-[11px] font-medium text-[var(--ff-text)]"
                                title={approval.reason}
                              >
                                {approval.reason}
                              </span>
                              <span className="shrink-0 text-[9px] text-[var(--ff-text-dim)]">
                                {relativeTime(approval.requestedAt)}
                              </span>
                            </div>
                            <p className="mt-1 truncate font-mono text-[8px] uppercase tracking-[0.1em] text-[var(--ff-text-dim)]">
                              step {approval.stepId}
                            </p>
                            {confirming ? (
                              <div
                                role="alert"
                                className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-studio-yellow)] px-2 py-1.5"
                              >
                                <span className="text-[10px] font-bold text-[#141414]">
                                  {confirming.decision === 'approved' ? 'Approve this action?' : 'Reject this action?'}
                                </span>
                                <div className="ml-auto flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => void handleConfirmDecision(approval)}
                                    disabled={decidingId === approval.id}
                                    aria-label={confirming.decision === 'approved' ? 'Confirm approve' : 'Confirm reject'}
                                    className="rounded-md border border-[#141414] bg-[#141414] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-[#f2d45c] disabled:opacity-50"
                                  >
                                    {decidingId === approval.id ? 'Working…' : 'Confirm'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDecision(null)}
                                    aria-label="Cancel"
                                    className="rounded-md border border-[#141414] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-[#141414]"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="mt-1.5 flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setConfirmDecision({ id: approval.id, decision: 'approved' })}
                                  aria-label={`Approve approval ${approval.id}`}
                                  className="inline-flex items-center gap-1 rounded-md border-2 border-[var(--ff-success)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--ff-success)] transition-colors hover:bg-[var(--ff-success)] hover:text-white"
                                >
                                  <Check size={11} aria-hidden strokeWidth={3} />
                                  Approve
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDecision({ id: approval.id, decision: 'rejected' })}
                                  aria-label={`Reject approval ${approval.id}`}
                                  className="inline-flex items-center gap-1 rounded-md border-2 border-[var(--ff-error)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--ff-error)] transition-colors hover:bg-[var(--ff-error)] hover:text-white"
                                >
                                  <X size={11} aria-hidden strokeWidth={3} />
                                  Reject
                                </button>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </section>

            {/* ── Loading skeleton / empty / revision list ─────── */}
            {loading && revisions.length === 0 ? (
              <div aria-busy="true" aria-label="Loading revisions" className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-16 animate-pulse rounded-xl border-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)]"
                  />
                ))}
              </div>
            ) : revisions.length === 0 ? (
              <div className="rounded-xl border-2 border-dashed border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-4 py-8 text-center">
                <GitCommitHorizontal size={26} aria-hidden className="mx-auto mb-2 text-[var(--ff-text-dim)]" />
                <p className="text-sm font-semibold text-[var(--ff-text)]">
                  No revisions yet — every committed patch seals one
                </p>
              </div>
            ) : (
              <ul role="list" aria-label="Project revisions" className="space-y-2">
                {revisions.map((revision) => {
                  const confirming = confirmRestoreId === revision.id;
                  return (
                    <li
                      key={revision.id}
                      role="listitem"
                      className="rounded-xl border-2 border-[var(--ff-border)] bg-[var(--ff-surface)] p-2.5 transition-colors hover:border-[var(--ff-border-hover)]"
                    >
                      <div className="flex items-center gap-2">
                        <code
                          className="shrink-0 font-mono text-[10px] font-bold text-[var(--ff-text)]"
                          title={revision.id}
                        >
                          {shortHash(revision.id)}
                        </code>
                        <span aria-hidden className="text-[var(--ff-text-dim)]">·</span>
                        <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-[var(--ff-text-dim)]">
                          {relativeTime(revision.createdAt)}
                        </span>
                        <span
                          className="ff-label ml-auto shrink-0 text-[8px] font-bold text-[var(--ff-text-dim)]"
                          title={`${revision.totalBytes} bytes`}
                        >
                          {revision.fileCount} files · {formatKB(revision.totalBytes)}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <p
                          className="min-w-0 flex-1 truncate text-xs leading-snug text-[var(--ff-text)]"
                          title={revision.message}
                        >
                          {revision.message}
                        </p>
                        {confirming ? (
                          <div
                            role="alert"
                            className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border-2 border-[var(--ff-border)] bg-[var(--ff-studio-yellow)] px-2 py-1.5"
                          >
                            <span className="text-[10px] font-bold text-[#141414]">
                              Restore {revision.fileCount} files?
                            </span>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => void handleConfirmRestore(revision)}
                                disabled={restoringId === revision.id}
                                aria-label="Confirm restore"
                                className="rounded-md border border-[#141414] bg-[#141414] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-[#f2d45c] disabled:opacity-50"
                              >
                                {restoringId === revision.id ? 'Working…' : 'Confirm'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmRestoreId(null)}
                                aria-label="Cancel"
                                className="rounded-md border border-[#141414] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-[#141414]"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setConfirmRestoreId(revision.id)}
                              aria-label={`Restore revision ${shortHash(revision.id)}`}
                              title="Restore this revision"
                              className="inline-flex items-center gap-1 rounded-md border-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--ff-text)] transition-colors hover:bg-[var(--ff-surface)]"
                            >
                              <RotateCcw size={11} aria-hidden />
                              Restore
                            </button>
                            <button
                              type="button"
                              disabled
                              aria-label="Diff (coming with the diff view)"
                              title="coming with the diff view"
                              className="inline-flex cursor-not-allowed items-center gap-1 rounded-md border-2 border-dashed border-[var(--ff-border)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--ff-text-dim)] opacity-70"
                            >
                              <GitCompare size={11} aria-hidden />
                              Diff
                            </button>
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>

      {/* ── Footer ─────────────────────────────────────────────── */}
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t-2 border-[var(--ff-border)] bg-[var(--ff-surface-2)] px-4 py-1.5">
        <span className="ff-label text-[8px] font-bold text-[var(--ff-text-dim)]">
          Local-first · platform never leaves this machine
        </span>
        <span className="ff-label text-[8px] font-bold text-[var(--ff-text-dim)]">
          last fetch {lastFetchMs} ms
        </span>
      </footer>
    </section>
  );
}
