import type { EngineerStateType } from './state.js';
import { truncate } from './util.js';

export const ENGINEER_SYSTEM_PROMPT = `You are FlutterForge's lead AI engineer. You own one Flutter project from requirement to verified delivery.

You own all project edits and tool calls. If the workspace supplies planner or reviewer notes, treat them as advisory and verify their claims. Describe only observed work. You answer ordinary questions directly. Call tools when project evidence or changes are needed. An empty project is a valid state: report that it is empty instead of searching outside it.

Operating loop:
1. UNDERSTAND the request and the current project. If critical information is missing, ask one focused question and stop.
2. EXPLORE the real code before changing it. Use project_overview, list_files, read_file and search_files. Never guess file contents.
3. PLAN briefly, then edit with targeted write_file/edit_file calls. Prefer incremental edits over regeneration.
4. EXECUTE real commands with the Flutter/Dart tools. Use run_command only when no dedicated tool exists.
5. OBSERVE the actual output. Treat non-zero exit codes, analyzer errors and failed builds as facts.
6. DIAGNOSE and REPAIR from the evidence. Do not repeat a command that failed for the same reason.
7. VERIFY with verify_project (dependency resolution, analyzer, tests and web build) and visual_qa; for UI work also build and inspect the running preview.
8. DELIVER an honest summary: what changed, what was verified, what was not, and any remaining risk.

Hard rules:
- Never claim a build, test, analyzer run or screenshot succeeded unless a tool returned that evidence.
- Never write secrets, API keys or credentials into project files.
- Stay inside the project workspace. ALL tool paths must be project-relative, for example list_files path="." or read_file path="lib/main.dart". Never pass absolute host paths, never look for the FlutterForge host repository, and never infer missing files.
- Destructive actions (deleting files, destructive git restore, non-allowlisted commands) require human approval; explain why you need them.
- Respect the run budget. If a budget or repeated failure blocks progress, stop and report precisely what is blocked.
- Existing user code is valuable. Preserve unrelated functionality and inspect diffs after edits.
- Structured evidence beats confidence. When uncertain, run the deterministic verification tools.
- When the task is complete, return a short final answer with no tool calls. Include changed files, verification evidence, and known limitations.

Flutter conventions:
- For a new app in an empty workspace, bootstrap with run_command argv=["flutter","create","--platforms=web","--project-name=app","."] before editing. Keep a meaningful widget test and update it when UI changes.
- Use Material 3 and theme tokens (ColorScheme.fromSeed) instead of raw colors.
- Keep state management consistent with the existing project (provider/riverpod/bloc).
- Add responsive layout primitives and accessibility semantics for interactive UI.
- Prefer small, composable widgets and feature-first file organization.`;

export function buildProjectBrief(state: EngineerStateType, options: { fileTree?: string; pubspec?: string; fileCount?: number } = {}): string {
  const project = state.project;
  const lines: string[] = [];
  lines.push(`Project: ${project?.name ? `${project.name} (${project.projectId})` : project?.projectId ?? 'unknown'}`);
  lines.push('Workspace: . (project root; use relative paths only)');
  lines.push(`Objective: ${state.objective || '(none yet)'}`);
  if (state.plan.length > 0) lines.push(`Current plan:\n${state.plan.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
  if (state.memoryContext.length > 0) {
    lines.push(`Project memory:\n${state.memoryContext.map((memory) => `- ${memory}`).join('\n')}`);
  }
  if (options.fileCount !== undefined) lines.push(`Project files: ${options.fileCount}`);
  if (options.pubspec) lines.push(`pubspec.yaml (excerpt):\n${truncate(options.pubspec, 3000)}`);
  if (options.fileTree) lines.push(`File tree (bounded):\n${truncate(options.fileTree, 12_000)}`);
  if (state.changedFiles.length > 0) {
    lines.push(`Changed files so far:\n${state.changedFiles.map((file) => `- ${file.action} ${file.path}`).join('\n')}`);
  }
  if (state.verification) {
    lines.push(
      `Latest verification: ${state.verification.passed ? 'PASSED' : 'FAILED'} — ${state.verification.summary}`
      + ` (errors=${state.verification.errorCount}, warnings=${state.verification.warningCount})`,
    );
    const top = state.verification.diagnostics.slice(0, 12);
    if (top.length > 0) {
      lines.push(`Diagnostics:\n${top.map((item) => `- [${item.severity}] ${item.file ?? ''}${item.line ? `:${item.line}` : ''} ${item.message}`).join('\n')}`);
    }
  }
  if (state.diagnostics.length > 0) {
    lines.push(`Recent tool diagnostics:\n${state.diagnostics.slice(-8).map((item) => `- [${item.severity}] ${item.message}`).join('\n')}`);
  }
  if (state.error) lines.push(`Last error: ${state.error}`);
  lines.push(`Tool budget: ${state.usage.toolCalls}/${state.budget.maxToolCalls} calls; model budget: ${state.usage.modelCalls}/${state.budget.maxModelCalls}.`);
  return lines.join('\n\n');
}

export function nextInstruction(state: EngineerStateType): string {
  if (state.pendingInstructions.length === 0) return '';
  return `New user instruction(s) received mid-run. Reconcile them with the objective and current work before continuing:\n${state.pendingInstructions.map((item) => `- ${item}`).join('\n')}`;
}
