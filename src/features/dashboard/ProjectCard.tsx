import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import {
  MoreVertical,
  FolderOpen,
  Copy,
  Trash2,
  Download,
  Pencil,
  ArrowUpRight,
  FileCode2,
  ShoppingCart,
  LayoutDashboard,
  Users,
  ShieldCheck,
  Wallet,
  UtensilsCrossed,
  MessageSquare,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Project } from '@/types';
import { Dropdown, DropdownItem } from '@/components/ui/Dropdown';
import { useProjectStore } from '@/stores/project.store';
import { toast } from '@/components/ui/Toast';
import { downloadProjectById, formatBytes } from '@/utils/exportProject';
import { timeAgo } from '@/utils/time';
import { TEMPLATES } from '@/utils/constants';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { cn } from '@/utils/cn';

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

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  created: { label: 'Created', className: 'bg-[var(--fb-dim)]' },
  generating: { label: 'Generating', className: 'bg-amber-400 animate-pulse' },
  ready: { label: 'Ready', className: 'bg-[var(--fb-accent)]' },
  building: { label: 'Building', className: 'bg-sky-400' },
  built: { label: 'Built', className: 'bg-[var(--fb-accent)]' },
  failed: { label: 'Failed', className: 'bg-red-400' },
  deployed: { label: 'Deployed', className: 'bg-emerald-400' },
};

