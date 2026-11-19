# Autonomous engineer migration audit — 2026-11-19

Source inspection preceded implementation. The initial working tree contained an untracked `server/platform/engine/` and a modified sandbox policy; these are preserved and extended. Initial `npm run build:server` failed on nine incorrect registry imports.

| Subsystem | Initial classification | Source evidence / migration decision |
|---|---|---|
| React/Vite/Electron UI | Existing, functional components | Keep workspace editor, chat, files, preview, revisions; migrate execution transport. |
| Chat/orchestration | Architectural migration | `src/agent/index.ts` invokes `LovableGenerationPipeline` and edit agent; `src/orchestrator/graph.ts` uses fixed specialist stages. Backend harness is a third path. |
| Backend gateway | Existing, incomplete | `server/platform/api.ts` has JWT/RBAC, rate limits and workflow routes. Reuse these for engineer APIs. Legacy server routes are separate. |
| LangGraph | Existing, incomplete | Untracked graph/state/tools exist but registry fails to compile; no composition service, routes or tests. Approval, budget and completion correctness require fixes. |
| Models/prompts | Architectural migration | LangChain OpenAI-compatible model exists; legacy browser LLM and harness adapters coexist. Gemini native integration and vision input remain gaps. |
| Tools/filesystem | Existing, incomplete | Filesystem tool comments claim symlink protection but shared resolveInside only checks lexical containment. Fix engine confinement. |
| Execution/Flutter | Existing, requiring migration | Sandbox Docker/local runners and actual SDK commands exist. Legacy verifier/preview spawn host processes; new engine must not use those as an isolation bypass. |
| Browser/screenshots | Existing, incomplete | CDP adapter captures actual PNGs; URL restriction, artifact delivery and multimodal inspection need integration. |
| Generation/repair | Architectural migration | Fixed pipeline, template compiler, deterministic QA and healing coexist. Reuse deterministic components; one model decides subsequent actions. |
| Preview | Existing, requiring migration | Legacy preview builds actual Flutter apps but runs on host. Need isolated build + bounded static serving for new engine. |
| Git/revisions | Existing, functional services | Transactional patch, revisions and recovery exist. Engine snapshot restore needs symlink validation and explicit approval. |
| Supabase/auth | Existing, incomplete | Supabase auth/data migrations plus local platform JWT/RBAC. Platform SQLite driver is actual implementation despite PostgreSQL deployment comments. |
| Persistence/memory | Existing, incomplete | Project memory table exists; engineer event/thread tables absent. Checkpointer silently degrades on failure; fail closed instead. |
| Observability | Existing, incomplete | Metrics/OTLP exist; LangSmith package installed, no verified remote traces/evaluation evidence. |
| Deployment | Existing, incomplete | Docker/Compose reference topology exists; no Docker executable found locally. Agent Server not integrated. |
| Tests | Existing, incomplete | Broad server/frontend suites exist; no autonomous graph lifecycle tests. |

## Incremental migration

1. Repair compile and graph invariants, add regression tests (budgets, approval, cancellation, verification freshness and filesystem escape).
2. Compose durable runtime with project-scoped workspaces, event history, identity checks, exclusive execution and native interrupt/resume.
3. Add authenticated APIs and connect existing chat to this runtime with actionable approvals and controls.
4. Route verification and preview builds through isolated execution; retain command evidence and source artifacts.
5. Add tracing/evaluation configuration and deployment notes. Run typecheck, tests, builds and available real integration probes.

## Acceptance discipline

A source implementation or scripted model test is not a live model/Flutter end-to-end result. Record separately: executed local tests, externally verified integrations, and remaining infrastructure blockers. Do not call the full production mandate complete without a real model-driven build, preview inspection, repair, PostgreSQL restart recovery and remote tracing evidence.

## Cleanup requested by the owner

Removed the legacy `src/agents/` specialist implementations, fixed `src/orchestrator/` pipeline and their pipeline-specific tests. Removed the redundant `FlutterForge-Agents.zip` package. Moved the still-used LLM chat client, schema helper and client tests into `src/agent/`. The generation facade now calls the backend engineer API. Moved server deterministic validators to `server/platform/checks/`; these perform no model calls. Their older HTTP response fields remain compatibility contracts for the review UI. No environment files, project workspaces or user credentials were removed.

## Executed cleanup validation

