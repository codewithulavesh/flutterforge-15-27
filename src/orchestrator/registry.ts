import type { ProjectState } from './state';

export interface AgentDefinition {
  id: string;
  name: string;
  role: string;
  modelTier: 'frontier' | 'coding' | 'economy';
  run: (state: ProjectState) => Promise<Partial<ProjectState>> | Partial<ProjectState>;
}

export class AgentRegistry {
  private static registry: Map<string, AgentDefinition> = new Map();

  public static register(agent: AgentDefinition): void {
    this.registry.set(agent.id, agent);
  }

  public static get(id: string): AgentDefinition | undefined {
    return this.registry.get(id);
  }

  public static getAll(): AgentDefinition[] {
    return Array.from(this.registry.values());
  }

  public static has(id: string): boolean {
    return this.registry.has(id);
  }
}

