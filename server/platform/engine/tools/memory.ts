/**
 * Project memory tools (long-term, project-scoped).
 *
 * The store is the existing `project_memory` table behind `MemoryPort`; reads
 * and writes are always scoped by tenant + project by the port implementation.
 */
import { z } from 'zod';
import type { EngineerToolSpec, ToolOutcome } from '../types.js';

export const memoryTools: EngineerToolSpec[] = [
  {
    name: 'memory_recall',
    description: 'Recall durable project decisions, constraints and facts recorded in earlier sessions.',
    schema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    invoke: async (input, context): Promise<ToolOutcome> => {
      const entries = await context.memory.list(context.projectId, input?.limit ?? 20);
      if (entries.length === 0) return { content: 'No project memories recorded yet.', data: { count: 0 } };
      return {
        content: entries.map((entry) => `- [${entry.kind}] ${entry.content}`).join('\n'),
        data: { count: entries.length },
      };
    },
  },
  {
    name: 'memory_remember',
    description:
      'Record a durable, project-scoped fact, decision or constraint that future sessions must know. '
      + 'Do not store secrets, credentials or transient build output.',
    schema: z.object({
      kind: z.enum(['decision', 'constraint', 'fact', 'summary']),
      content: z.string().min(3).max(4000),
      confidence: z.number().min(0).max(1).optional(),
    }),
    invoke: async (input, context): Promise<ToolOutcome> => {
      const entry = await context.memory.put(context.projectId, {
        kind: input.kind,
        content: input.content,
        source: `engine:${context.runId}`,
        confidence: input.confidence ?? 0.8,
      });
      return { content: `Remembered ${entry.kind}: ${entry.content}`, data: { id: entry.id } };
    },
  },
];
