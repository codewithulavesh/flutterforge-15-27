/**
 * Top-app benchmark suite.
 *
 * Ten realistic product prompts with the expectations a genuinely good
 * implementation must meet. A case passes only when the compiled spec has the
 * right entities and screen kinds, the emitted source contains the expected
 * capability markers, every hard gate passed, and the quality rubric scores
 * at least 70.
 */
import type {
  AppSpec,
  BenchmarkCase,
  BenchmarkCaseResult,
  BenchmarkSuiteReport,
  GateResult,
  GeneratedFile,
} from '../contracts.js';
import { SPEC_VERSION } from '../contracts.js';
import { pascal, snake } from '../emit/shared.js';
import { BENCHMARK_MIN_QUALITY, scoreProject, stripDartComments } from './score.js';

export const BENCHMARKS: BenchmarkCase[] = [
  {
    id: 'notes',
    prompt: 'Build a notes app with tags, search and pinning',
    expectation: {
      entities: ['Note', 'Tag'],
      screenKinds: ['list', 'detail', 'form'],
      mustInclude: ['search', 'validator', 'empty', 'pin'],
      minScreens: 4,
    },
    weight: 1.5,
  },
  {
    id: 'habits',
    prompt: 'Habit tracker with streaks and daily check-ins',
    expectation: {
      entities: ['Habit'],
      screenKinds: ['list', 'detail', 'form'],
      mustInclude: ['streak', 'check', 'validator'],
      minScreens: 4,
    },
    weight: 1,
  },
  {
    id: 'expenses',
    prompt: 'Split expenses with friends and settle balances',
    expectation: {
      entities: ['Expense', 'Friend'],
      screenKinds: ['list', 'form', 'dashboard'],
      mustInclude: ['settle', 'balance', 'validator'],
      minScreens: 4,
    },
    weight: 1.5,
  },
  {
    id: 'recipes',
    prompt: 'Recipe box with ingredients, steps and cook time',
    expectation: {
      entities: ['Recipe'],
      screenKinds: ['list', 'detail', 'form'],
      mustInclude: ['ingredient', 'step', 'cook'],
      minScreens: 4,
    },
    weight: 1,
  },
  {
    id: 'workouts',
    prompt: 'Workout log with exercises, sets and personal records',
    expectation: {
      entities: ['Workout', 'Exercise'],
      screenKinds: ['list', 'detail', 'form'],
      mustInclude: ['personal', 'exercise', 'validator'],
      minScreens: 4,
    },
    weight: 1,
  },
  {
    id: 'trips',
    prompt: 'Trip planner with itinerary and packing list',
    expectation: {
      entities: ['Trip'],
      screenKinds: ['list', 'detail', 'form'],
      mustInclude: ['itinerary', 'packing', 'validator'],
      minScreens: 4,
    },
    weight: 1,
  },
  {
    id: 'reading',
    prompt: 'Reading list with ratings and notes',
    expectation: {
      entities: ['Book'],
      screenKinds: ['list', 'detail', 'form'],
      mustInclude: ['rating', 'notes', 'empty'],
      minScreens: 4,
    },
    weight: 1,
  },
  {
    id: 'crm',
    prompt: 'CRM leads with pipeline stages and follow-ups',
    expectation: {
      entities: ['Lead'],
      screenKinds: ['dashboard', 'list', 'detail', 'form'],
      mustInclude: ['pipeline', 'follow', 'stage'],
      minScreens: 4,
    },
    weight: 1,
  },
  {
    id: 'invoices',
    prompt: 'Invoice manager with line items, tax and status',
    expectation: {
      entities: ['Invoice', 'LineItem'],
      screenKinds: ['list', 'detail', 'form'],
      mustInclude: ['subtotal', 'tax', 'validator'],
      minScreens: 4,
    },
    weight: 1,
  },
  {
    id: 'events',
    prompt: 'Event check-in app with guest list and QR badges',
    expectation: {
      entities: ['Event', 'Guest'],
      screenKinds: ['list', 'detail', 'form'],
      mustInclude: ['badge', 'guest', 'check'],
      minScreens: 4,
    },
    weight: 1,
  },
];

export interface BenchmarkRunner {
  (benchmark: BenchmarkCase): Promise<{ spec: AppSpec; files: GeneratedFile[]; gates: GateResult[] }>;
}

export interface BenchmarkSuiteOptions {
  cases?: BenchmarkCase[];
  now?: () => number;
  /** Minimum quality total for a case to pass. Defaults to 70. */
  minQuality?: number;
}

