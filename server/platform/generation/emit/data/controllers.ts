/**
 * Dart controller emitter.
 *
 * Controllers are intentionally dependency-free `ChangeNotifier`s: widgets
 * listen with `ListenableBuilder`, repository failures land in `error` and
 * never escape into the widget tree, and a disposed controller can be raced by
 * an in-flight load without throwing.
 */
import type { AppSpec, EntitySpec, FieldSpec, GeneratedFile } from '../../contracts.js';
import {
  controllerClass,
  controllerFile,
  dartString,
  dartType,
  entityClass,
  pluralize,
  primaryField,
  repositoryClass,
  snake,
} from '../shared.js';
import { sampleLiteral } from './seed.js';

export function controllerTestFile(entity: EntitySpec): string {
  return `test/data/${snake(entity.name)}_controller_test.dart`;
}

function isStringish(field: FieldSpec): boolean {
  return field.type === 'string' || field.type === 'text' || field.type === 'enum';
}

function searchableFields(entity: EntitySpec): FieldSpec[] {
  const primary = primaryField(entity);
  const fields: FieldSpec[] = [];
  const seen = new Set<string>();
  for (const field of entity.fields) {
    const primaryIsText = primary?.name === field.name && dartType(field) === 'String';
    if (!isStringish(field) && !primaryIsText) continue;
    if (seen.has(field.name)) continue;
    seen.add(field.name);
    fields.push(field);
  }
  return fields;
}

/** `lib/state/<entity>_controller.dart`. */
export function emitController(entity: EntitySpec): GeneratedFile {
  const cls = entityClass(entity);
  const controller = controllerClass(entity);
  const searchFields = searchableFields(entity);
  const haystack = searchFields.map((field) => `          item.${field.name},`).join('\n');

  const content = `import 'package:flutter/foundation.dart' show ChangeNotifier;

import '../data/models/${snake(entity.name)}.dart';
import '../data/repositories/${snake(entity.name)}_repository.dart';

/// State holder for [${cls}] records.
///
/// Widgets listen for changes and read [items], [isLoading] and [error].
/// Repository failures are captured in [error] instead of being rethrown.
class ${controller} extends ChangeNotifier {
  ${controller}(this._repository);

  final ${entityClass(entity)}Repository _repository;
  final List<${cls}> _items = <${cls}>[];
  bool _isLoading = false;
  String? _error;
  bool _disposed = false;

  /// Current records, in display order.
  List<${cls}> get items => List<${cls}>.unmodifiable(_items);

  /// True while a repository read is in flight.
  bool get isLoading => _isLoading;

  /// Last failure message, or null when the last operation succeeded.
  String? get error => _error;

  /// Loads every record from the repository.
  Future<void> load() async {
    if (_disposed) return;
    _isLoading = true;
    _error = null;
    _notify();
    try {
      final List<${cls}> loaded = await _repository.list();
      if (_disposed) return;
      _items
        ..clear()
        ..addAll(loaded);
    } catch (error) {
      if (_disposed) return;
      _error = _describeError(error);
    } finally {
      if (!_disposed) {
        _isLoading = false;
        _notify();
      }
    }
  }

  /// Creates [draft] and prepends the stored record.
  ///
  /// Returns null and sets [error] when the repository fails.
  Future<${cls}?> create(${cls} draft) async {
    if (_disposed) return null;
    _error = null;
    try {
      final ${cls} created = await _repository.create(draft);
      if (_disposed) return null;
      _items.insert(0, created);
      _notify();
      return created;
    } catch (error) {
      if (_disposed) return null;
      _error = _describeError(error);
      _notify();
      return null;
    }
  }

  /// Replaces [item] in the list after the repository accepts it.
  Future<void> update(${cls} item) async {
    if (_disposed) return;
    _error = null;
    try {
      final ${cls} stored = await _repository.update(item);
      if (_disposed) return;
      final int index = _items.indexWhere((${cls} existing) => existing.id == stored.id);
      if (index == -1) {
        _items.insert(0, stored);
      } else {
        _items[index] = stored;
      }
      _notify();
    } catch (error) {
      if (_disposed) return;
      _error = _describeError(error);
      _notify();
    }
  }

  /// Deletes [id] from the repository and the local list.
  Future<void> remove(String id) async {
    if (_disposed) return;
    _error = null;
    try {
      await _repository.delete(id);
      if (_disposed) return;
      _items.removeWhere((${cls} item) => item.id == id);
      _notify();
    } catch (error) {
      if (_disposed) return;
      _error = _describeError(error);
      _notify();
    }
  }

  /// Case-insensitive search across the primary, string, text and enum fields.
  List<${cls}> search(String query) {
    final String needle = query.trim().toLowerCase();
    if (needle.isEmpty) return items;
    return List<${cls}>.unmodifiable(
      _items.where((${cls} item) {
        final List<String?> haystack = <String?>[
${haystack}
        ];
        return haystack.whereType<String>().any((String value) => value.toLowerCase().contains(needle));
      }),
    );
  }

  /// Clears the last error without touching the loaded items.
  void clearError() {
    if (_error == null) return;
    _error = null;
    _notify();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }

  String _describeError(Object error) {
    final String message = error.toString().trim();
    return message.isEmpty ? 'Unexpected error.' : message;
  }

  void _notify() {
    if (_disposed) return;
    notifyListeners();
  }
}
`;

  return { path: controllerFile(entity), content, layer: 'data' };
}

