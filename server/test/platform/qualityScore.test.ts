import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AppSpec,
  BenchmarkCase,
  BenchmarkSuiteReport,
  EntitySpec,
  GateResult,
  GeneratedFile,
  QualityReport,
  ScreenKind,
  ScreenSpec,
} from '../../platform/generation/contracts.js';
import { SCREEN_KINDS } from '../../platform/generation/contracts.js';
import { scoreProject } from '../../platform/generation/quality/score.js';
import {
  BENCHMARKS,
  runBenchmarkSuite,
  type BenchmarkRunner,
} from '../../platform/generation/quality/index.js';
import { camel, pascal, screenClass, snake } from '../../platform/generation/emit/shared.js';

const FIXED_NOW = 1_700_000_000_000;

function file(path: string, content: string): GeneratedFile {
  return { path, content };
}

function codesOf(report: QualityReport): Set<string> {
  return new Set(report.findings.map((finding) => finding.code));
}

// ── golden project ─────────────────────────────────────────────────────────

const goldenSpec: AppSpec = {
  version: 1,
  app: {
    name: 'Golden Notes',
    packageName: 'golden_notes',
    tagline: 'Capture ideas fast',
    description: 'A notes app with tags, pinning and a searchable list.',
    domain: 'productivity',
  },
  audience: { primary: 'busy knowledge workers' },
  entities: [
    {
      name: 'Note',
      plural: 'notes',
      description: 'A written note.',
      fields: [
        { name: 'title', type: 'string', required: true, primary: true, label: 'Title' },
        { name: 'body', type: 'text', required: true, label: 'Body' },
        { name: 'pinned', type: 'bool', required: true, label: 'Pinned' },
        { name: 'tags', type: 'stringList', required: false, label: 'Tags' },
        { name: 'createdAt', type: 'datetime', required: true, label: 'Created' },
      ],
      searchField: 'title',
      sortField: 'createdAt',
    },
  ],
  screens: [
    {
      id: 'dashboard',
      title: 'Dashboard',
      route: '/dashboard',
      kind: 'dashboard',
      purpose: 'Orient the user and surface pinned notes.',
      inNavigation: true,
      icon: 'dashboard',
    },
    {
      id: 'notes',
      title: 'Notes',
      route: '/notes',
      kind: 'list',
      purpose: 'Search, filter and open notes.',
      entity: 'Note',
      inNavigation: true,
      icon: 'notes',
    },
    {
      id: 'note_detail',
      title: 'Note detail',
      route: '/notes/:id',
      kind: 'detail',
      purpose: 'Read a note and manage it.',
      entity: 'Note',
    },
    {
      id: 'note_form',
      title: 'Note form',
      route: '/notes/:id/edit',
      kind: 'form',
      purpose: 'Create and edit notes.',
      entity: 'Note',
      primaryAction: 'Save note',
    },
  ],
  flows: [
    {
      id: 'capture',
      name: 'Capture a note',
      steps: [
        { screenId: 'notes', action: 'open' },
        { screenId: 'note_form', action: 'create' },
        { screenId: 'note_detail', action: 'view' },
      ],
    },
  ],
  design: {
    seedColor: '#6750A4',
    brightness: 'system',
    spacing: [4, 8, 12, 16, 24, 32],
    radii: { sm: 4, md: 8, lg: 12, xl: 16 },
    motionMs: 200,
    shape: 'rounded',
  },
  requirements: [
    { id: 'req.search', statement: 'Users can search notes.', category: 'functional', verifiedBy: 'test' },
    { id: 'req.a11y', statement: 'Icon controls expose labels.', category: 'accessibility', verifiedBy: 'score' },
  ],
  backend: 'local',
  seedCount: 8,
};

const goldenTheme = `import 'package:flutter/material.dart';

abstract final class AppSpacing {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double xxl = 32;
}

abstract final class AppRadius {
  static const double sm = 4;
  static const double md = 8;
  static const double lg = 12;
  static const double xl = 16;
}

abstract final class AppTheme {
  static ThemeData light() => ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6750A4)),
      );

  static ThemeData dark() => ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF6750A4),
          brightness: Brightness.dark,
        ),
      );
}
`;

const goldenModel = `class Note {
  const Note({
    required this.id,
    required this.title,
    required this.body,
    required this.pinned,
    this.tags = const <String>[],
    required this.createdAt,
  });

  final String id;
  final String title;
  final String body;
  final bool pinned;
  final List<String> tags;
  final DateTime createdAt;

  Note copyWith({String? title, String? body, bool? pinned, List<String>? tags}) {
    return Note(
      id: id,
      title: title ?? this.title,
      body: body ?? this.body,
      pinned: pinned ?? this.pinned,
      tags: tags ?? this.tags,
      createdAt: createdAt,
    );
  }

  Map<String, Object?> toJson() => <String, Object?>{
        'id': id,
        'title': title,
        'body': body,
        'pinned': pinned,
        'tags': tags,
        'createdAt': createdAt.toIso8601String(),
      };

  factory Note.fromJson(Map<String, Object?> json) {
    return Note(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      body: json['body'] as String? ?? '',
      pinned: json['pinned'] as bool? ?? false,
      tags: (json['tags'] as List<Object?>?)?.whereType<String>().toList(growable: false) ?? const <String>[],
      createdAt: DateTime.tryParse(json['createdAt'] as String? ?? '') ?? DateTime.fromMillisecondsSinceEpoch(0),
    );
  }
}
`;

const goldenRepository = `import '../models/note.dart';

abstract class NoteRepository {
  Future<List<Note>> list();
  Future<Note?> find(String id);
  Future<void> create(Note note);
  Future<void> update(Note note);
  Future<void> remove(String id);
}

class InMemoryNoteRepository implements NoteRepository {
  InMemoryNoteRepository([List<Note> seed = const <Note>[]]) : _items = [...seed];

  final List<Note> _items;

  @override
  Future<List<Note>> list() async => List<Note>.unmodifiable(_items);

  @override
  Future<Note?> find(String id) async {
    for (final note in _items) {
      if (note.id == id) return note;
    }
    return null;
  }

  @override
  Future<void> create(Note note) async {
    _items.add(note);
  }

  @override
  Future<void> update(Note note) async {
    final index = _items.indexWhere((item) => item.id == note.id);
    if (index >= 0) _items[index] = note;
  }

  @override
  Future<void> remove(String id) async {
    _items.removeWhere((item) => item.id == id);
  }
}
`;

const goldenController = `import 'package:flutter/foundation.dart';

import '../data/models/note.dart';
import '../data/repositories/note_repository.dart';

class NoteController extends ChangeNotifier {
  NoteController(this._repository);

  final NoteRepository _repository;
  List<Note> _items = const <Note>[];
  bool isLoading = false;
  String? error;

  List<Note> get items => _items;

  Future<void> load() async {
    isLoading = true;
    error = null;
    notifyListeners();
    try {
      _items = await _repository.list();
    } catch (exception) {
      error = 'Could not load notes: $exception';
    } finally {
      isLoading = false;
      notifyListeners();
    }
  }

  Future<void> create(Note note) async {
    error = null;
    notifyListeners();
    try {
      await _repository.create(note);
      _items = await _repository.list();
    } catch (exception) {
      error = 'Could not create note: $exception';
    } finally {
      notifyListeners();
    }
  }

  Future<void> update(Note note) async {
    error = null;
    notifyListeners();
    try {
      await _repository.update(note);
      _items = await _repository.list();
    } catch (exception) {
      error = 'Could not update note: $exception';
    } finally {
      notifyListeners();
    }
  }

  Future<void> remove(String id) async {
    error = null;
    notifyListeners();
    try {
      await _repository.remove(id);
      _items = await _repository.list();
    } catch (exception) {
      error = 'Could not delete note: $exception';
    } finally {
      notifyListeners();
    }
  }
}
`;

