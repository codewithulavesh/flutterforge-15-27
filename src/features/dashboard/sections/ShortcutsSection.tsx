import { Command, Keyboard, LayoutDashboard, TerminalSquare } from 'lucide-react';
import { Panel, SectionBody, SectionHeader } from './SectionShell';

const GROUPS = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    description: 'Move around the project list without touching the mouse.',
    items: [
      { keys: ['MOD', 'B'], action: 'Expand or collapse the sidebar' },
      { keys: ['/'], action: 'Focus project search' },
      { keys: ['Esc'], action: 'Close a dialog or clear search' },
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    icon: TerminalSquare,
    description: 'Shortcuts inside a project workbench.',
    items: [
      { keys: ['MOD', 'K'], action: 'Open the command palette' },
      { keys: ['MOD', 'P'], action: 'Quick-open a file' },
      { keys: ['MOD', 'S'], action: 'Save the current file' },
      { keys: ['MOD', '↵'], action: 'Send the prompt or generate' },
      { keys: ['MOD', '⇧', 'P'], action: 'Open the command palette' },
    ],
  },
];

export function ShortcutsSection() {
  const isMac =
    typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  const mod = isMac ? 'Cmd' : 'Ctrl';

  return (
    <SectionBody>
      <SectionHeader
        description={`Speed up the workbench. ${isMac ? 'On Windows and Linux, use Ctrl instead of Cmd.' : 'On macOS, use Cmd instead of Ctrl.'}`}
        eyebrow="Account"
        title="Keyboard shortcuts"
      />

      <div className="grid items-start gap-4 lg:grid-cols-2">
        {GROUPS.map((group) => {
          const Icon = group.icon;
          return (
            <Panel
              actions={
                <span className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--fb-line)] bg-[var(--fb-soft)] text-[var(--fb-muted)]">
                  <Icon aria-hidden size={15} />
                </span>
              }
              description={group.description}
              key={group.id}
              title={group.label}
            >
              <ul className="divide-y divide-[var(--fb-line)]">
                {group.items.map((item) => (
                  <li className="flex items-center justify-between gap-4 px-4 py-3" key={`${group.id}-${item.action}-${item.keys.join('-')}`}>
                    <span className="text-[12.5px] text-[var(--fb-muted)]">{item.action}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {item.keys.map((key, index) => (
                        <kbd
                          className="grid h-6 min-w-6 place-items-center rounded-md border border-[var(--fb-line)] bg-[var(--fb-soft)] px-1.5 font-mono text-[10.5px] font-medium text-[var(--fb-ink)]"
                          key={`${key}-${index}`}
                        >
                          {key === 'MOD' ? mod : key}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          );
        })}
      </div>

      <Panel description="Available anywhere in the signed-in app." title="Global">
        <div className="flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <span className="grid h-10 w-10 place-items-center rounded-xl border border-[var(--fb-line)] bg-[var(--fb-soft)] text-[var(--fb-muted)]">
            <Command size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-medium text-[var(--fb-ink)]">Command palette</p>
            <p className="text-[11px] text-[var(--fb-dim)]">
              Jump to files, switch views and run project actions from one search box.
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-1">
            {[mod, 'K'].map((key, index) => (
              <kbd
                className="grid h-7 min-w-7 place-items-center rounded-md border border-[var(--fb-line)] bg-[var(--fb-soft)] px-2 font-mono text-[11px] font-medium"
                key={`${key}-${index}`}
              >
                {key}
              </kbd>
            ))}
          </span>
        </div>
      </Panel>

      <p className="flex items-center gap-1.5 text-[11px] text-[var(--fb-dim)]">
        <Keyboard aria-hidden size={13} />
        Shortcuts are ignored while typing in a text field.
      </p>
    </SectionBody>
  );
}
