/**
 * Project assembly — the only place the three emitter layers are composed.
 *
 * Layer ownership is exclusive:
 *   data → lib/data, lib/state/<entity>_controller.dart, test/data
 *   ui   → lib/features, lib/ui
 *   app  → lib/main.dart, lib/app, lib/state/app_settings_controller.dart, test/app
 *
 * The assembly adds the manifest files that describe the project rather than
 * the app (pubspec, analyzer config, gitignore), then asserts structural
 * integrity before anything is allowed near a workspace.
 */
import type { AppSpec, GeneratedFile } from '../contracts.js';
import { emitAppLayer } from './app/index.js';
import { emitDataLayer } from './data/index.js';
import { emitUiLayer } from './ui/index.js';
import { analysisOptionsYaml, mergeFiles, pubspecYaml, verifyFileSet } from './shared.js';

const GITIGNORE = `# Flutter/Dart
.dart_tool/
.packages
build/
.flutter-plugins
.flutter-plugins-dependencies
*.iml
.idea/
.vscode/
coverage/
`;

export interface EmitResult {
  spec: AppSpec;
  files: GeneratedFile[];
  problems: string[];
}

/** Compose all layers deterministically. Pure and side-effect free. */
export function emitProject(spec: AppSpec): GeneratedFile[] {
  return mergeFiles([
    { layer: 'data', files: emitDataLayer({ spec }) },
    { layer: 'ui', files: emitUiLayer({ spec }) },
    { layer: 'app', files: emitAppLayer({ spec }) },
    {
      layer: 'shell',
      files: [
        { path: 'pubspec.yaml', content: pubspecYaml(spec) },
        { path: 'analysis_options.yaml', content: analysisOptionsYaml() },
        { path: '.gitignore', content: GITIGNORE },
      ],
    },
  ]);
}

/** Compose and verify; `problems` is empty only for an analyzable project. */
export function emitAndCheck(spec: AppSpec): EmitResult {
  const files = emitProject(spec);
  return { spec, files, problems: verifyFileSet(files, spec.app.packageName) };
}