const goldenSeed = `import '../models/note.dart';

final List<Note> seedNotes = <Note>[
  Note(
    id: 'note_001',
    title: 'Welcome to Golden Notes',
    body: 'Capture your first idea and pin it for later.',
    pinned: true,
    tags: const <String>['intro'],
    createdAt: DateTime.utc(2026, 1, 1),
  ),
  Note(
    id: 'note_002',
    title: 'Shopping list',
    body: 'Milk, bread and coffee.',
    pinned: false,
    createdAt: DateTime.utc(2026, 1, 2),
  ),
];
`;

const goldenDashboard = `import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../app/theme.dart';
import '../../ui/components/states.dart';

class DashboardPage extends StatelessWidget {
  const DashboardPage({super.key});

  @override
  Widget build(BuildContext context) {
    final controller = AppScope.of(context).notes;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Golden Notes'),
        actions: [
          IconButton(
            tooltip: 'Create note',
            icon: const Icon(Icons.add),
            onPressed: () {
              Navigator.of(context).pushNamed('/notes/:id/edit');
            },
          ),
        ],
      ),
      body: ListenableBuilder(
        listenable: controller,
        builder: (context, child) {
          if (controller.isLoading) {
            return const Center(child: CircularProgressIndicator());
          }
          if (controller.error != null) {
            return ErrorState(
              message: controller.error ?? 'Something went wrong',
              onRetry: () async {
                await controller.load();
              },
            );
          }
          if (controller.items.isEmpty) {
            return const EmptyState(title: 'No notes yet', message: 'Create your first note.');
          }
          final pinned = controller.items.where((note) => note.pinned).length;
          return SingleChildScrollView(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('$pinned pinned', maxLines: 1, overflow: TextOverflow.ellipsis),
                const SizedBox(height: AppSpacing.md),
                FilledButton(
                  onPressed: () async {
                    await controller.load();
                  },
                  child: const Text('Refresh'),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}
`;

const goldenList = `import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../app/theme.dart';
import '../../ui/components/states.dart';
import '../note_detail/note_detail_page.dart';
import '../note_form/note_form_page.dart';

class NotesPage extends StatelessWidget {
  const NotesPage({super.key});

  @override
  Widget build(BuildContext context) {
    final controller = AppScope.of(context).notes;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Notes'),
        actions: [
          IconButton(
            tooltip: 'Search notes',
            icon: const Icon(Icons.search),
            onPressed: () async {
              await controller.load();
            },
          ),
          IconButton(
            tooltip: 'New note',
            icon: const Icon(Icons.add),
            onPressed: () => NoteFormPage.open(context),
          ),
        ],
      ),
      body: ListenableBuilder(
        listenable: controller,
        builder: (context, child) {
          if (controller.isLoading) {
            return const Center(child: CircularProgressIndicator());
          }
          if (controller.error != null) {
            return ErrorState(
              message: controller.error ?? 'Something went wrong',
              onRetry: () async {
                await controller.load();
              },
            );
          }
          if (controller.items.isEmpty) {
            return const EmptyState(title: 'No notes', message: 'Tap + to capture your first note.');
          }
          return ListView.builder(
            padding: const EdgeInsets.all(AppSpacing.lg),
            itemCount: controller.items.length,
            itemBuilder: (context, index) {
              final note = controller.items[index];
              return Card(
                child: ListTile(
                  title: Text(note.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                  subtitle: Text(note.body, maxLines: 2, overflow: TextOverflow.ellipsis),
                  trailing: IconButton(
                    tooltip: 'Pin note',
                    icon: Icon(note.pinned ? Icons.push_pin : Icons.push_pin_outlined),
                    onPressed: () async {
                      await controller.update(note.copyWith(pinned: !note.pinned));
                    },
                  ),
                  onTap: () => NoteDetailPage.open(context, note.id),
                ),
              );
            },
          );
        },
      ),
      floatingActionButton: FloatingActionButton(
        tooltip: 'New note',
        onPressed: () => NoteFormPage.open(context),
        child: const Icon(Icons.add),
      ),
    );
  }
}
`;

const goldenDetail = `import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../app/theme.dart';
import '../../ui/components/states.dart';

class NoteDetailPage extends StatelessWidget {
  const NoteDetailPage({super.key, this.entityId});

  final String? entityId;

  static Future<void> open(BuildContext context, String id) {
    return Navigator.of(context).pushNamed('/notes/:id', arguments: id);
  }

  Future<void> _delete(BuildContext context, String id) async {
    final controller = AppScope.of(context).notes;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) {
        return AlertDialog(
          title: const Text('Delete note?'),
          content: const Text('This cannot be undone.'),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('Delete'),
            ),
          ],
        );
      },
    );
    if (confirmed == true) {
      await controller.remove(id);
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = AppScope.of(context).notes;
    final id = entityId ?? '';
    return Scaffold(
      appBar: AppBar(
        title: const Text('Note detail'),
        actions: [
          IconButton(
            tooltip: 'Delete note',
            icon: const Icon(Icons.delete_outline),
            onPressed: () async {
              await _delete(context, id);
            },
          ),
        ],
      ),
      body: ListenableBuilder(
        listenable: controller,
        builder: (context, child) {
          if (controller.isLoading) {
            return const Center(child: CircularProgressIndicator());
          }
          if (controller.error != null) {
            return ErrorState(
              message: controller.error ?? 'Something went wrong',
              onRetry: () async {
                await controller.load();
              },
            );
          }
          final matches = controller.items.where((note) => note.id == id).toList(growable: false);
          if (matches.isEmpty) {
            return const EmptyState(title: 'Note not found', message: 'It may have been deleted.');
          }
          final note = matches.first;
          return Padding(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(note.title, style: Theme.of(context).textTheme.headlineSmall, maxLines: 2, overflow: TextOverflow.ellipsis),
                const SizedBox(height: AppSpacing.md),
                Text(note.body, maxLines: 8, overflow: TextOverflow.ellipsis),
                const SizedBox(height: AppSpacing.lg),
                Text(note.pinned ? 'Pinned' : 'Not pinned', maxLines: 1, overflow: TextOverflow.ellipsis),
              ],
            ),
          );
        },
      ),
    );
  }
}
`;

