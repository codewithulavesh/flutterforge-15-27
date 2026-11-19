/**
 * Agent Corps — roster, scoring and real-finding tests.
 *
 * Two fixtures are reviewed end to end: a well-architected project that must
 * not fail the board, and a deliberately broken project whose known defects
 * must surface under the expected stable codes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_ROSTER,
  DEPARTMENTS,
  DEPARTMENT_META,
  createReviewContext,
  getAgentDefinition,
  listAgents,
  listAgentsByDepartment,
  reviewFiles,
  runAgentCorps,
} from '../../platform/agents/index.js';
import { createReviewBoardWorkflow } from '../../platform/agents/reviewWorkflow.js';

const PUBSPEC = `name: notes_app
description: A focused notes app with tags and search.
version: 1.2.0+7
environment:
  sdk: ">=3.5.0 <4.0.0"

dependencies:
  flutter:
    sdk: flutter
  cupertino_icons: ^1.0.8

dev_dependencies:
  flutter_test:
    sdk: flutter
`;

const GOOD_FILES: Array<{ path: string; content: string }> = [
  { path: 'pubspec.yaml', content: PUBSPEC },
  { path: 'pubspec.lock', content: 'packages: {}\n' },
  { path: '.gitignore', content: '.dart_tool/\nbuild/\n.env\n' },
  { path: '.env.example', content: 'API_BASE_URL=\n' },
  { path: 'analysis_options.yaml', content: 'include: package:flutter_lints/flutter.yaml\n' },
  { path: '.github/workflows/ci.yml', content: 'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: flutter test\n' },
  { path: 'README.md', content: '# Notes App\n\nA focused notes app with tags, search and pinning. This project is generated and verified end to end. It demonstrates feature-first architecture, immutable models and a repository seam.\n\n## Run\n\n```\nflutter pub get\nflutter run\nflutter test\n```\n' },
  { path: 'LICENSE', content: 'MIT\n' },
  { path: 'CHANGELOG.md', content: '# 1.2.0\n\n- Initial release.\n' },
  { path: 'docs/ARCHITECTURE.md', content: '# Architecture\n\nfeatures → controllers → repositories → models.\n' },
  { path: 'l10n.yaml', content: 'arb-dir: lib/l10n\n' },
  { path: 'web/index.html', content: '<!doctype html><title>Notes</title>\n' },
  {
    path: 'lib/main.dart',
    content: `import 'package:flutter/material.dart';
import 'package:notes_app/app/app.dart';

void main() {
  FlutterError.onError = (details) {
    FlutterError.presentError(details);
  };
  ErrorWidget.builder = (details) => const SizedBox.shrink();
  runApp(const App());
}
`,
  },
  {
    path: 'lib/app/app.dart',
    content: `import 'package:flutter/material.dart';
import 'package:notes_app/app/router.dart';
import 'package:notes_app/app/theme.dart';

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Notes',
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: ThemeMode.system,
      routes: appRoutes,
      initialRoute: '/',
    );
  }
}
`,
  },
  {
    path: 'lib/app/theme.dart',
    content: `import 'package:flutter/material.dart';

ThemeData buildTheme(Brightness brightness) {
  final scheme = ColorScheme.fromSeed(seedColor: const Color(0xFF2563EB), brightness: brightness);
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    textTheme: const TextTheme(),
    cardTheme: const CardTheme(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(12))),
    ),
  );
}
`,
  },
  {
    path: 'lib/app/router.dart',
    content: `import 'package:flutter/material.dart';
import 'package:notes_app/features/detail/detail_page.dart';
import 'package:notes_app/features/home/home_page.dart';

final Map<String, WidgetBuilder> appRoutes = <String, WidgetBuilder>{
  '/': (context) => const HomePage(),
  '/detail': (context) => const DetailPage(),
};
`,
  },
  {
    path: 'lib/features/home/home_page.dart',
    content: `import 'package:flutter/material.dart';
import 'package:notes_app/state/notes_controller.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  final NotesController _controller = NotesController();

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onChanged);
    _controller.load();
  }

  void _onChanged() {
    setState(() {});
  }

  @override
  void dispose() {
    _controller.removeListener(_onChanged);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Notes')),
      body: ListView.builder(
        itemCount: _controller.notes.length,
        itemBuilder: (context, index) => ListTile(title: Text(_controller.notes[index].title)),
      ),
    );
  }
}
`,
  },
  {
    path: 'lib/features/detail/detail_page.dart',
    content: `import 'package:flutter/material.dart';

class DetailPage extends StatelessWidget {
  const DetailPage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Detail')),
      body: FutureBuilder<String>(
        future: Future<String>.value('note'),
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: Text('loading'));
          }
          if (snapshot.hasError) {
            return const Center(child: Text('error'));
          }
          final data = snapshot.data;
          if (data == null) {
            return const Center(child: Text('empty'));
          }
          return Center(child: Text(data));
        },
      ),
    );
  }
}
`,
  },
  {
    path: 'lib/data/models/note.dart',
    content: `class Note {
  const Note({required this.id, required this.title});

  final String id;
  final String title;

  Note copyWith({String? title}) => Note(id: id, title: title ?? this.title);

  Map<String, dynamic> toJson() => <String, dynamic>{'id': id, 'title': title};

  factory Note.fromJson(Map<String, dynamic> json) => Note(
        id: json['id'] as String,
        title: json['title'] as String,
      );
}
`,
  },
  {
    path: 'lib/data/repositories/note_repository.dart',
    content: `import 'package:notes_app/data/models/note.dart';

abstract class NoteRepository {
  Future<List<Note>> list();
  Future<Note> save(Note note);
}

class InMemoryNoteRepository implements NoteRepository {
  final List<Note> _notes = <Note>[];

  @override
  Future<List<Note>> list() async => List<Note>.unmodifiable(_notes);

  @override
  Future<Note> save(Note note) async {
    _notes.add(note);
    return note;
  }
}
`,
  },
  {
    path: 'lib/state/notes_controller.dart',
    content: `import 'package:flutter/foundation.dart';
import 'package:notes_app/data/models/note.dart';
import 'package:notes_app/data/repositories/note_repository.dart';

class NotesController extends ChangeNotifier {
  NotesController({NoteRepository? repository}) : _repository = repository ?? InMemoryNoteRepository();

  final NoteRepository _repository;
  final List<Note> _notes = <Note>[];
  bool isLoading = false;
  String? error;

  List<Note> get notes => List<Note>.unmodifiable(_notes);

  Future<void> load() async {
    isLoading = true;
    notifyListeners();
    try {
      final loaded = await _repository.list();
      _notes
        ..clear()
        ..addAll(loaded);
      error = null;
    } catch (cause) {
      error = cause.toString();
    } finally {
      isLoading = false;
      notifyListeners();
    }
  }
}
`,
  },
  {
    path: 'lib/observability/logger.dart',
    content: `import 'dart:developer' as developer;

class AppLogger {
  const AppLogger(this.name);

  final String name;

  void info(String message) => developer.log(message, name: name);
}
`,
  },
  {
    path: 'test/app/app_smoke_test.dart',
    content: `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:notes_app/app/app.dart';

void main() {
  testWidgets('renders the app shell', (tester) async {
    await tester.pumpWidget(const App());
    expect(find.byType(MaterialApp), findsOneWidget);
  });
}
`,
  },
  {
    path: 'test/data/note_test.dart',
    content: `import 'package:flutter_test/flutter_test.dart';
import 'package:notes_app/data/models/note.dart';

void main() {
  test('round-trips json', () {
    const note = Note(id: '1', title: 'A');
    final restored = Note.fromJson(note.toJson());
    expect(restored.title, note.title);
  });
}
`,
  },
  {
    path: 'test/state/notes_controller_test.dart',
    content: `import 'package:flutter_test/flutter_test.dart';
import 'package:notes_app/state/notes_controller.dart';

void main() {
  test('loads notes', () async {
    final controller = NotesController();
    await controller.load();
    expect(controller.notes, isNotNull);
  });
}
`,
  },
];

const BAD_PUBSPEC = `name: bad_app
description: Broken sample.
version: 1.0.0
environment:
  sdk: ">=3.5.0 <4.0.0"

dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.0
  supabase_flutter: ^2.5.0
`;

const BAD_FILES: Array<{ path: string; content: string }> = [
  { path: 'pubspec.yaml', content: BAD_PUBSPEC },
  {
    path: 'lib/main.dart',
    content: `import 'package:flutter/material.dart';

void main() {
  print('boot');
  runApp(const SizedBox());
}
`,
  },
  {
    path: 'lib/features/home/home_page.dart',
    content: `import 'package:flutter/material.dart';
import 'package:bad_app/data/repositories/note_repository.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  Future<void> load() async {
    await Future<void>.delayed(const Duration(seconds: 1));
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final repository = NoteRepository();
    repository.list();
    return ListView(children: const <Widget>[Text('http://example.com')]);
  }
}
`,
  },
  {
    path: 'lib/features/home/secrets.dart',
    content: `const String apiKey = 'sk-abcdefghijklmnopqrstuvwx1234';
`,
  },
  {
    path: 'lib/data/repositories/note_repository.dart',
    content: `class NoteRepository {
  Future<List<String>> list() async => <String>[];
}
`,
  },
  {
    path: 'lib/state/leak.dart',
    content: `import 'package:flutter/foundation.dart';

class Leak {
  final ValueNotifier<int> count = ValueNotifier<int>(0);

  void attach(VoidCallback listener) {
    count.addListener(listener);
  }
}
`,
  },
  {
    path: 'supabase/migrations/001_init.sql',
    content: `create table notes (id uuid primary key, user_id uuid);
create table tags (id uuid primary key, note_id uuid);
drop table old_notes;
`,
  },
];

test('roster is a complete twenty-agent organisation', () => {
  assert.equal(AGENT_ROSTER.length, 20);
  assert.equal(new Set(AGENT_ROSTER.map((agent) => agent.id)).size, 20);
  assert.deepEqual(listAgents().length, 20);
  for (const department of DEPARTMENTS) {
    assert.ok(
      listAgentsByDepartment().find((entry) => entry.department === department)!.agents.length > 0,
      `department ${department} has no agents`,
    );
  }
  const weight = DEPARTMENTS.reduce((sum, department) => sum + DEPARTMENT_META[department].weight, 0);
  assert.equal(weight, 100);
  assert.ok(getAgentDefinition('security-auditor'));
  assert.equal(getAgentDefinition('does-not-exist'), undefined);
});

test('well-architected project has no blockers and a passing board', async () => {
  const scorecard = await reviewFiles({
    projectId: 'good',
    files: GOOD_FILES,
    now: 1_700_000_000_000,
  });

  assert.equal(scorecard.stats.agents, 20);
  assert.equal(scorecard.stats.blockers, 0, JSON.stringify(scorecard.blockers, null, 2));
  assert.notEqual(scorecard.verdict, 'fail');
  assert.ok(scorecard.overallScore >= 80, `expected a high score, got ${scorecard.overallScore}`);
  assert.equal(scorecard.departments.length, 6);
  for (const report of scorecard.reports) {
    assert.ok(report.score >= 0 && report.score <= 100, `${report.agentId} score ${report.score}`);
  }
});

test('broken project surfaces the expected blocker codes', async () => {
  const scorecard = await reviewFiles({ projectId: 'bad', files: BAD_FILES, now: 1_700_000_000_000 });
  const codes = new Set(scorecard.blockers.map((finding) => finding.code));

  assert.equal(scorecard.verdict, 'fail');
  for (const expected of [
    'DESIGN_NO_THEME',
    'TEST_NONE',
    'DB_RLS_MISSING',
    'SEC_HARDCODED_SECRET',
    'STATE_SETSTATE_AFTER_AWAIT',
    'ARCH_PAGE_REACHES_REPOSITORY',
  ]) {
    assert.ok(codes.has(expected), `missing blocker ${expected}; got ${[...codes].join(', ')}`);
  }

  const allCodes = new Set(scorecard.reports.flatMap((report) => report.findings.map((finding) => finding.code)));
  for (const expected of [
    'DB_DESTRUCTIVE_MIGRATION',
    'BACKEND_NO_CONTRACT',
    'STATE_LISTENER_LEAK',
    'DOCS_NO_README',
    'DEVOPS_NO_CI',
    'SEC_INSECURE_TRANSPORT',
    'PERF_EAGER_LIST',
  ]) {
    assert.ok(allCodes.has(expected), `missing finding ${expected}`);
  }

  // Secrets must never be echoed verbatim into a report.
  for (const report of scorecard.reports) {
    for (const finding of report.findings) {
      assert.ok(!finding.evidence?.includes('sk-abcdefghijklmnopqrstuvwx1234'), 'raw secret leaked into evidence');
    }
  }
});

test('board can be narrowed to selected agents', async () => {
  const scorecard = await reviewFiles(
    { projectId: 'bad', files: BAD_FILES, now: 1_700_000_000_000 },
    { agentIds: ['security-auditor'] },
  );
  assert.equal(scorecard.stats.agents, 1);
  assert.equal(scorecard.reports[0].agentId, 'security-auditor');
  assert.equal(scorecard.departments.length, 1);
  assert.ok(scorecard.stats.blockers >= 1);
  await assert.rejects(() =>
    runAgentCorps(createReviewContext({ projectId: 'bad', files: BAD_FILES }), { agentIds: ['nope'] }),
  );
});

test('scoring is deterministic for the same snapshot', async () => {
  const first = await reviewFiles({ projectId: 'bad', files: BAD_FILES, now: 1 });
  const second = await reviewFiles({ projectId: 'bad', files: BAD_FILES, now: 1 });
  assert.equal(first.overallScore, second.overallScore);
  assert.equal(first.verdict, second.verdict);
  assert.deepEqual(first.findingCounts, second.findingCounts);
  assert.deepEqual(
    first.reports.map((report) => [report.agentId, report.score, report.findings.map((finding) => finding.code)]),
    second.reports.map((report) => [report.agentId, report.score, report.findings.map((finding) => finding.code)]),
  );
});

test('review.board workflow is a durable snapshot → review → gate DAG', () => {
  const definition = createReviewBoardWorkflow();
  assert.equal(definition.name, 'review.board');
  assert.deepEqual(definition.steps.map((step) => step.id), ['snapshot', 'review', 'gate']);
  assert.deepEqual(definition.steps[1].dependsOn, ['snapshot']);
  assert.deepEqual(definition.steps[2].dependsOn, ['review']);
});

test('screen-named screens count as pages and declared packages are not flagged', async () => {
  const files = [
    {
      path: 'pubspec.yaml',
      content: `name: demo
environment:
  sdk: ">=3.5.0 <4.0.0"

dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.0
`,
    },
    {
      path: 'lib/main.dart',
      content: `import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

void main() {
  http.get(Uri.parse('https://example.com'));
  runApp(const MaterialApp(home: HomeScreen()));
}
`,
    },
    {
      path: 'lib/features/home/screens/home_screen.dart',
      content: `import 'package:flutter/material.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) => const Scaffold(body: Text('home'));
}
`,
    },
  ];
  const scorecard = await reviewFiles({ projectId: 'naming', files });
  const codes = scorecard.reports.flatMap((report) => report.findings.map((finding) => finding.code));
  assert.ok(!codes.includes('PRODUCT_NO_SCREENS'), 'a *_screen.dart file must count as a page');
  assert.ok(!codes.includes('UX_NO_PAGES'), 'a *_screen.dart file must count as a page');
  assert.ok(!codes.includes('DART_SELF_PACKAGE_MISMATCH'), 'declared packages must not be treated as mismatches');
});

test('createReviewContext derives the package name and sorts files', () => {
  const context = createReviewContext({ projectId: 'x', files: [...GOOD_FILES].reverse(), now: 5 });
  assert.equal(context.packageName, 'notes_app');
  assert.equal(context.now, 5);
  const paths = context.files.map((file) => file.path);
  assert.deepEqual(paths, [...paths].sort((a, b) => a.localeCompare(b)));
  const again = createReviewContext({ projectId: 'x', files: [...GOOD_FILES].reverse(), now: 5 });
  assert.deepEqual(again.files.map((file) => file.path), paths);
});
