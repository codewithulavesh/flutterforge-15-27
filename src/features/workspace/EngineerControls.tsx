import { useState } from 'react';
import { CheckCircle2, ChevronDown, Circle, Pause, Play, ShieldCheck, Square, Terminal, WifiOff } from 'lucide-react';
import { engineerRequest } from '@/agent/engineClient';
import { useEngineerSession } from './useEngineerSession';

export function EngineerControls({ projectId }: { projectId?: string }) {
  const session = useEngineerSession(projectId);
  const { state, events } = session;
  const [actionError, setError] = useState('');
  const error = actionError || session.error;
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  if (!projectId) return null;
  const terminal = !state || ['idle', 'completed', 'failed', 'cancelled'].includes(state.status);
  const act = async (operation: string, body: unknown = {}): Promise<boolean> => {
    setBusy(true); setError('');
    try { await engineerRequest(projectId, operation, body); await session.refresh(); return true; }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); return false; }
    finally { setBusy(false); }
  };
  const current = events.filter(e => e.runId === state?.runId);
  const operation = [...current].reverse().find(e => ['tool_start', 'progress', 'tool_end'].includes(e.type));
  const status = state?.status ?? (error ? 'unavailable' : 'ready');
  return <section className="engine-console" aria-label="Engineer execution controls">
    <div className="engine-console-heading">
      <button className="engine-console-toggle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        {error ? <WifiOff size={14} /> : state?.verification?.passed ? <CheckCircle2 size={14} /> : <Circle size={9} className={!terminal ? 'engine-live-dot' : ''} fill="currentColor" />}
        <span>{status.replaceAll('_', ' ')}</span><ChevronDown size={13} />
      </button>
      <div className="engine-actions">
        {['paused', 'interrupted'].includes(status) && !state?.approval && <button disabled={busy} onClick={() => void act('resume')} title="Resume execution" aria-label="Resume execution"><Play size={14} /></button>}
        {!terminal && !['paused', 'awaiting_approval'].includes(status) && <button disabled={busy} onClick={() => void act('pause')} title="Pause after current operation" aria-label="Pause execution"><Pause size={14} /></button>}
        {!terminal && <button disabled={busy} onClick={() => void act('cancel')} title="Cancel execution" aria-label="Cancel execution"><Square size={12} /></button>}
        {state && <span className="engine-call-count">{state.usage?.toolCalls ?? 0} operations</span>}
      </div>
    </div>
    {!terminal && operation && <p className="engine-current-operation">{operation.message ?? operation.summary ?? operation.tool?.replaceAll('_', ' ')}</p>}
    {state?.approval && <div className="engine-approval">
      <div className="engine-approval-title"><ShieldCheck size={16} /> Your approval is needed</div>
      <p>{state.approval.reason}</p>
      <details><summary>Review requested actions</summary><pre>{JSON.stringify(state.approval.calls, null, 2)}</pre></details>
      <div className="engine-approval-actions">
        <button className="engine-button-primary" disabled={busy} onClick={() => void act('resume', { approvalId: state.approval!.id, approved: true })}>Approve & continue</button>
        <button className="engine-button-secondary" disabled={busy} onClick={() => void act('resume', { approvalId: state.approval!.id, approved: false })}>Reject</button>
      </div>
    </div>}
    {Boolean(state?.specialistReports?.length) && <div className="studio-specialist-reports" aria-label="Specialist reports">
      {state?.specialistReports?.map(report => <details key={report.role}>
        <summary>{report.role === 'planner' ? 'Planner' : 'Reviewer'} · {report.status}</summary>
        <p>{report.summary}</p>
      </details>)}
    </div>}
    {expanded && <div className="engine-detail">
      {state?.verification?.steps && <ul className="studio-checks" aria-label="Flutter verification steps">
        {state.verification.steps.map(step => <li key={step.command}><code>{step.command}</code><span data-result={step.status}>{step.status}</span></li>)}
      </ul>}
      {state?.verification && <p className={state.verification.passed ? 'engine-verified' : 'engine-error'}>{state.verification.summary}</p>}
      {state?.error && <p className="engine-error">{state.error}</p>}
      <ol aria-label="Execution history">{current.filter(e => e.type !== 'status').slice(-16).map(event => <li key={event.seq}>
        <Terminal size={12} /><span>{event.message ?? event.summary ?? event.tool?.replaceAll('_', ' ') ?? event.path ?? event.type.replaceAll('_', ' ')}</span>
        <time>{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      </li>)}</ol>
      {current.length === 0 && <p className="engine-empty-log">Execution events appear here when the engineer starts.</p>}
      {state?.changedFiles.length ? <p className="engine-files-summary">{state.changedFiles.length} changed files · {state.verification?.passed ? 'Verification passed' : 'Not yet verified'}</p> : null}
    </div>}
    {!terminal && <form className="engine-instruction" onSubmit={event => { event.preventDefault(); void act('instruction', { instruction }).then(ok => { if (ok) setInstruction(''); }); }}>
      <input aria-label="Additional instructions" value={instruction} maxLength={8000} onChange={e => setInstruction(e.target.value)} placeholder="Add direction without restarting…" />
      <button disabled={busy || !instruction.trim()}>Send</button>
    </form>}
    {error && <p className="engine-error" role="alert">{error}</p>}
  </section>;
}
