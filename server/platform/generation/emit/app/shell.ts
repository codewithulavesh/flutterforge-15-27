/**
 * Root widget, inherited scope and entrypoint emitter.
 *
 * The shell owns controller lifetime and nothing else: repositories are created
 * once, controllers load once after the first frame, and [AppScope] exposes the
 * same instances to every route. Keeping this wiring out of screens means the
 * UI layer can stay pure presentation.
 */
import type { AppSpec } from '../../contracts.js';
import {
  controllerClass,
  controllerFile,
  dartString,
  entityVar,
  pascal,
  pluralize,
  repositoryClass,
  repositoryFile,
  seedFile,
  snake,
} from '../shared.js';

/** Root widget class. Appends `App` unless the product name already ends in it. */
export function appRootClass(spec: AppSpec): string {
  const base = pascal(spec.app.name) || pascal(spec.app.packageName) || 'Forge';
  return base.endsWith('App') ? base : `${base}App`;
}

function relativeLib(path: string): string {
  return path.replace(/^lib\//, '../');
}

function seedFunction(entity: AppSpec['entities'][number]): string {
  return `seed${pluralize(entity.name)}`;
}

function settingsImport(): string {
  return "import '../state/app_settings_controller.dart';";
}

export function appScopeDart(spec: AppSpec): string {
  const controllerImports = spec.entities
    .map((entity) => `import '${relativeLib(controllerFile(entity))}';`)
    .join('\n');
  const fields = spec.entities
    .map((entity) => `  final ${controllerClass(entity)} ${entityVar(entity)};`)
    .join('\n');
  const parameters = spec.entities
    .map((entity) => `    required this.${entityVar(entity)},`)
    .join('\n');

  return `import 'package:flutter/widgets.dart';

${settingsImport()}
${controllerImports}

/// Exposes the app's long-lived controllers to every route.
///
/// Screens read state with \`AppScope.of(context).<entityName>\` and rebuild with
/// a [ListenableBuilder] on that controller. The scope itself never changes its
/// identity, so [updateShouldNotify] stays false and pages avoid needless work.
class AppScope extends InheritedWidget {
  const AppScope({
    super.key,
    required this.settings,
${parameters}
    required super.child,
  });

  /// Theme preference shared by the whole app.
  final AppSettingsController settings;

${fields}

  /// Looks up the nearest scope and registers a dependency edge.
  static AppScope of(BuildContext context) {
    final AppScope? scope =
        context.dependOnInheritedWidgetOfExactType<AppScope>();
    assert(scope != null, 'AppScope.of() called without an AppScope ancestor.');
    return scope!;
  }

  @override
  bool updateShouldNotify(AppScope oldWidget) => false;
}
`;
}

export function appDart(spec: AppSpec): string {
  const root = appRootClass(spec);
  const imports = [
    "import 'package:flutter/material.dart';",
    '',
    ...spec.entities.map((entity) => `import '${relativeLib(repositoryFile(entity))}';`),
    ...spec.entities.map((entity) => `import '${relativeLib(seedFile(entity))}';`),
    "import '../state/app_settings_controller.dart';",
    ...spec.entities.map((entity) => `import '${relativeLib(controllerFile(entity))}';`),
    "import 'app_scope.dart';",
    "import 'navigation.dart';",
    "import 'router.dart';",
    "import 'theme.dart';",
  ].join('\n');

  const settingsField = '  late final AppSettingsController _settings;';
  const controllerFields = spec.entities
    .map((entity) => `  late final ${controllerClass(entity)} _${entityVar(entity)};`)
    .join('\n');

  const initSettings = '    _settings = AppSettingsController();';
  const initControllers = spec.entities
    .map(
      (entity) =>
        `    _${entityVar(entity)} = ${controllerClass(entity)}(\n      InMemory${repositoryClass(entity)}(${seedFunction(entity)}()),\n    );`,
    )
    .join('\n');

  const loads = spec.entities
    .map((entity) => `      _${entityVar(entity)}.load(),`)
    .join('\n');

  const disposes = spec.entities
    .map((entity) => `    _${entityVar(entity)}.dispose();`)
    .join('\n');

  const scopeArgs = spec.entities
    .map((entity) => `              ${entityVar(entity)}: _${entityVar(entity)},`)
    .join('\n');

  return `${imports}

/// Root widget: owns controller lifetime, theme mode and the route table.
class ${root} extends StatefulWidget {
  const ${root}({super.key});

  @override
  State<${root}> createState() => _${root}State();
}

class _${root}State extends State<${root}> {
${settingsField}
${controllerFields}

  @override
  void initState() {
    super.initState();
${initSettings}
${initControllers}
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) {
        return;
      }
      Future<void>.microtask(_loadControllers);
    });
  }

  Future<void> _loadControllers() async {
    if (!mounted) {
      return;
    }
    await Future.wait(<Future<void>>[
${loads}
    ]);
  }

  @override
  void dispose() {
${disposes}
    _settings.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _settings,
      builder: (BuildContext context, Widget? _) {
        return MaterialApp(
          title: ${dartString(spec.app.name)},
          debugShowCheckedModeBanner: false,
          theme: buildLightTheme(),
          darkTheme: buildDarkTheme(),
          themeMode: _settings.themeMode,
          home: const HomeShell(),
          onGenerateRoute: onGenerateRoute,
          builder: (BuildContext context, Widget? child) {
            return AppScope(
              settings: _settings,
${scopeArgs}
              child: child ?? const SizedBox.shrink(),
            );
          },
        );
      },
    );
  }
}
`;
}

export function mainDart(spec: AppSpec): string {
  return `import 'package:flutter/widgets.dart';

import 'app/app.dart';

void main() {
  runApp(const ${appRootClass(spec)}());
}
`;
}

function oneLine(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function readmeMarkdown(spec: AppSpec): string {
  const name = oneLine(spec.app.name);
  const lines: string[] = [];
  lines.push(`# ${name}`, '');
  lines.push(`> ${oneLine(spec.app.tagline)}`, '');
  lines.push(oneLine(spec.app.description), '');

  lines.push('## Features', '');
  for (const screen of spec.screens ?? []) {
    lines.push(`- **${oneLine(screen.title)}** — ${oneLine(screen.purpose)}`);
  }
  lines.push('');

  if ((spec.flows ?? []).length > 0) {
    lines.push('## Flows', '');
    for (const flow of spec.flows) {
      const steps = flow.steps
        .map((step) => (spec.screens ?? []).find((screen) => screen.id === step.screenId)?.title ?? step.screenId)
        .map(oneLine)
        .join(' → ');
      lines.push(`- **${oneLine(flow.name)}** — ${steps}`);
    }
    lines.push('');
  }

  lines.push('## Run', '');
  lines.push('```sh');
  lines.push('flutter pub get');
  lines.push('flutter run -d chrome');
  lines.push('```', '');
  lines.push('Run the generated smoke test with:', '');
  lines.push('```sh');
  lines.push('flutter test');
  lines.push('```', '');
  lines.push(
    'The app is local-first: no third-party Dart packages, no network services and no account are required.',
    '',
  );

  lines.push('## Architecture', '');
  lines.push('```text');
  lines.push('lib/');
  lines.push('  main.dart                 app entrypoint');
  lines.push('  app/');
  lines.push('    app.dart                root widget and controller lifetime');
  lines.push('    app_scope.dart          inherited access to long-lived controllers');
  lines.push('    navigation.dart         adaptive NavigationBar / NavigationRail shell');
  lines.push('    router.dart             named routes and the not-found screen');
  lines.push('    theme.dart              Material 3 light and dark themes');
  lines.push('  data/');
  lines.push('    models/                 immutable entity models');
  lines.push('    repositories/           async repository seams and in-memory stores');
  lines.push('    seed/                   deterministic first-run data');
  lines.push('  features/');
  for (const screen of spec.screens ?? []) {
    lines.push(`    ${snake(screen.id)}/${snake(screen.id)}_page.dart`);
  }
  lines.push('  state/');
  lines.push('    app_settings_controller.dart');
  for (const entity of spec.entities ?? []) {
    lines.push(`    ${snake(entity.name)}_controller.dart`);
  }
  lines.push('test/');
  lines.push('  app/app_smoke_test.dart');
  lines.push('```', '');

  lines.push('## Design', '');
  lines.push(`- Seed colour: ${spec.design.seedColor.toUpperCase()}`);
  if (spec.design.accentColor) {
    lines.push(`- Accent colour: ${spec.design.accentColor.toUpperCase()}`);
  }
  lines.push(`- Corner language: ${spec.design.shape}`);
  lines.push(`- Spacing scale: ${(spec.design.spacing ?? []).join(', ')} px`);
  lines.push(`- Radii: ${Object.values(spec.design.radii).join(', ')} px`);
  lines.push('');

  lines.push('## Generated by FlutterForge', '');
  lines.push(
    'This project was generated from a typed app specification by FlutterForge. Re-running generation is deterministic, so the diff stays reviewable.',
  );
  lines.push('');

  return `${lines.join('\n')}`;
}
