import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowRight,
  ChevronDown,
  Copy,
  FileCode2,
  FolderOpen,
  MessageSquare,
  Plus,
  RotateCcw,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import { SkillRegistry } from '@/agent/skills';
import { SkillsModal } from '@/features/workspace/SkillsModal';
import { useProjectStore, type SendMessageOptions } from '@/stores/project.store';
import { usePreviewStore } from '@/stores/preview.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useTerminalStore } from '@/stores/terminal.store';
import { useActivityStore } from '@/stores/activity.store';
import { classifyChatIntent, detectIntentHeuristic, BUILDER_INTENTS } from '@/agent/chatIntent';
import { ChatError, classifyChatError, isAbortError, type ChatErrorDetails } from '@/agent/chatTypes';
import type { ModelPreference } from '@/agent/modelRouting';
import { useCredentialsStore } from '@/stores/credentials.store';
import { ChatContextHandler } from '@/agent/chatContext';
import { toast } from '@/components/ui/Toast';
import { BrandLogo } from '@/components/BrandLogo';
import { RunActivity } from '@/features/workspace/RunActivity';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
  MessageToolbar,
} from '@/components/ai-elements/message';
import { Suggestion } from '@/components/ai-elements/suggestion';
import {
  PromptInput,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import { Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources';
import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationSource,
  InlineCitationText,
} from '@/components/ai-elements/inline-citation';
import { cn } from '@/utils/cn';
import { OpenRouterKeyModal } from '@/components/OpenRouterKeyModal';
import { ShareModal } from '@/features/workspace/ShareModal';
import type { AIMessage, FileChange } from '@/types';

const SUGGESTIONS = [
  {
    label: 'Apple-style calculator',
    prompt: 'Build a colorful calculator app like the Apple Calculator with all basic and scientific functions, a history panel, and keyboard support. Local only — no backend.',
  },
  {
    label: 'Habit tracker',
    prompt: 'Build a habit streak tracker with daily check-ins, weekly progress rings, reminders, and local persistence. No backend.',
  },
  {
    label: 'Food delivery app',
    prompt: 'Build a food delivery app with restaurants, menus, cart, checkout, and Supabase auth, orders, and RLS policies.',
  },
  {
    label: 'AI chat assistant',
    prompt: 'Build an AI chat assistant with conversations, streaming replies, Markdown rendering, and Supabase auth and message history.',
  },
];

type PanelVariant = 'sidebar' | 'page';

/** Identical prompts sent within this window are dropped (double-click protection). */
const DUPLICATE_SEND_WINDOW_MS = 2000;

/** Local id with a fallback — used for the synthetic "stopped" assistant message. */
function newLocalId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function shortModel(modelId: string | undefined): string {
  if (!modelId) return 'FlutterForge Agent';
  const base = modelId.split('/').pop() || modelId;
  return base.replace(/:free$/, '').replace(/-/g, ' ');
}

function timeLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('success', 'Copied to clipboard');
  } catch {
    toast('error', 'Could not copy to clipboard');
  }
}

function buildStatusMessage(status: string): string {
  if (status === 'queued' || status === 'building') return 'Preview build started';
  if (status === 'running') return 'Preview is live';
  if (status === 'failed') return 'Preview build failed';
  if (status === 'stopped') return 'Preview build stopped';
  return 'Preview status changed';
}

