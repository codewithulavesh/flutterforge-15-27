import { useEffect, useId, useState } from 'react';
import { Check, Database, KeyRound, Plug, Unplug } from 'lucide-react';
import { DashboardDialog, DialogField, dialogInputClass } from './DashboardDialog';
import { useSupabaseStore } from '@/stores/supabase.store';
import { useCredentialsStore, type CredentialProvider } from '@/stores/credentials.store';
import { toast } from '@/components/ui/Toast';

const PROVIDERS: Array<{ id: CredentialProvider; name: string; hint: string; placeholder: string }> = [
  { id: 'openrouter', name: 'OpenRouter', hint: 'Frontier models for planning and first-pass code.', placeholder: 'sk-or-v1-…' },
  { id: 'deepseek', name: 'DeepSeek', hint: 'Fast model for edits, repairs and validation.', placeholder: 'sk-…' },
];

function StatusChip({ connected, label }: { connected: boolean; label?: string }) {
  return (
    <span
      className={
        connected
          ? 'inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-emerald-500'
          : 'inline-flex items-center gap-1 rounded-full border border-[var(--fb-line)] px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--fb-dim)]'
      }
    >
      {connected && <Check aria-hidden size={10} />}
      {label ?? (connected ? 'Connected' : 'Not connected')}
    </span>
  );
}

