/**
 * Quality surface for the prompt→app lane.
 *
 * Downstream workflow code should:
 *   1. call `scoreProject(spec, files, { now })` after emission, and
 *   2. call `runBenchmarkSuite(runner, { cases, now })` to prove the lane
 *      still produces top apps.
 *
 * Both functions are deterministic apart from `generatedAt`/`durationMs`,
 * which come from the injected clock.
 */
export {
  BENCHMARK_MIN_QUALITY,
  QUALITY_MAX_FINDINGS,
  QUALITY_WEIGHTS,
  gradeFor,
  scoreProject,
  stripDartComments,
} from './score.js';
export type { ScoreOptions } from './score.js';
export {
  BENCHMARKS,
  checkBenchmarkExpectation,
  runBenchmarkSuite,
} from './benchmarks.js';
export type { BenchmarkRunner, BenchmarkSuiteOptions } from './benchmarks.js';
