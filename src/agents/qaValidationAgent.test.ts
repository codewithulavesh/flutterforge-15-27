import { describe, expect, it } from 'vitest';
import type { GeneratedFile, ProjectState } from '../orchestrator/state';
import { createInitialProjectState } from '../orchestrator/state';
import { diagnosticFingerprint, runQAValidationAgent } from './qaValidationAgent';

const PKG = 'demo_app';

const PUBSPEC = `name: ${PKG}
description: A demo app used by the QA validation agent tests.
publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: '>=3.3.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  go_router: ^14.6.2

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^4.0.0

flutter:
  uses-material-design: true
`;

const SELF_CONTAINING_PUBSPEC = PUBSPEC.replace(
  'dependencies:\n  flutter:',
  'dependencies:\n  demo_app: ^1.0.0\n  flutter:',
);

const INVALID_NAME_PUBSPEC = PUBSPEC.replace(`name: ${PKG}`, 'name: Demo App');

const APP_DART = `import 'package:flutter/material.dart';

class DemoApp extends StatelessWidget {
  const DemoApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      title: 'Demo',
      home: Scaffold(body: Center(child: Text('Demo'))),
    );
  }
}
`;

const APP_DART_WITH_TODO = `import 'package:flutter/material.dart';

// TODO: implement the final brand palette
class DemoApp extends StatelessWidget {
  const DemoApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      title: 'Demo',
      home: Scaffold(body: Center(child: Text('Demo'))),
    );
  }
}
`;

const MAIN_DART = `import 'package:flutter/material.dart';
import 'package:${PKG}/app/app.dart';

void main() {
  runApp(const DemoApp());
}
`;

/** Entrypoint that does not import the app package — isolates single-gate failures. */
const INDEPENDENT_MAIN = `import 'package:flutter/material.dart';

void main() {
  runApp(const MaterialApp(home: Scaffold()));
}
`;

const MAIN_WITHOUT_RUN_APP = `import 'package:flutter/material.dart';

void main() {
  debugPrint('boot');
}
`;

function makeFile(path: string, content: string): GeneratedFile {
  return {
    path,
    content,
    action: 'created',
    language: path.endsWith('.dart') ? 'dart' : path.endsWith('.yaml') ? 'yaml' : 'text',
  };
}

function screenContent(className: string, imports: string[] = []): string {
  const importBlock = imports.length > 0 ? `${imports.join('\n')}\n\n` : '';
  return `${importBlock}import 'package:flutter/material.dart';

class ${className} extends StatelessWidget {
  const ${className}({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(body: SizedBox());
  }
}
`;
}

function greenFiles(): Map<string, GeneratedFile> {
  return new Map<string, GeneratedFile>([
    ['pubspec.yaml', makeFile('pubspec.yaml', PUBSPEC)],
    ['lib/main.dart', makeFile('lib/main.dart', MAIN_DART)],
    ['lib/app/app.dart', makeFile('lib/app/app.dart', APP_DART)],
  ]);
}

function stateWith(files: Map<string, GeneratedFile>, repairAttempts = 0): ProjectState {
  const state = createInitialProjectState('qa-validation-test', 'Build a demo app');
  state.generatedFiles = files;
  state.repairAttempts = repairAttempts;
  state.logs = ['[seed] test state'];
  return state;
}

function diagnosticCodes(result: Partial<ProjectState>): Array<string | undefined> {
  return (result.diagnostics ?? []).map((d) => d.code);
}