- Frontend TypeScript and backend TypeScript compilation passed.
- Frontend suite: 23 files, 176 tests passed.
- Server suite: 612 passed, 0 failed, 1 skipped (613 total).
- Production Vite build passed; existing large-chunk warnings remain.
- Autonomous tests use injected model/verification fixtures. SQLite restart and actual filesystem writes are exercised; these are not live provider or Flutter build evidence.
- Historical configuration contains VITE-prefixed provider keys. The renderer now uses an explicit public environment allowlist excluding provider credentials; the default chat calls the server runtime. No deployment was performed.
- Docker is unavailable locally. The new runtime deliberately refuses host execution instead of silently weakening isolation.
- Remaining integration work includes unified chat-only reasoning, isolated preview, project database integration, LangSmith evaluation/tracing validation, PostgreSQL validation, Agent Server evaluation, and real model-driven Flutter E2E validation. The production acceptance criteria are not yet satisfied.


## Workspace and chat implementation validation

The workspace uses one backend engineer for conversational answers and code changes. The UI now includes streamed Markdown, functional starter prompts, file attachments, stop/retry controls, execution history, native approval decisions, follow-up instructions, and responsive preview frames. Enabled skills are included as project preferences. Source snapshots come from the backend, and manual creation, editing, renaming and deletion use an exclusive lease and optimistic content checks. Pending approvals block manual edits; edits invalidate verification and close stale previews. Search uses the same secret/symlink checks as direct file reads.

The default preview serves actual Flutter web output on a separate, token-protected local origin. Compilation uses the isolated Docker runner. No preview is invented when compilation fails. The local preview URL is not a remote deployment URL and must be replaced with a deployment-aware preview origin before hosted use.

Executed checks on 2026-11-19:

- Frontend TypeScript and server TypeScript compilation passed.
- Frontend: 180 tests passed across 25 files.
- Server: 615 passed, 1 skipped, 0 failed (616 total).
- Expanded engineer/preview checks: 8 passed, including SQLite restart/approval continuity, stale edits, file create/rename/delete, path isolation, failure budgets and actual static HTTP serving.
- Production Vite build passed; existing large-chunk warnings remain.
- Browser inspection confirmed the redesigned chat/workspace renders. A submitted live prompt did not complete successfully; browser access subsequently became unavailable.
- The real-provider smoke script (`scripts/engine-chat-smoke.ts`) returned HTTP 429 from the configured OpenRouter free model (daily quota exhausted). No successful live generation is claimed.
- Docker is absent on this machine. The configured Flutter sandbox image also needs to be supplied and validated for non-root execution with the runner's read-only filesystem and resource limits. The existing preview builder image is not automatically a compatible sandbox image.

Run the app with `npm run server` and `npm run dev`. Configure a working server-side model using `FLUTTERFORGE_LLM_PROVIDER`, `FLUTTERFORGE_LLM_MODEL` and the corresponding `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, or `FLUTTERFORGE_LLM_API_KEY` (plus `FLUTTERFORGE_LLM_BASE_URL` for a custom endpoint). Never put provider secrets in public Vite variables. Set `FLUTTERFORGE_SANDBOX_IMAGE` to a validated Flutter SDK worker image and make Docker available before exercising compilation. The next acceptance run must generate a project, compile/test it, inspect its real preview and make a follow-up repair with a live model.

Outstanding production acceptance: live Flutter E2E, compatible sandbox image validation, hosted preview routing, project database integration, PostgreSQL restart recovery, remote LangSmith evidence, and deployment integration. This implementation is not verified production parity with Lovable.

## Credential rotation and live-chat result

The server now loads the full configured key pool (including the existing legacy environment list), deduplicates it and rotates requests round-robin. It retries 429/401/402 responses on another available key, honors Retry-After, bounds each request to one attempt per key and does not replay partially streamed output. Six regression tests cover discovery, rotation, body replay, cooldowns, exhaustion, cancellation and streaming failures. The real-provider chat smoke subsequently completed: two model calls, one successful project_overview tool call and 67 streamed chunks. This supersedes the earlier single-key quota blocker for chat; full generation/build acceptance is still separate.

The server suite now passes 622 tests with one skip. Command-created source files (including partial writes before command failure) now flow into changed-file tracking and verification. Host PATH/HOME values no longer override Linux worker settings. A pinned Flutter worker recipe and real generation/edit smoke script are included. Docker and Colima were installed locally; VM/image setup and real isolated compilation are still being validated.
