import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { DashboardSidebar } from '@/features/dashboard/DashboardSidebar';
import { CreateProjectWizard } from '@/features/dashboard/CreateProjectWizard';
import { ProjectsSection } from '@/features/dashboard/sections/ProjectsSection';
import { DeploymentsSection } from '@/features/dashboard/sections/DeploymentsSection';
import { UsageSection } from '@/features/dashboard/sections/UsageSection';
import { IntegrationsSection } from '@/features/dashboard/sections/IntegrationsSection';
import { ProfileSection } from '@/features/dashboard/sections/ProfileSection';
import { SettingsSection } from '@/features/dashboard/sections/SettingsSection';
import { ShortcutsSection } from '@/features/dashboard/sections/ShortcutsSection';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useProjectStore } from '@/stores/project.store';
import { useAuthStore } from '@/stores/auth.store';
import { HERO_PROMPT_KEY } from '@/utils/landing';

const SECTION_LABELS: Array<{ path: string; label: string }> = [
  { path: '/dashboard/deployments', label: 'Deployments' },
  { path: '/dashboard/usage', label: 'Usage & credits' },
  { path: '/dashboard/integrations', label: 'Integrations' },
  { path: '/dashboard/profile', label: 'Edit profile' },
  { path: '/dashboard/settings', label: 'Settings' },
  { path: '/dashboard/shortcuts', label: 'Keyboard shortcuts' },
];

export function DashboardPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { projects, loadProjects, loading } = useProjectStore();
  const { profile, signOut } = useAuthStore();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardDescription, setWizardDescription] = useState('');
  const wizardOpenedRef = useRef(false);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Native menu / global command: open the creation wizard.
  useEffect(() => {
    const open = () => {
      setWizardDescription('');
      setWizardOpen(true);
    };
    window.addEventListener('ff:new-project', open);
    return () => window.removeEventListener('ff:new-project', open);
  }, []);

  // Prompt-first entry: a Hero prompt (via navigation state or sessionStorage
  // when it survived the signup hop) opens the wizard with it prefilled.
  useEffect(() => {
    if (wizardOpenedRef.current) return;
    const fromState = (location.state as { heroPrompt?: string } | null)?.heroPrompt?.trim();
    let fromStorage = '';
    try {
      fromStorage = (sessionStorage.getItem(HERO_PROMPT_KEY) || '').trim();
      sessionStorage.removeItem(HERO_PROMPT_KEY);
    } catch {
      // storage unavailable — state only
    }
    const heroPrompt = fromState || fromStorage;
    if (heroPrompt) {
      wizardOpenedRef.current = true;
      setWizardDescription(heroPrompt);
      setWizardOpen(true);
    }
  }, [location.state]);

  const pathname = location.pathname.replace(/\/+$/, '') || '/dashboard';
  const activeSection = SECTION_LABELS.find((section) => pathname.startsWith(section.path));
  const firstName = profile?.full_name?.split(' ')[0];

  const openWizard = () => {
    setWizardDescription('');
    setWizardOpen(true);
  };

  const openPricing = () => {
    navigate('/');
    window.setTimeout(() => {
      document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 320);
  };

  const handleSignOut = () => {
    void signOut();
  };

  return (
    <div className="ff-bold min-h-[100dvh] bg-[var(--fb-bg)] sm:p-3 lg:p-4">
      <SidebarProvider collapsible="icon" storageKey="ff-dashboard-sidebar">
        <div className="ff-dash-shell mx-auto flex h-[100dvh] w-full max-w-[1500px] overflow-hidden border-[var(--fb-line)] bg-[var(--fb-bg)] sm:h-[calc(100dvh-1.5rem)] sm:rounded-2xl sm:border lg:h-[calc(100dvh-2rem)]">
          <DashboardSidebar
            onNewProject={openWizard}
            onOpenPricing={openPricing}
            projects={projects}
          />

          <div className="relative z-0 flex min-w-0 flex-1 flex-col">
            <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--fb-line)] px-3 sm:px-5">
              <SidebarTrigger />
              <nav aria-label="Breadcrumb" className="ml-1 flex min-w-0 items-center gap-1.5 text-[13px]">
                <Link
                  className="truncate font-medium text-[var(--fb-muted)] transition-colors hover:text-[var(--fb-ink)]"
                  to="/dashboard"
                >
                  Dashboard
                </Link>
                {activeSection && (
                  <>
                    <span aria-hidden className="text-[var(--fb-dim)]">/</span>
                    <span className="truncate font-medium text-[var(--fb-ink)]">{activeSection.label}</span>
                  </>
                )}
              </nav>
              <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
                <ThemeToggle />
                <button
                  aria-label="New app"
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-[var(--fb-ink)] px-3 text-[12px] font-semibold text-[var(--fb-bg)] transition-transform hover:-translate-y-px sm:px-4"
                  onClick={openWizard}
                  type="button"
                >
                  <Plus size={14} />
                  <span className="hidden sm:inline">New app</span>
                </button>
              </div>
            </header>

            <main className="ff-scrollbar flex-1 overflow-y-auto">
              <div className="mx-auto max-w-[1200px] px-4 pb-16 pt-8 sm:px-8 sm:pb-16 sm:pt-10">
                <Routes>
                  <Route
                    index
                    element={
                      <ProjectsSection
                        firstName={firstName}
                        loading={loading}
                        onNewProject={openWizard}
                        projects={projects}
                      />
                    }
                  />
                  <Route
                    path="deployments"
                    element={
                      <DeploymentsSection loading={loading} onNewProject={openWizard} projects={projects} />
                    }
                  />
                  <Route path="usage" element={<UsageSection onOpenPricing={openPricing} />} />
                  <Route
                    path="integrations"
                    element={
                      <IntegrationsSection
                        onOpenBilling={() => navigate('/dashboard/settings#billing')}
                      />
                    }
                  />
                  <Route path="profile" element={<ProfileSection onSignOut={handleSignOut} />} />
                  <Route
                    path="settings"
                    element={
                      <SettingsSection
                        onOpenPricing={openPricing}
                        onSignOut={handleSignOut}
                        projects={projects}
                      />
                    }
                  />
                  <Route path="shortcuts" element={<ShortcutsSection />} />
                  <Route path="*" element={<Navigate replace to="/dashboard" />} />
                </Routes>
              </div>
            </main>
          </div>
        </div>
      </SidebarProvider>

      <CreateProjectWizard
        initialDescription={wizardDescription}
        onClose={() => {
          setWizardOpen(false);
          setWizardDescription('');
        }}
        open={wizardOpen}
      />
    </div>
  );
}
