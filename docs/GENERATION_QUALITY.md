# Generation Quality Program

FlutterForge's promise is **any prompt → a top-quality Flutter app**. This document
describes the architecture that makes that promise measurable, the hard gates a
generated project must pass, and the honest limits of the current build.

## Pipeline

```
prompt
  │
  ├─ spec compiler (deterministic)  ──▶  AppSpec            server/platform/generation/spec/
  │      optional LLM enrichment    ──▶  refined AppSpec    server/platform/generation/spec/enrich.ts
  │
  ├─ emitters (pure, deterministic) ──▶  GeneratedFile[]    server/platform/generation/emit/
  │      data: models / repositories / controllers / seeds
  │      ui:   screens / components
  │      app:  theme / scope / router / adaptive nav / tests
  │
  ├─ quality rubric                 ──▶  QualityReport      server/platform/generation/quality/
  ├─ hard gates                     ──▶  GateResult[]       server/platform/generation/gate/
  │      structure · budget · tests · quality · flutter analyze
  │
  └─ durable workflow `app.forge`   ──▶  sealed workspace   server/platform/generation/forgeWorkflow.ts
```

Every stage is pure and independently testable. The workflow is the only stage
with side effects, and it writes through the two-phase transaction engine.

## AppSpec — the single source of truth

`server/platform/generation/contracts.ts` defines a typed IR:

- `entities` — fields, types, enums, relations, the primary display field
- `screens` — eight archetypes (`dashboard`, `list`, `detail`, `form`, `chat`,
  `profile`, `settings`, `onboarding`) with routes and purposes
- `flows` — ordered user journeys referencing screen ids
- `design` — seed color, spacing/radii scales, motion, shape
- `requirements` — each with a category and the gate that proves it

Emitters may not invent screens or entities. If it is in the spec, the UI layer
must emit it; if it is not, it must not appear. This makes output reviewable and
prevents the classic "LLM added a screen nobody asked for" failure.

## The generated app

Zero third-party packages — only the Flutter SDK. This is deliberate:

- **Hermetic**: `flutter pub get` needs no third-party resolution, so analyze and
  build are fast and reproducible.
- **Auditable**: no transitive dependency surface to review or patch.
- **Portable**: web, Android, iOS, macOS, Windows, Linux from one tree.

Architecture of emitted projects:

```
lib/
  main.dart
  app/            # theme, AppScope, router, adaptive navigation
  state/          # ChangeNotifier controllers + app settings
  data/
    models/       # immutable models: copyWith, toJson, fromJson
    repositories/ # abstract seam + in-memory implementation
    seed/         # deterministic, domain-appropriate sample data
  features/<screen>/<screen>_page.dart
  ui/components/  # async view, empty state, stat tile, confirm dialog
test/
  app/app_smoke_test.dart
  data/<entity>_model_test.dart
  data/<entity>_controller_test.dart
```

State flows one way: screen → controller → repository. Controllers own loading,
error and mutation state; screens never touch repositories. Every data screen
renders loading, error-with-retry, and empty states. Detail/form routes carry an
`:id` and receive it as `entityId`.

## Quality rubric

`scoreProject(spec, files)` returns a 0–100 score across seven weighted
categories:

| Category | Weight | What it rewards |
|---|---|---|
| Architecture | 15 | model/repository/controller separation, no business logic in widgets |
| Completeness | 20 | every spec screen/entity emitted, fields present, routes correct |
| Design | 15 | seed-derived theme, no raw colors, dark mode, state coverage |
| Accessibility | 15 | semantics/tooltips, labelled fields, tap targets, text scaling |
| Reliability | 15 | error handling, validators, delete confirmation, no unawaited work |
| Testability | 10 | widget smoke test plus model/controller tests |
| Performance | 10 | const constructors, `ListView.builder`, no shrink-wrap on long lists |

`MIN_TOP_APP_QUALITY = 80`. The workflow's default threshold is lower (65) so a
project can be inspected and repaired; production builds should pin 80+.

