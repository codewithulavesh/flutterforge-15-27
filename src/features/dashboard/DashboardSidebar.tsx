import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CreditCard,
  FolderKanban,
  Gauge,
  Keyboard,
  LayoutGrid,
  LifeBuoy,
  LogOut,
  Megaphone,
  Moon,
  Plug,
  Plus,
  Rocket,
  Settings2,
  Sparkles,
  Sun,
  UserRound,
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
  SidebarMenuBadge,
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
import { ProfileAvatar } from './ProfileAvatar';
import { planLabel } from '@/utils/profile';

const REPO_URL = 'https://github.com/codewithulavesh/flutterforge';
const ISSUES_URL = `${REPO_URL}/issues`;
const RELEASES_URL = `${REPO_URL}/releases`;

function MenuIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[rgba(248,255,248,0.12)] bg-white/5 text-[rgba(248,255,248,0.8)]">
      {children}
    </span>
  );
}

export function DashboardSidebar({
  projects,
  onNewProject,
}: {
  projects: Project[];
  onNewProject: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { profile, signOut } = useAuthStore();
  const { wallet, refresh } = useCreditsStore();
  const { theme, toggle } = useThemeStore();
  const { state, isMobile, setOpenMobile } = useSidebar();

  const collapsed = !isMobile && state === 'collapsed';
  const isDark = theme === 'dark';
  const isMac =
    typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  const shortcutLabel = isMac ? 'Cmd B' : 'Ctrl B';

  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const workspaceRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);
  const refreshedCredits = useRef(false);

  const pathname = location.pathname.replace(/\/+$/, '') || '/dashboard';
  const sortParam = searchParams.get('sort');
  const sortBy = sortParam === 'created' || sortParam === 'name' ? sortParam : 'updated';

  const active = {
    allProjects: pathname === '/dashboard' && sortBy !== 'created',
    recentProjects: pathname === '/dashboard' && sortBy === 'created',
    agents: pathname === '/dashboard/agents',
    usage: pathname === '/dashboard/usage',
    deployments: pathname === '/dashboard/deployments',
    integrations: pathname === '/dashboard/integrations',
    profile: pathname === '/dashboard/profile',
    shortcuts: pathname === '/dashboard/shortcuts',
    billing: pathname === '/dashboard/billing',
    settings: pathname === '/dashboard/settings' || pathname === '/dashboard/billing',
  };

  useEffect(() => {
    if (refreshedCredits.current) return;
    refreshedCredits.current = true;
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (active.settings) setSettingsOpen(true);
     
  }, [active.settings]);

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
  const deployedCount = useMemo(
    () => projects.filter((project) => project.status === 'deployed' || Boolean(project.deployment_url)).length,
    [projects],
  );

  const closeMenus = () => {
    setWorkspaceOpen(false);
    setUserOpen(false);
    setOpenMobile(false);
  };

  const openProject = (projectId: string) => {
    closeMenus();
    navigate(`/project/${projectId}`);
  };

  const openNewProject = () => {
    closeMenus();
    onNewProject();
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
              'flex h-14 w-full items-center gap-3 rounded-2xl px-2.5 text-left outline-none transition-all hover:bg-white/10 border border-transparent hover:border-[rgba(248,255,248,0.1)] focus-visible:ring-2 focus-visible:ring-[var(--fb-lime)]/30',
              workspaceOpen && 'bg-white/10 border-[rgba(248,255,248,0.15)]',
              collapsed && 'justify-center px-0',
              isMobile && 'pr-9',
            )}
            onClick={() => {
              setWorkspaceOpen((open) => !open);
              setUserOpen(false);
            }}
            type="button"
          >
            <BrandLogo className="rounded-[10px] border border-[rgba(248,255,248,0.15)]" size={36} />
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] ffb-display font-bold leading-tight text-[#f8fff8] tracking-[-0.03em]">
                    FlutterForge
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--fb-lime)]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--fb-lime)] ring-2 ring-[var(--fb-lime)]/30" />
                    {planName}
                  </span>
                </span>
                {!isMobile && (
                  <ChevronsUpDown aria-hidden className="shrink-0 text-[rgba(248,255,248,0.45)]" size={14} />
                )}
              </>
            )}
          </button>

          {workspaceOpen && (
            <div
              className="absolute left-0 top-[calc(100%+8px)] z-50 w-[min(21rem,calc(100vw-2.5rem))] overflow-hidden rounded-[22px] border border-[rgba(248,255,248,0.16)] bg-[#00101e] p-2 shadow-[0_32px_90px_-20px_rgba(0,0,0,0.85)] backdrop-blur-xl animate-in fade-in-0 zoom-in-95 ff-dash-popover"
              role="menu"
            >
              <p className="px-2.5 pb-1 pt-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-[var(--fb-lime)]">Workspaces</p>
              <button
                className="flex h-12 w-full items-center gap-3 rounded-xl px-2.5 text-left transition-colors hover:bg-white/10"
                onClick={() => {
                  closeMenus();
                  navigate('/dashboard');
                }}
                role="menuitem"
                type="button"
              >
                <MenuIcon>
                  <BrandLogo className="rounded-[6px]" size={18} />
                </MenuIcon>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-[#f8fff8]">
                    FlutterForge
                  </span>
                  <span className="block truncate text-[11.5px] text-[rgba(248,255,248,0.55)]">
                    Personal workspace
                  </span>
                </span>
                <Check aria-hidden className="text-[var(--fb-lime)]" size={15} />
              </button>

              {recentProjects.length > 0 && (
                <>
                  <div className="my-1.5 h-px bg-[rgba(248,255,248,0.1)]" />
                  <p className="px-2.5 pb-1 pt-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-[rgba(248,255,248,0.45)]">
                    Recent projects
                  </p>
                  {recentProjects.map((project) => (
                    <button
                      className="flex h-11 w-full items-center gap-3 rounded-xl px-2.5 text-left transition-colors hover:bg-white/10"
                      key={project.id}
                      onClick={() => openProject(project.id)}
                      role="menuitem"
                      type="button"
                    >
                      <MenuIcon>
                        <FolderKanban aria-hidden size={16} />
                      </MenuIcon>
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-[#f8fff8]">
                        {project.name}
                      </span>
                      <ArrowUpRight aria-hidden className="text-[rgba(248,255,248,0.4)]" size={14} />
                    </button>
                  ))}
                </>
              )}

              <div className="my-1.5 h-px bg-[rgba(248,255,248,0.1)]" />
              <button
                className="flex h-11 w-full items-center gap-3 rounded-xl px-2.5 text-left text-[var(--fb-lime)] transition-colors hover:bg-[var(--fb-lime)]/10"
                onClick={openNewProject}
                role="menuitem"
                type="button"
              >
                <MenuIcon>
                  <Plus aria-hidden size={16} className="text-[var(--fb-lime)]" />
                </MenuIcon>
                <span className="text-[13.5px] font-semibold text-[var(--fb-lime)]">New app</span>
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
                            isActive={active.allProjects}
                            onClick={closeMenus}
                            render={<Link to="/dashboard" />}
                          >
                            All projects
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton
                            isActive={active.recentProjects}
                            onClick={closeMenus}
                            render={<Link to="/dashboard?sort=created" />}
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
                  isActive={active.agents}
                  onClick={closeMenus}
                  render={<Link to="/dashboard/agents" />}
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
                    <SidebarMenuButton
                      {...collapsedLabel('Settings')}
                      isActive={active.settings}
                      type="button"
                    >
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
                            isActive={active.settings && !active.billing}
                            onClick={closeMenus}
                            render={<Link to="/dashboard/settings" />}
                          >
                            Preferences
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton
                            isActive={active.billing}
                            onClick={closeMenus}
                            render={<Link to="/dashboard/billing" />}
                          >
                            Plan &amp; billing
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
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
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  )}
                </Collapsible>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  {...collapsedLabel('Usage & credits')}
                  isActive={active.usage}
                  onClick={closeMenus}
                  render={<Link to="/dashboard/usage" />}
                >
                  <NavIcon icon={Gauge} />
                  <span>Usage &amp; credits</span>
                  {!collapsed && (
                    <SidebarMenuBadge>{credits != null ? credits.toLocaleString() : '—'}</SidebarMenuBadge>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>

              <SidebarMenuItem>
                <SidebarMenuButton
                  {...collapsedLabel('Deployments')}
                  isActive={active.deployments}
                  onClick={closeMenus}
                  render={<Link to="/dashboard/deployments" />}
                >
                  <NavIcon icon={Rocket} />
                  <span>Deployments</span>
                  {!collapsed && deployedCount > 0 && <SidebarMenuBadge>{deployedCount}</SidebarMenuBadge>}
                </SidebarMenuButton>
              </SidebarMenuItem>

              <SidebarMenuItem>
                <SidebarMenuButton
                  {...collapsedLabel('Integrations')}
                  isActive={active.integrations}
                  onClick={closeMenus}
                  render={<Link to="/dashboard/integrations" />}
                >
                  <NavIcon icon={Plug} />
                  <span>Integrations</span>
                  {!collapsed && (
                    <ChevronRight aria-hidden className="ml-auto shrink-0 text-[var(--fb-dim)]" size={14} />
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Account</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  {...collapsedLabel('Edit profile')}
                  isActive={active.profile}
                  onClick={closeMenus}
                  render={<Link to="/dashboard/profile" />}
                >
                  <NavIcon icon={UserRound} />
                  <span>Edit profile</span>
                  {!collapsed && (
                    <ChevronRight aria-hidden className="ml-auto shrink-0 text-[var(--fb-dim)]" size={14} />
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>

              <SidebarMenuItem>
                <SidebarMenuButton
                  {...collapsedLabel('Keyboard shortcuts')}
                  isActive={active.shortcuts}
                  onClick={closeMenus}
                  render={<Link to="/dashboard/shortcuts" />}
                >
                  <NavIcon icon={Keyboard} />
                  <span>Keyboard shortcuts</span>
                  {!collapsed && <SidebarMenuBadge>{shortcutLabel}</SidebarMenuBadge>}
                </SidebarMenuButton>
              </SidebarMenuItem>

              <SidebarMenuItem>
                <SidebarMenuButton
                  {...collapsedLabel('Support')}
                  render={<a href={ISSUES_URL} rel="noreferrer" target="_blank" />}
                >
                  <NavIcon icon={LifeBuoy} />
                  <span>Support</span>
                  {!collapsed && (
                    <ArrowUpRight aria-hidden className="ml-auto shrink-0 text-[var(--fb-dim)]" size={14} />
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>

              <SidebarMenuItem>
                <SidebarMenuButton
                  {...collapsedLabel("What's new")}
                  render={<a href={RELEASES_URL} rel="noreferrer" target="_blank" />}
                >
                  <NavIcon icon={Megaphone} />
                  <span>What's new</span>
                  {!collapsed && (
                    <ArrowUpRight aria-hidden className="ml-auto shrink-0 text-[var(--fb-dim)]" size={14} />
                  )}
                </SidebarMenuButton>
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
              'flex h-14 w-full items-center gap-3 rounded-2xl px-2.5 text-left outline-none transition-all hover:bg-white/10 border border-transparent hover:border-[rgba(248,255,248,0.1)] focus-visible:ring-2 focus-visible:ring-[var(--fb-lime)]/30',
              userOpen && 'bg-white/10 border-[rgba(248,255,248,0.15)]',
              collapsed && 'justify-center px-0',
            )}
            onClick={() => {
              setUserOpen((open) => !open);
              setWorkspaceOpen(false);
            }}
            type="button"
          >
            <ProfileAvatar name={displayName} url={profile?.avatar_url} />
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold leading-tight text-[#f8fff8]">
                    {displayName}
                  </span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-[rgba(248,255,248,0.55)]">
                    {displayEmail}
                  </span>
                </span>
                <ChevronsUpDown aria-hidden className="shrink-0 text-[rgba(248,255,248,0.45)]" size={14} />
              </>
            )}
          </button>

          {userOpen && (
            <div
              className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-[min(21rem,calc(100vw-2.5rem))] overflow-hidden rounded-[22px] border border-[rgba(248,255,248,0.16)] bg-[#00101e] shadow-[0_32px_90px_-20px_rgba(0,0,0,0.85)] backdrop-blur-xl animate-in fade-in-0 zoom-in-95 ff-dash-popover"
              role="menu"
            >
              <div className="flex items-center gap-3 px-3.5 py-3.5">
                <ProfileAvatar name={displayName} size="lg" url={profile?.avatar_url} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-semibold text-[#f8fff8]">{displayName}</p>
                  <p className="truncate text-[11.5px] text-[rgba(248,255,248,0.55)]">{displayEmail}</p>
                </div>
              </div>
              {typeof credits === 'number' && (
                <p className="px-3.5 pb-2.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--fb-lime)]">
                  {credits.toLocaleString()} credits · {planName}
                </p>
              )}
              <div className="h-px bg-[rgba(248,255,248,0.1)]" />
              <div className="p-1.5">
                <Link
                  className="flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-[13px] font-medium text-[rgba(248,255,248,0.8)] transition-all hover:bg-white/10 hover:text-[#f8fff8]"
                  onClick={closeMenus}
                  role="menuitem"
                  to="/dashboard/profile"
                >
                  <UserRound aria-hidden size={16} className="text-[var(--fb-lime)]" />
                  Edit profile
                </Link>
                <Link
                  className="flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-[13px] font-medium text-[rgba(248,255,248,0.8)] transition-all hover:bg-white/10 hover:text-[#f8fff8]"
                  onClick={closeMenus}
                  role="menuitem"
                  to="/dashboard/usage"
                >
                  <Gauge aria-hidden size={16} className="text-[var(--fb-lime)]" />
                  Usage &amp; credits
                </Link>
                <Link
                  className="flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-[13px] font-medium text-[var(--fb-lime)] transition-all hover:bg-[var(--fb-lime)]/10"
                  onClick={closeMenus}
                  role="menuitem"
                  to="/dashboard/billing"
                >
                  <Sparkles aria-hidden size={16} />
                  {planAction}
                </Link>
                <Link
                  className="flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-[13px] font-medium text-[rgba(248,255,248,0.8)] transition-all hover:bg-white/10 hover:text-[#f8fff8]"
                  onClick={closeMenus}
                  role="menuitem"
                  to="/dashboard/billing"
                >
                  <CreditCard aria-hidden size={16} />
                  Plan &amp; billing
                </Link>
                <button
                  className="flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-[13px] font-medium text-[rgba(248,255,248,0.8)] transition-all hover:bg-white/10 hover:text-[#f8fff8]"
                  onClick={toggle}
                  role="menuitem"
                  type="button"
                >
                  {isDark ? <Sun aria-hidden size={16} /> : <Moon aria-hidden size={16} />}
                  {isDark ? 'Light mode' : 'Dark mode'}
                </button>
                <Link
                  className="flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-[13px] font-medium text-[rgba(248,255,248,0.8)] transition-all hover:bg-white/10 hover:text-[#f8fff8]"
                  onClick={closeMenus}
                  role="menuitem"
                  to="/dashboard/shortcuts"
                >
                  <Keyboard aria-hidden size={16} />
                  Keyboard shortcuts
                </Link>
              </div>
              <div className="h-px bg-[rgba(248,255,248,0.1)]" />
              <div className="p-1.5">
                <button
                  className="flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-[13px] font-medium text-[rgba(248,255,248,0.8)] transition-all hover:bg-rose-500/15 hover:text-rose-300"
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
