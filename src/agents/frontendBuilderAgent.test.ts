import { describe, expect, it, vi } from 'vitest';
import type { ProjectState, ScreenDefinition } from '../orchestrator/state';
import { runFrontendBuilderAgent, isDartBalanced } from './frontendBuilderAgent';

const { callLLMTextMock } = vi.hoisted(() => ({
  callLLMTextMock: vi.fn(),
}));

vi.mock('./llmClient', () => ({
  callLLMText: callLLMTextMock,
  parseFilesFromLLMOutput: (raw: string) => {
    const files: Array<{ path: string; content: string }> = [];
    const regex = /\/\/ FILE:\s*(\S+)\s*\n```(?:dart)?\s*([\s\S]*?)```/g;
    for (const match of raw.matchAll(regex)) {
      files.push({ path: match[1], content: match[2].trim() });
    }
    return files;
  },
  agentModelFor: () => 'test-model',
}));

function screens(count: number): ScreenDefinition[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `feature_${index}`,
    name: `Feature${index}Screen`,
    route: `/feature-${index}`,
    purpose: `Feature ${index}`,
    primaryAction: 'Continue',
    states: { loading: 'spinner', empty: 'CTA', error: 'retry', content: 'list' },
    widgets: ['Card'],
  }));
}

function stateWith(count: number): ProjectState {
  return {
    projectId: 'p1',
    userPrompt: 'build app',
    status: 'generating',
    productBrief: { appName: 'Demo' } as ProjectState['productBrief'],
    screenGraph: { screens: screens(count), userFlows: [] },
    designTokens: null,
    architectureSpec: null,
    architecture: null,
    dataSchema: null,
    plan: null,
    generatedFiles: new Map(),
    diagnostics: [],
    repairAttempts: 0,
    logs: [],
  };
}

