import { executeEngineer, engineerRequest, EngineerRequestError } from '@/agent/engineClient';
import { create } from 'zustand';
import { supabase } from '@/services/supabase';
import type { Project, ProjectFile, ProjectVersion, AIConversation, AIMessage, GenerationTask, Build, Dependency, Deployment, FileChange } from '@/types';
import { useAuthStore } from './auth.store';
import { generateFlutterProjectFiles, generateMinimalStarterFiles } from '@/utils/flutterTemplates';
import { applyAppIdToPubspec, generateUniqueAppId } from '@/utils/appId';
import { detectSupabaseNeed, isExplicitLocalOnly } from '@/utils/backendNeed';
import { classifyChatIntent, detectChatIntent, detectIntentHeuristic, BUILDER_INTENTS, PROJECT_AWARE_INTENTS } from '@/agent/chatIntent';
import { answerGeneralQuestion, executeChatTurn } from '@/agent/chatAnswer';
import { ChatContextHandler } from '@/agent/chatContext';
import { type ChatEvent, type ChatErrorDetails, ChatError } from '@/agent/chatTypes';
import { AgentContextBuilder, AgentPlanner, FlutterSupabaseAgent, MultiFileCodeGenerator, keyPool, SkillRegistry } from '@/agent';
import { validateProjectFiles, type PreWriteValidation } from '@/agent/preWriteValidator';
import type { SSEFileReadyEvent } from '@/agent/streamEvents';
import { usePreviewStore, registerBuildFailedHandler, type ProjectVerification } from './preview.store';
import { useWorkspaceStore } from './workspace.store';
import { useTerminalStore } from './terminal.store';
import { useActivityStore } from './activity.store';
import { useCredentialsStore } from './credentials.store';
import { ECONOMY_MODEL, FRONTIER_MODEL, resolveModelChoice, type ModelPreference } from '@/agent/modelRouting';
import type { AgentFileArtifact, AgentGenerationResult, AgentPlan, ValidationReport } from '@/agent/types';
import { snapshotHash } from '@/utils/versionDiff';

/** One in-flight promise per key — collapsing concurrent duplicate calls
 *  (React StrictMode double-mounts, double navigations) prevents races like
 *  two `loadConversation` runs inserting two chat conversations. */
const inFlightCalls = new Map<string, Promise<unknown>>();

function ensureSingleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlightCalls.get(key);
  if (existing) return existing as Promise<T>;
  const promise = run().finally(() => {
    inFlightCalls.delete(key);
  });
  inFlightCalls.set(key, promise);
  return promise;
}

function snapshotProjectFiles(files: ProjectFile[]): Record<string, { content: string }> {
  const snapshot: Record<string, { content: string }> = {};
  for (const file of files) {
    if (!file.is_directory) snapshot[file.path] = { content: file.content };
  }
  return snapshot;
}

export interface SendMessageOptions {
  /** Explicit initial-generation flag (wizard/first prompt). Falls back to heuristics when omitted. */
  isInitialGeneration?: boolean;
  /** Watch the auto-built preview and auto-repair on build failure. Default true. */
  autoRepairBuild?: boolean;
  /** Internal: marks a repair pass and which round it belongs to. */
  isRepair?: boolean;
  /** 1-based automatic repair round; caps the self-healing loop. */
  repairRound?: number;
  /** Typed AgentEvent callback — receives structured events from the agent runtime
   *  (includes node name, phase, step_number). Used by AIBuilderPanel for direct step
   *  advancement without keyword matching. Falls back to onProgress for other paths. */
  onEvent?: (event: {
    message: string;
    node?: string;
    phase?: string;
    step_number?: number;
    stepNumber?: number;
    totalSteps?: number;
    thought?: string;
    plan?: AgentPlan;
    validationReport?: ValidationReport;
    generatedFiles?: AgentFileArtifact[];
    detail?: string;
    kind?: string;
    tool?: string;
    toolInput?: unknown;
    toolCallId?: string;
    status?: string;
    filePath?: string;
    timestamp?: string;
  }) => void;
  /** Raw agent-runtime file artefact as it is written to the workspace. */
  onFile?: (file: SSEFileReadyEvent) => void;
  /** AbortSignal from the UI Stop button — cancels the backend stream / LLM calls. */
  signal?: AbortSignal;
  /** Auto routes frontier for first passes and fast for edits; fast/quality pin a tier. */
  modelPreference?: ModelPreference;
  /** Project-relative files the user explicitly attached as context. */
  attachedFiles?: string[];
  /** Receives each assistant text chunk while a chat-only answer streams. */
  onToken?: (token: string) => void;
  /** Called when a chat answer switches credentials/models after an error. */
  onRetry?: (message: string) => void;
  /** Surgical edit mode — skips full pipeline, only changes affected files. */
  isEdit?: boolean;
  /** Current project files passed as context for edit mode. */
  existingFiles?: Array<{ path: string; content: string | null }>;
  /** Real-time structured runtime event sink. */
  onChatEvent?: (event: ChatEvent) => void;
}

export interface SendMessageResult {
  /** 'duplicate' = a generation for this conversation is already running;
      the caller must NOT report it as a completed 0-file generation. */
  mode: 'chat' | 'generation' | 'duplicate';
  fileCount?: number;
  files?: import('@/types').FileChange[];
  /** False when files were written but the authoritative gates failed. */
  verified?: boolean;
  verification?: import('@/agent/types').AgentGenerationResult['verification'];
  intent?: import('@/agent/chatTypes').AssistantIntent;
  error?: ChatErrorDetails;
}

interface ProjectState {
  projects: Project[];
  currentProject: Project | null;
  files: ProjectFile[];
  versions: ProjectVersion[];
  conversation: AIConversation | null;
  messages: AIMessage[];
  tasks: GenerationTask[];
  builds: Build[];
  dependencies: Dependency[];
  deployments: Deployment[];
  loading: boolean;
  error: string | null;
  /** ProjectId whose generation is running at the STORE level (auto-repair,
      wizard auto-start, …) — the panel drives its own busy state for sends it
      initiates, so store-driven runs are otherwise invisible in the UI. */
  generatingIn: string | null;

  loadProjects: () => Promise<void>;
  createProject: (data: { name: string; description: string; template: string; flutter_version?: string; state_management?: string; theme_mode?: string; platform?: string }) => Promise<Project | null>;
  /** Returns false when the remote update failed (state error is also set). */
  updateProject: (id: string, data: Partial<Project>) => Promise<boolean>;
  /** Returns false when the remote delete failed — nothing is removed locally. */
  deleteProject: (id: string) => Promise<boolean>;
  /** Returns false when the duplicate could not be created. */
  duplicateProject: (id: string) => Promise<boolean>;
  loadProject: (id: string) => Promise<void>;
  loadFiles: (projectId: string) => Promise<void>;
  /** Returns false when the edit only exists in memory (backend write failed). */
  saveFile: (projectId: string, path: string, content: string) => Promise<boolean>;
  /** Returns false when the file only exists in memory (backend write failed). */
  createFile: (projectId: string, path: string, content: string, isDirectory?: boolean) => Promise<boolean>;
  /** Returns false when the delete failed — the file is kept. */
  deleteFile: (projectId: string, path: string) => Promise<boolean>;
  renameFile: (projectId: string, oldPath: string, newPath: string) => Promise<void>;
  loadConversation: (projectId: string) => Promise<void>;
  newConversation: (projectId: string) => Promise<void>;
  sendMessage: (projectId: string, content: string, onProgress?: (message: string) => void, opts?: SendMessageOptions) => Promise<SendMessageResult>;
  loadDependencies: (projectId: string) => Promise<void>;
  /** Returns false when the dependency could not be recorded. */
  addDependency: (projectId: string, packageName: string, version: string) => Promise<boolean>;
  /** Returns false when the dependency could not be removed remotely. */
  removeDependency: (projectId: string, packageId: string) => Promise<boolean>;
  loadVersions: (projectId: string) => Promise<void>;
  /** Returns false when the checkpoint could not be stored. */
  createVersion: (projectId: string, label: string, description: string) => Promise<boolean>;
  /** Best-effort checkpoint after a run, repair, or manual edit. Never throws
      and skips when the project state matches the newest checkpoint. */
  autoCheckpoint: (projectId: string, label: string, description: string) => Promise<boolean>;
  /** Returns false when the version was not found or files could not be restored. */
  restoreVersion: (projectId: string, versionId: string) => Promise<boolean>;
  restoreFile: (projectId: string, filePath: string, content?: string) => Promise<void>;
  loadBuilds: (projectId: string) => Promise<void>;
  loadDeployments: (projectId: string) => Promise<void>;
  /** Manual entry to the build-repair loop: feeds the latest failed preview
      logs back through the agent. Same pipeline the auto-watcher uses. */
  repairBuild: (projectId: string, round?: number) => Promise<void>;
  /** Aborts the store-driven repair run (panel Stop button). */
  stopRepair: () => void;
  clearCurrent: () => void;
  clearError: () => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProject: null,
  files: [],
  versions: [],
  conversation: null,
  messages: [],
  tasks: [],
  builds: [],
  dependencies: [],
  deployments: [],
  loading: false,
  error: null,
  generatingIn: null,

