/**
 * Deterministic verification tools.
 *
 * These reuse FlutterForge's existing verification service rather than a new
 * implementation: the project is copied into the isolated verification
 * workspace, dependencies are resolved for real and the Dart analyzer runs.
 * `visual_qa` is the existing deterministic design/accessibility gate.
 */
import { z } from 'zod';
import { snapshotFiles } from '../../../harness/workspace.js';
import { verifyProject } from '../../../harness/verify.js';
import { analyzeVisualQa } from '../../qa/visualQa.js';
import type { EngineerDiagnostic, EngineerToolSpec, EngineerVerification, ToolContext, ToolOutcome } from '../types.js';
import { truncate } from '../util.js';

export async function collectWorkspaceFiles(root: string, options: { maxFiles?: number; maxBytes?: number } = {}) {
  const snapshot = await snapshotFiles(root);
  const maxFiles = options.maxFiles ?? 3000;
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  const files: Array<{ path: string; content: string }> = [];
  let bytes = 0;
  for (const [path, entry] of snapshot) {
    if (files.length >= maxFiles || bytes + entry.content.length > maxBytes) break;
    files.push({ path, content: entry.content });
    bytes += entry.content.length;
  }
  return { files, total: snapshot.size };
}

function mapDiagnostics(diagnostics: ReadonlyArray<{ filePath: string; line: number; severity: string; message: string; code?: string }>): EngineerDiagnostic[] {
  return diagnostics.map((item) => ({
    severity: item.severity === 'error' ? 'error' : item.severity === 'warning' ? 'warning' : 'info',
    message: item.message,
    file: item.filePath,
    line: item.line > 0 ? item.line : undefined,
    code: item.code,
  }));
}

export async function runDeterministicVerification(
  context: ToolContext,
  options: { forcePubGet?: boolean; timeoutMs?: number } = {},
): Promise<EngineerVerification> {
  return context.verify();
}

export const verifyTools: EngineerToolSpec[] = [
  {
    name: 'verify_project',
    description:
      'Run the real deterministic verification gate on the whole project: copies the workspace, runs flutter pub get and the Dart analyzer, and returns every error and warning. '
      + 'This is the only acceptable evidence for "code compiles". It can take a few minutes.',
    schema: z.object({
      forcePubGet: z.boolean().optional().describe('Re-resolve dependencies even when the pubspec hash is unchanged.'),
      timeoutMs: z.number().int().min(10_000).max(1_800_000).optional(),
    }),
    invoke: async (input, context): Promise<ToolOutcome> => {
      const verification = await runDeterministicVerification(context, {
        forcePubGet: input?.forcePubGet === true,
        timeoutMs: input?.timeoutMs,
      });
      const header = [
        `VERIFICATION ${verification.passed ? 'PASSED' : 'FAILED'}`,
        verification.summary,
        `errors=${verification.errorCount} warnings=${verification.warningCount} skipped=${verification.skipped === true}`,
      ].join('\n');
      const body = verification.diagnostics.length > 0
        ? `\n\nDiagnostics:\n${verification.diagnostics.slice(0, 80).map((item) => `- [${item.severity}] ${item.file ?? ''}${item.line ? `:${item.line}` : ''} ${item.message}`).join('\n')}`
        : '';
      return {
        content: `${header}${body}\n\n${verification.evidence.join('\n')}`,
        data: {
          verified: verification.passed,
          errorCount: verification.errorCount,
          warningCount: verification.warningCount,
          skipped: verification.skipped === true,
        },
        verification,
        diagnostics: verification.diagnostics,
      };
    },
  },
  {
    name: 'visual_qa',
    description:
      'Run the deterministic visual quality gate over Dart sources: Material 3 usage, theme tokens, semantics and responsive layout primitives. '
      + 'This checks source-level design regressions; it is not a screenshot.',
    schema: z.object({}),
    invoke: async (_input, context): Promise<ToolOutcome> => {
      const collected = await collectWorkspaceFiles(context.projectRoot);
      const dartFiles = collected.files.filter((file) => file.path.endsWith('.dart'));
      const result = analyzeVisualQa(dartFiles);
      const diagnostics: EngineerDiagnostic[] = result.diagnostics.map((item) => ({
        severity: item.severity,
        message: item.message,
        file: item.path,
        line: item.line,
      }));
      const content = result.passed
        ? `Visual QA PASSED across ${dartFiles.length} Dart files (${result.diagnostics.length} notes).`
        : `Visual QA FAILED with ${result.diagnostics.length} issue(s):\n${result.diagnostics.map((item) => `- [${item.severity}] ${item.path ?? ''}${item.line ? `:${item.line}` : ''} ${item.message}`).join('\n')}`;
      return {
        content,
        data: { passed: result.passed, issues: result.diagnostics.length },
        diagnostics,
      };
    },
  },
];