describe('frontend builder robustness', () => {
  function namedScreens(defs: Array<{ id: string; name: string }>): ProjectState {
    const base = stateWith(0);
    return {
      ...base,
      screenGraph: {
        screens: defs.map((def) => ({
          id: def.id,
          name: def.name,
          route: `/${def.id}`,
          purpose: `Purpose for ${def.name}`,
          primaryAction: 'Continue',
          states: { loading: 'spinner', empty: 'CTA', error: 'retry', content: 'list' },
          widgets: ['Card'],
        })),
        userFlows: [],
      },
    };
  }

  function llmScreenOutput(target: string, className: string): string {
    return `// FILE: ${target}\n\`\`\`dart\nimport 'package:flutter/material.dart';\nclass ${className} extends StatelessWidget {\n  const ${className}({super.key});\n  @override\n  Widget build(BuildContext context) {\n    final theme = Theme.of(context);\n    return Scaffold(\n      appBar: AppBar(title: Text('${className}', style: theme.textTheme.titleLarge)),\n      body: Center(child: Text('content', style: theme.textTheme.bodyMedium)),\n    );\n  }\n}\n\`\`\``;
  }

  function llmBrokenOutput(target: string): string {
    return `// FILE: ${target}\n\`\`\`dart\nimport 'package:flutter/material.dart';\nclass BrokenScreen extends StatelessWidget {\n  @override\n  Widget build(BuildContext context) {\n    return Scaffold(\n      body: Column(\n        children: [\n          Text('truncated mid-widget'\n\`\`\``;
  }

  function routeFromPrompt(messages: Array<{ content: string }>): string {
    const user = String(messages[1]?.content ?? '');
    const match = user.match(/Output path \(use EXACTLY\): \/\/ FILE: (\S+)/);
    return match?.[1] ?? '';
  }

  it('returns a diagnostic and writes NOTHING for a screen whose LLM output has unbalanced braces', async () => {
    callLLMTextMock.mockReset();
    callLLMTextMock.mockImplementation(async (messages: Array<{ content: string }>) => {
      const target = routeFromPrompt(messages);
      if (target.includes('feature_1')) return llmBrokenOutput(target);
      return llmScreenOutput(target, 'GeneratedScreen');
    });

    const result = await runFrontendBuilderAgent(
      namedScreens([
        { id: 'feature_0', name: 'Feature0Screen' },
        { id: 'feature_1', name: 'Feature1Screen' },
      ]),
    );

    // Exactly half of the screens failed → below the fail-fast threshold.
    const paths = [...result.generatedFiles!.keys()];
    expect(paths).toContain('lib/features/feature_0/screens/feature0_screen.dart');
    expect(paths).not.toContain('lib/features/feature_1/screens/feature1_screen.dart');

    const diagnostics = result.diagnostics ?? [];
    const broken = diagnostics.find((d) => d.filePath === 'lib/features/feature_1/screens/feature1_screen.dart');
    expect(broken).toBeDefined();
    expect(broken!.level).toBe('error');
    expect(broken!.message).toMatch(/unbalanced/i);
    expect(broken!.message).toContain('Feature1Screen');
  });

  it('throws with the failing screen names when more than half of the screens fail the structural check', async () => {
    callLLMTextMock.mockReset();
    callLLMTextMock.mockImplementation(async (messages: Array<{ content: string }>) => {
      const target = routeFromPrompt(messages);
      return llmBrokenOutput(target);
    });

    await expect(
      runFrontendBuilderAgent(
        namedScreens([
          { id: 'feature_0', name: 'Feature0Screen' },
          { id: 'feature_1', name: 'Feature1Screen' },
          { id: 'feature_2', name: 'Feature2Screen' },
        ]),
      ),
    ).rejects.toThrow(/Feature[02]Screen/);

    callLLMTextMock.mockImplementation(async (messages: Array<{ content: string }>) => {
      const target = routeFromPrompt(messages);
      if (target.includes('feature_1') || target.includes('feature_2')) return llmBrokenOutput(target);
      return llmScreenOutput(target, 'GeneratedScreen');
    });

    await expect(
      runFrontendBuilderAgent(
        namedScreens([
          { id: 'feature_0', name: 'Feature0Screen' },
          { id: 'feature_1', name: 'Feature1Screen' },
          { id: 'feature_2', name: 'Feature2Screen' },
        ]),
      ),
    ).rejects.toThrow(/Feature1Screen/);
  });

  it('generated screen contains Theme.of(context) and a material import, and no TODO markers', async () => {
    // LLM path
    callLLMTextMock.mockReset();
    callLLMTextMock.mockImplementation(async (messages: Array<{ content: string }>) => {
      const target = routeFromPrompt(messages);
      return llmScreenOutput(target, 'GeneratedScreen');
    });

    const llmResult = await runFrontendBuilderAgent(namedScreens([{ id: 'feature_0', name: 'Feature0Screen' }]));
    const llmFile = llmResult.generatedFiles!.get('lib/features/feature_0/screens/feature0_screen.dart');
    expect(llmFile).toBeDefined();
    expect(llmFile!.content).toContain("package:flutter/material.dart");
    expect(llmFile!.content).toContain('Theme.of(context)');
    expect(llmFile!.content).not.toMatch(/TODO|FIXME|UnimplementedError|placeholder/i);

    // Deterministic fallback path (LLM produced no parseable output at all)
    callLLMTextMock.mockReset();
    callLLMTextMock.mockImplementation(async () => 'garbage output with no FILE markers');

    const fallbackResult = await runFrontendBuilderAgent(namedScreens([{ id: 'feature_0', name: 'Feature0Screen' }]));
    const fallbackFile = fallbackResult.generatedFiles!.get('lib/features/feature_0/screens/feature0_screen.dart');
    expect(fallbackFile).toBeDefined();
    expect(fallbackFile!.content).toContain("package:flutter/material.dart");
    expect(fallbackFile!.content).toContain('Theme.of(context)');
    expect(fallbackFile!.content).not.toMatch(/TODO|FIXME|UnimplementedError|placeholder/i);
    // The deterministic fallback must always pass the same structural check the pipeline applies.
    expect(isDartBalanced(fallbackFile!.content)).toBe(true);
  });

  it('two screens from the same graph produce unique class names derived from the singularized screen name', async () => {
    callLLMTextMock.mockReset();
    // The LLM emits the SAME generic class name for both screens; the agent
    // must rename each to a unique class derived from the screen name.
    callLLMTextMock.mockImplementation(async (messages: Array<{ content: string }>) => {
      const target = routeFromPrompt(messages);
      return llmScreenOutput(target, 'GeneratedScreen');
    });

    const result = await runFrontendBuilderAgent(
      namedScreens([
        { id: 'users', name: 'UsersScreen' },
        { id: 'tasks', name: 'TasksScreen' },
      ]),
    );

    const users = result.generatedFiles!.get('lib/features/users/screens/users_screen.dart');
    const tasks = result.generatedFiles!.get('lib/features/tasks/screens/tasks_screen.dart');
    expect(users).toBeDefined();
    expect(tasks).toBeDefined();
    expect(users!.content).toContain('class UserScreen');
    expect(tasks!.content).toContain('class TaskScreen');
    expect(users!.content).not.toContain('class GeneratedScreen');
    expect(tasks!.content).not.toContain('class GeneratedScreen');
    // Singular, derived class names must be unique across the graph.
    const classNames = [...result.generatedFiles!.values()].map((f) => f.content.match(/class\s+(\w+)\s+extends/)?.[1]);
    expect(new Set(classNames).size).toBe(classNames.length);
  });
});

describe('frontend builder concurrency', () => {
  it('generates screens in limited parallel batches', async () => {
    let active = 0;
    let peak = 0;
    callLLMTextMock.mockReset();
    callLLMTextMock.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      // Deliberately emit a WRONG path; the agent must canonicalize it.
      return '// FILE: lib/wrong/place.dart\n```dart\nimport \'package:flutter/material.dart\';\nclass Generated extends StatelessWidget { const Generated({super.key}); @override Widget build(BuildContext c) => const SizedBox(); }\n```';
    });

    const result = await runFrontendBuilderAgent(stateWith(7));

    // With 3 concurrent slots, 7 screens take 3 batches; peak must be exactly 3.
    expect(peak).toBe(3);
    expect(callLLMTextMock).toHaveBeenCalledTimes(7);
    const paths = [...result.generatedFiles!.keys()].sort();
    expect(paths).toEqual([
      'lib/features/feature_0/screens/feature0_screen.dart',
      'lib/features/feature_1/screens/feature1_screen.dart',
      'lib/features/feature_2/screens/feature2_screen.dart',
      'lib/features/feature_3/screens/feature3_screen.dart',
      'lib/features/feature_4/screens/feature4_screen.dart',
      'lib/features/feature_5/screens/feature5_screen.dart',
      'lib/features/feature_6/screens/feature6_screen.dart',
    ]);
    expect(result.logs!.join('\n')).toContain('batches of 3');
  });
});
