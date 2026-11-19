import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowUpRight, CheckCircle2, Code2, Hammer, Maximize2, Minimize2, RotateCw, ZoomIn, ZoomOut, Loader2, Monitor, RefreshCw, Smartphone, Tablet } from 'lucide-react';
import { BuildBreak } from './BuildBreak';
import { engineerRequest } from '@/agent/engineClient';
import { useEngineerSession } from './useEngineerSession';
import { useProjectStore } from '@/stores/project.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import './workspace-engine.css';

export function EngineerPreviewPanel() {
  const { currentProject, generatingIn, files } = useProjectStore();
  const { setActiveView } = useWorkspaceStore();
  const { state, events, refresh, error: sessionError } = useEngineerSession(currentProject?.id);
  const [error, setError] = useState(''); const [device, setDevice] = useState('desktop');
  const [reload, setReload] = useState(0); const [loaded, setLoaded] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [landscape, setLandscape] = useState(false);
  const dartCount = files.filter(file => !file.is_directory && file.path.endsWith('.dart')).length;
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === panel.current);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === panel.current) await document.exitFullscreen();
      else await panel.current?.requestFullscreen();
    } catch { setError('Fullscreen is unavailable in this browser. Open the preview in a new tab.'); }
  }
  const url = state?.preview?.status === 'running' ? state.preview.url : null;
  useEffect(() => { setLoaded(false); }, [url, reload]);
  const [starting, setStarting] = useState(false);
  const waiting = ['paused', 'awaiting_approval', 'interrupted'].includes(state?.status ?? '');
  const running = !waiting && (starting || (!!currentProject && generatingIn === currentProject.id) || ['reasoning', 'executing', 'verifying', 'building'].includes(state?.status ?? ''));
  const latest = events.filter(event => event.runId === state?.runId && ['progress', 'tool_start', 'status'].includes(event.type)).at(-1);
  const activity = latest?.tool ? `Running ${latest.tool.replaceAll('_', ' ')}` : latest?.message || 'Starting execution…';
  useEffect(() => { setError(''); }, [currentProject?.id, state?.runId]);
  const revision = url ? new URL(url).pathname.split('/').filter(Boolean).at(-1)?.slice(0, 7) : undefined;
  const build = async () => {
    if (!currentProject || running || waiting) return; setError(''); setStarting(true);
    try { await engineerRequest(currentProject.id, 'build', {}); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Build failed.'); }
    finally { setStarting(false); }
  };
  return <section ref={panel} className="engine-preview-panel" aria-label="Application preview">
    <div className="engine-preview-toolbar">
      <div className="engine-preview-devices" aria-label="Preview device">
        {([{ name: 'mobile', Icon: Smartphone }, { name: 'tablet', Icon: Tablet }, { name: 'desktop', Icon: Monitor }]).map(({ name, Icon }) =>
          <button key={name} title={name} aria-label={name + ' preview'} aria-pressed={device === name} onClick={() => setDevice(name)}>
            <Icon size={15} /><span>{name}</span>
          </button>)}
      </div>
      <span className="studio-dart-count">{dartCount} Dart {dartCount === 1 ? 'file' : 'files'}</span>
      <div className="studio-preview-zoom">
        <button aria-label="Zoom out" title="Zoom out" disabled={zoom <= 50} onClick={() => setZoom(z => z - 10)}><ZoomOut size={15} /></button>
        <button aria-label="Reset zoom" title="Reset zoom" onClick={() => setZoom(100)}>{zoom}%</button>
        <button aria-label="Zoom in" title="Zoom in" disabled={zoom >= 150} onClick={() => setZoom(z => z + 10)}><ZoomIn size={15} /></button>
      </div>
      <button aria-label="Rotate device" title="Rotate device" aria-pressed={landscape && device !== 'desktop'} disabled={device === 'desktop'} onClick={() => setLandscape(value => !value)}><RotateCw size={15} /></button>
      <button aria-label="Refresh preview" title="Refresh preview" disabled={!url} onClick={() => setReload(value => value + 1)}><RefreshCw size={15} /></button>
      <button aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} title="Fullscreen" onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
      <button className="studio-compile" disabled={!currentProject || running || waiting} onClick={() => void build()}><Hammer size={15} /> Compile</button>
    </div>
    {running && <BuildBreak key={currentProject?.id} activity={activity} />}
    <div className="engine-preview-canvas">
      {url ? <div className={`engine-preview-frame engine-preview-frame-${device} ${landscape ? 'studio-landscape' : ''}`}>
        {!loaded && <div className="engine-preview-loading"><Loader2 className="animate-spin" size={19} /> Loading application…</div>}
        <iframe style={{ width: (10000 / zoom) + '%', height: (10000 / zoom) + '%', transform: 'scale(' + zoom / 100 + ')', transformOrigin: 'top left' }} key={`${url}-${reload}`} src={url} title="Running Flutter application" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} />
      </div> : <div className="engine-preview-empty">
        <div className="engine-preview-emblem">{running ? <Loader2 className="animate-spin" size={27} /> : <Code2 size={29} strokeWidth={1.4} />}</div>

        <h2>{waiting ? 'Execution needs your attention' : running ? 'Preparing your preview' : 'No preview yet'}</h2>
        <p>{waiting ? 'Open project chat to review the pending execution.' : running ? 'The preview will open when the build passes.' : 'Build this project to open its interactive preview.'}</p>
        <div className="engine-preview-empty-actions"><button disabled={running || waiting} onClick={() => void build()}>{running ? 'Execution in progress…' : 'Build current project'}</button><button onClick={() => setActiveView('ai-builder')}>Open AI engineer</button></div>
      </div>}
    </div>
    {(error || sessionError || state?.error) && <div className="engine-preview-error" role="alert"><AlertCircle size={15} /><span>{error || sessionError || state?.error}</span></div>}
    <footer className="engine-preview-footer">{state?.verification?.passed ? <><CheckCircle2 size={13} /> Verified build</> : <>{state?.status === 'failed' ? 'Build failed' : running ? 'Build in progress' : 'Awaiting build'}</>}{url && <a className="studio-revision-link" href={url} target="_blank" rel="noreferrer" aria-label="Open preview in new tab">{currentProject?.name} · {revision}<ArrowUpRight size={13} /></a>}</footer>
  </section>;
}
