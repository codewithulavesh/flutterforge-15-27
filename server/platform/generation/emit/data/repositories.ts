/**
 * Dart repository emitter.
 *
 * Every entity gets an abstract seam plus an honest async in-memory
 * implementation, so the app layer can swap persistence without touching
 * widgets or controllers. CRUD semantics are part of the generated contract.
 */
import type { EntitySpec, GeneratedFile } from '../../contracts.js';
import { entityClass, repositoryClass, repositoryFile, snake } from '../shared.js';

/** `lib/data/repositories/<entity>_repository.dart`. */
export function emitRepository(entity: EntitySpec): GeneratedFile {
  const cls = entityClass(entity);
  const repo = repositoryClass(entity);
  const memory = `InMemory${repo}`;
  const modelPath = `../models/${snake(entity.name)}.dart`;

  const content = `import '${modelPath}';

/// Persistence contract for [${cls}] records.
abstract class ${repo} {
  /// Returns every record in display order.
  Future<List<${cls}>> list();

  /// Stores [draft] and returns the stored copy.
  ///
  /// When [draft] has an empty id the repository assigns one.
  Future<${cls}> create(${cls} draft);

  /// Replaces the record with the same id and returns the stored copy.
  ///
  /// Throws a [StateError] when no record has that id.
  Future<${cls}> update(${cls} item);

  /// Removes the record with [id]; an absent id is not an error.
  Future<void> delete(String id);
}

/// Async in-memory implementation used by local builds and tests.
class ${memory} implements ${repo} {
  ${memory}([List<${cls}>? seed]) : _items = <${cls}>[...?seed];

  final List<${cls}> _items;

  @override
  Future<List<${cls}>> list() async {
    await Future<void>.delayed(Duration.zero);
    return List<${cls}>.unmodifiable(_items);
  }

  @override
  Future<${cls}> create(${cls} draft) async {
    await Future<void>.delayed(Duration.zero);
    final ${cls} stored = draft.id.isEmpty
        ? draft.copyWith(id: DateTime.now().microsecondsSinceEpoch.toString())
        : draft;
    _items.insert(0, stored);
    return stored;
  }

  @override
  Future<${cls}> update(${cls} item) async {
    await Future<void>.delayed(Duration.zero);
    final int index = _items.indexWhere((${cls} existing) => existing.id == item.id);
    if (index == -1) {
      throw StateError('${cls} not found: \${item.id}');
    }
    _items[index] = item;
    return item;
  }

  @override
  Future<void> delete(String id) async {
    await Future<void>.delayed(Duration.zero);
    _items.removeWhere((${cls} existing) => existing.id == id);
  }
}
`;

  return { path: repositoryFile(entity), content, layer: 'data' };
}
