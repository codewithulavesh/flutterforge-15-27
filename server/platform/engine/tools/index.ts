/**
 * The single unified tool registry.
 *
 * One registry instance backs the one reasoning loop. Tool specs carry their
 * own zod schema, risk classification and implementation; this module converts
 * them to LangChain tools for binding and is the only place tools are looked
 * up by name.
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { EngineerToolSpec, RiskLevel, ToolApprovalVerdict, ToolContext, ToolOutcome } from '../types.js';
import { filesystemTools } from './filesystem.js';
import { commandTool, flutterTools } from './execution.js';
import { verifyTools } from './verify.js';
import { gitTools } from './git.js';
import { previewTools } from './preview.js';
import { browserTools } from './browser.js';
import { databaseTools } from './database.js';
import { memoryTools } from './memory.js';

export class EngineerToolRegistry {
  private readonly specs = new Map<string, EngineerToolSpec>();

  constructor(specs: readonly EngineerToolSpec[]) {
    for (const spec of specs) {
      if (this.specs.has(spec.name)) throw new Error(`Duplicate tool name: ${spec.name}`);
      this.specs.set(spec.name, spec);
    }
  }

  list(): EngineerToolSpec[] {
    return [...this.specs.values()];
  }

  names(): string[] {
    return [...this.specs.keys()];
  }

  get(name: string): EngineerToolSpec | undefined {
    return this.specs.get(name);
  }

  require(name: string): EngineerToolSpec {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`Unknown tool "${name}". Available tools: ${this.names().join(', ')}`);
    return spec;
  }

  approval(name: string, args: unknown): ToolApprovalVerdict {
    const spec = this.require(name);
    if (!spec.approval) return { required: false, risk: 'low' };
    const verdict = spec.approval(args);
    return { required: verdict.required === true, risk: verdict.risk ?? 'low', reason: verdict.reason };
  }

  async invoke(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    const spec = this.require(name);
    return spec.invoke(args, context);
  }

  /** LangChain tools for model binding. Execution is performed by the graph. */
  langchainTools(): StructuredToolInterface[] {
    return this.list().map((spec) => new DynamicStructuredTool({
      name: spec.name,
      description: spec.description,
      schema: spec.schema as any,
      func: async () => {
        throw new Error(`Tool ${spec.name} is executed by the engineer runtime, not through this wrapper.`);
      },
    }) as unknown as StructuredToolInterface);
  }
}

export function createEngineerToolRegistry(): EngineerToolRegistry {
  return new EngineerToolRegistry([
    ...filesystemTools(),
    commandTool,
    ...flutterTools,
    ...verifyTools,
    ...gitTools,
    ...previewTools,
    ...browserTools,
    ...databaseTools,
    ...memoryTools,
  ]);
}

export { filesystemTools, flutterTools, verifyTools, gitTools, previewTools, browserTools, databaseTools, memoryTools, commandTool };
export type { EngineerToolSpec, RiskLevel, ToolOutcome };
