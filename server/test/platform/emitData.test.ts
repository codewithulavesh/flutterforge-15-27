import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppDomain, AppSpec, EntitySpec, FieldSpec, FieldType } from '../../platform/generation/contracts.js';
import { emitDataLayer } from '../../platform/generation/emit/data/index.js';
import {
  controllerFile,
  dartType,
  entityClass,
  modelFile,
  pluralize,
  repositoryFile,
  seedFile,
  snake,
} from '../../platform/generation/emit/shared.js';

// ── fixtures ──────────────────────────────────────────────────────────────

function field(name: string, type: FieldType, required = false, extra: Partial<FieldSpec> = {}): FieldSpec {
  return { name, type, required, ...extra };
}

function entity(name: string, plural: string, fields: FieldSpec[], extra: Partial<EntitySpec> = {}): EntitySpec {
  return { name, plural, description: `${name} records for the app.`, fields, ...extra };
}

function makeSpec(entities: EntitySpec[], seedCount = 3, domain: AppDomain = 'productivity'): AppSpec {
  const first = entities[0]?.name;
  return {
    version: 1,
    app: {
      name: 'Field Notes',
      packageName: 'field_notes',
      tagline: 'Capture the work that matters.',
      description: 'A small app for keeping notes, projects and reference material in one place.',
      domain,
    },
    audience: { primary: 'Small product teams', secondary: 'Independent makers' },
    entities,
    screens: [
      { id: 'dashboard', title: 'Dashboard', route: '/', kind: 'dashboard', purpose: 'Overview', inNavigation: true },
      { id: 'browse', title: 'Browse', route: '/browse', kind: 'list', purpose: 'Browse records', entity: first, inNavigation: true },
    ],
    flows: [{ id: 'browse', name: 'Browse records', steps: [{ screenId: 'browse', action: 'open' }] }],
    design: {
      seedColor: '#2F6F5F',
      brightness: 'light',
      spacing: [4, 8, 12, 16, 24, 32],
      radii: { sm: 8, md: 12, lg: 16, xl: 24 },
      motionMs: 200,
      shape: 'rounded',
    },
    requirements: [
      { id: 'data-tests', statement: 'The data layer is covered by Dart tests.', category: 'data', verifiedBy: 'test' },
    ],
    backend: 'local',
    seedCount,
  };
}

const singleSpec = makeSpec(
  [
    entity('Note', 'notes', [
      field('title', 'string', true, { primary: true, label: 'Title' }),
      field('body', 'text', false, { label: 'Body' }),
      field('archived', 'bool', true, { label: 'Archived' }),
    ]),
  ],
  3,
);

const multiSpec = makeSpec(
  [
    entity('Project', 'projects', [
      field('name', 'string', true, { primary: true, label: 'Project name' }),
      field('status', 'enum', true, { values: ['planned', 'active', 'done'], label: 'Status' }),
      field('budget', 'double', false, { label: 'Budget' }),
    ]),
    entity('Task', 'tasks', [
      field('title', 'string', true, { primary: true, label: 'Task title' }),
      field('done', 'bool', true, { label: 'Done' }),
      field('projectId', 'relation', true, { target: 'Project', label: 'Project' }),
    ]),
    entity('Label', 'labels', [
      field('name', 'string', true, { primary: true, label: 'Label name' }),
      field('color', 'string', false, { label: 'Color' }),
    ]),
  ],
  4,
  'productivity',
);

const allTypesSpec = makeSpec(
  [
    entity('Collection', 'collections', [
      field('name', 'string', true, { primary: true, label: 'Collection name' }),
      field('notes', 'text', false, { label: 'Notes' }),
    ]),
    entity('Recipe', 'recipes', [
      field('title', 'string', true, { primary: true, label: 'Recipe title' }),
      field('summary', 'text', false, { label: 'Summary' }),
      field('servings', 'int', true, { label: 'Servings' }),
      field('rating', 'double', false, { label: 'Rating' }),
      field('published', 'bool', true, { label: 'Published' }),
      field('createdAt', 'datetime', true, { label: 'Created at' }),
      field('difficulty', 'enum', true, { values: ['easy', 'medium', "chef's $special"], label: 'Difficulty' }),
      field('steps', 'stringList', true, { label: 'Steps' }),
      field('ingredients', 'stringList', false, { label: 'Ingredients' }),
      field('collectionId', 'relation', true, { target: 'Collection', label: 'Collection' }),
      field('owner', 'string', false, { label: "Owner's $tip" }),
    ]),
  ],
  5,
  'education',
);

