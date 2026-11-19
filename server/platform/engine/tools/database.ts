/**
 * Database inspection tools.
 *
 * The runtime injects a least-privilege read-only port over the platform
 * SQLite database. The port (not the model) enforces SELECT-only queries,
 * table denylists and row limits; these tools merely expose it.
 */
import { z } from 'zod';
import type { EngineerToolSpec, ToolOutcome } from '../types.js';
import { truncate } from '../util.js';

export const databaseTools: EngineerToolSpec[] = [
  {
    name: 'database_schema',
    description:
      'Inspect the available database tables and their columns. This is the platform database, exposed read-only. '
      + 'Use it to understand persisted project, run, revision and memory records.',
    schema: z.object({ table: z.string().max(120).optional() }),
    invoke: async (input, context): Promise<ToolOutcome> => {
      const schema = await context.database.schema();
      const filtered = input?.table
        ? schema.filter((entry) => entry.table.toLowerCase() === String(input.table).toLowerCase())
        : schema;
      if (filtered.length === 0) return { content: `No accessible table named ${input?.table}.`, data: { tables: 0 } };
      return {
        content: filtered.map((entry) => `${entry.table}(${entry.columns.join(', ')})`).join('\n'),
        data: { tables: filtered.length },
      };
    },
  },
  {
    name: 'database_query',
    description:
      'Run a single read-only SELECT/WITH/EXPLAIN query against the platform database. '
      + 'Writes, DDL and sensitive tables are rejected by the port. Results are bounded.',
    schema: z.object({
      sql: z.string().min(1).max(8000),
      params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(50).optional(),
    }),
    invoke: async (input, context): Promise<ToolOutcome> => {
      const rows = await context.database.query(String(input.sql), input.params ?? []);
      return {
        content: truncate(JSON.stringify(rows, null, 2), 40_000),
        data: { rows: rows.length },
      };
    },
  },
];
