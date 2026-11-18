import { useNavigate } from 'react-router-dom';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  ChevronDown,
  FileCode2,
  Layers,
  ShoppingCart,
  Users,
  UtensilsCrossed,
  Wallet,
  Database,
  HardDrive,
} from 'lucide-react';
import { useProjectStore } from '@/stores/project.store';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { TEMPLATES } from '@/utils/constants';
import { detectSupabaseNeed } from '@/utils/backendNeed';
import { toast } from '@/components/ui/Toast';
import { cn } from '@/utils/cn';
import type { Template } from '@/types';

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  FileCode2,
  ShoppingCart,
  LayoutDashboard,
  Users,
  ShieldCheck,
  Wallet,
  UtensilsCrossed,
  MessageSquare,
};

const MAX_PROMPT = 2000;

const STATE_LABELS: Record<string, string> = { provider: 'Provider', riverpod: 'Riverpod', bloc: 'BLoC' };
const THEME_LABELS: Record<string, string> = { dark: 'Dark', light: 'Light', system: 'System' };
const PLATFORM_LABELS: Record<string, string> = {
  web: 'Web',
  mobile: 'Mobile',
  desktop: 'Desktop',
  macos: 'macOS',
  windows: 'Windows',
};

function SettingSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <label className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#748ea0]" htmlFor={id}>
        {label}
      </label>
      <select
        className="h-10 w-full rounded-xl border border-[rgba(248,255,248,0.14)] bg-[#00101e] px-3 text-[12.5px] text-[#f8fff8] outline-none transition-all focus:border-[var(--fb-lime)] focus:ring-1 focus:ring-[var(--fb-lime)]"
        id={id}
        onChange={(e) => onChange(e.target.value)}
        value={value}
      >
        {children}
      </select>
    </div>
  );
}

