/**
 * Generated Flutter smoke test.
 *
 * The test exercises the shell at both breakpoints, proves the settings
 * destination is reachable and flips the theme control without relying on the
 * network or on a specific CRUD screen layout.
 */
import type { AppSpec, ScreenSpec } from '../../contracts.js';
import { dartString } from '../shared.js';
import { navigationScreens } from './navigation.js';
import { appRootClass } from './shell.js';

export function appSmokeTestDart(spec: AppSpec): string {
  const root = appRootClass(spec);
  const appName = spec.app.name;
  const destinations = navigationScreens(spec);
  const labels = destinations.map((screen) => screen.title);
  const firstLabel = labels[0] ?? 'Home';
  const secondLabel = labels[1] ?? firstLabel;
  const settingsScreen: ScreenSpec | undefined = (spec.screens ?? []).find(
    (screen) => screen.kind === 'settings',
  );

  const settingsBlock = settingsScreen
    ? `
    final Finder settingsDestination = find.descendant(
      of: find.byType(NavigationRail),
      matching: find.text(${dartString(settingsScreen.title)}),
    );
    expect(settingsDestination, findsOneWidget);
    await tester.tap(settingsDestination);
    await tester.pumpAndSettle();

    await _toggleThemeControl(tester);
    expect(find.byType(MaterialApp), findsOneWidget);
    expect(tester.takeException(), isNull);
`
    : `
    expect(tester.takeException(), isNull);
`;

  const destinationLabels = labels.map(dartString).join(', ');

  return `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:${spec.app.packageName}/app/app.dart';

/// Sets a deterministic surface size so both adaptive branches are testable.
Future<void> _pumpShell(WidgetTester tester, Size size) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(const ${root}());
  await tester.pumpAndSettle();
}

/// Taps whichever accessible theme control the settings screen exposes.
Future<void> _toggleThemeControl(WidgetTester tester) async {
  final Finder switches = find.byType(Switch);
  if (switches.evaluate().isNotEmpty) {
    await tester.ensureVisible(switches.first);
    await tester.pumpAndSettle();
    await tester.tap(switches.first);
    await tester.pumpAndSettle();
    return;
  }

  final Finder segmented = find.byWidgetPredicate(
    (Widget widget) => widget is SegmentedButton,
  );
  expect(
    segmented,
    findsWidgets,
    reason: 'Settings must expose a Switch or a SegmentedButton theme control.',
  );

  final Finder labels = find.descendant(
    of: segmented.first,
    matching: find.byType(Text),
  );
  if (labels.evaluate().isNotEmpty) {
    final Finder darkLabel = find.descendant(
      of: segmented.first,
      matching: find.text('Dark'),
    );
    final Finder target =
        darkLabel.evaluate().isNotEmpty ? darkLabel.first : labels.last;
    await tester.ensureVisible(target);
    await tester.pumpAndSettle();
    await tester.tap(target);
  } else {
    await tester.ensureVisible(segmented.first);
    await tester.pumpAndSettle();
    await tester.tap(segmented.first);
  }
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('wide shell shows the app name, destinations and a theme control', (
    WidgetTester tester,
  ) async {
    await _pumpShell(tester, const Size(1280, 1000));

    expect(find.text(${dartString(appName)}), findsWidgets);
    expect(find.byType(NavigationRail), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);
    expect(find.text(${dartString(firstLabel)}), findsWidgets);
${settingsBlock}  });

  testWidgets('compact shell keeps every destination in the bottom bar', (
    WidgetTester tester,
  ) async {
    await _pumpShell(tester, const Size(390, 844));

    expect(find.byType(NavigationBar), findsOneWidget);
    expect(find.byType(NavigationRail), findsNothing);

    for (final String label in <String>[${destinationLabels}]) {
      expect(find.text(label), findsWidgets);
    }

    final Finder secondDestination = find.descendant(
      of: find.byType(NavigationBar),
      matching: find.text(${dartString(secondLabel)}),
    );
    expect(secondDestination, findsOneWidget);
    await tester.tap(secondDestination);
    await tester.pumpAndSettle();

    final NavigationBar bar = tester.widget<NavigationBar>(
      find.byType(NavigationBar),
    );
    expect(bar.selectedIndex, 1);
    expect(tester.takeException(), isNull);
  });
}
`;
}