export function IntegrationsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    connected: supabaseConnected,
    connecting,
    lastError: supabaseError,
    projectName,
    projectRef,
    save: connectSupabase,
    disconnect: disconnectSupabase,
  } = useSupabaseStore();
  const {
    status: credentialStatus,
    loading: credentialsLoading,
    error: credentialsError,
    load: loadCredentials,
    saveKey,
    removeKey,
  } = useCredentialsStore();

  const [ref, setRef] = useState('');
  const [pat, setPat] = useState('');
  const [drafts, setDrafts] = useState<Record<CredentialProvider, string>>({ openrouter: '', deepseek: '' });
  const [savingProvider, setSavingProvider] = useState<CredentialProvider | null>(null);
  const refId = useId();
  const patId = useId();

  useEffect(() => {
    if (!open) return;
    setPat('');
    setDrafts({ openrouter: '', deepseek: '' });
    void loadCredentials();
  }, [loadCredentials, open]);

  useEffect(() => {
    if (open && projectRef) setRef(projectRef);
  }, [open, projectRef]);

  async function handleConnect(event: React.FormEvent) {
    event.preventDefault();
    if (!ref.trim() || !pat.trim()) {
      toast('error', 'Project ref and personal access token are required.');
      return;
    }
    const saved = await connectSupabase(ref.trim(), pat.trim());
    if (saved) {
      setPat('');
      toast('success', 'Supabase connected');
    }
  }

  function handleDisconnect() {
    if (!window.confirm('Disconnect this Supabase project? Stored credentials are removed from this device.')) {
      return;
    }
    disconnectSupabase();
    setPat('');
    toast('success', 'Supabase disconnected');
  }

  async function handleSaveKey(provider: CredentialProvider) {
    const value = drafts[provider].trim();
    if (!value) return;
    setSavingProvider(provider);
    const saved = await saveKey(provider, value);
    setSavingProvider(null);
    if (saved) {
      setDrafts((current) => ({ ...current, [provider]: '' }));
      toast('success', `${provider === 'openrouter' ? 'OpenRouter' : 'DeepSeek'} key saved`);
    } else {
      toast('error', useCredentialsStore.getState().error ?? 'Could not save the key.');
    }
  }

  async function handleRemoveKey(provider: CredentialProvider) {
    const removed = await removeKey(provider);
    if (removed) toast('success', 'Key removed');
    else toast('error', useCredentialsStore.getState().error ?? 'Could not remove the key.');
  }

  return (
    <DashboardDialog
      description="Connect the services FlutterForge uses to generate, preview and publish your apps."
      footer={
        <button
          className="h-9 rounded-lg bg-[var(--fb-ink)] px-4 text-[12.5px] font-semibold text-[var(--fb-bg)]"
          onClick={onClose}
          type="button"
        >
          Done
        </button>
      }
      icon={<Plug size={18} />}
      onClose={onClose}
      open={open}
      size="lg"
      title="Integrations"
    >
      <div className="space-y-4">
        <section className="overflow-hidden rounded-2xl border border-[var(--fb-line)]">
          <div className="flex items-center gap-3 border-b border-[var(--fb-line)] bg-[var(--fb-soft)]/60 px-4 py-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[var(--fb-line)] bg-[var(--fb-bg)] text-[var(--fb-muted)]">
              <Database size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold">Supabase</p>
              <p className="truncate text-[11px] text-[var(--fb-dim)]">
                {supabaseConnected ? projectName || projectRef : 'Database, auth and storage for generated apps'}
              </p>
            </div>
            <StatusChip connected={supabaseConnected} />
          </div>

          <div className="p-4">
            {supabaseConnected ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[12px] text-[var(--fb-muted)]">
                    Project ref <span className="font-mono text-[11px] text-[var(--fb-ink)]">{projectRef}</span>
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--fb-dim)]">
                    Migrations run against this project from your local engine.
                  </p>
                </div>
                <button
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--fb-line)] px-3 text-[12px] font-medium text-[var(--fb-muted)] transition-colors hover:border-red-500/40 hover:text-red-500"
                  onClick={handleDisconnect}
                  type="button"
                >
                  <Unplug size={14} />
                  Disconnect
                </button>
              </div>
            ) : (
              <form className="space-y-3" onSubmit={handleConnect}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <DialogField htmlFor={refId} label="Project ref">
                    <input
                      autoComplete="off"
                      className={dialogInputClass}
                      id={refId}
                      onChange={(event) => setRef(event.target.value)}
                      placeholder="abcdefghijklmnop"
                      spellCheck={false}
                      value={ref}
                    />
                  </DialogField>
                  <DialogField htmlFor={patId} label="Personal access token">
                    <input
                      autoComplete="off"
                      className={dialogInputClass}
                      id={patId}
                      onChange={(event) => setPat(event.target.value)}
                      placeholder="sbp_…"
                      type="password"
                      value={pat}
                    />
                  </DialogField>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] text-[var(--fb-dim)]">
                    Stored on this device only; sent to your local engine for verification.
                  </p>
                  <button
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--fb-ink)] px-3.5 text-[12px] font-semibold text-[var(--fb-bg)] disabled:opacity-50"
                    disabled={connecting}
                    type="submit"
                  >
                    <Plug size={14} />
                    {connecting ? 'Connecting…' : 'Connect Supabase'}
                  </button>
                </div>
                {supabaseError && <p className="text-[11.5px] text-red-500">{supabaseError}</p>}
              </form>
            )}
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-[var(--fb-line)]">
          <div className="flex items-center gap-3 border-b border-[var(--fb-line)] bg-[var(--fb-soft)]/60 px-4 py-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[var(--fb-line)] bg-[var(--fb-bg)] text-[var(--fb-muted)]">
              <KeyRound size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold">AI model keys</p>
              <p className="text-[11px] text-[var(--fb-dim)]">Bring your own keys, or use the keys included with Pro.</p>
            </div>
          </div>

          <div className="divide-y divide-[var(--fb-line)]">
            {PROVIDERS.map((provider) => {
              const state = credentialStatus?.credentials[provider.id];
              const configured = Boolean(state?.configured);
              const draft = drafts[provider.id];
              return (
                <div className="p-4" key={provider.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-[12.5px] font-semibold">{provider.name}</p>
                      <p className="text-[11px] text-[var(--fb-dim)]">{provider.hint}</p>
                    </div>
                    <StatusChip connected={configured} label={configured ? `Connected · ${state?.masked ?? ''}` : undefined} />
                  </div>
                  <div className="mt-2.5 flex gap-2">
                    <input
                      aria-label={`${provider.name} API key`}
                      autoComplete="off"
                      className={dialogInputClass}
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [provider.id]: event.target.value }))
                      }
                      placeholder={provider.placeholder}
                      type="password"
                      value={draft}
                    />
                    <button
                      className="h-11 shrink-0 rounded-xl border border-[var(--fb-line)] px-3 text-[12px] font-medium text-[var(--fb-muted)] transition-colors hover:border-[var(--fb-ink)] hover:text-[var(--fb-ink)] disabled:opacity-40"
                      disabled={!draft.trim() || savingProvider === provider.id}
                      onClick={() => void handleSaveKey(provider.id)}
                      type="button"
                    >
                      {savingProvider === provider.id ? 'Saving…' : configured ? 'Replace' : 'Save'}
                    </button>
                    {configured && (
                      <button
                        className="h-11 shrink-0 rounded-xl px-2.5 text-[12px] font-medium text-[var(--fb-dim)] transition-colors hover:text-red-500"
                        onClick={() => void handleRemoveKey(provider.id)}
                        type="button"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <p className="text-[11px] leading-relaxed text-[var(--fb-dim)]">
          {credentialsLoading
            ? 'Checking saved keys…'
            : credentialStatus?.storage === 'os-encrypted'
              ? 'Keys are encrypted by the operating system and never leave this machine.'
              : 'Keys stay on this device. Install the desktop app for OS-encrypted storage.'}
          {credentialsError ? ` ${credentialsError}` : ''}
        </p>
      </div>
    </DashboardDialog>
  );
}