const goldenForm = `import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../app/theme.dart';
import '../../data/models/note.dart';
import '../../ui/components/states.dart';

class NoteFormPage extends StatefulWidget {
  const NoteFormPage({super.key, this.entityId});

  final String? entityId;

  static Future<void> open(BuildContext context, {String? id}) {
    return Navigator.of(context).pushNamed('/notes/:id/edit', arguments: id);
  }

  @override
  State<NoteFormPage> createState() => _NoteFormPageState();
}

class _NoteFormPageState extends State<NoteFormPage> {
  final _formKey = GlobalKey<FormState>();
  final _titleController = TextEditingController();
  final _bodyController = TextEditingController();
  bool _pinned = false;

  @override
  void dispose() {
    _titleController.dispose();
    _bodyController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final controller = AppScope.of(context).notes;
    final note = Note(
      id: widget.entityId ?? 'note_new',
      title: _titleController.text.trim(),
      body: _bodyController.text.trim(),
      pinned: _pinned,
      createdAt: DateTime.utc(2026, 1, 1),
    );
    if (widget.entityId == null) {
      await controller.create(note);
    } else {
      await controller.update(note);
    }
    if (!mounted) return;
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final controller = AppScope.of(context).notes;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Note form'),
        actions: [
          IconButton(
            tooltip: 'Save note',
            icon: const Icon(Icons.check),
            onPressed: () async {
              await _submit();
            },
          ),
        ],
      ),
      body: ListenableBuilder(
        listenable: controller,
        builder: (context, child) {
          if (controller.error != null) {
            return ErrorState(
              message: controller.error ?? 'Something went wrong',
              onRetry: () async {
                await controller.load();
              },
            );
          }
          return Form(
            key: _formKey,
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(AppSpacing.lg),
              child: Column(
                children: [
                  TextFormField(
                    controller: _titleController,
                    decoration: const InputDecoration(labelText: 'Title'),
                    validator: (value) {
                      if (value == null || value.trim().isEmpty) return 'Title is required';
                      return null;
                    },
                  ),
                  const SizedBox(height: AppSpacing.md),
                  TextFormField(
                    controller: _bodyController,
                    maxLines: 5,
                    decoration: const InputDecoration(labelText: 'Body'),
                    validator: (value) {
                      if (value == null || value.trim().isEmpty) return 'Body is required';
                      return null;
                    },
                  ),
                  const SizedBox(height: AppSpacing.md),
                  SwitchListTile(
                    title: const Text('Pinned'),
                    value: _pinned,
                    onChanged: (value) {
                      setState(() {
                        _pinned = value;
                      });
                    },
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  FilledButton(
                    onPressed: () async {
                      await _submit();
                    },
                    child: const Text('Save note'),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}
`;

const goldenStates = `import 'package:flutter/material.dart';

import '../../app/theme.dart';

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.title, required this.message});

  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.inbox_outlined, size: 48),
            const SizedBox(height: AppSpacing.md),
            Text(title, style: Theme.of(context).textTheme.titleMedium, textAlign: TextAlign.center),
            const SizedBox(height: AppSpacing.sm),
            Text(message, textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}

class ErrorState extends StatelessWidget {
  const ErrorState({super.key, required this.message, required this.onRetry});

  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48),
            const SizedBox(height: AppSpacing.md),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: AppSpacing.lg),
            FilledButton(
              onPressed: () async {
                await onRetry();
              },
              child: const Text('Try again'),
            ),
          ],
        ),
      ),
    );
  }
}
`;

const goldenFiles: GeneratedFile[] = [
  file(
    'pubspec.yaml',
    `name: golden_notes
description: Capture ideas fast
publish_to: "none"
version: 1.0.0+1

environment:
  sdk: ">=3.4.0 <4.0.0"

dependencies:
  flutter:
    sdk: flutter
`,
  ),
  file('analysis_options.yaml', 'include: package:flutter_lints/flutter.yaml\n'),
  file(
    'lib/main.dart',
    `import 'package:flutter/material.dart';

import 'app/app.dart';

void main() {
  runApp(const GoldenNotesApp());
}
`,
  ),
  file(
    'lib/app/app.dart',
    `import 'package:flutter/material.dart';

import 'app_scope.dart';
import 'router.dart';
import 'theme.dart';

class GoldenNotesApp extends StatelessWidget {
  const GoldenNotesApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Golden Notes',
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: ThemeMode.system,
      onGenerateRoute: AppRouter.onGenerateRoute,
      builder: (context, child) => AppScope(child: child ?? const SizedBox.shrink()),
    );
  }
}
`,
  ),
  file('lib/app/theme.dart', goldenTheme),
  file(
    'lib/app/router.dart',
    `import 'package:flutter/material.dart';

import '../features/dashboard/dashboard_page.dart';
import '../features/note_detail/note_detail_page.dart';
import '../features/note_form/note_form_page.dart';
import '../features/notes/notes_page.dart';

abstract final class AppRouter {
  static const String dashboard = '/dashboard';
  static const String notes = '/notes';
  static const String noteDetail = '/notes/:id';
  static const String noteForm = '/notes/:id/edit';

  static Route<dynamic> onGenerateRoute(RouteSettings settings) {
    switch (settings.name) {
      case dashboard:
        return MaterialPageRoute<void>(builder: (_) => const DashboardPage());
      case notes:
        return MaterialPageRoute<void>(builder: (_) => const NotesPage());
      case noteDetail:
        return MaterialPageRoute<void>(
          builder: (_) => NoteDetailPage(entityId: settings.arguments as String?),
        );
      case noteForm:
        return MaterialPageRoute<void>(
          builder: (_) => NoteFormPage(entityId: settings.arguments as String?),
        );
      default:
        return MaterialPageRoute<void>(builder: (_) => const NotesPage());
    }
  }
}
`,
  ),
  file(
    'lib/app/navigation.dart',
    `import 'package:flutter/material.dart';

import 'router.dart';

class AppDestination {
  const AppDestination({required this.label, required this.icon, required this.route});

  final String label;
  final IconData icon;
  final String route;
}

const List<AppDestination> appDestinations = <AppDestination>[
  AppDestination(label: 'Dashboard', icon: Icons.dashboard_outlined, route: AppRouter.dashboard),
  AppDestination(label: 'Notes', icon: Icons.notes_outlined, route: AppRouter.notes),
];
`,
  ),
  file(
    'lib/app/app_scope.dart',
    `import 'package:flutter/widgets.dart';

import '../data/repositories/note_repository.dart';
import '../data/seed/note_seed.dart';
import '../state/note_controller.dart';

class AppScope extends InheritedWidget {
  const AppScope({super.key, required this.notes, required super.child});

  final NoteController notes;

  static AppScope of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<AppScope>();
    assert(scope != null, 'AppScope is missing');
    return scope as AppScope;
  }

  @override
  bool updateShouldNotify(AppScope oldWidget) => notes != oldWidget.notes;
}

AppScope createAppScope({required Widget child}) {
  final repository = InMemoryNoteRepository(seedNotes);
  return AppScope(notes: NoteController(repository), child: child);
}
`,
  ),
  file('lib/data/models/note.dart', goldenModel),
  file('lib/data/repositories/note_repository.dart', goldenRepository),
  file('lib/data/seed/note_seed.dart', goldenSeed),
  file('lib/state/note_controller.dart', goldenController),
  file('lib/ui/components/states.dart', goldenStates),
  file('lib/features/dashboard/dashboard_page.dart', goldenDashboard),
  file('lib/features/notes/notes_page.dart', goldenList),
  file('lib/features/note_detail/note_detail_page.dart', goldenDetail),
  file('lib/features/note_form/note_form_page.dart', goldenForm),
  file(
    'test/app/app_smoke_test.dart',
    `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:golden_notes/app/app.dart';

void main() {
  testWidgets('app boots into the dashboard', (tester) async {
    await tester.pumpWidget(const GoldenNotesApp());
    expect(find.byType(MaterialApp), findsOneWidget);
    expect(find.text('Golden Notes'), findsWidgets);
    expect(find.byType(Scaffold), findsWidgets);
  });
}
`,
  ),
  file(
    'test/data/note_test.dart',
    `import 'package:flutter_test/flutter_test.dart';
import 'package:golden_notes/data/models/note.dart';

void main() {
  test('Note round-trips through JSON', () {
    final note = Note(
      id: 'note_001',
      title: 'Title',
      body: 'Body',
      pinned: false,
      tags: const <String>['tag'],
      createdAt: DateTime.utc(2026, 1, 1),
    );
    final restored = Note.fromJson(note.toJson());
    expect(restored.title, 'Title');
    expect(restored.tags, const <String>['tag']);
  });
}
`,
  ),
];