  loadProjects: async () => {
    const user = useAuthStore.getState().user;
    if (!user) return;
    set({ loading: true });
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false });
    if (error) {
      set({ loading: false, error: error.message });
      return;
    }
    set({ projects: (data as Project[]) ?? [], loading: false });
  },

  createProject: async (data) => {
    const user = useAuthStore.getState().user;
    if (!user) {
      set({ error: 'You must be signed in to create a project.' });
      return null;
    }
    set({ loading: true, error: null });
    const { data: project, error } = await supabase
      .from('projects')
      .insert({
        user_id: user.id,
        name: data.name,
        description: data.description,
        template: data.template,
        flutter_version: data.flutter_version ?? '3.24.0',
        state_management: data.state_management ?? 'provider',
        theme_mode: data.theme_mode ?? 'light',
        platform: data.platform ?? 'web',
        status: 'created',
      })
      .select('*')
      .single();
    if (error) {
      set({ loading: false, error: error.message });
      return null;
    }

    // New projects start empty. The first prompt creates the real app; shipping
    // demo auth/onboarding/Supabase files first caused them to leak into
    // unrelated apps and confused the generation model.
    set((state) => ({ projects: [project as Project, ...state.projects], loading: false }));
    return project as Project;
  },

  updateProject: async (id, data) => {
    const { error } = await supabase.from('projects').update(data).eq('id', id);
    if (error) {
      set({ error: error.message });
      return false;
    }
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? { ...p, ...data } : p)),
      currentProject: state.currentProject?.id === id ? { ...state.currentProject, ...data } : state.currentProject,
    }));
    return true;
  },

  deleteProject: async (id) => {
    const { error } = await supabase.from('projects').delete().eq('id', id);
    if (error) {
      set({ error: error.message });
      return false;
    }
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
      currentProject: state.currentProject?.id === id ? null : state.currentProject,
    }));
    return true;
  },

  duplicateProject: async (id) => {
    const project = get().projects.find((p) => p.id === id);
    if (!project) {
      set({ error: 'Project not found.' });
      return false;
    }
    const user = useAuthStore.getState().user;
    if (!user) {
      set({ error: 'You must be signed in to duplicate a project.' });
      return false;
    }
    const { data: newProject, error } = await supabase
      .from('projects')
      .insert({
        user_id: user.id,
        name: `${project.name} (Copy)`,
        description: project.description,
        template: project.template,
        flutter_version: project.flutter_version,
        state_management: project.state_management,
        theme_mode: project.theme_mode,
        platform: project.platform,
        status: 'created',
      })
      .select('*')
      .single();
    if (error || !newProject) {
      set({ error: error?.message ?? 'Could not duplicate the project.' });
      return false;
    }
    const { data: files } = await supabase.from('project_files').select('*').eq('project_id', id);
    if (files && files.length > 0) {
      // The copy is a NEW app, so it needs a DIFFERENT id: rewrite the
      // pubspec package name instead of copying the original verbatim.
      const freshAppId = generateUniqueAppId(
        `${project.name} copy`,
        (newProject as Project).id,
      );
      const fileInserts = files.map((f) => ({
        project_id: (newProject as Project).id,
        path: f.path,
        content:
          f.path === 'pubspec.yaml' && typeof f.content === 'string'
            ? applyAppIdToPubspec(f.content, freshAppId)
            : f.content,
        file_type: f.file_type,
        is_directory: f.is_directory,
      }));
      await supabase.from('project_files').insert(fileInserts);
    }
    set((state) => ({ projects: [newProject as Project, ...state.projects] }));
    return true;
  },

  loadProject: (id) => ensureSingleFlight(`project:${id}`, async () => {
    // Clear the previous project's state first so switching projects never
    // flashes (or previews from) stale files/messages of another app.
    // Also reset editor tabs: openTabs/activeFile otherwise leak across
    // projects and the Files/Code view opens stale or missing files.
    useWorkspaceStore.getState().resetWorkspace();
    set({
      loading: true,
      currentProject: null,
      files: [],
      versions: [],
      conversation: null,
      messages: [],
      tasks: [],
      builds: [],
      dependencies: [],
      deployments: [],
      error: null,
    });
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) {
      set({ loading: false, error: error?.message ?? 'Project not found' });
      return;
    }
    set({ currentProject: data as Project, loading: false });
    await get().loadFiles(id);
    await Promise.allSettled([
      get().loadConversation(id),
      get().loadDependencies(id),
      get().loadVersions(id),
      get().loadBuilds(id),
      get().loadDeployments(id),
    ]);
  }),

  loadFiles: async (projectId) => {
    try {
      const snapshot = await engineerRequest<{ files: Array<{ path: string; content: string }> }>(projectId, 'files');
      if (get().currentProject?.id !== projectId) return;
      const now = new Date().toISOString();
      set({ files: snapshot.files.map(file => ({ id: `local-engine-${file.path}`, project_id: projectId, ...file,
        is_directory: false, file_type: file.path.split('.').pop() ?? null, created_at: now, updated_at: now })) });
      return;
    } catch (error) {
      // A never-started project still lives in Supabase. Offline engine errors remain visible.
      if (!(error instanceof EngineerRequestError && error.status === 404)) set({ error: error instanceof Error ? error.message : 'Engine unavailable.' });
    }
    const { data, error } = await supabase.from('project_files').select('*').eq('project_id', projectId).order('path', { ascending: true });
    if (error) { set({ error: error.message }); return; }
    if (get().currentProject?.id === projectId) set({ files: (data as ProjectFile[]) ?? [] });
  },

  saveFile: async (projectId, path, content) => {
    const expected = get().files.find(file => file.path === path && file.project_id === projectId)?.content ?? null;
    let engineSaved = false;
    try { await engineerRequest(projectId, 'edit-file', { path, content, expectedContent: expected }); engineSaved = true; }
    catch (error) { if (!(error instanceof EngineerRequestError && error.status === 404)) throw error; }

    const applyLocal = () =>
      set((state) => ({
        files: state.files.map((f) =>
          f.project_id === projectId && f.path === path ? { ...f, content } : f
        ),
      }));
    // Local-only files (created while Supabase was unreachable) have no DB
    // row to update — persist in memory so edits never silently vanish.
    const existing = get().files.find((f) => f.project_id === projectId && f.path === path);
    if (existing?.id.startsWith('local-')) {
      applyLocal();
      return engineSaved;
    }
    const { error } = await supabase
      .from('project_files')
      .update({ content, updated_at: new Date().toISOString() })
      .eq('project_id', projectId)
      .eq('path', path);
    if (error) {
      // Same fallback as createFile: keep the edit locally instead of
      // dropping it when the backend write fails.
      applyLocal();
      set({ error: error.message });
      return false;
    }
    applyLocal();
    return true;
  },

  createFile: async (projectId, path, content, isDirectory = false) => {
    let engineSaved = false;
    try {
      if (isDirectory) {
        await engineerRequest(projectId, 'state');
        throw new Error('Create a file inside the new folder; engine folders are created automatically.');
      }
      await engineerRequest(projectId, 'edit-file', { path, content, expectedContent: null }); engineSaved = true;
    } catch (error) { if (!(error instanceof EngineerRequestError && error.status === 404)) throw error; }
    const ext = path.split('.').pop() ?? '';
    const { data, error } = await supabase
      .from('project_files')
      .insert({
        project_id: projectId,
        path,
        content,
        file_type: ext,
        is_directory: isDirectory,
      })
      .select('*')
      .single();
    if (error) {
      // Fallback to local state if Supabase returns error or is unconfigured
      const fallbackFile: ProjectFile = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        project_id: projectId,
        path,
        content,
        file_type: ext,
        is_directory: isDirectory,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      set((state) => ({ files: [...state.files.filter(f => f.path !== path), fallbackFile] }));
      return engineSaved;
    }
    set((state) => ({ files: [...state.files.filter(f => f.path !== path), data as ProjectFile] }));
    return true;
  },

  deleteFile: async (projectId, path) => {
    let engineSaved = false;
    const existing = get().files.find(file => file.project_id === projectId && file.path === path);
    try { await engineerRequest(projectId, 'edit-file', { path, content: null, expectedContent: existing?.content ?? null }); engineSaved = true; }
    catch (error) { if (!(error instanceof EngineerRequestError && error.status === 404)) throw error; }
    const { error } = await supabase
      .from('project_files')
      .delete()
      .eq('project_id', projectId)
      .eq('path', path);
    if (error) {
      set({ error: error.message });
      if (!engineSaved) return false;
    }
    set((state) => ({
      files: state.files.filter((f) => !(f.project_id === projectId && f.path === path)),
    }));
    return true;
  },

  renameFile: async (projectId, oldPath, newPath) => {
    const existing = get().files.find(file => file.project_id === projectId && file.path === oldPath);
    let engineSaved = false;
    try { await engineerRequest(projectId, 'edit-file', { path: oldPath, content: null, expectedContent: existing?.content ?? null, destination: newPath }); engineSaved = true; }
    catch (error) { if (!(error instanceof EngineerRequestError && error.status === 404)) throw error; }
    const { error } = await supabase
      .from('project_files')
      .update({ path: newPath, updated_at: new Date().toISOString() })
      .eq('project_id', projectId)
      .eq('path', oldPath);
    if (error && !engineSaved) throw new Error(error.message);
    if (error) set({ error: 'File renamed in the engine; cloud sync failed.' });
    set((state) => ({
      files: state.files.map((f) =>
        f.project_id === projectId && f.path === oldPath ? { ...f, path: newPath } : f
      ),
    }));
  },

  newConversation: async (projectId) => {
    const { data, error } = await supabase
      .from('ai_conversations')
      .insert({ project_id: projectId, title: 'New Conversation' })
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    set({ conversation: data as AIConversation, messages: [] });
  },

  loadConversation: (projectId) => ensureSingleFlight(`conv:${projectId}`, () => (async () => {
    const { data: conv } = await supabase
      .from('ai_conversations')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (conv) {
      set({ conversation: conv as AIConversation });
      const { data: msgs } = await supabase
        .from('ai_messages')
        .select('*')
        .eq('conversation_id', (conv as AIConversation).id)
        .order('created_at', { ascending: true });
      set({ messages: (msgs as AIMessage[]) ?? [] });
    } else {
      const { data: newConv, error } = await supabase
        .from('ai_conversations')
        .insert({ project_id: projectId, title: 'New Conversation' })
        .select('*')
        .single();
      if (error) throw new Error(error.message);
      set({ conversation: newConv as AIConversation, messages: [] });
    }
  })()),

  sendMessage: async (projectId, content, onProgress, opts) => {
    if (activeSendProjects.has(projectId)) return { mode: 'duplicate' };
    activeSendProjects.add(projectId);
    set({ generatingIn: projectId });
    try {
      if (get().conversation?.project_id !== projectId) await get().loadConversation(projectId);
      const conversation = get().conversation;
      const project = get().currentProject;
      if (!conversation || !project || project.id !== projectId) throw new Error('Project conversation is not ready.');
      const addMessage = async (role: 'user' | 'assistant', text: string, changes: FileChange[] = []) => {
        const message: AIMessage = { id: crypto.randomUUID(), conversation_id: conversation.id, role,
          content: text, tool_calls: null, changed_files: changes, metadata: {}, created_at: new Date().toISOString() };
        if (get().currentProject?.id === projectId) set(state => ({ messages: [...state.messages, message] }));
        const { error } = await supabase.from('ai_messages').insert({ conversation_id: conversation.id, role, content: text, changed_files: changes });
        if (error) onProgress?.('Message is visible locally; conversation sync failed.');
      };
      await addMessage('user', content);
      const request = opts?.attachedFiles?.length ? `${content}\n\nFocus on these project files: ${opts.attachedFiles.join(', ')}` : content;
      const result = await executeEngineer(request, {
        projectId, projectName: project.name,
        files: get().files.filter(file => !file.is_directory).map(({ path, content }) => ({ path, content })),
      }, { signal: opts?.signal, onProgress, onToken: opts?.onToken,
        onEvent: event => opts?.onEvent?.(event),
        onEngineEvent: event => { if (event.type === 'file') void get().loadFiles(projectId); }, onFile: file => opts?.onFile?.(file) });
      const changes: FileChange[] = result.files.map(file => ({ path: file.path, action: file.action ?? 'modified', content: file.content }));
      // Keep authoritative backend output even when verification fails. Never rewrite it after verification.
      const now = new Date().toISOString();
      if (get().currentProject?.id === projectId) set(state => {
        const byPath = new Map(state.files.map(file => [file.path, file]));
        for (const change of changes) {
          if (change.action === 'deleted') byPath.delete(change.path);
          else byPath.set(change.path, { id: byPath.get(change.path)?.id ?? `local-${crypto.randomUUID()}`, project_id: projectId,
            path: change.path, content: change.content ?? '', file_type: change.path.split('.').pop() ?? null,
            is_directory: false, created_at: byPath.get(change.path)?.created_at ?? now, updated_at: now });
        }
        return { files: [...byPath.values()] };
      });
      const writes = changes.filter(c => c.action !== 'deleted').map(c => ({ project_id: projectId, path: c.path, content: c.content ?? '', file_type: c.path.split('.').pop(), is_directory: false }));
      if (writes.length) {
        const { error } = await supabase.from('project_files').upsert(writes, { onConflict: 'project_id,path' });
        if (error) onProgress?.('Files are saved in the engine workspace; cloud sync failed.');
      }
      const deleted = changes.filter(c => c.action === 'deleted').map(c => c.path);
      if (deleted.length) {
        const { error } = await supabase.from('project_files').delete().eq('project_id', projectId).in('path', deleted);
        if (error) onProgress?.('Cloud deletion sync failed; the engine workspace is authoritative.');
      }
      await addMessage('assistant', result.summary, changes);
      if (!result.success) throw new Error(result.summary);
      return { mode: changes.length ? 'generation' : 'chat', fileCount: changes.length, files: changes,
        verified: result.verification?.verified, verification: result.verification };
    } finally {
      activeSendProjects.delete(projectId);
      if (get().generatingIn === projectId) set({ generatingIn: null });
    }
  },

  loadDependencies: async (projectId) => {
    const { data } = await supabase
      .from('dependencies')
      .select('*')
      .eq('project_id', projectId)
      .order('package_name', { ascending: true });
    set({ dependencies: (data as Dependency[]) ?? [] });
  },

  addDependency: async (projectId, packageName, version) => {
    const { data, error } = await supabase
      .from('dependencies')
      .insert({
        project_id: projectId,
        package_name: packageName,
        version,
        package_type: 'direct',
        status: 'installing',
      })
      .select('*')
      .single();
    if (error || !data) {
      set({ error: error?.message ?? 'Could not add the dependency.' });
      return false;
    }
    set((state) => ({ dependencies: [...state.dependencies, data as Dependency] }));
    await supabase
      .from('dependencies')
      .update({ status: 'installed' })
      .eq('id', data.id);
    set((state) => ({
      dependencies: state.dependencies.map((d) =>
        d.id === data.id ? { ...d, status: 'installed' } : d
      ),
    }));
    return true;
  },

  removeDependency: async (projectId, packageId) => {
    const { error } = await supabase.from('dependencies').delete().eq('id', packageId);
    if (error) {
      set({ error: error.message });
      return false;
    }
    set((state) => ({
      dependencies: state.dependencies.filter((d) => d.id !== packageId),
    }));
    return true;
  },

  loadVersions: async (projectId) => {
    const { data } = await supabase
      .from('project_versions')
      .select('*')
      .eq('project_id', projectId)
      .order('version_number', { ascending: false });
    set({ versions: (data as ProjectVersion[]) ?? [] });
  },

  createVersion: async (projectId, label, description) => {
    const snapshot = snapshotProjectFiles(get().files);
    const localMax = get().versions.reduce(
      (max, version) => Math.max(max, version.version_number || 0),
      0,
    );
    // Local state can lag behind the table (another window, a failed load), and
    // `versions.length + 1` reused numbers after restore/deletes. Always derive
    // the next number from the highest number stored anywhere.
    const { data: latest } = await supabase
      .from('project_versions')
      .select('version_number')
      .eq('project_id', projectId)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    const versionNumber = Math.max(localMax, latest?.version_number ?? 0) + 1;
    const { data, error } = await supabase
      .from('project_versions')
      .insert({
        project_id: projectId,
        version_number: versionNumber,
        label,
        description,
        file_snapshot: snapshot,
      })
      .select('*')
      .single();
    if (error || !data) {
      set({ error: error?.message ?? 'Could not create the checkpoint.' });
      return false;
    }
    set((state) => ({ versions: [data as ProjectVersion, ...state.versions] }));
    return true;
  },

  autoCheckpoint: async (projectId, label, description) => {
    if (get().currentProject?.id !== projectId) return false;
    const files = get().files.filter((file) => !file.is_directory);
    if (files.length === 0) return false;
    const snapshot = snapshotProjectFiles(files);
    const hash = snapshotHash(snapshot);

    let latest: ProjectVersion | undefined = get().versions[0];
    if (!latest) {
      const { data } = await supabase
        .from('project_versions')
        .select('*')
        .eq('project_id', projectId)
        .order('version_number', { ascending: false })
        .limit(1)
        .maybeSingle();
      latest = (data as ProjectVersion | null) ?? undefined;
    }
    if (latest && snapshotHash(latest.file_snapshot ?? {}) === hash) return true;

    try {
      return await get().createVersion(projectId, label, description);
    } catch {
      return false;
    }
  },

  restoreVersion: async (projectId, versionId) => {
    const version = get().versions.find((v) => v.id === versionId);
    if (!version) return false;
    const snapshot = version.file_snapshot;
    const currentFiles = get().files;

    for (const [path, data] of Object.entries(snapshot)) {
      const existing = currentFiles.find((f) => f.path === path);
      if (existing) {
        await get().saveFile(projectId, path, data.content);
      } else {
        await get().createFile(projectId, path, data.content);
      }
    }

    for (const file of currentFiles) {
      if (!file.is_directory && !(file.path in snapshot)) {
        await get().deleteFile(projectId, file.path);
      }
    }

    await get().loadFiles(projectId);
    return true;
  },

  restoreFile: async (projectId, filePath, content) => {
    if (content !== undefined) {
      await get().saveFile(projectId, filePath, content);
      await get().loadFiles(projectId);
      return;
    }

    // Lookup in previous versions
    const prevVersions = get().versions;
    for (const v of prevVersions) {
      const snap = v.file_snapshot?.[filePath];
      if (snap?.content !== undefined) {
        await get().saveFile(projectId, filePath, snap.content);
        await get().loadFiles(projectId);
        return;
      }
    }
  },

  loadBuilds: async (projectId) => {
    const { data } = await supabase
      .from('builds')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    set({ builds: (data as Build[]) ?? [] });
  },

  repairBuild: async (projectId, round = 1) => {
    const session = usePreviewStore.getState().getSession(projectId);
    if (!session || session.status !== 'failed') return;
    if (activeRepairAbort) activeRepairAbort.abort(); // superseded repair
    const controller = new AbortController();
    activeRepairAbort = controller;
    try {
      await repairFailedBuild(projectId, session.logs ?? [], round, controller.signal);
    } finally {
      if (activeRepairAbort === controller) activeRepairAbort = null;
      set({ generatingIn: null });
    }
  },

  stopRepair: () => {
    activeRepairAbort?.abort();
    activeRepairAbort = null;
    set({ generatingIn: null });
  },

  loadDeployments: async (projectId) => {
    const { data } = await supabase
      .from('deployments')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    set({ deployments: (data as Deployment[]) ?? [] });
  },

  clearCurrent: () => {
    set({
      currentProject: null,
      files: [],
      versions: [],
      conversation: null,
      messages: [],
      tasks: [],
      builds: [],
      dependencies: [],
      deployments: [],
    });
  },

  clearError: () => set({ error: null }),
}));

