/**
 * `review.board` — durable review of one project by the Agent Corps.
 *
 * snapshot → review → gate
 *
 * The review is re-derived from the workspace in the `review` step rather than
 * passed through SQLite, so a resumed run never scores a stale snapshot. The
 * gate fails only on blockers; warnings are reported and do not stop a release
 * unless the caller explicitly asks for `failOn: 'warning'`.
 */
import { promises as fs } from 'node:fs';
import type { WorkflowDefinition } from '../workflow/engine.js';
import { PlatformError } from '../kernel/errors.js';
import { getProjectWorkspace } from '../../harness/run.js';
import { snapshotFiles } from '../../harness/workspace.js';
import { createReviewContext, runAgentCorps } from './runner.js';
import type { Scorecard } from './types.js';

export interface ReviewBoardInput {
  projectId: string;
  prompt?: string;
  agentIds?: string[];
  excludeInfo?: boolean;
  failOn?: 'blocker' | 'warning';
}

async function readProject(projectId: string): Promise<Array<{ path: string; content: string }>> {
  const workspace = getProjectWorkspace(projectId);
  const snapshot = await snapshotFiles(workspace);
  if (snapshot.size === 0) {
    throw new PlatformError({
      code: 'AGENT_REVIEW_EMPTY_PROJECT',
      message: 'The project workspace is empty — there is nothing to review.',
      statusCode: 422,
      details: { projectId },
    });
  }
  return [...snapshot.entries()].map(([path, entry]) => ({ path, content: entry.content }));
}

export function createReviewBoardWorkflow(): WorkflowDefinition {
  return {
    name: 'review.board',
    version: 1,
    displayName: 'Agent Corps review board',
    description:
      'Runs the twenty-agent review organisation over a project, produces a department-weighted scorecard, and fails the run on blocking findings.',
    steps: [
      {
        id: 'snapshot',
        description: 'Verify the workspace is non-empty and record its size before reviewing.',
        timeoutMs: 30_000,
        retry: { maxAttempts: 1 },
        run: async (ctx) => {
          const input = ctx.input as ReviewBoardInput;
          const projectId = String(input?.projectId ?? ctx.projectId ?? '').trim();
          if (!projectId) {
            throw new PlatformError({ code: 'AGENT_REVIEW_PROJECT_MISSING', message: 'projectId is required.', statusCode: 422 });
          }
          const files = await readProject(projectId);
          await ctx.emit('review.board.snapshot', { projectId, files: files.length });
          return { projectId, fileCount: files.length };
        },
      },
      {
        id: 'review',
        dependsOn: ['snapshot'],
        description: 'Run the selected agents and aggregate the scorecard.',
        timeoutMs: 120_000,
        retry: { maxAttempts: 1 },
        run: async (ctx) => {
          const input = ctx.input as ReviewBoardInput;
          const projectId = String(input?.projectId ?? ctx.projectId ?? '').trim();
          const files = await readProject(projectId);
          const context = createReviewContext({
            projectId,
            files,
            prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
          });
          const scorecard = await runAgentCorps(context, {
            agentIds: Array.isArray(input.agentIds) ? input.agentIds : undefined,
            excludeInfo: input.excludeInfo === true,
          });
          await ctx.emit('review.board.completed', {
            projectId,
            verdict: scorecard.verdict,
            score: scorecard.overallScore,
            blockers: scorecard.stats.blockers,
            agents: scorecard.stats.agents,
          });
          return scorecard;
        },
      },
      {
        id: 'gate',
        dependsOn: ['review'],
        description: 'Fail closed on blockers (or warnings when failOn=warning).',
        timeoutMs: 15_000,
        retry: { maxAttempts: 1 },
        run: async (ctx) => {
          const input = ctx.input as ReviewBoardInput;
          const scorecard = ctx.outputs.review as Scorecard;
          const failOn = input?.failOn === 'warning' ? 'warning' : 'blocker';
          const blocking = failOn === 'warning'
            ? scorecard.stats.blockers + scorecard.stats.majors
            : scorecard.stats.blockers;
          if (blocking > 0) {
            const first = scorecard.blockers[0];
            throw new PlatformError({
              code: 'AGENT_REVIEW_BLOCKED',
              message: `Agent review blocked the project: ${blocking} finding(s) at or above the ${failOn} threshold${first ? ` — ${first.code}: ${first.message}` : ''}`,
              statusCode: 422,
              details: {
                verdict: scorecard.verdict,
                overallScore: scorecard.overallScore,
                blockers: scorecard.stats.blockers,
                majors: scorecard.stats.majors,
                codes: Object.keys(scorecard.findingCounts).slice(0, 20),
              },
            });
          }
          await ctx.emit('review.board.passed', {
            projectId: String(input?.projectId ?? ctx.projectId ?? ''),
            score: scorecard.overallScore,
            failOn,
          });
          return { passed: true, verdict: scorecard.verdict, overallScore: scorecard.overallScore };
        },
      },
    ],
  };
}

/** Async guard used by direct API calls: returns the workspace file list. */
export async function readProjectFiles(projectId: string): Promise<Array<{ path: string; content: string }>> {
  return readProject(projectId);
}

/** Exposed for tooling that wants a count without reading content. */
export async function projectExists(projectId: string): Promise<boolean> {
  const workspace = getProjectWorkspace(projectId);
  const entries = await fs.readdir(workspace).catch(() => [] as string[]);
  return entries.some((entry) => entry !== '.flutterforge');
}
