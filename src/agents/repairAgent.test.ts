import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { GeneratedFile, GateDiagnostic, ProjectState } from '../orchestrator/state';
import { runRepairAgent, repairFingerprint } from './repairAgent';

const { callLLMTextMock } = vi.hoisted(() => ({
  callLLMTextMock: vi.fn(),
}));

vi.mock('./llmClient', () => ({
  callLLMText: callLLMTextMock,
  agentModelFor: () => 'test-model',
  parseFilesFromLLMOutput: () => [],
}));

function errorDiag(filePath: string, message: string, line?: number): GateDiagnostic {
  return { gate: 'G9-test', level: 'error', filePath, line, message, suggestion: 'fix it' };
}

function genFile(path: string, content: string): GeneratedFile {
  return { path, content, action: 'created', language: path.endsWith('.dart') ? 'dart' : 'yaml' };
}

function seededFiles(): Map<string, GeneratedFile> {
  return new Map<string, GeneratedFile>([
    ['lib/features/alpha.dart', genFile('lib/features/alpha.dart', 'class Alpha {\n  const Alpha( {\n')],
    ['lib/features/beta.dart', genFile('lib/features/beta.dart', 'class Beta {\n  const Beta( {\n')],
    ['lib/features/gamma.dart', genFile('lib/features/gamma.dart', 'class Gamma {\n  const Gamma();\n}\n')],
  ]);
}

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectId: 'p-test',
    userPrompt: 'build it',
    status: 'verifying',
    productBrief: {
      appName: 'Demo',
      oneLiner: 'one',
      targetAudience: 'all',
      primaryProblem: 'none',
      platforms: ['android'],
      constraints: [],
    },
    screenGraph: null,
    designTokens: null,
    architectureSpec: null,
    architecture: null,
    dataSchema: null,
    plan: null,
    generatedFiles: seededFiles(),
    diagnostics: [],
    repairAttempts: 1,
    logs: ['seed log'],
    ...overrides,
  };
}

// Extracted candidates are trimmed by the parser, so expected file content
// has no leading/trailing blank lines.
const ALPHA_FIX = 'class Alpha {\n  const Alpha();\n}';
const BETA_FIX = 'class Beta {\n  const Beta();\n}';

function userMessageOf(callIndex: number): string {
  const messages = callLLMTextMock.mock.calls[callIndex][0] as Array<{ role: string; content: string }>;
  return messages.find((m) => m.role === 'user')?.content ?? '';
}

