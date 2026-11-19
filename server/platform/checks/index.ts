/**
 * Public API of the Deterministic checks.
 */
export * from './types.js';
export {
  CHECK_REGISTRY,
  DEPARTMENTS,
  DEPARTMENT_META,
  getCheckDefinition,
  listChecks,
  listChecksByCategory,
  resolveRoster,
} from './registry.js';
export {
  buildScorecard,
  createReviewContext,
  reviewFiles,
  runChecks,
} from './runner.js';
