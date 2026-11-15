'use client';

import * as React from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/utils/cn';

/**
 * FlutterForge's sidebar primitive.
 *
 * The API mirrors the shadcn sidebar vocabulary — Provider / Sidebar / Header /
 * Content / Group / Menu / Rail / Trigger / useSidebar — so composition stays
 * familiar, but it is implemented against the app's own `--fb-*` tokens instead
 * of shadcn's `--sidebar-*` variables. That keeps the dashboard's bold/neutral
 * palette intact and avoids pulling a second design system into the bundle.
 */

const SIDEBAR_WIDTH = '16.5rem';
const SIDEBAR_WIDTH_MOBILE = '18rem';
const SIDEBAR_WIDTH_ICON = '3.5rem';
const SIDEBAR_KEYBOARD_SHORTCUT = 'b';
const SIDEBAR_STORAGE_KEY = 'ff-sidebar-open';

type SidebarState = 'expanded' | 'collapsed';
type SidebarCollapsible = 'offcanvas' | 'icon' | 'none';

type SidebarContextValue = {
  state: SidebarState;
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
  collapsible: SidebarCollapsible;
  width: string;
  widthMobile: string;
  widthIcon: string;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

export function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.');
  }
  return context;
}

function readInitialOpen(storageKey: string, defaultOpen: boolean | undefined) {
  if (typeof window === 'undefined') return defaultOpen ?? true;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
  } catch {
    // Storage can be blocked in private windows; fall through to the default.
  }
  if (defaultOpen !== undefined) return defaultOpen;
  return window.innerWidth >= 900;
}

export function SidebarProvider({
  children,
  defaultOpen,
  open: openProp,
  onOpenChange,
  persist = true,
  storageKey = SIDEBAR_STORAGE_KEY,
  keyboardShortcut = true,
  collapsible = 'icon',
  width = SIDEBAR_WIDTH,
  widthMobile = SIDEBAR_WIDTH_MOBILE,
  widthIcon = SIDEBAR_WIDTH_ICON,
}: {
  children: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  persist?: boolean;
  storageKey?: string;
  keyboardShortcut?: boolean;
  collapsible?: SidebarCollapsible;
  width?: string;
  widthMobile?: string;
  widthIcon?: string;
}) {
  const isMobile = useIsMobile();
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(() =>
    readInitialOpen(storageKey, defaultOpen),
  );
  const [openMobile, setOpenMobile] = React.useState(false);

  const open = openProp ?? uncontrolledOpen;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (openProp === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange, openProp],
  );

  const toggleSidebar = React.useCallback(() => {
    if (isMobile) setOpenMobile((current) => !current);
    else setOpen(!open);
  }, [isMobile, open, setOpen]);

  // Persist only the uncontrolled desktop rail. The mobile drawer is transient.
  React.useEffect(() => {
    if (!persist || openProp !== undefined) return;
    try {
      window.localStorage.setItem(storageKey, String(uncontrolledOpen));
    } catch {
      // Storage is optional.
    }
  }, [openProp, persist, storageKey, uncontrolledOpen]);

  // ⌘B / Ctrl+B mirrors the shadcn shortcut. Don't steal it while typing.
  React.useEffect(() => {
    if (!keyboardShortcut) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== SIDEBAR_KEYBOARD_SHORTCUT) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      toggleSidebar();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [keyboardShortcut, toggleSidebar]);

  // The mobile drawer owns the viewport while open.
  React.useEffect(() => {
    if (!openMobile) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpenMobile(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openMobile]);

  const state: SidebarState = open ? 'expanded' : 'collapsed';

  const context = React.useMemo<SidebarContextValue>(
    () => ({
      state,
      open,
      setOpen,
      openMobile,
      setOpenMobile,
      isMobile,
      toggleSidebar,
      collapsible,
      width,
      widthMobile,
      widthIcon,
    }),
    [state, open, setOpen, openMobile, isMobile, toggleSidebar, collapsible, width, widthMobile, widthIcon],
  );

  return <SidebarContext.Provider value={context}>{children}</SidebarContext.Provider>;
}

