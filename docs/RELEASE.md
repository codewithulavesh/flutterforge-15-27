# Release Pipeline — Operator Guide

**Audience:** operators · **Scope:** release of generated Flutter apps · **Companion:** `docs/RUNBOOK_PLATFORM.md`

Two release paths exist in this repo, and the difference matters:

1. **Wired path — `server/publish.ts`** (behind `/api/publish/*` and `/publish/*`, driven from the web app's **Export** view, `src/utils/exportProject.ts`, and the ZIP download). It runs real Flutter builds on this host and is usable over HTTP today.
2. **Engine + DAG — `server/platform/release/release.ts` and `release/buildWorkflow.ts`** (pillar 12): deterministic release plans, offline **readiness checks**, artifact execution with a fixed flutter command surface, per-job sha256 manifests, Android/iOS signing detection that never echoes key material, all wrapped in the durable `release.build` workflow (`readiness → prepare (flutter create --platforms runners) → build`, events `release.ready`/`release.prepared`/`release.built`). Exposed over HTTP: `POST /api/platform/release/plan` (readiness + plan, no build), `POST /api/platform/release/build` (202, returns run id; `GET /workflows/runs/<id>/events` streams progress), `GET /api/platform/release/artifacts` (job manifests with sha256/size/signing state). A GitHub export sync helper lives at `server/platform/release/github.ts` — see below.

CI (`.github/workflows/ci.yml`) deliberately contains **no release or deploy steps** — its header states "no deploys; release pipeline is server-side" — so key material never touches a shared GitHub runner.

## Build targets matrix

### Engine targets (`server/platform/release/release.ts`)

`RELEASE_TARGETS = ['web', 'android-apk', 'android-aab', 'ios-archive', 'zip']`. `RELEASE_STEPS` is the **entire executable surface** — nothing else is run. `.tar.gz` packaging is in-process (node `zlib` + a ustar writer; mtime 0, sorted entries, symlinks skipped) and produces byte-identical output modulo the gzip header. Artifacts land at `<artifactsRoot>/<projectId>/<jobId>/<artifactName>`:

| Target | Command(s) actually run | Artifact | Notes |
|---|---|---|---|
| `web` | `flutter build web --release` | `<projectId>-web.tar.gz` (tarball of `build/web`) | `--base-href` unset → default `/`, CDN-root ready |
| `zip` | `flutter build web --release` + in-process archive | `<projectId>-flutter-web.tar.gz` | Same bundle, different name |
| `android-apk` | `flutter build apk --release` | `<projectId>-release.apk` | From `build/app/outputs/flutter-apk/app-release.apk` (preferred) or any `*.apk` |
| `android-aab` | `flutter build appbundle --release` | `<projectId>-release.aab` | From `build/app/outputs/bundle/release/app-release.aab` or any `*.aab` |
| `ios-archive` | `flutter build ipa --release` | `<projectId>-release.ipa` | macOS + Xcode only; signing Xcode-managed; execution elsewhere throws `IOS_REQUIRES_MACOS` (409, job `skipped`) |

Command output tails are capped (64 KiB), signing secrets are scrubbed from every log line and error detail, and every step runs without a shell. No reader can observe a torn manifest: manifests are written tmp+rename+dir-fsync to `<artifactsRoot>/jobs/<id>.json` on success **and** failure.

### Wired publish targets (`server/publish.ts`, HTTP)

Exact commands as invoked by `server/publish.ts` (`flutter` resolved by `ensureFlutter`, managed SDK at `<dataDir>/toolchains/flutter/<platform>-<arch>/flutter` or `FLUTTER_BIN`):

| Target | Command run by the server | Artifact | Notes |
|---|---|---|---|
| Web | `flutter build web --release --base-href /publish/<key>/` | `build/web/` served at `/publish/<key>/` | `--base-href` is publish-server specific — see CDN section |
| PWA | same as Web + presence check | `build/web/` (+ `manifest.json`, `flutter_service_worker.js`) | Missing files → notes in `build-report.json`, not fatal |
| Android | `flutter build apk --release` | `app-release.apk` | Served via `GET /api/publish/project/:id/artifact` |
| macOS | `flutter build macos --release` | `build/macos/Build/Products/Release/` | **Darwin hosts only** — hard error elsewhere |
| Windows | `flutter build windows --release` | `build/windows/x64/runner/Release/` | **Win32 hosts only** — hard error elsewhere |

The wired path has **no Android App Bundle, no IPA and no PWA-specific command** beyond Web; use the engine (`android-aab`, `ios-archive`) or run manually on the exported project. iOS signing is never automated — see "Signing on macOS for iOS".

## Readiness gates

**Engine readiness (`checkReleaseReadiness`, `server/platform/release/release.ts`)** — offline pre-flight; blocker codes are stable:

| Code | Meaning |
|---|---|
| `PROJECT_ROOT_MISSING` | Project root missing/not a directory |
| `PUBSPEC_MISSING` | `pubspec.yaml` missing at root |
| `MAIN_DART_MISSING` | `lib/main.dart` missing — not a Flutter app |
| `ANDROID_BUILD_GRADLE_MISSING` | `android/app/build.gradle(.kts)` absent — run `flutter create` |
| `ANDROID_SIGNING_NOT_CONFIGURED` | No `android/key.properties`, no `ANDROID_KEYSTORE_PATH`/`FLUTTERFORGE_ANDROID_KEYSTORE` pointing at an existing file; hard blocker unless `unsigned: true` (then a warning, artifact debug-signed, not Play-ready) |
| `ANDROID_KEYSTORE_NOT_FOUND` | A keystore env var is set but the file does not exist/is unreadable (path withheld); environment-name reported, never the value |
| `IOS_REQUIRES_MACOS` | iOS target on non-Darwin host (execution also refuses — job `skipped`, error 409) |
| `IOS_PROJECT_MISSING` | `ios/` directory absent — run `flutter create` |
| `FLUTTER_NOT_AVAILABLE` | `flutter` not on `PATH` (overridable `which` seam) |

Warnings: `ANDROID_KEYSTORE_NOT_FOUND` for a `key.properties` whose `storeFile` does not resolve (path withheld), or when `unsigned: true` was accepted.

**Wired publish readiness (`startPublish`, `server/publish.ts`)**

1. `target` ∈ {`web`, `pwa`, `android`, `macos`, `windows`} else 400 `Unsupported publish target`.
2. `files[]` non-empty, paths pass `safeRelativePath`; one build per project at a time (else 409 `A publish build for this project is already running.`).
3. Managed/located Flutter SDK runs `flutter pub get` (4 min timeout), then **the compile gate**: `dart analyze` must pass with **zero errors** (`skipped` bypasses the gate — a skipped gate is reported as `analyzer.skipped: true` in the report, never as a pass).
4. Pubspec auto-repairs are applied and logged (`fixInvalidPlainScalars`, SDK/Flutter constraint sanitizers); `pub get` failure → build aborts.
5. Missing platform runner folders are scaffolded via `flutter create --platforms=<platform> --no-pub --org com.flutterforge` into a scratch dir and copied in (web uses `--platforms=web`).
6. Artifact must exist (`index.html` for web; `app-release.apk` for Android) else the build fails.

Status/report/artifact endpoints: `POST /api/publish/<projectId>/build` → `202 {ok, status:"building", target}` · `GET /api/publish/project/<projectId>/status` → `{ ok, status, logs, report }` · `GET /api/publish/project/<projectId>/report` → `build-report.json` · `GET /api/publish/project/<projectId>/artifact` → APK with `Content-Disposition: attachment; filename="app-release.apk"`.

## Web export → CDN deployment

The UI **Export** view builds a ZIP client-side (JSZip via `src/utils/exportProject.ts`): live project files, a `pubspec.yaml` fallback, a runnable `README.md`, a minimal `web/index.html` when web is targeted, and `tool/create_platforms.sh` / `.ps1` which run `flutter create --platforms=<targets> .` to add the runner folders. The ZIP contains **Dart source only — no build output**.

```bash
unzip exported-app.zip -d exported-app && cd exported-app
bash tool/create_platforms.sh web          # or: web,windows,macos,android,ios
flutter pub get
flutter build web --release --base-href /   # NOT the /publish/<key>/ base-href
```

Deploy `build/web/` (must contain `index.html`):

- **Engine tarball (recommended for repeatable CDN releases).** Run `buildReleasePlan`/`executeReleasePlan` with target `web` (library use; see Recovery for the manifest layout). You get `<projectId>-web.tar.gz` with mtime 0 and byte-stable output, no `base-href` (defaults to `/`), upload it to any static host. Wire it into your own build host; it is not exposed over HTTP.
- **Drag-and-drop** (Netlify Drop, Cloudflare Pages Direct Upload, Vercel import): quickest; re-upload `build/web` on every release; instant HTTPS; no repo needed.
- **Git integration** (Netlify/Vercel/Pages connected to your repo): build command `flutter build web --release --base-href /`, output dir `build/web`. **Caveat:** default build images ship Node, not Flutter — use a build image/plugin/boilerplate that installs Flutter, or build locally and upload. For Pages, a Wrangler one-liner also works: `npx wrangler pages deploy build/web --project-name <your-project>` (same for `netlify deploy --prod --dir build/web` — requires you to be authenticated).
- **Base-href gotcha:** never publish a `--base-href /publish/<key>/` build to a CDN root — asset URLs will 404. The publish server build is for `/publish/<key>/` hosting only.
- **`netlify.toml` at this repo's root is for the FlutterForge UI itself** (`npm run build` → `dist`, SPA fallback to `/index.html`, `SECRETS_SCAN_OMIT_KEYS = "VITE_PREVIEW_API_URL"`); it does not build or deploy an exported app.

## Android signing

The Android signing surface is detected two ways by the release engine and one way by convention for manual builds:

1. **`android/key.properties`** at the project root — the engine treats its presence as `configured` (and warns, path withheld, when its `storeFile` does not resolve).
2. **Environment keystore vars** — `ANDROID_KEYSTORE_PATH` or `FLUTTERFORGE_ANDROID_KEYSTORE` pointing at an existing, readable `.jks` file. If set but unreadable → readiness blocker `ANDROID_KEYSTORE_NOT_FOUND` (names the env var, never the value).
3. **Passwords** are never used or echoed — FlutterForge reads them only to scrub values from logs/errors (`ANDROID_STORE_PASSWORD` / `ANDROID_KEY_PASSWORD` / `FLUTTERFORGE_ANDROID_KEYSTORE_PASSWORD`); Gradle uses them for signing. Any value ≥ 4 chars is replaced with `[REDACTED]` everywhere the engine writes.

Flutter signs a release APK using the `release` signingConfig of the generated `android/` project. Standard setup (do it once per app on a trusted host):

```bash
mkdir -p ~/keystores
keytool -genkeypair -v -keystore ~/keystores/<app>.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias <app>-release
# Password prompts for storepass/keypass — do not put them in the shell history.

cat > android/key.properties <<'EOF'
storePassword=<store-pass>
keyPassword=<key-pass>
keyAlias=<app>-release
storeFile=/Users/<you>/keystores/<app>.jks
EOF
```

Then in `android/app/build.gradle(.kts)`: read `key.properties`, add `signingConfigs.release`, and set `buildTypes.release.signingConfig = signingConfigs.release`. Keep `~/keystores/` outside the repo; add to `android/.gitignore`: `key.properties`, `*.jks`, `*.keystore`. Build & verify (engine readiness then passes; `signingState` becomes `signed`):

```bash
flutter build apk --release
flutter build appbundle --release
$ANDROID_HOME/build-tools/$(ls $ANDROID_HOME/build-tools | sort -V | tail -1)/apksigner verify --print-certs build/app/outputs/flutter-apk/app-release.apk
```

**Why the keystore never enters the repo or LLM context:** the generated project is fed to generation/repair models as file paths and contents. Anything committed or pasted into a prompt — a `.jks`, a password, a private key in a Dart string — is unrecoverable once pushed and may be echoed into model output and logs elsewhere. Release keystores are created on the operator host, referenced only via `key.properties`/absolute `storeFile` or the env vars above (never committed), and kept outside the repo and outside any prompt. Losing the keystore means you cannot update the app on the Play Store — back it up offline.

## Distribution paths

1. **Direct download (Android, phone browsers).** Serve `app-release.apk` over HTTP(S) — e.g. `GET /api/publish/project/<id>/artifact` sends it with `Content-Disposition: attachment; filename="app-release.apk"`. Android hands such downloads to the system DownloadManager; tap the notification → install (requires "install unknown apps" enabled). Same flow for any plain file host. Install over USB with `adb install -r app-release.apk`. Engine-built `<projectId>-release.apk` needs a static file host of your choosing — it is not exposed by any endpoint.
2. **Web / PWA.** `flutter build web` output served at `https://<host>/publish/<key>/` (this server, `Cache-Control: max-age=300`; `index.html` no-cache). When the build report shows `PWA manifest and service worker are present.`, the app can be installed from Chromium/Android browsers and works offline. iOS Safari supports Add to Home Screen for a web build; its service-worker/offline coverage is narrower than Android.
3. **TestFlight / Play Console.** Manual. Upload the AAB (engine `android-aab` target or `flutter build appbundle --release`, signed) to Play Console; iOS build → TestFlight. Not automated here.
4. **Self-hosted FlutterForge** (Docker `docker-compose.yml`): artifacts land on the `flutterforge-data` volume under `<dataDir>/publish/<key>/` — back up that volume.

## CI relationship

`.github/workflows/ci.yml` gates: **Quality** (`node scripts/ci/check-env.mjs`, `npm run typecheck`, `npm run lint` — continue-on-error, `npm run test:platform`), **Frontend** (`npx vitest run`), **Server** (`npm run test:server`), **Build** (`npm run build` + assert `dist/index.html`). CI pins Node 24 and sets `FLUTTERFORGE_AUTH_MODE=local`, `FLUTTERFORGE_DATA_DIR=${{ runner.temp }}/platform`. **Release is intentionally not in CI**: no deploy job exists, `permissions: contents: read`, and the pipeline is server-side on operator-trusted hosts because key material and signed artifacts must never touch a shared GitHub runner.

If you want release-PRs opened programmatically, `server/platform/release/github.ts` ships that capability and is wired to `POST /api/platform/release/github/sync` (admin+; requires `FLUTTERFORGE_GITHUB_OWNER`/`FLUTTERFORGE_GITHUB_REPO`/`FLUTTERFORGE_GITHUB_TOKEN`; optional `FLUTTERFORGE_GITHUB_BASE_BRANCH`). The route snapshots the project's text files, synthesizes a README, pushes to `flutterforge/release/<slug>-<timestamp>`, and opens a PR against the base branch. Errors are returned as data (`{ ok: false, status, message, retryAfterMs? }`, capped at 60 s from `Retry-After`/`x-ratelimit-reset`), never thrown for operational failure. It is tested (`server/test/platform/release.test.ts`, `npm run test:platform`). Keep the token in the deploy host's secret store, never in the repo, never in prompts.

## Rollback

Revisioned, transactional rollback of the project — then rebuild the artifact:

```bash
# 1. Find the last good revision (requires project:rollback = lead_engineer+)
curl -s -H "Authorization: Bearer $TOK" \
  http://127.0.0.1:8787/api/platform/projects/<projectId>/revisions | jq '.revisions[] | {id, createdAt, message}'

# 2. Atomic restore (one transactional patch: writes manifest files, deletes
#    files missing from it — cannot half-apply)
curl -s -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{}' \
  http://127.0.0.1:8787/api/platform/projects/<projectId>/revisions/<revisionId>/restore
# expect: {"ok":true,"result":{…}}

# 3. Build the files payload from the restored workspace snapshot, then rebuild + republish
FILES=$(curl -s http://127.0.0.1:8787/api/harness/session/<projectId> \
  | jq -c '{target:"web", files:[.files[] | {path, content}]}')
curl -s -X POST -H 'Content-Type: application/json' -d "$FILES" \
  http://127.0.0.1:8787/api/publish/<projectId>/build
# expect: {"ok":true,"status":"building","target":"web"}

# 4. Track until done, then confirm the restore was audited
curl -s http://127.0.0.1:8787/api/publish/project/<projectId>/status | jq '.status, .error, .report.notes'
curl -s -H "Authorization: Bearer $TOK" "http://127.0.0.1:8787/api/platform/audit/entries?limit=10" \
  | jq '.entries[] | select(.action=="project.revision.restore") | {action, resourceId, createdAt}'
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:8787/api/platform/audit/verify | jq '.ok'
```

Notes: (a) restore rewrites the workspace directory (`getProjectWorkspace(projectId)`); it does not push anything to a CDN — for web, re-download the ZIP or rebuild locally with `base-href /` and re-upload `build/web`, or use the snapshot→publish flow above for the built-in hosting. (b) revision restore requires permission `project:rollback`; the publish endpoints are legacy routes with no auth of their own — keep port 8787 on `127.0.0.1` or behind your own reverse proxy. (c) if you publish the CDN bundle manually, there is no server-side rollback — re-deploy the previous `build/web` (keep each release directory) or restore the revision and rebuild.

## Release checklist (wired HTTP path; every command runnable against `http://127.0.0.1:8787`)

The checklist exercises the wired `publish.ts` path. The engine path is the same gates (unit-tested) but is invoked from your own tooling via `buildReleasePlan(...)`/`executeReleasePlan(...)` — e.g. a build host script run with `node --import tsx/esm`.

```bash
1  node --version                                    # v24+ (node:sqlite)
2  npm run test:platform                              # platform suite green
3  curl -s http://127.0.0.1:8787/api/platform/health | jq -e '.ok and .database.integrity=="ok"'
4  curl -s http://127.0.0.1:8787/api/platform/audit/verify    | jq -e '.ok'
5  curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:8787/api/platform/projects/<id>/sbom \
     | jq -e '.ok and (.stats.total > 0)'
6  curl -s -X POST http://127.0.0.1:8787/api/platform/gate/analyze \
     -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
     -d '{"packageName":"my_app","files":[{"path":"lib/main.dart","content":"void main() { runApp(const SizedBox()); }\n"}]}' | jq -e '.passed'
7  FILES=$(curl -s http://127.0.0.1:8787/api/harness/session/<id> | jq -c '{target:"web", files:[.files[] | {path, content}]}')
   curl -s -X POST -H 'Content-Type: application/json' -d "$FILES" http://127.0.0.1:8787/api/publish/<id>/build   # 202 building
8  curl -s http://127.0.0.1:8787/api/publish/project/<id>/status | jq '.status'                     # poll until "succeeded"
9  curl -s http://127.0.0.1:8787/api/publish/project/<id>/report | tee build-report.json \
     | jq -e '.status=="succeeded" and .analyzer.errors==0'
10 curl -s -X POST http://127.0.0.1:8787/api/platform/maintenance/prune \
     -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
     -d '{"retentionDays":30}' | jq -e '.ok'
```

(omit `-H "Authorization: Bearer …"` in `local` auth mode.) Item 6 passes because it calls `runApp` in a top-level `main` — a minimal-but-valid entrypoint; real apps must ship with zero gate blockers, fix before release. Item 10 is optional housekeeping; run it after a release trains.

## Recovery

**Corrupt/missing artifact (engine jobs).** Engine artifacts are plain files under `<artifactsRoot>/<projectId>/<jobId>/<artifactName>` plus a manifest at `<artifactsRoot>/jobs/<id>.json` (written on success and failure). Verify integrity against the manifest's `artifact.sha256`: `shasum -a 256 <artifact>` must equal it. On `RELEASE_ARTIFACT_MISSING` the build produced no `build/web` or no `*.apk`/`*.aab`/`*.ipa` — fix the build, do not fake the artifact. On `RELEASE_MANIFEST_FAILED` the artifact built but its manifest could not be written — the bytes on disk are the truth; `sha256sum` them and write a manifest copy manually before re-running. `RELEASE_BUILD_FAILED` carries the failing step's id and 64 KiB output tail in `details`. Delete stale `jobs/*.json` and `<projectId>/<jobId>/` directories when pruning releases.

**Corrupt/missing artifact (wired publish path).** Artifacts are plain build output under `${FLUTTERFORGE_PUBLISH:-<dataDir>/publish}/<projectKey>/project/build/…` — there is no checksum store. Fix: confirm the report (`status`, `artifact.name`, `bytes`), delete the artifact directory (`rm -rf …/publish/<key>/project/build`), and republish via `POST /api/publish/<id>/build`. The exported ZIP is rebuilt client-side at any time — use it to re-create the source tree.

**Checksum mismatch (revision blobs).** Revision blobs are content-addressed: blob *filename* equals its SHA-256. Detect: `for f in $(find "${FLUTTERFORGE_DATA_DIR:-.flutterforge}/blobs" -type f); do printf '%s  %s\n' "$(basename "$f")" "$f"; done | shasum -a 256 -c -` should print `OK` lines. A mismatch or `REVISION_BLOB_MISSING` on restore means the blob store is damaged: stop writes, restore `blobs/` from backup (see RUNBOOK → Backup), then re-run restore. Restore aborts before touching the workspace when a blob is missing, so a workspace is never half-restored.

**Publish interrupted.** Job state is in-memory (`jobs`/`busy` maps). If the build dies or the server restarts, `status` for the project is lost and the `busy` slot is gone — simply `POST /api/publish/<id>/build` again. The `project/` tree is wiped (except `.dart_tool`, `build`, `pubspec.lock`, `.flutterforge-pubspec-hash` are preserved; everything else re-materializes from `files[]`), so a re-publish always starts clean. If a 409 `A publish build for this project is already running.` persists after a restart, the in-memory lock died with the process — restart cleared it; if not, the previous process may still be alive: check with `ps aux | grep -i publish` / port `8787`.

## Signing on macOS for iOS (not automated)

FlutterForge never creates, stores or uploads signing material. The engine supports iOS as far as Flutter's own tooling goes: target `ios-archive` runs `flutter build ipa --release` on macOS with Xcode-managed signing (`signingState: xcode-managed`); readiness requires `darwin` + `ios/` (codes `IOS_REQUIRES_MACOS` / `IOS_PROJECT_MISSING`), and execution on any other OS throws `IOS_REQUIRES_MACOS` (409) with the job marked `skipped`. Upload is manual: **Product → Archive → Distribute App** from Xcode (or `xcrun altool`/Transporter), to App Store Connect / TestFlight. You need an Apple Developer Program membership, a distribution certificate + provisioning profile (Xcode automatic signing works for ad-hoc/TestFlight), and the Xcode `Runner` bundle id matching your App ID. Pointers: <https://docs.flutter.dev/deployment/ios> · <https://developer.apple.com/help/app-store-connect/test-flight/> · <https://developer.apple.com/documentation/xcode/archives>. Do not paste certificates/profiles into prompts or commits; keep them in the macOS keychain. Any iOS release here is a manual, audited action on a dedicated build Mac.

## Artifact retention

- **Finished workflow runs** (not artifacts) are pruned by `POST /api/platform/maintenance/prune` with `{"retentionDays": N}` (default `FLUTTERFORGE_WORKFLOW_RETENTION_DAYS`, 30) — deletes `succeeded`/`failed`/`cancelled` runs older than N days; requires `org:manage` (owner) — returns `{ ok, pruned }`.
- **Publish artifacts (wired path)** under `${FLUTTERFORGE_PUBLISH:-<dataDir>/publish}/<key>/` have **no automatic retention** — remove old ones per release policy, after re-downloading anything you need.
- **Engine artifacts** under `<artifactsRoot>/<projectId>/<jobId>/` have **no automatic retention** either; prune old job directories and `<artifactsRoot>/jobs/*.json` manifests on the same cadence.
- **Engine web bundles** are reproducible from the same source tree (`mtime 0`, sorted entries) — keeping one canonical copy plus the tree is sufficient.
- **Platform DB:** finished runs go via prune; events/steps/approvals cascade from runs (`ON DELETE CASCADE`); the audit chain is never pruned. To confirm retention worked: `sqlite3 "$FLUTTERFORGE_PLATFORM_DB" "SELECT count(*) FROM workflow_runs WHERE finished_at IS NOT NULL AND finished_at < strftime('%s','now')*1000 - <N>*86400000;"` prints `0`.
- **Logical DB size:** after heavy churn run `sqlite3 "$FLUTTERFORGE_PLATFORM_DB" 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;'` to fold the WAL back.