export function CreateProjectWizard({
  open,
  onClose,
  initialDescription = '',
}: {
  open: boolean;
  onClose: () => void;
  initialDescription?: string;
}) {
  const navigate = useNavigate();
  const { createProject } = useProjectStore();

  const [prompt, setPrompt] = useState(initialDescription);
  const [name, setName] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<Template>(TEMPLATES[0]);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Advanced options (sensible defaults)
  const [flutterVersion, setFlutterVersion] = useState('3.24.0');
  const [stateManagement, setStateManagement] = useState('provider');
  const [themeMode, setThemeMode] = useState('dark');
  const [platform, setPlatform] = useState('web');
  const [backendMode, setBackendMode] = useState<'auto' | 'supabase' | 'local'>('auto');
  const [loading, setLoading] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const promptId = useId();
  const advancedId = useId();

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

  // Sync initial description from Hero or dashboard
  const prevOpen = useRef(open);
  useEffect(() => {
    if (open && !prevOpen.current) {
      if (initialDescription) {
        setPrompt(initialDescription);
        if (!name) {
          const words = initialDescription.trim().split(/\s+/).slice(0, 3).join(' ');
          setName(words.length > 20 ? 'My Flutter App' : words);
        }
      }
      setTimeout(() => textareaRef.current?.focus(), 60);
    }
    prevOpen.current = open;
  }, [open, initialDescription, name]);

  // Live read-out of what "Auto" backend mode would decide.
  const autoNeedsSupabase = useMemo(
    () => detectSupabaseNeed(`${prompt} ${name} ${selectedTemplate.description}`),
    [prompt, name, selectedTemplate.description],
  );
  const willUseSupabase = backendMode === 'supabase' ? true : backendMode === 'local' ? false : autoNeedsSupabase;

  const settingsSummary = [
    STATE_LABELS[stateManagement] ?? stateManagement,
    THEME_LABELS[themeMode] ?? themeMode,
    PLATFORM_LABELS[platform] ?? platform,
    willUseSupabase ? 'Supabase' : 'Local',
  ].join(' · ');

  function reset() {
    setPrompt('');
    setName('');
    setSelectedTemplate(TEMPLATES[0]);
    setShowAdvanced(false);
    setFlutterVersion('3.24.0');
    setStateManagement('provider');
    setThemeMode('dark');
    setPlatform('web');
    setBackendMode('auto');
  }

  function handleSelectTemplate(tpl: Template) {
    setSelectedTemplate(tpl);
    if (!prompt.trim() || TEMPLATES.some((t) => t.defaultPrompt === prompt)) {
      setPrompt(tpl.defaultPrompt || tpl.description);
    }
    if (!name.trim() || TEMPLATES.some((t) => t.suggestedName === name)) {
      setName(tpl.suggestedName || tpl.name);
    }
  }

  async function handleCreate() {
    if (loading) return;
    const finalPrompt = prompt.trim();
    if (!finalPrompt) {
      textareaRef.current?.focus();
      return;
    }

    const finalName = name.trim() || selectedTemplate.suggestedName || 'My Flutter App';
    const usesSupabase = backendMode === 'supabase'
      ? true
      : backendMode === 'local'
        ? false
        : detectSupabaseNeed(`${finalPrompt} ${finalName} ${selectedTemplate.description}`);
    setLoading(true);

    let project;
    try {
      project = await createProject({
        name: finalName,
        description: finalPrompt,
        template: selectedTemplate.id,
        flutter_version: flutterVersion,
        state_management: stateManagement,
        theme_mode: themeMode,
        platform,
      });
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not create the project. Check your connection and try again.');
      return;
    } finally {
      setLoading(false);
    }

    if (project) {
      const backendLine = usesSupabase
        ? 'Supabase (auth where useful, database, RLS)'
        : 'None — local only (no auth, no database, no SQL)';
      const backendRequirements = usesSupabase
        ? 'Include Supabase initialization, auth where useful, RLS SQL migrations, complete services and screens.'
        : 'Do NOT use Supabase or any backend. Keep state local (shared_preferences/Hive if persistence is needed). No SQL, no auth screens, no service layer.';

      const richPrompt =
        `Build a production-grade Flutter ${selectedTemplate.name} app called "${finalName}".\n\n` +
        `Project: ${finalName}\n` +
        `Template: ${selectedTemplate.id} - ${selectedTemplate.description}\n` +
        `Description: ${finalPrompt}\n` +
        `Platform: ${platform}\n` +
        `Backend: ${backendLine}\n` +
        `State Management: ${stateManagement}\n` +
        `Theme Mode: ${themeMode}\n` +
        `Flutter Version: ${flutterVersion}\n\n` +
        `Requirements: Generate complete, runnable Flutter code with Material 3, a coherent theme, responsive layouts and every requested feature. ${backendRequirements}`;

      reset();
      onClose();
      // Persist the first prompt for this project. Route state is consumed and
      // cleared by the workspace; the storage copy survives StrictMode
      // double-mounts and a reload between create and first render.
      try {
        localStorage.setItem(`ff-handoff:${project.id}`, richPrompt);
      } catch {
        // private mode / storage unavailable — route state still works
      }
      toast('success', `Created ${finalName}! Generating app...`);
      navigate(`/project/${project.id}`, {
        state: {
          initialPrompt: finalPrompt,
          richPrompt,
          template: selectedTemplate.id,
          projectName: finalName,
          platform,
          usesSupabase,
          stateManagement,
          themeMode,
        },
      });
    } else {
      toast('error', useProjectStore.getState().error ?? 'Could not create the project. Check your connection and try again.');
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleCreate();
    }
  }

  function handleClose() {
    reset();
    onClose();
  }

  const remaining = MAX_PROMPT - prompt.length;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Create Flutter App"
      size="md"
      variant="metallic"
      className="p-4 sm:p-6"
    >
      <div className="ff-fade-in flex flex-col">
        {/* Scrollable body (keeps footer visible on short / mobile screens) */}
        <div className="max-h-[calc(100dvh-13rem)] space-y-5 overflow-y-auto overscroll-contain pr-0.5 sm:max-h-[calc(100dvh-14rem)]">
          {/* Prompt — main focus */}
          <section>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <label
                className="font-mono text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--fb-lime)]"
                htmlFor={promptId}
              >
                What do you want to build?
              </label>
              <span className="hidden font-mono text-[10px] uppercase tracking-wider text-[#748ea0] sm:inline">
                {isMac ? '⌘' : 'Ctrl'} + Enter to generate
              </span>
            </div>
            <textarea
              className="min-h-[110px] w-full resize-none rounded-2xl border border-[rgba(248,255,248,0.14)] bg-white/5 p-3.5 text-base leading-relaxed text-[#f8fff8] placeholder:text-[rgba(248,255,248,0.35)] outline-none transition-all focus:border-[var(--fb-lime)] focus:ring-2 focus:ring-[var(--fb-lime)]/20 sm:min-h-[100px] sm:text-sm"
              id={promptId}
              maxLength={MAX_PROMPT}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe your Flutter app… e.g. E-commerce store with catalog, cart, Stripe checkout, and Supabase auth."
              ref={textareaRef}
              rows={4}
              value={prompt}
            />
            <div className="mt-1.5 flex items-center justify-between text-[11px] text-[#748ea0]">
              <span>The more specific you are, the better the first build.</span>
              <span className={cn('font-mono tabular-nums', remaining < 100 ? 'font-semibold text-rose-400' : 'text-[#748ea0]')}>
                {prompt.length}/{MAX_PROMPT}
              </span>
            </div>
          </section>

          {/* App name */}
          <section>
            <label
              className="mb-1.5 block font-mono text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--fb-lime)]"
              htmlFor={`${promptId}-name`}
            >
              App name <span className="font-normal normal-case tracking-normal text-[#748ea0]">(optional)</span>
            </label>
            <input
              className="h-11 w-full rounded-xl border border-[rgba(248,255,248,0.14)] bg-white/5 px-3.5 text-[13.5px] text-[#f8fff8] placeholder:text-[rgba(248,255,248,0.35)] outline-none transition-all focus:border-[var(--fb-lime)] focus:ring-2 focus:ring-[var(--fb-lime)]/20"
              id={`${promptId}-name`}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. ShopFlow, HabitPulse"
              value={name}
            />
          </section>

          {/* Archetypes */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--fb-lime)]">
                Start from an archetype
              </span>
              {selectedTemplate.id !== 'blank' && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--fb-lime)]/30 bg-[var(--fb-lime)]/10 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-[var(--fb-lime)]">
                  <span className="h-1 w-1 rounded-full bg-[var(--fb-lime)]" />
                  {selectedTemplate.name}
                </span>
              )}
            </div>

            <div
              aria-label="Archetype"
              className="grid grid-cols-2 gap-2 sm:grid-cols-3"
              role="group"
            >
              {TEMPLATES.map((tpl) => {
                const Icon = TEMPLATE_ICONS[tpl.icon] ?? FileCode2;
                const isSelected = selectedTemplate.id === tpl.id;

                return (
                  <button
                    aria-pressed={isSelected}
                    className={cn(
                      'group flex min-h-[46px] items-center gap-2.5 rounded-[16px] border px-3 py-2 text-left text-xs transition-all',
                      isSelected
                        ? 'border-[var(--fb-lime)] bg-[var(--fb-lime)]/15 font-bold text-[#f8fff8] shadow-[0_0_16px_-2px_rgba(197,250,117,0.25)]'
                        : 'border-[rgba(248,255,248,0.12)] bg-white/5 font-medium text-[rgba(248,255,248,0.85)] hover:-translate-y-px hover:border-[rgba(248,255,248,0.25)] hover:bg-white/10 hover:text-white',
                    )}
                    key={tpl.id}
                    onClick={() => handleSelectTemplate(tpl)}
                    title={tpl.description}
                    type="button"
                  >
                    <span
                      className={cn(
                        'flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors',
                        isSelected
                          ? 'bg-[var(--fb-lime)] text-[#00101e] shadow-sm'
                          : 'border border-[rgba(248,255,248,0.1)] bg-white/5 text-[#748ea0] group-hover:text-white',
                      )}
                    >
                      <Icon size={14} className={isSelected ? 'text-[#00101e]' : undefined} />
                    </span>
                    <span className="min-w-0 truncate">{tpl.name}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Settings */}
          <section className="rounded-2xl border border-[rgba(248,255,248,0.12)] bg-white/5 overflow-hidden transition-colors">
            <button
              aria-controls={advancedId}
              aria-expanded={showAdvanced}
              className="flex min-h-[46px] w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left text-xs font-medium text-[rgba(248,255,248,0.85)] transition-colors hover:text-white hover:bg-white/5"
              onClick={() => setShowAdvanced((v) => !v)}
              type="button"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Layers className="shrink-0 text-[var(--fb-lime)]" size={14} />
                <span className="shrink-0 font-semibold text-white">Settings</span>
                <span className="truncate font-mono text-[10.5px] text-[#748ea0]">{settingsSummary}</span>
              </span>
              <ChevronDown
                className={cn('shrink-0 text-[#748ea0] transition-transform duration-200', showAdvanced && 'rotate-180 text-[var(--fb-lime)]')}
                size={14}
              />
            </button>

            {showAdvanced && (
              <div className="ff-fade-in space-y-3.5 border-t border-[rgba(248,255,248,0.1)] p-3.5" id={advancedId}>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <SettingSelect label="State management" onChange={setStateManagement} value={stateManagement}>
                    <option value="provider">Provider</option>
                    <option value="riverpod">Riverpod</option>
                    <option value="bloc">BLoC</option>
                  </SettingSelect>

                  <SettingSelect label="Theme preset" onChange={setThemeMode} value={themeMode}>
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                    <option value="system">System</option>
                  </SettingSelect>

                  <SettingSelect
                    label="Backend"
                    onChange={(v) => setBackendMode(v as 'auto' | 'supabase' | 'local')}
                    value={backendMode}
                  >
                    <option value="auto">Auto (only if needed)</option>
                    <option value="supabase">Supabase</option>
                    <option value="local">Local only</option>
                  </SettingSelect>

                  <SettingSelect label="Platform" onChange={setPlatform} value={platform}>
                    <option value="web">Web</option>
                    <option value="mobile">Mobile (iOS + Android)</option>
                    <option value="desktop">Desktop (macOS + Windows)</option>
                    <option value="macos">macOS only</option>
                    <option value="windows">Windows only</option>
                  </SettingSelect>

                  <SettingSelect label="Flutter version" onChange={setFlutterVersion} value={flutterVersion}>
                    <option value="3.24.0">3.24.0 (Stable)</option>
                    <option value="3.22.0">3.22.0</option>
                  </SettingSelect>
                </div>

                {/* What the backend decision will be */}
                <p
                  className={cn(
                    'flex items-start gap-2.5 rounded-xl px-3 py-2.5 text-[11px] leading-relaxed',
                    willUseSupabase
                      ? 'border border-[var(--fb-lime)]/30 bg-[var(--fb-lime)]/10 text-[var(--fb-lime)]'
                      : 'border border-[rgba(248,255,248,0.12)] bg-white/5 text-[rgba(248,255,248,0.7)]',
                  )}
                >
                  {willUseSupabase ? (
                    <Database className="mt-0.5 shrink-0 text-[var(--fb-lime)]" size={14} />
                  ) : (
                    <HardDrive className="mt-0.5 shrink-0 text-[#748ea0]" size={14} />
                  )}
                  <span>
                    {willUseSupabase
                      ? 'Supabase will be set up with auth, database tables and RLS policies.'
                      : 'Local-only app — no backend, auth or SQL will be generated.'}
                    {backendMode === 'auto' && ' (detected from your description)'}
                  </span>
                </p>
              </div>
            )}
          </section>
        </div>

        {/* Footer */}
        <div className="mt-5 flex flex-col-reverse gap-2.5 border-t border-[rgba(248,255,248,0.12)] pt-4 sm:flex-row sm:items-center sm:justify-end">
          <button
            className="inline-flex h-10 w-full items-center justify-center rounded-full border border-[rgba(248,255,248,0.25)] bg-transparent px-5 text-xs font-bold uppercase tracking-wider text-white transition-all hover:bg-white/10 sm:w-auto"
            onClick={handleClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-[var(--fb-lime)] px-6 text-xs font-bold uppercase tracking-wider text-[#00101e] transition-all hover:-translate-y-px hover:shadow-[0_4px_20px_rgba(197,250,117,0.35)] disabled:opacity-40 disabled:pointer-events-none sm:w-auto"
            disabled={!prompt.trim() || loading}
            onClick={handleCreate}
            type="button"
          >
            {loading ? (
              <span className="size-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
            ) : (
              <Sparkles className="text-[#00101e]" size={14} />
            )}
            <span>Generate App</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}