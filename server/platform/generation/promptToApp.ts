/**
 * `prompt.to.app` — end-to-end durable DAG: prompt → scaffold → verify → release.
 *
 * Intake passes a raw prompt in; Intake/Plan phases use the deterministic
 * recipe catalog to emit a complete project (pubspec, app shell, feature
 * files, tests) in one atomic transaction. Verification uses the same
 * Flutter toolchain gate as `verify.heal`. Release collects the `.tar.gz`
 * artifact with a SHA-256 manifest.
 *
 * No external services or keys are required for the deterministic recipe
 * lane; the path is a supported, honest product surface.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { WorkflowDefinition } from '../workflow/engine.js';
import { PlatformError } from '../kernel/errors.js';
import { matchPrompt, recipeStarter, RECIPES } from './recipes/index.js';
import { buildStarterProject } from './starter/index.js';
import { applyPatch, type PatchInput } from '../patch/transaction.js';
import { verifyProject } from '../../harness/verify.js';
import { getProjectWorkspace } from '../../harness/run.js';
import { buildReleasePlan, checkReleaseReadiness, executeReleasePlan, type ReleaseTarget } from '../release/release.js';

import { existsSync } from 'node:fs';
import { defaultReleaseCommandRunner } from '../release/release.js';

export interface PromptToAppInput {
  projectId: string;
  prompt: string;
  appName?: string;
  packageName?: string;
  seedColor?: string;
  backend?: 'local' | 'supabase';
  target?: ReleaseTarget;
  recipeId?: string;
}

export interface PromptToAppPlatform {
  dataDir: string;
  transactionRoot: string;
}

const RUNNER_DIR = { web: 'web', android: 'android', ios: 'ios' } as const;

export function createPromptToAppWorkflow(platform: PromptToAppPlatform): WorkflowDefinition {
  return {
    name: 'prompt.to.app',
    version: 1,
    displayName: 'Prompt to app (intake → scaffold → verify → release)',
    description: 'End-to-end: intake a free-text prompt, match it to a deterministic recipe or a new starter, and release an artifact.',
    steps: [
      {
        id: 'intake',
        description: 'Normalize the prompt, pick a recipe (or a fresh starter), and record the decision.',
        timeoutMs: 30_000,
        retry: { maxAttempts: 1 },
        run: async (ctx) => {
          const input = ctx.input as PromptToAppInput;
          const projectId = String(input?.projectId ?? '').trim();
          if (!projectId) throw new PlatformError({ code: 'PROMPT_PROJECT_MISSING', message: 'projectId is required.', statusCode: 422 });
          const prompt = String(input?.prompt ?? '').trim();
          if (!prompt) throw new PlatformError({ code: 'PROMPT_MISSING', message: 'prompt is required.', statusCode: 422 });

          // If the workspace already has a project, fail fast to avoid overlapping generation.
          const workspace = getProjectWorkspace(projectId);
          const entries = await Promise.allSettled([fs.readdir(workspace)]);
          const files = entries[0].status === 'fulfilled' ? entries[0].value.filter((e) => e !== '.flutterforge') : [];
          if (files.length > 0) {
            throw new PlatformError({ code: 'PROJECT_NOT_EMPTY', message: 'Workspace is not empty — use patch.apply or a dedicated repair app to modify it.', statusCode: 409, details: { files: files.slice(0, 10) } });
          }

          const appName = String(input?.appName ?? (projectId.replace(/[^a-z0-9_]+/gi, '_').replace(/^_+|_+$/g, '') || 'App')).trim();
          const packageName = String(input?.packageName ?? (appName.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '') || 'flutterforge_app'));
          const recipe = input?.recipeId
            ? RECIPES.find((r) => r.id === input.recipeId)
            : matchPrompt(prompt);
          const matched = recipe ? { recipe: recipe.id } : { recipe: null, reason: 'no recipe matched — falling back to starter' };

          await ctx.emit('prompt.to.app.intake', { prompt, appName, packageName, backend: input?.backend ?? 'local', matched });
          return { prompt, appName, packageName, recipeId: recipe?.id ?? null, seedColor: input?.seedColor, backend: input?.backend };
        },
      },
      {
        id: 'scaffold',
        dependsOn: ['intake'],
        description: 'Write the initial project files transactionally.',
        timeoutMs: 60_000,
        retry: { maxAttempts: 1 },
        run: async (ctx) => {
          const input = ctx.input as PromptToAppInput;
          const intake = ctx.outputs.intake as { appName: string; packageName: string; prompt: string; recipeId?: string };
          const workspace = getProjectWorkspace(input.projectId);

          const files = intake.recipeId
            ? recipeStarter(RECIPES.find((r) => r.id === intake.recipeId)!, intake.appName, intake.packageName)
            : buildStarterProject({ appName: intake.appName, packageName: intake.packageName, seedColor: input?.seedColor, backend: input?.backend });

          await applyPatch({
            transactionRoot: platform.transactionRoot,
            workspaceRoot: workspace,
            actor: ctx.actor,
            message: intake.recipeId ? `recipe:${intake.recipeId}` : 'starter',
            files: files.map((f) => ({ path: f.path, content: f.content } satisfies PatchInput)),
          });
          await ctx.emit('prompt.to.app.scaffold', { recipeId: intake.recipeId, fileCount: files.length });
          return { files: files.length, recipeId: intake.recipeId ?? null };
        },
      },
      {
        id: 'prepare',
        dependsOn: ['scaffold'],
        description: 'Materialize the web/android/ios runners when missing (flutter create --platforms).',
        timeoutMs: 90_000,
        retry: { maxAttempts: 1 },
        run: async (ctx) => {
          const input = ctx.input as PromptToAppInput;
          const target = (input?.target ?? 'web') as ReleaseTarget;
          const workspace = getProjectWorkspace(input.projectId);
          const platform = target === 'ios-archive' ? 'ios' : target === 'android-apk' || target === 'android-aab' ? 'android' : 'web';
          const runnerDir = RUNNER_DIR[platform as 'web' | 'android' | 'ios'];
          if (existsSync(path.join(workspace, runnerDir))) {
            return { skipped: true, reason: `${runnerDir}/ present` };
          }
          const flutterBin = process.env.FLUTTER_BIN || 'flutter';
          let result;
          try {
            result = await defaultReleaseCommandRunner([flutterBin, 'create', '.', '--platforms', platform], { cwd: workspace, timeoutMs: 80_000 });
          } catch (error) {
            throw new PlatformError({
              code: 'PREPARE_FAILED',
              message: `flutter create --platforms ${platform} could not start: ${error instanceof Error ? error.message : String(error)}`,
              statusCode: 422,
              details: { platform },
            });
          }
          if (result.code !== 0) {
            const tail = ((result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ') || 'no output').slice(0, 400);
            throw new PlatformError({
              code: 'PREPARE_FAILED',
              message: `flutter create failed (exit ${result.code}): ${tail}`,
              statusCode: 422,
              details: { platform, exitCode: result.code, timedOut: Boolean(result.timedOut) },
            });
          }
          await ctx.emit('prompt.to.app.prepared', { platform });

          // flutter create drops in a test/widget_test.dart that expects MyApp.
          // Rewrite it to a minimal smoke test that matches whatever root
          // widget the recipe built — avoids the verifier's
          // creation_with_non_type diagnostic.
          const appDart = path.join(workspace, 'lib', 'app', 'app.dart');
          if (existsSync(appDart)) {
            const source = await fs.readFile(appDart, 'utf8');
            const match = source.match(/class ([A-Za-z_][A-Za-z0-9_]*App)\s+extends\s+(?:StatelessWidget|StatefulWidget)/);
            const rootWidget = match?.[1] ?? null;
            if (rootWidget) {
              const testPath = path.join(workspace, 'test', 'widget_test.dart');
              await fs.mkdir(path.dirname(testPath), { recursive: true });
              await fs.writeFile(
                testPath,
                `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../lib/app/app.dart';

void main() {
  testWidgets('App smoke test', (WidgetTester tester) async {
    await tester.pumpWidget(const ${rootWidget}());
    expect(find.byType(MaterialApp), findsOneWidget);
  });
}
`,
              );
            }
          }

          return { prepared: true, platform };
        },
      },
      {
        id: 'verify',
        dependsOn: ['prepare'],
        description: 'Run the Flutter toolchain gate (pub get + dart analyze).',
        timeoutMs: 10 * 60_000,
        retry: { maxAttempts: 1 },
        run: async (ctx) => {
          const input = ctx.input as PromptToAppInput;
          const workspace = getProjectWorkspace(input.projectId);
          const snapshot = await snapshotToFiles(workspace);
          if (snapshot.length === 0) throw new PlatformError({ code: 'EMPTY_WORKSPACE', message: 'No files found after scaffold.', statusCode: 422 });
          const result = await verifyProject({ projectId: input.projectId, files: snapshot });
          if (!result.verified) {
            throw new PlatformError({
              code: 'VERIFY_FAILED',
              message: `Verification failed — ${result.diagnostics?.[0]?.message ?? 'unknown'}`,
              statusCode: 422,
              details: { errorCount: result.errorCount ?? 0, warningCount: result.warningCount ?? 0 },
            });
          }
          await ctx.emit('prompt.to.app.verified', { errorCount: result.errorCount, warningCount: result.warningCount });
          return { verified: true, diagnosticCount: result.diagnostics?.length ?? 0 };
        },
      },
      {
        id: 'release',
        dependsOn: ['verify'],
        description: 'Build release artifact and emit sha256 manifest.',
        timeoutMs: 25 * 60_000,
        retry: { maxAttempts: 1 },
        run: async (ctx) => {
          const input = ctx.input as PromptToAppInput;
          const target = (input?.target ?? 'web') as ReleaseTarget;
          const workspace = getProjectWorkspace(input.projectId);
          const readiness = await checkReleaseReadiness({ target, projectId: input.projectId, projectRoot: workspace });
          if (!readiness.ready) {
            throw new PlatformError({ code: 'RELEASE_NOT_READY', message: readiness.blockers.join('; '), statusCode: 422, details: { blockers: readiness.blockers, warnings: readiness.warnings } });
          }
          const plan = buildReleasePlan({ target, projectId: input.projectId, projectRoot: workspace, artifactDir: path.join(platform.dataDir, 'releases'), tenantId: ctx.tenantId, actor: ctx.actor });
          const result = await executeReleasePlan({ plan, platform: process.platform, tenantId: ctx.tenantId, actor: ctx.actor, projectRoot: workspace });
          await ctx.emit('prompt.to.app.released', { jobId: result.job.id, artifact: result.artifact, size: result.size, sha256: result.sha256 });
          return { jobId: result.job.id, target, artifact: result.artifact, size: result.size, sha256: result.sha256 };
        },
      },
    ],
  };
}

async function snapshotToFiles(root: string): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  const walk = async (dir: string, base: string) => {
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!/\.(dart|yaml|yml|json|md|txt|gradle|properties|xml|arb|swift|kt|kts|gitignore)$/.test(entry.name)) continue;
      try {
        const content = await fs.readFile(abs, 'utf8');
        if (content.length > 4 * 1024 * 1024) continue;
        out.push({ path: rel, content });
      } catch {
        // skip unreadables
      }
    }
  };
  await walk(root, '');
  return out;
}
