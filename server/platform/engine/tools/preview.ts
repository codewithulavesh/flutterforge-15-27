/**
 * Preview and process management tools.
 *
 * The adapter is the existing preview service: the same code path that serves
 * the user's preview panel builds and runs the app. These tools therefore
 * operate a real process, not a simulation.
 */
import { z } from 'zod';
import type { EngineerToolSpec, PreviewStatus, ToolOutcome } from '../types.js';
import { sleep, truncate } from '../util.js';
import { collectWorkspaceFiles } from './verify.js';

async function waitForPreview(
  preview: Parameters<EngineerToolSpec['invoke']>[1]['preview'],
  projectId: string,
  initial: PreviewStatus | null,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<PreviewStatus | null> {
  let status = initial;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return status;
    if (status && status.status !== 'building') return status;
    await sleep(1500);
    status = preview.status(projectId);
  }
  return status;
}

function describePreview(status: PreviewStatus | null): string {
  if (!status) return 'No preview session exists for this project.';
  return [
    `Preview ${status.status}: session=${status.sessionId}`,
    `url=${status.url ?? '(none)'} port=${status.port ?? '(none)'}`,
    status.diagnostics && status.diagnostics.length > 0
      ? `diagnostics:\n${status.diagnostics.slice(0, 20).map((item) => `- [${item.severity}] ${item.file ?? ''}${item.line ? `:${item.line}` : ''} ${item.message}`).join('\n')}`
      : '',
    status.logs.length > 0 ? `recent logs:\n${truncate(status.logs.slice(-40).join('\n'), 8000)}` : '',
  ].filter(Boolean).join('\n');
}

export const previewTools: EngineerToolSpec[] = [
  {
    name: 'preview_start',
    description:
      'Build and run the current project as a real web preview, then wait until it is running or has failed. Returns the preview URL and the real build logs.',
    schema: z.object({ timeoutMs: z.number().int().min(10_000).max(900_000).optional() }),
    invoke: async (input, context): Promise<ToolOutcome> => {
      const collected = await collectWorkspaceFiles(context.projectRoot);
      if (collected.files.length === 0) throw new Error('The project workspace is empty; nothing to preview.');
      context.emit({ type: 'progress', phase: 'building', message: 'Building the web preview.' });
      const started = await context.preview.start(context.projectId, collected.files);
      let status = context.preview.status(context.projectId);
      status = await waitForPreview(context.preview, context.projectId, status ?? {
        sessionId: started.sessionId,
        projectId: context.projectId,
        status: started.status === 'running' ? 'running' : 'building',
        url: started.url,
        port: null,
        logs: [],
      }, context.signal, input?.timeoutMs ?? 300_000);
      const ok = status?.status === 'running';
      return {
        content: describePreview(status) + (ok ? '' : '\n\nRESULT: preview is not running.'),
        data: { running: ok, status: status?.status ?? 'unknown', url: status?.url ?? null, sessionId: status?.sessionId ?? null },
      };
    },
  },
  {
    name: 'preview_status',
    description: 'Inspect the current preview process: status, URL, port and recent real logs.',
    schema: z.object({}),
    invoke: async (_input, context): Promise<ToolOutcome> => {
      const status = context.preview.status(context.projectId);
      return { content: describePreview(status), data: status ? { ...status } : { status: 'none' } };
    },
  },
  {
    name: 'preview_reload',
    description: 'Hot-reload a running preview (restart=true for a full restart).',
    schema: z.object({ restart: z.boolean().optional() }),
    invoke: async (input, context): Promise<ToolOutcome> => {
      const result = context.preview.reload(context.projectId, { restart: input?.restart === true });
      return { content: result.ok ? `Preview ${input?.restart ? 'restarted' : 'reloaded'}: ${JSON.stringify(result.body)}` : `Preview reload failed: ${JSON.stringify(result.body)}`, data: result.body };
    },
  },
  {
    name: 'preview_stop',
    description: 'Stop the preview process and free its port.',
    schema: z.object({}),
    invoke: async (_input, context): Promise<ToolOutcome> => {
      const status = context.preview.status(context.projectId);
      if (!status) return { content: 'No preview session to stop.', data: { stopped: false } };
      const stopped = context.preview.stop(status.sessionId);
      return { content: stopped ? `Stopped preview ${status.sessionId}.` : `Preview ${status.sessionId} could not be stopped.`, data: { stopped } };
    },
  },
];