const specs: Array<{ label: string; spec: AppSpec }> = [
  { label: 'single entity', spec: singleSpec },
  { label: 'three entities', spec: multiSpec },
  { label: 'all field types', spec: allTypesSpec },
];

interface EmittedEntity {
  spec: AppSpec;
  entity: EntitySpec;
  files: ReturnType<typeof emitDataLayer>;
  model: string;
  seed: string;
  repository: string;
  controller: string;
  modelTest: string;
  controllerTest: string;
}

function entriesFor(spec: AppSpec): EmittedEntity[] {
  const files = emitDataLayer({ spec });
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  return spec.entities.map((entity) => {
    const model = byPath.get(modelFile(entity));
    const seed = byPath.get(seedFile(entity));
    const repository = byPath.get(repositoryFile(entity));
    const controller = byPath.get(controllerFile(entity));
    const modelTest = byPath.get(`test/data/${snake(entity.name)}_model_test.dart`);
    const controllerTest = byPath.get(`test/data/${snake(entity.name)}_controller_test.dart`);
    assert.ok(model && seed && repository && controller && modelTest && controllerTest, `missing files for ${entity.name}`);
    return {
      spec,
      entity,
      files,
      model,
      seed,
      repository,
      controller,
      modelTest,
      controllerTest,
    };
  });
}

const allEntries = specs.flatMap(({ spec }) => entriesFor(spec));

// ── file set ──────────────────────────────────────────────────────────────

test('single-entity spec emits the exact contract paths', () => {
  const paths = emitDataLayer({ spec: singleSpec }).map((file) => file.path).sort();
  assert.deepEqual(paths, [
    'lib/data/models/note.dart',
    'lib/data/repositories/note_repository.dart',
    'lib/data/seed/note_seed.dart',
    'lib/state/note_controller.dart',
    'test/data/note_controller_test.dart',
    'test/data/note_model_test.dart',
  ]);
});

test('every entity gets model, seed, repository, controller and two Dart tests', () => {
  for (const { label, spec } of specs) {
    const files = emitDataLayer({ spec });
    const expected: string[] = [];
    for (const entity of spec.entities) {
      expected.push(
        modelFile(entity),
        seedFile(entity),
        repositoryFile(entity),
        controllerFile(entity),
        `test/data/${snake(entity.name)}_model_test.dart`,
        `test/data/${snake(entity.name)}_controller_test.dart`,
      );
    }
    assert.deepEqual(
      files.map((file) => file.path).sort(),
      expected.sort(),
      `${label} must emit exactly six files per entity`,
    );
    assert.equal(files.length, spec.entities.length * 6, `${label} file count`);
    for (const file of files) {
      const expectedLayer = file.path.startsWith('test/') ? 'test' : 'data';
      assert.equal(file.layer, expectedLayer, `${file.path} layer`);
    }
  }
});

test('paths are unique and emission is deterministic', () => {
  for (const { label, spec } of specs) {
    const first = emitDataLayer({ spec });
    const second = emitDataLayer({ spec });
    const paths = first.map((file) => file.path);
    assert.equal(new Set(paths).size, paths.length, `${label} has duplicate paths`);
    assert.deepEqual(first, second, `${label} must be byte-identical across runs`);
  }
});

