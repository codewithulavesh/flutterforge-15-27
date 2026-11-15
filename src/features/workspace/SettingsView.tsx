import { Settings as SettingsIcon, Save, RefreshCw, KeyRound, Database, Link2, Unlink, FileCode2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useProjectStore } from '@/stores/project.store';
import { useAuthStore } from '@/stores/auth.store';
import { useCredentialsStore, type CredentialProvider } from '@/stores/credentials.store';
import { useSupabaseStore } from '@/stores/supabase.store';
import { toast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';

const PROVIDER_LABELS: Record<CredentialProvider, { name: string; hint: string; placeholder: string }> = {
  openrouter: {
    name: 'OpenRouter',
    hint: 'Frontier and fast models. Keys start with sk-or-.',
    placeholder: 'sk-or-v1-…',
  },
  deepseek: {
    name: 'DeepSeek',
    hint: 'Native DeepSeek route for the fast model.',
    placeholder: 'sk-…',
  },
};

export function SettingsView() {
  const { currentProject, updateProject, files } = useProjectStore();
  const plan = useAuthStore((state) => state.profile?.plan ?? 'free');
  const {
    status: credentialStatus,
    loading: credentialLoading,
    error: credentialError,
    load: loadCredentials,
    saveKey,
    removeKey,
  } = useCredentialsStore();
  const [name, setName] = useState(currentProject?.name ?? '');
  const [description, setDescription] = useState(currentProject?.description ?? '');
  const [flutterVersion, setFlutterVersion] = useState(currentProject?.flutter_version ?? '3.24.0');
  const [stateManagement, setStateManagement] = useState(currentProject?.state_management ?? 'provider');
  const [themeMode, setThemeMode] = useState(currentProject?.theme_mode ?? 'light');
  const [platform, setPlatform] = useState(currentProject?.platform ?? 'web');
  const [keyDrafts, setKeyDrafts] = useState<Record<CredentialProvider, string>>({ openrouter: '', deepseek: '' });
  const [sbRef, setSbRef] = useState('');
  const [sbPat, setSbPat] = useState('');
  const { connected, connecting, lastError, projectName, projectRef, save: connectSupabase, disconnect: disconnectSupabase } = useSupabaseStore();

  useEffect(() => {
    void loadCredentials();
  }, [loadCredentials]);

  if (!currentProject) return null;

  const frontierIncluded = ['pro', 'team'].includes(plan.toLowerCase())
    || Boolean(credentialStatus?.credentials.openrouter.configured);
  const storageLabel = credentialStatus?.storage === 'os-encrypted'
    ? 'Keys are encrypted by the operating system and never leave this machine.'
    : window.flutterforgeDesktop?.isDesktop
      ? 'Keys are stored in a local file with owner-only permissions.'
      : 'Browser session only — install the desktop app to store keys securely.';

  async function handleSaveKey(provider: CredentialProvider) {
    const value = keyDrafts[provider].trim();
    if (!value) return;
    const saved = await saveKey(provider, value);
    if (saved) {
      setKeyDrafts((current) => ({ ...current, [provider]: '' }));
      toast('success', `${PROVIDER_LABELS[provider].name} key saved`);
    } else {
      toast('error', useCredentialsStore.getState().error ?? 'Could not save the key.');
    }
  }

  async function handleRemoveKey(provider: CredentialProvider) {
    if (!confirm(`Remove the ${PROVIDER_LABELS[provider].name} key?`)) return;
    const removed = await removeKey(provider);
    if (removed) toast('success', `${PROVIDER_LABELS[provider].name} key removed`);
    else toast('error', useCredentialsStore.getState().error ?? 'Could not remove the key.');
  }

  async function handleSave() {
    const saved = await updateProject(currentProject!.id, {
      name,
      description,
      flutter_version: flutterVersion,
      state_management: stateManagement,
      theme_mode: themeMode,
      platform,
    });
    if (saved) toast('success', 'Settings saved');
    else toast('error', useProjectStore.getState().error ?? 'Could not save settings.');
  }

  return (
    <div className="flex flex-col h-full bg-[var(--ff-bg)] overflow-y-auto ff-scrollbar">
      <div className="max-w-2xl mx-auto w-full p-6 space-y-6">
        <div className="flex items-center gap-2">
          <SettingsIcon size={18} className="text-[var(--ff-primary)]" />
          <h2 className="text-lg font-semibold text-[var(--ff-text)]">Project Settings</h2>
        </div>

        <div className="space-y-4">
          <Input label="Project Name" value={name} onChange={(e) => setName(e.target.value)} />
          <div>
            <label className="block text-sm font-medium text-[var(--ff-text-muted)] mb-1.5">Description</label>
            <textarea
              className="ff-input w-full px-3 py-2 text-sm resize-none"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[var(--ff-text-muted)] mb-1.5">Flutter Version</label>
              <select className="ff-input w-full px-3 py-2.5 text-sm" value={flutterVersion} onChange={(e) => setFlutterVersion(e.target.value)}>
                <option value="3.24.0">3.24.0 (Stable)</option>
                <option value="3.22.0">3.22.0</option>
                <option value="3.19.0">3.19.0</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--ff-text-muted)] mb-1.5">State Management</label>
              <select className="ff-input w-full px-3 py-2.5 text-sm" value={stateManagement} onChange={(e) => setStateManagement(e.target.value)}>
                <option value="provider">Provider</option>
                <option value="riverpod">Riverpod</option>
                <option value="bloc">Bloc</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--ff-text-muted)] mb-1.5">Theme Mode</label>
              <select className="ff-input w-full px-3 py-2.5 text-sm" value={themeMode} onChange={(e) => setThemeMode(e.target.value)}>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="system">System</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--ff-text-muted)] mb-1.5">Platform</label>
              <select className="ff-input w-full px-3 py-2.5 text-sm" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="web">Web</option>
                <option value="mobile">Mobile (iOS + Android)</option>
                <option value="desktop">Desktop (macOS + Windows)</option>
                <option value="macos">macOS only</option>
                <option value="windows">Windows only</option>
              </select>
            </div>
          </div>

          <div className="ff-card p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Database size={15} className="text-[var(--ff-primary)]" />
                <h3 className="text-sm font-semibold text-[var(--ff-text)]">Supabase project</h3>
              </div>
              <Badge variant={connected ? 'success' : 'info'}>{connected ? 'Connected' : 'Not connected'}</Badge>
            </div>

            <p className="text-xs text-[var(--ff-text-muted)]">
              Paste your project ref and a personal access token from
              <code className="mx-1 rounded bg-[var(--ff-surface-2)] px-1 py-0.5 font-mono text-[10px]">supabase.com/dashboard/account/tokens</code>.
              FlutterForge uses them to apply the generated schema automatically.
              Keys never leave this machine or your engine process.
            </p>

            {connected ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--ff-border)]/60 p-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-[var(--ff-text)]">{projectName || projectRef}</p>
                  <p className="text-[11px] font-mono text-[var(--ff-text-dim)]">{projectRef}</p>
                </div>
                <button
                  type="button"
                  onClick={disconnectSupabase}
                  className="flex items-center gap-1 rounded-md border border-[var(--ff-border)] px-2.5 py-1.5 text-[11px] text-[var(--ff-text-muted)] hover:text-[var(--ff-text)] hover:border-[var(--ff-border-hover)]"
                >
                  <Unlink size={11} />
                  Disconnect
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-[11px] font-medium text-[var(--ff-text-muted)]">Project ref</span>
                    <input
                      className="ff-input w-full px-3 py-2 text-xs font-mono"
                      placeholder="abcdefghijklmnoprstuv"
                      autoComplete="off"
                      spellCheck={false}
                      value={sbRef}
                      onChange={(event) => setSbRef(event.target.value)}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] font-medium text-[var(--ff-text-muted)]">Personal access token</span>
                    <input
                      className="ff-input w-full px-3 py-2 text-xs font-mono"
                      placeholder="sbp_…"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={sbPat}
                      onChange={(event) => setSbPat(event.target.value)}
                    />
                  </label>
                </div>
                <Button icon={<Link2 size={13} />} disabled={connecting || !sbRef.trim() || !sbPat.trim()} onClick={async () => { const ok = await connectSupabase(sbRef.trim(), sbPat.trim()); if (ok) { setSbRef(''); setSbPat(''); toast('success', 'Supabase project connected'); } else toast('error', useSupabaseStore.getState().lastError ?? 'Could not connect.'); }}>
                  {connecting ? 'Verifying…' : 'Connect Supabase'}
                </Button>
                {lastError && <p className="text-[11px] text-[var(--ff-danger)]">{lastError}</p>}
              </div>
            )}

            {connected && files.filter((f) => /^supabase\/migrations\/.*\.sql$/i.test(f.path)).length > 0 && (
              <div className="rounded-lg border border-[var(--ff-border)]/60 p-3 space-y-2">
                <p className="text-[11px] font-semibold text-[var(--ff-text-muted)]">Generated migrations</p>
                {files
                  .filter((f) => /^supabase\/migrations\/.*\.sql$/i.test(f.path))
                  .map((f) => (
                    <div key={f.path} className="flex flex-wrap items-center justify-between gap-2">
                      <code className="flex items-center gap-1 font-mono text-[10px] text-[var(--ff-text-muted)]">
                        <FileCode2 size={11} className="shrink-0" />
                        {f.path}
                      </code>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={connecting}
                        onClick={async () => {
                          const ok = await useSupabaseStore.getState().applyMigration(f.content, f.path);
                          if (ok) toast('success', 'Migration applied');
                          else toast('error', useSupabaseStore.getState().lastError ?? 'Migration failed.');
                        }}
                      >
                        Apply
                      </Button>
                    </div>
                  ))}
              </div>
            )}
          </div>

          <div className="ff-card p-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs text-[var(--ff-text-dim)]">Project ID</p>
              <p className="text-xs text-[var(--ff-text-muted)] font-mono truncate">{currentProject.id}</p>
            </div>
            <Badge variant="info" className="shrink-0">{currentProject.template}</Badge>
          </div>

          <Button icon={<Save size={14} />} onClick={handleSave}>Save Settings</Button>

          <div className="ff-card p-4 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <KeyRound size={15} className="text-[var(--ff-primary)]" />
                <h3 className="text-sm font-semibold text-[var(--ff-text)]">Model access</h3>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={frontierIncluded ? 'success' : 'info'}>
                  {frontierIncluded ? 'Frontier included' : `${plan} plan`}
                </Badge>
                <button
                  onClick={() => void loadCredentials()}
                  className="p-1 rounded text-[var(--ff-text-dim)] hover:text-[var(--ff-text)] hover:bg-white/5 transition-colors"
                  title="Re-check connected keys"
                  aria-label="Re-check connected keys"
                  disabled={credentialLoading}
                >
                  <RefreshCw size={13} className={credentialLoading ? 'animate-spin' : ''} />
                </button>
              </div>
            </div>

            <p className="text-xs text-[var(--ff-text-muted)]">
              Auto routing sends planning, design, and the first code pass to the frontier model;
              edits, repairs, and chat use the fast model. Pro, Team, or your own OpenRouter key
              unlocks the frontier tier.
            </p>

            {(['openrouter', 'deepseek'] as const).map((provider) => {
              const entry = credentialStatus?.credentials[provider];
              const meta = PROVIDER_LABELS[provider];
              return (
                <div key={provider} className="rounded-lg border border-[var(--ff-border)]/60 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-[var(--ff-text)]">{meta.name}</p>
                      <p className="text-[11px] text-[var(--ff-text-dim)]">{meta.hint}</p>
                    </div>
                    <Badge variant={entry?.configured ? 'success' : 'info'}>
                      {entry?.configured ? 'Connected' : 'Not set'}
                    </Badge>
                  </div>
                  {entry?.configured && (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--ff-text-dim)] font-mono">
                      <span>{entry.masked}</span>
                      {entry.source && <span>· {entry.source}</span>}
                      <button
                        onClick={() => void handleRemoveKey(provider)}
                        className="text-[var(--ff-text-muted)] underline-offset-2 hover:text-[var(--ff-text)] hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <label className="sr-only" htmlFor={`key-${provider}`}>{meta.name} API key</label>
                    <input
                      id={`key-${provider}`}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      className="ff-input w-full px-3 py-2 text-xs font-mono"
                      placeholder={entry?.configured ? 'Replace key…' : meta.placeholder}
                      value={keyDrafts[provider]}
                      onChange={(event) => setKeyDrafts((current) => ({ ...current, [provider]: event.target.value }))}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!keyDrafts[provider].trim() || credentialLoading}
                      onClick={() => void handleSaveKey(provider)}
                    >
                      Save key
                    </Button>
                  </div>
                </div>
              );
            })}

            <p className="text-[11px] text-[var(--ff-text-dim)]">{storageLabel}</p>
            {credentialError && <p className="text-[11px] text-[var(--ff-danger)]">{credentialError}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