export function ProjectCard({ project, index }: { project: Project; index: number }) {
  const navigate = useNavigate();
  const { deleteProject, duplicateProject, updateProject } = useProjectStore();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [newName, setNewName] = useState(project.name);

  async function handleRename() {
    if (!newName.trim()) return;
    const renamed = await updateProject(project.id, { name: newName.trim() });
    if (renamed) {
      setRenameOpen(false);
      toast('success', 'Project renamed');
    } else {
      toast('error', useProjectStore.getState().error ?? 'Could not rename the project.');
    }
  }

  async function handleDelete() {
    const deleted = await deleteProject(project.id);
    if (deleted) {
      setDeleteOpen(false);
      toast('success', 'Project deleted');
    } else {
      toast('error', useProjectStore.getState().error ?? 'Could not delete the project.');
    }
  }

  async function handleDuplicate() {
    const duplicated = await duplicateProject(project.id);
    if (duplicated) toast('success', 'Project duplicated');
    else toast('error', useProjectStore.getState().error ?? 'Could not duplicate the project.');
  }

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    toast('info', `Preparing ${project.name} for download...`);
    try {
      const built = await downloadProjectById(project);
      toast('success', `Downloaded ${built.filename} (${built.fileCount} files, ${formatBytes(built.bytes)})`);
    } catch (err) {
      toast('error', err instanceof Error ? `Export failed: ${err.message}` : 'Export failed');
    }
    setExporting(false);
  }

  const template = TEMPLATES.find((t) => t.id === project.template);
  const templateLabel = template?.name ?? project.template;
  const templateIconName = template?.icon ?? 'FileCode2';
  const TemplateIcon = TEMPLATE_ICONS[templateIconName] ?? FileCode2;
  // Distinct accent per card: rotate the hue by the golden angle so no two
  // cards on screen ever share an accent, even with repeated templates.
  const hue = Math.round((index * 137.508) % 360);
  const accent = `hsl(${hue} 78% 62%)`;
  const accentSoft = `hsl(${hue} 78% 65% / 0.13)`;
  const accentGlow = `hsl(${hue} 78% 65% / 0.22)`;
  const numeral = String(index + 1).padStart(3, '0');
  const status = STATUS_LABELS[project.status] ?? { label: project.status, className: 'bg-[var(--fb-dim)]' };

  return (
    <>
      <article className="group relative flex flex-col overflow-hidden rounded-[28px] border border-[var(--fb-line)] bg-[var(--fb-card)] shadow-[0_20px_48px_-18px_rgba(0,16,30,0.4)] transition-all duration-200 hover:-translate-y-1 hover:border-[var(--fb-lime)]/50 hover:shadow-[0_24px_54px_-16px_rgba(0,16,30,0.5)]">
        {/* Cover */}
        <div
          className="relative h-24 shrink-0 overflow-hidden border-b border-[var(--fb-line)]"
          style={{
            background: `linear-gradient(135deg, ${accentSoft} 0%, transparent 70%)`,
          }}
        >
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              background: `radial-gradient(circle at 85% 15%, ${accentGlow} 0%, transparent 55%)`,
            }}
          />
          <div className="absolute left-4 top-4 flex h-10 w-10 items-center justify-center rounded-[12px] bg-black/40 text-[var(--fb-ink)] backdrop-blur-sm border border-white/10" style={{ color: accent }}>
            <TemplateIcon size={18} />
          </div>
          <div className="absolute right-3 top-3" onClick={(e) => e.stopPropagation()}>
            <Dropdown
              trigger={
                <button
                  aria-label={`Project actions for ${project.name}`}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--fb-line)] bg-black/30 text-[var(--fb-muted)] backdrop-blur-sm transition-colors hover:border-[var(--fb-lime)] hover:text-[var(--fb-lime)]"
                  type="button"
                >
                  <MoreVertical size={14} />
                </button>
              }
            >
              <DropdownItem icon={<FolderOpen size={14} />} onClick={() => navigate(`/project/${project.id}`)}>Open</DropdownItem>
              <DropdownItem icon={<Pencil size={14} />} onClick={() => { setNewName(project.name); setRenameOpen(true); }}>Rename</DropdownItem>
              <DropdownItem icon={<Copy size={14} />} onClick={() => void handleDuplicate()}>Duplicate</DropdownItem>
              <DropdownItem icon={<Download size={14} />} onClick={() => void handleExport()}>{exporting ? 'Exporting...' : 'Export as ZIP'}</DropdownItem>
              <DropdownItem icon={<Trash2 size={14} />} danger onClick={() => setDeleteOpen(true)}>Delete</DropdownItem>
            </Dropdown>
          </div>
          <span className="absolute bottom-3 left-4 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--fb-lime)]">
            {templateLabel}
          </span>
        </div>

        {/* Body */}
        <div className="flex flex-1 flex-col p-5">
          <div className="flex items-start justify-between gap-3">
            <h3
              className="min-w-0 flex-1 truncate ffb-display text-[15px] font-bold leading-tight tracking-[-0.02em] text-[var(--fb-ink)]"
              title={project.name}
            >
              <button
                className="text-left after:absolute after:inset-0 after:rounded-[28px]"
                onClick={() => navigate(`/project/${project.id}`)}
                type="button"
              >
                {project.name}
                <span className="sr-only"> — open project</span>
              </button>
            </h3>
          </div>

          <p className="mt-2 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--fb-muted)]">
            <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', status.className)} />
            <span className="truncate">{status.label}</span>
          </p>

          <p className="mt-3 line-clamp-2 min-h-[2.6em] text-[12.5px] leading-[1.7] text-[var(--fb-muted)]">
            {project.description?.trim() || 'No brief yet. Open the project to start building.'}
          </p>

          <div className="mt-auto flex items-center justify-between border-t border-[var(--fb-line)] pt-4">
            <span className="font-mono text-[10px] text-[var(--fb-dim)]">
              {numeral} · Updated {timeAgo(project.updated_at)}
            </span>
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--fb-line)] text-[var(--fb-muted)] transition-colors group-hover:border-[var(--fb-lime)] group-hover:bg-[var(--fb-lime)] group-hover:text-[var(--fb-ink)]">
              <ArrowUpRight size={14} aria-hidden />
            </span>
          </div>
        </div>
      </article>

      {/* Rename modal */}
      <Modal open={renameOpen} onClose={() => setRenameOpen(false)} title="Rename Project" size="sm">
        <Input label="New Name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRenameOpen(false)}>Cancel</Button>
          <Button onClick={handleRename}>Save</Button>
        </div>
      </Modal>

      {/* Delete modal */}
      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete Project" size="sm">
        <p className="mb-4 break-words text-sm text-[var(--ff-text-muted)]">
          Are you sure you want to delete "{project.name}"? This action cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete}>Delete</Button>
        </div>
      </Modal>
    </>
  );
}