// ── toy project ────────────────────────────────────────────────────────────

const toySpec: AppSpec = {
  version: 1,
  app: {
    name: 'Toy Notes',
    packageName: 'toy_notes',
    tagline: 'A toy',
    description: 'The smallest possible scaffold-shaped project.',
    domain: 'custom',
  },
  audience: { primary: 'nobody' },
  entities: [
    {
      name: 'Note',
      plural: 'notes',
      description: 'A note with no data layer.',
      fields: [
        { name: 'title', type: 'string', required: true, primary: true },
        { name: 'body', type: 'text', required: true },
        { name: 'createdAt', type: 'datetime', required: true },
      ],
    },
  ],
  screens: [
    {
      id: 'notes',
      title: 'Notes',
      route: '/notes',
      kind: 'list',
      purpose: 'Show notes.',
      entity: 'Note',
      inNavigation: true,
    },
    {
      id: 'note_form',
      title: 'Note form',
      route: '/notes/:id/edit',
      kind: 'form',
      purpose: 'Edit a note.',
      entity: 'Note',
    },
  ],
  flows: [{ id: 'flow', name: 'Flow', steps: [{ screenId: 'notes', action: 'open' }] }],
  design: {
    seedColor: '#112233',
    brightness: 'light',
    spacing: [4, 8, 16],
    radii: { sm: 2, md: 4, lg: 8, xl: 12 },
    motionMs: 0,
    shape: 'square',
  },
  requirements: [
    { id: 'req', statement: 'It opens.', category: 'functional', verifiedBy: 'score' },
  ],
  backend: 'local',
  seedCount: 0,
};

const toyFiles: GeneratedFile[] = [
  file(
    'lib/features/notes/notes_page.dart',
    `import 'package:flutter/material.dart';

class NotesPage extends StatelessWidget {
  NotesPage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Color(0xFF112233),
    );
  }
}
`,
  ),
];

// ── tests ──────────────────────────────────────────────────────────────────

test('golden project scores in the top grades with clean category scores', () => {
  const report = scoreProject(goldenSpec, goldenFiles, { now: () => FIXED_NOW });
  assert.ok(report.total >= 85, `expected >= 85, got ${report.total}: ${JSON.stringify(report.categories)}`);
  assert.ok(report.grade === 'A' || report.grade === 'B', `unexpected grade ${report.grade}`);
  for (const [category, value] of Object.entries(report.categories)) {
    assert.ok(value >= 80, `${category} should be >= 80, got ${value}`);
  }
  assert.equal(report.generatedAt, FIXED_NOW);
  assert.equal(report.stats.screens, goldenSpec.screens.length);
  assert.equal(report.stats.entities, goldenSpec.entities.length);
  assert.ok(report.stats.tests >= 2);
  assert.ok(report.stats.lines > 0);
  assert.ok(report.stats.bytes > 0);
});

test('scaffold-only toy project scores low and emits specific finding codes', () => {
  const report = scoreProject(toySpec, toyFiles, { now: () => FIXED_NOW });
  assert.ok(report.total <= 55, `expected <= 55, got ${report.total}: ${JSON.stringify(report.categories)}`);
  const codes = codesOf(report);
  for (const expected of [
    'MISSING_SCREEN',
    'EMPTY_SCREEN',
    'RAW_COLOR',
    'NO_REPOSITORY_SEAM',
    'NO_CONTROLLER',
    'MISSING_TEST',
    'NO_ERROR_STATE',
    'NO_CONST_CONSTRUCTORS',
    'MISSING_VALIDATOR',
    'MISSING_THEME',
  ]) {
    assert.ok(codes.has(expected), `expected finding code ${expected}; got ${[...codes].join(', ')}`);
  }
  assert.ok(report.total < 70, 'toy project must never clear the benchmark bar');
});

test('scoreProject is deterministic for identical input and injected clock', () => {
  const first = scoreProject(goldenSpec, goldenFiles, { now: () => FIXED_NOW });
  const second = scoreProject(goldenSpec, goldenFiles, { now: () => FIXED_NOW });
  assert.deepEqual(first, second);
  const third = scoreProject(goldenSpec, [...goldenFiles].reverse(), { now: () => FIXED_NOW });
  assert.equal(first.total, third.total);
  assert.deepEqual(first.categories, third.categories);
});

test('findings are capped, sorted by severity then code, and always coded', () => {
  const report = scoreProject(toySpec, toyFiles, { now: () => FIXED_NOW });
  assert.ok(report.findings.length <= 80);
  const rank = { error: 0, warning: 1, info: 2 } as const;
  for (let index = 1; index < report.findings.length; index += 1) {
    const previous = report.findings[index - 1];
    const current = report.findings[index];
    const previousKey = `${rank[previous.severity]}:${previous.code}`;
    const currentKey = `${rank[current.severity]}:${current.code}`;
    assert.ok(previousKey <= currentKey, `findings out of order at ${index}: ${previousKey} > ${currentKey}`);
  }
  for (const finding of report.findings) {
    assert.ok(finding.code.length > 0);
    assert.ok(finding.message.length > 0);
  }
});

// ── benchmark fakes ────────────────────────────────────────────────────────

const PERFECT_GATES: GateResult[] = [
  { gate: 'analyze', passed: true, blockers: [] },
  { gate: 'test', passed: true, blockers: [] },
  { gate: 'structure', passed: true, blockers: [] },
];

