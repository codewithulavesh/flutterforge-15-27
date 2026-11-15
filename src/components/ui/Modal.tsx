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
}

export function Modal({ open, onClose, title, children, className, size = 'md' }: ModalProps) {
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        aria-label={title}
        aria-modal="true"
        className={cn(
          'relative ff-card w-full p-4 sm:p-5 ff-fade-in max-h-[92vh] sm:max-h-[90vh] overflow-y-auto ff-scrollbar',
          sizes[size],
          className
        )}
        role="dialog"
      >
        {title && (
          <div className="flex items-center justify-between mb-3 sm:mb-4 pb-2 border-b border-[var(--ff-border)]/50">
            <h2 className="text-base sm:text-lg font-semibold text-[var(--ff-text)] truncate pr-2">
              {title}
            </h2>
            <button
              aria-label="Close dialog"
              onClick={onClose}
              className="ff-btn-ghost flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--ff-text-muted)] transition-colors hover:text-[var(--ff-text)]"
              title="Close"
            >
              <X size={18} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
