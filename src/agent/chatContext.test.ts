// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ChatContextHandler } from './chatContext';

describe('ChatContextHandler project awareness', () => {
  const samplePubspec = `
name: habit_tracker
description: A mindful habit tracking Flutter app.
version: 1.0.0+1

environment:
  sdk: ^3.5.0

dependencies:
  flutter:
    sdk: flutter
  flutter_riverpod: ^2.5.1
  go_router: ^14.2.0
  supabase_flutter: ^2.6.0

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^4.0.0
`;

  const sampleMain = `
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

final _router = GoRouter(
  initialLocation: '/',
  routes: [
    GoRoute(path: '/', builder: (context, state) => const HomeScreen()),
    GoRoute(path: '/settings', builder: (context, state) => const SettingsScreen()),
  ],
);

void main() => runApp(const ProviderScope(child: MyApp()));

class MyApp extends StatelessWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'Habit Tracker',
      theme: ThemeData(useMaterial3: true, colorSchemeSeed: Colors.indigo),
      routerConfig: _router,
    );
  }
}
`;

  const sampleHomeScreen = `
import 'package:flutter/material.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Habits')),
      body: const Center(child: Text('Track daily habits')),
    );
  }
}
`;

  const sampleHabitCard = `
import 'package:flutter/material.dart';

class HabitCardWidget extends StatelessWidget {
  final String title;
  const HabitCardWidget({super.key, required this.title});
  @override
  Widget build(BuildContext context) {
    return Card(child: Text(title));
  }
}
`;

  const mockFiles = [
    { path: 'pubspec.yaml', content: samplePubspec },
    { path: 'lib/main.dart', content: sampleMain },
    { path: 'lib/screens/home_screen.dart', content: sampleHomeScreen },
    { path: 'lib/widgets/habit_card.dart', content: sampleHabitCard },
  ];

  it('extracts pubspec dependencies, flutter sdk, and metadata', () => {
    const output = ChatContextHandler.build({
      projectName: 'Habit Tracker',
      files: mockFiles,
      messages: [],
    });

    const ctx = output.projectContext;
    expect(ctx.pubspec?.name).toBe('habit_tracker');
    expect(ctx.pubspec?.dependencies).toContain('flutter_riverpod');
    expect(ctx.pubspec?.dependencies).toContain('go_router');
    expect(ctx.pubspec?.dependencies).toContain('supabase_flutter');
    expect(ctx.stateManagement).toBe('Riverpod');
  });

  it('extracts screens, widgets, routes and theme configuration', () => {
    const output = ChatContextHandler.build({
      projectName: 'Habit Tracker',
      files: mockFiles,
      messages: [],
    });

    const ctx = output.projectContext;
    expect(ctx.screens.some((s) => s.name === 'HomeScreen')).toBe(true);
    expect(ctx.widgets.some((w) => w.name === 'HabitCardWidget')).toBe(true);
    expect(ctx.routes).toContain('/');
    expect(ctx.routes).toContain('/settings');
    expect(ctx.themeSummary).toContain('Material 3');
    expect(ctx.themeSummary).toContain('indigo');
  });

  it('selectively retrieves relevant Dart files based on user query', () => {
    const output = ChatContextHandler.build({
      projectName: 'Habit Tracker',
      files: mockFiles,
      messages: [],
      question: 'How does the home screen render the habit card widget?',
    });

    const relevantPaths = output.projectContext.relevantFiles.map((f) => f.path);
    expect(relevantPaths).toContain('lib/screens/home_screen.dart');
    expect(relevantPaths).toContain('lib/widgets/habit_card.dart');
    // Generates tailored prompt context without exploding token budget
    expect(output.formattedPromptContext).toContain('lib/screens/home_screen.dart');
    expect(output.tokenEstimate).toBeGreaterThan(50);
    expect(output.tokenEstimate).toBeLessThan(4000);
  });
});
