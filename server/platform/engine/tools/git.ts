/**
 * Git and project checkpoint tools.
 *
 * Git commands go through the same sandbox policy as every other command, so
 * only the read/commit subset is reachable and nothing can run a shell. Project
 * checkpoints are engine-owned snapshots stored outside the workspace; they are
 * the guaranteed recovery point when a project is not a git repository.
 */
import { z } from 'zod';
import type { EngineerToolSpec, ToolOutcome } from '../types.js';
import { truncate, redact } from '../util.js';
import { formatSandboxResult } from './execution.js';

async function git(context: Parameters<EngineerToolSpec['invoke']>[1], args: string[], timeoutMs = 120_000): Promise<ToolOutcome> {
  const argv = ['git', ...args];
  const result = await context.sandbox.run({ argv, cwd: context.projectRoot, timeoutMs }, { signal: context.signal });
  const outcome = formatSandboxResult(result, argv.join(' '));
  outcome.content = redact(outcome.content);
  return outcome;
}

export const gitTools: EngineerToolSpec[] = [
  {
    name: 'git_status',
    description: 'Show the real Git working-tree status for the project (porcelain).',
    schema: z.object({}),
    invoke: async (_input, context) => git(context, ['status', '--porcelain=v1', '--branch']),
  },
  {
    name: 'git_diff',
    description: 'Show the real Git diff. Pass staged=true for staged changes. Output is bounded.',
    schema: z.object({ staged: z.boolean().optional(), path: z.string().optional() }),
    invoke: async (input, context) => {
      const args = ['diff', '--no-color'];
      if (input?.staged === true) args.push('--staged');
      if (typeof input?.path === 'string' && input.path.trim() !== '') args.push('--', input.path);
      const outcome = await git(context, args, 120_000);
      outcome.content = truncate(outcome.content, 30_000);
      return outcome;
    },
  },
  {
    name: 'git_log',
    description: 'Show recent Git commits for the project.',
    schema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    invoke: async (input, context) => git(context, ['log', '--oneline', `-n`, String(input?.limit ?? 10)]),
  },
  {
    name: 'git_commit',
    description: 'Stage every project change and create a real Git commit. Fails when the directory is not a git repository.',
    schema: z.object({ message: z.string().min(1).max(500) }),
    invoke: async (input, context): Promise<ToolOutcome> => {
      const add = await git(context, ['add', '-A'], 120_000);
      if (add.data?.ok !== true) return { content: `Could not stage changes.\n\n${add.content}`, data: add.data };
      const commit = await git(context, ['commit', '-m', String(input.message)], 180_000);
      if (commit.data?.ok !== true) {
        return { content: `Commit was not created.\n\n${commit.content}`, data: commit.data };
      }
      const head = await git(context, ['rev-parse', '--short', 'HEAD'], 30_000);
      return { content: `Commit created.\n\n${commit.content}\n\nHEAD: ${head.content.trim()}`, data: { ...commit.data, head: head.content.trim() } };
    },
  },
  {
    name: 'project_checkpoint_create',
    description:
      'Create an engine-owned recovery snapshot of every project source file before a risky change. Returns a checkpoint id that can be restored later.',
    schema: z.object({ label: z.string().max(200).optional() }),
    invoke: async (input, context): Promise<ToolOutcome> => {
      const record = await context.checkpoints.create(input?.label);
      return {
        content: `Checkpoint ${record.id} created with ${record.files} files (${record.label}). Path: ${record.path}`,
        data: { ...record },
      };
    },
  },
  {
    name: 'project_checkpoint_list',
    description: 'List engine-owned recovery checkpoints for this project, newest first.',
    schema: z.object({}),
    invoke: async (_input, context): Promise<ToolOutcome> => {
      const records = await context.checkpoints.list();
      if (records.length === 0) return { content: 'No checkpoints exist for this project yet.', data: { count: 0 } };
      return {
        content: records.map((record) => `${record.id}  ${new Date(record.createdAt).toISOString()}  ${record.files} files  ${record.label}`).join('\n'),
        data: { count: records.length },
      };
    },
  },
  {
    name: 'project_checkpoint_restore',
    description:
      'Restore a project checkpoint. Rewrites every file in the checkpoint and deletes source files created after it. Requires human approval.',
    schema: z.object({ id: z.string().min(1) }),
    approval: () => ({ required: true, risk: 'high', reason: 'Restoring a checkpoint overwrites and deletes current source files.' }),
    invoke: async (input, context): Promise<ToolOutcome> => {
      const result = await context.checkpoints.restore(String(input.id));
      return {
        content: `Restored checkpoint ${result.id}: ${result.restored} files rewritten, ${result.deleted} files removed.`,
        data: { ...result },
      };
    },
  },
];
