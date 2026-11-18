import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppSpec } from '../../platform/generation/contracts.js';
import { emitAppLayer } from '../../platform/generation/emit/app/index.js';
import { appRootClass } from '../../platform/generation/emit/app/shell.js';
import {
  controllerClass,
  dartColor,
  dartString,
  entityVar,
  pluralize,
  radiusOf,
  repositoryClass,
  routeOf,
  screenClass,
  screenFile,
  snake,
  spacingScale,
  validateSpec,
} from '../../platform/generation/emit/shared.js';

// ── representative specs ──────────────────────────────────────────────────

function trailNotesSpec(): AppSpec {
  return {
    version: 1,
    app: {
      name: 'Trail Notes',
      packageName: 'trail_notes',
      tagline: 'Field notes for the long way round.',
      description: 'Capture observations, trail conditions and small discoveries before the moment passes.',
      domain: 'productivity',
    },
    audience: {
      primary: 'Weekend hikers and field researchers',
      secondary: 'Travel journalers',
    },
    entities: [
      {
        name: 'Note',
        plural: 'notes',
        description: 'A written observation captured on the trail.',
        fields: [
          { name: 'title', type: 'string', required: true, primary: true, label: 'Title' },
          { name: 'body', type: 'text', required: true, label: 'Note' },
          { name: 'pinned', type: 'bool', required: true, label: 'Pinned' },
          { name: 'createdAt', type: 'datetime', required: true, label: 'Captured' },
          { name: 'tags', type: 'stringList', required: true, label: 'Tags' },
          { name: 'trailId', type: 'relation', required: false, target: 'Trail', label: 'Trail' },
        ],
        searchField: 'title',
        sortField: 'createdAt',
      },
      {
        name: 'Trail',
        plural: 'trails',
        description: 'A route worth returning to.',
        fields: [
          { name: 'name', type: 'string', required: true, primary: true, label: 'Trail name' },
          { name: 'distanceKm', type: 'double', required: true, label: 'Distance (km)' },
          {
            name: 'difficulty',
            type: 'enum',
            required: true,
            values: ['easy', 'moderate', 'hard'],
            label: 'Difficulty',
          },
          { name: 'completed', type: 'bool', required: true, label: 'Completed' },
        ],
      },
    ],
    screens: [
      {
        id: 'dashboard',
        title: 'Dashboard',
        route: '/dashboard',
        kind: 'dashboard',
        purpose: 'See recent notes, trail progress and the next useful action at a glance.',
        inNavigation: true,
        icon: 'dashboard',
      },
      {
        id: 'notes',
        title: 'Notes',
        route: '/notes',
        kind: 'list',
        purpose: 'Search, filter and pin every field note.',
        entity: 'Note',
        primaryAction: 'New note',
        inNavigation: true,
        icon: 'list',
      },
      {
        id: 'note_detail',
        title: 'Note details',
        route: '/notes/:id',
        kind: 'detail',
        purpose: 'Read a note with its metadata and trail context.',
        entity: 'Note',
        primaryAction: 'Edit note',
      },
      {
        id: 'note_edit',
        title: 'Edit note',
        route: '/notes/:id/edit',
        kind: 'form',
        purpose: 'Create or revise a note with validated fields.',
        entity: 'Note',
        primaryAction: 'Save note',
      },
      {
        id: 'settings',
        title: 'Settings',
        route: '/settings',
        kind: 'settings',
        purpose: 'Switch the theme and review app information.',
        inNavigation: true,
        icon: 'settings',
      },
    ],
    flows: [
      {
        id: 'capture_note',
        name: 'Capture a field note',
        steps: [
          { screenId: 'dashboard', action: 'Start a note' },
          { screenId: 'notes', action: 'Open the collection' },
          { screenId: 'note_detail', action: 'Review the entry' },
          { screenId: 'note_edit', action: 'Refine the wording' },
        ],
      },
    ],
    design: {
      seedColor: '#0F766E',
      accentColor: '#F59E0B',
      brightness: 'system',
      spacing: [4, 8, 12, 16, 24, 32],
      radii: { sm: 6, md: 12, lg: 20, xl: 28 },
      motionMs: 180,
      shape: 'rounded',
    },
    requirements: [
      {
        id: 'req-capture',
        statement: 'A note can be captured in under three taps.',
        category: 'ux',
        verifiedBy: 'test',
      },
      {
        id: 'req-theme',
        statement: 'Theme changes apply without restarting the app.',
        category: 'accessibility',
        verifiedBy: 'test',
      },
      {
        id: 'req-local',
        statement: 'The app works with no network connection.',
        category: 'reliability',
        verifiedBy: 'test',
      },
    ],
    backend: 'local',
    seedCount: 6,
  };
}

