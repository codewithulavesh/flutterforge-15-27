import { useNavigate } from 'react-router-dom';
import {
  Circle,
  Code2,
  Download as DownloadIcon,
  Eye,
  FolderTree,
  GitBranch,
  History,
  LayoutGrid,
  MoreHorizontal,
  Package,
  Play,
  Settings as SettingsIcon,
  Sparkles,
  Square,
  TerminalSquare,
  RotateCw,
  Hammer,
  Download,
  MessageSquarePlus,
  Copy,
  RotateCcw,
  FolderOpen,
  Command,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useProjectStore } from '@/stores/project.store';
import { useTerminalStore } from '@/stores/terminal.store';
import { usePreviewStore } from '@/stores/preview.store';
import { BrandLogo } from '@/components/BrandLogo';
import { getProjectWorkspacePath } from '@/utils/previewWorkspace';
import { Button } from '@/components/ui/Button';
import { Dropdown, DropdownItem } from '@/components/ui/Dropdown';
import { toast } from '@/components/ui/Toast';
import { ThemeToggle } from '@/components/ThemeToggle';
import { downloadProjectZip, formatBytes } from '@/utils/exportProject';
import { SIDEBAR_SECTIONS } from '@/utils/constants';
import { cn } from '@/utils/cn';

const PRIMARY_NAV_ITEMS = new Set(['dashboard', 'ai-builder', 'preview', 'files', 'code', 'terminal']);
const NAV_ICONS: Record<string, LucideIcon> = {
  LayoutGrid,
  Sparkles,
  Eye,
  FolderTree,
  Package,
  Code2,
  TerminalSquare,
  History,
  GitBranch,
  Hammer,
  Settings: SettingsIcon,
  Download: DownloadIcon,
};
const WORKSPACE_NAV_ITEMS = SIDEBAR_SECTIONS.reduce<Array<{ id: string; label: string; icon: string }>>(
  (items, section) => [...items, ...section.items],
  [],
);

