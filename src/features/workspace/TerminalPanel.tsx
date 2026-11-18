import { useCallback, useEffect, useRef, useState } from 'react';
import { useTerminalStore } from '@/stores/terminal.store';
import { useProjectStore } from '@/stores/project.store';
import { cn } from '@/utils/cn';

const LOCAL_HELP = `Allowed commands (run in the project workspace on the harness server):
  flutter analyze | test | pub get | pub upgrade | pub outdated | pub deps
  dart analyze | format | fix | test | pub get
  git status | log | diff | show | branch | ls-files | rev-parse | blame
  ls [-a] [-l] [path]        pwd
  cat <file>                 head|tail [-n N] <file>
  grep|rg [-r] [-i] [-n] [-l] [-c] <pattern> [path]
  find [path] [-name "*.dart"] [-type f|d] [-maxdepth N]
  wc [-l|-w|-c] <file>
  mkdir [-p] <dir>           touch <file>           rm <file>
  help                       clear

No shell operators or pipes. Use the Preview tab to build/run the app.`;

interface TerminalResponse {
  output?: string;
  code?: number;
  timedOut?: boolean;
  kind?: string;
  error?: string;
}

export function TerminalPanel() {
  const { lines, addLine, clearLines } = useTerminalStore();
  const { currentProject } = useProjectStore();
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  const append = useCallback((text: string) => {
    for (const line of text.replace(/\n$/, '').split('\n').slice(0, 400)) {
      addLine({ type: 'output', content: line });
    }
  }, [addLine]);

  const fallbackLocal = useCallback((cmd: string): boolean => {
    const [nameRaw, ...rest] = cmd.trim().split(/\s+/);
    const name = nameRaw.toLowerCase();
    const target = rest.join(' ').trim();
    const files = useProjectStore.getState().files;

    if (name === 'pwd') {
      addLine({ type: 'output', content: `/projects/${currentProject?.id ?? 'workspace'} — local view (harness server offline)` });
      return true;
    }
    if (name === 'ls') {
      const topLevel = [...new Set(files.map((file) => file.path.split('/')[0]))].sort();
      addLine({ type: 'output', content: 'Local file view — harness server offline; nothing was executed.' });
      for (const item of topLevel) addLine({ type: 'output', content: item });
      return true;
    }
    if (name === 'cat' && target) {
      const file = files.find((candidate) => candidate.path === target || candidate.path.endsWith(`/${target}`));
      if (!file?.content) {
        addLine({ type: 'error', content: `cat: ${target}: no such file in the loaded project` });
        return true;
      }
      addLine({ type: 'output', content: 'Local file view — harness server offline; nothing was executed.' });
      append(file.content.split('\n').slice(0, 200).join('\n'));
      return true;
    }
    return false;
  }, [addLine, append, currentProject?.id]);

  async function runCommand(cmd: string) {
    setRunning(true);
    try {
      const response = await fetch('/api/terminal/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject?.id ?? 'anonymous', command: cmd }),
      });
      const data = (await response.json().catch(() => ({}))) as TerminalResponse;

      if (!response.ok) {
        addLine({ type: 'error', content: data.error || `Terminal request failed (${response.status}).` });
        if (fallbackLocal(cmd)) return;
        addLine({ type: 'error', content: 'Command was NOT executed. Start the harness server with: npm run server' });
        return;
      }
      if (data.error) {
        addLine({ type: 'error', content: data.error });
        return;
      }
      if (data.output) append(data.output);
      if (data.timedOut) {
        addLine({ type: 'error', content: '✗ Command timed out. Nothing was retried.' });
      } else if (typeof data.code === 'number' && data.code !== 0) {
        addLine({ type: 'error', content: `✗ exit code ${data.code}` });
      }
    } catch (error) {
      addLine({ type: 'error', content: `Harness server offline — ${error instanceof Error ? error.message : 'request failed'}` });
      if (!fallbackLocal(cmd)) {
        addLine({ type: 'error', content: 'Command was NOT executed. Start the harness server with: npm run server' });
      }
    } finally {
      setRunning(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  async function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (history.length === 0) return;
      const next = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      input.value = history[next] ?? '';
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (historyIndex < 0) return;
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(-1);
        input.value = '';
      } else {
        setHistoryIndex(next);
        input.value = history[next] ?? '';
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      clearLines();
      return;
    }
    if (event.key !== 'Enter') return;

    const cmd = input.value.trim();
    if (!cmd || running) return;
    addLine({ type: 'command', content: `$ ${cmd}` });
    input.value = '';
    setHistory((previous) => (previous[previous.length - 1] === cmd ? previous : [...previous, cmd]).slice(-100));
    setHistoryIndex(-1);

    const lower = cmd.toLowerCase();
    if (lower === 'clear' || lower === 'cls') {
      clearLines();
      return;
    }
    if (lower === 'help') {
      for (const line of LOCAL_HELP.split('\n')) addLine({ type: 'output', content: line });
      return;
    }
    await runCommand(cmd);
  }

  return (
    <div
      className="flex flex-col h-full bg-[#00101e] font-mono text-xs"
      onClick={() => inputRef.current?.focus()}
    >
      <div ref={scrollRef} className="flex-1 overflow-y-auto ff-scrollbar px-3 py-2 space-y-0.5">
        {lines.length === 0 && (
          <div className="text-[#748ea0]">
            FlutterForge Terminal — real commands in the project workspace. Type &quot;help&quot; for the allowlist.
          </div>
        )}
        {lines.map((line) => (
          <div
            key={line.id}
            className={cn(
              'whitespace-pre-wrap',
              line.type === 'command' && 'text-[#c5fa75]',
              line.type === 'output' && 'text-[rgba(248,255,248,0.75)]',
              line.type === 'error' && 'text-red-400',
              line.type === 'success' && 'text-emerald-400'
            )}
          >
            {line.content}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1 px-3 py-1.5 border-t border-[rgba(248,255,248,0.10)] bg-[rgba(0,16,30,0.80)]">
        <span className={cn('text-[#c5fa75]', running && 'animate-pulse')}>
          {running ? '…' : '$'}
        </span>
        <input
          ref={inputRef}
          onKeyDown={handleKeyDown}
          placeholder={running ? 'Running on the harness server…' : 'Type a command… (help)'}
          disabled={running}
          spellCheck={false}
          autoComplete="off"
          className="flex-1 bg-transparent outline-none text-[#f8fff8] placeholder:text-[#748ea0] font-mono text-xs disabled:opacity-60"
        />
        <span className="text-[10px] text-[#748ea0] select-none">
          {currentProject ? 'project shell' : 'no project'}
        </span>
      </div>
    </div>
  );
}