function benchmarkSpec(benchmark: BenchmarkCase): AppSpec {
  const names = benchmark.expectation.entities.length > 0 ? benchmark.expectation.entities : ['Item'];
  const entities: EntitySpec[] = names.map((name) => {
    const className = pascal(name);
    return {
      name: className,
      plural: `${snake(name)}s`,
      description: `${className} record.`,
      fields: [
        { name: 'title', type: 'string', required: true, primary: true, label: 'Title' },
        { name: 'notes', type: 'text', required: true, label: 'Notes' },
        { name: 'createdAt', type: 'datetime', required: true, label: 'Created' },
      ],
      searchField: 'title',
      sortField: 'createdAt',
    };
  });

  const kinds: ScreenKind[] = [...benchmark.expectation.screenKinds];
  for (const filler of ['dashboard', 'settings', 'profile', 'chat', 'onboarding'] as ScreenKind[]) {
    if (kinds.length >= (benchmark.expectation.minScreens ?? 4)) break;
    if (!kinds.includes(filler)) kinds.push(filler);
  }

  const primary = entities[0].name;
  const screens: ScreenSpec[] = kinds.map((kind) => {
    const bound = kind === 'list' || kind === 'detail' || kind === 'form';
    const route =
      kind === 'detail'
        ? `/${snake(primary)}/:id`
        : kind === 'form'
          ? `/${snake(primary)}/:id/edit`
          : `/${kind}`;
    return {
      id: kind,
      title: pascal(kind),
      route,
      kind,
      purpose: `${pascal(kind)} for ${primary}.`,
      entity: bound ? primary : undefined,
      inNavigation: kind === 'dashboard' || kind === 'list',
    };
  });

  return {
    version: 1,
    app: {
      name: `${pascal(benchmark.id)} Benchmark`,
      packageName: `${snake(benchmark.id)}_app`,
      tagline: 'A benchmark fixture',
      description: 'Synthetic project used to test the benchmark suite.',
      domain: 'custom',
    },
    audience: { primary: 'benchmark' },
    entities,
    screens,
    flows: [{ id: 'main', name: 'Main flow', steps: [{ screenId: screens[0].id, action: 'open' }] }],
    design: {
      seedColor: '#6750A4',
      brightness: 'system',
      spacing: [4, 8, 12, 16, 24, 32],
      radii: { sm: 4, md: 8, lg: 12, xl: 16 },
      motionMs: 200,
      shape: 'rounded',
    },
    requirements: [
      { id: 'req.main', statement: 'The main flow works.', category: 'functional', verifiedBy: 'test' },
    ],
    backend: 'local',
    seedCount: 6,
  };
}

interface FixtureEntity {
  cls: string;
  model: string;
  varName: string;
  controller: string;
  repository: string;
}

function fixtureEntities(spec: AppSpec): FixtureEntity[] {
  return spec.entities.map((entity) => ({
    cls: pascal(entity.name),
    model: snake(entity.name),
    varName: camel(entity.plural),
    controller: `${pascal(entity.name)}Controller`,
    repository: `${pascal(entity.name)}Repository`,
  }));
}

