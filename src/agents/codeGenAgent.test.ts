import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArchitectureSpec, DataSchema, ProjectState } from '../orchestrator/state';
import { createInitialProjectState } from '../orchestrator/state';
import { runDataModelsAgent } from './dataModelsAgent';
import { runCodeGenAgent } from './codeGenAgent';

const { callLLMTextMock } = vi.hoisted(() => ({
  callLLMTextMock: vi.fn(),
}));

vi.mock('./llmClient', () => ({
  callLLMText: callLLMTextMock,
  agentModelFor: () => 'test-model',
  parseFilesFromLLMOutput: (raw: string) => {
    const files: Array<{ path: string; content: string; language: string }> = [];
    const regex = /\/\/\s*FILE:\s*([^\n]+)\n```(?:dart|yaml|json|md|markdown)?\s*\n([\s\S]*?)```/g;
    for (const match of raw.matchAll(regex)) {
      files.push({ path: match[1].trim(), content: match[2].trim(), language: 'dart' });
    }
    return files;
  },
}));

const VALID_THEME = `import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

class ThemeNotifier extends ChangeNotifier {
  ThemeMode _mode = ThemeMode.light;
  ThemeMode get mode => _mode;
}

class AppTheme {
  AppTheme._();

  static ThemeData get lightTheme => ThemeData(useMaterial3: true);
  static ThemeData get darkTheme => ThemeData(useMaterial3: true);
}
`;

function makeTables(): DataSchema {
  return {
    tables: [
      {
        name: 'users',
        enableRLS: true,
        policies: [],
        columns: [
          { name: 'id', type: 'UUID', isPrimary: true },
          { name: 'email', type: 'TEXT' },
          { name: 'full_name', type: 'TEXT', isNullable: true },
          { name: 'role', type: 'TEXT', defaultValue: "'member'" },
          { name: 'created_at', type: 'TIMESTAMPTZ', defaultValue: 'NOW()' },
        ],
      },
      {
        name: 'tasks',
        enableRLS: true,
        policies: [],
        columns: [
          { name: 'id', type: 'UUID', isPrimary: true },
          { name: 'title', type: 'TEXT' },
          { name: 'description', type: 'TEXT', isNullable: true },
          { name: 'is_done', type: 'BOOLEAN', defaultValue: 'false' },
          { name: 'user_id', type: 'UUID', isNullable: true },
        ],
      },
    ],
    migrations: [],
  };
}

function makeArchitecture(
  stateManagement: 'provider' | 'riverpod' | 'bloc' = 'provider',
  packages: Record<string, string> = { provider: '^6.1.2' }
): ArchitectureSpec {
  return {
    stateManagement,
    navigationType: 'stack',
    features: ['users', 'tasks'],
    packages,
    backendMode: 'supabase',
  };
}

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  const arch = makeArchitecture();
  const base = createInitialProjectState('test-project', 'build a tasks app');
  return {
    ...base,
    status: 'generating',
    productBrief: {
      appName: 'Demo App',
      oneLiner: 'A tiny tasks app for testing',
      targetAudience: 'developers',
      primaryProblem: 'organizing work',
      platforms: ['android'],
      constraints: [],
    },
    dataSchema: makeTables(),
    architectureSpec: arch,
    architecture: arch,
    screenGraph: { screens: [], userFlows: [] },
    ...overrides,
  };
}

async function stateAfterModels(overrides: Partial<ProjectState> = {}): Promise<ProjectState> {
  const state = makeState(overrides);
  const models = await runDataModelsAgent(state);
  return {
    ...state,
    generatedFiles: models.generatedFiles ?? state.generatedFiles,
    _modelFiles: models._modelFiles,
    logs: models.logs ?? state.logs,
    diagnostics: models.diagnostics ?? state.diagnostics,
  };
}

function delimiterBalance(content: string): { braces: number; parens: number; brackets: number } {
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "''");
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  for (const ch of stripped) {
    if (ch === '{') braces += 1;
    else if (ch === '}') braces -= 1;
    else if (ch === '(') parens += 1;
    else if (ch === ')') parens -= 1;
    else if (ch === '[') brackets += 1;
    else if (ch === ']') brackets -= 1;
  }
  return { braces, parens, brackets };
}

function expectBalanced(content: string): void {
  expect(delimiterBalance(content)).toEqual({ braces: 0, parens: 0, brackets: 0 });
}

beforeEach(() => {
  callLLMTextMock.mockReset();
  callLLMTextMock.mockResolvedValue('LLM output not parseable');
});

