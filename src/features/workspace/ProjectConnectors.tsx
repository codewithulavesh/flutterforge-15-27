import { useEffect, useRef, useState } from 'react';
import { Box, GitFork, Loader2, RefreshCw, Unplug } from 'lucide-react';
import { engineerRequest } from '@/agent/engineClient';
import './project-connectors.css';

type Kind = 'github' | 'pubdev';
type Connection = { kind: Kind; resource: string; revision: string; syncedAt: string; metadata: Record<string, string> };

const providers = [
  { kind: 'github' as const, title: 'GitHub', label: 'Public repository', placeholder: 'flutter/flutter', Icon: GitFork },
  { kind: 'pubdev' as const, title: 'pub.dev', label: 'Dart package', placeholder: 'go_router', Icon: Box },
];

export function ProjectConnectors({ projectId }: { projectId: string }) {
  return <ConnectorSettings key={projectId} projectId={projectId} />;
}

function ConnectorSettings({ projectId }: { projectId: string }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [draft, setDraft] = useState<Record<Kind, string>>({ github: '', pubdev: '' });
  const [busy, setBusy] = useState<Kind | 'loading' | null>('loading');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [requestNumber, setRequestNumber] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    setBusy('loading');
    setError('');
    engineerRequest<Connection[]>(projectId, 'connectors', undefined, abort.signal)
      .then(rows => { if (!abort.signal.aborted) { setConnections(rows); setLoaded(true); } })
      .catch(err => { if (!abort.signal.aborted) setError(err.message); })
      .finally(() => { if (!abort.signal.aborted) setBusy(null); });
    return () => abort.abort();
  }, [projectId, requestNumber]);

  async function change(kind: Kind, action: 'sync' | 'disconnect') {
    const signal = controller.current?.signal;
    if (busy || !loaded || !signal) return;
    const saved = connections.find(row => row.kind === kind);
    const body = { kind, action, expectedRevision: saved?.revision ?? null };
    setBusy(kind); setError('');
    try {
      const rows = await engineerRequest<Connection[]>(projectId, 'connectors', action === 'sync'
        ? { ...body, resource: saved?.resource ?? draft[kind].trim() } : body, signal);
      if (!signal.aborted) { setConnections(rows); setDraft(prev => ({ ...prev, [kind]: '' })); }
    } catch (err) {
      if (!signal.aborted) setError(err instanceof Error ? err.message : 'Connection failed.');
    } finally { if (!signal.aborted) setBusy(null); }
  }

  return <section className="project-connectors" aria-label="Project connectors">
    <p>Sync public resource metadata into the context of this project’s next AI run.</p>
    {busy === 'loading' && <p role="status">Loading connectors…</p>}
    {error && <div className="connector-error" role="alert">{error} <button type="button" disabled={!!busy} onClick={() => setRequestNumber(n => n + 1)}>Reload connections</button></div>}
    {providers.map(({ kind, title, Icon, label, placeholder }) => {
      const saved = connections.find(row => row.kind === kind);
      return <article key={kind} className="connector-card">
        <header><span className="connector-icon"><Icon size={18} aria-hidden="true" /></span><h3>{title}</h3>
          <span className="connector-state" data-connected={!!saved}>{!loaded ? '—' : saved ? 'Connected' : 'Disconnected'}</span>
        </header>
        {saved ? <>
          <strong>{saved.resource}</strong>
          <dl>{Object.entries(saved.metadata).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
          <p>Synced <time dateTime={saved.syncedAt}>{new Date(saved.syncedAt).toLocaleString()}</time></p>
          <div className="connector-buttons"><button type="button" disabled={!!busy} onClick={() => void change(kind, 'sync')}><RefreshCw size={13} /> Sync now</button>
            <button type="button" disabled={!!busy} onClick={() => void change(kind, 'disconnect')}><Unplug size={13} /> Disconnect</button></div>
        </> : <form onSubmit={event => { event.preventDefault(); void change(kind, 'sync'); }}>
          <label>{label}<input placeholder={placeholder} value={draft[kind]} maxLength={145} disabled={!loaded || !!busy}
            onChange={event => setDraft(prev => ({ ...prev, [kind]: event.target.value }))} spellCheck={false} autoCapitalize="none" /></label>
          <button disabled={!loaded || !!busy || !draft[kind].trim()}>Connect</button>
        </form>}
        {busy === kind && <span className="connector-progress" role="status"><Loader2 size={13} className="animate-spin" /> Updating connection…</span>}
      </article>;
    })}
  </section>;
}