describe('runRepairAgent', () => {
  beforeEach(() => {
    callLLMTextMock.mockReset();
  });

  it('regenerates only files with error diagnostics and leaves clean files unchanged', async () => {
    callLLMTextMock.mockImplementation(async (messages: Array<{ role: string; content: string }>) => {
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      if (user.includes('lib/features/alpha.dart')) return ALPHA_FIX;
      if (user.includes('lib/features/beta.dart')) return `\`\`\`dart\n${BETA_FIX}\`\`\`\n`;
      throw new Error(`unexpected repair target: ${user.slice(0, 120)}`);
    });

    const state = makeState({
      diagnostics: [
        errorDiag('lib/features/beta.dart', 'bad import', 1),
        errorDiag('lib/features/alpha.dart', 'missing semicolon', 2),
      ],
    });
    const result = await runRepairAgent(state);

    // One LLM call per diagnostics-file pair, deterministic sorted scope.
    expect(callLLMTextMock).toHaveBeenCalledTimes(2);
    expect(userMessageOf(0)).toContain('lib/features/alpha.dart');
    expect(userMessageOf(1)).toContain('lib/features/beta.dart');

    // Only the diagnosed files were regenerated.
    expect(result.generatedFiles?.get('lib/features/alpha.dart')?.content).toBe(ALPHA_FIX);
    expect(result.generatedFiles?.get('lib/features/beta.dart')?.content).toBe(BETA_FIX);

    // The clean file was never rewritten.
    expect(result.generatedFiles?.get('lib/features/gamma.dart')?.content)
      .toBe('class Gamma {\n  const Gamma();\n}\n');

    // Only per-file content + its own diagnostics are sent — not other files.
    expect(userMessageOf(0)).not.toContain('class Beta');
    expect(userMessageOf(0)).toContain('missing semicolon');
    expect(userMessageOf(1)).toContain('bad import');

    expect(result.repairAttempts).toBe(2);
    expect((result.logs ?? []).join('\n')).toMatch(/2 LLM call\(s\) made/);
  });

  it('leaves a file unchanged when the LLM returns garbage for it', async () => {
    callLLMTextMock.mockImplementation(async (messages: Array<{ role: string; content: string }>) => {
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      if (user.includes('lib/features/alpha.dart')) {
        return 'Sorry, I cannot fix this — the diagnostics are unclear. 🤷\nTry upgrading your Flutter SDK!';
      }
      return BETA_FIX;
    });

    const alphaBefore = seededFiles().get('lib/features/alpha.dart')?.content;
    const state = makeState({
      diagnostics: [
        errorDiag('lib/features/alpha.dart', 'missing semicolon', 2),
        errorDiag('lib/features/beta.dart', 'bad import', 1),
      ],
    });
    const result = await runRepairAgent(state);

    // Garbage candidate → nothing written for alpha; beta still repaired.
    expect(result.generatedFiles?.get('lib/features/alpha.dart')?.content).toBe(alphaBefore);
    expect(result.generatedFiles?.get('lib/features/beta.dart')?.content).toBe(BETA_FIX);
    expect((result.logs ?? []).join('\n'))
      .toContain('repair parse failed for lib/features/alpha.dart; left unchanged');
    expect(result.repairAttempts).toBe(2);
  });

  it('detects oscillation when fingerprints match a recorded previous pass and keeps files unchanged', async () => {
    const diag = errorDiag('lib/features/alpha.dart', 'missing semicolon', 2);
    const recorded = {
      'lib/features/alpha.dart': [repairFingerprint(diag)],
    };
    const alphaBefore = seededFiles().get('lib/features/alpha.dart')?.content;

    const state = makeState({
      diagnostics: [diag],
      _repairFingerprints: recorded,
    } as Partial<ProjectState>);
    const result = await runRepairAgent(state);

    // No LLM call for the oscillating file.
    expect(callLLMTextMock).not.toHaveBeenCalled();
    expect(result.generatedFiles?.get('lib/features/alpha.dart')?.content).toBe(alphaBefore);
    expect((result.logs ?? []).join('\n'))
      .toContain('oscillation detected for lib/features/alpha.dart; keeping previous content');

    // repairAttempts still increments monotonically.
    expect(result.repairAttempts).toBe(2);
  });

  it('increments repairAttempts and keeps the exact no-errors log when there is nothing to repair', async () => {
    const state = makeState({
      diagnostics: [{ gate: 'G1-style', level: 'warning', filePath: 'lib/features/alpha.dart', message: 'prefer const' }],
    });
    const result = await runRepairAgent(state);

    expect(result.repairAttempts).toBe(2);
    expect(result.logs).toContain('[Repair Agent] No errors to repair.');
    expect(callLLMTextMock).not.toHaveBeenCalled();
  });

  it('truncates oversized files so the LLM prompt stays under the token budget', async () => {
    const bigLines: string[] = [];
    for (let i = 1; i <= 1000; i += 1) {
      bigLines.push(i === 800 ? 'final needleLine800 = 42; // NEEDLE_800' : `final v${i} = 1; // abcdefg`);
    }
    const bigContent = bigLines.join('\n');
    expect(bigContent.length).toBeGreaterThan(12_000);

    let capturedUser = '';
    callLLMTextMock.mockImplementation(async (messages: Array<{ role: string; content: string }>) => {
      capturedUser = messages.map((m) => m.content).join('\n');
      return 'class Big {\n  const Big();\n}';
    });

    const files = new Map(seededFiles());
    files.set('lib/features/big.dart', genFile('lib/features/big.dart', bigContent));

    const state = makeState({
      generatedFiles: files,
      diagnostics: [errorDiag('lib/features/big.dart', 'broken near line 800', 800)],
    });
    const result = await runRepairAgent(state);

    expect(callLLMTextMock).toHaveBeenCalledTimes(1);
    expect(capturedUser.length).toBeLessThan(14_000);
    expect(capturedUser).toContain('// ... (truncated)');
    expect(capturedUser).toContain('NEEDLE_800');
    // The repaired file is the candidate the LLM returned, not the truncated view.
    expect(result.generatedFiles?.get('lib/features/big.dart')?.content).toBe('class Big {\n  const Big();\n}');
  });

  it('makes exactly one LLM call per diagnostics file even with multiple diagnostics on it', async () => {
    callLLMTextMock.mockImplementation(async () => ALPHA_FIX);

    const state = makeState({
      diagnostics: [
        errorDiag('lib/features/alpha.dart', 'missing semicolon', 3),
        errorDiag('lib/features/alpha.dart', 'unterminated string', 7),
      ],
    });
    const result = await runRepairAgent(state);

    expect(callLLMTextMock).toHaveBeenCalledTimes(1);
    expect(userMessageOf(0)).toContain('missing semicolon');
    expect(userMessageOf(0)).toContain('unterminated string');
    expect(result.repairAttempts).toBe(2);
    expect((result.logs ?? []).join('\n')).toContain('1 LLM call(s) made this pass');
  });
});
