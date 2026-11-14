import type { CSSProperties } from 'react';
import { cn } from '@/utils/cn';

/**
 * Loading skeleton — one token-consistent primitive for the workspace.
 * Rendered while real content (editor shards, the Flutter web engine,
 * project history) streams in. Animate-pulse is token-driven, so it
 * adapts to light and dark without extra styling.
 */
export function Skeleton({
  className,
  style,
  rounded = 'lg',
}: {
  className?: string;
  style?: CSSProperties;
  rounded?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
}) {
  const radius = {
    sm: 'rounded-md',
    md: 'rounded-lg',
    lg: 'rounded-xl',
    xl: 'rounded-2xl',
    '2xl': 'rounded-[22px]',
    full: 'rounded-full',
  }[rounded];
  return <div aria-hidden="true" style={style} className={cn('animate-pulse bg-[var(--fb-soft)]', radius, className)} />;
}

/** A block of skeleton lines with mixed widths (editor-like shimmer). */
export function SkeletonLines({ count = 8, className }: { count?: number; className?: string }) {
  const widths = ['82%', '64%', '74%', '48%', '88%', '58%', '70%', '40%', '78%', '52%'];
  return (
    <div aria-hidden="true" className={cn('flex flex-col gap-[11px]', className)}>
      {Array.from({ length: count }).map((_, index) => (
        <Skeleton
          key={index}
          rounded="full"
          style={{ width: widths[index % widths.length] }}
          className="h-[9px]"
        />
      ))}
    </div>
  );
}