function pantryPilotSpec(): AppSpec {
  return {
    version: 1,
    app: {
      name: 'Pantry Pilot',
      packageName: 'pantry_pilot',
      tagline: 'Cook from what you already have.',
      description: 'Track the pantry, rescue ingredients before they expire and turn them into weeknight recipes.',
      domain: 'health',
    },
    audience: {
      primary: 'Busy home cooks',
      secondary: 'Households reducing food waste',
    },
    entities: [
      {
        name: 'Recipe',
        plural: 'recipes',
        description: 'A weeknight meal built from pantry staples.',
        fields: [
          { name: 'name', type: 'string', required: true, primary: true, label: 'Recipe' },
          { name: 'minutes', type: 'int', required: true, label: 'Minutes' },
          { name: 'tags', type: 'stringList', required: true, label: 'Tags' },
          { name: 'favorite', type: 'bool', required: true, label: 'Favorite' },
        ],
        sortField: 'name',
      },
      {
        name: 'PantryItem',
        plural: 'pantry_items',
        description: 'An ingredient on hand and its expiry window.',
        fields: [
          { name: 'label', type: 'string', required: true, primary: true, label: 'Ingredient' },
          { name: 'quantity', type: 'int', required: true, label: 'Quantity' },
          { name: 'expiresAt', type: 'datetime', required: true, label: 'Expires' },
          {
            name: 'category',
            type: 'enum',
            required: true,
            values: ['produce', 'dairy', 'pantry', 'frozen'],
            label: 'Category',
          },
        ],
      },
    ],
    screens: [
      {
        id: 'dashboard',
        title: 'Today',
        route: '/dashboard',
        kind: 'dashboard',
        purpose: 'See expiring ingredients and a suggested meal for tonight.',
        inNavigation: true,
        icon: 'dashboard',
      },
      {
        id: 'recipes',
        title: 'Recipes',
        route: '/recipes',
        kind: 'list',
        purpose: 'Browse saved recipes and filter by the ingredients on hand.',
        entity: 'Recipe',
        primaryAction: 'New recipe',
        inNavigation: true,
        icon: 'list',
      },
      {
        id: 'recipe_detail',
        title: 'Recipe',
        route: '/recipes/:id',
        kind: 'detail',
        purpose: 'Read the method, timing and ingredient list for one recipe.',
        entity: 'Recipe',
        primaryAction: 'Cook this',
      },
      {
        id: 'pantry',
        title: 'Pantry',
        route: '/pantry',
        kind: 'list',
        purpose: 'Manage quantities and expiry dates for every ingredient.',
        entity: 'PantryItem',
        primaryAction: 'Add ingredient',
      },
      {
        id: 'settings',
        title: 'Preferences',
        route: '/settings',
        kind: 'settings',
        purpose: 'Choose the theme and review local-first app details.',
        icon: 'settings',
      },
    ],
    flows: [
      {
        id: 'cook_now',
        name: 'Cook from the pantry',
        steps: [
          { screenId: 'recipes', action: 'Pick a saved recipe' },
          { screenId: 'recipe_detail', action: 'Check the method' },
        ],
      },
    ],
    design: {
      seedColor: '#7C3AED',
      accentColor: '#EC4899',
      brightness: 'dark',
      spacing: [2, 6, 10, 14, 20, 28],
      radii: { sm: 2, md: 10, lg: 16, xl: 24 },
      motionMs: 120,
      shape: 'soft',
    },
    requirements: [
      {
        id: 'req-expiry',
        statement: 'Expiring ingredients surface before anything else.',
        category: 'functional',
        verifiedBy: 'test',
      },
      {
        id: 'req-offline',
        statement: 'The pantry remains usable offline.',
        category: 'reliability',
        verifiedBy: 'test',
      },
    ],
    backend: 'local',
    seedCount: 4,
  };
}

const SPECS: AppSpec[] = [trailNotesSpec(), pantryPilotSpec()];

const REQUIRED_PATHS = [
  'lib/main.dart',
  'lib/app/app.dart',
  'lib/app/app_scope.dart',
  'lib/app/navigation.dart',
  'lib/app/router.dart',
  'lib/app/theme.dart',
  'lib/state/app_settings_controller.dart',
  'test/app/app_smoke_test.dart',
  'README.md',
];

// ── helpers ───────────────────────────────────────────────────────────────

function filesFor(spec: AppSpec): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of emitAppLayer({ spec })) files.set(file.path, file.content);
  return files;
}