function fixtureTheme(spec: AppSpec): string {
  const hex = spec.design.seedColor.replace(/^#/, '').toUpperCase();
  return `import 'package:flutter/material.dart';

abstract final class AppSpacing {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double xxl = 32;
}

abstract final class AppRadius {
  static const double sm = 4;
  static const double md = 8;
  static const double lg = 12;
  static const double xl = 16;
}

abstract final class AppTheme {
  static ThemeData light() => ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF${hex})),
      );

  static ThemeData dark() => ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF${hex}),
          brightness: Brightness.dark,
        ),
      );
}
`;
}

function fixtureModel(entity: FixtureEntity): string {
  return `class ${entity.cls} {
  const ${entity.cls}({
    required this.id,
    required this.title,
    required this.notes,
    required this.createdAt,
  });

  final String id;
  final String title;
  final String notes;
  final DateTime createdAt;

  ${entity.cls} copyWith({String? title, String? notes}) {
    return ${entity.cls}(
      id: id,
      title: title ?? this.title,
      notes: notes ?? this.notes,
      createdAt: createdAt,
    );
  }

  Map<String, Object?> toJson() => <String, Object?>{
        'id': id,
        'title': title,
        'notes': notes,
        'createdAt': createdAt.toIso8601String(),
      };

  factory ${entity.cls}.fromJson(Map<String, Object?> json) {
    return ${entity.cls}(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      notes: json['notes'] as String? ?? '',
      createdAt: DateTime.tryParse(json['createdAt'] as String? ?? '') ?? DateTime.fromMillisecondsSinceEpoch(0),
    );
  }
}
`;
}

function fixtureRepository(entity: FixtureEntity): string {
  return `import '../models/${entity.model}.dart';

abstract class ${entity.repository} {
  Future<List<${entity.cls}>> list();
  Future<${entity.cls}?> find(String id);
  Future<void> create(${entity.cls} item);
  Future<void> update(${entity.cls} item);
  Future<void> remove(String id);
}

class InMemory${entity.cls}Repository implements ${entity.repository} {
  InMemory${entity.cls}Repository([List<${entity.cls}> seed = const <${entity.cls}>[]]) : _items = [...seed];

  final List<${entity.cls}> _items;

  @override
  Future<List<${entity.cls}>> list() async => List<${entity.cls}>.unmodifiable(_items);

  @override
  Future<${entity.cls}?> find(String id) async {
    for (final item in _items) {
      if (item.id == id) return item;
    }
    return null;
  }

  @override
  Future<void> create(${entity.cls} item) async {
    _items.add(item);
  }

  @override
  Future<void> update(${entity.cls} item) async {
    final index = _items.indexWhere((candidate) => candidate.id == item.id);
    if (index >= 0) _items[index] = item;
  }

  @override
  Future<void> remove(String id) async {
    _items.removeWhere((candidate) => candidate.id == id);
  }
}
`;
}

function fixtureController(entity: FixtureEntity): string {
  return `import 'package:flutter/foundation.dart';

import '../data/models/${entity.model}.dart';
import '../data/repositories/${entity.model}_repository.dart';

class ${entity.controller} extends ChangeNotifier {
  ${entity.controller}(this._repository);

  final ${entity.repository} _repository;
  List<${entity.cls}> _items = const <${entity.cls}>[];
  bool isLoading = false;
  String? error;

  List<${entity.cls}> get items => _items;

  Future<void> load() async {
    isLoading = true;
    error = null;
    notifyListeners();
    try {
      _items = await _repository.list();
    } catch (exception) {
      error = 'Could not load: $exception';
    } finally {
      isLoading = false;
      notifyListeners();
    }
  }

  Future<void> create(${entity.cls} item) async {
    error = null;
    notifyListeners();
    try {
      await _repository.create(item);
      _items = await _repository.list();
    } catch (exception) {
      error = 'Could not create: $exception';
    } finally {
      notifyListeners();
    }
  }

  Future<void> update(${entity.cls} item) async {
    error = null;
    notifyListeners();
    try {
      await _repository.update(item);
      _items = await _repository.list();
    } catch (exception) {
      error = 'Could not update: $exception';
    } finally {
      notifyListeners();
    }
  }

  Future<void> remove(String id) async {
    error = null;
    notifyListeners();
    try {
      await _repository.remove(id);
      _items = await _repository.list();
    } catch (exception) {
      error = 'Could not delete: $exception';
    } finally {
      notifyListeners();
    }
  }
}
`;
}

function fixtureSeed(entity: FixtureEntity): string {
  return `import '../models/${entity.model}.dart';

final List<${entity.cls}> seed${entity.cls} = <${entity.cls}>[
  ${entity.cls}(
    id: '${entity.model}_001',
    title: 'Sample ${entity.cls}',
    notes: 'Seeded record for the benchmark fixture.',
    createdAt: DateTime.utc(2026, 1, 1),
  ),
];
`;
}

function fixtureListPage(className: string, title: string, entity: FixtureEntity): string {
  return `import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../app/theme.dart';
import '../../ui/components/states.dart';

class ${className} extends StatelessWidget {
  const ${className}({super.key});

  @override
  Widget build(BuildContext context) {
    final controller = AppScope.of(context).${entity.varName};
    return Scaffold(
      appBar: AppBar(
        title: const Text('${title}'),
        actions: [
          IconButton(
            tooltip: 'Search',
            icon: const Icon(Icons.search),
            onPressed: () async {
              await controller.load();
            },
          ),
        ],
      ),
      body: ListenableBuilder(
        listenable: controller,
        builder: (context, child) {
          if (controller.isLoading) {
            return const Center(child: CircularProgressIndicator());
          }
          if (controller.error != null) {
            return ErrorState(
              message: controller.error ?? 'Something went wrong',
              onRetry: () async {
                await controller.load();
              },
            );
          }
          if (controller.items.isEmpty) {
            return const EmptyState(title: 'Empty', message: 'Nothing here yet.');
          }
          return ListView.builder(
            padding: const EdgeInsets.all(AppSpacing.lg),
            itemCount: controller.items.length,
            itemBuilder: (context, index) {
              final item = controller.items[index];
              return ListTile(
                title: Text(item.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text(item.notes, maxLines: 2, overflow: TextOverflow.ellipsis),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      tooltip: 'Open',
                      icon: const Icon(Icons.chevron_right),
                      onPressed: () async {
                        await controller.load();
                      },
                    ),
                    IconButton(
                      tooltip: 'Delete',
                      icon: const Icon(Icons.delete_outline),
                      onPressed: () async {
                        final confirmed = await showDialog<bool>(
                          context: context,
                          builder: (dialogContext) => AlertDialog(
                            title: const Text('Delete item?'),
                            actions: [
                              TextButton(
                                onPressed: () => Navigator.of(dialogContext).pop(false),
                                child: const Text('Cancel'),
                              ),
                              FilledButton(
                                onPressed: () => Navigator.of(dialogContext).pop(true),
                                child: const Text('Delete'),
                              ),
                            ],
                          ),
                        );
                        if (confirmed == true) {
                          await controller.remove(item.id);
                        }
                      },
                    ),
                  ],
                ),
              );
            },
          );
        },
      ),
    );
  }
}
`;
}

function fixtureFormPage(className: string, title: string, entity: FixtureEntity): string {
  return `import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../app/theme.dart';
import '../../data/models/${entity.model}.dart';
import '../../ui/components/states.dart';

class ${className} extends StatefulWidget {
  const ${className}({super.key, this.entityId});

  final String? entityId;

  @override
  State<${className}> createState() => _${className}State();
}

class _${className}State extends State<${className}> {
  final _formKey = GlobalKey<FormState>();
  final _titleController = TextEditingController();
  final _notesController = TextEditingController();

  @override
  void dispose() {
    _titleController.dispose();
    _notesController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final controller = AppScope.of(context).${entity.varName};
    final item = ${entity.cls}(
      id: widget.entityId ?? 'new',
      title: _titleController.text.trim(),
      notes: _notesController.text.trim(),
      createdAt: DateTime.utc(2026, 1, 1),
    );
    if (widget.entityId == null) {
      await controller.create(item);
    } else {
      await controller.update(item);
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = AppScope.of(context).${entity.varName};
    return Scaffold(
      appBar: AppBar(
        title: const Text('${title}'),
        actions: [
          IconButton(
            tooltip: 'Save',
            icon: const Icon(Icons.check),
            onPressed: () async {
              await _submit();
            },
          ),
        ],
      ),
      body: ListenableBuilder(
        listenable: controller,
        builder: (context, child) {
          if (controller.error != null) {
            return ErrorState(
              message: controller.error ?? 'Something went wrong',
              onRetry: () async {
                await controller.load();
              },
            );
          }
          return Form(
            key: _formKey,
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(AppSpacing.lg),
              child: Column(
                children: [
                  TextFormField(
                    controller: _titleController,
                    decoration: const InputDecoration(labelText: 'Title'),
                    validator: (value) {
                      if (value == null || value.trim().isEmpty) return 'Title is required';
                      return null;
                    },
                  ),
                  const SizedBox(height: AppSpacing.md),
                  TextFormField(
                    controller: _notesController,
                    maxLines: 4,
                    decoration: const InputDecoration(labelText: 'Notes'),
                    validator: (value) {
                      if (value == null || value.trim().isEmpty) return 'Notes are required';
                      return null;
                    },
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  FilledButton(
                    onPressed: () async {
                      await _submit();
                    },
                    child: const Text('Save'),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}
`;
}

function fixtureGenericPage(className: string, title: string, entity: FixtureEntity): string {
  return `import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../app/theme.dart';
import '../../ui/components/states.dart';

class ${className} extends StatelessWidget {
  const ${className}({super.key});

  @override
  Widget build(BuildContext context) {
    final controller = AppScope.of(context).${entity.varName};
    return Scaffold(
      appBar: AppBar(
        title: const Text('${title}'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: () async {
              await controller.load();
            },
          ),
        ],
      ),
      body: ListenableBuilder(
        listenable: controller,
        builder: (context, child) {
          if (controller.isLoading) {
            return const Center(child: CircularProgressIndicator());
          }
          if (controller.error != null) {
            return ErrorState(
              message: controller.error ?? 'Something went wrong',
              onRetry: () async {
                await controller.load();
              },
            );
          }
          if (controller.items.isEmpty) {
            return const EmptyState(title: 'Empty', message: 'Nothing here yet.');
          }
          return SingleChildScrollView(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${title}', maxLines: 1, overflow: TextOverflow.ellipsis),
                const SizedBox(height: AppSpacing.md),
                Text('\${controller.items.length} records', maxLines: 1, overflow: TextOverflow.ellipsis),
              ],
            ),
          );
        },
      ),
    );
  }
}
`;
}

function fixtureFiles(spec: AppSpec, benchmark: BenchmarkCase): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const entities = fixtureEntities(spec);
  const primary = entities[0];
  const pkg = spec.app.packageName;

  files.push(file('pubspec.yaml', `name: ${pkg}\ndescription: Benchmark fixture\npublish_to: "none"\nversion: 1.0.0+1\n\nenvironment:\n  sdk: ">=3.4.0 <4.0.0"\n\ndependencies:\n  flutter:\n    sdk: flutter\n`));
  files.push(file('analysis_options.yaml', 'include: package:flutter_lints/flutter.yaml\n'));
  files.push(file('lib/app/theme.dart', fixtureTheme(spec)));

  files.push(
    file(
      'lib/main.dart',
      `import 'package:flutter/material.dart';

import 'app/app.dart';

void main() {
  runApp(const BenchmarkApp());
}
`,
    ),
  );

  files.push(
    file(
      'lib/app/app.dart',
      `import 'package:flutter/material.dart';

import 'app_scope.dart';
import 'router.dart';
import 'theme.dart';

class BenchmarkApp extends StatelessWidget {
  const BenchmarkApp({super.key});

  @override
  Widget build(BuildContext context) {
    return createAppScope(
      child: MaterialApp(
        title: '${spec.app.name}',
        theme: AppTheme.light(),
        darkTheme: AppTheme.dark(),
        themeMode: ThemeMode.system,
        onGenerateRoute: AppRouter.onGenerateRoute,
      ),
    );
  }
}
`,
    ),
  );

  const routeImports = spec.screens
    .map((screen) => `import '../features/${snake(screen.id)}/${snake(screen.id)}_page.dart';`)
    .join('\n');
  const routeCases = spec.screens
    .map((screen) => {
      const className = screenClass(screen);
      const constructor =
        screen.kind === 'form'
          ? `${className}(entityId: settings.arguments as String?)`
          : `const ${className}()`;
      return `      case '${screen.route}':
        return MaterialPageRoute<void>(builder: (_) => ${constructor});`;
    })
    .join('\n');
  files.push(
    file(
      'lib/app/router.dart',
      `import 'package:flutter/material.dart';

${routeImports}

abstract final class AppRouter {
${spec.screens.map((screen) => `  static const String ${camel(screen.id)} = '${screen.route}';`).join('\n')}

  static Route<dynamic> onGenerateRoute(RouteSettings settings) {
    switch (settings.name) {
${routeCases}
      default:
        return MaterialPageRoute<void>(builder: (_) => const ${screenClass(spec.screens[0])}());
    }
  }
}
`,
    ),
  );

  const navRoutes = spec.screens.filter((screen) => screen.inNavigation).map((screen) => screen.route);
  files.push(
    file(
      'lib/app/navigation.dart',
      `const List<String> appNavigationRoutes = <String>[
${navRoutes.map((route) => `  '${route}',`).join('\n')}
];
`,
    ),
  );

  const scopeImports = [
    ...entities.map((entity) => `import '../data/repositories/${entity.model}_repository.dart';`),
    ...entities.map((entity) => `import '../data/seed/${entity.model}_seed.dart';`),
    ...entities.map((entity) => `import '../state/${entity.model}_controller.dart';`),
  ].join('\n');
  const scopeFields = entities.map((entity) => `  final ${entity.controller} ${entity.varName};`).join('\n');
  const scopeCtor = entities.map((entity) => `required this.${entity.varName}`).join(', ');
  const notify = entities.map((entity) => `${entity.varName} != oldWidget.${entity.varName}`).join(' || ');
  const repoInits = entities
    .map((entity, index) => `  final ${entity.repository} repository${index} = InMemory${entity.cls}Repository(seed${entity.cls});`)
    .join('\n');
  const scopeArgs = entities
    .map((entity, index) => `${entity.varName}: ${entity.controller}(repository${index})`)
    .join(', ');
  files.push(
    file(
      'lib/app/app_scope.dart',
      `import 'package:flutter/widgets.dart';

${scopeImports}

class AppScope extends InheritedWidget {
  const AppScope({super.key, ${scopeCtor}, required super.child});

${scopeFields}

  static AppScope of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<AppScope>();
    assert(scope != null, 'AppScope is missing');
    return scope as AppScope;
  }

  @override
  bool updateShouldNotify(AppScope oldWidget) => ${notify};
}

AppScope createAppScope({required Widget child}) {
${repoInits}
  return AppScope(${scopeArgs}, child: child);
}
`,
    ),
  );

  files.push(
    file(
      'lib/ui/components/states.dart',
      `import 'package:flutter/material.dart';

import '../../app/theme.dart';

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.title, required this.message});

  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.inbox_outlined, size: 48),
            const SizedBox(height: AppSpacing.md),
            Text(title, textAlign: TextAlign.center),
            const SizedBox(height: AppSpacing.sm),
            Text(message, textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}

class ErrorState extends StatelessWidget {
  const ErrorState({super.key, required this.message, required this.onRetry});

  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48),
            const SizedBox(height: AppSpacing.md),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: AppSpacing.lg),
            FilledButton(
              onPressed: () async {
                await onRetry();
              },
              child: const Text('Try again'),
            ),
          ],
        ),
      ),
    );
  }
}
`,
    ),
  );

  const markers = benchmark.expectation.mustInclude ?? [];
  if (markers.length > 0) {
    files.push(
      file(
        'lib/app/features.dart',
        `const List<String> benchmarkFeatures = <String>[
${markers.map((marker) => `  '${String(marker).toLowerCase()}',`).join('\n')}
];
`,
      ),
    );
  }

  for (const entity of entities) {
    files.push(file(`lib/data/models/${entity.model}.dart`, fixtureModel(entity)));
    files.push(file(`lib/data/repositories/${entity.model}_repository.dart`, fixtureRepository(entity)));
    files.push(file(`lib/state/${entity.model}_controller.dart`, fixtureController(entity)));
    files.push(file(`lib/data/seed/${entity.model}_seed.dart`, fixtureSeed(entity)));
    files.push(
      file(
        `test/data/${entity.model}_test.dart`,
        `import 'package:flutter_test/flutter_test.dart';
import 'package:${pkg}/data/models/${entity.model}.dart';

void main() {
  test('${entity.cls} round-trips through JSON', () {
    final item = ${entity.cls}(
      id: '${entity.model}_001',
      title: 'Title',
      notes: 'Notes',
      createdAt: DateTime.utc(2026, 1, 1),
    );
    final restored = ${entity.cls}.fromJson(item.toJson());
    expect(restored.title, 'Title');
    expect(restored.notes, 'Notes');
  });
}
`,
      ),
    );
  }

  for (const screen of spec.screens) {
    const className = screenClass(screen);
    const path = `lib/features/${snake(screen.id)}/${snake(screen.id)}_page.dart`;
    let content: string;
    if (screen.kind === 'list') content = fixtureListPage(className, screen.title, primary);
    else if (screen.kind === 'form') content = fixtureFormPage(className, screen.title, primary);
    else content = fixtureGenericPage(className, screen.title, primary);
    files.push(file(path, content));
  }

  files.push(
    file(
      'test/app/app_smoke_test.dart',
      `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:${pkg}/app/app.dart';

void main() {
  testWidgets('app boots and renders the dashboard', (tester) async {
    await tester.pumpWidget(const BenchmarkApp());
    expect(find.byType(MaterialApp), findsOneWidget);
    expect(find.byType(Scaffold), findsWidgets);
    expect(find.text('Dashboard'), findsWidgets);
  });
}
`,
    ),
  );

  return files;
}

