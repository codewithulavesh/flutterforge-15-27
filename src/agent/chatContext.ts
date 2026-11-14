export interface ChatContextInput {
  projectName: string;
  projectDescription?: string | null;
  files: Array<{ path: string; content: string; is_directory?: boolean }>;
  messages: Array<{ role: string; content: string }>;
  activeFile?: string | null;
  buildErrors?: string[];
  question?: string;
  attachedFiles?: string[];
}

export interface ChatContextOutput {
  summary: string;
  history: Array<{ role: string; content: string }>;
  tokenEstimate: number;
}

export class ChatContextHandler {
  public static build(input: ChatContextInput): ChatContextOutput {
    const fileCount = input.files.filter((f) => !f.is_directory).length;
    const summary = `${input.projectName} (${fileCount} files)`;
    const history = input.messages.slice(-6).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const totalChars = (input.projectName.length) + (input.projectDescription?.length || 0) + history.reduce((sum, h) => sum + h.content.length, 0);
    const tokenEstimate = Math.max(120, Math.ceil(totalChars / 4));
    return { summary, history, tokenEstimate };
  }
}
