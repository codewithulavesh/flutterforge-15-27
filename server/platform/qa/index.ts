/**
 * Public API of the FlutterForge QA platform module.
 *
 * - `diagnostics.ts` — normalized Diagnostic shape, parsers for analyzer/
 *   compiler/test output, fingerprinting, dedupe, ranking, summaries.
 * - `contract.ts` — text-based verification of the generated Flutter project
 *   against the platform contract (pubspec, entry point, imports, secrets,
 *   assets, Android applicationId, Supabase RLS).
 * - `healing.ts` — deterministic repair-planning policy (cycle limits,
 *   oscillation detection, target selection, prompt brief).
 */
export * from './diagnostics.js';
export * from './contract.js';
export * from './healing.js';