describe('dataModelsAgent', () => {
  it('emits models for both tables at the expected feature paths', async () => {
    const result = await runDataModelsAgent(makeState());
    const files = result.generatedFiles!;
    expect(files.has('lib/features/users/data/models/user_model.dart')).toBe(true);
    expect(files.has('lib/features/tasks/data/models/task_model.dart')).toBe(true);
  });

  it('uses lib/core/data/models when the table→feature mapping cannot be inferred', async () => {
    const arch = makeArchitecture('provider', { provider: '^6.1.2' });
    const quietArch = { ...arch, features: [] };
    const result = await runDataModelsAgent(makeState({ architectureSpec: quietArch, architecture: quietArch }));
    const files = result.generatedFiles!;
    expect(files.has('lib/core/data/models/user_model.dart')).toBe(true);
    expect(files.has('lib/core/data/models/task_model.dart')).toBe(true);
    const taskModel = files.get('lib/core/data/models/task_model.dart')!;
    expect(taskModel.content).toContain(
      "import 'package:demo_app/core/data/models/user_model.dart';"
    );
    expectBalanced(taskModel.content);
  });

  it('generates complete models with fromJson/toJson/copyWith and balanced delimiters', async () => {
    const result = await runDataModelsAgent(makeState());
    const files = result.generatedFiles!;
    const userModel = files.get('lib/features/users/data/models/user_model.dart')!;
    const taskModel = files.get('lib/features/tasks/data/models/task_model.dart')!;

    for (const model of [userModel, taskModel]) {
      expect(model).toBeDefined();
      expectBalanced(model.content);
      expect(model.content).toContain('fromJson');
      expect(model.content).toContain('toJson');
      expect(model.content).toContain('copyWith');
      expect(model.content).toContain('operator ==');
      expect(model.content).toContain('hashCode');
      expect(model.content).toContain('const '); // const constructor
      expect(model.content).not.toMatch(/\b(TODO|FIXME)\b/);
      expect(model.content).not.toContain('UnimplementedError');
      expect(model.content).not.toMatch(/^\s*part\s+of\b/m);
    }

    expect(userModel.content).toContain('class UserModel');
    expect(taskModel.content).toContain('class TaskModel');
    // required vs optional fields mirror isNullable/defaultValue
    expect(userModel.content).toContain('required this.email');
    expect(userModel.content).toContain('this.fullName,');
    expect(userModel.content).toContain("this.role = 'member',");
    expect(taskModel.content).toContain('this.isDone = false,');
  });

  it('resolves inter-model package: imports against the same batch', async () => {
    const result = await runDataModelsAgent(makeState());
    const files = result.generatedFiles!;
    const taskModel = files.get('lib/features/tasks/data/models/task_model.dart')!;

    // tasks.user_id references users — the synthesized model must import it (package:<pkg>/...).
    expect(taskModel.content).toContain(
      "import 'package:demo_app/features/users/data/models/user_model.dart';"
    );

    // Every package:<pkg>/... import in any generated file resolves to a file in the batch.
    for (const [path, file] of files) {
      for (const match of file.content.matchAll(/import\s+['"]([^'"]+)['"]/g)) {
        const uri = match[1];
        if (uri.startsWith('package:demo_app/')) {
          const target = `lib/${uri.slice('package:demo_app/'.length)}`;
          expect(files.has(target), `${path} imports unresolved ${uri}`).toBe(true);
        }
      }
    }
  });

  it('accepts a valid LLM-produced model file from the LLM path', async () => {
    callLLMTextMock.mockResolvedValueOnce(
      [
        '// FILE: lib/core/data/models/note_model.dart',
        '```dart',
        "import 'package:flutter/foundation.dart';",
        '',
        '@immutable',
        'class NoteModel {',
        '  final String id;',
        '  final String body;',
        '',
        '  const NoteModel({required this.id, required this.body});',
        '',
        '  factory NoteModel.fromJson(Map<String, dynamic> json) =>',
        "      NoteModel(id: json['id'] as String, body: json['body'] as String);",
        '',
        "  Map<String, dynamic> toJson() => {'id': id, 'body': body};",
        '',
        '  NoteModel copyWith({String? id, String? body}) =>',
        '      NoteModel(id: id ?? this.id, body: body ?? this.body);',
        '',
        '  @override',
        '  bool operator ==(Object other) =>',
        '      identical(this, other) || other is NoteModel && other.id == id;',
        '',
        '  @override',
        '  int get hashCode => id.hashCode;',
        '}',
        '```',
      ].join('\n')
    );

    const result = await runDataModelsAgent(makeState());
    const note = result.generatedFiles!.get('lib/core/data/models/note_model.dart');
    expect(note).toBeDefined();
    expect(note!.content).toContain('class NoteModel');
    expectBalanced(note!.content);
  });
});

