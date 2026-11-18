/**
 * Adaptive navigation shell.
 *
 * Navigation is deliberately declarative: destinations are generated from the
 * screens the spec marks `inNavigation` (with a deterministic fallback), and the
 * shell picks a bottom bar or a rail from the available width. No route names
 * are resolved through reflection and no icon is looked up dynamically.
 */
import type { AppSpec, ScreenSpec } from '../../contracts.js';
import {
  dartString,
  routeOf,
  screenClass,
  screenFile,
} from '../shared.js';

const ICONS: ReadonlyArray<[string, string]> = [
  ['dashboard', 'Icons.dashboard_outlined'],
  ['list', 'Icons.view_list_outlined'],
  ['home', 'Icons.home_outlined'],
  ['settings', 'Icons.settings_outlined'],
  ['person', 'Icons.person_outline'],
  ['chat', 'Icons.chat_bubble_outline'],
  ['add', 'Icons.add_rounded'],
  ['search', 'Icons.search_rounded'],
  ['favorite', 'Icons.favorite_border'],
  ['calendar', 'Icons.calendar_today_outlined'],
  ['wallet', 'Icons.account_balance_wallet_outlined'],
  ['fitness', 'Icons.fitness_center_rounded'],
  ['school', 'Icons.school_outlined'],
  ['flight', 'Icons.flight_takeoff_rounded'],
  ['code', 'Icons.code_rounded'],
  ['photo', 'Icons.photo_camera_outlined'],
  ['profile', 'Icons.person_outline'],
  ['detail', 'Icons.article_outlined'],
  ['form', 'Icons.add_circle_outline'],
  ['onboarding', 'Icons.rocket_launch_outlined'],
];

/**
 * Screens reachable from the primary navigation.
 *
 * Explicit `inNavigation` flags win. When a spec has none, the first three
 * screens are used, matching the product shell default. Settings is always
 * appended when the spec declares a settings screen so the theme control can
 * never become unreachable. At least two destinations are returned because
 * Material's NavigationBar requires a real choice.
 */
export function navigationScreens(spec: AppSpec): ScreenSpec[] {
  const screens = spec.screens ?? [];
  const chosen: ScreenSpec[] = [];
  const add = (screen: ScreenSpec) => {
    if (!chosen.some((candidate) => candidate.id === screen.id)) chosen.push(screen);
  };

  const marked = screens.filter((screen) => screen.inNavigation === true);
  if (marked.length > 0) {
    for (const screen of marked) add(screen);
  } else {
    for (const screen of screens.slice(0, 3)) add(screen);
  }

  for (const screen of screens) {
    if (chosen.length >= 2) break;
    add(screen);
  }

  const settings = screens.find((screen) => screen.kind === 'settings');
  if (settings) add(settings);

  return chosen;
}

function iconCall(screen: ScreenSpec): string {
  const requested = String(screen.icon ?? '').trim() || screen.kind;
  return `appIconFor(${dartString(requested)}, ${dartString(screen.kind)})`;
}