export function Sidebar({
  side = 'left',
  variant = 'sidebar',
  className,
  children,
  ...props
}: Omit<React.ComponentProps<'aside'>, 'collapsible'> & {
  side?: 'left' | 'right';
  variant?: 'sidebar' | 'floating' | 'inset';
}) {
  const { isMobile, state, openMobile, setOpenMobile, width, widthMobile, widthIcon, collapsible } =
    useSidebar();

  if (isMobile) {
    if (!openMobile) return null;
    return (
      <>
        <div
          aria-hidden
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] animate-in fade-in-0 min-[900px]:hidden"
          onClick={() => setOpenMobile(false)}
        />
        <aside
          aria-label="Navigation"
          aria-modal="true"
          className={cn(
            'fixed inset-y-0 z-50 flex flex-col border-[var(--fb-line)] bg-[var(--fb-card)] text-[var(--fb-ink)] shadow-[0_32px_90px_-24px_rgba(0,0,0,0.8)] animate-in slide-in-from-left duration-200 min-[900px]:hidden',
            side === 'left' ? 'left-0 border-r' : 'right-0 border-l',
            className,
          )}
          data-mobile="true"
          data-state="expanded"
          role="dialog"
          style={{ width: widthMobile }}
          {...props}
        >
          {children}
        </aside>
      </>
    );
  }

  const collapsed = collapsible !== 'none' && state === 'collapsed';
  const desktopWidth = collapsed ? widthIcon : width;

  return (
    <aside
      data-collapsible={collapsed ? 'icon' : ''}
      data-side={side}
      data-state={state}
      data-variant={variant}
      className={cn(
        'group/sidebar relative z-20 flex h-full shrink-0 flex-col border-[var(--fb-line)] bg-[var(--fb-card)] text-[var(--fb-ink)] transition-[width] duration-200 ease-out',
        side === 'left' ? 'border-r' : 'order-last border-l',
        variant === 'floating' && 'm-2 rounded-xl border',
        variant === 'inset' && 'bg-transparent',
        collapsed && 'overflow-hidden',
        className,
      )}
      style={{ width: desktopWidth }}
      {...props}
    >
      {children}
    </aside>
  );
}

export function SidebarInset({ className, ...props }: React.ComponentProps<'main'>) {
  return (
    <main
      className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--fb-bg)]', className)}
      {...props}
    />
  );
}

export function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex w-full shrink-0 flex-col', className)}
      data-sidebar="header"
      {...props}
    />
  );
}

export function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex w-full shrink-0 flex-col', className)}
      data-sidebar="footer"
      {...props}
    />
  );
}

export function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'ff-scrollbar flex min-h-0 w-full flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-3 py-3',
        className,
      )}
      data-sidebar="content"
      {...props}
    />
  );
}

export function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('relative flex w-full min-w-0 flex-col', className)}
      data-sidebar="group"
      {...props}
    />
  );
}

export function SidebarGroupLabel({ className, ...props }: React.ComponentProps<'div'>) {
  const { state, collapsible, isMobile } = useSidebar();
  const collapsed = !isMobile && collapsible !== 'none' && state === 'collapsed';
  if (collapsed) {
    return <div aria-hidden className="mx-2 my-1.5 h-px bg-[var(--fb-line)]" />;
  }
  return (
    <div
      className={cn('px-2.5 pb-1.5 pt-6 text-[12px] font-medium text-[var(--fb-dim)]', className)}
      data-sidebar="group-label"
      {...props}
    />
  );
}

export function SidebarGroupContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex w-full min-w-0 flex-col gap-0.5', className)}
      data-sidebar="group-content"
      {...props}
    />
  );
}

export function SidebarGroupAction({ className, ...props }: React.ComponentProps<'button'>) {
  return (
    <button
      className={cn(
        'absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-[var(--fb-dim)] transition-colors hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)]',
        className,
      )}
      data-sidebar="group-action"
      type="button"
      {...props}
    />
  );
}

export function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      className={cn('flex w-full min-w-0 flex-col gap-0.5', className)}
      data-sidebar="menu"
      {...props}
    />
  );
}

export function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      className={cn('group/menu-item relative min-w-0', className)}
      data-sidebar="menu-item"
      {...props}
    />
  );
}

type SidebarMenuButtonProps = React.ComponentPropsWithoutRef<'button'> & {
  isActive?: boolean;
  size?: 'default' | 'sm' | 'lg';
  /** Render as another element (e.g. a react-router Link). */
  render?: React.ReactElement<Record<string, unknown>>;
};

/**
 * Collapsed rails keep only the leading icon. Labels are plain spans so they
 * can be hidden without knowing the icon implementation; keep any trailing
 * badge inside a span as well.
 */
export const SidebarMenuButton = React.forwardRef<HTMLButtonElement, SidebarMenuButtonProps>(
  function SidebarMenuButton(
    { className, isActive, size = 'default', render, children, ...props },
    ref,
  ) {
    const { state, collapsible, isMobile } = useSidebar();
    const collapsed = !isMobile && collapsible !== 'none' && state === 'collapsed';

    const classes = cn(
      'group/menu-button relative flex w-full items-center gap-2.5 overflow-hidden rounded-lg text-left font-medium outline-none transition-[background-color,color] duration-150',
      'focus-visible:ring-2 focus-visible:ring-[var(--fb-ink)]/20',
      size === 'default' && 'h-10 px-2.5 text-[13.5px]',
      size === 'sm' && 'h-8 px-2 text-[12.5px]',
      size === 'lg' && 'h-11 px-3 text-[14px]',
      isActive
        ? 'bg-[var(--fb-soft)] text-[var(--fb-ink)]'
        : 'text-[var(--fb-muted)] hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)]',
      collapsed &&
        'mx-auto size-10 shrink-0 justify-center px-0 [&>span]:hidden [&>svg]:mx-0',
      className,
    );

    const shared = {
      'aria-current': isActive ? ('page' as const) : undefined,
      'data-active': isActive ? 'true' : undefined,
      'data-size': size,
      className: classes,
    };

    if (render) {
      const child = render;
      const mergedProps = {
        ...props,
        ...shared,
        className: cn(classes, (child.props as { className?: string }).className),
      } as unknown as Partial<Record<string, unknown>> & React.Attributes;
      return React.cloneElement(child, mergedProps, children);
    }

    return (
      <button ref={ref} type="button" {...props} {...shared}>
        {children}
      </button>
    );
  },
);

