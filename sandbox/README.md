# Flutter engineer worker

Build with `npm run sandbox:build` after Docker is running. The default image name is `flutterforge/sandbox:latest`; override it with `FLUTTERFORGE_SANDBOX_IMAGE`.

The Dockerfile pins the Flutter source revision, precaches web/Linux engine artifacts and runs as UID 1000. The runner supplies a read-only container root, a non-executable temporary filesystem, dropped capabilities and resource limits. Flutter needs writable SDK locks and stamps, so the entrypoint copies the SDK to the project's ignored `.flutterforge/worker` directory on first use. This also holds the project-private package cache. Allow several GB of disk space per workspace. Recreate that worker directory when changing SDK images; do not reuse it across different SDK revisions. Project files and generated Dart code never run on the host as a fallback.

For local macOS development, start Colima or Docker Desktop before starting the server. The engineer currently requests 2 GB of container memory and 2 CPU cores. Configure VM resources accordingly. On Linux, the workspace mount must be writable by UID 1000.

`npm run engine:smoke` exercises the real provider and a read-only tool. `npm run engine:e2e` exercises live generation, compilation, tests, static preview HTTP serving and a follow-up change. It fails on missing infrastructure or model errors. Browser interaction is a separate acceptance check. Set `FF_E2E_KEEP=1` to retain the temporary acceptance workspace for diagnosis.

## Server-side credential pool

Use `OPENROUTER_API_KEYS` for a comma-separated pool. The server also reads the existing `VITE_OPENROUTER_API_KEYS` configuration for migration, single-key variables and numbered `OPENROUTER_API_KEY_1` variables; duplicates are removed. Provider secrets are excluded from Vite's public environment allowlist. Do not add them back to the browser build.

Each model request starts with the next healthy credential. HTTP 429 triggers a cooldown and tries the next key, at most once per credential. Retry-After is honored; daily-quota errors cool down until the next UTC day. Invalid credentials (401) stay disabled until the runtime is recreated; insufficient-credit credentials (402) cool down for an hour. Exhaustion stops with an explicit error, without changing providers or buying credits. A response already streaming tokens is never replayed on another credential. Cooldowns are held in the current server process, not shared across replicas. Account-wide provider quotas still apply.
