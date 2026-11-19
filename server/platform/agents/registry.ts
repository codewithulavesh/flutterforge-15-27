/**
 * The Corps roster.
 *
 * Twenty specialists, six departments, one accountable board. The roster is the
 * single source of truth for the API, the dashboard and the `review.board`
 * workflow — adding an agent means adding one definition here.
 */
import type { AgentDefinition, AgentDepartment, AgentSummary } from './types.js';
import { productOwnerAgent, uxArchitectAgent } from './product.js';
import { accessibilityAgent, designSystemAgent } from './design.js';
import {
  backendEngineerAgent,
  dartEngineerAgent,
  databaseEngineerAgent,
  dependencyAuditorAgent,
  flutterArchitectAgent,
  stateManagementAgent,
} from './engineering.js';
import {
  performanceAnalystAgent,
  qaTesterAgent,
  securityAuditorAgent,
  testEngineerAgent,
} from './quality.js';
import {
  codeReviewerAgent,
  devopsEngineerAgent,
  docsWriterAgent,
  releaseEngineerAgent,
} from './delivery.js';
import { i18nEngineerAgent, observabilityEngineerAgent } from './intelligence.js';

export interface DepartmentMeta {
  label: string;
  /** Weight in the overall score. Weights sum to 100 across all departments. */
  weight: number;
  remit: string;
}

export const DEPARTMENT_META: Record<AgentDepartment, DepartmentMeta> = {
  product: { label: 'Product & UX', weight: 10, remit: 'Brief coverage, navigation and real user states.' },
  design: { label: 'Design & Accessibility', weight: 15, remit: 'Theme discipline and operability by assistive tech.' },
  engineering: { label: 'Engineering', weight: 25, remit: 'Layering, Dart correctness, data, state and supply chain.' },
  quality: { label: 'Quality & Security', weight: 30, remit: 'Tests, structural gates, security and performance.' },
  delivery: { label: 'Delivery & Operations', weight: 10, remit: 'Review hygiene, docs, release readiness and CI.' },
  intelligence: { label: 'Intelligence', weight: 10, remit: 'Observability and localisation readiness.' },
};

export const DEPARTMENTS: readonly AgentDepartment[] = [
  'product',
  'design',
  'engineering',
  'quality',
  'delivery',
  'intelligence',
];

export const AGENT_ROSTER: readonly AgentDefinition[] = Object.freeze([
  productOwnerAgent,
  uxArchitectAgent,
  designSystemAgent,
  accessibilityAgent,
  flutterArchitectAgent,
  dartEngineerAgent,
  backendEngineerAgent,
  databaseEngineerAgent,
  stateManagementAgent,
  dependencyAuditorAgent,
  testEngineerAgent,
  qaTesterAgent,
  securityAuditorAgent,
  performanceAnalystAgent,
  codeReviewerAgent,
  docsWriterAgent,
  releaseEngineerAgent,
  devopsEngineerAgent,
  observabilityEngineerAgent,
  i18nEngineerAgent,
]);

function validateRoster(roster: readonly AgentDefinition[]): void {
  const ids = new Set<string>();
  for (const agent of roster) {
    if (ids.has(agent.id)) throw new Error(`Agent Corps roster contains duplicate id "${agent.id}".`);
    ids.add(agent.id);
    if (!DEPARTMENTS.includes(agent.department)) {
      throw new Error(`Agent "${agent.id}" declares unknown department "${agent.department}".`);
    }
  }
  for (const department of DEPARTMENTS) {
    if (!roster.some((agent) => agent.department === department)) {
      throw new Error(`Agent Corps roster has no agent in department "${department}".`);
    }
  }
  const weight = DEPARTMENTS.reduce((sum, department) => sum + DEPARTMENT_META[department].weight, 0);
  if (weight !== 100) throw new Error(`Department weights must sum to 100 (got ${weight}).`);
}

validateRoster(AGENT_ROSTER);

const BY_ID = new Map(AGENT_ROSTER.map((agent) => [agent.id, agent]));

export function getAgentDefinition(id: string): AgentDefinition | undefined {
  return BY_ID.get(id);
}

export function listAgents(): AgentSummary[] {
  return AGENT_ROSTER.map(({ run: _run, ...summary }) => summary);
}

export function listAgentsByDepartment(): Array<{
  department: AgentDepartment;
  label: string;
  weight: number;
  remit: string;
  agents: AgentSummary[];
}> {
  return DEPARTMENTS.map((department) => ({
    department,
    ...DEPARTMENT_META[department],
    agents: listAgents().filter((agent) => agent.department === department),
  }));
}

export function resolveRoster(agentIds?: readonly string[]): AgentDefinition[] {
  if (!agentIds || agentIds.length === 0) return [...AGENT_ROSTER];
  const unknown = agentIds.filter((id) => !BY_ID.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown agent id(s): ${unknown.join(', ')}. Use GET /api/platform/agents for the roster.`);
  }
  const selected = new Set(agentIds);
  return AGENT_ROSTER.filter((agent) => selected.has(agent.id));
}