export function SidebarMenuAction({
  className,
  showOnHover = false,
  ...props
}: React.ComponentProps<'button'> & { showOnHover?: boolean }) {
  const { state, collapsible, isMobile } = useSidebar();
  if (!isMobile && collapsible !== 'none' && state === 'collapsed') return null;
  return (
    <button
      className={cn(
        'absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-[var(--fb-dim)] transition-colors hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)]',
        showOnHover && 'opacity-0 group-hover/menu-item:opacity-100 focus-visible:opacity-100',
        className,
      )}
      data-sidebar="menu-action"
      type="button"
      {...props}
    />
  );
}

export function SidebarMenuBadge({ className, ...props }: React.ComponentProps<'span'>) {
  const { state, collapsible, isMobile } = useSidebar();
  if (!isMobile && collapsible !== 'none' && state === 'collapsed') return null;
  return (
    <span
      className={cn(
        'pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-1.5 py-0.5 font-mono text-[9px] leading-none text-[var(--fb-dim)]',
        className,
      )}
      data-sidebar="menu-badge"
      {...props}
    />
  );
}

export function SidebarMenuSub({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      className={cn(
        'ml-[1.2rem] flex min-w-0 flex-col gap-0.5 border-l border-[var(--fb-line)] px-2 py-0.5',
        className,
      )}
      data-sidebar="menu-sub"
      {...props}
    />
  );
}

export function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<'li'>) {
  return <li className={cn('min-w-0', className)} data-sidebar="menu-sub-item" {...props} />;
}

export function SidebarMenuSubButton({
  className,
  isActive,
  render,
  children,
  ...props
}: React.ComponentPropsWithoutRef<'button'> & {
  isActive?: boolean;
  render?: React.ReactElement<Record<string, unknown>>;
}) {
  const { state, collapsible, isMobile } = useSidebar();
  if (!isMobile && collapsible !== 'none' && state === 'collapsed') return null;

  const classes = cn(
    'flex h-9 w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-2.5 text-left text-[13px] outline-none transition-colors',
    'focus-visible:ring-2 focus-visible:ring-[var(--fb-ink)]/20',
    isActive
      ? 'bg-[var(--fb-soft)] font-medium text-[var(--fb-ink)]'
      : 'text-[var(--fb-muted)] hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)]',
    className,
  );

  if (render) {
    const child = render;
    const mergedProps = {
      ...props,
      'aria-current': isActive ? 'page' : undefined,
      className: cn(classes, (child.props as { className?: string }).className),
    } as unknown as Partial<Record<string, unknown>> & React.Attributes;
    return React.cloneElement(child, mergedProps, children);
  }

  return (
    <button
      aria-current={isActive ? 'page' : undefined}
      className={classes}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}

export function SidebarMenuSkeleton({ className, ...props }: React.ComponentProps<'div'>) {
  const { state, collapsible, isMobile } = useSidebar();
  const collapsed = !isMobile && collapsible !== 'none' && state === 'collapsed';
  return (
    <div
      className={cn('flex h-10 items-center gap-2.5 rounded-lg px-2.5', className)}
      data-sidebar="menu-skeleton"
      {...props}
    >
      <div className="size-4 shrink-0 animate-pulse rounded bg-[var(--fb-soft)]" />
      {!collapsed && <div className="h-2.5 max-w-32 flex-1 animate-pulse rounded bg-[var(--fb-soft)]" />}
    </div>
  );
}

export function SidebarRail({ className, ...props }: React.ComponentProps<'button'>) {
  const { toggleSidebar, open, isMobile } = useSidebar();
  if (isMobile) return null;
  return (
    <button
      aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
      className={cn(
        'absolute inset-y-0 right-0 z-30 w-2 cursor-col-resize bg-transparent after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-transparent hover:after:bg-[var(--fb-line)]',
        className,
      )}
      data-sidebar="rail"
      onClick={toggleSidebar}
      title="Toggle sidebar (⌘B)"
      type="button"
      {...props}
    />
  );
}

export const SidebarTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<'button'>
>(function SidebarTrigger({ className, onClick, ...props }, ref) {
  const { isMobile, open, openMobile, toggleSidebar } = useSidebar();
  const expanded = isMobile ? openMobile : open;
  const Icon = expanded ? PanelLeftClose : PanelLeftOpen;

  return (
    <button
      ref={ref}
      aria-expanded={expanded}
      aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-[var(--fb-muted)] transition-colors hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fb-ink)]/20',
        className,
      )}
      data-sidebar="trigger"
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) toggleSidebar();
      }}
      title="Toggle sidebar (⌘B)"
      type="button"
      {...props}
    >
      <Icon aria-hidden size={17} />
    </button>
  );
});