function fallbackSpec(benchmark: BenchmarkCase): AppSpec {
  const label = pascal(benchmark.id) || 'Benchmark';
  const packageName = `${snake(benchmark.id) || 'benchmark'}_app`;
  return {
    version: SPEC_VERSION,
    app: {
      name: label,
      packageName: packageName.replace(/^[^a-z]+/, '') || 'benchmark_app',
      tagline: 'Benchmark fallback',
      description: 'Synthetic spec used when a benchmark runner throws.',
      domain: 'custom',
    },
    audience: { primary: 'general' },
    entities: [],
    screens: [],
    flows: [],
    design: {
      seedColor: '#6750A4',
      brightness: 'system',
      spacing: [4, 8, 12, 16, 24, 32],
      radii: { sm: 4, md: 8, lg: 12, xl: 16 },
      motionMs: 200,
      shape: 'rounded',
    },
    requirements: [
      {
        id: 'runner.available',
        statement: 'The benchmark runner must return a project.',
        category: 'functional',
        verifiedBy: 'benchmark',
      },
    ],
    backend: 'local',
    seedCount: 0,
  };
}

function benchmarkMarkerText(files: GeneratedFile[]): string {
  return files
    .filter((file) => !file.path.startsWith('test/'))
    .map((file) => (file.path.endsWith('.dart') ? stripDartComments(file.content) : String(file.content ?? '')))
    .join('\n')
    .toLowerCase();
}

/** Human-readable expectation failures; empty means the case met its bar. */
export function checkBenchmarkExpectation(
  benchmark: BenchmarkCase,
  spec: AppSpec,
  files: GeneratedFile[],
): string[] {
  const failures: string[] = [];
  const entityNames = new Set((spec.entities ?? []).map((entity) => pascal(entity.name)));
  for (const expected of benchmark.expectation.entities ?? []) {
    if (!entityNames.has(pascal(expected))) failures.push(`missing entity '${expected}'`);
  }

  const kinds = new Set((spec.screens ?? []).map((screen) => screen.kind));
  for (const expected of benchmark.expectation.screenKinds ?? []) {
    if (!kinds.has(expected)) failures.push(`missing screen kind '${expected}'`);
  }

  const minScreens = benchmark.expectation.minScreens ?? 0;
  if ((spec.screens ?? []).length < minScreens) {
    failures.push(`expected at least ${minScreens} screens, got ${(spec.screens ?? []).length}`);
  }

  const haystack = benchmarkMarkerText(files);
  for (const marker of benchmark.expectation.mustInclude ?? []) {
    const needle = String(marker).toLowerCase();
    if (!haystack.includes(needle)) failures.push(`missing marker '${marker}'`);
  }
  return failures;
}

/**
 * Run every benchmark through a runner, score the emitted project and gate the
 * result. Failure reasons are human-readable and ordered deterministically.
 */
export async function runBenchmarkSuite(
  runner: BenchmarkRunner,
  options: BenchmarkSuiteOptions = {},
): Promise<BenchmarkSuiteReport> {
  const clock = options.now ?? Date.now;
  const stamp = clock();
  const generatedAt = Number.isFinite(stamp) ? Math.trunc(stamp) : 0;
  const cases = [...(options.cases ?? BENCHMARKS)];
  const minQuality =
    Number.isFinite(options.minQuality) && (options.minQuality ?? 0) > 0
      ? Math.trunc(options.minQuality as number)
      : BENCHMARK_MIN_QUALITY;

  const results: BenchmarkCaseResult[] = [];
  for (const benchmark of cases) {
    const started = clock();
    const failures: string[] = [];
    let spec: AppSpec;
    let files: GeneratedFile[];
    let gates: GateResult[];
    try {
      const run = await runner(benchmark);
      spec = run.spec;
      files = run.files ?? [];
      gates = run.gates ?? [];
      failures.push(...checkBenchmarkExpectation(benchmark, spec, files));
      for (const gate of gates) {
        if (gate.passed) continue;
        const detail = (gate.blockers ?? []).slice(0, 3).join('; ');
        failures.push(`gate '${gate.gate}' failed${detail ? `: ${detail}` : ''}`);
      }
    } catch (error) {
      spec = fallbackSpec(benchmark);
      files = [];
      gates = [
        {
          gate: 'runner',
          passed: false,
          blockers: [error instanceof Error ? error.message : String(error)],
        },
      ];
      failures.push(`runner failed: ${gates[0].blockers[0]}`);
    }

    const quality = scoreProject(spec, files, { now: clock });
    if (quality.total < minQuality) {
      failures.push(`quality ${quality.total} is below the ${minQuality} minimum`);
    }
    const elapsed = Math.max(0, Math.trunc(clock() - started));
    results.push({
      caseId: benchmark.id,
      passed: failures.length === 0,
      failures,
      quality,
      gates,
      spec,
      durationMs: elapsed,
    });
  }

  let weightSum = 0;
  let qualitySum = 0;
  for (let index = 0; index < cases.length; index += 1) {
    const weight =
      Number.isFinite(cases[index].weight) && (cases[index].weight ?? 0) > 0 ? (cases[index].weight as number) : 1;
    weightSum += weight;
    qualitySum += results[index].quality.total * weight;
  }
  const meanQuality = weightSum > 0 ? Math.round(qualitySum / weightSum) : 0;
  const passed = results.filter((result) => result.passed).length;

  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    meanQuality,
    cases: results,
    generatedAt,
  };
}
