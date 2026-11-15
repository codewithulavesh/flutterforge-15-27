import { useEffect, useId, useState } from 'react';
import { Mail, Save, UserRound } from 'lucide-react';
import { DashboardDialog, DialogField, dialogInputClass } from './DashboardDialog';
import { ProfileAvatar } from './ProfileAvatar';
import { useAuthStore } from '@/stores/auth.store';
import { toast } from '@/components/ui/Toast';
import { planLabel } from '@/utils/profile';
import { cn } from '@/utils/cn';

function validateAvatarUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return 'Use an http(s) image URL.';
    }
    return null;
  } catch {
    return 'Enter a valid image URL, or leave it blank.';
  }
}

export function EditProfileModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { profile, updateProfile } = useAuthStore();
  const [fullName, setFullName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameId = useId();
  const avatarId = useId();

  useEffect(() => {
    if (!open) return;
    setFullName(profile?.full_name ?? '');
    setAvatarUrl(profile?.avatar_url ?? '');
    setError(null);
    setSaving(false);
  }, [open, profile?.avatar_url, profile?.full_name]);

  const displayName = fullName.trim() || profile?.email?.split('@')[0] || 'Your account';

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
    onClose();
  }

  return (
    <DashboardDialog
      description="This is how you appear across FlutterForge and shared projects."
      footer={
        <>
          <button
            className="h-9 rounded-lg px-3 text-[12.5px] font-medium text-[var(--fb-muted)] transition-colors hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)]"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--fb-ink)] px-4 text-[12.5px] font-semibold text-[var(--fb-bg)] transition-transform hover:-translate-y-px disabled:opacity-50"
            disabled={saving}
            form="edit-profile-form"
            type="submit"
          >
            <Save size={14} />
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }
      icon={<UserRound size={18} />}
      onClose={onClose}
      open={open}
      title="Edit profile"
    >
      <form className="space-y-5" id="edit-profile-form" onSubmit={handleSubmit}>
        <div className="flex items-center gap-4 rounded-2xl border border-[var(--fb-line)] bg-[var(--fb-soft)]/60 p-4">
          <ProfileAvatar name={displayName} size="xl" url={avatarUrl.trim() || null} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-semibold text-[var(--fb-ink)]">{displayName}</p>
            <p className="mt-0.5 truncate text-[12px] text-[var(--fb-muted)]">{profile?.email}</p>
            <span className="mt-2 inline-flex items-center rounded-full border border-[var(--fb-line)] bg-[var(--fb-bg)] px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--fb-muted)]">
              {planLabel(profile?.plan)}
            </span>
          </div>
        </div>

        <DialogField htmlFor={nameId} label="Display name">
          <input
            autoComplete="name"
            className={dialogInputClass}
            id={nameId}
            maxLength={80}
            onChange={(event) => setFullName(event.target.value)}
            placeholder="Your name"
            value={fullName}
          />
        </DialogField>

        <DialogField
          hint="Paste an https image URL. Leave blank to use your initials."
          htmlFor={avatarId}
          label="Avatar URL"
        >
          <input
            className={dialogInputClass}
            id={avatarId}
            inputMode="url"
            onChange={(event) => setAvatarUrl(event.target.value)}
            placeholder="https://example.com/avatar.png"
            type="text"
            value={avatarUrl}
          />
        </DialogField>

        <div className="space-y-1.5">
          <span className="block text-[12px] font-medium text-[var(--fb-muted)]">Email</span>
          <div className="flex h-11 items-center gap-2 rounded-xl border border-[var(--fb-line)] bg-[var(--fb-soft)] px-3 text-[13.5px] text-[var(--fb-dim)]">
            <Mail aria-hidden size={15} />
            <span className="truncate">{profile?.email}</span>
            <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-[0.1em]">
              Locked
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-[var(--fb-dim)]">
            Sign-in email changes go through account recovery for security.
          </p>
        </div>

        {error && (
          <p
            aria-live="polite"
            className={cn(
              'rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-500',
            )}
            role="alert"
          >
            {error}
          </p>
        )}
      </form>
    </DashboardDialog>
  );
}
