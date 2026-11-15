import { useEffect, useId, useState } from 'react';
import {
  CalendarDays,
  Check,
  Copy,
  KeyRound,
  LogOut,
  Mail,
  Save,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { toast } from '@/components/ui/Toast';
import { ProfileAvatar } from '../ProfileAvatar';
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

function validateAvatarUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Use an http(s) image URL.';
    return null;
  } catch {
    return 'Enter a valid image URL, or leave it blank.';
  }
}

function formatMemberSince(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function ProfileSection({ onSignOut }: { onSignOut: () => void }) {
  const { profile, updateProfile, resetPassword } = useAuthStore();
  const [fullName, setFullName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sendingReset, setSendingReset] = useState(false);
  const [copied, setCopied] = useState(false);
  const nameId = useId();
  const avatarId = useId();

  useEffect(() => {
    setFullName(profile?.full_name ?? '');
    setAvatarUrl(profile?.avatar_url ?? '');
    setError(null);
  }, [profile?.avatar_url, profile?.full_name]);

  const displayName = fullName.trim() || profile?.email?.split('@')[0] || 'Your account';
  const dirty = (profile?.full_name ?? '') !== fullName.trim() || (profile?.avatar_url ?? '') !== avatarUrl.trim();

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const avatarError = validateAvatarUrl(avatarUrl);
    if (avatarError) {
      setError(avatarError);
      return;
    }
    if (!fullName.trim()) {
      setError('Add a display name so teammates know who you are.');
      return;
    }

    setSaving(true);
    setError(null);
    const result = await updateProfile({
      full_name: fullName.trim(),
      avatar_url: avatarUrl.trim() || null,
    });
    setSaving(false);

    if (result.error) {
      setError(result.error);
      return;
    }
    toast('success', 'Profile updated');
  }

  async function handleResetPassword() {
    if (!profile?.email) return;
    setSendingReset(true);
    const result = await resetPassword(profile.email);
    setSendingReset(false);
    if (result.error) {
      toast('error', result.error);
      return;
    }
    toast('success', `Password reset link sent to ${profile.email}`);
  }

  async function copyUserId() {
    if (!profile?.id) return;
    try {
      await navigator.clipboard.writeText(profile.id);
      setCopied(true);
      toast('success', 'User ID copied');
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast('error', 'Could not copy the user ID.');
    }
  }

  return (
    <SectionBody>
      <SectionHeader
        actions={
          <>
            <button
              className={secondaryButtonClass}
              form="profile-form"
              onClick={() => {
                setFullName(profile?.full_name ?? '');
                setAvatarUrl(profile?.avatar_url ?? '');
                setError(null);
              }}
              type="reset"
            >
              Reset
            </button>
            <button className={primaryButtonClass} disabled={saving || !dirty} form="profile-form" type="submit">
              <Save size={14} />
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </>
        }
        description="This is how you appear across FlutterForge and shared projects. Your sign-in email stays locked."
        eyebrow="Account"
        title="Edit profile"
      />

      <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
        <Panel description="Shown in the sidebar, project cards and review links." title="Public profile">
          <form className="space-y-5 p-4 sm:p-5" id="profile-form" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-4 rounded-2xl border border-[var(--fb-line)] bg-[var(--fb-bg)]/40 p-4 sm:flex-row sm:items-center">
              <ProfileAvatar name={displayName} size="xl" url={avatarUrl.trim() || null} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold text-[var(--fb-ink)]">{displayName}</p>
                <p className="mt-0.5 truncate text-[12px] text-[var(--fb-muted)]">{profile?.email}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <StatusChip tone="neutral">{planLabel(profile?.plan)}</StatusChip>
                  <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--fb-dim)]">
                    Member since {formatMemberSince(profile?.created_at)}
                  </span>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-[12px] font-medium text-[var(--fb-muted)]" htmlFor={nameId}>
                Display name
              </label>
              <input
                autoComplete="name"
                className={fieldClass}
                id={nameId}
                maxLength={80}
                onChange={(event) => setFullName(event.target.value)}
                placeholder="Your name"
                value={fullName}
              />
              <p className="text-[11px] text-[var(--fb-dim)]">
                Used in greetings and shared project headers. {80 - fullName.length} characters left.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="block text-[12px] font-medium text-[var(--fb-muted)]" htmlFor={avatarId}>
                Avatar URL
              </label>
              <input
                className={fieldClass}
                id={avatarId}
                inputMode="url"
                onChange={(event) => setAvatarUrl(event.target.value)}
                placeholder="https://example.com/avatar.png"
                type="text"
                value={avatarUrl}
              />
              <p className="text-[11px] text-[var(--fb-dim)]">
                Paste an https image URL. Leave blank to use your initials.
              </p>
            </div>

            {error && (
              <p
                aria-live="polite"
                className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-500"
                role="alert"
              >
                {error}
              </p>
            )}

            <p className="flex items-center gap-1.5 text-[10.5px] text-[var(--fb-dim)]">
              <ShieldCheck aria-hidden size={13} />
              Changes are saved to your Supabase profile and synced to this device.
            </p>
          </form>
        </Panel>

        <div className="space-y-4">
          <Panel title="Account">
            <dl className="divide-y divide-[var(--fb-line)]">
              <div className="flex items-center gap-3 px-4 py-3">
                <Mail aria-hidden className="shrink-0 text-[var(--fb-dim)]" size={15} />
                <div className="min-w-0 flex-1">
                  <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--fb-dim)]">Email</dt>
                  <dd className="mt-0.5 truncate text-[12px] font-medium text-[var(--fb-ink)]">{profile?.email}</dd>
                </div>
                <StatusChip tone="neutral">Locked</StatusChip>
              </div>
              <div className="flex items-center gap-3 px-4 py-3">
                <UserRound aria-hidden className="shrink-0 text-[var(--fb-dim)]" size={15} />
                <div className="min-w-0 flex-1">
                  <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--fb-dim)]">User ID</dt>
                  <dd className="mt-0.5 truncate font-mono text-[11px] text-[var(--fb-muted)]">{profile?.id}</dd>
                </div>
                <button
                  aria-label="Copy user ID"
                  className="grid h-8 w-8 place-items-center rounded-lg text-[var(--fb-dim)] transition-colors hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)]"
                  onClick={() => void copyUserId()}
                  type="button"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
              <div className="flex items-center gap-3 px-4 py-3">
                <CalendarDays aria-hidden className="shrink-0 text-[var(--fb-dim)]" size={15} />
                <div className="min-w-0 flex-1">
                  <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--fb-dim)]">
                    Member since
                  </dt>
                  <dd className="mt-0.5 text-[12px] font-medium text-[var(--fb-ink)]">
                    {formatMemberSince(profile?.created_at)}
                  </dd>
                </div>
              </div>
            </dl>
            <p className="border-t border-[var(--fb-line)] px-4 py-3 text-[11px] leading-relaxed text-[var(--fb-dim)]">
              Sign-in email changes go through account recovery for security.
            </p>
          </Panel>

          <Panel description="Keep your account secure." title="Security">
            <div className="space-y-3 p-4">
              <button
                className="flex h-10 w-full items-center gap-2.5 rounded-xl border border-[var(--fb-line)] px-3 text-left text-[12px] font-medium text-[var(--fb-muted)] transition-colors hover:border-[var(--fb-ink)] hover:text-[var(--fb-ink)] disabled:opacity-50"
                disabled={sendingReset || !profile?.email}
                onClick={() => void handleResetPassword()}
                type="button"
              >
                <KeyRound aria-hidden size={15} />
                {sendingReset ? 'Sending reset link…' : 'Send password reset email'}
              </button>
              <button
                className="flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-left text-[12px] font-medium text-[var(--fb-muted)] transition-colors hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)]"
                onClick={onSignOut}
                type="button"
              >
                <LogOut aria-hidden size={15} />
                Sign out of this device
              </button>
            </div>
          </Panel>
        </div>
      </div>
    </SectionBody>
  );
}
