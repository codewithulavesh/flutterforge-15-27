// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevisionHistory } from './RevisionHistory';
import {
  usePlatformStore,
  type PlatformApproval,
  type PlatformAuditEntry,
  type PlatformAuditVerification,
  type PlatformRevision,
} from '@/stores/platform.store';

const NOW = Date.now();

function makeRevision(overrides: Partial<PlatformRevision> = {}): PlatformRevision {
  return {
    id: 'rev_a1b2c3d4e5f6',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    message: 'Seal patch: add counter screen',
    actor: 'user-1',
    fileCount: 12,
    totalBytes: 245 * 1024,
    createdAt: NOW - 2 * 3_600_000,
    ...overrides,
  };
}

function makeApproval(overrides: Partial<PlatformApproval> = {}): PlatformApproval {
  return {
    id: 'appr_1',
    runId: 'run_1',
    stepId: 'patch.apply',
    risk: 'high',
    reason: 'Publish to production host',
    requestedAt: NOW - 30 * 60_000,
    summary: { files: 2 },
    ...overrides,
  };
}

interface RouterState {
  revisions: PlatformRevision[];
  approvals: PlatformApproval[];
  entries: PlatformAuditEntry[];
  verify: PlatformAuditVerification;
  failRevisions: boolean;
  revisionsGets: number;
  restoreCalls: Array<{ url: string; method: string; body: unknown }>;
  decisionCalls: Array<{ url: string; method: string; body: unknown }>;
}

function makeRouter(state: RouterState) {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const parseBody = () => (init?.body ? JSON.parse(String(init.body)) : undefined);

    if (method === 'GET' && url.startsWith('/api/platform/projects/project-1/revisions')) {
      state.revisionsGets += 1;
      if (state.failRevisions) {
        return json({ error: { code: 'INTERNAL', message: 'revision store offline' } }, 500);
      }
      return json({ ok: true, revisions: state.revisions });
    }
    if (method === 'GET' && url === '/api/platform/approvals/pending') {
      return json({ ok: true, approvals: state.approvals });
    }
    if (method === 'POST' && /\/revisions\/[^/]+\/restore$/.test(url)) {
      state.restoreCalls.push({ url, method, body: parseBody() });
      // A successful restore seals a fresh revision — the refresh must surface it.
      state.revisions = [
        makeRevision({
          id: 'rev_f6e5d4c3b2a1',
          message: 'Seal patch: post-restore revision',
          createdAt: Date.now(),
        }),
        ...state.revisions,
      ];
      return json({ ok: true, result: { transactionId: 'tx_1' } });
    }
    if (method === 'POST' && url.startsWith('/api/platform/approvals/') && url.endsWith('/decision')) {
      const body = parseBody() as { decision?: string };
      state.decisionCalls.push({ url, method, body });
      if (body?.decision === 'approved' || body?.decision === 'rejected') {
        state.approvals = state.approvals.filter((approval) => !url.includes(approval.id));
      }
      return json({ ok: true, approval: { ...state.approvals[0], status: body?.decision } });
    }
    if (method === 'GET' && url.startsWith('/api/platform/audit/entries')) {
      return json({ ok: true, entries: state.entries });
    }
    if (method === 'GET' && url === '/api/platform/audit/verify') {
      return json({ ok: state.verify.ok, verification: state.verify });
    }
    return json({ error: { code: 'NOT_FOUND', message: `Unmocked route: ${method} ${url}` } }, 404);
  });
}

let state: RouterState;