function ChangedFiles({ files, onOpen }: { files: FileChange[]; onOpen: (path: string) => void }) {
  const unique = files.filter((file, index, list) => (
    list.findIndex((item) => item.path === file.path) === index
  ));
  if (unique.length === 0) return null;

  return (
    <Sources>
      <SourcesTrigger count={unique.length}>
        <InlineCitation>
          <InlineCitationText>Used {unique.length} project {unique.length === 1 ? 'source' : 'sources'}</InlineCitationText>
        </InlineCitation>
        <ChevronDown className="size-4" />
      </SourcesTrigger>
      <SourcesContent>
        {unique.map((file) => (
          <InlineCitation key={file.path}>
            <InlineCitationCard>
              <InlineCitationCardTrigger
                onClick={() => file.action !== 'deleted' && onOpen(file.path)}
                onKeyDown={(event) => {
                  if (file.action === 'deleted') return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpen(file.path);
                  }
                }}
                role={file.action === 'deleted' ? undefined : 'button'}
                tabIndex={file.action === 'deleted' ? undefined : 0}
                aria-label={`Open ${file.path}`}
                sources={[file.path]}
                title={file.path}
              />
              <InlineCitationCardBody>
                <div className="space-y-2 p-3">
                  <InlineCitationSource
                    description={`${file.action} by FlutterForge`}
                    title={file.path}
                  />
                  {file.action !== 'deleted' && (
                    <button
                      className="text-xs font-medium text-primary hover:underline"
                      onClick={() => onOpen(file.path)}
                      type="button"
                    >
                      Open file
                    </button>
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

function MessageBubble({
  message,
  page,
  onOpen,
  onRetry,
  canRetry,
  onPromptClick,
  onViewPreview,
}: {
  message: AIMessage;
  page: boolean;
  onOpen: (path: string) => void;
  onRetry: () => void;
  canRetry: boolean;
  onPromptClick?: (prompt: string) => void;
  onViewPreview?: () => void;
}) {
  const isUser = message.role === 'user';
  const changedFiles = Array.isArray(message.changed_files) ? message.changed_files : [];
  const metadata = (message.metadata ?? {}) as { nextActionPrompts?: unknown; stopped?: unknown };
  const isStopped = metadata.stopped === true;
  const nextActions = Array.isArray(metadata.nextActionPrompts)
    ? metadata.nextActionPrompts.filter((item): item is string => typeof item === 'string')
    : [];

  return (
    <Message className={cn(page ? 'max-w-full' : 'max-w-[94%]')} from={message.role}>
      {!isUser && (
        <div className="flex items-center gap-2 px-0.5 text-[11px]">
          <span className="grid size-6 place-items-center rounded-full border border-[rgba(197,250,117,0.30)] bg-[rgba(197,250,117,0.12)] text-[#c5fa75]">
            <MessageSquare className="size-3 text-[#c5fa75]" />
          </span>
          <span className="font-semibold text-[#f8fff8]">FlutterForge</span>
          <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-[#748ea0]">{timeLabel(message.created_at)}</span>
          {isStopped && (
            <span
              className="rounded-full border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-[0.14em] text-amber-400"
              role="note"
              title="Generation stopped by user"
            >
              Stopped
            </span>
          )}
        </div>
      )}
      <MessageContent className={cn(
        page && !isUser && 'w-full',
        isUser && 'rounded-[18px] border border-[rgba(248,255,248,0.14)] bg-[linear-gradient(135deg,#0c2236_0%,#001424_100%)] text-[#f8fff8] px-4 py-3 shadow-md',
      )}>
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        ) : (
          <MessageResponse>{message.content}</MessageResponse>
        )}
        {!isUser && changedFiles.length > 0 && (
          <div className="mt-2 space-y-2">
            <ChangedFiles files={changedFiles} onOpen={onOpen} />
            {onViewPreview && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={onViewPreview}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[#c5fa75] px-3.5 py-1.5 text-[11px] font-bold text-[#00101e] transition-transform hover:-translate-y-px active:scale-95 shadow-[0_4px_14px_rgba(197,250,117,0.25)]"
                >
                  <ArrowRight className="size-3 text-[#00101e]" />
                  <span>Open Live Preview</span>
                </button>
              </div>
            )}
          </div>
        )}

        {!isUser && nextActions.length > 0 && onPromptClick && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-[rgba(248,255,248,0.10)] pt-2.5">
            <span className="w-full font-mono text-[10px] uppercase tracking-[0.14em] text-[#748ea0]">Next steps</span>
            {nextActions.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => onPromptClick(prompt)}
                className="group inline-flex items-center gap-1.5 rounded-full border border-[rgba(248,255,248,0.12)] bg-[rgba(248,255,248,0.04)] px-3 py-1 text-[11px] text-[#f8fff8] transition-all hover:border-[rgba(197,250,117,0.40)] hover:text-[#c5fa75] active:scale-95"
              >
                <ArrowRight className="size-3 text-[#748ea0] transition-all group-hover:translate-x-0.5 group-hover:text-[#c5fa75]" />
                <span>{prompt}</span>
              </button>
            ))}
          </div>
        )}
      </MessageContent>
      {!isUser && (
        <MessageToolbar className="mt-1">
          <MessageActions>
            <MessageAction
              aria-label="Copy response"
              label="Copy response"
              onClick={() => void copyText(message.content)}
              title="Copy response"
              tooltip="Copy"
            >
              <Copy className="size-3.5" />
            </MessageAction>
            {canRetry && (
              <MessageAction
                aria-label="Retry"
                label="Retry"
                onClick={onRetry}
                title="Retry"
                tooltip="Retry"
              >
                <RotateCcw className="size-3.5" />
              </MessageAction>
            )}
          </MessageActions>
        </MessageToolbar>
      )}
    </Message>
  );
}

const HANDOFF_PREFIX = 'ff-handoff:';

/**
 * The creation wizard hands the first prompt to the workspace. Route state is
 * wiped by `navigate(..., { state: null })` after consumption, so the prompt is
 * also persisted per project. This survives StrictMode double-mounts and a
 * reload between creating the project and the workspace mounting.
 */
function readHandoffPrompt(projectId: string): string | null {
  try {
    return localStorage.getItem(`${HANDOFF_PREFIX}${projectId}`);
  } catch {
    return null;
  }
}

function clearHandoffPrompt(projectId: string): void {
  try {
    localStorage.removeItem(`${HANDOFF_PREFIX}${projectId}`);
  } catch {
    // private mode / storage unavailable
  }
}

export function AIBuilderPanel({ variant = 'sidebar' }: { variant?: PanelVariant }) {
  const {
    messages,
    sendMessage,
    currentProject,
    conversation,
    repairBuild,
    stopRepair,
    files,
    newConversation,
    generatingIn,
  } = useProjectStore();
  const preview = usePreviewStore();
  const { openFile, activeFile, setActiveView } = useWorkspaceStore();
  const {
    isGenerating,
    isAnswering,
    generationError,
    setGenerating,
    setAnswering,
    setCurrentPhase,
    setGenerationError,
    addLine,
    addLiveFile,
    clearLiveFiles,
  } = useTerminalStore();
  const activity = useActivityStore();

  const page = variant === 'page';
  const [input, setInput] = useState('');
  const [streamingReply, setStreamingReply] = useState('');
  const [keyModalOpen, setKeyModalOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [errorDetails, setErrorDetails] = useState<ChatErrorDetails | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [dismissedRepair, setDismissedRepair] = useState<string | null>(null);
  const [modelPreference, setModelPreference] = useState<ModelPreference>(() => {
    try {
      const saved = (typeof localStorage !== 'undefined' ? localStorage.getItem('ff-model-preference') : null);
      return saved === 'quality' || saved === 'fast' || saved === 'auto' ? saved : 'auto';
    } catch {
      return 'auto';
    }
  });

  const [isSkillsOpen, setIsSkillsOpen] = useState(false);
  const [activeSkillCount, setActiveSkillCount] = useState(() => SkillRegistry.getActiveSkills().length);

  const busy = isGenerating || isAnswering || generatingIn === currentProject?.id;
  // The route param is the only source of truth for which project is on screen.
  // (The store mirrors it, but keying off the URL avoids ever re-pointing an
  // in-flight stream at the previous project's message list.)
  const urlProjectId = useParams<{ projectId?: string }>().projectId ?? null;
  const switchProjectId = urlProjectId ?? currentProject?.id ?? null;
  const projectRef = useRef(switchProjectId);
  // Bumped on every send, on project switch and on unmount/stop. Outgoing
  // requests carry the current nonce and streaming callbacks bail out on any
  // mismatch, so stale SSE frames can never repaint a foreign message list.
  const requestNonceRef = useRef(0);
  const streamingReplyRef = useRef('');
  const lastSendRef = useRef<{ text: string; at: number } | null>(null);
  const wasBusyRef = useRef(false);

  const composerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const autoStarted = useRef(false);
  const autoTimer = useRef<number | null>(null);
  // Stream tokens are batched to one React commit per frame. Without this,
  // fast models cause a full markdown re-render per token and the chat stutters.
  const tokenBuffer = useRef('');
  const tokenFrame = useRef<number | null>(null);
  const buildCursor = useRef<{ sessionId: string | null; logs: number; status: string | null }>({
    sessionId: null,
    logs: 0,
    status: null,
  });

  /** Cancel the pending token frame and drop unflushed batches. */
  const clearPendingTokens = useCallback(() => {
    if (tokenFrame.current !== null) {
      cancelAnimationFrame(tokenFrame.current);
      tokenFrame.current = null;
    }
    tokenBuffer.current = '';
    streamingReplyRef.current = '';
    setStreamingReply('');
  }, []);

  /**
   * Re-point any in-flight stream at nothing: invalidate nonces, abort the
   * request, drop every pending token batch and reset the per-project busy
   * state. Safe to call on unmount, project switch, new chat and stop.
   */
  const invalidateActiveStream = useCallback(() => {
    requestNonceRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    sendingRef.current = false;
    clearPendingTokens();
    setGenerating(false);
    setAnswering(false);
    setCurrentPhase(null);
    startedAtRef.current = null;
    setElapsed(0);
    useProjectStore.setState({ generatingIn: null });
  }, [clearPendingTokens, setGenerating, setAnswering, setCurrentPhase]);
  const location = useLocation();
  const navigate = useNavigate();
  const navState = location.state as { initialPrompt?: string; richPrompt?: string } | null;

  const hasMessages = messages.length > 0;
  const lastUserMessage = useMemo(
    () => [...messages].reverse().find((message) => message.role === 'user')?.content ?? '',
    [messages],
  );
  const lastAssistant = useMemo(
    () => [...messages].reverse().find((message) => message.role === 'assistant'),
    [messages],
  );
  const userMessageCount = messages.filter((message) => message.role === 'user').length;
  const lastAssistantIndex = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === 'assistant') return index;
    }
    return -1;
  }, [messages]);
  const showActivity = Boolean(activity.run) || activity.events.length > 0;
  const modelLabel = shortModel(
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_AGENT_MODEL) || undefined,
  );

  // Unmount: abort the in-flight stream and clear every pending timer, frame
  // and token batch. Without this, a request that outlives the panel keeps
  // appending tokens to a message list the user is no longer looking at.
  useEffect(() => {
    return () => {
      requestNonceRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      sendingRef.current = false;
      if (autoTimer.current !== null) {
        window.clearTimeout(autoTimer.current);
        autoTimer.current = null;
      }
      if (tokenFrame.current !== null) {
        cancelAnimationFrame(tokenFrame.current);
        tokenFrame.current = null;
      }
      tokenBuffer.current = '';
      streamingReplyRef.current = '';
      startedAtRef.current = null;
      buildCursor.current = { sessionId: null, logs: 0, status: null };
    };
  }, []);

  // Project switch (sourced from the URL param): re-point every stream at
  // nothing and wipe per-project UI state so the previous project's stream,
  // errors, attachments and build cursor can never bleed into the new one.
  useEffect(() => {
    if (projectRef.current === switchProjectId) return;
    projectRef.current = switchProjectId;
    lastSendRef.current = null;
    autoStarted.current = false;
    invalidateActiveStream();
    buildCursor.current = { sessionId: null, logs: 0, status: null };
    setErrorDetails(null);
    setGenerationError(null);
    setAttachedFiles([]);
    clearLiveFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switchProjectId, invalidateActiveStream]);

  useEffect(() => {
    try {
      localStorage.setItem('ff-model-preference', modelPreference);
    } catch {
      // private mode / storage unavailable
    }
  }, [modelPreference]);

  useEffect(() => {
    void useCredentialsStore.getState().load();
  }, []);

  useEffect(() => {
    if (currentProject?.id) useActivityStore.getState().load(currentProject.id);
  }, [currentProject?.id]);

  // Re-focus the composer once a send settles. The textarea is disabled while
  // busy, which drops focus to <body>; without this the user has to re-click.
  useEffect(() => {
    const wasBusy = wasBusyRef.current;
    wasBusyRef.current = busy;
    if (!wasBusy || busy) return;
    const frame = window.requestAnimationFrame(() => focusComposer());
    return () => window.cancelAnimationFrame(frame);
  }, [busy]);

  useEffect(() => {
    if (!busy) {
      startedAtRef.current = null;
      setElapsed(0);
      return;
    }
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    const timer = window.setInterval(() => {
      if (startedAtRef.current !== null) {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const buildSession = currentProject ? preview.getSession(currentProject.id) : null;

  useEffect(() => {
    if (!buildSession) return;
    const store = useActivityStore.getState();
    if (buildCursor.current.sessionId !== buildSession.sessionId) {
      buildCursor.current = { sessionId: buildSession.sessionId, logs: 0, status: null };
    }
    const cursor = buildCursor.current;
    for (let index = cursor.logs; index < buildSession.logs.length; index++) {
      store.ingestBuildLog(buildSession.logs[index]);
    }
    cursor.logs = buildSession.logs.length;
    if (cursor.status !== buildSession.status) {
      cursor.status = buildSession.status;
      const errors = buildSession.logs.filter((line) => (
        /error|exception|failed to|because|not found|invalid|undefined/i.test(line)
      ));
      store.ingestBuildStatus(buildSession.status, buildStatusMessage(buildSession.status), errors);
    }
  }, [buildSession?.sessionId, buildSession?.status, buildSession?.logs]); // eslint-disable-line react-hooks/exhaustive-deps

  const showRepair = Boolean(
    buildSession
    && buildSession.status === 'failed'
    && dismissedRepair !== buildSession.sessionId
    && !busy,
  );
  const repairHint = (buildSession?.logs ?? [])
    .filter((line) => /error|exception|because|failed to|not found|invalid/i.test(line))
    .slice(0, 2);

  const contextInfo = useMemo(() => ChatContextHandler.build({
    projectName: currentProject?.name ?? 'Project',
    projectDescription: currentProject?.description ?? '',
    files,
    messages,
    activeFile,
    buildErrors: buildSession?.logs ?? [],
    question: input || lastUserMessage,
  }), [currentProject?.name, currentProject?.description, files, messages, activeFile, buildSession?.logs, input, lastUserMessage]);

  const tokenBudget = 12000;
  const tokenPct = Math.min(100, Math.round((contextInfo.tokenEstimate / tokenBudget) * 100));
  const tokenLabel = contextInfo.tokenEstimate >= 1000
    ? `${(contextInfo.tokenEstimate / 1000).toFixed(1)}k`
    : String(contextInfo.tokenEstimate);

  const focusComposer = () => {
    composerRef.current?.querySelector('textarea')?.focus();
  };

  function handleNewChat() {
    if (!currentProject) return;
    // A fresh conversation invalidates any in-flight stream for the old one;
    // its late tokens must never land in the new message list.
    lastSendRef.current = null;
    invalidateActiveStream();
    setErrorDetails(null);
    autoStarted.current = true;
    void newConversation(currentProject.id).then(() => {
      useActivityStore.getState().clear();
      setGenerationError(null);
      setInput('');
      setStreamingReply('');
      focusComposer();
    }).catch((error) => {
      toast('error', error instanceof Error ? error.message : 'Could not start a new chat.');
    });
  }

  function handleStop() {
    // Capture the partial assistant reply (flushed tokens + unflushed buffer)
    // BEFORE tearing streaming state down.
    if (tokenFrame.current !== null) {
      cancelAnimationFrame(tokenFrame.current);
      tokenFrame.current = null;
    }
    const partial = (streamingReplyRef.current + tokenBuffer.current).trim();
    const projectAtStop = useProjectStore.getState().currentProject?.id ?? null;
    const conversationAtStop = useProjectStore.getState().conversation?.id ?? null;

    lastSendRef.current = null;
    stopRepair();
    useProjectStore.setState({ generatingIn: null });
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    // Any late SSE frames for the aborted stream are dropped from here on.
    requestNonceRef.current += 1;
    sendingRef.current = false;
    tokenBuffer.current = '';
    streamingReplyRef.current = '';
    setStreamingReply('');
    setGenerating(false);
    setAnswering(false);
    setCurrentPhase(null);
    setGenerationError('Generation stopped.');
    setErrorDetails({ kind: 'cancelled', message: 'Generation stopped.', retryable: false });
    addLine({ type: 'error', content: '⏹ Generation stopped by user' });
    const store = useActivityStore.getState();
    if (store.run?.status === 'running') store.end('stopped', 'Generation stopped by user');

    // Keep the partial reply in the transcript, marked stopped — but only
    // when the project/conversation still matches; never write a foreign
    // message into a list that has since switched project.
    if (partial && projectAtStop) {
      const state = useProjectStore.getState();
      if (state.currentProject?.id === projectAtStop) {
        const stoppedMessage: AIMessage = {
          id: newLocalId(),
          conversation_id: conversationAtStop ?? state.conversation?.id ?? '',
          role: 'assistant',
          content: partial,
          tool_calls: null,
          changed_files: null,
          metadata: { stopped: true, stoppedAt: new Date().toISOString() },
          created_at: new Date().toISOString(),
        };
        useProjectStore.setState((s) => ({ messages: [...s.messages, stoppedMessage] }));
      }
    }
  }

  /**
   * Retrying must never masquerade as a first generation. Replaying the
   * original prompt as `isInitialGeneration` discards the files already saved
   * and runs the whole multi-agent pipeline again. Any prior assistant reply
   * or generated Flutter file makes a targeted repair the honest action.
   */
  function retryOptions(): SendMessageOptions {
    const hasGeneratedFiles = files.some((file) => (
      !file.is_directory && (file.path === 'lib/main.dart' || file.path.startsWith('lib/features/'))
    ));
    const hasPriorWork = messages.some((message) => message.role === 'assistant') || hasGeneratedFiles;
    if (hasPriorWork) {
      return { isRepair: true, repairRound: 1, isInitialGeneration: false, autoRepairBuild: true };
    }
    return {
      isInitialGeneration: userMessageCount <= 1 && classifyChatIntent(lastUserMessage) === 'build',
    };
  }

  async function handleSend(prompt?: string, opts?: SendMessageOptions) {
    const text = (prompt ?? input).trim();
    if (!text || busy || sendingRef.current || !currentProject) return;

    // Drop identical prompts sent within a short window — this is the
    // double-click / double-fire guard (retry re-sending the same text twice,
    // suggestion buttons hitting send twice, …).
    const now = Date.now();
    const lastSend = lastSendRef.current;
    if (lastSend && lastSend.text === text && now - lastSend.at < DUPLICATE_SEND_WINDOW_MS) {
      console.warn(
        `[AIBuilderPanel] Dropping duplicate prompt sent ${now - lastSend.at}ms ago: "${text.slice(0, 80)}"`,
      );
      return;
    }

    const attachments = opts?.attachedFiles ?? attachedFiles;
    lastSendRef.current = { text, at: now };
    // Generation/session nonce: outgoing requests carry it, every streaming
    // callback checks it, so a stale response from a previous project or
    // stopped request is never rendered or persisted.
    const nonce = ++requestNonceRef.current;
    const isCurrent = () => nonce === requestNonceRef.current;

    sendingRef.current = true;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;
    setInput('');
    setAttachedFiles([]);
    clearPendingTokens();
    setGenerationError(null);
    setErrorDetails(null);
    clearLiveFiles();

    const isNewApp = opts?.isInitialGeneration === true || messages.length === 0;
    // If no OpenRouter key, show key modal before starting generation
    const storage = typeof localStorage !== 'undefined' ? localStorage : null;
    const hasApiKey = Boolean(
      storage?.getItem('openrouter_api_key') ||
      storage?.getItem('openrouter_key') ||
      storage?.getItem('ff_openrouter_key')
    );
    if (!hasApiKey && (opts?.isInitialGeneration || classifyChatIntent(text) === 'build')) {
      // Release the send guard: this call never reached the store. The prompt
      // is restored so it is not lost while the key modal is open. The dedupe
      // record is rolled back too, so pressing Send again right after pasting
      // a key is not mistaken for a double-click.
      sendingRef.current = false;
      abortRef.current = null;
      lastSendRef.current = null;
      setInput(text);
      setKeyModalOpen(true);
      return;
    }
    const intentDecision = opts?.isInitialGeneration || opts?.isRepair
      ? { intent: 'feature' as const }
      : detectIntentHeuristic(text, {
          projectFiles: files.map((f) => f.path),
          hasErrors: Boolean(buildSession?.status === 'failed'),
        });
    const isBuilderAction = opts?.isInitialGeneration || opts?.isRepair || BUILDER_INTENTS.has(intentDecision.intent);
    let runId: string | null = null;
    let ended = false;

    try {
      if (!isBuilderAction) {
        setAnswering(true);
        setCurrentPhase('Thinking…');
        const chatPayload: SendMessageOptions & { sessionNonce: number } = {
          ...opts,
          modelPreference: opts?.modelPreference ?? modelPreference,
          attachedFiles: attachments,
          signal,
          sessionNonce: nonce,
          onChatEvent: (event) => {
            if (!isCurrent()) return;
            useActivityStore.getState().ingestChatEvent(event);
          },
          onToken: (token) => {
            if (!isCurrent()) return;
            tokenBuffer.current += token;
            if (tokenFrame.current !== null) return;
            tokenFrame.current = requestAnimationFrame(() => {
              tokenFrame.current = null;
              if (!isCurrent()) {
                tokenBuffer.current = '';
                return;
              }
              const buffered = tokenBuffer.current;
              tokenBuffer.current = '';
              if (buffered) {
                streamingReplyRef.current += buffered;
                setStreamingReply((reply) => reply + buffered);
              }
            });
          },
          onRetry: (message) => {
            if (!isCurrent()) return;
            tokenBuffer.current = '';
            streamingReplyRef.current = '';
            setStreamingReply('');
            setCurrentPhase(message);
          },
        };
        const result = await sendMessage(
          currentProject.id,
          text,
          (message) => {
            if (isCurrent()) setCurrentPhase(message);
          },
          chatPayload,
        );
        if (!isCurrent()) return;
        if (result.mode === 'duplicate') {
          setGenerationError('A response is already in progress for this chat.');
          return;
        }
        // The final assistant message is already in `messages` with the full
        // reply; drop any buffered tokens so a late frame cannot repaint it.
        clearPendingTokens();
        addLine({ type: 'success', content: '✓ Answered — project files untouched' });
        return;
      }

      const store = useActivityStore.getState();
      store.begin(currentProject.id, text, isNewApp, modelLabel);
      runId = useActivityStore.getState().run?.id ?? null;

      setGenerating(true);
      setCurrentPhase(isNewApp ? 'Starting AI Agent…' : 'Applying your changes…');
      addLine({ type: 'output', content: `▶ ${text.slice(0, 140)}` });

      // Builder payload: carries a generation/session nonce so late streaming
      // events from a superseded send are dropped, never applied.
      const generationPayload: SendMessageOptions & { sessionNonce: number } = {
        ...opts,
        isEdit: !isNewApp,
        existingFiles: !isNewApp ? files.map(f => ({ path: f.path, content: f.content })) : undefined,
        modelPreference: opts?.modelPreference ?? modelPreference,
        attachedFiles: attachments,
        signal,
        sessionNonce: nonce,
        onEvent: (event) => {
          if (!isCurrent()) return;
          useActivityStore.getState().ingestAgent(event);
          if (event.generatedFiles) {
            for (const file of event.generatedFiles) {
              if (file.path) addLiveFile(file.path);
            }
          }
          if (event.message) {
            setCurrentPhase(event.message);
            addLine({ type: 'output', content: event.message });
            if (event.message.startsWith('✓ ')) {
              const file = event.message.replace(/^✓\s*/, '').trim();
              if (file) addLiveFile(file);
            }
          }
        },
        onFile: (file) => {
          if (!isCurrent()) return;
          useActivityStore.getState().ingestFile(file);
          addLiveFile(file.path);
        },
      };
      const result = await sendMessage(
        currentProject.id,
        text,
        (message) => {
          if (!isCurrent()) return;
          setCurrentPhase(message);
          useActivityStore.getState().ingestProgress(message);
        },
        generationPayload,
      );
      if (!isCurrent()) return;

      if (result.mode === 'duplicate') {
        setGenerationError('A generation is already running for this chat.');
        useActivityStore.getState().end('error', 'Generation already running');
        ended = true;
        return;
      }
      if (result.mode === 'chat') return;

      const count = result.fileCount ?? result.files?.length ?? 0;
      if (count === 0) {
        setGenerationError('The engine returned no files. Your project was not changed — please retry.');
        useActivityStore.getState().end('error', 'The engine returned no files');
        ended = true;
        return;
      }

      // Files are saved, but the authoritative build/analysis gates rejected
      // the result. Never show the user a green “App generated” toast here.
      if (result.verified === false) {
        const failed = (result.verification?.gates ?? [])
          .filter((gate) => gate.status === 'fail')
          .map((gate) => `${gate.id} ${gate.detail}`)
          .join('; ');
        const message = `Files saved, but verification failed${failed ? `: ${failed}` : '.'}`;
        setGenerationError(message);
        addLine({ type: 'error', content: `✗ ${message}` });
        toast('warning', message.length > 160 ? `${message.slice(0, 157)}…` : message);
        useActivityStore.getState().end('error', message);
        ended = true;
        return;
      }

      toast('success', isNewApp ? `App generated (${count} files)` : `Updated ${count} files`);
      useActivityStore.getState().end('success', isNewApp ? `Generated ${count} files` : `Updated ${count} files`);
      ended = true;
    } catch (error) {
      if (!isCurrent()) return;
      // A failed send must not eat a legitimate immediate retry.
      lastSendRef.current = null;
      if (signal.aborted || isAbortError(error)) {
        setGenerationError('Generation stopped.');
        setErrorDetails({ kind: 'cancelled', message: 'Generation stopped.', retryable: false });
        useActivityStore.getState().end('stopped', 'Generation stopped by user');
        ended = true;
        return;
      }
      const classified = error instanceof ChatError
        ? error
        : classifyChatError(error, signal);
      setErrorDetails(classified);
      setGenerationError(classified.message);
      addLine({ type: 'error', content: `✗ ${classified.message}` });
      useActivityStore.getState().end('error', classified.message);
      ended = true;
    } finally {
      // A newer send, a project switch or a stop already owns the lifecycle
      // state — a superseded request must not tear it down.
      if (isCurrent()) {
        if (tokenFrame.current !== null) {
          cancelAnimationFrame(tokenFrame.current);
          tokenFrame.current = null;
        }
        tokenBuffer.current = '';
        streamingReplyRef.current = '';
        sendingRef.current = false;
        abortRef.current = null;
        setGenerating(false);
        setAnswering(false);
        setCurrentPhase(null);
        if (runId && !ended) {
          const store = useActivityStore.getState();
          if (store.run?.id === runId && store.run.status === 'running') {
            store.end(signal.aborted ? 'stopped' : 'success');
          }
        }
      }
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    const sendsWithModifier = (event.metaKey || event.ctrlKey) && event.key === 'Enter';
    const sendsOnEnter = event.key === 'Enter'
      && !event.shiftKey
      && !event.metaKey
      && !event.ctrlKey
      && !event.altKey;
    if (sendsWithModifier || sendsOnEnter) {
      event.preventDefault();
      void handleSend();
    }
  }

  // Wizard hand-off: fire the first prompt once for a brand-new, empty project.
  // Never auto-start over an existing conversation or generated files — that
  // replay was the full `[1/13]` regeneration.
  useEffect(() => {
    if (!currentProject || !conversation || autoStarted.current) return;
    if (conversation.project_id !== currentProject.id) return;
    const projectId = currentProject.id;
    const storedPrompt = readHandoffPrompt(projectId);
    const hasFiles = files.some((file) => !file.is_directory);
    if (messages.length > 0 || hasFiles) {
      // Stale hand-off: the project already has work, so it must never be
      // applied on top of it.
      if (storedPrompt) clearHandoffPrompt(projectId);
      return;
    }
    const prompt = storedPrompt?.trim() || navState?.richPrompt?.trim() || navState?.initialPrompt?.trim();
    if (!prompt) return;
    autoTimer.current = window.setTimeout(() => {
      autoTimer.current = null;
      autoStarted.current = true;
      clearHandoffPrompt(projectId);
      // Consume route state so a remount or navigation cannot replay it.
      if (navState) {
        navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
      }
      void handleSend(prompt, { isInitialGeneration: true });
    }, 350);
    return () => {
      if (autoTimer.current !== null) {
        window.clearTimeout(autoTimer.current);
        autoTimer.current = null;
        autoStarted.current = false;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id, conversation?.id, messages.length, files.length]);

  // Native menu bridge + toolbar events.
  useEffect(() => {
    const focus = () => focusComposer();
    const stop = () => handleStop();
    const retry = () => {
      if (lastUserMessage) void handleSend(lastUserMessage, retryOptions());
    };
    const copyLast = () => {
      if (lastAssistant) void copyText(lastAssistant.content);
    };
    const newChat = () => handleNewChat();
    const prefill = (event: Event) => {
      const text = (event as CustomEvent<{ text?: string }>).detail?.text;
      if (!text) return;
      setInput((previous) => (previous.trim() ? previous : text));
      window.requestAnimationFrame(focusComposer);
    };
    window.addEventListener('ff:focus-composer', focus);
    window.addEventListener('ff:stop-generation', stop);
    window.addEventListener('ff:retry-last', retry);
    window.addEventListener('ff:copy-last', copyLast);
    window.addEventListener('ff:new-chat', newChat);
    window.addEventListener('ff:prefill-composer', prefill);
    return () => {
      window.removeEventListener('ff:focus-composer', focus);
      window.removeEventListener('ff:stop-generation', stop);
      window.removeEventListener('ff:retry-last', retry);
      window.removeEventListener('ff:copy-last', copyLast);
      window.removeEventListener('ff:new-chat', newChat);
      window.removeEventListener('ff:prefill-composer', prefill);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastUserMessage, lastAssistant?.id, userMessageCount, currentProject?.id]);

  // Escape closes any panel-owned dialog/popover (the Radix primitives used
  // for menus and inline cards close themselves; this covers the skills,
  // key and share dialogs).
  useEffect(() => {
    if (!isSkillsOpen && !keyModalOpen && !shareOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setIsSkillsOpen(false);
      setKeyModalOpen(false);
      setShareOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isSkillsOpen, keyModalOpen, shareOpen]);

  const projectFiles = files.filter((file) => !file.is_directory);

  const panelHeader = (
    <header className={cn(
      'flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2.5 sm:px-4',
      page
        ? 'border-[rgba(248,255,248,0.10)] bg-[linear-gradient(180deg,#001525_0%,#00101e_100%)] backdrop-blur-xl'
        : 'border-[rgba(248,255,248,0.10)] bg-[linear-gradient(124deg,#00101e_8%,#1f3747_19%,#163348_32%,#0e2338_56%,#00101e_100%)]',
    )}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-[rgba(248,255,248,0.14)] bg-[rgba(248,255,248,0.07)] text-[#c5fa75]">
          <MessageSquare className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-semibold tracking-[-0.02em] text-[#f8fff8]" style={{ fontFamily: "'Lime Panchang', sans-serif" }}>
            AI Builder
          </div>
          <div className="mt-1 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[#748ea0]">
            <span className={cn(
              'h-1.5 w-1.5 rounded-full',
              busy ? 'animate-pulse bg-amber-400' : 'bg-[#c5fa75]',
            )} />
            <span className="truncate">
              {busy ? `Working · ${elapsed}s` : 'Ready'}
            </span>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          aria-label="Manage agent capability skills"
          className="flex h-8 items-center gap-1.5 rounded-full border border-[rgba(248,255,248,0.14)] bg-[rgba(248,255,248,0.05)] px-2.5 font-mono text-[9px] uppercase tracking-[0.08em] text-[#748ea0] outline-none transition-colors hover:border-[rgba(197,250,117,0.40)] hover:text-[#c5fa75]"
          onClick={() => setIsSkillsOpen(true)}
          title="Connect modular Flutter capability skills (Material 3, Clean Architecture, Animations, Web Parity...)"
          type="button"
        >
          <Sparkles className="size-3 text-[#c5fa75]" />
          <span className="hidden sm:inline">Skills</span>
          <span className="grid size-4 place-items-center rounded-full bg-[rgba(197,250,117,0.15)] text-[8px] font-bold text-[#c5fa75]">
            {activeSkillCount}
          </span>
        </button>
        <label className="sr-only" htmlFor="ff-model-preference">Generation model</label>
        <select
          aria-label="Generation model"
          className="h-8 max-w-[88px] rounded-full border border-[rgba(248,255,248,0.14)] bg-[rgba(248,255,248,0.05)] px-2.5 font-mono text-[9px] uppercase tracking-[0.08em] text-[#748ea0] outline-none transition-colors hover:border-[rgba(248,255,248,0.25)] hover:text-[#f8fff8] focus-visible:border-[rgba(197,250,117,0.40)] sm:max-w-[104px]"
          id="ff-model-preference"
          onChange={(event) => {
            const next = event.target.value;
            setModelPreference(next === 'quality' ? 'quality' : next === 'fast' ? 'fast' : 'auto');
          }}
          title="Auto sends first passes to the frontier model and edits to the fast model. Frontier needs Pro or your own OpenRouter key."
          value={modelPreference}
        >
          <option value="auto">Auto</option>
          <option value="fast">Fast</option>
          <option value="quality">Frontier</option>
        </select>
        <button
          aria-label="New chat"
          className="grid size-8 place-items-center rounded-full border border-[rgba(248,255,248,0.14)] bg-[rgba(248,255,248,0.05)] text-[#748ea0] transition-colors hover:border-[rgba(197,250,117,0.35)] hover:text-[#c5fa75] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(197,250,117,0.30)]"
          onClick={handleNewChat}
          title="Start a new chat"
          type="button"
        >
          <Plus className="size-4" />
        </button>
      </div>
    </header>
  );

  const composer = (
    <div className="w-full" ref={composerRef}>
      <PromptInput
        className={cn(
          '[&_[data-slot=input-group]]:rounded-[20px] [&_[data-slot=input-group]]:border-[rgba(248,255,248,0.14)] [&_[data-slot=input-group]]:bg-[rgba(0,16,30,0.80)] [&_[data-slot=input-group]]:shadow-[0_18px_44px_-38px_rgba(0,0,0,0.80)] [&_[data-slot=input-group]]:transition-colors [&_[data-slot=input-group]]:focus-within:border-[rgba(197,250,117,0.50)] [&_[data-slot=input-group]]:focus-within:ring-2 [&_[data-slot=input-group]]:focus-within:ring-[rgba(197,250,117,0.12)]',
          page && 'text-[15px]',
        )}
        onSubmit={({ text }) => {
          void handleSend(text);
        }}
      >
        <PromptInputBody>
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2">
              {attachedFiles.map((path) => (
                <span
                  className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-2 py-1 text-xs text-foreground"
                  key={path}
                >
                  <FileCode2 className="size-3 text-muted-foreground" />
                  {path.split('/').pop()}
                  <button
                    aria-label={`Remove ${path}`}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setAttachedFiles((current) => current.filter((item) => item !== path))}
                    title={`Remove ${path}`}
                    type="button"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <PromptInputTextarea
            className={cn('min-h-[64px] resize-none text-[13px] leading-relaxed text-[#f8fff8] placeholder:text-[#748ea0]', page && 'text-[15px]')}
            disabled={busy}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={busy
              ? 'Working…'
              : page
                ? 'Ask about the project, or describe what to build next…'
                : 'Describe a change or ask a question…'}
            value={input}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger aria-label="Attach a project file" title="Attach a project file" tooltip="Attach a project file" />
              <PromptInputActionMenuContent className="max-h-64 overflow-y-auto">
                {projectFiles.slice(0, 40).map((file) => (
                  <PromptInputActionMenuItem
                    key={file.path}
                    onSelect={() => setAttachedFiles((current) => (
                      current.includes(file.path) ? current : [...current, file.path].slice(0, 4)
                    ))}
                  >
                    <FileCode2 className="mr-2 size-3.5" />
                    <span className="truncate font-mono text-[11px]">{file.path}</span>
                  </PromptInputActionMenuItem>
                ))}
                {projectFiles.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">No project files yet.</div>
                )}
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
          </PromptInputTools>
          <div className="flex items-center gap-1.5">
            {currentProject && files.some((file) => file.path === 'pubspec.yaml') && (
              <PromptInputButton
                aria-label="Open pubspec.yaml"
                className="hidden sm:inline-flex"
                onClick={() => openFile('pubspec.yaml')}
                title="Open pubspec.yaml"
                tooltip="Open pubspec.yaml"
              >
                <FolderOpen className="size-3.5" />
              </PromptInputButton>
            )}
            <PromptInputSubmit
              disabled={!busy && (!input.trim() || !currentProject)}
              onStop={handleStop}
              status={busy ? 'streaming' : undefined}
              title={busy ? 'Stop generation' : 'Send message'}
            />
          </div>
        </PromptInputFooter>
      </PromptInput>
      <div className="mt-2 flex items-center justify-between gap-2 px-1">
        <span className="hidden whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.12em] text-[#748ea0] sm:block">
          {busy ? 'Stop keeps your files' : 'Enter to send · Shift+Enter for a new line'}
        </span>
        <div className="ml-auto flex items-center gap-2.5">
          <div
            className="flex items-center gap-1.5"
            title={`Estimated context: ~${contextInfo.tokenEstimate.toLocaleString()} of ${tokenBudget.toLocaleString()} tokens`}
          >
            <span className="font-mono text-[8px] uppercase tracking-[0.12em] text-[#748ea0]">ctx</span>
            <div className="h-1 w-12 overflow-hidden rounded-full bg-[rgba(248,255,248,0.07)]">
              <div
                className={cn('h-full rounded-full transition-all', tokenPct >= 90 ? 'bg-red-400' : tokenPct >= 70 ? 'bg-amber-400' : 'bg-[#c5fa75]')}
                style={{ width: `${tokenPct}%` }}
              />
            </div>
            <span className="font-mono text-[9px] tabular-nums text-[#748ea0]">{tokenLabel}/{Math.round(tokenBudget / 1000)}k</span>
          </div>
        </div>
      </div>
    </div>
  );

  const body = (
    <Conversation aria-live="polite" className={cn(page ? "absolute inset-0" : "flex-1 min-h-0")}>
      <ConversationContent
        className={cn(
          'mx-auto w-full',
          page ? 'max-w-[860px] gap-6 px-5 py-6 sm:px-10' : 'max-w-2xl gap-4 px-3 py-4',
        )}
      >
        {!hasMessages && !busy && (
          <ConversationEmptyState className={cn('max-[359px]:p-4', page ? 'min-h-[48vh]' : 'min-h-[320px]')}>
            <div className="flex w-full max-w-xl flex-col items-center text-center">
              <div className={cn('mb-5 grid place-items-center rounded-[20px] border border-[var(--fb-line)] bg-[var(--fb-card)] shadow-[0_18px_44px_-30px_rgba(0,0,0,0.45)] transition-transform hover:-translate-y-0.5', page ? 'size-16' : 'size-12')}>
                <BrandLogo size={page ? 36 : 28} />
              </div>
              <span className="inline-flex items-center gap-2 rounded-full border border-[rgba(197,250,117,0.30)] bg-[rgba(197,250,117,0.08)] px-3 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.15em] text-[#c5fa75]">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#c5fa75]" />
                FlutterForge · AI builder
              </span>
              <h2 className={cn('mt-5 text-balance font-medium tracking-[-0.045em] text-[var(--fb-ink)]', page ? 'text-[clamp(30px,4vw,48px)] leading-[1.05]' : 'text-[22px] leading-[1.1]', 'max-[359px]:text-[24px]')}>
                One brief from a running app.
              </h2>
              <p className={cn('mt-3 text-pretty leading-relaxed text-[var(--fb-muted)] max-[359px]:hidden', page ? 'max-w-md text-[13.5px]' : 'max-w-sm text-[11.5px]')}>
                Ask a question, request a code change, or brief a new Flutter feature. The agent writes real Dart files, repairs compile errors and keeps the preview live.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2 max-[359px]:w-full max-[359px]:flex-nowrap max-[359px]:justify-start max-[359px]:overflow-x-auto max-[359px]:pb-1" role="group" aria-label="Starter prompts">
                {SUGGESTIONS.map((suggestion) => (
                  <Suggestion
                    key={suggestion.label}
                    className={cn(
                      'border-[var(--fb-line)] bg-[var(--fb-card)] text-[var(--fb-ink)] hover:border-[var(--fb-ink)] hover:bg-[var(--fb-card)] max-[359px]:shrink-0',
                      page ? 'h-10 px-4 text-[12px]' : 'h-8 px-3 text-[11px]',
                    )}
                    onClick={(prompt) => {
                      setInput(prompt);
                      focusComposer();
                    }}
                    suggestion={suggestion.prompt}
                  >
                    {suggestion.label}
                  </Suggestion>
                ))}
              </div>
              <p className="mt-6 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--fb-dim)] max-[359px]:mt-4">
                Dart 3 · Local studio · Real source
              </p>
            </div>
          </ConversationEmptyState>
        )}

        {messages.map((message, index) => {
          const isLastAssistant = lastAssistant?.id === message.id && index === messages.length - 1;
          return (
            <Fragment key={message.id}>
              {index === lastAssistantIndex && showActivity && (
                <RunActivity onOpen={openFile} page={page} />
              )}
              <MessageBubble
                canRetry={isLastAssistant && Boolean(lastUserMessage) && !busy}
                message={message}
                onOpen={openFile}
                onRetry={() => void handleSend(lastUserMessage, retryOptions())}
                page={page}
                onPromptClick={(prompt) => {
                  if (busy) {
                    setInput(prompt);
                    focusComposer();
                  } else {
                    void handleSend(prompt);
                  }
                }}
                onViewPreview={() => setActiveView('preview')}
              />
            </Fragment>
          );
        })}

        {showActivity && lastAssistantIndex === -1 && (
          <RunActivity onOpen={openFile} page={page} />
        )}

        {isAnswering && (
          <Message className={page ? 'max-w-full' : undefined} from="assistant">
            <MessageContent className={cn(page && 'w-full')}>
              {streamingReply ? (
                <>
                  <MessageResponse>{streamingReply}</MessageResponse>
                  <span className="mt-1 inline-block h-3 w-1 animate-pulse bg-[var(--fb-ink)] align-middle" />
                </>
              ) : (
                <div className="flex items-center gap-1.5 py-1" role="status" aria-label="Generating…">
                  <span aria-hidden="true" className="size-1.5 animate-bounce rounded-full bg-[var(--fb-ink)] [animation-delay:-0.3s]" />
                  <span aria-hidden="true" className="size-1.5 animate-bounce rounded-full bg-[var(--fb-ink)] [animation-delay:-0.15s]" />
                  <span aria-hidden="true" className="size-1.5 animate-bounce rounded-full bg-[var(--fb-ink)]" />
                  <span className="ml-2 text-[11px] text-[var(--fb-muted)]">Generating…</span>
                </div>
              )}
            </MessageContent>
          </Message>
        )}

        {generationError && !busy && errorDetails?.kind !== 'cancelled' && (
          <div className="rounded-[16px] border border-[var(--fb-danger)] bg-[var(--fb-card)] px-3.5 py-3" role="alert">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-[var(--fb-danger)]" />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--fb-danger)]">
                  {errorDetails?.kind === 'configuration'
                    ? 'Configuration required'
                    : errorDetails?.kind === 'network'
                      ? 'Network connection error'
                      : errorDetails?.kind === 'empty'
                        ? 'Empty response'
                        : errorDetails?.kind === 'timeout'
                          ? 'Request timed out'
                          : 'Request failed'}
                </p>
                <p className="mt-1 break-words text-[11.5px] leading-relaxed text-[var(--fb-muted)]">{generationError}</p>
                <div className="mt-2.5 flex items-center gap-2">
                  {errorDetails?.kind === 'configuration' && (
                    <button
                      className="rounded-full bg-[var(--fb-ink)] px-3 py-1 text-[10px] font-semibold text-[var(--fb-bg)] transition-colors hover:opacity-90"
                      onClick={() => setKeyModalOpen(true)}
                      type="button"
                    >
                      Configure API Key
                    </button>
                  )}
                  {lastUserMessage && errorDetails?.kind !== 'configuration' && (
                    <button
                      className="rounded-full border border-[var(--fb-danger)] px-3 py-1 text-[10px] font-semibold text-[var(--fb-danger)] transition-colors hover:bg-[var(--fb-soft)]"
                      onClick={() => void handleSend(lastUserMessage, retryOptions())}
                      type="button"
                    >
                      Retry
                    </button>
                  )}
                </div>
              </div>
              <button
                aria-label="Dismiss error"
                className="p-0.5 text-[var(--fb-dim)] hover:text-[var(--fb-danger)]"
                onClick={() => {
                  setGenerationError(null);
                  setErrorDetails(null);
                }}
                title="Dismiss error"
                type="button"
              >
                <X className="size-3" />
              </button>
            </div>
          </div>
        )}

        {showRepair && currentProject && buildSession && (
          <Confirmation
            approval={{ id: buildSession.sessionId }}
            className="border-amber-500/30 bg-amber-500/5"
            state="approval-requested"
          >
            <ConfirmationTitle className="flex items-center gap-2 text-amber-600">
              <Wrench className="size-3.5" /> Preview build failed
            </ConfirmationTitle>
            <ConfirmationRequest>
              <div className="space-y-2">
                <p className="text-xs text-amber-600/80">
                  The preview build failed. Let the agent read the compiler errors and repair the project?
                </p>
                {repairHint.length > 0 && (
                  <pre className="max-h-24 overflow-auto rounded-md bg-amber-500/10 p-2 font-mono text-[10px] text-amber-700 dark:text-amber-400">
                    {repairHint.join('\n')}
                  </pre>
                )}
              </div>
            </ConfirmationRequest>
            <ConfirmationActions>
              <ConfirmationAction onClick={() => void repairBuild(currentProject.id)}>
                Fix automatically
              </ConfirmationAction>
              <ConfirmationAction
                onClick={() => setDismissedRepair(buildSession.sessionId)}
                variant="outline"
              >
                Dismiss
              </ConfirmationAction>
            </ConfirmationActions>
          </Confirmation>
        )}
      </ConversationContent>
      <ConversationScrollButton aria-label="Scroll to latest message" title="Scroll to latest message" />
    </Conversation>
  );

  if (page) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[#00101e]">
        {panelHeader}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {body}
        </div>
        <div className="shrink-0 border-t border-[rgba(248,255,248,0.10)] bg-[rgba(0,16,30,0.95)] px-5 pb-4 pt-3 backdrop-blur sm:px-10">
          <div className="mx-auto w-full max-w-[860px]">{composer}</div>
        </div>
        <SkillsModal
          isOpen={isSkillsOpen}
          onClose={() => setIsSkillsOpen(false)}
          onSkillsChanged={(skills) => setActiveSkillCount(skills.filter((s) => s.enabled).length)}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[linear-gradient(124deg,#00101e_8%,#1f3747_19%,#163348_32%,#0e2338_56%,#00101e_100%)]">
      {panelHeader}
      {body}
      <div className="shrink-0 border-t border-[rgba(248,255,248,0.10)] bg-[rgba(0,16,30,0.90)] px-3 py-2.5">
        <div className="mx-auto w-full max-w-2xl">{composer}</div>
      </div>
      <SkillsModal
        isOpen={isSkillsOpen}
        onClose={() => setIsSkillsOpen(false)}
        onSkillsChanged={(skills) => setActiveSkillCount(skills.filter((s) => s.enabled).length)}
      />
      <OpenRouterKeyModal open={keyModalOpen} onClose={() => setKeyModalOpen(false)} />
      <ShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        projectName={currentProject?.name ?? 'Flutter App'}
        files={files}
      />
    </div>
  );
}
