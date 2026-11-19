import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowUp, Check, Code2, FileCode2, MessageSquarePlus, FolderOpen, Plus, RotateCcw, Sparkles, Square, X } from 'lucide-react';
import { useProjectStore, type SendMessageOptions } from '@/stores/project.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useTerminalStore } from '@/stores/terminal.store';
import { ChatTranscript } from './chat/ChatTranscript';
import { EngineerControls } from './EngineerControls';
import { isAbortError } from '@/agent/chatTypes';
import { SkillsModal } from './SkillsModal';
import './workspace-engine.css';

const suggestions = [
  { label: 'Build a feature', prompt: 'Inspect this project and help me implement a new feature. Ask me what I want to build.' },
  { label: 'Review this project', prompt: 'Inspect the existing code and explain the architecture, what works, and what needs attention.' },
  { label: 'Find and fix a bug', prompt: 'Inspect the project for bugs. Explain your findings and fix issues you can verify.' },
];
export function AIBuilderPanel({ variant = 'panel' }: { variant?: 'panel' | 'page' }) {
  const { currentProject, messages, files, sendMessage, newConversation, generatingIn } = useProjectStore();
  const workspace = useWorkspaceStore();
  const location = useLocation(); const navigate = useNavigate();
  const [input, setInput] = useState(''); const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [progress, setProgress] = useState(''); const [attachments, setAttachments] = useState<string[]>([]);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [showFiles, setShowFiles] = useState(false); const [saved, setSaved] = useState(false);
  const abort = useRef<AbortController | null>(null); const sending = useRef(false);
  const upload = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null); const projectRef = useRef(currentProject?.id);
  const lastPrompt = useRef(''); const pendingWizard = useRef<string | null>(null);
  projectRef.current = currentProject?.id;
  const running = busy || (!!currentProject && generatingIn === currentProject.id);
  useEffect(() => {
    setInput(''); setReply(''); setError(''); setAttachments([]); setProgress(''); setBusy(false); sending.current = false;
    // A project run outlives this view. Only an explicit Stop cancels it.
  }, [currentProject?.id]);
  const submit = async (prompt = input, extra: SendMessageOptions = {}) => {
    if (!currentProject || sending.current || !prompt.trim()) return;
    const id = currentProject.id; const text = prompt.trim();
    sending.current = true; setBusy(true); setInput(''); setError(''); setReply(''); setProgress('Connecting to your project…');
    lastPrompt.current = text; const controller = new AbortController(); abort.current = controller;
    useTerminalStore.setState({ isAnswering: true, generationError: null });
    try {
      const result = await sendMessage(id, text, message => { if (projectRef.current === id) setProgress(message); }, {
        ...extra, signal: controller.signal, attachedFiles: attachments,
        onToken: token => { if (!controller.signal.aborted && projectRef.current === id) setReply(previous => previous + token); },
        onEvent: event => { if (projectRef.current === id) setProgress(event.message); },
        onFile: file => { if (projectRef.current === id) setProgress(`${file.action}: ${file.path}`); },
      });
      if (projectRef.current !== id || abort.current !== controller) return;
      if (result.mode === 'duplicate') { setInput(text); throw new Error('An execution is already active for this project. Use the instruction field to update it.'); }
      setReply(''); setAttachments([]); setSaved(true);
    } catch (err) {
      if (projectRef.current !== id || abort.current !== controller) return;
      setError(isAbortError(err) ? 'Execution stopped. Saved project changes are preserved.' : err instanceof Error ? err.message : 'The request failed.');
    } finally {
      if (projectRef.current === id && abort.current === controller) {
        sending.current = false; setBusy(false); abort.current = null; setProgress('');
        useTerminalStore.setState({ isAnswering: false, isGenerating: false });
        composer.current?.focus();
      }
    }
  };
  useEffect(() => {
    if (!currentProject) return;
    const state = location.state as { initialPrompt?: string; richPrompt?: string; autoGenerate?: boolean } | null;
    const key = `ff-handoff:${currentProject.id}`;
    const prompt = state?.richPrompt ?? state?.initialPrompt ?? localStorage.getItem(key);
    if (!prompt || pendingWizard.current === prompt) return;
    localStorage.removeItem(key);
    if (state?.richPrompt || state?.initialPrompt) navigate(location.pathname, { replace: true, state: {} });
    pendingWizard.current = prompt;
    if (messages.length > 0) return;
    void submit(prompt, { isInitialGeneration: true });
  }, [currentProject?.id, location.key]);
  useEffect(() => {
    const retry = () => {
      const last = [...messages].reverse().find(message => message.role === 'user');
      if (last && !sending.current) void submit(last.content, { isRepair: files.length > 0, isInitialGeneration: false, repairRound: 1, autoRepairBuild: true });
    };
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { setShowFiles(false); setSkillsOpen(false); } };
    window.addEventListener('ff:retry-last', retry); window.addEventListener('keydown', keydown);
    return () => { window.removeEventListener('ff:retry-last', retry); window.removeEventListener('keydown', keydown); };
  }, [messages, files, currentProject?.id]);
  const stop = () => {
    abort.current?.abort(); abort.current = null; setBusy(false); sending.current = false; setError('Stopped. Saved project changes are preserved.');
    useTerminalStore.setState({ isAnswering: false, isGenerating: false });
  };
  const transcript = messages.filter(message => message.role === 'user' || message.role === 'assistant').map(message => ({
    id: message.id, role: message.role as 'user' | 'assistant', content: message.content, timestamp: message.created_at,
  }));
  if (reply) transcript.push({ id: 'live-response', role: 'assistant', content: reply, timestamp: '' });
  const newChat = async () => {
    if (!currentProject || running) return;
    try { await newConversation(currentProject.id); setReply(''); setError(''); composer.current?.focus(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not create a conversation.'); }
  };
  return <div className={`engine-builder ${variant === 'page' ? 'engine-builder-page' : ''}`}>
    <header className="engine-builder-header">
      <div className="engine-avatar"><Sparkles size={17} /></div>
      <div className="engine-builder-title"><h2>Project chat</h2><p>{currentProject?.name ?? 'Project workspace'}</p></div>
      <button className="engine-icon-button" onClick={() => void newChat()} disabled={running} aria-label="New conversation" title="New conversation"><MessageSquarePlus size={17} /></button>
    </header>
    <EngineerControls projectId={currentProject?.id} />
    <div className="engine-chat-surface">
      {transcript.length ? <ChatTranscript onRegenerate={running ? undefined : prompt => void submit(prompt)} messages={transcript.map(message => ({ ...message, isStreaming: message.id === 'live-response' && running }))} /> : <div className="engine-welcome">
        <div className="engine-welcome-mark"><Code2 size={27} strokeWidth={1.4} /></div>

        <h3>What shall we build?</h3>
        <p>Describe a feature, ask about your code, or work through a bug. Changes appear in Preview after a successful build.</p>
        <div className="engine-suggestions">{suggestions.map(suggestion => <button key={suggestion.label} onClick={() => { setInput(suggestion.prompt); composer.current?.focus(); }}>
          <span>{suggestion.label}</span><ArrowUp size={13} className="rotate-45" />
        </button>)}</div>
        <div className="engine-context-count"><FileCode2 size={13} />{files.filter(f => !f.is_directory).length} project files available</div>
      </div>}
    </div>
    {running && <div className="engine-progress" role="status"><span className="engine-live-dot" /><span className="truncate">{progress || 'Working on your request…'}</span><button type="button" className="ml-auto shrink-0 underline min-[900px]:hidden" onClick={() => workspace.setActiveView('preview')}>View build</button></div>}
    {error && <div className="engine-error-card" role="alert"><p>{error}</p>{!running && lastPrompt.current && <button onClick={() => void submit(lastPrompt.current)}><RotateCcw size={13} /> Retry request</button>}</div>}
    <div className="engine-composer-area">
      {attachments.length > 0 && <div className="engine-attachments">{attachments.map(file => <button key={file} onClick={() => setAttachments(attachments.filter(f => f !== file))} title={`Remove ${file}`}><FileCode2 size={12} />{file.split('/').pop()}<X size={12} /></button>)}</div>}
      {showFiles && <div className="engine-file-picker" aria-label="Attach project files">{files.filter(f => !f.is_directory).map(file => <button key={file.path} onClick={() => { setAttachments(previous => previous.includes(file.path) ? previous : [...previous, file.path]); setShowFiles(false); }}><FileCode2 size={12} />{file.path}</button>)}{files.length === 0 && <p>No project files yet.</p>}</div>}
      <input type="file" ref={upload} hidden accept=".txt,.md,.dart,.json,.yaml,.yml,.css,.js,.ts,.tsx" onChange={async event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        if (file.size > 30000) { setError('Choose a text file under 30 KB.'); return; }
        const projectId = currentProject?.id;
        try {
          const text = await file.text();
          if (projectRef.current !== projectId) return;
          const snippet = '\n\n' + file.name + '\n' + text;
          if ((composer.current?.value.length ?? 0) + snippet.length > 32000) { setError('The attachment exceeds the remaining message length.'); return; }
          setInput(previous => previous + snippet);
          composer.current?.focus();
        } catch { setError('Could not read this file.'); }
      }} />
      <form className="engine-composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <textarea ref={composer} aria-label="Message your AI engineer" placeholder="Ask about the project, or describe what to build next…" value={input} maxLength={32000}
          disabled={running} rows={3} onChange={event => { setInput(event.target.value); setSaved(false); }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
        <div className="engine-composer-footer">
          <button type="button" className="engine-icon-button" aria-label="Add a local text file" title="Add a local text file" disabled={running} onClick={() => upload.current?.click()}><Plus size={16} /></button>
          <button type="button" className="engine-icon-button" aria-label="Attach a project file" title="Attach a project file" disabled={running} onClick={() => setShowFiles(!showFiles)}><FolderOpen size={16} /></button>
          <button type="button" className="engine-icon-button" aria-label="Manage agent capability skills" title="Generator settings" onClick={() => setSkillsOpen(true)}><Code2 size={15} /></button>
          <span className="engine-composer-hint">{saved ? <><Check size={12} /> Conversation updated</> : 'Shift + Enter for a new line'}</span>
          {running ? <button type="button" className="engine-send" aria-label="Stop" onClick={stop}><Square size={14} fill="currentColor" /></button> : <button className="engine-send" type="submit" aria-label="Submit" disabled={!input.trim() || !currentProject}><ArrowUp size={18} /></button>}
        </div>
      </form>
      <div className="studio-context-meta"><span>Project context · {files.filter(file => !file.is_directory).length} files</span><span title="Message length in characters">{input.length.toLocaleString()} / 32k</span></div>
    </div>
    <SkillsModal isOpen={skillsOpen} onClose={() => setSkillsOpen(false)} projectId={currentProject?.id} />
  </div>;
}