const perfectRunner: BenchmarkRunner = async (benchmark) => {
  const spec = benchmarkSpec(benchmark);
  return {
    spec,
    files: fixtureFiles(spec, benchmark),
    gates: PERFECT_GATES.map((gate) => ({ ...gate, blockers: [] })),
  };
};

const lazySpec: AppSpec = {
  version: 1,
  app: {
    name: 'Lazy',
    packageName: 'lazy_app',
    tagline: 'Lazy',
    description: 'A runner that does the minimum.',
    domain: 'custom',
  },
  audience: { primary: 'nobody' },
  entities: [
    {
      name: 'Thing',
      plural: 'things',
      description: 'A thing.',
      fields: [{ name: 'title', type: 'string', required: true, primary: true }],
    },
  ],
  screens: [
    {
      id: 'settings',
      title: 'Settings',
      route: '/settings',
      kind: 'settings',
      purpose: 'Settings.',
    },
  ],
  flows: [{ id: 'flow', name: 'Flow', steps: [{ screenId: 'settings', action: 'open' }] }],
  design: {
    seedColor: '#6750A4',
    brightness: 'light',
    spacing: [4, 8, 16],
    radii: { sm: 2, md: 4, lg: 8, xl: 12 },
    motionMs: 0,
    shape: 'square',
  },
  requirements: [{ id: 'req', statement: 'It opens.', category: 'functional', verifiedBy: 'score' }],
  backend: 'local',
  seedCount: 0,
};

