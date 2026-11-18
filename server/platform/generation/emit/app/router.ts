/**
 * Named-route emitter.
 *
 * The router is the single mapping between spec routes and generated pages. It
 * supports exact routes and `:id` style parameters (including nested suffixes
 * such as `/notes/:id/edit`) without adding a routing package.
 */
import type { AppSpec, ScreenSpec } from '../../contracts.js';
import {
  camel,
  dartString,
  routeOf,
  screenClass,
  screenFile,
  screenNeedsId,
} from '../shared.js';

interface CompiledRoute {
  pattern: string;
  groupIndex: number;
  hasParams: boolean;
}

function compileRoute(route: string): CompiledRoute {
  const segments = route.split('/');
  let groups = 0;
  let idGroup = 0;
  const body = segments
    .map((segment) => {
      if (!segment.startsWith(':')) {
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      groups += 1;
      if (segment === ':id' && idGroup === 0) idGroup = groups;
      return '([^/]+)';
    })
    .join('/');
  if (idGroup === 0 && groups > 0) idGroup = 1;
  return { pattern: `^${body}$`, groupIndex: idGroup, hasParams: groups > 0 };
}

function pageExpression(screen: ScreenSpec, entityExpression: string | null): string {
  const cls = screenClass(screen);
  if (entityExpression) return `${cls}(entityId: ${entityExpression})`;
  return `const ${cls}()`;
}

export function routerDart(spec: AppSpec): string {
  const screens = spec.screens ?? [];
  const staticScreens = screens.filter((screen) => !compileRoute(routeOf(screen)).hasParams);
  const dynamicScreens = screens.filter((screen) => compileRoute(routeOf(screen)).hasParams);

  const imports = screens
    .map((screen) => `import '${screenFile(screen).replace(/^lib\//, '../')}';`)
    .join('\n');

  const staticCases = staticScreens
    .map(
      (screen) => `    // Spec route: ${routeOf(screen)}
    case ${dartString(routeOf(screen))}:
      return MaterialPageRoute<void>(
        settings: settings,
        builder: (BuildContext context) => ${pageExpression(screen, null)},
      );`,
    )
    .join('\n');

  const dynamicCases = dynamicScreens
    .map((screen) => {
      const route = routeOf(screen);
      const compiled = compileRoute(route);
      const base = `${camel(screen.id)}Route`;
      const patternVar = `${base}Pattern`;
      const matchVar = `${base}Match`;
      const needsId = screenNeedsId(screen) && compiled.groupIndex > 0;
      const body = needsId
        ? `      final String rawId = ${matchVar}.group(${compiled.groupIndex}) ?? '';
      final String entityId = Uri.decodeComponent(rawId);
      return MaterialPageRoute<void>(
        settings: settings,
        builder: (BuildContext context) => ${pageExpression(screen, 'entityId')},
      );`
        : `      return MaterialPageRoute<void>(
        settings: settings,
        builder: (BuildContext context) => ${pageExpression(screen, null)},
      );`;

      return `    // Spec route: ${route}
    final RegExp ${patternVar} = RegExp(${dartString(compiled.pattern)});
    final RegExpMatch? ${matchVar} = ${patternVar}.firstMatch(path);
    if (${matchVar} != null) {
${body}
    }`;
    })
    .join('\n');

  return `import 'package:flutter/material.dart';

${imports}
import 'navigation.dart';
import 'theme.dart';

/// Resolves every route declared by the product spec.
///
/// Detail and form routes receive the trailing identifier as \`entityId\`; pages
/// own the decoding of that identifier into a repository lookup. Unmatched
/// routes render [NotFoundPage] instead of crashing or showing a blank screen.
Route<dynamic>? onGenerateRoute(RouteSettings settings) {
  final String routeName = settings.name ?? '/';
  final Uri? parsed = Uri.tryParse(routeName);
  final String path = parsed == null || parsed.path.isEmpty ? routeName : parsed.path;

  switch (path) {
${staticCases}
    default:
      break;
  }

${dynamicCases}

  return MaterialPageRoute<void>(
    settings: settings,
    builder: (BuildContext context) => NotFoundPage(routeName: routeName),
  );
}

/// Friendly terminal state for a link that no longer maps to a screen.
class NotFoundPage extends StatelessWidget {
  const NotFoundPage({super.key, this.routeName});

  /// The requested route, shown so a broken link is easy to report.
  final String? routeName;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme colorScheme = theme.colorScheme;
    final String? missingRoute = routeName;

    return Scaffold(
      appBar: AppBar(title: const Text('Page not found')),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(appSpaceXl),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(
                  Icons.explore_off_outlined,
                  size: 56,
                  color: colorScheme.primary,
                ),
                const SizedBox(height: appSpaceLg),
                Text(
                  'That page does not exist',
                  style: theme.textTheme.headlineSmall,
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: appSpaceSm),
                Text(
                  'The link may be out of date. Return to the app shell and pick a destination.',
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: colorScheme.onSurfaceVariant,
                  ),
                  textAlign: TextAlign.center,
                ),
                if (missingRoute != null && missingRoute.isNotEmpty) ...<Widget>[
                  const SizedBox(height: appSpaceSm),
                  Text(
                    missingRoute,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: colorScheme.onSurfaceVariant,
                    ),
                    textAlign: TextAlign.center,
                  ),
                ],
                const SizedBox(height: appSpaceXl),
                FilledButton.icon(
                  onPressed: () {
                    Navigator.of(context).pushAndRemoveUntil(
                      MaterialPageRoute<void>(
                        builder: (BuildContext context) => const HomeShell(),
                      ),
                      (Route<dynamic> route) => false,
                    );
                  },
                  icon: const Icon(Icons.home_outlined),
                  label: const Text('Go home'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
`;
}