beforeEach(() => {
  usePlatformStore.setState({ revisions: [], approvals: [], loading: false, error: null, lastFetchMs: 0 });
  state = {
    revisions: [makeRevision()],
    approvals: [],
    entries: [
      { seq: 41, action: 'revision.commit', actor: 'user-1', resourceId: 'rev_a1b2c3d4e5f6', createdAt: NOW - 5 * 60_000 },
      { seq: 42, action: 'patch.apply', actor: 'agent', createdAt: NOW - 60_000 },
    ],
    verify: { ok: true, checked: 42, headHash: 'deadbeef' },
    failRevisions: false,
    revisionsGets: 0,
    restoreCalls: [],
    decisionCalls: [],
  };
  vi.stubGlobal('fetch', makeRouter(state));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RevisionHistory', () => {
  it('renders revisions and restores via the inline confirm, then refreshes the list', async () => {
    const user = userEvent.setup();
    render(<RevisionHistory projectId="project-1" />);

    expect(await screen.findByText('Seal patch: add counter screen')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /restore revision/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Restore 12 files?');

    await user.click(within(alert).getByRole('button', { name: 'Confirm restore' }));

    await waitFor(() => expect(state.restoreCalls).toHaveLength(1));
    expect(state.restoreCalls[0]).toMatchObject({
      url: '/api/platform/projects/project-1/revisions/rev_a1b2c3d4e5f6/restore',
      method: 'POST',
      body: { revisionId: 'rev_a1b2c3d4e5f6' },
    });

    // The panel refreshes revisions after a successful restore.
    expect(await screen.findByText('Seal patch: post-restore revision')).toBeInTheDocument();
    expect(state.revisionsGets).toBeGreaterThanOrEqual(2);
  });

  it('renders pending approvals with a risk chip; Approve posts the decision and the row disappears after refresh', async () => {
    state.approvals = [makeApproval()];
    const user = userEvent.setup();
    render(<RevisionHistory projectId="project-1" />);

    expect(await screen.findByText('Publish to production host')).toBeInTheDocument();
    expect(screen.getByLabelText('High risk')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve approval appr_1' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Approve this action?');

    await user.click(within(alert).getByRole('button', { name: 'Confirm approve' }));

    await waitFor(() => expect(state.decisionCalls).toHaveLength(1));
    expect(state.decisionCalls[0]).toMatchObject({
      url: '/api/platform/approvals/appr_1/decision',
      method: 'POST',
      body: { decision: 'approved' },
    });

    await waitFor(() =>
      expect(screen.queryByText('Publish to production host')).not.toBeInTheDocument(),
    );
  });

  it('toggles to the audit view: lists entries and verifies the chain (ok and broken)', async () => {
    const user = userEvent.setup();
    render(<RevisionHistory projectId="project-1" />);

    await screen.findByText('Seal patch: add counter screen');
    await user.click(screen.getByRole('button', { name: 'View audit log' }));

    expect(await screen.findByText('revision.commit')).toBeInTheDocument();
    expect(screen.getByText('patch.apply')).toBeInTheDocument();
    expect(screen.getByText('#41')).toBeInTheDocument();
    expect(screen.getByText('agent')).toBeInTheDocument();

    // Chain verifies.
    await user.click(screen.getByRole('button', { name: 'Verify audit chain' }));
    expect(await screen.findByText('Chain verified')).toBeInTheDocument();

    // Chain broken: verdict flips and the server reason is shown.
    state.verify = { ok: false, checked: 3, firstBadSeq: 7, reason: 'previous-hash linkage is broken' };
    await user.click(screen.getByRole('button', { name: 'Verify audit chain' }));
    expect(await screen.findByText(/Chain broken/)).toBeInTheDocument();
    expect(screen.getByText(/previous-hash linkage is broken/)).toBeInTheDocument();
  });

  it('renders the server error in a banner and dismisses it', async () => {
    state.failRevisions = true;
    const user = userEvent.setup();
    render(<RevisionHistory projectId="project-1" />);

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('revision store offline');

    await user.click(within(banner).getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the empty state when there are no revisions', async () => {
    state.revisions = [];
    render(<RevisionHistory projectId="project-1" />);

    expect(
      await screen.findByText('No revisions yet — every committed patch seals one'),
    ).toBeInTheDocument();
  });
});
