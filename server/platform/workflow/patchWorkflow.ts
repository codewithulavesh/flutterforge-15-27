/**
 * Built-in workflow: `patch.apply` v1.
 *
 * The concrete proof that the control plane is durable: an ordered, typed DAG
 * that validates → applies → seals a project patch transaction. Any failure
 * before the apply step writes nothing; any failure after it leaves the
 * workspace rolled back by the transactional engine. When the request asks
 * for approval, the run parks in `waiting_approval` until a human decides.
 *
 * Steps are individually idempotent from the outside: re-running the run re-
 * executes whatever step is pending; the transactional engine makes the apply
 * step safe to retry.
 */
import path from 'node:path';
import type { WorkflowDefinition } from './engine.js';
import { PlatformError, ValidationError } from '../kernel/errors.js';
import { applyPatch, normalizePatchPath, type PatchInput } from '../patch/transaction.js';
import { getProjectWorkspace } from '../../harness/run.js';
import type { PlatformInstance } from '../instance.js';

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bsk-or-v1-[A-Za-z0-9_-]{8,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
];

export interface PatchApplyInput {
  projectId: string;
  files: PatchInput[];
  message?: string;
  /** High-risk change that must be reviewed before the workspace is touched. */
  requireApproval?: boolean;
  /** Reason surfaced in the approval card. */
  approvalReason?: string;
}

const codeExtensions = new Set(['.dart', '.ts', '.tsx', '.js', '.kt', '.swift', '.gradle', '.kts', '.java']);

export function createPatchApplyWorkflow(platform: Pick<PlatformInstance, 'config' | 'revisions' | 'audit' | 'transactionRoot'>): WorkflowDefinition {
  const transactionRoot = platform.transactionRoot;

  return {
    name: 'patch.apply',
    version: 1,
    displayName: 'Transactional patch (validate → apply → revise)',
    description:
      'Validates generated files for structural integrity and secrets, then applies them atomically and seals a project revision. Fails closed on any validation blocker.',
    steps: [
      {
        id: 'gateway',
        description: 'Entry gate: normalizes input and decides whether human approval is required before any file is written.',
        run: async (ctx) => {
          const input = ctx.input as PatchApplyInput;
          if (!input || typeof input.projectId !== 'string' || input.projectId.trim() === '') {
            throw new ValidationError('projectId is required.', { field: 'projectId' });
          }
          if (!Array.isArray(input.files) || input.files.length === 0) {
            throw new ValidationError('files[] must be a non-empty array.', { field: 'files' });
          }
          if (input.requireApproval) {
            await ctx.requestApproval({
              risk: 'high',
              reason: input.approvalReason ?? 'The change was submitted as requiring review.',
              summary: {
                projectId: input.projectId,
                fileCount: input.files.length,
                bytes: input.files.reduce((sum, file) => sum + Buffer.byteLength(file.content ?? '', 'utf8'), 0),
                message: input.message ?? '',
              },
            });
          }
          return { projectId: input.projectId, fileCount: input.files.length };
        },
      },
      {
        id: 'validate',
        dependsOn: ['gateway'],
        description: 'Deterministic pre-write gate: path rules, secret scan, balanced delimiters, pubspec sanity.',
        timeoutMs: 30_000,
        run: async (ctx) => {
          const input = ctx.input as PatchApplyInput;
          const findings = validateFiles(input.files);
          await ctx.emit('patch.validation', { findings });
          const blockers = findings.filter((f) => f.severity === 'error');
          if (blockers.length > 0) {
            throw new PlatformError({
              code: 'GATE_VALIDATION_FAILED',
              message: `${blockers.length} blocking validation issue(s); nothing was written to the project.`,
              statusCode: 422,
              details: { findings: blockers.slice(0, 25) },
            });
          }
          return { filesProcessed: input.files.length, warningCount: findings.length };
        },
      },
      {
        id: 'apply',
        dependsOn: ['validate'],
        description: 'Two-phase commit of the staged files into the project workspace.',
        timeoutMs: 60_000,
        retry: { maxAttempts: 1 }, // never blindly re-apply; the transaction itself is atomic
        run: async (ctx) => {
          const input = ctx.input as PatchApplyInput;
          const workspace = getProjectWorkspace(input.projectId);
          const result = await applyPatch({
            transactionRoot,
            workspaceRoot: workspace,
            actor: ctx.actor,
            message: input.message ?? 'Apply patch.apply workflow',
            runId: ctx.runId,
            files: input.files,
          });
          await ctx.emit('patch.applied', {
            transactionId: result.transactionId,
            filesWritten: result.filesWritten,
            filesDeleted: result.filesDeleted,
            changes: result.changes,
          });
          return {
            transactionId: result.transactionId,
            changes: result.changes,
            filesWritten: result.filesWritten,
            filesDeleted: result.filesDeleted,
          };
        },
        compensate: async (ctx) => {
          // The transactional engine already guarantees atomicity of a single
          // commit. Compensation is a no-op here; the rollback story is owned
          // by `patch` transactions, not by this workflow.
          await ctx.emit('patch.compensation_noop', { reason: 'transactional commit is atomic' });
        },
      },
      {
        id: 'revise',
        dependsOn: ['apply'],
        description: 'Seal an immutable content-addressed project revision.',
        timeoutMs: 60_000,
        run: async (ctx) => {
          const input = ctx.input as PatchApplyInput;
          const workspace = getProjectWorkspace(input.projectId);
          const revision = await platform.revisions.commitRevision({
            tenantId: ctx.tenantId,
            projectId: input.projectId,
            workspaceRoot: workspace,
            message: input.message ?? `patch.apply ${ctx.runId}`,
            actor: ctx.actor,
          });
          return { revisionId: revision.id, fileCount: revision.fileCount, totalBytes: revision.totalBytes };
        },
      },
    ],
  };
}

