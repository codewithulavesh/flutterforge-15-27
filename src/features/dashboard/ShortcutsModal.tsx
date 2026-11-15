import { Keyboard } from 'lucide-react';
import { DashboardDialog } from './DashboardDialog';

const GROUPS: Array<{ label: string; items: Array<{ keys: string[]; action: string }> }> = [
  {
    label: 'Dashboard',
    items: [
      { keys: ['⌘', 'B'], action: 'Expand or collapse the sidebar' },
      { keys: ['/'], action: 'Focus project search' },
      { keys: ['Esc'], action: 'Close a dialog or clear search' },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { keys: ['⌘', 'K'], action: 'Open the command palette' },
      { keys: ['⌘', 'P'], action: 'Quick-open a file' },
      { keys: ['⌘', 'S'], action: 'Save the current file' },
      { keys: ['⌘', '↵'], action: 'Send the prompt or generate' },
    ],
  },
];

export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <DashboardDialog
      description="Speed up the workbench. Use Ctrl instead of ⌘ on Windows and Linux."
      icon={<Keyboard size={18} />}
      onClose={onClose}
      open={open}
      title="Keyboard shortcuts"
    >
      <div className="space-y-5">
        {GROUPS.map((group) => (
          <section key={group.label}>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--fb-dim)]">
              {group.label}
            </h3>
            <ul className="overflow-hidden rounded-xl border border-[var(--fb-line)]">
              {group.items.map((item, index) => (
                <li
                  className={`flex items-center justify-between gap-4 px-3 py-2.5 ${
                    index > 0 ? 'border-t border-[var(--fb-line)]' : ''
                  }`}
                  key={item.action}
                >
                  <span className="text-[12.5px] text-[var(--fb-muted)]">{item.action}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {item.keys.map((key) => (
                      <kbd
                        className="grid h-6 min-w-6 place-items-center rounded-md border border-[var(--fb-line)] bg-[var(--fb-soft)] px-1.5 font-mono text-[10.5px] font-medium text-[var(--fb-ink)]"
                        key={key}
                      >
                        {key}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </DashboardDialog>
  );
}