export function navigationDart(spec: AppSpec): string {
  const destinations = navigationScreens(spec);
  const appName = spec.app.name;
  const iconLines = ICONS.map(([name, icon]) => `  '${name}': ${icon},`).join('\n');

  const imports = destinations
    .map((screen) => `import '${screenFile(screen).replace(/^lib\//, '../')}';`)
    .join('\n');

  const destinationLines = destinations
    .map(
      (screen) => `    AppDestination(
      label: ${dartString(screen.title)},
      icon: ${iconCall(screen)},
      route: ${dartString(routeOf(screen))},
    ),`,
    )
    .join('\n');

  const pageCases = destinations
    .map(
      (screen) => `      case ${dartString(routeOf(screen))}:
        return const ${screenClass(screen)}();`,
    )
    .join('\n');

  return `import 'package:flutter/material.dart';

${imports}
import 'theme.dart';

/// The product name shown in the wide navigation rail.
const String appDisplayName = ${dartString(appName)};

/// One primary navigation entry.
class AppDestination {
  const AppDestination({
    required this.label,
    required this.icon,
    required this.route,
  });

  /// Human readable label and the accessibility name for the destination.
  final String label;

  /// Resolved from [appIconMap]; never from a dynamic lookup.
  final IconData icon;

  /// Named route handled by the app router.
  final String route;
}

/// Static icon vocabulary. Unknown names fall back to [Icons.circle_outlined].
const Map<String, IconData> appIconMap = <String, IconData>{
${iconLines}
};

/// Resolves a spec icon name, then a kind fallback, then a neutral circle.
IconData appIconFor(String? name, [String? fallbackName]) {
  String normalize(String? value) {
    return (value ?? '').trim().toLowerCase().replaceAll(RegExp(r'[\\s-]+'), '_');
  }

  final String key = normalize(name);
  final String fallbackKey = normalize(fallbackName);
  return appIconMap[key] ?? appIconMap[fallbackKey] ?? Icons.circle_outlined;
}

/// Destinations shown by both the bottom bar and the desktop rail.
List<AppDestination> appDestinations() {
  return <AppDestination>[
${destinationLines}
  ];
}

/// Adaptive application shell used as [MaterialApp.home].
///
/// Below 900 logical pixels the shell uses a [NavigationBar]; at and above that
/// breakpoint it switches to a [NavigationRail] (extended from 1200 pixels).
/// An [IndexedStack] preserves each destination's state while the user moves
/// between tabs.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  static const double _railBreakpoint = 900;
  static const double _extendedRailBreakpoint = 1200;

  late final List<AppDestination> _destinations;
  late final List<Widget> _pages;
  int _selectedIndex = 0;

  @override
  void initState() {
    super.initState();
    _destinations = appDestinations();
    _pages = _destinations
        .map((AppDestination destination) => _pageForRoute(destination.route))
        .toList(growable: false);
  }

  void _selectDestination(int index) {
    if (index == _selectedIndex) {
      return;
    }
    setState(() {
      _selectedIndex = index;
    });
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        if (constraints.maxWidth >= _railBreakpoint) {
          return _buildRail(context, constraints.maxWidth >= _extendedRailBreakpoint);
        }
        return _buildBar(context);
      },
    );
  }

  Widget _buildBar(BuildContext context) {
    return Scaffold(
      body: IndexedStack(index: _selectedIndex, children: _pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _selectedIndex,
        onDestinationSelected: _selectDestination,
        destinations: <Widget>[
          for (final AppDestination destination in _destinations)
            NavigationDestination(
              icon: Icon(destination.icon),
              selectedIcon: Icon(destination.icon),
              label: destination.label,
              tooltip: destination.label,
            ),
        ],
      ),
    );
  }

  Widget _buildRail(BuildContext context, bool extended) {
    final ThemeData theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            NavigationRail(
              selectedIndex: _selectedIndex,
              onDestinationSelected: _selectDestination,
              extended: extended,
              labelType: extended
                  ? NavigationRailLabelType.none
                  : NavigationRailLabelType.all,
              leading: Padding(
                padding: EdgeInsets.fromLTRB(
                  appSpaceLg,
                  appSpaceMd,
                  appSpaceLg,
                  appSpaceLg,
                ),
                // NavigationRail's leading slot is width-unbounded, so the Row
                // must be bounded before Expanded can be used inside it.
                child: extended
                    ? SizedBox(
                        width: 200,
                        child: Row(
                          children: <Widget>[
                            Icon(
                              Icons.auto_awesome_rounded,
                              color: theme.colorScheme.primary,
                            ),
                            const SizedBox(width: appSpaceSm),
                            Expanded(
                              child: Text(
                                appDisplayName,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.titleMedium?.copyWith(
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                          ],
                        ),
                      )
                    : Tooltip(
                        message: appDisplayName,
                        child: Icon(
                          Icons.auto_awesome_rounded,
                          color: theme.colorScheme.primary,
                        ),
                      ),
              ),
              destinations: <NavigationRailDestination>[
                for (final AppDestination destination in _destinations)
                  NavigationRailDestination(
                    icon: Icon(destination.icon),
                    selectedIcon: Icon(destination.icon),
                    label: Text(destination.label),
                  ),
              ],
            ),
            const VerticalDivider(width: 1, thickness: 1),
            Expanded(
              child: IndexedStack(index: _selectedIndex, children: _pages),
            ),
          ],
        ),
      ),
    );
  }

  Widget _pageForRoute(String route) {
    switch (route) {
${pageCases}
      default:
        return const _MissingDestinationPage();
    }
  }
}

/// Defensive fallback for a destination that has no generated page.
class _MissingDestinationPage extends StatelessWidget {
  const _MissingDestinationPage();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Unavailable')),
      body: const Center(
        child: Text('This destination is not available in this build.'),
      ),
    );
  }
}
`;
}
