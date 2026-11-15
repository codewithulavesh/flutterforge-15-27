import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CreditCard,
  FolderKanban,
  LayoutGrid,
  LogOut,
  Moon,
  Plus,
  Settings2,
  Sparkles,
  Sun,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@radix-ui/react-collapsible';
import { BrandLogo } from '@/components/BrandLogo';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { useAuthStore } from '@/stores/auth.store';
import { useCreditsStore } from '@/stores/credits.store';
import { useThemeStore } from '@/stores/theme.store';
import type { Project } from '@/types';
import { cn } from '@/utils/cn';

const REPO_URL = 'https://github.com/codewithulavesh/flutterforge';

type ProjectSort = 'updated' | 'created' | 'name';

function initials(value: string) {
  const parts = value.trim().split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : value.slice(0, 2);
  return letters.toUpperCase();
}

function planLabel(plan?: string | null) {
  const normalized = (plan || 'free').toLowerCase();
  if (normalized === 'pro') return 'Pro plan';
  if (normalized === 'team') return 'Team plan';
  return 'Free plan';
}

function Avatar({
  url,
  name,
  size = 'md',
}: {
  url?: string | null;
  name: string;
  size?: 'md' | 'lg';
}) {
  const dimension = size === 'lg' ? 'h-10 w-10 text-[11px]' : 'h-9 w-9 text-[10px]';
  if (url) {
    return (
      <img
        alt=""
        className={cn('shrink-0 rounded-full border border-[var(--fb-line)] object-cover', dimension)}
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
      )}
    >
      {initials(name)}
    </span>
  );
}

function MenuIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-[var(--fb-line)] bg-[var(--fb-soft)] text-[var(--fb-muted)]">
      {children}
    </span>
  );
}