test('generated files are non-empty and free of TODO/print', () => {
  for (const entry of allEntries) {
    for (const file of entry.files) {
      assert.ok(file.content.trim().length > 0, `${file.path} is empty`);
      assert.doesNotMatch(file.content, /\bTODO\b/, `${file.path} contains TODO`);
      assert.doesNotMatch(file.content, /\bprint\s*\(/, `${file.path} contains print()`);
    }
  }
});

test('generated Dart imports only the SDK, Flutter and local packages', () => {
  for (const entry of allEntries) {
    for (const file of entry.files.filter((candidate) => candidate.path.endsWith('.dart'))) {
      const specifiers = [...file.content.matchAll(/^import\s+'([^']+)';$/gm)].map((match) => match[1]);
      for (const specifier of specifiers) {
        const allowed =
          specifier.startsWith('dart:') ||
          specifier.startsWith('package:flutter/') ||
          specifier.startsWith('package:flutter_test/') ||
          specifier.startsWith(`package:${entry.spec.app.packageName}/`) ||
          specifier.startsWith('.');
        assert.ok(allowed, `${file.path} imports unexpected ${specifier}`);
      }
    }
  }
});

// ── model contract ────────────────────────────────────────────────────────

test('models expose const constructors, typed fields, copyWith, JSON and identity equality', () => {
  for (const { entity, model } of allEntries) {
    const cls = entityClass(entity);
    assert.match(model, new RegExp(`class ${cls} \\{`), `${cls} class`);
    assert.match(model, new RegExp(`const ${cls}\\(\\{`), `${cls} const constructor`);
    assert.match(model, /required this\.id,/);
    assert.match(model, new RegExp(`${cls} copyWith\\(\\{`));
    assert.match(model, /Map<String, Object\?> toJson\(\)/);
    assert.match(model, new RegExp(`factory ${cls}\\.fromJson\\(Map<String, Object\\?> json\\)`));
    assert.match(model, /bool operator ==\(Object other\)/);
    assert.match(model, /int get hashCode => id\.hashCode;/);
    assert.match(model, /@override/);

    for (const field of entity.fields) {
      const type = dartType(field);
      const copyType = type.endsWith('?') ? type : `${type}?`;
      assert.ok(model.includes(`final ${type} ${field.name};`), `${cls}.${field.name} field type`);
      assert.ok(model.includes(`${copyType} ${field.name},`), `${cls}.${field.name} copyWith parameter`);
      assert.ok(model.includes(`${field.name}: ${field.name} ?? this.${field.name},`), `${cls}.${field.name} copyWith`);
      assert.ok(model.includes(`'${field.name}':`), `${cls}.${field.name} toJson key`);
      assert.ok(model.includes(`${field.name}:`), `${cls}.${field.name} fromJson assignment`);
      if (field.required) {
        assert.ok(model.includes(`required this.${field.name},`), `${cls}.${field.name} required`);
      } else {
        assert.ok(model.includes(`this.${field.name},`), `${cls}.${field.name} optional`);
      }
      if (field.type === 'enum') {
        assert.ok(
          model.includes(`static const List<String> ${field.name}Values = <String>[`),
          `${cls}.${field.name} enum list`,
        );
      }
    }
  }
});

test('datetime and stringList fields use ISO strings and List<String>', () => {
  const recipe = allEntries.find((entry) => entry.entity.name === 'Recipe');
  assert.ok(recipe, 'Recipe fixture is emitted');
  assert.match(recipe.model, /final DateTime createdAt;/);
  assert.match(recipe.model, /createdAt\.toIso8601String\(\)/);
  assert.match(recipe.model, /DateTime\.tryParse\(json\['createdAt'\] as String\? \?\? ''\)/);
  assert.match(recipe.model, /final List<String> steps;/);
  assert.match(recipe.model, /final List<String>\? ingredients;/);
  assert.match(recipe.model, /steps\.toList\(growable: false\)/);
  assert.match(recipe.model, /ingredients\?\.toList\(growable: false\)/);
  assert.match(recipe.model, /final String collectionId;/);
});

test('enum values are declared and escaped on the model', () => {
  const recipe = allEntries.find((entry) => entry.entity.name === 'Recipe');
  assert.ok(recipe);
  assert.match(recipe.model, /static const List<String> difficultyValues = <String>\['easy', 'medium', 'chef\\'s \\\$special'\];/);
  assert.ok(recipe.modelTest.includes('<String>[\'easy\', \'medium\', \'chef\\\'s \\$special\']'));
});

// ── repository contract ───────────────────────────────────────────────────

test('repositories expose the async CRUD contract and honest in-memory semantics', () => {
  for (const { entity, repository } of allEntries) {
    const cls = entityClass(entity);
    assert.match(repository, new RegExp(`abstract class ${cls}Repository`));
    assert.match(repository, new RegExp(`class InMemory${cls}Repository implements ${cls}Repository`));
    assert.ok(repository.includes(`InMemory${cls}Repository([List<${cls}>? seed])`));
    assert.ok(repository.includes(`Future<List<${cls}>> list();`));
    assert.ok(repository.includes(`Future<${cls}> create(${cls} draft);`));
    assert.ok(repository.includes(`Future<${cls}> update(${cls} item);`));
    assert.ok(repository.includes('Future<void> delete(String id);'));
    assert.ok(repository.includes(`List<${cls}>.unmodifiable(_items)`));
    assert.ok(repository.includes('_items.insert(0, stored);'));
    assert.ok(repository.includes('_items.removeWhere('));
    assert.match(repository, /throw StateError\(/);
    assert.equal(
      (repository.match(/await Future<void>\.delayed\(Duration\.zero\);/g) ?? []).length,
      4,
      `${cls}Repository models async I/O in every method`,
    );
    assert.match(repository, /DateTime\.now\(\)\.microsecondsSinceEpoch\.toString\(\)/);
  }
});

// ── controller contract ───────────────────────────────────────────────────

test('controllers expose the exact ChangeNotifier API and guard every failure', () => {
  for (const { entity, controller } of allEntries) {
    const cls = entityClass(entity);
    const name = `${cls}Controller`;
    assert.match(controller, /import 'package:flutter\/foundation\.dart' show ChangeNotifier;/);
    assert.match(controller, new RegExp(`class ${name} extends ChangeNotifier`));
    assert.match(controller, new RegExp(`${name}\\(this\\._repository\\);`));
    assert.ok(controller.includes(`List<${cls}> get items => List<${cls}>.unmodifiable(_items);`));
    assert.match(controller, /bool get isLoading/);
    assert.match(controller, /String\? get error/);
    assert.match(controller, /Future<void> load\(\) async/);
    assert.ok(controller.includes(`Future<${cls}?> create(${cls} draft) async`));
    assert.ok(controller.includes(`Future<void> update(${cls} item) async`));
    assert.match(controller, /Future<void> remove\(String id\) async/);
    assert.ok(controller.includes(`List<${cls}> search(String query)`));
    assert.match(controller, /void clearError\(\)/);
    assert.match(controller, /query\.trim\(\)\.toLowerCase\(\)/);
    assert.match(controller, /whereType<String>\(\)\.any\(\(String value\) => value\.toLowerCase\(\)\.contains\(needle\)\)/);
    assert.match(controller, /_disposed = true;/);
    assert.match(controller, /void _notify\(\) \{\n\s+if \(_disposed\) return;\n\s+notifyListeners\(\);/);
    assert.match(controller, /void dispose\(\)/);
    assert.doesNotMatch(controller, /throw /, 'controllers must capture repository errors, never rethrow');
  }
});

test('controller search covers exactly the primary, string, text and enum fields', () => {
  const task = allEntries.find((entry) => entry.entity.name === 'Task');
  assert.ok(task);
  assert.match(task.controller, /item\.title,/);
  assert.doesNotMatch(task.controller, /item\.projectId,/, 'relation fields are not free-text search targets');
});

// ── seed contract ─────────────────────────────────────────────────────────

test('seeds are deterministic, domain-real and respect seedCount', () => {
  for (const { spec, entity, seed } of allEntries) {
    const cls = entityClass(entity);
    const fn = `seed${pluralize(entity.name)}`;
    assert.ok(seed.includes(`List<${cls}> ${fn}()`), `${cls} seed function`);
    assert.ok(seed.includes(`import '../models/${snake(entity.name)}.dart';`));
    assert.doesNotMatch(seed, /lorem ipsum/i);
    assert.match(seed, new RegExp(`'${snake(entity.name)}_001'`));
    if (spec.seedCount === 0) {
      assert.ok(seed.includes(`const <${cls}>[]`), `${cls} empty seed`);
    } else {
      const rows = seed.match(new RegExp(`\\b${cls}\\(`, 'g')) ?? [];
      assert.equal(rows.length, spec.seedCount, `${cls} seed row count`);
    }
  }
});

test('seed rows are const when possible and use DateTime for datetime fields', () => {
  const note = allEntries.find((entry) => entry.entity.name === 'Note');
  const recipe = allEntries.find((entry) => entry.entity.name === 'Recipe');
  assert.ok(note && recipe);
  assert.match(note.seed, /return const <Note>\[/);
  assert.doesNotMatch(recipe.seed, /return const <Recipe>\[/);
  assert.match(recipe.seed, /createdAt: DateTime\.utc\(2026, 1, 5, 9, 30\)/);
});

test('zero seedCount emits an empty const seed list', () => {
  const zero: AppSpec = { ...singleSpec, seedCount: 0 };
  const files = emitDataLayer({ spec: zero });
  const seed = files.find((file) => file.path === 'lib/data/seed/note_seed.dart')?.content ?? '';
  assert.match(seed, /List<Note> seedNotes\(\) => const <Note>\[\];/);
  assert.equal((seed.match(/\bNote\(/g) ?? []).length, 0);
});

test('relations reference deterministic target seed ids', () => {
  const task = allEntries.find((entry) => entry.entity.name === 'Task');
  assert.ok(task);
  assert.match(task.seed, /projectId: 'project_00[1-4]'/);
});

// ── generated Dart tests ──────────────────────────────────────────────────

test('model tests cover JSON roundtrip, copyWith and id equality', () => {
  for (const { entity, modelTest } of allEntries) {
    const cls = entityClass(entity);
    assert.match(modelTest, /import 'package:flutter_test\/flutter_test\.dart';/);
    assert.match(modelTest, new RegExp(`import 'package:[a-z_]+/data/models/${snake(entity.name)}\\.dart';`));
    assert.match(modelTest, new RegExp(`group\\('${cls}'`));
    assert.match(modelTest, /test\('JSON roundtrip preserves every field'/);
    assert.match(modelTest, /test\('copyWith replaces id and preserves every field'/);
    assert.match(modelTest, /test\('equality and hashCode are keyed by id'/);
    assert.match(modelTest, /\.toJson\(\)/);
    assert.match(modelTest, /\.fromJson\(/);
    assert.match(modelTest, /hashCode/);
    for (const field of entity.fields) {
      assert.ok(modelTest.includes(`restored.${field.name}`), `${cls} test asserts ${field.name}`);
      assert.ok(modelTest.includes(`copy.${field.name}`), `${cls} test copies ${field.name}`);
    }
  }
});

test('controller tests cover load, CRUD, search, failures and disposal', () => {
  for (const { entity, spec, controllerTest } of allEntries) {
    const cls = entityClass(entity);
    const name = `${cls}Controller`;
    const seedFn = `seed${pluralize(entity.name)}`;
    assert.match(controllerTest, /import 'package:flutter_test\/flutter_test\.dart';/);
    assert.match(controllerTest, new RegExp(`class _Failing${cls}Repository implements ${cls}Repository`));
    assert.match(controllerTest, new RegExp(`${name}\\(`));
    assert.ok(controllerTest.includes(`${seedFn}()`), `${name} test uses ${seedFn}`);
    assert.match(controllerTest, /await controller\.load\(\);/);
    assert.match(controllerTest, /controller\.create\(/);
    assert.match(controllerTest, /controller\.update\(/);
    assert.match(controllerTest, /controller\.remove\(/);
    assert.match(controllerTest, /controller\.search\(/);
    assert.match(controllerTest, /controller\.clearError\(\)/);
    assert.match(controllerTest, /test\('repository failures become error state instead of thrown exceptions'/);
    assert.match(controllerTest, /test\('a disposed controller ignores late work'/);
    assert.ok(controllerTest.includes(`package:${spec.app.packageName}/data/seed/${snake(entity.name)}_seed.dart`));
  }
});

test('entities without text fields still get a valid search test', () => {
  const metricSpec = makeSpec(
    [
      entity('Metric', 'metrics', [
        field('value', 'int', true, { primary: true, label: 'Value' }),
        field('recordedOn', 'datetime', false, { label: 'Recorded on' }),
      ]),
    ],
    2,
  );
  const files = emitDataLayer({ spec: metricSpec });
  const controllerTest = files.find((file) => file.path === 'test/data/metric_controller_test.dart')?.content ?? '';
  assert.match(controllerTest, /search returns an empty list when the entity has no text fields/);
  assert.match(controllerTest, /await controller\.update\(created\);/);
  const controller = files.find((file) => file.path === 'lib/state/metric_controller.dart')?.content ?? '';
  assert.match(controller, /final List<String\?> haystack = <String\?>\[\n\s+\];/);
});

test('irregular plurals name seed functions correctly', () => {
  const categorySpec = makeSpec([
    entity('Category', 'categories', [
      field('name', 'string', true, { primary: true, label: 'Name' }),
    ]),
  ]);
  const files = emitDataLayer({ spec: categorySpec });
  const seed = files.find((file) => file.path === 'lib/data/seed/category_seed.dart')?.content ?? '';
  const controllerTest = files.find((file) => file.path === 'test/data/category_controller_test.dart')?.content ?? '';
  assert.match(seed, /List<Category> seedCategories\(\)/);
  assert.match(controllerTest, /seedCategories\(\)/);
});

// ── escaping ──────────────────────────────────────────────────────────────

test('Dart string literals escape apostrophes and dollar signs from labels and enums', () => {
  const recipe = allEntries.find((entry) => entry.entity.name === 'Recipe');
  assert.ok(recipe);
  const output = [recipe.model, recipe.seed, recipe.repository, recipe.controller, recipe.modelTest, recipe.controllerTest].join('\n');
  assert.ok(output.includes("Owner\\'s \\$tip"), 'label apostrophe and dollar must be escaped');
  assert.ok(output.includes("chef\\'s \\$special"), 'enum apostrophe and dollar must be escaped');
  assert.match(recipe.modelTest, /reason: 'Owner\\'s \\\$tip roundtrips through JSON'/);
  assert.match(recipe.modelTest, /reason: 'copyWith preserves Owner\\'s \\\$tip'/);
  assert.match(recipe.seed, /difficulty: 'chef\\'s \\\$special'/);
});
