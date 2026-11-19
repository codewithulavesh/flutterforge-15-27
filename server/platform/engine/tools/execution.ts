/**
 * Real command execution tools.
 *
 * Nothing here fabricates output: every tool funnels through the platform
 * sandbox runner, which enforces the argv allowlist, workspace containment,
 * resource limits and timeouts. A tool only reports success when the process
 * actually exited 0.
 */
import { z } from 'zod';
import { basename } from 'node:path';
import type { SandboxResult } from '../../sandbox/index.js';
import type { EngineerToolSpec, ToolApprovalVerdict, ToolOutcome } from '../types.js';
import { truncate, redact } from '../util.js';

const MAX_OUTPUT = 24_000;

export function formatSandboxResult(result: SandboxResult, label: string): ToolOutcome {
  const stdout = redact(result.stdout ?? '');
  const stderr = redact(result.stderr ?? '');
  const ok = result.exitCode === 0 && !result.timedOut;
  const sections: string[] = [
    `${label}: exit=${result.exitCode ?? 'signal'} signal=${result.signal ?? 'none'} duration=${result.durationMs}ms${result.timedOut ? ' TIMED OUT' : ''}${result.truncated ? ' (output truncated)' : ''}`,
  ];
  if (stdout.trim() !== '') sections.push(`stdout:\n${truncate(stdout.trimEnd(), MAX_OUTPUT)}`);
  if (stderr.trim() !== '') sections.push(`stderr:\n${truncate(stderr.trimEnd(), MAX_OUTPUT)}`);
  if (stdout.trim() === '' && stderr.trim() === '') sections.push('(no output)');
  if (!ok) sections.push('RESULT: FAILED — do not describe this step as successful.');
  return {
    content: sections.join('\n\n'),
    data: {
      command: result.command,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      truncated: result.truncated,
      ok,
    },
  };
}

function approvalForCommand(argv: string[]): ToolApprovalVerdict {
  const program = basename(argv[0] ?? '').replace(/\.(exe|cmd|bat)$/i, '');
  const positional = argv.slice(1).filter((arg) => !arg.startsWith('-'));
  if (program === 'git') {
    const sub = positional[0];
    if (sub === 'checkout' || sub === 'stash' || sub === 'reset' || sub === 'clean' || sub === 'restore') {
      return { required: true, risk: 'high', reason: `git ${sub} can discard uncommitted work.` };
    }
  }
  if (program === 'flutter' && positional[0] === 'clean') {
    return { required: false, risk: 'low' };
  }
  if (program === 'flutter' && positional[0] === 'pub' && positional[1] === 'upgrade') {
    return { required: false, risk: 'medium' };
  }
  if (program === 'mv' || program === 'cp') {
    return { required: false, risk: 'medium' };
  }
  return { required: false, risk: 'low' };
}

export const commandTool: EngineerToolSpec = {
  name: 'run_command',
  description:
    'Run an allowlisted command inside the project workspace (flutter, dart, git, node, npm, ls, cat, ...). '
    + 'There is no shell: pass argv as an array, e.g. ["flutter","pub","get"]. '
    + 'Returns the real exit code, stdout and stderr. Use dedicated tools when available.',
  schema: z.object({
    argv: z.array(z.string().min(1)).min(1).max(64),
    cwd: z.string().optional().describe('Project-relative working directory. Defaults to the project root.'),
    timeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
    stdin: z.string().max(100_000).optional(),
  }),
  approval: (input) => approvalForCommand(Array.isArray(input?.argv) ? input.argv : []),
  invoke: async (input, context): Promise<ToolOutcome> => {
    const argv = input.argv.map((arg: string) => String(arg));
    let cwd = context.projectRoot;
    if (typeof input.cwd === 'string' && input.cwd.trim() !== '' && input.cwd.trim() !== '.') {
      const { resolveInside } = await import('../../../harness/workspace.js');
      cwd = resolveInside(context.projectRoot, input.cwd);
    }
    const result = await context.sandbox.run(
      { argv, cwd, timeoutMs: input.timeoutMs ?? 180_000, stdin: input.stdin },
      { signal: context.signal },
    );
    return formatSandboxResult(result, `${argv.join(' ')}`);
  },
};

