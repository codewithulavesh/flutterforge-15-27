import { type ReactNode, useEffect } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/utils/cn';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'default' | 'metallic';
}

export function Modal({
  open,
  onClose,
  title,
  children,
  className,
  size = 'md',
  variant = 'default',
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, open]);

  if (!open) return null;

  const sizes = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  };

  const isMetallic = variant === 'metallic';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <div
        className={cn(
          'absolute inset-0',
          isMetallic ? 'bg-black/75 backdrop-blur-md' : 'bg-black/60 backdrop-blur-sm',
        )}
        onClick={onClose}
      />
      <div
        aria-label={title}
        aria-modal="true"
        className={cn(
          'relative w-full ff-fade-in max-h-[92vh] sm:max-h-[90vh] overflow-y-auto ff-scrollbar',
          isMetallic
            ? 'rounded-[28px] border border-[rgba(248,255,248,0.14)] bg-[#00101e] shadow-[0_32px_90px_-20px_rgba(0,16,30,0.85)] text-[#f8fff8] p-5 sm:p-6'
            : 'ff-card p-4 sm:p-5',
          sizes[size],
          className,
        )}
        style={
          isMetallic
            ? {
                backgroundImage:
                  'linear-gradient(124deg, #00101e 8%, #1f3747 19%, #00101e 30%, #00101e 75%, #1f3747 88%, #00101e 100%)',
              }
            : undefined
        }
        role="dialog"
      >
        {title && (
          <div
            className={cn(
              'flex items-center justify-between mb-4 pb-3',
              isMetallic
                ? 'border-b border-[rgba(248,255,248,0.12)]'
                : 'border-b border-[var(--ff-border)]/50',
            )}
          >
            <h2
              className={cn(
                'truncate pr-2',
                isMetallic
                  ? 'ffb-display text-[18px] sm:text-[20px] font-bold text-[#f8fff8] tracking-[-0.035em] uppercase'
                  : 'text-base sm:text-lg font-semibold text-[var(--ff-text)]',
              )}
            >
              {title}
            </h2>
            <button
              aria-label="Close dialog"
              onClick={onClose}
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all',
                isMetallic
                  ? 'border border-[rgba(248,255,248,0.14)] bg-white/5 text-[rgba(248,255,248,0.7)] hover:bg-white/10 hover:text-white hover:border-[rgba(248,255,248,0.3)]'
                  : 'ff-btn-ghost text-[var(--ff-text-muted)] hover:text-[var(--ff-text)]',
              )}
              title="Close"
            >
              <X size={16} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