const STARTER_FILE_PATTERNS = [
  /^supabase\//,
  /^lib\/core\/services\/supabase_service\.dart$/,
  /^lib\/features\/onboarding\//,
  /^lib\/features\/auth\//,
  /^lib\/features\/profile\//,
  /^lib\/features\/settings\//,
  /^lib\/features\/shared\//,
  /^lib\/core\/widgets\/main_nav_scaffold\.dart$/,
  /^lib\/core\/widgets\/app_header\.dart$/,
  /^lib\/core\/router\/app_router\.dart$/,
  /^lib\/features\/home\/screens\/home_screen\.dart$/,
];

function buildAssistantResponse(prompt: string, changes: FileChange[], usesSupabase = false): string {
  const generated = changes.filter((change) => change.action !== 'deleted');
  const isInitial = generated.filter((change) => change.action === 'created').length >= 4;

  const names = (match: (path: string) => boolean) => [
    ...new Set(
      generated
        .filter((change) => match(change.path))
        .map((change) => change.path.split('/').pop()?.replace(/\.dart$/, '') ?? '')
        .filter(Boolean),
    ),
  ];

  const screens = names((path) => path.includes('/screens/') || path.endsWith('_screen.dart'));
  const models = names((path) => path.includes('/models/'));
  const services = names((path) => path.includes('/services/'));
  const repositories = names((path) => path.includes('/repositories/'));
  const hasTheme = generated.some((change) => /theme/i.test(change.path));
  const hasProvider = generated.some((change) => /provider/i.test(change.path));
  const hasSql = generated.some((change) => change.path.endsWith('.sql'));
  const backendLine = usesSupabase
    ? 'Supabase — PostgreSQL migrations with client setup'
    : 'Local in-memory repositories with sample data';

  if (!isInitial) {
    const lines = ['### Project updated', '', `**${generated.length} file${generated.length === 1 ? '' : 's'} written.**`, ''];
    if (screens.length > 0) {
      lines.push(`- **Screens:** ${screens.map((s) => `\`${s}\``).join(', ')}`);
    }
    lines.push('- The preview build is queued — open the **Preview** tab to try the changes.');
    return lines.join('\n');
  }

  const sections: string[] = [];
  sections.push(
    `### App scaffold is ready\n\n` +
      `**${generated.length} production files** written — Material 3, \`provider\` state${usesSupabase ? ', Supabase backend' : ''}.`,
  );

  if (screens.length > 0) {
    sections.push(`**Screens (${screens.length})**\n${screens.map((screen) => `- \`${screen}\``).join('\n')}`);
  }

  const dataLines = [`- **Backend:** ${backendLine}`];
  if (models.length > 0) dataLines.push(`- **Models:** ${models.map((model) => `\`${model}\``).join(', ')}`);
  if (services.length > 0) dataLines.push(`- **Services:** ${services.map((service) => `\`${service}\``).join(', ')}`);
  if (repositories.length > 0) dataLines.push(`- **Repositories:** ${repositories.map((repo) => `\`${repo}\``).join(', ')}`);
  if (hasProvider) dataLines.push('- **State:** `AppProvider` (`provider`) app-wide with `notifyListeners()`');
  if (hasSql) dataLines.push('- **SQL:** migrations included — run them in the Supabase SQL editor first');
  sections.push(`**Data & state**\n${dataLines.join('\n')}`);

  if (hasTheme) {
    sections.push('**Theming**\n- `AppTheme` — Material 3 tokens for light and dark surfaces');
  }

  sections.push('**Next**\n- The preview build is queued — open the **Preview** tab to try it.\n- Ask for changes in plain language; I will edit the source in place.');

  return sections.join('\n\n');
}

export function generateNextActionPrompts(prompt: string, changes: FileChange[], usesSupabase = true): string[] {
  const lower = prompt.toLowerCase();
  const prompts: string[] = [];

  const hasSql = changes.some((c) => c.path.endsWith('.sql'));
  const hasAuth = changes.some((c) => c.path.includes('auth'));
  const hasCart = changes.some((c) => c.path.includes('cart'));

  if (!lower.includes('dark') && !lower.includes('theme')) {
    prompts.push('Add an animated Dark/Light Mode toggle');
  }

  if (usesSupabase && !hasAuth && !lower.includes('auth') && !lower.includes('login')) {
    prompts.push('Add Supabase Auth with login, signup and password recovery');
  }

  if (!usesSupabase) {
    prompts.push('Add local persistence so the app remembers state after restart');
    prompts.push('Add keyboard shortcuts and responsive desktop layout');
  }

  if (lower.includes('ecommerce') || lower.includes('shop') || hasCart) {
    prompts.push('Add Stripe checkout flow and order receipt history');
    prompts.push('Add category filter and price range slider');
  } else if (lower.includes('crypto') || lower.includes('wallet')) {
    prompts.push('Add interactive price history chart with 24h P&L');
    prompts.push('Add real-time price alerts in Supabase');
  } else if (lower.includes('chat') || lower.includes('ai')) {
    prompts.push('Add streaming typewriter response effect');
    prompts.push('Add voice input and audio message recorder');
  } else {
    prompts.push('Add a search bar with instant autocomplete');
    prompts.push('Add real-time Supabase subscription stream');
  }

  if (hasSql) {
    prompts.push('Generate mock seed data SQL for instant testing');
  }

  return prompts.slice(0, 4);
}


function safePoolKey(): string {
  try {
    const key = keyPool.getNextKey();
    if (key) return key;
  } catch {
    // continue
  }
  try {
    if (typeof localStorage !== 'undefined') {
      const storedPool = localStorage.getItem('openrouter_api_keys');
      if (storedPool) {
        for (const k of storedPool.split(',')) keyPool.addKey(k);
      }
      const stored = localStorage.getItem('openrouter_api_key')
        || localStorage.getItem('openrouter_key')
        || localStorage.getItem('ff_openrouter_key');
      if (stored) {
        keyPool.addKey(stored);
        return stored;
      }
    }
  } catch {
    // continue
  }
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    const envPool = import.meta.env.VITE_OPENROUTER_API_KEYS as string | undefined;
    if (envPool) {
      for (const k of envPool.split(',')) keyPool.addKey(k);
      const next = keyPool.getNextKey();
      if (next) return next;
    }
    const envKey = import.meta.env.VITE_OPENROUTER_API_KEY as string | undefined;
    if (envKey) {
      keyPool.addKey(envKey);
      return envKey;
    }
  }
  return '';
}

// Short display name for progress messages ("nemotron-3-ultra" etc.).
function shortModel(modelId: string): string {
  const base = modelId.split('/').pop() || modelId;
  return base.replace(/:free$/, '').replace(/-/g, ' ');
}


// Conversations with a generation currently running. Second concurrent
// sendMessage for the same conversation returns immediately (see C4).
const inFlightSends = new Set<string>();

// Projects whose generation currently owns the send lock. Repairs must never
// fire inside a send: the duplicate guard would swallow them while the caller
// logs a false "repair complete". They queue here and flush after the lock is
// released (sendMessage's finally).
const activeSendProjects = new Set<string>();
type RepairReason = 'build' | 'verification' | 'artifact';
interface PendingRepair {
  logs: string[];
  round: number;
  reason: RepairReason;
}
const pendingRepairs = new Map<string, PendingRepair>();

function queueRepair(projectId: string, logs: string[], round = 1, reason: RepairReason = 'build'): void {
  const existing = pendingRepairs.get(projectId);
  pendingRepairs.set(projectId, {
    logs: [...logs],
    round: Math.max(round, existing?.round ?? 0),
    reason: existing?.reason ?? reason,
  });
  useTerminalStore.getState().addLine({
    type: 'output',
    content: `[repair] Queued ${reason} repair for after the current generation finishes.`,
  });
}

async function flushQueuedRepair(projectId: string): Promise<void> {
  const pending = pendingRepairs.get(projectId);
  if (!pending) return;
  if (activeSendProjects.has(projectId)) return; // that send's finally flushes
  pendingRepairs.delete(projectId);
  try {
    await repairFailedBuild(projectId, pending.logs, pending.round, undefined, pending.reason);
  } catch (error) {
    useTerminalStore.getState().addLine({
      type: 'error',
      content: `[repair] Queued repair failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

// Abort controller for the CURRENT store-driven repair run. The panel's Stop
// button owns its own controller for panel-initiated sends; repairs are
// started outside the panel, so their signal lives here.
let activeRepairAbort: AbortController | null = null;

// Session flag: the Supabase `ai-generate` edge function answered 404/absent.
// Every generation used to retry it (404 + CORS noise) before falling through;
// after the first miss we skip the tier for a cooldown window, then give it
// another chance (an edge deploy/blip must not brick the tier for the whole
// session).
let edgeGenerateUnavailableUntil = 0;
const EDGE_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const edgeGenerateUnavailableNow = () => Date.now() < edgeGenerateUnavailableUntil;
const markEdgeGenerateUnavailable = () => { edgeGenerateUnavailableUntil = Date.now() + EDGE_RETRY_COOLDOWN_MS; };

// Files without which a Flutter project can never build. When the Edge LLM
// omits any of these, they are backfilled from the deterministic offline
// generator (same guarantee as the local agent's mergeWithBaseline).
const CRITICAL_FILES = [
  'pubspec.yaml',
  'lib/main.dart',
  'lib/app.dart',
  'supabase/migrations/001_initial_schema.sql',
];

// How long the post-generation build watcher waits for a terminal preview
// status before giving up (5s poll × 144 = 12 min, covers cold Docker builds).
const BUILD_WATCH_POLLS = 144;
const BUILD_WATCH_INTERVAL_MS = 5000;
// The first build plus three automatic AI repair attempts, then the user is
// asked to step in. One rebuild is also triggered by the repair itself.
const MAX_AUTO_REPAIRS = 3;

/**
 * Lovable-style self-healing loop (A3): watches a just-triggered preview
 * build and, if it FAILS, sends the build logs back through the agent as a
 * repair prompt. Exactly one repair per build — repair passes carry
 * isRepair so they never arm another watcher (no infinite loops).
 * Fire-and-forget: never throws.
 */
function watchPreviewBuild(projectId: string, sessionId: string): void {
  let polls = 0;
  const timer = setInterval(() => {
    polls++;
    try {
      const session = usePreviewStore.getState().getSession(projectId);
      // Superseded (newer build started) or project switched away.
      if (!session || session.sessionId !== sessionId) {
        clearInterval(timer);
        return;
      }
      if (session.status === 'running') {
        resetAutoRepairBudget(projectId);
        useTerminalStore.getState().addLine({ type: 'success', content: '✓ Preview is live' });
        clearInterval(timer);
        return;
      }
      if (session.status === 'failed') {
        // Repair is owned by the preview-store bridge (registerBuildFailedHandler),
        // which covers manual retries and automatic builds uniformly.
        clearInterval(timer);
        return;
      }
      if (session.status === 'stopped' || polls >= BUILD_WATCH_POLLS) {
        clearInterval(timer);
      }
    } catch {
      clearInterval(timer);
    }
  }, BUILD_WATCH_INTERVAL_MS);
}

/** Read pubspec.yaml into the package set we trust: the app's own name plus
 *  every declared (dev)dependency. */
function declaredPackagesFromPubspec(yamlText: string | undefined): { name: string | null; packages: Set<string> } {
  const packages = new Set<string>(['flutter', 'dart', 'sky_engine', 'cupertino_icons']);
  if (!yamlText) return { name: null, packages };
  const name = yamlText.match(/^name\s*:\s*([A-Za-z0-9_]+)/m)?.[1] ?? null;
  if (name) packages.add(name);
  let section: string | null = null;
  for (const raw of yamlText.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^(dependencies|dev_dependencies)\s*:/.test(trimmed)) { section = 'deps'; continue; }
    if (/^[A-Za-z0-9_-]+\s*:/.test(raw)) { section = null; continue; }
    if (section) {
      const indent = raw.match(/^\s*/)![0].length;
      if (indent >= 2 && indent < 4) {
        const m = trimmed.match(/^([A-Za-z0-9_]+)\s*:/);
        if (m && m[1] !== 'sdk') packages.add(m[1]);
      }
    }
  }
  return { name, packages };
}