const lazyRunner: BenchmarkRunner = async () => ({
  spec: lazySpec,
  files: [
    file(
      'lib/features/settings/settings_page.dart',
      `import 'package:flutter/material.dart';

class SettingsPage extends StatelessWidget {
  SettingsPage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold();
  }
}
`,
    ),
  ],
  gates: [{ gate: 'analyze', passed: false, blockers: ['Analyzer found 2 errors'] }],
});

// ── benchmark assertions ───────────────────────────────────────────────────

test('BENCHMARKS contains ten unique, internally coherent cases', () => {
  assert.equal(BENCHMARKS.length, 10);
  assert.equal(new Set(BENCHMARKS.map((benchmark) => benchmark.id)).size, 10);
  assert.equal(new Set(BENCHMARKS.map((benchmark) => benchmark.prompt)).size, 10);

  const requiredPrompts: Record<string, string> = {
    notes: 'Build a notes app with tags, search and pinning',
    habits: 'Habit tracker with streaks and daily check-ins',
    expenses: 'Split expenses with friends and settle balances',
    recipes: 'Recipe box with ingredients, steps and cook time',
    workouts: 'Workout log with exercises, sets and personal records',
    trips: 'Trip planner with itinerary and packing list',
    reading: 'Reading list with ratings and notes',
    crm: 'CRM leads with pipeline stages and follow-ups',
    invoices: 'Invoice manager with line items, tax and status',
    events: 'Event check-in app with guest list and QR badges',
  };

  for (const benchmark of BENCHMARKS) {
    assert.equal(benchmark.prompt, requiredPrompts[benchmark.id], `prompt drift for ${benchmark.id}`);
    const expectation = benchmark.expectation;
    assert.ok(expectation.entities.length >= 1 && expectation.entities.length <= 3, `${benchmark.id}: entity count`);
    assert.equal(new Set(expectation.entities.map(pascal)).size, expectation.entities.length, `${benchmark.id}: duplicate entities`);
    for (const entity of expectation.entities) {
      assert.match(entity, /^[A-Z][A-Za-z0-9]*$/, `${benchmark.id}: entity '${entity}' must be PascalCase`);
    }
    assert.ok(expectation.screenKinds.length > 0, `${benchmark.id}: screen kinds`);
    assert.equal(new Set(expectation.screenKinds).size, expectation.screenKinds.length, `${benchmark.id}: duplicate kinds`);
    for (const kind of expectation.screenKinds) {
      assert.ok(SCREEN_KINDS.includes(kind), `${benchmark.id}: unknown kind '${kind}'`);
    }
    assert.ok((expectation.minScreens ?? 0) >= 4, `${benchmark.id}: minScreens`);
    assert.ok((expectation.screenKinds.length ?? 0) <= (expectation.minScreens ?? 0) + 2, `${benchmark.id}: kind/screen mismatch`);
    assert.ok((expectation.mustInclude ?? []).length >= 2, `${benchmark.id}: needs capability markers`);
    for (const marker of expectation.mustInclude ?? []) {
      assert.ok(marker.length > 0, `${benchmark.id}: empty marker`);
      assert.equal(marker, marker.toLowerCase(), `${benchmark.id}: marker '${marker}' must be lowercase`);
    }
    const expectedWeight = benchmark.id === 'notes' || benchmark.id === 'expenses' ? 1.5 : 1;
    assert.equal(benchmark.weight, expectedWeight, `${benchmark.id}: weight`);
  }
});

test('perfect fake runner passes 10/10 with meanQuality at the top bar', async () => {
  const report = await runBenchmarkSuite(perfectRunner, { now: () => FIXED_NOW });
  const detail = report.cases.map((result) => `${result.caseId}: ${result.failures.join(' | ')}`).join('\n');
  assert.equal(report.total, 10);
  assert.equal(report.passed, 10, detail);
  assert.equal(report.failed, 0);
  assert.ok(report.meanQuality >= 90, `expected meanQuality >= 90, got ${report.meanQuality}`);
  assert.equal(report.generatedAt, FIXED_NOW);
  for (const result of report.cases) {
    assert.equal(result.passed, true, `${result.caseId}: ${result.failures.join(' | ')}`);
    assert.ok(result.quality.total >= 70, `${result.caseId}: ${result.quality.total}`);
    assert.ok(result.quality.grade === 'A' || result.quality.grade === 'B');
    assert.ok(result.gates.every((gate) => gate.passed));
    assert.ok(result.quality.stats.files > 0);
    assert.ok(result.quality.stats.tests > 0);
    assert.equal(result.durationMs, 0);
  }
});

test('lazy runner fails every case with accurate messages', async () => {
  const report: BenchmarkSuiteReport = await runBenchmarkSuite(lazyRunner, { now: () => FIXED_NOW });
  assert.equal(report.total, 10);
  assert.equal(report.passed, 0);
  assert.equal(report.failed, 10);
  assert.ok(report.meanQuality < 70, `lazy runner must score below the bar, got ${report.meanQuality}`);

  const notes = report.cases.find((result) => result.caseId === 'notes');
  assert.ok(notes);
  assert.equal(notes.passed, false);
  const failures = notes.failures.join('\n');
  assert.match(failures, /missing entity 'Note'/);
  assert.match(failures, /missing entity 'Tag'/);
  assert.match(failures, /missing screen kind 'list'/);
  assert.match(failures, /missing screen kind 'detail'/);
  assert.match(failures, /expected at least 4 screens, got 1/);
  assert.match(failures, /missing marker 'search'/);
  assert.match(failures, /gate 'analyze' failed: Analyzer found 2 errors/);
  assert.match(failures, /quality \d+ is below the 70 minimum/);
  for (const result of report.cases) {
    assert.equal(result.passed, false);
    assert.ok(result.failures.length >= 4, `${result.caseId}: expected several failures`);
  }
});

test('runBenchmarkSuite is deterministic for a fixed clock and runner', async () => {
  const first = await runBenchmarkSuite(perfectRunner, { now: () => FIXED_NOW });
  const second = await runBenchmarkSuite(perfectRunner, { now: () => FIXED_NOW });
  assert.deepEqual(first, second);
});

test('runBenchmarkSuite confines execution to the requested subset', async () => {
  const cases = BENCHMARKS.filter((benchmark) => benchmark.id === 'notes' || benchmark.id === 'events');
  const report = await runBenchmarkSuite(perfectRunner, { cases, now: () => FIXED_NOW });
  assert.equal(report.total, 2);
  assert.deepEqual(report.cases.map((result) => result.caseId), ['notes', 'events']);
});

