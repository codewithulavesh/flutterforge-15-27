import { cn } from '@/utils/cn';

export function initialsOf(name?: string | null): string {
  const source = (name || '?').trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

/**
 * The signed-in user's avatar, with an initials fallback. Used by the sidebar
 * footer, the account menu and the edit-profile dialog so all three stay in
 * sync after a profile save.
 */
export function ProfileAvatar({
  url,
  name,
  size = 'md',
  className,
}: {
  url?: string | null;
  name?: string | null;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const dimension = {
    sm: 'h-8 w-8 text-[9px]',
    md: 'h-9 w-9 text-[10px]',
    lg: 'h-10 w-10 text-[11px]',
    xl: 'h-16 w-16 text-[17px]',
  }[size];

  if (url) {
    return (
      <img
        alt=""
        className={cn('shrink-0 rounded-full border border-[var(--fb-line)] object-cover', dimension, className)}
        src={url}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-full border border-[var(--fb-line)] bg-[var(--fb-soft)] font-mono font-semibold text-[var(--fb-ink)]',
        dimension,
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