async function attemptDeterministicRepair(projectId: string, logs: string[]): Promise<boolean> {
  const store = useProjectStore.getState();
  const files = store.files;
  if (!files || files.length === 0) return false;

  let fixedAny = false;

  // 0. Rewrite hallucinated package: namespaces in Dart files
  //    (e.g. package:production/app.dart when pubspec declares `shopflow`).
  //    Nothing else in the toolchain can fix this — pub get and analyze both
  //    fail on it — so repair it here before calling any model.
  const pubspec = files.find((file) => file.path === 'pubspec.yaml');
  const declared = declaredPackagesFromPubspec(pubspec?.content ?? undefined);
  if (declared.name) {
    const appName = declared.name;
    const importRe = /(package:)([A-Za-z0-9_]+)(\/[^'"\s]*)/g;
    for (const file of files) {
      if (!file.path.endsWith('.dart') || !file.content || file.is_directory) continue;
      const next = file.content.replace(importRe, (whole, prefix, pkg, rest) =>
        declared.packages.has(pkg) ? whole : `${prefix}${appName}${rest}`);
      if (next !== file.content) {
        await store.saveFile(projectId, file.path, next);
        fixedAny = true;
      }
    }
  }

  // 1. Proactively scan lib/core/router/app_router.dart for common mismatched imports
  const routerFile = files.find((f) => f.path === 'lib/core/router/app_router.dart');
  if (routerFile && routerFile.content) {
    let content = routerFile.content;
    let routerModified = false;

    const replacements: Array<[RegExp, string]> = [
      [/screens\/usermanagement\/user_management_screen\.dart/g, 'screens/users/user_management_screen.dart'],
      [/screens\/auditlogs\/audit_logs_screen\.dart/g, 'screens/audit/audit_logs_screen.dart'],
      [/screens\/healthmonitor\/health_monitor_screen\.dart/g, 'screens/health/health_monitor_screen.dart'],
      [/screens\/usermanagement\//g, 'screens/users/'],
      [/screens\/auditlogs\//g, 'screens/audit/'],
    ];

    for (const [pattern, repl] of replacements) {
      if (pattern.test(content)) {
        content = content.replace(pattern, repl);
        routerModified = true;
      }
    }

    // Check all screen imports against actual project files
    const importRegex = /import\s+['"]([^'"]+\.dart)['"];/g;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(routerFile.content)) !== null) {
      const imp = match[1];
      if (imp.startsWith('package:') || imp.startsWith('dart:')) continue;
      const fileName = imp.split('/').pop();
      if (!fileName) continue;

      const normalized = imp.replace(/^\.\.\/\.\.\//, 'lib/');
      const exists = files.some((f) => f.path === normalized || f.path.endsWith(normalized));
      if (!exists) {
        const actual = files.find((f) => f.path.endsWith(`/${fileName}`) || f.path === fileName);
        if (actual) {
          const relativeToRouter = `../../${actual.path.replace(/^lib\//, '')}`;
          content = content.replace(imp, relativeToRouter);
          routerModified = true;
        }
      }
    }

    if (routerModified && content !== routerFile.content) {
      await store.saveFile(projectId, routerFile.path, content);
      fixedAny = true;
    }
  }

  // 2. Scan compiler logs for "Error when reading '...': No such file or directory"
  const missingImports: string[] = [];
  for (const line of logs) {
    const m = line.match(/Error(?: when reading)? ['"]([^'"]+\.dart)['"]: No such file or directory/i);
    if (m) missingImports.push(m[1]);
  }

  if (missingImports.length > 0) {
    for (const missing of missingImports) {
      const fileName = missing.split('/').pop();
      if (!fileName) continue;
      const actual = files.find((f) => f.path.endsWith(`/${fileName}`));
      if (!actual) continue;

      for (const file of files) {
        if (!file.content || file.is_directory) continue;
        if (file.content.includes(fileName)) {
          const depth = file.path.split('/').length - 2;
          const up = depth > 0 ? Array(depth).fill('..').join('/') : '.';
          const newRel = `${up}/${actual.path.replace(/^lib\//, '')}`;
          const badRegex = new RegExp(`['"][^'"]*${fileName}['"]`, 'g');
          const newContent = file.content.replace(badRegex, `'${newRel}'`);
          if (newContent !== file.content) {
            await store.saveFile(projectId, file.path, newContent);
            fixedAny = true;
          }
        }
      }
    }
  }

  return fixedAny;
}

async function repairFailedBuild(
  projectId: string,
  logs: string[],
  round = 1,
  signal?: AbortSignal,
  reason: RepairReason = 'build',
): Promise<void> {
  // Never enter sendMessage while this project's generation owns the lock:
  // the duplicate guard returns `mode: 'duplicate'`, and pretending that was
  // a completed repair was the bug that restarted whole generations.
  if (activeSendProjects.has(projectId)) {
    queueRepair(projectId, logs, round, reason);
    return;
  }

  const terminal = useTerminalStore.getState();
  const activity = useActivityStore.getState();
  activity.begin(projectId, `Repair ${reason === 'build' ? 'preview build' : reason} (round ${round})`, false);

  terminal.addLine({
    type: 'output',
    content: `[repair] Checking ${reason === 'build' ? 'preview build' : reason} errors (attempt ${round}/${MAX_AUTO_REPAIRS})…`,
  });
  activity.ingestProgress(`Checking ${reason === 'build' ? 'preview build' : reason} errors (attempt ${round}/${MAX_AUTO_REPAIRS})`);

  try {
    const store = useProjectStore.getState();
    if (!store.currentProject || store.currentProject.id !== projectId) {
      // Never teleport the user to another project because a background build
      // failed while they're working elsewhere — and never repair against the
      // wrong project's file list. Queue it; it will run next time the user
      // opens this project (or clicks "Fix automatically" in the Preview tab).
      queueRepair(projectId, logs, round, reason);
      terminal.addLine({
        type: 'output',
        content: `[repair] Skipped auto-repair — "${projectId}" is not the project you're viewing. Open it to retry, or use "Fix automatically" in the Preview tab.`,
      });
      activity.end('stopped', 'Auto-repair deferred until the project is opened');
      return;
    }
    if (!store.conversation) {
      await store.loadConversation(projectId);
    }

    // Step 1: Attempt deterministic zero-latency import repair
    const repairedDeterministically = await attemptDeterministicRepair(projectId, logs);
    if (repairedDeterministically) {
      terminal.addLine({ type: 'success', content: '✓ Auto-fixed known build issues in the project — rebuilding preview' });
      activity.end('success', 'Auto-fixed known build issues — rebuilding preview');
      const updatedFiles = useProjectStore.getState().files;
      const newSessionId = await usePreviewStore.getState().build(projectId, updatedFiles);
      if (newSessionId) {
        watchPreviewBuild(projectId, newSessionId);
      }
      return;
    }

    // Step 2: Clean kernel/dev_compiler noise, keep everything that points
    // at the real failure (pub/yaml/compile), plus the raw terminal tail —
    // the analyzer is often skipped, so the tail is all the AI has.
    const cleanErrors = [
      ...logs
        .filter((line) => !/package:dev_compiler|package:frontend_server|package:kernel|dart:core-patch|<asynchronous suspension>/i.test(line))
        .filter((line) => /pub get|pubspec|yaml|error|Error:|Exception|Failed|unable|undefined|not found|Expected|Invalid|No such|warning/i.test(line))
        .slice(-8),
      '── terminal tail ──',
      ...logs.slice(-15),
    ]
      .join('\n')
      .slice(-3000);

    terminal.addLine({
      type: 'error',
      content: `✗ ${reason === 'build' ? 'Preview build failed' : `Project ${reason} gate failed`} — agent repairing compile errors…`,
    });

    const heading = reason === 'artifact'
      ? 'The deterministic project gate found unresolved files or imports in the generated project'
      : reason === 'verification'
        ? 'The Dart analyzer (dart analyze) found errors in the saved project'
        : 'The Flutter preview build encountered compile errors';
    const focus = reason === 'artifact'
      ? 'Create the missing files or fix the imports listed below. Do not remove working features.'
      : 'Read the failing file(s) and fix the actual root cause.';

    const result = await useProjectStore.getState().sendMessage(
      projectId,
      `${heading} (attempt ${round}/${MAX_AUTO_REPAIRS}). Fix the code so it compiles cleanly.\n\nErrors:\n${cleanErrors || '(no specific errors captured)'}\n\nRules:\n- ${focus}\n- Keep every file complete and compilable; no TODOs or placeholders.`,
      (message) => {
        terminal.addLine({ type: 'output', content: `  [repair ${round}] ${message}` });
        activity.ingestProgress(message);
      },
      {
        isInitialGeneration: false,
        autoRepairBuild: true,
        isRepair: true,
        repairRound: round,
        signal,
        onEvent: (event) => activity.ingestAgent(event),
        onFile: (file) => activity.ingestFile(file),
      },
    );

    if (result.mode === 'duplicate') {
      terminal.addLine({
        type: 'error',
        content: '✗ Repair did NOT run — another generation still holds the chat. It is queued and will retry automatically.',
      });
      queueRepair(projectId, logs, round, reason);
      activity.end('stopped', 'Repair queued behind an in-flight generation');
      return;
    }

    if (result.verified) {
      terminal.addLine({ type: 'success', content: '✓ Repair verified — analyzer clean; preview rebuilding' });
      activity.end('success', 'Repair verified — preview rebuilding');
    } else {
      terminal.addLine({
        type: 'output',
        content: 'Repair pass finished, but the project is still not verified. Files are saved; see the analyzer errors above.',
      });
      activity.end('error', 'Repair finished but verification still fails');
    }
  } catch (e) {
    const message = (e as Error).message;
    terminal.addLine({ type: 'error', content: `✗ Auto-repair failed: ${message}` });
    activity.end('error', `Repair failed: ${message}`);
  }
}

interface AgentGenerationOutcome {
  changes: FileChange[];
  verified: boolean;
  verification?: AgentGenerationResult['verification'];
}

async function requestAIGeneration(
  projectId: string,
  messages: AIMessage[],
  files: ProjectFile[],
  isInitialGeneration: boolean,
  projectName = 'FlutterForgeApp',
  stateManagement = 'provider',
  conversationHistory: Array<{ role: string; content: string }> = [],
  onProgress?: (msg: string) => void,
  onEvent?: (event: { message: string; node?: string; phase?: string; step_number?: number }) => void,
  signal?: AbortSignal,
  platform = 'web',
  projectDescription = '',
  modelPreference: ModelPreference = 'auto',
  onFile?: (file: SSEFileReadyEvent) => void,
  isRepair = false,
  isEdit = false,
): Promise<AgentGenerationOutcome> {
  // Routing policy: frontier for planning/design/first pass, fast for routine
  // edits, repairs, and chat. The engine re-checks entitlement server-side.
  if (!useCredentialsStore.getState().status) {
    await useCredentialsStore.getState().load();
  }
  const plan = useAuthStore.getState().profile?.plan ?? 'free';
  const choice = resolveModelChoice({
    preference: modelPreference,
    isInitialGeneration,
    isRepair,
    plan,
    hasByok: useCredentialsStore.getState().hasOpenRouterKey(),
  });
  const fastModel =
    (typeof import.meta !== 'undefined' && (import.meta.env?.VITE_AGENT_MODEL as string | undefined)) ||
    ECONOMY_MODEL;
  const qualityModel = FRONTIER_MODEL;
  const preferredModel = choice.role === 'frontier' ? qualityModel : fastModel;
  const agentModel = preferredModel;

  const latestUserPrompt = messages.filter((m) => m.role === 'user').pop()?.content || 'Create Flutter application';
  const appId = generateUniqueAppId(projectName, projectId);
  const promptText = `${latestUserPrompt} ${projectDescription} ${projectName}`;
  const filesUseSupabase = files.some((file) => !file.is_directory && (
    /^supabase\//.test(file.path)
    || /supabase_flutter|Supabase\.initialize|SupabaseService/.test(file.content)
  ));
  const usesSupabase = isExplicitLocalOnly(latestUserPrompt)
    ? false
    : (isInitialGeneration
      ? detectSupabaseNeed(promptText)
      : (detectSupabaseNeed(promptText) || filesUseSupabase));
  const context = AgentContextBuilder.buildContext({
    projectId,
    projectName,
    projectDescription,
    files,
    conversationHistory: messages.map((m) => ({ role: m.role, content: m.content })),
    supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
    supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    platform,
    appId,
    usesSupabase,
    activeFile: useWorkspaceStore.getState().activeFile,
    buildErrors: usePreviewStore.getState().getSession(projectId)?.logs ?? [],
  });

  const isIncremental = !isInitialGeneration && files.length > 0;
  const activeSkills = SkillRegistry.getActiveSkills();

  if (signal?.aborted) throw new Error('Generation cancelled by user');

  // TIER 1: Edge Function (real AI generation with model fallback chain).
  // Deployments without this function answered 404+CORS on EVERY generation —
  // remember the first miss for the session and skip straight to the local agent.
  // Repairs and surgical edits are also routed straight to the local edit
  // agent: the Edge function does whole-app regeneration, not targeted fixes.
  const repairCall = isRepair || isEdit;
  if (edgeGenerateUnavailableNow() || repairCall) {
    if (repairCall) {
      onProgress?.('Repair mode — applying a targeted fix with the local edit agent…');
    } else {
      console.info('[Agent] Skipping Supabase edge function (unavailable in this deployment).');
    }
  } else
    try {
      onProgress?.(`Sending request to AI (${shortModel(agentModel)} + fallback models)...`);
      const edgeKey = safePoolKey();
      const edgeHeaders: Record<string, string> = {};
      if (edgeKey) edgeHeaders['X-OpenRouter-Key'] = edgeKey;
      if (agentModel) edgeHeaders['X-OpenRouter-Model'] = agentModel;
      const invokePromise = supabase.functions.invoke('ai-generate', {
        body: {
          messages: messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          files: files.filter((file) => !file.is_directory).map((file) => ({
            path: file.path,
            content: file.content,
          })),
          mode: isInitialGeneration ? 'new' : 'edit',
        },
        headers: Object.keys(edgeHeaders).length > 0 ? edgeHeaders : undefined,
      });
      const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Edge timeout 90s')), 90000));
      const { data, error } = await Promise.race([invokePromise, timeoutPromise]) as Awaited<typeof invokePromise>;

      if (!error && data) {
        edgeGenerateUnavailableUntil = 0; // edge recovered — clear any cooldown
        const generatedFiles = (data as { files?: Array<{ path?: unknown; content?: unknown }>; model?: string; complete?: boolean; missing?: string[] } | null)?.files;
        const usedModel = (data as { model?: string })?.model;
        if (Array.isArray(generatedFiles) && generatedFiles.length > 0) {
          onProgress?.(`AI generated ${generatedFiles.length} files using ${usedModel || 'unknown model'}`);
          const existingPaths = new Set(files.map((file) => file.path));
          const changes: FileChange[] = generatedFiles
            .filter((file: { path?: unknown; content?: unknown }): file is { path: string; content: string } => typeof file.path === 'string' && typeof file.content === 'string')
            .map((file) => ({
              path: file.path,
              content: file.content,
              action: existingPaths.has(file.path) ? 'modified' as const : 'created' as const,
            }));

          // An edge response that parses to zero usable files is treated as
          // empty — fall through to the local agent, never return 0 files.
          if (changes.length === 0) {
            onProgress?.('Edge output had no usable files - trying local AI agent...');
          } else {

            // E2E completeness: backfill any critical files the LLM omitted so
            // the project is never left unbuildable by a truncated response.
            const produced = new Set(changes.map((c) => c.path));
            const missingCritical = CRITICAL_FILES.filter((p) => !produced.has(p));
            if (missingCritical.length > 0) {
              onProgress?.(`AI omitted ${missingCritical.length} critical file(s) — backfilling from structured generator...`);
              try {
                const latestUserPrompt = messages.filter((m) => m.role === 'user').pop()?.content || 'Create Flutter application';
                const bContext = AgentContextBuilder.buildContext({
                  projectId,
                  projectName,
                  files,
                  conversationHistory: messages.map((m) => ({ role: m.role, content: m.content })),
                });
                const bPlan = AgentPlanner.plan(latestUserPrompt, bContext, {
                  stateManagement: stateManagement as 'provider' | 'riverpod' | 'bloc' | 'change_notifier',
                });
                const baseline = MultiFileCodeGenerator.generateAllFiles(bPlan, bContext);
                for (const b of baseline) {
                  if (missingCritical.includes(b.path) && !produced.has(b.path)) {
                    changes.push({
                      path: b.path,
                      content: b.content,
                      action: existingPaths.has(b.path) ? 'modified' as const : 'created' as const,
                    });
                    produced.add(b.path);
                  }
                }
              } catch {
                // Backfill is best-effort — partial Edge output still proceeds.
              }
            }

            return { changes, verified: true };
          }
        }
        onProgress?.('Edge returned empty - trying local AI agent...');
      } else if (error) {
        const errorMessage = (error as Error).message ?? '';
        // 404 / "function not found" / CORS-blocked fetches mean the function is
        // NOT deployed — remember and skip this tier for the rest of the session.
        if (/404|FunctionsNotFound|not found|Failed to fetch|Failed to send/i.test(errorMessage)) {
          markEdgeGenerateUnavailable();
        }
        onProgress?.(`Edge failed (${errorMessage.slice(0, 60)}) - trying local AI agent...`);
      }
    } catch (e) {
      const message = (e as Error).message ?? '';
      if (/404|FunctionsNotFound|not found|Failed to fetch|Failed to send/i.test(message)) {
        markEdgeGenerateUnavailable();
      }
      onProgress?.(`Edge timeout/error (${message.slice(0, 40)}) - using structured fallback...`);
    }

  if (signal?.aborted) throw new Error('Generation cancelled by user');

  // TIER 2: In-browser agent. Runs entirely in the renderer with the user's
  // key, so it works in any deployment without a local model service.
  try {
    const apiKey = safePoolKey() || '';
    onProgress?.(
      repairCall
        ? 'Edit agent active — applying a targeted fix…'
        : `Local AI agent active — generating Flutter app (${choice.role === 'frontier' ? 'frontier' : 'fast'} model, ${activeSkills.length} skills active)...`,
    );
    const result = await FlutterSupabaseAgent.execute(latestUserPrompt, context, {
      enableAutoHealing: true,
      stateManagement: stateManagement as 'provider' | 'riverpod' | 'bloc' | 'change_notifier',
      isIncremental,
      conversationHistory,
      skills: activeSkills,
      signal,
      isEdit: repairCall,
      existingFiles: repairCall
        ? files.filter((file) => !file.is_directory).map((file) => ({ path: file.path, content: file.content }))
        : undefined,

      modelConfig: {
        provider: 'custom',
        modelName: agentModel,
        apiKey,
      },
      onEvent: (event) => {
        onEvent?.({
          message: event.message,
          node: event.phase,
          phase: event.phase,
          step_number: event.stepNumber,
        });
        onProgress?.(event.message);
      },
      onFile,
    });

    if (signal?.aborted) throw new Error('Generation cancelled by user');

    if (result.files && result.files.length > 0) {
      if (apiKey) keyPool.markSuccess(apiKey);
      const verified = result.success !== false;
      onProgress?.(`Generation complete: produced ${result.files.length} Flutter files`);
      const existingFileMap = new Map(files.map((file) => [file.path, file.content]));
      const changes = result.files.map((file) => {
        const prevContent = file.oldContent ?? existingFileMap.get(file.path);
        const isNew = !existingFileMap.has(file.path);
        return {
          path: file.path,
          content: file.content ?? '',
          previous_content: prevContent,
          oldContent: prevContent,
          action: isNew ? ('created' as const) : ('modified' as const),
        };
      });
      return { changes, verified, verification: result.verification };
    }
    onProgress?.('Local AI agent returned no files — using structured fallback...');
  } catch (agentError) {
    if (signal?.aborted) throw new Error('Generation cancelled by user');
    const message = agentError instanceof Error ? agentError.message : String(agentError);
    console.warn('[Tier 2] In-browser agent failed, falling back:', agentError);
    onProgress?.(`Local AI agent failed (${message.slice(0, 80)}) — using structured fallback...`);
  }

  if (signal?.aborted) throw new Error('Generation cancelled by user');

  // TIER 3: Deterministic Structured Template Generator Fallback
  // If ALL AI models are unavailable (503 capacity limit, 402 credits exhausted, offline, etc.)
  // NEVER leave the project with 0 files or broken state. Generate the complete, production-grade
  // Flutter project containing: Home, Profile, Settings, Navbar, Header, Login, Register, Onboard,
  // GoRouter, ThemeController, Item/User models, AppProvider, Supabase service, and SQL migrations.
  onProgress?.('AI model unavailable — applying complete production Flutter app structure with all sections...');
  if (!isInitialGeneration && files.length > 0) {
    throw new Error(
      'AI providers are unavailable, so I could not safely apply this change. Your existing project files were kept unchanged. Check the AI connection or API key, then retry.',
    );
  }
  // Last-resort deterministic fallback must also respect the backend choice.
  // A local calculator should never receive auth screens and SQL.
  const fallbackFiles = usesSupabase
    ? generateFlutterProjectFiles(
      projectName,
      'standard',
      [],
      undefined,
      projectId,
    )
    : generateMinimalStarterFiles(projectName, projectId);
  const existingFileMap = new Map(files.map((file) => [file.path, file.content]));
  return {
    changes: fallbackFiles.map((file) => ({
      path: file.path,
      content: file.content ?? '',
      oldContent: existingFileMap.get(file.path),
      action: existingFileMap.has(file.path) ? ('modified' as const) : ('created' as const),
    })),
    verified: true,
  };
}


/* ─────────────────────────────────────────────────────────────
   Automatic repair bridge
   ─────────────────────────────────────────────────────────────
   Every preview build (manual retry or automatic post-generation
   build) that transitions to `failed` lands in this handler. It
   feeds the build's terminal log tail to the repair agent and
   rebuilds — bounded per project so a hopeless pubspec cannot
   burn unbounded LLM calls. Budget resets on a live preview.
   ───────────────────────────────────────────────────────────── */
const autoRepairAttempts = new Map<string, number>();
const autoRepairSessions = new Set<string>();

function resetAutoRepairBudget(projectId: string): void {
  autoRepairAttempts.set(projectId, 0);
}

registerBuildFailedHandler((projectId, sessionId) => {
  if (autoRepairSessions.has(sessionId)) return; // already handled this failure
  autoRepairSessions.add(sessionId);
  const attempts = autoRepairAttempts.get(projectId) ?? 0;
  if (attempts >= MAX_AUTO_REPAIRS) {
    useTerminalStore.getState().addLine({
      type: 'error',
      content: `[auto-repair] Giving up after ${MAX_AUTO_REPAIRS} attempts. Your files are saved — fix the remaining error in the Code tab, or click “Fix automatically”.`,
    });
    return;
  }
  autoRepairAttempts.set(projectId, attempts + 1);
  useTerminalStore.getState().addLine({
    type: 'output',
    content: `[auto-repair] Build failed — AI is reading the logs and fixing the code (attempt ${attempts + 1}/${MAX_AUTO_REPAIRS})…`,
  });
  void useProjectStore.getState().repairBuild(projectId, attempts + 1);
});