describe('codeGenAgent', () => {
  it('emits a ChangeNotifier provider for each model with the model class name', async () => {
    const state = await stateAfterModels();
    callLLMTextMock.mockImplementation(async (messages: Array<{ role: string; content: string }>) => {
      const system = messages?.[0]?.content ?? '';
      if (system.includes('app_theme')) return VALID_THEME;
      return 'no providers in this response';
    });

    const result = await runCodeGenAgent(state);
    const files = result.generatedFiles!;

    const userProvider = files.get('lib/features/users/providers/user_provider.dart');
    const taskProvider = files.get('lib/features/tasks/providers/task_provider.dart');
    expect(userProvider).toBeDefined();
    expect(taskProvider).toBeDefined();

    for (const [provider, model] of [[userProvider, 'UserModel'], [taskProvider, 'TaskModel']] as const) {
      expect(provider!.content).toContain(`class ${model}Provider extends ChangeNotifier`);
      expect(provider!.content).toContain(model);
      expect(provider!.content).toContain(`import 'package:demo_app/`);
      expectBalanced(provider!.content);
    }
  });

  it('falls back to deterministic synthesis when the LLM emits an unparseable file', async () => {
    const state = await stateAfterModels();
    callLLMTextMock.mockImplementation(async (messages: Array<{ role: string; content: string }>) => {
      const system = messages?.[0]?.content ?? '';
      if (system.includes('app_theme')) return VALID_THEME;
      return [
        '// FILE: lib/features/tasks/providers/task_provider.dart',
        '```dart',
        'class TaskModelProvider extends ChangeNotifier {',
        '  void load() { {{{',
        '```',
      ].join('\n');
    });

    const result = await runCodeGenAgent(state);
    const files = result.generatedFiles!;

    const taskProvider = files.get('lib/features/tasks/providers/task_provider.dart');
    expect(taskProvider).toBeDefined();
    expect(taskProvider!.content).toContain('class TaskModelProvider extends ChangeNotifier');
    expect(taskProvider!.content).toContain('TaskModel');
    expectBalanced(taskProvider!.content);

    const logs = (result.logs ?? []).join('\n');
    expect(logs).toContain(
      '[CodeGenAgent] LLM parse failed for lib/features/tasks/providers/task_provider.dart; used deterministic fallback'
    );

    // The users provider is synthesized because the LLM emitted nothing for it.
    const userProvider = files.get('lib/features/users/providers/user_provider.dart');
    expect(userProvider).toBeDefined();
    expect(userProvider!.content).toContain('class UserModelProvider extends ChangeNotifier');
  });

  it('produces unique, path-sorted file maps for both agents', async () => {
    const state = makeState();
    const models = await runDataModelsAgent(state);
    const merged: ProjectState = {
      ...state,
      generatedFiles: models.generatedFiles ?? state.generatedFiles,
      _modelFiles: models._modelFiles,
      logs: models.logs ?? state.logs,
      diagnostics: models.diagnostics ?? state.diagnostics,
    };

    // Default mock returns unusable output — deterministic path with LLM no-ops.
    callLLMTextMock.mockResolvedValue('no usable output');
    const codegen = await runCodeGenAgent(merged);

    for (const result of [models, codegen]) {
      const keys = [...result.generatedFiles!.keys()];
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toEqual([...keys].sort());
    }
  });

  it('emits only balanced Dart for every deterministic file', async () => {
    const state = await stateAfterModels();
    callLLMTextMock.mockImplementation(async (messages: Array<{ role: string; content: string }>) => {
      const system = messages?.[0]?.content ?? '';
      if (system.includes('app_theme')) return VALID_THEME;
      return 'no providers in this response';
    });

    const result = await runCodeGenAgent(state);
    for (const [path, file] of result.generatedFiles!) {
      if (!path.endsWith('.dart')) continue;
      expectBalanced(file.content);
      expect(file.content).not.toMatch(/\b(TODO|FIXME)\b/);
      expect(file.content).not.toContain('UnimplementedError');
      expect(file.content).not.toMatch(/^\s*part\s+of\b/m);
    }
  });

  it('falls back to provider + warning diagnostic when bloc is requested without flutter_bloc', async () => {
    const arch = makeArchitecture('bloc', {});
    const state = await stateAfterModels({ architectureSpec: arch, architecture: arch });
    const result = await runCodeGenAgent(state);
    const files = result.generatedFiles!;

    const taskProvider = files.get('lib/features/tasks/providers/task_provider.dart')!;
    expect(taskProvider.content).toContain('ChangeNotifier');
    expect(taskProvider.content).not.toContain('flutter_bloc');

    const everything = [...files.values()].map((f) => f.content).join('\n');
    expect(everything).not.toContain('flutter_bloc');

    expect(files.get('pubspec.yaml')!.content).toContain('provider: ^6.1.2');
    expect(
      result.diagnostics!.some((d) => d.level === 'warning' && /bloc/i.test(d.message))
    ).toBe(true);
  });

  it('generates bloc/Cubit state only when flutter_bloc is declared', async () => {
    const arch = makeArchitecture('bloc', { flutter_bloc: '^8.1.6' });
    const state = await stateAfterModels({ architectureSpec: arch, architecture: arch });
    const result = await runCodeGenAgent(state);
    const files = result.generatedFiles!;

    const taskProvider = files.get('lib/features/tasks/providers/task_provider.dart')!;
    expect(taskProvider.content).toContain('class TaskModelCubit extends Cubit<TaskModelState>');
    expect(taskProvider.content).toContain("import 'package:flutter_bloc/flutter_bloc.dart';");
    expectBalanced(taskProvider.content);
    expect(files.get('pubspec.yaml')!.content).toContain('flutter_bloc: ^8.1.6');
  });
});
