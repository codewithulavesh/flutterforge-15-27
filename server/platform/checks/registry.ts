/**
 * The Corps roster.
 *
 * Deterministic source checks grouped by category. The roster is the
 * single source of truth for the API, the dashboard and the `review.board`
 * workflow — adding an agent means adding one definition here.
 */
import type { CheckDefinition, CheckCategory, CheckSummary } from './types.js';
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

export const DEPARTMENT_META: Record<CheckCategory, DepartmentMeta> = {
  product: { label: 'Product & UX', weight: 10, remit: 'Brief coverage, navigation and real user states.' },
  design: { label: 'Design & Accessibility', weight: 15, remit: 'Theme discipline and operability by assistive tech.' },
  engineering: { label: 'Engineering', weight: 25, remit: 'Layering, Dart correctness, data, state and supply chain.' },
  quality: { label: 'Quality & Security', weight: 30, remit: 'Tests, structural gates, security and performance.' },
  delivery: { label: 'Delivery & Operations', weight: 10, remit: 'Review hygiene, docs, release readiness and CI.' },
  intelligence: { label: 'Intelligence', weight: 10, remit: 'Observability and localisation readiness.' },
};

export const DEPARTMENTS: readonly CheckCategory[] = [
  'product',
  'design',
  'engineering',
  'quality',
  'delivery',
  'intelligence',
];

export const CHECK_REGISTRY: readonly CheckDefinition[] = Object.freeze([
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

function validateRoster(roster: readonly CheckDefinition[]): void {
  const ids = new Set<string>();
  for (const agent of roster) {
    if (ids.has(agent.id)) throw new Error(`Deterministic checks roster contains duplicate id "${agent.id}".`);
    ids.add(agent.id);
    if (!DEPARTMENTS.includes(agent.department)) {
      throw new Error(`Agent "${agent.id}" declares unknown department "${agent.department}".`);
    }
  }
  for (const department of DEPARTMENTS) {
    if (!roster.some((agent) => agent.department === department)) {
      throw new Error(`Deterministic checks roster has no agent in department "${department}".`);
    }
  }
  const weight = DEPARTMENTS.reduce((sum, department) => sum + DEPARTMENT_META[department].weight, 0);
  if (weight !== 100) throw new Error(`Department weights must sum to 100 (got ${weight}).`);
}

validateRoster(CHECK_REGISTRY);

const BY_ID = new Map(CHECK_REGISTRY.map((agent) => [agent.id, agent]));

export function getCheckDefinition(id: string): CheckDefinition | undefined {
  return BY_ID.get(id);
}

export function listChecks(): CheckSummary[] {
  return CHECK_REGISTRY.map(({ run: _run, ...summary }) => summary);
}

export function listChecksByCategory(): Array<{
  department: CheckCategory;
  label: string;
  weight: number;
  remit: string;
  agents: CheckSummary[];
}> {
  return DEPARTMENTS.map((department) => ({
    department,
    ...DEPARTMENT_META[department],
    agents: listChecks().filter((agent) => agent.department === department),
  }));
}

export function resolveRoster(agentIds?: readonly string[]): CheckDefinition[] {
  if (!agentIds || agentIds.length === 0) return [...CHECK_REGISTRY];
  const unknown = agentIds.filter((id) => !BY_ID.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown agent id(s): ${unknown.join(', ')}. Use GET /api/platform/agents for the roster.`);
  }
  const selected = new Set(agentIds);
  return CHECK_REGISTRY.filter((agent) => selected.has(agent.id));
}
