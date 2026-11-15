import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/utils/cn';

/**
 * Dashboard-native dialog. The generic `Modal` is styled with the bold studio
 * tokens; on the neutral dashboard shell we want the same surface, border and
 * elevation as the sidebar popovers, so this keeps the shadcn-like palette.
 */
export function DashboardDialog({
  open,
  onClose,
  title,
  description,
  icon,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, open]);

  if (!open || typeof document === 'undefined') return null;

  const widths = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl' }[size];

  return createPortal(
    <div className="ff-dash-shell fixed inset-0 z-[60] flex items-end justify-center p-3 sm:items-center sm:p-6">
      <div
        aria-hidden
        className="absolute inset-0 bg-black/55 backdrop-blur-[3px] animate-in fade-in-0"
        onClick={onClose}
      />
      <div
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={cn(
          'relative flex max-h-[min(88dvh,780px)] w-full flex-col overflow-hidden rounded-2xl border border-[var(--fb-line)] bg-[var(--fb-elevated)] text-[var(--fb-ink)] shadow-[0_40px_120px_-32px_rgba(0,0,0,0.75)] outline-none animate-in fade-in-0 zoom-in-95',
          widths,
        )}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-[var(--fb-line)] px-5 py-4">
          {icon && (
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[var(--fb-line)] bg-[var(--fb-soft)] text-[var(--fb-muted)]">
              {icon}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold leading-tight" id={titleId}>
              {title}
            </h2>
            {description && (
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--fb-muted)]" id={descriptionId}>
                {description}
              </p>
            )}
          </div>
          <button
            aria-label="Close dialog"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--fb-dim)] transition-colors hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fb-ink)]/20"
            onClick={onClose}
            type="button"
          >
            <X size={16} />
          </button>
        </header>

        <div className="ff-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--fb-line)] bg-[var(--fb-soft)]/40 px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Shared form field styling for dashboard dialogs. */
export const dialogInputClass =
  'h-11 w-full rounded-xl border border-[var(--fb-line)] bg-[var(--fb-bg)] px-3 text-[13.5px] text-[var(--fb-ink)] outline-none transition-colors placeholder:text-[var(--fb-dim)] focus:border-[var(--fb-ink)]';

export function DialogField({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label
        className="block text-[12px] font-medium text-[var(--fb-muted)]"
        htmlFor={htmlFor}
      >
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-[var(--fb-dim)]">{hint}</p>}
    </div>
  );
}
