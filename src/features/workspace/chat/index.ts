// Barrel export for the FlutterForge workspace chat component set.
//
// NOTE for integrators: each component imports './chat.css' itself, so
// importing from this barrel is all you need to get styles. Do NOT add a
// CSS import here — keep the side effect in one place (the components) and
// keep this barrel pure re-exports.
//
// Example:
//   import { ChatTranscript, CodeBlock, EmptyChatState } from '@/features/workspace/chat';

export { ChatMessage } from './ChatMessage';
export type { ChatMessageProps, ChatRole } from './ChatMessage';

export { ChatTranscript } from './ChatTranscript';
export type { ChatTranscriptProps, TranscriptMessage } from './ChatTranscript';

export { CodeBlock } from './CodeBlock';
export type { CodeBlockProps } from './CodeBlock';

export { FileChangeChip } from './FileChangeChip';
export type { FileChangeChipProps, FileChangeAction } from './FileChangeChip';

export { EmptyChatState } from './EmptyChatState';
export type { EmptyChatStateProps } from './EmptyChatState';

export { ErrorBanner } from './ErrorBanner';
export type { ErrorBannerProps } from './ErrorBanner';
