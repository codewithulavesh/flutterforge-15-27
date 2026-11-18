/**
 * Deterministic Flutter app recipes.
 *
 * Each recipe is a complete, self-contained Flutter app shell whose code is
 * hand-written, screens exercisable in the web preview, and passes the
 * full verifier + release pipeline without an LLM round-trip. Recipes are
 * keyed off the prompt by token overlap against the template names — a
 * recipe hit never requires a model call.
 *
 * Every recipe is also a reference for how generated apps should be
 * structured: Material 3 theming, typed state, accessibility semantics,
 * responsive layout primitives, no off-token colors, no placeholders.
 */

export { RECIPES, matchPrompt, recipeStarter, type Recipe } from './catalog.js';