## Hard gates

| Gate | Fails closed when |
|---|---|
| `structuralGate` | spec invalid, dangling imports, duplicate paths, missing entrypoint/pubspec/test |
| `budgetGate` | > 400 files, > 2.5 MB, > 120 KB per file, > 40k lines |
| `testGate` | no widget test and no model/controller test |
| `qualityGate` | score below threshold or any error-severity finding |
| `analyzeGate` | real `flutter analyze` fails **or the toolchain is unavailable** |

The analyzer gate does not pretend: without Flutter installed it reports
`ANALYZE: Flutter toolchain unavailable — verification did not run`. Setting
`FLUTTERFORGE_ALLOW_UNVERIFIED_GENERATION=1` is the only way past it, and that is
recorded as an explicit policy decision.

## Benchmarks

`server/platform/generation/quality/benchmarks.ts` defines ten real prompts
(notes, habits, expenses, recipes, workouts, trips, reading, CRM, invoices,
events). Each case asserts entity coverage, screen archetypes, content markers,
all gates green, and quality ≥ 70. `runBenchmarkSuite` aggregates pass rate and
weighted mean quality; it is the regression harness for prompt/emitter changes.

Run the fast suite:

```bash
node --import tsx/esm --test server/test/platform/qualityScore.test.ts
```

Run the real-toolchain proof (requires Flutter on PATH):

```bash
FLUTTERFORGE_E2E_FLUTTER=1 node --import tsx/esm --test server/test/platform/generationE2E.test.ts
```

## LLM enrichment

Enrichment is **opt-in** (`FLUTTERFORGE_LLM_ENRICH=1`). It uses the server-side
provider in `server/platform/ai/provider.ts` — keys never reach the browser,
retrying with backoff, and recording usage into the metering ledger. It refines
names, fields, screens and copy; it cannot remove anything the deterministic
compiler emitted, and any failure returns the un-enriched spec. It exists so a
prompt that is closer to product copy ("a serene trail journal for patient
hikers") gets bespoke phrasing; it is not required for a correct app.

## API surface

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/platform/generation/spec` | prompt → AppSpec + validation (no writes) |
| POST | `/api/platform/generation/build` | start durable `app.forge` run |
| GET | `/api/platform/generation/quality?projectId=` | latest quality report + gates |
| GET | `/api/platform/generation/benchmarks` | benchmark catalog metadata |
| GET | `/api/platform/workflows/runs/:id` | run status |
| GET | `/api/platform/workflows/runs/:id/events` | run timeline |

The UI surface is **Forge Studio** (`src/features/workspace/GenerationStudio.tsx`),
mounted as the `generation` workspace view.

## Verified in production mode

```
POST /api/platform/generation/build
  → 202 { run: { id, definition: "app.forge" } }

plan (3 ms)      → app.spec       Split Expenses · finance · Expense, Person
emit  (15 ms)    → app.emitted    37 files · 145,539 bytes
score (15 ms)    → app.scored     93 / grade A
verify (6.3 s)   → app.verified   flutter analyze — 0 errors, 0 warnings
seal  (645 ms)   → app.sealed     tx_01M7…  · 37 files, workspace populated
```

`quality.total = 93` with architecture 92 · completeness 98 · design 85 ·
accessibility 100 · reliability 95 · testability 100 · performance 75.

## Honest limits

- Generated apps persist data **in memory**. Persistence behind
  `shared_preferences`/SQLite is a follow-up; the repository seam is the only
  place it needs to change.
- The deterministic compiler understands English product prompts best; other
  languages fall back to the `custom` domain and a sensible generic spec.
- LLM enrichment is additive: it may refine names, fields and screens, but it
  cannot remove what the deterministic compiler emitted. It is optional and
  failure-safe.
- Visual regression screenshots are not part of the fast suite; the visual QA
  gate is static (token/a11y/responsive markers).
- Real backend generation (Supabase) emits the same local repository seam; the
  remote adapter is not generated yet.
