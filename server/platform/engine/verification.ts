import type { ToolContext, EngineerVerification } from './types.js';
import { redact, truncate } from './util.js';

/** All compiler/test/build execution uses the same isolated worker as tools. */
export async function verifyWorkspace(context: ToolContext): Promise<EngineerVerification> {
  const evidence: string[] = [];
  const notes: string[] = [];
  const commands = [
    ['flutter', 'pub', 'get'],
    ['flutter', 'analyze', '--no-pub', '--no-fatal-infos'],
    ['flutter', 'test', '--no-pub'],
    ['flutter', 'build', 'web', '--no-pub'],
  ];
  const steps = commands.map(argv => ({ command: argv.join(' '), status: 'skipped' as 'skipped' | 'passed' | 'failed' }));
  for (const [index, argv] of commands.entries()) {
    context.emit({ type: 'progress', phase: 'verifying', message: argv.join(' ') });
    const result = await context.sandbox.run({ argv, cwd: context.projectRoot, timeoutMs: 600_000 }, { signal: context.signal });
    const text = redact(`${argv.join(' ')}\nexit=${result.exitCode}; timeout=${result.timedOut}\n${result.stdout}\n${result.stderr}`);
    const artifact = await context.artifacts.write(`verify-${Date.now()}-${argv[1]}.txt`, Buffer.from(text), 'text/plain');
    evidence.push(artifact);
    if (argv[1] === 'analyze') notes.push(...text.split('\n').filter(line => /^\s*info\s+•/.test(line)));
    if (result.exitCode !== 0 || result.timedOut || result.killed) {
      steps[index].status = 'failed';
      return { passed: false, steps, summary: truncate(text, 8000), errorCount: 1, warningCount: 0, diagnostics: [], evidence, at: Date.now() };
    }
    steps[index].status = 'passed';
  }
  return { passed: true, steps, summary: `Dependency resolution, analyzer, tests and web build passed.${notes.length ? ` Analyzer reported ${notes.length} informational notices.` : ''}`, errorCount: 0, warningCount: 0, diagnostics: [], evidence, at: Date.now() };
}
