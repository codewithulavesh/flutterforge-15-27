import { useEffect, useId, useState } from 'react';
import { Check, CreditCard, Database, KeyRound, Lock, Plug, Unplug } from 'lucide-react';
import { useSupabaseStore } from '@/stores/supabase.store';
import { useCredentialsStore, type CredentialProvider } from '@/stores/credentials.store';
import { useCreditsStore } from '@/stores/credits.store';
import { toast } from '@/components/ui/Toast';
import { planLabel } from '@/utils/profile';
import {
  Panel,
  SectionBody,
  SectionHeader,
  StatusChip,
  fieldClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './SectionShell';

const PROVIDERS: Array<{ id: CredentialProvider; name: string; hint: string; placeholder: string }> = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    hint: 'Frontier models for planning and first-pass code.',
    placeholder: 'sk-or-v1-…',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    hint: 'Fast model for edits, repairs and validation.',
    placeholder: 'sk-…',
  },
];

export function IntegrationsSection({ onOpenBilling }: { onOpenBilling: () => void }) {
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
  const { wallet, refresh } = useCreditsStore();

  const [ref, setRef] = useState('');
  const [pat, setPat] = useState('');
  const [drafts, setDrafts] = useState<Record<CredentialProvider, string>>({ openrouter: '', deepseek: '' });
  const [savingProvider, setSavingProvider] = useState<CredentialProvider | null>(null);
  const refId = useId();
  const patId = useId();

  useEffect(() => {
    setPat('');
    setDrafts({ openrouter: '', deepseek: '' });
    void loadCredentials();
    void refresh();
  }, [loadCredentials, refresh]);

  useEffect(() => {
    if (projectRef) setRef(projectRef);
  }, [projectRef]);

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

  const configuredCount = PROVIDERS.filter(
    (provider) => credentialStatus?.credentials[provider.id].configured,
  ).length;

  return (
    <SectionBody>
      <SectionHeader
        actions={
          <button className={secondaryButtonClass} onClick={onOpenBilling} type="button">
            <CreditCard size={14} />
            Plan &amp; billing
          </button>
        }
        description="Connect the services FlutterForge uses to generate, preview and publish your apps. Credentials stay on this device."
        eyebrow="Workspace"
        title="Integrations"
      />

      <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
        <div className="space-y-4">
          <Panel
            actions={
              <StatusChip tone={supabaseConnected ? 'live' : 'neutral'}>
                {supabaseConnected ? (
                  <>
                    <Check aria-hidden size={10} /> Connected
                  </>
                ) : (
                  'Not connected'
                )}
              </StatusChip>
            }
            description="Database, auth and storage for generated apps."
            title="Supabase"
          >
            <div className="p-4 sm:p-5">
              {supabaseConnected ? (
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-[var(--fb-ink)]">{projectName || projectRef}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-[var(--fb-dim)]">ref · {projectRef}</p>
                    <p className="mt-2 text-[11.5px] text-[var(--fb-muted)]">
                      Migrations run against this project from your local engine.
                    </p>
                  </div>
                  <button
                    className="inline-flex h-9 items-center gap-1.5 rounded-full border border-[var(--fb-line)] px-3.5 text-[11.5px] font-medium text-[var(--fb-muted)] transition-colors hover:border-red-500/40 hover:text-red-500"
                    onClick={handleDisconnect}
                    type="button"
                  >
                    <Unplug size={14} />
                    Disconnect
                  </button>
                </div>
              ) : (
                <form className="space-y-4" onSubmit={handleConnect}>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <label className="block text-[12px] font-medium text-[var(--fb-muted)]" htmlFor={refId}>
                        Project ref
                      </label>
                      <input
                        autoComplete="off"
                        className={fieldClass}
                        id={refId}
                        onChange={(event) => setRef(event.target.value)}
                        placeholder="abcdefghijklmnop"
                        spellCheck={false}
                        value={ref}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-[12px] font-medium text-[var(--fb-muted)]" htmlFor={patId}>
                        Personal access token
                      </label>
                      <input
                        autoComplete="off"
                        className={fieldClass}
                        id={patId}
                        onChange={(event) => setPat(event.target.value)}
                        placeholder="sbp_…"
                        type="password"
                        value={pat}
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="max-w-sm text-[11px] leading-relaxed text-[var(--fb-dim)]">
                      Create a token at supabase.com/dashboard/account/tokens. It is stored on this device only
                      and sent to your local engine for verification.
                    </p>
                    <button className={primaryButtonClass} disabled={connecting} type="submit">
                      <Plug size={14} />
                      {connecting ? 'Connecting…' : 'Connect Supabase'}
                    </button>
                  </div>
                  {supabaseError && (
                    <p aria-live="polite" className="text-[11.5px] text-red-500">
                      {supabaseError}
                    </p>
                  )}
                </form>
              )}
            </div>
          </Panel>

          <Panel
            actions={
              <StatusChip tone={configuredCount > 0 ? 'live' : 'neutral'}>
                {configuredCount} of {PROVIDERS.length} connected
              </StatusChip>
            }
            description="Bring your own keys, or use the credits included with Pro."
            title="AI model keys"
          >
            <div className="divide-y divide-[var(--fb-line)]">
              {PROVIDERS.map((provider) => {
                const state = credentialStatus?.credentials[provider.id];
                const configured = Boolean(state?.configured);
                const draft = drafts[provider.id];
                return (
                  <div className="p-4 sm:p-5" key={provider.id}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-[12.5px] font-semibold text-[var(--fb-ink)]">{provider.name}</p>
                        <p className="text-[11px] text-[var(--fb-dim)]">{provider.hint}</p>
                      </div>
                      <StatusChip tone={configured ? 'live' : 'neutral'}>
                        {configured ? (
                          <>
                            <Check aria-hidden size={10} />
                            {state?.masked ?? 'Connected'}
                          </>
                        ) : (
                          'Not connected'
                        )}
                      </StatusChip>
                    </div>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <input
                        aria-label={`${provider.name} API key`}
                        autoComplete="off"
                        className={fieldClass}
                        onChange={(event) =>
                          setDrafts((current) => ({ ...current, [provider.id]: event.target.value }))
                        }
                        placeholder={provider.placeholder}
                        type="password"
                        value={draft}
                      />
                      <button
                        className="h-11 shrink-0 rounded-xl border border-[var(--fb-line)] px-4 text-[12px] font-medium text-[var(--fb-muted)] transition-colors hover:border-[var(--fb-ink)] hover:text-[var(--fb-ink)] disabled:opacity-40"
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
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel description="How keys are handled on this device." title="Credential storage">
            <div className="space-y-3 p-4 sm:p-5">
              <span className="grid h-10 w-10 place-items-center rounded-xl border border-[var(--fb-line)] bg-[var(--fb-soft)] text-[var(--fb-muted)]">
                <Lock size={17} />
              </span>
              <p className="text-[12px] leading-relaxed text-[var(--fb-muted)]">
                {credentialsLoading
                  ? 'Checking saved keys…'
                  : credentialStatus?.storage === 'os-encrypted'
                    ? 'Keys are encrypted by the operating system and never leave this machine.'
                    : 'Keys stay in this browser session. Install the desktop app for OS-encrypted storage.'}
              </p>
              <p className="text-[11px] leading-relaxed text-[var(--fb-dim)]">
                Model keys are only used by your local engine to call the provider you chose. FlutterForge never
                proxies them through its own servers.
              </p>
              {credentialsError && <p className="text-[11px] text-red-500">{credentialsError}</p>}
            </div>
          </Panel>

          <Panel description="Subscriptions and credit top-ups." title="Billing">
            <div className="space-y-4 p-4 sm:p-5">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--fb-lime)] text-black">
                  <CreditCard size={17} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-semibold">{planLabel(wallet?.plan)}</p>
                  <p className="text-[11px] text-[var(--fb-dim)]">
                    {wallet ? `${wallet.balance.toLocaleString()} credits available` : 'Checking credits…'}
                  </p>
                </div>
              </div>
              <p className="text-[11.5px] leading-relaxed text-[var(--fb-muted)]">
                Payments are processed by Razorpay in INR. Card details never touch FlutterForge servers.
              </p>
              <button
                className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-full border border-[var(--fb-line)] text-[11.5px] font-medium text-[var(--fb-muted)] transition-colors hover:border-[var(--fb-ink)] hover:text-[var(--fb-ink)]"
                onClick={onOpenBilling}
                type="button"
              >
                <CreditCard size={13} />
                Manage plan &amp; billing
              </button>
            </div>
          </Panel>

          <Panel description="What each connection unlocks." title="Setup checklist">
            <ul className="divide-y divide-[var(--fb-line)]">
              <li className="flex items-center gap-3 px-4 py-3 text-[12px]">
                <Database aria-hidden className="shrink-0 text-[var(--fb-dim)]" size={15} />
                <span className="min-w-0 flex-1 text-[var(--fb-muted)]">Supabase migrations & auth</span>
                <StatusChip tone={supabaseConnected ? 'live' : 'neutral'}>
                  {supabaseConnected ? 'Ready' : 'Optional'}
                </StatusChip>
              </li>
              <li className="flex items-center gap-3 px-4 py-3 text-[12px]">
                <KeyRound aria-hidden className="shrink-0 text-[var(--fb-dim)]" size={15} />
                <span className="min-w-0 flex-1 text-[var(--fb-muted)]">Model keys for generation</span>
                <StatusChip tone={configuredCount > 0 ? 'live' : 'warn'}>
                  {configuredCount > 0 ? 'Ready' : 'Needed'}
                </StatusChip>
              </li>
            </ul>
          </Panel>
        </div>
      </div>
    </SectionBody>
  );
}
