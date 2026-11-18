# Prompt → Release: the honest path

FlutterForge ships a complete prompt-to-artifact pipeline. This document walks through what actually happens today when a developer asks for an app — and names exactly what is and isn't automated.

## The chain

```
POST /api/platform/projects/<id>/starter   — scaffold a valid empty project
POST /api/platform/projects/<id>/patch     — write files transactionally
POST /api/platform/release/build           — run the release.build DAG
GET  /api/platform/release/artifacts       — get the artifact + sha256
```

Every request passes through the same three gates: auth → RBAC → tenant isolation. After RBAC passes, the **structural gate** (`validateDartFiles`) checks the generated source; the **contract verifier** (`verifyProjectContract`) checks the project-level shape (main.dart has `runApp`, pubspec package identity, required deps, assets); and the **visual QA gate** (`analyzeVisualQa`) checks theme presence, off-token colors, accessibility affordances and responsive layout primitives. All three feed into the repair/review loop; none ships silently.

## Starter template (the zero-prompt baseline)

`server/platform/generation/starter/templates.ts` generates the same scaffold for every prompt:

- `pubspec.yaml` — flutter, go_router, provider, equatable
- `lib/main.dart` — `runApp(...)`
- `lib/app/app.dart` — App widget + Home
- `lib/app/theme.dart` — Material 3, light + dark, ColorScheme.fromSeed
- `analysis_options.yaml`, `.gitignore`, `README.md`

Scaffold is deterministic: same input → same output. Safe to regenerate.

## What a generated app looks like end-to-end

1. `POST /projects/<id>/starter` → 201, `transactionId`, `gate.passed: true`, `contract.passed: true`
2. `POST /projects/<id>/release/build { target: "web" }` → 202, `run.id`
3. `GET /workflows/runs/<runId>/events` → `readiness → pub-get → security (OSV) → prepare (flutter create) → build`
4. `GET /release/artifacts?projectId=<id>` → `fresh-release-web.tar.gz`, size, sha256, `status: "succeeded"`

If any step fails, the workflow stops at the failing gate with a structured error (`RELEASE_NOT_READY`, `RELEASE_DEP_VULNERABILITIES`, `RELEASE_PREPARE_FAILED`, `RELEASE_BUILD_FAILED`).

## What "top apps from any prompt" means today vs. what it doesn't (yet)

Today:
- Starting from an empty workspace and emitting a valid Flutter+Material 3 app with a full release artifact in under 2 minutes.
- A deterministic starter you can regenerate safely; the agent patches feature code on top.

Not yet shipped:
- Automatic prompt-to-project generation driven from one endpoint. The starter exists; the generator wiring is the next DAG.
- Screenshot-based visual QA (requires a GPU/headless Flutter viewer; source-level token gating is the interim gate, `analyzeVisualQa`).
- Backend field generation (Supabase schema wiring, RLS policies) — the Supabase wiring is in `supabase/migrations/` and only opt-in.
- In-flight multi-turn generation with intermediate review gates.
- AI SDK/free-form prompt-to-fullscreen UX synthesis (material for the next product iteration).