/** `test/data/<entity>_controller_test.dart` — load, CRUD, search, failures. */
export function emitControllerTest(spec: AppSpec, entity: EntitySpec): GeneratedFile {
  const cls = entityClass(entity);
  const controller = controllerClass(entity);
  const repo = repositoryClass(entity);
  const memoryRepo = `InMemory${repo}`;
  const seedFn = `seed${pluralize(entity.name)}`;
  const ctx = { spec, entity, index: 0 };
  const draftId = `${snake(entity.name)}_draft`;

  const jsonLines: string[] = [`    'id': ${dartString(draftId)},`];
  for (const field of entity.fields) {
    const sample = sampleLiteral(field, ctx);
    jsonLines.push(`    ${dartString(field.name)}: ${sample.json},`);
  }

  const searchFields = searchableFields(entity);
  const searchField =
    searchFields.find((field) => field.primary) ??
    searchFields.find((field) => field.required) ??
    searchFields[0];
  const searchToken =
    searchField === undefined
      ? ''
      : searchField.type === 'enum'
        ? (searchField.values ?? [])[0] ?? ''
        : 'Zephyr checkpoint';
  const searchQuery = searchToken.toUpperCase();

  const mutableField = entity.fields.find((field) => field.type === 'string' || field.type === 'text');

  const searchTest =
    searchField === undefined
      ? `    test('search returns an empty list when the entity has no text fields', () {
      final ${controller} controller = ${controller}(
        ${memoryRepo}(${seedFn}()),
      );
      addTearDown(controller.dispose);

      expect(controller.search('anything'), isEmpty);
    });
`
      : `    test('search matches text fields case-insensitively', () async {
      final ${controller} controller = ${controller}(
        ${memoryRepo}(${seedFn}()),
      );
      addTearDown(controller.dispose);
      await controller.load();

      final ${cls}? maybeCreated = await controller.create(
        _draft().copyWith(
          id: ${dartString(`${snake(entity.name)}_search`)},
          ${searchField.name}: ${dartString(searchToken)},
        ),
      );
      expect(maybeCreated, isNotNull);
      final ${cls} created = maybeCreated!;

      final List<${cls}> matches = controller.search(${dartString(searchQuery)});
      expect(matches.map((${cls} item) => item.id), contains(created.id));
      expect(controller.search('   '), hasLength(controller.items.length));
    });
`;

  const syncTest =
    mutableField === undefined
      ? `      await controller.update(created);
      expect(controller.error, isNull);
      expect(controller.items.first.id, created.id);`
      : `      final ${cls} updated = created.copyWith(${mutableField.name}: 'Refined checkpoint');
      await controller.update(updated);
      expect(controller.error, isNull);
      expect(controller.items.first.${mutableField.name}, 'Refined checkpoint');`;

  const content = `import 'package:flutter_test/flutter_test.dart';

import 'package:${spec.app.packageName}/data/models/${snake(entity.name)}.dart';
import 'package:${spec.app.packageName}/data/repositories/${snake(entity.name)}_repository.dart';
import 'package:${spec.app.packageName}/data/seed/${snake(entity.name)}_seed.dart';
import 'package:${spec.app.packageName}/state/${snake(entity.name)}_controller.dart';

class _Failing${cls}Repository implements ${repo} {
  @override
  Future<List<${cls}>> list() async => throw StateError('storage unavailable');

  @override
  Future<${cls}> create(${cls} draft) async => throw StateError('storage unavailable');

  @override
  Future<${cls}> update(${cls} item) async => throw StateError('storage unavailable');

  @override
  Future<void> delete(String id) async => throw StateError('storage unavailable');
}

${cls} _draft() {
  return ${cls}.fromJson(<String, Object?>{
${jsonLines.join('\n')}
  });
}

void main() {
  group('${controller}', () {
    test('load publishes seeded rows and clears the loading flag', () async {
      final ${controller} controller = ${controller}(
        ${memoryRepo}(${seedFn}()),
      );
      addTearDown(controller.dispose);

      final Future<void> pending = controller.load();
      expect(controller.isLoading, isTrue);
      await pending;

      expect(controller.isLoading, isFalse);
      expect(controller.error, isNull);
      expect(controller.items.length, ${seedFn}().length);
      expect(() => controller.items.add(_draft()), throwsUnsupportedError);
    });

    test('create, update and remove keep the list in sync', () async {
      final ${controller} controller = ${controller}(
        ${memoryRepo}(${seedFn}()),
      );
      addTearDown(controller.dispose);
      await controller.load();

      final int initialCount = controller.items.length;
      final ${cls}? maybeCreated = await controller.create(_draft().copyWith(id: ''));
      expect(maybeCreated, isNotNull);
      final ${cls} created = maybeCreated!;
      expect(created.id, isNotEmpty);
      expect(controller.error, isNull);
      expect(controller.items.length, initialCount + 1);
      expect(controller.items.first.id, created.id);

${syncTest}

      await controller.remove(created.id);
      expect(controller.error, isNull);
      expect(controller.items.length, initialCount);
      expect(controller.items.any((${cls} item) => item.id == created.id), isFalse);
    });

${searchTest}
    test('repository failures become error state instead of thrown exceptions', () async {
      final ${controller} controller = ${controller}(_Failing${cls}Repository());
      addTearDown(controller.dispose);

      await controller.load();
      expect(controller.isLoading, isFalse);
      expect(controller.error, isNotNull);

      controller.clearError();
      expect(controller.error, isNull);

      final ${cls}? created = await controller.create(_draft());
      expect(created, isNull);
      expect(controller.error, isNotNull);

      controller.clearError();
      await controller.update(_draft());
      expect(controller.error, isNotNull);

      controller.clearError();
      await controller.remove('missing');
      expect(controller.error, isNotNull);
    });

    test('a disposed controller ignores late work', () async {
      final ${controller} controller = ${controller}(
        ${memoryRepo}(${seedFn}()),
      );
      controller.dispose();

      await controller.load();
      expect(controller.isLoading, isFalse);
    });
  });
}
`;

  return { path: controllerTestFile(entity), content, layer: 'test' };
}
