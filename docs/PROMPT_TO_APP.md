# Prompt → Release: the shipped path

FlutterForge ships a complete prompt-to-artifact pipeline behind **one endpoint**. This document walks through what actually happens when a developer asks for an app — and names exactly what is and isn't automated.

## One-call path

```
POST /api/platform/projects/<id>/generate   { "prompt": "build me a todo app" }
  → 202 { run: { id, definition: "prompt.to.app", … } }

GET  /api/platform/workflows/runs/<runId>/events
  → intake → scaffold → prepare → verify → release

GET  /api/platform/release/artifacts?projectId=<id>
  → artifact path, size, sha256
```

`prompt.to.app` is a durable DAG registered in the workflow engine, so it survives process restarts, retries bounded steps, and streams every transition on the run event log. The same three gates always apply: auth → RBAC → tenant isolation. After RBAC passes, the **structural gate** (`validateDartFiles`) checks generated source; the **contract verifier** (`verifyProjectContract`) checks project shape (main.dart has `runApp`, pubspec identity, required deps); and the **visual QA gate** (`analyzeVisualQa`) checks theme presence, off-token colors, accessibility affordances and responsive layout primitives.

## Arbitrary prompts — the `app.forge` lane

For free-text prompts that no recipe matches, the platform ships a parallel lane: `POST /api/platform/generation/build` (Forge Studio in the workspace) compiles the prompt to a typed **AppSpec**, emits a zero-dependency Flutter project (models/repositories/controllers/screens), scores it against the top-app rubric (`docs/GENERATION_QUALITY.md`), proves it with the real `flutter analyze`, and seals it transactionally. It returns a run id and streams `app.spec → app.emitted → app.scored → app.verified → app.sealed`; the same gates, but the artifact is a complete, analysable app rather than a scaffold. Both DAGs coexist; Forge Studio is the recommended surface for new apps.

## Recipe catalog (the deterministic lane)

`server/platform/generation/recipes/` maps a prompt to a complete, hand-written app shell:

| Recipe | Triggers | Ships |
|---|---|---|
| `counter` | counter, count, tally, increment | increment/decrement/reset, Material 3, semantics |
| `todo` | todo, task, checklist, to-do | add/toggle/remove, empty state, list UI |
| `flashcards` | flashcard, study, memorize, anki | flip deck, prev/next, semantics |

Recipes are deterministic: same prompt → same files, no model call, no keys. A prompt that matches no recipe falls back to the starter shell (a valid, themed app with a release artifact), and the run event log records the miss.

## What the DAG does

1. **intake** — normalize prompt, derive app/package names, match a recipe. Fails fast if the workspace already holds files (`409 PROJECT_NOT_EMPTY`) so generation never overwrites user work.
2. **scaffold** — write files through the 2PC patch engine (`applyPatch`) with a content-addressed revision.
3. **prepare** — `flutter create . --platforms <target>` when the runner is missing, then rewrite `test/widget_test.dart` to match the generated root widget (the Flutter-generated test expects `MyApp`, which no generated app defines).
4. **verify** — materialize the workspace and run the real toolchain gate (`pub get` + `dart analyze`). Failure raises `VERIFY_FAILED` with the first diagnostic.
5. **release** — readiness check → OSV dependency gate (fail-closed) → prepare → `flutter build web --release` → `.tar.gz` + sha256 manifest.

## Verified live

```
intake   → matched recipe "todo", wrote 8 files
prepare  → web runner materialized
verify   → 0 errors, 0 warnings
release  → e2e-gen-web.tar.gz, 13.8 MB, sha256 recorded
run status: succeeded in ~40s
```

## What "top apps from any prompt" means today vs. what it doesn't (yet)

Shipped:
- One endpoint from free-text prompt to a built, hashed release artifact for the recipe lane.
- Deterministic starter + recipes that pass the structural, contract and visual gates.
- Output shape proven with a real Flutter web build.

Not yet shipped:
- Free-form app synthesis (entities, CRUD screens, navigation) for prompts outside the recipe catalog. Today those ship the starter shell. The AppSpec compiler lane is the next DAG.
- Screenshot-based visual QA (requires a GPU/headless Flutter viewer; source-level token gating is the interim gate, `analyzeVisualQa`).
- Backend field generation (Supabase schema wiring, RLS policies) — wiring lives in `supabase/migrations/` and is opt-in.
- In-flight multi-turn generation with intermediate review gates.
