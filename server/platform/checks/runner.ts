/**
 * Corps execution and scorecard aggregation.
 *
 * Runs the selected checks over one immutable file snapshot, then folds their
 * findings into a department-weighted scorecard. The aggregation is pure: the
 * same reports always produce the same score, verdict and ordering.
 */
import type {
  CheckDefinition,
  CheckFinding,
  CheckReport,
  CheckStatus,
  DepartmentScore,
  ReviewContext,
  ReviewFile,
  RunChecksOptions,
  Scorecard,
} from './types.js';
import { DEPARTMENT_META, DEPARTMENTS, resolveRoster } from './registry.js';
import {
  countSeverities,
  finding,
  parsePubspec,
  scoreFindings,
  sortFindings,
  statusForFindings,
} from './shared.js';

export interface CreateContextInput {
  projectId: string;
  files: readonly ReviewFile[];
  prompt?: string;
  now?: number;
}

export function createReviewContext(input: CreateContextInput): ReviewContext {
  const pubspecFile = input.files.find((file) => file.path === 'pubspec.yaml');
  const pubspec = pubspecFile?.content ?? null;
  const parsed = parsePubspec(pubspec);
  return {
    projectId: input.projectId,
    files: [...input.files].sort((a, b) => a.path.localeCompare(b.path)),
    packageName: parsed.name,
    pubspec,
    prompt: input.prompt,
    now: typeof input.now === 'number' ? input.now : Date.now(),
  };
}

async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runOne(agent: CheckDefinition, context: ReviewContext, excludeInfo: boolean): Promise<CheckReport> {
  const started = Date.now();
  let findings: CheckFinding[];
  try {
    findings = [...(await agent.run(context))];
  } catch (error) {
    findings = [
      finding('AGENT_INTERNAL_ERROR', 'blocker', `${agent.name} could not complete the review: ${error instanceof Error ? error.message : String(error)}`, {
        suggestion: 'This is a Corps defect — report it with the project snapshot used for the review.',
      }),
    ];
    const durationMs = Date.now() - started;
    const stats = { blockers: 1, majors: 0, minors: 0, infos: 0 };
    return {
      agentId: agent.id,
      name: agent.name,
      title: agent.title,
      department: agent.department,
      status: 'fail',
      score: 0,
      findings: sortFindings(findings),
      stats,
      durationMs,
    };
  }

  const filtered = excludeInfo ? findings.filter((item) => item.severity !== 'info') : findings;
  const sorted = sortFindings(filtered);
  const stats = countSeverities(sorted);
  return {
    agentId: agent.id,
    name: agent.name,
    title: agent.title,
    department: agent.department,
    status: statusForFindings(sorted),
    score: scoreFindings(sorted),
    findings: sorted,
    stats,
    durationMs: Date.now() - started,
  };
}

function aggregateDepartments(reports: readonly CheckReport[], selected: readonly CheckDefinition[]): DepartmentScore[] {
  const selectedDepartments = new Set(selected.map((agent) => agent.department));
  return DEPARTMENTS.filter((department) => selectedDepartments.has(department)).map((department) => {
    const departmentReports = reports.filter((report) => report.department === department);
    const score = departmentReports.length > 0
      ? Math.round(departmentReports.reduce((sum, report) => sum + report.score, 0) / departmentReports.length)
      : 100;
    let status: CheckStatus = 'pass';
    if (departmentReports.some((report) => report.status === 'fail')) status = 'fail';
    else if (departmentReports.some((report) => report.status === 'warn')) status = 'warn';
    return {
      department,
      label: DEPARTMENT_META[department].label,
      weight: DEPARTMENT_META[department].weight,
      score,
      status,
      agentIds: departmentReports.map((report) => report.agentId),
      blockers: departmentReports.reduce((sum, report) => sum + report.stats.blockers, 0),
      majors: departmentReports.reduce((sum, report) => sum + report.stats.majors, 0),
      minors: departmentReports.reduce((sum, report) => sum + report.stats.minors, 0),
    };
  });
}

export function buildScorecard(
  context: ReviewContext,
  selected: readonly CheckDefinition[],
  reports: readonly CheckReport[],
  durationMs: number,
): Scorecard {
  const departments = aggregateDepartments(reports, selected);
  const weightSum = departments.reduce((sum, department) => sum + department.weight, 0) || 1;
  const overallScore = Math.round(departments.reduce((sum, department) => sum + department.score * department.weight, 0) / weightSum);

  const allFindings = sortFindings(reports.flatMap((report) => report.findings));
  const blockers = allFindings.filter((item) => item.severity === 'blocker');
  const majors = allFindings.filter((item) => item.severity === 'major');
  const minors = allFindings.filter((item) => item.severity === 'minor');
  const infos = allFindings.filter((item) => item.severity === 'info');

  const verdict = blockers.length > 0
    ? 'fail'
    : majors.length > 0 || minors.length > 0 || overallScore < 85
      ? 'warn'
      : 'pass';

  const findingCounts: Record<string, number> = {};
  for (const item of allFindings) findingCounts[item.code] = (findingCounts[item.code] ?? 0) + 1;
  const orderedCounts = Object.fromEntries(Object.keys(findingCounts).sort().map((code) => [code, findingCounts[code]]));

  return {
    projectId: context.projectId,
    overallScore,
    verdict,
    departments,
    reports: [...reports],
    blockers,
    findingCounts: orderedCounts,
    stats: {
      agents: reports.length,
      findings: allFindings.length,
      blockers: blockers.length,
      majors: majors.length,
      minors: minors.length,
      infos: infos.length,
      filesReviewed: context.files.length,
    },
    generatedAt: context.now,
    durationMs,
  };
}

export async function runChecks(context: ReviewContext, options: RunChecksOptions = {}): Promise<Scorecard> {
  const started = Date.now();
  const selected = resolveRoster(options.agentIds);
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 4));
  const excludeInfo = options.excludeInfo === true;

  const reports = await mapPool(selected, concurrency, (agent) => runOne(agent, context, excludeInfo));
  return buildScorecard(context, selected, reports, Date.now() - started);
}

/** Convenience wrapper: snapshot in, scorecard out. */
export async function reviewFiles(
  input: CreateContextInput,
  options: RunChecksOptions = {},
): Promise<Scorecard> {
  return runChecks(createReviewContext(input), options);
}