export function WorkspaceToolbar() {
  const navigate = useNavigate();
  const { currentProject, files } = useProjectStore();
  const { activeView, setActiveView, setCommandPaletteOpen, setBottomPanelOpen, setBottomPanelTab } = useWorkspaceStore();
  const { setBuilding, addBuildLog, clearBuildLogs, isBuilding } = useTerminalStore();

  const hasSecondaryActiveView = WORKSPACE_NAV_ITEMS.some(
    (item) => item.id === activeView && !PRIMARY_NAV_ITEMS.has(item.id),
  );

  const dartFileCount = files.filter((f) => !f.is_directory && f.path.endsWith('.dart')).length;
  const hasCode = dartFileCount > 0;

  async function handleExportZip() {
    if (!currentProject) {
      toast('error', 'No project open to export');
      return;
    }
    toast('info', `Preparing ${currentProject.name} for download...`);
    try {
      const built = await downloadProjectZip(currentProject, files);
      toast('success', `Downloaded ${built.filename} (${built.fileCount} files, ${formatBytes(built.bytes)})`);
    } catch (err) {
      toast('error', err instanceof Error ? `Export failed: ${err.message}` : 'Export failed');
    }
  }

  async function openProjectFolder() {
    if (!currentProject) return;
    const workspace = await getProjectWorkspacePath(currentProject.id);
    if (!workspace) {
      toast('error', 'No preview build yet — build the preview first.');
      return;
    }
    const result = await window.flutterforgeDesktop?.openPath(workspace);
    if (result && !result.ok) toast('error', result.error || 'Could not open the folder.');
  }

  function dispatchChat(action: string) {
    setActiveView('ai-builder');
    window.setTimeout(() => window.dispatchEvent(new CustomEvent(action)), 100);
  }

  async function handleBuild() {
    if (!currentProject) return;
    const previewStore = usePreviewStore.getState();
    const existing = previewStore.getSession(currentProject.id);
    if (existing && (existing.status === 'queued' || existing.status === 'building')) {
      toast('info', 'A build is already running — watch it in the Preview tab.');
      setActiveView('preview');
      return;
    }
    if (files.length === 0 || dartFileCount === 0) {
      toast('error', 'No Dart files to build yet — generate the app first.');
      return;
    }
    // Trigger the REAL Flutter web build (same pipeline as PreviewPanel).
    // Live compiler output streams into the Build panel via the session sync.
    setBuilding(true);
    setBottomPanelOpen(true);
    setBottomPanelTab('build');
    clearBuildLogs();
    addBuildLog('Starting Flutter web preview build…');
    try {
      const sessionId = await previewStore.build(
        currentProject.id,
        files.filter((f) => !f.is_directory).map((f) => ({ path: f.path, content: f.content })),
        {
          supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
          supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
      );
      addBuildLog(`✓ Build started (session ${sessionId.slice(0, 8)}…) — live log in Preview tab`);
      setActiveView('preview');
      toast('success', 'Real web build started — watch it in Preview.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Build failed to start.';
      addBuildLog(`✗ ${message}`);
      toast('error', message);
    } finally {
      setBuilding(false);
    }
  }

  return (
    <header className="sticky top-0 z-30 shrink-0 border-b border-[rgba(248,255,248,0.10)] bg-[linear-gradient(180deg,#001525_0%,#00101e_100%)] backdrop-blur-xl shadow-[0_1px_0_rgba(248,255,248,0.07)]">
      <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 min-h-[60px] px-3 sm:px-4 py-2">

        {/* ── Left: logo + project name ─────────────────────── */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <button
            onClick={() => navigate('/dashboard')}
            className="group flex items-center gap-2.5 rounded-[14px] px-2 py-1.5 transition-colors hover:bg-[rgba(248,255,248,0.07)]"
          >
            <BrandLogo size={28} className="rounded-[8px] border border-[rgba(248,255,248,0.14)]" />
            <div className="flex flex-col leading-none text-left">
              <span className="max-w-24 truncate text-[13px] font-semibold text-[#f8fff8] sm:max-w-36" style={{ fontFamily: "'Lime Panchang', sans-serif" }}>
                {currentProject?.name ?? 'FlutterForge'}
              </span>
              <span className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-[#748ea0]">Workspace</span>
            </div>
          </button>

          {/* Status chip */}
          {currentProject && (
            <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-[rgba(248,255,248,0.12)] bg-[rgba(248,255,248,0.05)] px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-[#748ea0]">
              <span
                aria-hidden
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  currentProject.status === 'ready' ? 'bg-[#c5fa75]' : 'bg-[#748ea0]',
                )}
              />
              {currentProject.status ?? 'created'}
            </span>
          )}

          {/* Live code indicator */}
          {hasCode && (
            <div className="hidden md:inline-flex items-center gap-1.5 rounded-full bg-[rgba(197,250,117,0.15)] border border-[rgba(197,250,117,0.30)] px-2.5 py-1 text-[10px] font-semibold text-[#c5fa75]">
              <Zap size={10} />
              <span>{dartFileCount} files</span>
            </div>
          )}
        </div>

        {/* ── Center: primary nav ───────────────────────────── */}
        <div className="flex items-center order-last w-full sm:order-none sm:w-auto sm:contents">
          <nav
            className="flex items-center gap-0.5 flex-1 overflow-x-auto ff-scrollbar min-w-0 mx-1 sm:mx-2"
            aria-label="Workspace navigation"
            style={{ scrollbarWidth: 'none' }}
          >
            {WORKSPACE_NAV_ITEMS.filter((item) => PRIMARY_NAV_ITEMS.has(item.id)).map((item) => {
              const Icon = NAV_ICONS[item.icon] ?? Circle;
              const isActive = item.id === activeView;
              return (
                <button
                  key={item.id}
                  onClick={() => item.id === 'dashboard' ? navigate('/dashboard') : setActiveView(item.id as typeof activeView)}
                  className={cn(
                    'relative flex items-center gap-1.5 px-3 py-2 rounded-full text-[11px] font-medium whitespace-nowrap transition-all shrink-0',
                    isActive
                      ? 'bg-[rgba(197,250,117,0.12)] border border-[rgba(197,250,117,0.35)] text-[#f8fff8] shadow-[0_0_12px_rgba(197,250,117,0.12)]'
                      : 'border border-transparent text-[#748ea0] hover:bg-[rgba(248,255,248,0.07)] hover:text-[#f8fff8]'
                  )}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <Icon size={13} className={cn('shrink-0', isActive && 'text-[#c5fa75]')} />
                  <span className="hidden sm:inline">{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* More dropdown - outside scroll container to avoid clipping */}
          <div className="shrink-0">
            <Dropdown
              trigger={
                <button
                  aria-label="More workspace tools"
                  className={cn(
                    'relative flex items-center gap-1.5 px-3 py-2 rounded-full text-[11px] font-medium whitespace-nowrap transition-all shrink-0 border',
                    hasSecondaryActiveView
                      ? 'bg-[rgba(197,250,117,0.12)] border-[rgba(197,250,117,0.35)] text-[#f8fff8]'
                      : 'border-transparent text-[#748ea0] hover:bg-[rgba(248,255,248,0.07)] hover:text-[#f8fff8]'
                  )}
                >
                  <MoreHorizontal size={13} />
                  <span className="hidden sm:inline">More</span>
                </button>
              }
            >
              {WORKSPACE_NAV_ITEMS.filter((item) => !PRIMARY_NAV_ITEMS.has(item.id)).map((item) => {
                const Icon = NAV_ICONS[item.icon] ?? Circle;
                const isActive = activeView === item.id;
                return (
                  <DropdownItem key={item.id} icon={<Icon size={14} />} onClick={() => setActiveView(item.id as typeof activeView)}>
                    <span className={cn(isActive && 'font-semibold')}>{item.label}</span>
                  </DropdownItem>
                );
              })}
              <DropdownItem icon={<MessageSquarePlus size={14} />} onClick={() => dispatchChat('ff:new-chat')}>New chat</DropdownItem>
              <DropdownItem icon={<Copy size={14} />} onClick={() => dispatchChat('ff:copy-last')}>Copy last response</DropdownItem>
              <DropdownItem icon={<RotateCcw size={14} />} onClick={() => dispatchChat('ff:retry-last')}>Retry last response</DropdownItem>
              {window.flutterforgeDesktop?.isDesktop && (
                <DropdownItem icon={<FolderOpen size={14} />} onClick={() => void openProjectFolder()}>Open project folder</DropdownItem>
              )}
            </Dropdown>
          </div>
        </div>

        {/* ── Right: command + build actions ───────────────── */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 ml-auto sm:ml-0">
          <ThemeToggle className="rounded-full !border-[rgba(248,255,248,0.14)] !bg-[rgba(248,255,248,0.05)] text-[#748ea0] hover:text-[#f8fff8] hover:!bg-[rgba(248,255,248,0.10)]" />
          <button
            onClick={() => setCommandPaletteOpen(true)}
            className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-full border border-[rgba(248,255,248,0.12)] bg-[rgba(248,255,248,0.05)] text-xs text-[#748ea0] hover:border-[rgba(248,255,248,0.25)] hover:text-[#f8fff8] transition-colors w-48 shrink-0"
          >
            <Command size={11} />
            <span className="flex-1 text-left truncate">Search commands...</span>
            <kbd className="rounded-full border border-[rgba(248,255,248,0.12)] px-1.5 py-0.5 font-mono text-[9px]">⌘K</kbd>
          </button>

          <Button
            variant="ghost"
            size="sm"
            icon={<RotateCw size={13} />}
            onClick={handleBuild}
            className="hidden md:flex text-[#748ea0] hover:text-[#f8fff8] border-[rgba(248,255,248,0.12)] hover:border-[rgba(248,255,248,0.25)] hover:bg-[rgba(248,255,248,0.07)]"
          >
            <span className="hidden lg:inline">Rebuild</span>
          </Button>

          <button
            onClick={handleBuild}
            className="flex items-center gap-2 h-9 px-4 rounded-full bg-[#c5fa75] text-[#00101e] text-[11px] font-bold transition-all hover:brightness-105 hover:-translate-y-px active:scale-95 shadow-[0_4px_16px_rgba(197,250,117,0.25)]"
          >
            {isBuilding ? <Square size={13} /> : <Play size={13} />}
            <span>{isBuilding ? 'Building...' : 'Build'}</span>
          </button>

          <Dropdown
            trigger={
              <button
                aria-label="Build options"
                className="p-2 rounded-full text-[#748ea0] hover:bg-[rgba(248,255,248,0.07)] hover:text-[#f8fff8] transition-colors border border-transparent hover:border-[rgba(248,255,248,0.12)]"
              >
                <Hammer size={13} />
              </button>
            }
          >
            <DropdownItem icon={<Hammer size={14} />} onClick={handleBuild}>
              Build Flutter Web
            </DropdownItem>
            <DropdownItem icon={<Download size={14} />} onClick={handleExportZip}>
              Export as ZIP
            </DropdownItem>
          </Dropdown>
        </div>
      </div>
    </header>
  );
}
