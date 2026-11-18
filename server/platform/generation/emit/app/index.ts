/**
 * App-layer emitter.
 *
 * Owns the entrypoint, inherited scope, theme, adaptive navigation, router,
 * settings controller, smoke test and README. Data and UI files are owned by
 * their own emitters; this layer only wires their public contracts together.
 */
import type { EmitContext, GeneratedFile } from '../../contracts.js';
import { navigationDart } from './navigation.js';
import { routerDart } from './router.js';
import { appSettingsControllerDart, APP_SETTINGS_FILE } from './settings.js';
import { appDart, appScopeDart, mainDart, readmeMarkdown } from './shell.js';
import { appSmokeTestDart } from './tests.js';
import { themeDart } from './theme.js';

export { navigationScreens } from './navigation.js';
export { appRootClass } from './shell.js';

/** Every file the app layer owns, in deterministic order. */
export function emitAppLayer(ctx: EmitContext): GeneratedFile[] {
  const { spec } = ctx;
  return [
    { path: 'lib/main.dart', content: mainDart(spec), layer: 'app' },
    { path: 'lib/app/app.dart', content: appDart(spec), layer: 'app' },
    { path: 'lib/app/app_scope.dart', content: appScopeDart(spec), layer: 'app' },
    { path: 'lib/app/navigation.dart', content: navigationDart(spec), layer: 'app' },
    { path: 'lib/app/router.dart', content: routerDart(spec), layer: 'app' },
    { path: 'lib/app/theme.dart', content: themeDart(spec), layer: 'app' },
    { path: APP_SETTINGS_FILE, content: appSettingsControllerDart(), layer: 'app' },
    { path: 'test/app/app_smoke_test.dart', content: appSmokeTestDart(spec), layer: 'test' },
    { path: 'README.md', content: readmeMarkdown(spec), layer: 'docs' },
  ];
}