export function DashboardSidebar({
  projects,
  sortBy,
  searching,
  onNewProject,
  onShowProjects,
  onOpenPricing,
}: {
  projects: Project[];
  sortBy: ProjectSort;
  searching: boolean;
  onNewProject: () => void;
  onShowProjects: (sort: ProjectSort) => void;
  onOpenPricing: () => void;
}) {
  const navigate = useNavigate();
  const { profile, signOut } = useAuthStore();
  const { wallet, refresh } = useCreditsStore();
  const { theme, toggle } = useThemeStore();
  const { state, isMobile, setOpenMobile } = useSidebar();

  const collapsed = !isMobile && state === 'collapsed';
  const isDark = theme === 'dark';

  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const workspaceRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);
  const refreshedCredits = useRef(false);

  useEffect(() => {
    if (refreshedCredits.current) return;
    refreshedCredits.current = true;
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!workspaceOpen && !userOpen) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (workspaceOpen && workspaceRef.current && !workspaceRef.current.contains(target)) {
        setWorkspaceOpen(false);
      }
      if (userOpen && userRef.current && !userRef.current.contains(target)) {
        setUserOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setWorkspaceOpen(false);
        setUserOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [userOpen, workspaceOpen]);

  const recentProjects = useMemo(
    () =>
      [...projects]
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
        .slice(0, 3),
    [projects],
  );

  const displayName = profile?.full_name || profile?.email?.split('@')[0] || 'Your account';
  const displayEmail = profile?.email || 'Local workspace';
  const plan = wallet?.plan || profile?.plan;
  const planName = planLabel(plan);
  const planAction = (plan || 'free').toLowerCase() === 'free' ? 'Upgrade to Pro' : 'Manage plan';
  const credits = wallet?.balance;

  const openProject = (projectId: string) => {
    setWorkspaceOpen(false);
    setOpenMobile(false);
    navigate(`/project/${projectId}`);
  };

  const openPricing = () => {
    setWorkspaceOpen(false);
    setUserOpen(false);
    setOpenMobile(false);
    onOpenPricing();
  };

  const openNewProject = () => {
    setWorkspaceOpen(false);
    setOpenMobile(false);
    onNewProject();
  };

  const showProjects = (sort: ProjectSort) => {
    setOpenMobile(false);
    onShowProjects(sort);
  };

  const NavIcon = ({ icon: Icon }: { icon: LucideIcon }) => (
    <Icon aria-hidden className="shrink-0" size={17} />
  );

  // Labels are display:none in the icon rail, so name the row explicitly.
  const collapsedLabel = (label: string) =>
    collapsed ? { 'aria-label': label, title: label } : {};

  return (
    <Sidebar className="border-[var(--fb-line)]">
      <SidebarHeader className="relative px-3 pb-3 pt-4">
        {isMobile && (
          <button
            aria-label="Close navigation"
            className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-lg text-[var(--fb-muted)] transition-colors hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)]"
            onClick={() => setOpenMobile(false)}
            type="button"
          >
            <X size={16} />
          </button>
        )}

        <div className="relative" ref={workspaceRef}>
          <button
            aria-expanded={workspaceOpen}
            aria-haspopup="menu"
            aria-label={collapsed ? 'Switch workspace' : undefined}
            className={cn(
              'flex h-14 w-full items-center gap-3 rounded-xl px-2 text-left outline-none transition-colors hover:bg-[var(--fb-soft)] focus-visible:ring-2 focus-visible:ring-[var(--fb-ink)]/20',
              workspaceOpen && 'bg-[var(--fb-soft)]',
              collapsed && 'justify-center px-0',
              isMobile && 'pr-9',
            )}
            onClick={() => {
              setWorkspaceOpen((open) => !open);
              setUserOpen(false);
            }}
            type="button"
          >
            <BrandLogo size={36} className="rounded-[10px] border border-[var(--fb-line)]" />
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-semibold leading-tight text-[var(--fb-ink)]">
                    FlutterForge
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-[var(--fb-dim)]">
                    {planName}
                  </span>
                </span>
                {!isMobile && (
                  <ChevronsUpDown aria-hidden className="shrink-0 text-[var(--fb-dim)]" size={14} />
                )}
              </>
            )}
          </button>

          {workspaceOpen && (
            <div
              className="absolute left-0 top-[calc(100%+8px)] z-50 w-[min(21rem,calc(100vw-2.5rem))] overflow-hidden rounded-xl border border-[var(--fb-line)] bg-[var(--fb-elevated)] p-1.5 shadow-[0_28px_80px_-22px_rgba(0,0,0,0.6)] animate-in fade-in-0 zoom-in-95"
              role="menu"
            >
              <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-[var(--fb-dim)]">
                Workspaces
              </p>
              <button
                className="flex h-12 w-full items-center gap-3 rounded-lg px-2 text-left transition-colors hover:bg-[var(--fb-soft)]"
                onClick={() => {
                  setWorkspaceOpen(false);
                  setOpenMobile(false);
                  navigate('/dashboard');
                }}
                role="menuitem"
                type="button"
              >
                <MenuIcon>
                  <BrandLogo size={18} className="rounded-[5px]" />
                </MenuIcon>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-[var(--fb-ink)]">
                    FlutterForge
                  </span>
                  <span className="block truncate text-[11.5px] text-[var(--fb-dim)]">
                    Personal workspace
                  </span>
                </span>
                <Check aria-hidden className="text-[var(--fb-ink)]" size={15} />
              </button>

              {recentProjects.length > 0 && (
                <>
                  <div className="my-1 h-px bg-[var(--fb-line)]" />
                  <p className="px-2.5 pb-1 pt-0.5 text-[11px] font-medium text-[var(--fb-dim)]">
                    Recent projects
                  </p>
                  {recentProjects.map((project) => (
                    <button
                      className="flex h-11 w-full items-center gap-3 rounded-lg px-2 text-left transition-colors hover:bg-[var(--fb-soft)]"
                      key={project.id}
                      onClick={() => openProject(project.id)}
                      role="menuitem"
                      type="button"
                    >
                      <MenuIcon>
                        <FolderKanban aria-hidden size={16} />
                      </MenuIcon>
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-[var(--fb-ink)]">
                        {project.name}
                      </span>
                      <ArrowUpRight aria-hidden className="text-[var(--fb-dim)]" size={14} />
                    </button>
                  ))}
                </>
              )}

              <div className="my-1 h-px bg-[var(--fb-line)]" />
              <button
                className="flex h-11 w-full items-center gap-3 rounded-lg px-2 text-left transition-colors hover:bg-[var(--fb-soft)]"
                onClick={openNewProject}
                role="menuitem"
                type="button"
              >
                <MenuIcon>
                  <Plus aria-hidden size={16} />
                </MenuIcon>
                <span className="text-[13.5px] font-medium text-[var(--fb-muted)]">New app</span>
              </button>
            </div>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <Collapsible onOpenChange={setProjectsOpen} open={projectsOpen}>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton {...collapsedLabel('Projects')} type="button">
                      <NavIcon icon={LayoutGrid} />
                      <span>Projects</span>
                      {!collapsed && (
                        <ChevronDown
                          aria-hidden
                          className={cn(
                            'ml-auto shrink-0 text-[var(--fb-dim)] transition-transform duration-200',
                            !projectsOpen && '-rotate-90',
                          )}
                          size={14}
                        />
                      )}
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  {!collapsed && (
                    <CollapsibleContent>
                      <SidebarMenuSub>
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton
                            isActive={!searching && sortBy === 'updated'}
                            onClick={() => showProjects('updated')}
                          >
                            All projects
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton
                            isActive={!searching && sortBy === 'created'}
                            onClick={() => showProjects('created')}
                          >
                            Recent
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton onClick={openNewProject}>Templates</SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  )}
                </Collapsible>
              </SidebarMenuItem>

              <SidebarMenuItem>
                <SidebarMenuButton
                  {...collapsedLabel('Agents')}
                  onClick={() => {
                    setOpenMobile(false);
                    navigate('/agents');
                  }}
                >
                  <NavIcon icon={Sparkles} />
                  <span>Agents</span>
                  {!collapsed && (
                    <ChevronRight aria-hidden className="ml-auto shrink-0 text-[var(--fb-dim)]" size={14} />
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>

              <SidebarMenuItem>
                <SidebarMenuButton
                  {...collapsedLabel('Documentation')}
                  render={<a href={REPO_URL} rel="noreferrer" target="_blank" />}
                >
                  <NavIcon icon={BookOpen} />
                  <span>Documentation</span>
                  {!collapsed && (
                    <ArrowUpRight aria-hidden className="ml-auto shrink-0 text-[var(--fb-dim)]" size={14} />
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>

              <SidebarMenuItem>
                <Collapsible onOpenChange={setSettingsOpen} open={settingsOpen}>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton {...collapsedLabel('Settings')} type="button">
                      <NavIcon icon={Settings2} />
                      <span>Settings</span>
                      {!collapsed && (
                        <ChevronDown
                          aria-hidden
                          className={cn(
                            'ml-auto shrink-0 text-[var(--fb-dim)] transition-transform duration-200',
                            !settingsOpen && '-rotate-90',
                          )}
                          size={14}
                        />
                      )}
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  {!collapsed && (
                    <CollapsibleContent>
                      <SidebarMenuSub>
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton
                            onClick={(event) => {
                              event.stopPropagation();
                              toggle();
                            }}
                          >
                            <span className="flex min-w-0 flex-1 items-center gap-2">
                              {isDark ? <Sun aria-hidden size={14} /> : <Moon aria-hidden size={14} />}
                              <span>{isDark ? 'Light mode' : 'Dark mode'}</span>
                            </span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton onClick={openPricing}>Plan & billing</SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  )}
                </Collapsible>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="mt-auto px-3 pb-3">
        <div className="relative" ref={userRef}>
          <button
            aria-expanded={userOpen}
            aria-haspopup="menu"
            aria-label={collapsed ? 'Account menu' : undefined}
            className={cn(
              'flex h-14 w-full items-center gap-3 rounded-xl px-2 text-left outline-none transition-colors hover:bg-[var(--fb-soft)] focus-visible:ring-2 focus-visible:ring-[var(--fb-ink)]/20',
              userOpen && 'bg-[var(--fb-soft)]',
              collapsed && 'justify-center px-0',
            )}
            onClick={() => {
              setUserOpen((open) => !open);
              setWorkspaceOpen(false);
            }}
            type="button"
          >
            <Avatar name={displayName} url={profile?.avatar_url} />
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold leading-tight text-[var(--fb-ink)]">
                    {displayName}
                  </span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-[var(--fb-dim)]">
                    {displayEmail}
                  </span>
                </span>
                <ChevronsUpDown aria-hidden className="shrink-0 text-[var(--fb-dim)]" size={14} />
              </>
            )}
          </button>

          {userOpen && (
            <div
              className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-[min(21rem,calc(100vw-2.5rem))] overflow-hidden rounded-xl border border-[var(--fb-line)] bg-[var(--fb-elevated)] shadow-[0_28px_80px_-22px_rgba(0,0,0,0.6)] animate-in fade-in-0 zoom-in-95"
              role="menu"
            >
              <div className="flex items-center gap-3 px-3 py-3">
                <Avatar name={displayName} size="lg" url={profile?.avatar_url} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-semibold text-[var(--fb-ink)]">{displayName}</p>
                  <p className="truncate text-[11.5px] text-[var(--fb-dim)]">{displayEmail}</p>
                </div>
              </div>
              {typeof credits === 'number' && (
                <p className="px-3 pb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--fb-dim)]">
                  {credits.toLocaleString()} credits · {planName}
                </p>
              )}
              <div className="h-px bg-[var(--fb-line)]" />
              <div className="p-1.5">
                <button
                  className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] font-medium text-[var(--fb-muted)] transition-colors hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)]"
                  onClick={openPricing}
                  role="menuitem"
                  type="button"
                >
                  <Sparkles aria-hidden size={16} />
                  {planAction}
                </button>
                <button
                  className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] font-medium text-[var(--fb-muted)] transition-colors hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)]"
                  onClick={openPricing}
                  role="menuitem"
                  type="button"
                >
                  <CreditCard aria-hidden size={16} />
                  Plan & billing
                </button>
                <button
                  className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] font-medium text-[var(--fb-muted)] transition-colors hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)]"
                  onClick={toggle}
                  role="menuitem"
                  type="button"
                >
                  {isDark ? <Sun aria-hidden size={16} /> : <Moon aria-hidden size={16} />}
                  {isDark ? 'Light mode' : 'Dark mode'}
                </button>
              </div>
              <div className="h-px bg-[var(--fb-line)]" />
              <div className="p-1.5">
                <button
                  className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] font-medium text-[var(--fb-muted)] transition-colors hover:bg-[var(--fb-soft)] hover:text-[var(--fb-ink)]"
                  onClick={() => {
                    setUserOpen(false);
                    void signOut();
                  }}
                  role="menuitem"
                  type="button"
                >
                  <LogOut aria-hidden size={16} />
                  Log out
                </button>
              </div>
            </div>
          )}
        </div>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