export interface ValidationFinding {
  severity: 'error' | 'warning';
  code: string;
  path?: string;
  message: string;
  line?: number;
}

export function validateFiles(files: PatchInput[]): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    let relative: string;
    try {
      relative = normalizePatchPath(file.path);
    } catch (error) {
      findings.push({
        severity: 'error',
        code: 'UNSAFE_PATH',
        path: String(file?.path ?? '<unknown>'),
        message: error instanceof Error ? error.message : 'Unsafe path.',
      });
      continue;
    }

    if (seen.has(relative)) {
      findings.push({ severity: 'error', code: 'DUPLICATE_PATH', path: relative, message: 'The same path appears twice in this patch.' });
    }
    seen.add(relative);

    const content = typeof file.content === 'string' ? file.content : file.content === null ? null : String(file.content);
    if (content === null || content === undefined) continue; // deletion

    for (const pattern of SECRET_PATTERNS) {
      const match = pattern.exec(content);
      if (match) {
        findings.push({
          severity: 'error',
          code: 'SECRET_IN_CODE',
          path: relative,
          message: 'A credential-like value was detected in this file. Store it in a secret manager instead.',
        });
        break;
      }
    }

    const extension = path.extname(relative).toLowerCase();
    if (codeExtensions.has(extension)) {
      findings.push(...balancedDelimiters(content, relative));
    }

    if (path.basename(relative) === 'pubspec.yaml') {
      if (!/^name:\s*[a-z][a-z0-9_]*\s*$/m.test(content)) {
        findings.push({ severity: 'error', code: 'PUBSPEC_NAME_INVALID', path: relative, message: 'pubspec.yaml must declare a valid snake_case `name:` field.' });
      }
      if (!/^environment:\s*$/m.test(content)) {
        findings.push({ severity: 'warning', code: 'PUBSPEC_ENVIRONMENT_MISSING', path: relative, message: 'pubspec.yaml has no `environment:` section.' });
      }
    }
  }

  return findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    return (a.path ?? '').localeCompare(b.path ?? '') || (a.line ?? 0) - (b.line ?? 0) || a.code.localeCompare(b.code);
  });
}

/**
 * Comment/string/interpolation-aware delimiter balance check.
 *
 * The scanner is a small mode machine, not a regex cascade. Modes: code,
 * string literals (with triple-quoted and raw variants and `${…}`
 * interpolation), line comments, and nestable block comments. Falling through
 * to unbalanced brackets anywhere — including inside interpolations — is a
 * validation error, never a silent success.
 */