function flutterTool(
  name: string,
  description: string,
  args: (input: any) => string[],
  defaults: { timeoutMs?: number; approval?: EngineerToolSpec['approval'] } = {},
): EngineerToolSpec {
  return {
    name,
    description,
    schema: z.object({
      timeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
    }),
    approval: defaults.approval,
    invoke: async (input, context): Promise<ToolOutcome> => {
      const argv = args(input ?? {});
      const result = await context.sandbox.run(
        { argv, cwd: context.projectRoot, timeoutMs: input?.timeoutMs ?? defaults.timeoutMs ?? 300_000 },
        { signal: context.signal },
      );
      return formatSandboxResult(result, argv.join(' '));
    },
  };
}

export const flutterTools: EngineerToolSpec[] = [
  flutterTool('flutter_doctor', 'Run `flutter doctor -v` and return the real SDK/toolchain report.', () => ['flutter', 'doctor', '-v'], { timeoutMs: 120_000 }),
  flutterTool('flutter_pub_get', 'Resolve project dependencies with `flutter pub get`. Run this after editing pubspec.yaml.', () => ['flutter', 'pub', 'get'], { timeoutMs: 300_000 }),
  flutterTool('flutter_analyze', 'Run the Dart analyzer (`flutter analyze --no-pub`) and return real diagnostics.', () => ['flutter', 'analyze', '--no-pub'], { timeoutMs: 300_000 }),
  flutterTool('flutter_test', 'Run the project test suite (`flutter test --no-pub`).', () => ['flutter', 'test', '--no-pub'], { timeoutMs: 600_000 }),
  {
    name: 'flutter_build',
    description: 'Build the application with the real Flutter toolchain. Returns the actual build result and artifact location.',
    schema: z.object({
      target: z.enum(['web', 'apk', 'appbundle', 'ios', 'macos', 'linux', 'windows']).optional(),
      release: z.boolean().optional(),
      timeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
    }),
    approval: (input) => (input?.target && input.target !== 'web'
      ? { required: false, risk: 'medium', reason: `Native ${input.target} build downloads platform toolchains and can take a long time.` }
      : { required: false, risk: 'low' }),
    invoke: async (input, context): Promise<ToolOutcome> => {
      const target = input?.target ?? 'web';
      const argv = ['flutter', 'build', target];
      if (input?.release === true) argv.push('--release');
      const result = await context.sandbox.run(
        { argv, cwd: context.projectRoot, timeoutMs: input?.timeoutMs ?? 900_000 },
        { signal: context.signal },
      );
      const outcome = formatSandboxResult(result, argv.join(' '));
      const artifact = target === 'web'
        ? `${context.projectRoot}/build/web`
        : `${context.projectRoot}/build/app/outputs`;
      outcome.data = { ...(outcome.data ?? {}), artifact, target };
      if (result.exitCode === 0) outcome.content += `\n\nBuild artifact: ${artifact}`;
      return outcome;
    },
  },
  {
    name: 'dart_format',
    description: 'Format Dart sources with `dart format`. Pass project-relative paths (default: lib test).',
    schema: z.object({
      paths: z.array(z.string()).max(20).optional(),
      output: z.enum(['write', 'show', 'none']).optional(),
    }),
    invoke: async (input, context): Promise<ToolOutcome> => {
      const paths = Array.isArray(input?.paths) && input.paths.length > 0
        ? input.paths.map((entry: string) => String(entry))
        : ['lib', 'test'];
      const argv = ['dart', 'format', ...paths, ...(input?.output === 'show' ? ['--output=show'] : [])];
      const result = await context.sandbox.run(
        { argv, cwd: context.projectRoot, timeoutMs: 180_000 },
        { signal: context.signal },
      );
      return formatSandboxResult(result, argv.join(' '));
    },
  },
];
