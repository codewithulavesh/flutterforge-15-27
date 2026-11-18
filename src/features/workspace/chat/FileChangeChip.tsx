import { FilePen, FilePlus, FileX, type LucideIcon } from 'lucide-react';
import './chat.css';

export type FileChangeAction = 'created' | 'modified' | 'deleted';

export interface FileChangeChipProps {
  /** Full path as reported by the agent, e.g. "lib/screens/home_screen.dart". */
  path: string;
  /** What happened to the file. Defaults to "modified". */
  action?: FileChangeAction;
  /** Optional short language tag rendered as a mini badge (e.g. "dart"). */
  language?: string;
  /** When provided the chip is a focusable button that opens the file; otherwise a static status pill. */
  onOpen?: (path: string) => void;
}

const ACTION_ICONS: Record<FileChangeAction, LucideIcon> = {
  created: FilePlus,
  modified: FilePen,
  deleted: FileX,
};

function splitPath(path: string): { directory: string; basename: string } {
  const match = /^(.*[\\/])?([^\\/]+)$/.exec(path);
  if (!match) {
    return { directory: '', basename: path };
  }
  return { directory: match[1] ?? '', basename: match[2] };
}

/**
 * Compact pill summarising a single file change. Focusable and keyboard
 * operable (native <button> semantics: Enter/Space) when `onOpen` is set;
 * otherwise a static, screen-reader-announced status pill.
 */
export function FileChangeChip({ path, action = 'modified', language, onOpen }: FileChangeChipProps) {
  const ActionIcon = ACTION_ICONS[action];
  const { directory, basename } = splitPath(path);
  const ariaLabel = `${action} ${path}`;

  const body = (
    <>
      <ActionIcon size={14} className="chat-file-chip-icon" aria-hidden="true" />
      <span className="chat-file-chip-path" title={path}>
        {directory && <span className="chat-file-chip-dir">{directory}</span>}
        <span className="chat-file-chip-base">{basename}</span>
      </span>
      {language && <span className="chat-file-chip-lang">{language}</span>}
      <span className={`chat-file-chip-badge chat-file-chip-badge--${action}`}>{action}</span>
    </>
  );

  if (onOpen) {
    return (
      <button
        type="button"
        className="chat-file-chip"
        aria-label={ariaLabel}
        title={path}
        onClick={() => onOpen(path)}
      >
        {body}
      </button>
    );
  }

  return (
    <div className="chat-file-chip chat-file-chip--static" role="status" aria-label={ariaLabel} title={path}>
      {body}
    </div>
  );
}