export function balancedDelimiters(source: string, relative: string): ValidationFinding[] {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const openers = new Set(['{', '(', '[']);
  const stack: Array<{ char: string; line: number }> = [];
  // Mode stack lets interpolations carry their own nested strings and braces.
  const modes: Array<{ type: 'string' | 'interp'; raw?: boolean; triple?: boolean; quote?: string; braceDepth?: number }> = [];

  let line = 1;
  let offset = 0;

  const currentMode = () => modes[modes.length - 1];
  const inString = () => currentMode()?.type === 'string';
  const inInterp = () => currentMode()?.type === 'interp';

  while (offset < source.length) {
    const char = source[offset];
    const next = source[offset + 1];

    if (char === '\n') line += 1;

    // ---- inside a raw/normal string literal
    if (inString()) {
      const mode = currentMode();
      const quote = mode.quote ?? "'";
      const terminator = mode.triple ? quote.repeat(3) : quote;

      if (char === '\\' && !mode.raw) { offset += 2; continue; }
      if (source.startsWith(terminator, offset)) {
        offset += terminator.length;
        modes.pop();
        continue;
      }
      if (!mode.raw && char === '$' && next === '{') {
        modes.push({ type: 'interp', braceDepth: 1 });
        offset += 2;
        continue;
      }
      if (!mode.raw && char === '$' && /[A-Za-z_]/.test(next ?? '')) {
        offset += 2;
        while (/[A-Za-z0-9_]/.test(source[offset] ?? '')) offset += 1;
        continue;
      }
      offset += 1;
      continue;
    }

    // ---- inside ${ … } interpolation: exactly the code path, with depth accounting.
    // A string-mode `${` consumes both characters, so the FIRST `}` at the
    // outermost interpolation level closes the interpolation itself, and is
    // not matched against the code-delimiter stack.
    if (inInterp()) {
      if (char === '/' && next === '/') { offset += 2; while (offset < source.length && source[offset] !== '\n') offset += 1; continue; }
      if (char === '/' && next === '*') {
        let depthBlock = 1;
        offset += 2;
        while (offset < source.length && depthBlock > 0) {
          if (source[offset] === '\n') line += 1;
          if (source.startsWith('/*', offset)) { depthBlock += 1; offset += 2; continue; }
          if (source.startsWith('*/', offset)) { depthBlock -= 1; offset += 2; continue; }
          offset += 1;
        }
        continue;
      }

      // Nested string literal inside the interpolation.
      const rawPrefix = char === 'r' && (next === "'" || next === '"');
      const start = rawPrefix ? offset + 1 : offset;
      const q = source[start];
      if (q === "'" || q === '"') {
        const triple = source.startsWith(q.repeat(3), start);
        modes.push({ type: 'string', raw: rawPrefix, triple, quote: q });
        offset = start + (triple ? 3 : 1);
        continue;
      }

      if (openers.has(char)) {
        stack.push({ char, line });
        if (char === '{') currentMode().braceDepth = (currentMode().braceDepth ?? 1) + 1;
        offset += 1;
        continue;
      }

      if (char === '}') {
        const depth = currentMode().braceDepth ?? 1;
        if (depth === 1) {
          // This `}` closes the interpolation, not a code block.
          modes.pop();
          offset += 1;
          continue;
        }
        const top = stack.pop();
        if (!top || top.char !== '{') {
          return [imbalance(relative, line, char, '{', top)];
        }
        currentMode().braceDepth = depth - 1;
        offset += 1;
        continue;
      }

      if (pairs[char]) {
        const top = stack.pop();
        if (!top || top.char !== pairs[char]) {
          return [imbalance(relative, line, char, pairs[char], top)];
        }
        offset += 1;
        continue;
      }
      offset += 1;
      continue;
    }

    // ---- line comment in code context
    if (char === '/' && next === '/') {
      offset += 2;
      while (offset < source.length && source[offset] !== '\n') offset += 1;
      continue;
    }

    // ---- block comment, nestable in Dart
    if (char === '/' && next === '*') {
      let depthBlock = 1;
      offset += 2;
      while (offset < source.length && depthBlock > 0) {
        if (source[offset] === '\n') line += 1;
        if (source.startsWith('/*', offset)) { depthBlock += 1; offset += 2; continue; }
        if (source.startsWith('*/', offset)) { depthBlock -= 1; offset += 2; continue; }
        offset += 1;
      }
      if (depthBlock > 0) {
        return [{ severity: 'error', code: 'UNTERMINATED_LITERAL', path: relative, line, message: 'Block comment opened and never closed.' }];
      }
      continue;
    }

    // ---- string entry in code context (raw and triple variants)
    const rawPrefix = char === 'r' && (next === "'" || next === '"');
    const start = rawPrefix ? offset + 1 : offset;
    const q = source[start];
    if (q === "'" || q === '"') {
      const triple = source.startsWith(q.repeat(3), start);
      modes.push({ type: 'string', raw: rawPrefix, triple, quote: q });
      offset = start + (triple ? 3 : 1);
      continue;
    }

    if (openers.has(char)) { stack.push({ char, line }); offset += 1; continue; }
    if (pairs[char]) {
      const top = stack.pop();
      if (!top || top.char !== pairs[char]) return [imbalance(relative, line, char, pairs[char], top)];
      offset += 1;
      continue;
    }
    offset += 1;
  }

  if (currentMode()?.type === 'string') {
    return [{ severity: 'error', code: 'UNTERMINATED_LITERAL', path: relative, line, message: 'String literal opened and never closed.' }];
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    return [{ severity: 'error', code: 'DELIMITER_IMBALANCE', path: relative, line: top.line, message: `Unclosed '${top.char}' opened on line ${top.line}.` }];
  }
  return [];
}

function imbalance(relative: string, line: number, char: string, expected: string, top?: { char: string; line: number }): ValidationFinding {
  return {
    severity: 'error',
    code: 'DELIMITER_IMBALANCE',
    path: relative,
    line,
    message: top
      ? `Unbalanced '${char}' on line ${line}; expected '${expected}' to close the '${top.char}' opened on line ${top.line}.`
      : `Unmatched closing '${char}' on line ${line}.`,
  };
}
