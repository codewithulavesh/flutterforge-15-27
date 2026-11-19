import { useEffect, useRef, useState } from 'react';
import { Blocks, Network, SlidersHorizontal } from 'lucide-react';
import { engineerRequest, EngineerRequestError } from '@/agent/engineClient';
import { SKILL_DEFINITIONS } from '@/agent/skills';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProjectConnectors } from './ProjectConnectors';
import './generator-panel.css';

type Specialist = 'planner' | 'reviewer';
interface Settings { revision: number; skills: string[]; specialists: Specialist[] }
const specialists = [
  { id: 'planner', name: 'Planner', description: 'Reads the task and project context and proposes an implementation plan before the lead engineer starts.' },
  { id: 'reviewer', name: 'Reviewer', description: 'Reviews the resulting changes and reports findings to the lead engineer.' },
] as const;

function ExecutionPreferences({ projectId, section }: { projectId: string; section: 'skills' | 'specialists' }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const scope = useRef<AbortController>();
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    setSettings(null); setError(''); setBusy(false); setMessage('');
    engineerRequest<Settings>(projectId, 'generator-settings', undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setSettings(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [projectId, attempt]);

  async function save(patch: Partial<Pick<Settings, 'skills' | 'specialists'>>) {
    if (!settings || busy) return;
    const signal = scope.current?.signal;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await engineerRequest<Settings>(projectId, 'generator-settings', { ...settings, ...patch }, signal);
      if (!signal?.aborted) { setSettings(next); setMessage('Saved for the next run.'); }
    } catch (reason) {
      if (signal?.aborted) return;
      if (reason instanceof EngineerRequestError && reason.status === 409) setSettings(null);
      setError(reason instanceof Error ? reason.message : 'Could not save settings.');
    } finally { if (!signal?.aborted) setBusy(false); }
  }

  const isSkills = section === 'skills';
  const options = isSkills ? SKILL_DEFINITIONS : specialists;
  const selected: readonly string[] = settings?.[section] ?? [];
  return <section className="generator-preferences" aria-label={isSkills ? 'Project skills' : 'Specialist agents'}>
    <header><h3>{isSkills ? 'Project skills' : 'Specialist agents'}</h3>
      <p>{isSkills ? 'Choose the rules the engineer applies to future requests in this project.' : 'Delegate planning and review on future chat runs. Each specialist uses the project’s model-call budget.'}</p>
    </header>
    {settings ? <>
      <div className="generator-selection"><span>{selected.length} enabled</span>{isSkills && <button disabled={busy} onClick={() => void save({ skills: SKILL_DEFINITIONS.filter(s => s.enabledByDefault).map(s => s.id) })}>Restore defaults</button>}</div>
      <div className="generator-options">{options.map(option => <div className="generator-option" key={option.id}>
        <label><span><strong>{option.name}</strong><small>{option.description}</small></span>
          <input aria-label={option.name} type="checkbox" role="switch" disabled={busy} checked={selected.includes(option.id)} onChange={event => {
            const value = event.target.checked ? [...selected, option.id] : selected.filter(id => id !== option.id);
            void save(isSkills ? { skills: value } : { specialists: value as Specialist[] });
          }} /></label>
        {'rules' in option && <details><summary>View rules</summary><ul>{option.rules.map(rule => <li key={rule}>{rule}</li>)}</ul></details>}
      </div>)}</div>
    </> : !error && <p role="status">Loading settings…</p>}
    {error && <p role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>Reload settings</button></p>}
    <p role="status" className="generator-save">{busy ? 'Saving…' : message}</p>
  </section>;
}

export function GeneratorPanel({ projectId }: { projectId: string }) {
  return <Tabs defaultValue="skills" className="generator-panel">
    <TabsList className="generator-tabs" aria-label="Generator configuration">
      <TabsTrigger value="skills"><SlidersHorizontal size={15} />Skills</TabsTrigger>
      <TabsTrigger value="connectors"><Blocks size={15} />Connectors</TabsTrigger>
      <TabsTrigger value="specialists"><Network size={15} />Agents</TabsTrigger>
    </TabsList>
    <TabsContent value="skills"><ExecutionPreferences projectId={projectId} section="skills" /></TabsContent>
    <TabsContent value="connectors"><ProjectConnectors projectId={projectId} /></TabsContent>
    <TabsContent value="specialists"><ExecutionPreferences projectId={projectId} section="specialists" /></TabsContent>
  </Tabs>;
}
