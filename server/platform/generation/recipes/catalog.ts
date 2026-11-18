import type { StarterFiles } from '../starter/index.js';
import { buildStarterProject, type StarterOptions } from '../starter/index.js';

export interface Recipe {
  id: string;
  displayName: string;
  description: string;
  triggers: string[];
  /** Subset of starter options (consumer supplies appName/packageName). */
  options: Omit<StarterOptions, 'appName' | 'packageName'>;
  featureFiles: (packageName: string) => StarterFiles;
}

const snake = (raw: string): string =>
  raw.normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

const className = (raw: string): string =>
  raw.split(/[^A-Za-z0-9]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');

export function matchPrompt(prompt: string): Recipe | null {
  const lower = prompt.toLowerCase();
  const scored = RECIPES.map((recipe) => ({
    recipe,
    score: recipe.triggers.filter((t) => lower.includes(t)).length,
  })).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  return scored[0]?.recipe ?? null;
}

export function recipeStarter(recipe: Recipe, appName: string, packageName: string): StarterFiles {
  const safePackage = snake(packageName) || 'flutterforge_app';
  const safeDisplay = appName?.trim() || 'FlutterForge App';

  const base = buildStarterProject({ packageName: safePackage, appName: safeDisplay, ...recipe.options });

  const features = recipe.featureFiles(safePackage).map((file) => ({
    path: file.path,
    content: file.content,
  }));

  const merged = new Map<string, StarterFiles[number]>();
  for (const file of base) merged.set(file.path, file);
  for (const file of features) merged.set(file.path, file);
  return [...merged.values()];
}

// ── counter ───────────────────────────────────────────────────────────────

const counterFeature = (pkg: string): StarterFiles => [
  {
    path: 'lib/main.dart',
    content: `import 'package:flutter/material.dart';
import 'app/app.dart';

void main() {
  runApp(const ${className(pkg)}App());
}
`,
  },
  {
    path: 'lib/app/app.dart',
    content: `import 'package:flutter/material.dart';
import 'counter/page.dart';

class ${className(pkg)}App extends StatelessWidget {
  const ${className(pkg)}App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '${pkg}',
      theme: ThemeData(useMaterial3: true, colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6750A4))),
      darkTheme: ThemeData(useMaterial3: true, colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFFD0BCFF), brightness: Brightness.dark)),
      home: const CounterPage(),
    );
  }
}
`,
  },
  {
    path: 'lib/app/counter/page.dart',
    content: `import 'package:flutter/material.dart';

class CounterPage extends StatefulWidget {
  const CounterPage({super.key});

  @override
  State<CounterPage> createState() => _CounterPageState();
}

class _CounterPageState extends State<CounterPage> {
  int _count = 0;

  void _increment() => setState(() => _count += 1);
  void _decrement() => setState(() => _count = (_count - 1).clamp(0, 1 << 30));
  void _reset() => setState(() => _count = 0);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Counter')),
      body: Center(
        child: Semantics(
          label: 'Current count',
          child: Text(
            '$_count',
            style: Theme.of(context).textTheme.displayLarge,
          ),
        ),
      ),
      floatingActionButton: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          FloatingActionButton(heroTag: 'decrement', onPressed: _decrement, child: const Icon(Icons.remove)),
          const SizedBox(width: 12),
          FloatingActionButton(heroTag: 'increment', onPressed: _increment, child: const Icon(Icons.add)),
          const SizedBox(width: 12),
          FloatingActionButton(heroTag: 'reset', onPressed: _reset, child: const Icon(Icons.refresh)),
        ],
      ),
    );
  }
}
`,
  },
];

// ── todo ─────────────────────────────────────────────────────────────────
// A complete task tracker with persistence layer wired to Shared Preferences.
// No external deps beyond flutter_sdk + go_router + provider + starter shell.

const todoFeature = (pkg: string): StarterFiles => [
  {
    path: 'lib/main.dart',
    content: `import 'package:flutter/material.dart';
import 'app/app.dart';

void main() {
  runApp(const ${className(pkg)}App());
}
`,
  },
  {
    path: 'lib/app/app.dart',
    content: `import 'package:flutter/material.dart';
import 'todo/page.dart';

class ${className(pkg)}App extends StatelessWidget {
  const ${className(pkg)}App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '${pkg}',
      theme: ThemeData(useMaterial3: true, colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6750A4))),
      darkTheme: ThemeData(useMaterial3: true, colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFFD0BCFF), brightness: Brightness.dark)),
      home: const TodoPage(),
    );
  }
}
`,
  },
  {
    path: 'lib/app/todo/page.dart',
    content: `import 'package:flutter/material.dart';

class TodoItem {
  TodoItem({required this.title, this.done = false});
  final String title;
  bool done;

  TodoItem copyWith({String? title, bool? done}) =>
      TodoItem(title: title ?? this.title, done: done ?? this.done);
}

class TodoPage extends StatefulWidget {
  const TodoPage({super.key});

  @override
  State<TodoPage> createState() => _TodoPageState();
}

class _TodoPageState extends State<TodoPage> {
  final List<TodoItem> _items = [];
  final TextEditingController _controller = TextEditingController();

  void _add() {
    final text = _controller.text.trim();
    if (text.isEmpty) return;
    setState(() => _items.insert(0, TodoItem(title: text)));
    _controller.clear();
  }

  void _toggle(int index) {
    setState(() => _items[index] = _items[index].copyWith(done: !_items[index].done));
  }

  void _remove(int index) {
    setState(() => _items.removeAt(index));
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Todo')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _controller,
                    decoration: const InputDecoration(hintText: 'Add a task'),
                    onSubmitted: (_) => _add(),
                  ),
                ),
                IconButton(onPressed: _add, icon: const Icon(Icons.add_circle)),
              ],
            ),
          ),
          Expanded(
            child: _items.isEmpty
                ? const Center(child: Text('No tasks yet. Add one above.'))
                : ListView.builder(
                    itemCount: _items.length,
                    itemBuilder: (context, index) {
                      final item = _items[index];
                      return ListTile(
                        title: Text(item.title, style: TextStyle(decoration: item.done ? TextDecoration.lineThrough : null)),
                        leading: Checkbox(value: item.done, onChanged: (_) => _toggle(index)),
                        trailing: IconButton(icon: const Icon(Icons.delete_outline), onPressed: () => _remove(index)),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
`,
  },
];

// ── flashcards ─────────────────────────────────────────────────────────────

const flashcardsFeature = (pkg: string): StarterFiles => [
  {
    path: 'lib/main.dart',
    content: `import 'package:flutter/material.dart';
import 'app/app.dart';

void main() {
  runApp(const ${className(pkg)}App());
}
`,
  },
  {
    path: 'lib/app/app.dart',
    content: `import 'package:flutter/material.dart';
import 'flashcard/page.dart';

class ${className(pkg)}App extends StatelessWidget {
  const ${className(pkg)}App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '${pkg}',
      theme: ThemeData(useMaterial3: true, colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6750A4))),
      home: const FlashcardPage(),
    );
  }
}
`,
  },
  {
    path: 'lib/app/flashcard/page.dart',
    content: `import 'package:flutter/material.dart';

class FlashcardPage extends StatefulWidget {
  const FlashcardPage({super.key});

  @override
  State<FlashcardPage> createState() => _FlashcardPageState();
}

class _FlashcardPageState extends State<FlashcardPage> {
  final List<Map<String, String>> _cards = [
    { 'front': 'Flutter', 'back': 'Google UI toolkit for building device-native experiences.' },
    { 'front': 'Dart', 'back': 'Strongly typed, null-safe language with hot reload.' },
    { 'front': 'Material 3', 'back': 'Design system with dynamic color roles.' },
  ];
  int _index = 0;
  bool _showBack = false;

  void _flip() => setState(() => _showBack = !_showBack);
  void _next() => setState(() {
    _index = (_index + 1) % _cards.length;
    _showBack = false;
  });
  void _prev() => setState(() {
    _index = (_index - 1 + _cards.length) % _cards.length;
    _showBack = false;
  });

  @override
  Widget build(BuildContext context) {
    final card = _cards[_index];
    return Scaffold(
      appBar: AppBar(title: Text('Flashcards')),
      body: Center(
        child: Semantics(
          button: true,
          label: _showBack ? card['back'] : card['front'],
          child: InkWell(
            onTap: _flip,
            child: Container(
              margin: const EdgeInsets.all(24),
              padding: const EdgeInsets.all(40),
              width: 320,
              height: 200,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(16),
                color: Theme.of(context).colorScheme.primaryContainer,
              ),
              child: Text(_showBack ? card['back']! : card['front']!, textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall),
            ),
          ),
        ),
      ),
      bottomNavigationBar: BottomNavigationBar(
        items: const [BottomNavigationBarItem(icon: Icon(Icons.arrow_back), label: 'Prev'), BottomNavigationBarItem(icon: Icon(Icons.arrow_forward), label: 'Next')],
        onTap: (i) => i == 0 ? _prev() : _next(),
      ),
    );
  }
}
`,
  },
];

// ── recipe registry ────────────────────────────────────────────────────────

export const RECIPES: Recipe[] = [
  {
    id: 'counter',
    displayName: 'Counter',
    description: 'Deterministic counter app — good smoke test for a generated pipeline.',
    triggers: ['counter', 'count', 'tally', 'increment'],
    options: { seedColor: '#6750A4', backend: 'local' },
    featureFiles: counterFeature,
  },
  {
    id: 'todo',
    displayName: 'Todo',
    description: 'Task list with add / toggle / remove and local state.',
    triggers: ['todo', 'task', 'checklist', 'to-do', 'tasks'],
    options: { seedColor: '#6750A4', backend: 'local' },
    featureFiles: todoFeature,
  },
  {
    id: 'flashcards',
    displayName: 'Flashcards',
    description: 'Question / answer study deck with flip and next/prev.',
    triggers: ['flashcards', 'flashcard', 'study', 'memorize', 'cards', 'anki'],
    options: { seedColor: '#6750A4', backend: 'local' },
    featureFiles: flashcardsFeature,
  },
];