describe('runQAValidationAgent', () => {
  it('returns zero error diagnostics for a green project and keeps repairAttempts untouched', async () => {
    const result = await runQAValidationAgent(stateWith(greenFiles(), 2));

    expect(result.diagnostics).toEqual([]);
    expect(result.repairAttempts).toBe(2);
    expect(result.logs?.join('\n')).toContain('[QA Validation Agent]');
  });

  it('accepts the legacy lib/app.dart shell root', async () => {
    const files = greenFiles();
    files.delete('lib/app/app.dart');
    files.set('lib/app.dart', makeFile('lib/app.dart', APP_DART));
    files.set('lib/main.dart', makeFile('lib/main.dart', INDEPENDENT_MAIN));

    const result = await runQAValidationAgent(stateWith(files));

    expect(diagnosticCodes(result)).not.toContain('MISSING_SHELL_FILE');
    expect((result.diagnostics ?? []).filter((d) => d.level === 'error')).toHaveLength(0);
  });

  it('reports MISSING_MAIN when lib/main.dart is absent', async () => {
    const files = greenFiles();
    files.delete('lib/main.dart');

    const result = await runQAValidationAgent(stateWith(files));

    const missing = (result.diagnostics ?? []).filter((d) => d.code === 'MISSING_MAIN');
    expect(missing).toHaveLength(1);
    expect(missing[0].level).toBe('error');
    expect(missing[0].filePath).toBe('lib/main.dart');
    expect(diagnosticCodes(result)).not.toContain('MISSING_RUN_APP');
  });

  it('reports MISSING_RUN_APP when lib/main.dart never calls runApp()', async () => {
    const files = greenFiles();
    files.set('lib/main.dart', makeFile('lib/main.dart', MAIN_WITHOUT_RUN_APP));

    const result = await runQAValidationAgent(stateWith(files));

    const missing = (result.diagnostics ?? []).filter((d) => d.code === 'MISSING_RUN_APP');
    expect(missing).toHaveLength(1);
    expect(missing[0].level).toBe('error');
    expect(diagnosticCodes(result)).not.toContain('MISSING_MAIN');
  });

  it('reports MISSING_SHELL_FILE when neither app root exists', async () => {
    const files = greenFiles();
    files.delete('lib/app/app.dart');
    files.set('lib/main.dart', makeFile('lib/main.dart', INDEPENDENT_MAIN));

    const result = await runQAValidationAgent(stateWith(files));

    const shell = (result.diagnostics ?? []).filter((d) => d.code === 'MISSING_SHELL_FILE');
    expect(shell).toHaveLength(1);
    expect(shell[0].level).toBe('error');
    expect(shell[0].filePath).toBe('lib/app/app.dart');
  });

  it('reports PACKAGE_MISMATCH for a pubspec package name that is not a Dart slug', async () => {
    const files = greenFiles();
    files.set('pubspec.yaml', makeFile('pubspec.yaml', INVALID_NAME_PUBSPEC));
    files.set('lib/main.dart', makeFile('lib/main.dart', INDEPENDENT_MAIN));

    const result = await runQAValidationAgent(stateWith(files));

    const mismatch = (result.diagnostics ?? []).filter((d) => d.code === 'PACKAGE_MISMATCH');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].level).toBe('error');
    expect(mismatch[0].filePath).toBe('pubspec.yaml');
  });

  it('reports UNRESOLVED_IMPORT with the importing filePath for a dangling self-package import', async () => {
    const files = greenFiles();
    const screenPath = 'lib/features/home/screens/home_screen.dart';
    files.set(
      screenPath,
      makeFile(
        screenPath,
        screenContent('HomeScreen', [
          `import 'package:${PKG}/core/ghost.dart';`,
        ]),
      ),
    );

    const result = await runQAValidationAgent(stateWith(files));

    const unresolved = (result.diagnostics ?? []).filter((d) => d.code === 'UNRESOLVED_IMPORT');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].level).toBe('error');
    expect(unresolved[0].filePath).toBe(screenPath);
    expect(unresolved[0].message).toContain(`package:${PKG}/core/ghost.dart`);
  });

  it('reports UNDECLARED_DEPENDENCY for an external package missing from pubspec.yaml', async () => {
    const files = greenFiles();
    const screenPath = 'lib/features/home/screens/home_screen.dart';
    files.set(
      screenPath,
      makeFile(
        screenPath,
        screenContent('HomeScreen', [
          "import 'package:http/http.dart';",
        ]),
      ),
    );

    const result = await runQAValidationAgent(stateWith(files));

    const undeclared = (result.diagnostics ?? []).filter((d) => d.code === 'UNDECLARED_DEPENDENCY');
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0].level).toBe('error');
    expect(undeclared[0].filePath).toBe(screenPath);
    expect(undeclared[0].message).toContain('package:http');
  });

  it('reports placeholder markers as warnings, never as errors', async () => {
    const files = greenFiles();
    files.set('lib/app/app.dart', makeFile('lib/app/app.dart', APP_DART_WITH_TODO));

    const result = await runQAValidationAgent(stateWith(files));

    const placeholders = (result.diagnostics ?? []).filter((d) => d.code === 'PLACEHOLDER_MARKER');
    expect(placeholders.length).toBeGreaterThan(0);
    for (const diagnostic of placeholders) {
      expect(diagnostic.level).toBe('warning');
    }
    expect((result.diagnostics ?? []).filter((d) => d.level === 'error')).toHaveLength(0);
  });

  it('warns about a self-referencing dependency constraint without failing the gate', async () => {
    const files = greenFiles();
    files.set('pubspec.yaml', makeFile('pubspec.yaml', SELF_CONTAINING_PUBSPEC));

    const result = await runQAValidationAgent(stateWith(files));

    const duplicate = (result.diagnostics ?? []).filter(
      (d) => d.code === 'DUPLICATE_PACKAGE_CONSTRAINT',
    );
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0].level).toBe('warning');
  });

  it('deduplicates repeated imports from the same file', async () => {
    const files = greenFiles();
    const screenPath = 'lib/features/home/screens/home_screen.dart';
    files.set(
      screenPath,
      makeFile(
        screenPath,
        screenContent('HomeScreen', [
          `import 'package:${PKG}/core/ghost.dart';`,
          `import 'package:${PKG}/core/ghost.dart';`,
          `import 'package:${PKG}/core/ghost.dart';`,
          "import 'package:http/http.dart';",
          "import 'package:http/http.dart';",
        ]),
      ),
    );

    const result = await runQAValidationAgent(stateWith(files));

    expect(
      (result.diagnostics ?? []).filter(
        (d) => d.code === 'UNRESOLVED_IMPORT' && d.filePath === screenPath,
      ),
    ).toHaveLength(1);
    expect(
      (result.diagnostics ?? []).filter(
        (d) => d.code === 'UNDECLARED_DEPENDENCY' && d.filePath === screenPath,
      ),
    ).toHaveLength(1);
  });

  it('removes duplicates, caps diagnostics at 50 and keeps a stable sort order', async () => {
    const files = greenFiles();
    for (let index = 0; index < 60; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const screenPath = `lib/features/f${suffix}/screens/screen_${suffix}.dart`;
      files.set(
        screenPath,
        makeFile(
          screenPath,
          screenContent(`Screen${suffix}`, [`import 'package:ghostpkg${suffix}/ghostpkg${suffix}.dart';`]),
        ),
      );
    }

    const first = await runQAValidationAgent(stateWith(files));
    const firstDiagnostics = first.diagnostics ?? [];

    expect(firstDiagnostics).toHaveLength(50);
    for (let index = 1; index < firstDiagnostics.length; index += 1) {
      const previous = firstDiagnostics[index - 1];
      const current = firstDiagnostics[index];
      expect((previous.filePath ?? '') <= (current.filePath ?? '')).toBe(true);
    }
    const keys = firstDiagnostics.map((d) => `${d.code} ${d.filePath} ${d.message}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(firstDiagnostics.map(diagnosticFingerprint)).size).toBe(firstDiagnostics.length);

    // Deterministic across calls — the cap and the sort must not drift.
    const second = await runQAValidationAgent(stateWith(greenFiles()));
    expect(second.diagnostics).toEqual([]);
  });

  it('emits a single QA_INTERNAL error instead of crashing when the analysis blows up', async () => {
    const broken = {
      ...stateWith(greenFiles(), 3),
      generatedFiles: null as unknown as ProjectState['generatedFiles'],
    };

    const result = await runQAValidationAgent(broken);

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics?.[0].code).toBe('QA_INTERNAL');
    expect(result.diagnostics?.[0].level).toBe('error');
    expect(result.diagnostics?.[0].message).toContain('QA validation failed internally');
    expect(result.repairAttempts).toBe(3);
  });

  it('produces stable fingerprints across calls and changes them when a message changes', async () => {
    const files = greenFiles();
    files.delete('lib/main.dart');
    const state = stateWith(files);

    const first = await runQAValidationAgent(state);
    const second = await runQAValidationAgent(state);

    expect(first.diagnostics).toEqual(second.diagnostics);

    const diagnostic = first.diagnostics?.[0];
    expect(diagnostic).toBeDefined();
    expect(diagnosticFingerprint(diagnostic!)).toBe(
      `${diagnostic!.level}|${diagnostic!.code}|${diagnostic!.filePath}|${diagnostic!.message}`,
    );
    expect(diagnosticFingerprint(second.diagnostics![0])).toBe(diagnosticFingerprint(diagnostic!));

    expect(diagnosticFingerprint({ ...diagnostic!, message: `${diagnostic!.message} changed` })).not.toBe(
      diagnosticFingerprint(diagnostic!),
    );
    expect(diagnosticFingerprint({ ...diagnostic!, code: 'OTHER_CODE' })).not.toBe(
      diagnosticFingerprint(diagnostic!),
    );
    expect(diagnosticFingerprint({ ...diagnostic!, filePath: 'lib/other.dart' })).not.toBe(
      diagnosticFingerprint(diagnostic!),
    );
    expect(diagnosticFingerprint({ ...diagnostic!, level: 'warning' })).not.toBe(
      diagnosticFingerprint(diagnostic!),
    );
  });
});