function textAt(files: Map<string, string>, path: string): string {
  const content = files.get(path);
  assert.ok(content, `missing generated file ${path}`);
  return content!;
}

function expectedNavigation(spec: AppSpec): string[] {
  const marked = spec.screens.filter((screen) => screen.inNavigation === true);
  const chosen = marked.length > 0 ? [...marked] : spec.screens.slice(0, 3);
  const settings = spec.screens.find((screen) => screen.kind === 'settings');
  if (settings && !chosen.some((screen) => screen.id === settings.id)) {
    chosen.push(settings);
  }
  return chosen.map(routeOf);
}

// ── file set ──────────────────────────────────────────────────────────────

for (const spec of SPECS) {
  test(`${spec.app.name}: emits the complete app-owned file set`, () => {
    const files = filesFor(spec);
    for (const path of REQUIRED_PATHS) {
      assert.ok(files.has(path), `${spec.app.name} should emit ${path}`);
    }
    assert.equal(files.size, REQUIRED_PATHS.length);
  });

  test(`${spec.app.name}: every screen route and page class is wired into the router`, () => {
    const router = textAt(filesFor(spec), 'lib/app/router.dart');
    for (const screen of spec.screens) {
      const route = routeOf(screen);
      const importPath = screenFile(screen).replace(/^lib\//, '../');
      assert.ok(router.includes(route), `router should mention route ${route}`);
      assert.ok(
        router.includes(`import '${importPath}';`),
        `router should import ${importPath}`,
      );
      assert.ok(
        router.includes(screenClass(screen)),
        `router should construct ${screenClass(screen)}`,
      );
    }
    assert.match(router, /Route<dynamic>\? onGenerateRoute\(RouteSettings settings\)/);
    assert.match(router, /Uri\.decodeComponent/);
    assert.match(router, /class NotFoundPage extends StatelessWidget/);
    assert.match(router, /Go home/);
    assert.match(router, /_railBreakpoint|HomeShell/);
  });

  test(`${spec.app.name}: app scope exposes settings plus one controller per entity`, () => {
    const scope = textAt(filesFor(spec), 'lib/app/app_scope.dart');
    assert.match(scope, /class AppScope extends InheritedWidget/);
    assert.match(scope, /final AppSettingsController settings;/);
    for (const entity of spec.entities) {
      assert.ok(
        scope.includes(`final ${controllerClass(entity)} ${entityVar(entity)};`),
        `scope should expose ${entityVar(entity)}`,
      );
      assert.ok(
        scope.includes(`required this.${entityVar(entity)},`),
        `scope should require ${entityVar(entity)}`,
      );
      assert.ok(
        scope.includes(`import '../state/${snake(entity.name)}_controller.dart';`),
        `scope should import the ${entity.name} controller`,
      );
    }
    assert.match(scope, /bool updateShouldNotify\(AppScope oldWidget\) => false;/);
    assert.match(scope, /dependOnInheritedWidgetOfExactType<AppScope>\(\)/);
    const fields = scope.match(/^ {2}final \w+Controller \w+;$/gm) ?? [];
    assert.equal(fields.length, spec.entities.length + 1, 'one settings field plus one per entity');
  });

  test(`${spec.app.name}: theme uses the exact seed/accent tokens and component themes`, () => {
    const theme = textAt(filesFor(spec), 'lib/app/theme.dart');
    assert.ok(
      theme.includes(dartColor(spec.design.seedColor)),
      `theme should contain ${dartColor(spec.design.seedColor)}`,
    );
    assert.match(theme, /ColorScheme\.fromSeed\(/);
    if (spec.design.accentColor) {
      assert.ok(theme.includes(dartColor(spec.design.accentColor)), 'accent token is emitted');
      assert.match(theme, /secondary: appAccentColor/);
      assert.match(theme, /copyWith\(/);
    }
    for (const component of [
      'CardThemeData(',
      'InputDecorationThemeData(',
      'FilledButtonThemeData(',
      'NavigationBarThemeData(',
      'NavigationRailThemeData(',
      'AppBarThemeData(',
      'DividerThemeData(',
      'ListTileThemeData(',
      'SnackBarThemeData(',
    ]) {
      assert.ok(theme.includes(component), `theme should configure ${component}`);
    }
    assert.match(theme, /useMaterial3: true/);
    assert.match(theme, /centerTitle: false/);
    assert.match(theme, /scrolledUnderElevation: 1/);
    assert.match(theme, /WidgetStateProperty\.resolveWith/);
    assert.match(theme, /visualDensity: VisualDensity\.standard/);
    assert.ok(theme.includes(`appSpaceMd = ${spacingScale(spec.design).md};`));
    assert.ok(theme.includes(`appRadiusMd = ${spec.design.radii.md};`));
    assert.ok(theme.includes(`appRadiusCard = ${radiusOf(spec.design, spec.design.shape === 'soft' ? 'xl' : spec.design.shape === 'square' ? 'sm' : 'lg')};`));
    assert.match(theme, /ThemeData buildLightTheme\(\)/);
    assert.match(theme, /ThemeData buildDarkTheme\(\)/);
  });

  test(`${spec.app.name}: navigation mirrors inNavigation screens and stays adaptive`, () => {
    const nav = textAt(filesFor(spec), 'lib/app/navigation.dart');
    const expected = expectedNavigation(spec);
    for (const screen of spec.screens.filter((candidate) => expected.includes(routeOf(candidate)))) {
      assert.ok(nav.includes(`label: ${dartString(screen.title)}`), `nav label for ${screen.title}`);
      assert.ok(nav.includes(`route: ${dartString(routeOf(screen))}`), `nav route for ${routeOf(screen)}`);
      assert.ok(nav.includes(screenClass(screen)), `nav page for ${screen.title}`);
    }
    const destinationCount = (nav.match(/^ {4}AppDestination\($/gm) ?? []).length;
    assert.equal(destinationCount, expected.length, 'one destination per expected screen');
    assert.match(nav, /class AppDestination/);
    assert.match(nav, /class HomeShell extends StatefulWidget/);
    assert.match(nav, /NavigationBar\(/);
    assert.match(nav, /NavigationRail\(/);
    assert.match(nav, /IndexedStack\(/);
    assert.match(nav, /LayoutBuilder\(/);
    assert.match(nav, /static const double _railBreakpoint = 900;/);
    assert.match(nav, /const Map<String, IconData> appIconMap/);
    for (const icon of [
      'dashboard',
      'list',
      'home',
      'settings',
      'person',
      'chat',
      'add',
      'search',
      'favorite',
      'calendar',
      'wallet',
      'fitness',
      'school',
      'flight',
      'code',
      'photo',
    ]) {
      assert.ok(nav.includes(`'${icon}':`), `icon map should include ${icon}`);
    }
    assert.match(nav, /Icons\.circle_outlined/);
    assert.match(nav, /tooltip: destination\.label/);
  });

  test(`${spec.app.name}: app root owns controller lifetime and settings drive MaterialApp`, () => {
    const app = textAt(filesFor(spec), 'lib/app/app.dart');
    const main = textAt(filesFor(spec), 'lib/main.dart');
    const settings = textAt(filesFor(spec), 'lib/state/app_settings_controller.dart');
    const root = appRootClass(spec);

    assert.ok(app.includes(`class ${root} extends StatefulWidget`));
    assert.match(app, /void initState\(\)/);
    assert.match(app, /_settings = AppSettingsController\(\);/);
    for (const entity of spec.entities) {
      assert.ok(
        app.includes(`InMemory${repositoryClass(entity)}(seed${pluralize(entity.name)}())`),
        `app should seed the ${entity.name} repository`,
      );
      assert.ok(
        app.includes(`${controllerClass(entity)}(`),
        `app should construct ${controllerClass(entity)}`,
      );
      assert.match(app, new RegExp(`_${entityVar(entity)}\\.load\\(\\)`));
      assert.match(app, new RegExp(`_${entityVar(entity)}\\.dispose\\(\\)`));
    }
    assert.match(app, /Future<void>\.microtask\(_loadControllers\)/);
    assert.match(app, /addPostFrameCallback/);
    assert.match(app, /ListenableBuilder\(/);
    assert.match(app, /MaterialApp\(/);
    assert.match(app, /debugShowCheckedModeBanner: false/);
    assert.match(app, /theme: buildLightTheme\(\)/);
    assert.match(app, /darkTheme: buildDarkTheme\(\)/);
    assert.match(app, /themeMode: _settings\.themeMode/);
    assert.match(app, /home: const HomeShell\(\)/);
    assert.match(app, /onGenerateRoute: onGenerateRoute/);
    assert.match(app, /AppScope\(/);

    assert.match(main, /void main\(\)/);
    assert.match(main, new RegExp(`runApp\\(const ${root}\\(\\)\\)`));

    assert.match(settings, /class AppSettingsController extends ChangeNotifier/);
    assert.match(settings, /ThemeMode\.system/);
    assert.match(settings, /ThemeMode get themeMode/);
    assert.match(settings, /bool get isDark/);
    assert.match(settings, /Future<void> setThemeMode\(ThemeMode mode\)/);
    assert.match(settings, /Future<void> toggleTheme\(\)/);
    assert.match(settings, /notifyListeners\(\)/);
  });

  test(`${spec.app.name}: smoke test and README describe a runnable app`, () => {
    const smoke = textAt(filesFor(spec), 'test/app/app_smoke_test.dart');
    const readme = textAt(filesFor(spec), 'README.md');

    assert.match(smoke, /testWidgets\(/);
    assert.match(smoke, /pumpAndSettle/);
    assert.match(smoke, new RegExp(`pumpWidget\\(const ${appRootClass(spec)}\\(\\)\\)`));
    assert.ok(smoke.includes(spec.app.name), 'smoke test expects the app name');
    assert.match(smoke, /NavigationBar/);
    assert.match(smoke, /NavigationRail/);
    assert.match(smoke, /Switch/);
    assert.match(smoke, /SegmentedButton/);
    if (spec.screens.some((screen) => screen.kind === 'settings')) {
      assert.match(smoke, /_toggleThemeControl\(tester\)/);
    }
    assert.doesNotMatch(smoke, /dart:io|package:http|HttpClient/);

    assert.ok(readme.startsWith(`# ${spec.app.name}`));
    assert.ok(readme.includes(spec.app.tagline));
    assert.ok(readme.includes('flutter pub get'));
    assert.ok(readme.includes('flutter run -d chrome'));
    assert.ok(readme.includes('Generated by FlutterForge'));
    assert.ok(readme.includes('## Features'));
    assert.ok(readme.includes('## Architecture'));
    for (const screen of spec.screens) {
      assert.ok(readme.includes(screen.title), `README should list ${screen.title}`);
    }
  });

  test(`${spec.app.name}: contains no deprecated APIs, prints, TODOs or network code`, () => {
    const files = filesFor(spec);
    const deprecated: Array<[string, RegExp]> = [
      ['withOpacity(', /withOpacity\(/],
      ['ColorScheme.background', /ColorScheme\.background/],
      ['surfaceVariant', /surfaceVariant/],
      ['MaterialState', /MaterialState/],
      ['CardTheme constructor', /CardTheme\(/],
    ];
    for (const [path, content] of files) {
      for (const [label, pattern] of deprecated) {
        assert.doesNotMatch(content, pattern, `${path} must not use ${label}`);
      }
      assert.doesNotMatch(content, /\bprint\(/, `${path} must not print`);
      assert.doesNotMatch(content, /TODO/, `${path} must not contain TODO`);
      assert.doesNotMatch(content, /https?:\/\//, `${path} must not contain a URL`);
      assert.doesNotMatch(content, /package:http|HttpClient|dart:io/, `${path} must stay offline`);

      const importRe = /^\s*import\s+['"]package:([^/]+)\//gm;
      for (const match of content.matchAll(importRe)) {
        const pkg = match[1];
        assert.ok(
          pkg === 'flutter' || pkg === 'flutter_test' || pkg === spec.app.packageName,
          `${path} imports third-party package ${pkg}`,
        );
        if (pkg === spec.app.packageName) {
          assert.equal(path, 'test/app/app_smoke_test.dart', 'only the smoke test may self-import the app');
        }
        if (path.startsWith('lib/')) {
          assert.equal(pkg, 'flutter', `${path} should use relative imports for app code`);
        }
      }
    }
  });

  test(`${spec.app.name}: emission is deterministic`, () => {
    assert.deepEqual(emitAppLayer({ spec }), emitAppLayer({ spec }));
  });
}

test('fallback navigation uses the first three screens plus settings', () => {
  const spec = trailNotesSpec();
  const withoutFlags: AppSpec = {
    ...spec,
    screens: spec.screens.map(({ inNavigation: _inNavigation, ...screen }) => screen),
  };
  const nav = textAt(filesFor(withoutFlags), 'lib/app/navigation.dart');
  const expected = withoutFlags.screens.slice(0, 3);
  const settings = withoutFlags.screens.find((screen) => screen.kind === 'settings');
  if (settings && !expected.includes(settings)) expected.push(settings);

  assert.equal((nav.match(/^ {4}AppDestination\($/gm) ?? []).length, expected.length);
  for (const screen of expected) {
    assert.ok(nav.includes(`label: ${dartString(screen.title)}`), screen.title);
    assert.ok(nav.includes(`route: ${dartString(routeOf(screen))}`), routeOf(screen));
  }
});

test('specs used by these tests are structurally valid', () => {
  for (const spec of SPECS) {
    const result = validateSpec(spec);
    assert.equal(result.ok, true, result.errors.join('\n'));
  }
});
