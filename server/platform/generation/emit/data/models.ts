/**
 * Dart domain-model emitter.
 *
 * One const class per entity with an implicit required `id`, null-safe scalar
 * fields, ISO-8601 DateTime JSON, enum value lists and identity equality.
 * The generated model test lives next to this emitter because it documents the
 * same contract the UI layer compiles against.
 */
import type { AppSpec, EntitySpec, FieldSpec, GeneratedFile } from '../../contracts.js';
import {
  dartString,
  dartType,
  entityClass,
  enumValues,
  fieldLabel,
  jsonRead,
  jsonWrite,
  modelFile,
  seedId,
  snake,
} from '../shared.js';
import { sampleLiteral } from './seed.js';

function safeDoc(text: string): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\*\//g, '* /')
    .trim();
}

/** Dart type for a copyWith parameter: always nullable so callers can omit it. */
function copyWithType(field: FieldSpec): string {
  const type = dartType(field);
  return type.endsWith('?') ? type : `${type}?`;
}

/** JSON expression for a field, including null-safe optional list/date writes. */
function writeExpression(field: FieldSpec): string {
  if (field.required) return jsonWrite(field, field.name);
  if (field.type === 'datetime') return `${field.name}?.toIso8601String()`;
  if (field.type === 'stringList') return `${field.name}?.toList(growable: false)`;
  return field.name;
}

export function modelTestFile(entity: EntitySpec): string {
  return `test/data/${snake(entity.name)}_model_test.dart`;
}

/** `lib/data/models/<entity>.dart` — the canonical Dart model class. */
export function emitModel(entity: EntitySpec): GeneratedFile {
  const cls = entityClass(entity);
  const lines: string[] = [];

  lines.push(`/// Domain model for a ${cls} record.`);
  lines.push(`class ${cls} {`);
  lines.push(`  const ${cls}({`);
  lines.push('    required this.id,');
  for (const field of entity.fields) {
    lines.push(field.required ? `    required this.${field.name},` : `    this.${field.name},`);
  }
  lines.push('  });');
  lines.push('');
  lines.push('  final String id;');
  for (const field of entity.fields) {
    const label = safeDoc(fieldLabel(field));
    lines.push('');
    if (label) lines.push(`  /// ${label}`);
    lines.push(`  final ${dartType(field)} ${field.name};`);
  }

  for (const field of entity.fields) {
    if (field.type !== 'enum') continue;
    const values = enumValues(field).map(dartString).join(', ');
    lines.push('');
    lines.push(`  /// Allowed values for [${field.name}].`);
    lines.push(`  static const List<String> ${field.name}Values = <String>[${values}];`);
  }

  lines.push('');
  lines.push('  /// Returns a copy with the supplied fields replaced.');
  lines.push(`  ${cls} copyWith({`);
  lines.push('    String? id,');
  for (const field of entity.fields) {
    lines.push(`    ${copyWithType(field)} ${field.name},`);
  }
  lines.push('  }) {');
  lines.push(`    return ${cls}(`);
  lines.push('      id: id ?? this.id,');
  for (const field of entity.fields) {
    lines.push(`      ${field.name}: ${field.name} ?? this.${field.name},`);
  }
  lines.push('    );');
  lines.push('  }');
  lines.push('');
  lines.push('  /// Serializes this record for local persistence and tests.');
  lines.push('  Map<String, Object?> toJson() {');
  lines.push('    return <String, Object?>{');
  lines.push("      'id': id,");
  for (const field of entity.fields) {
    lines.push(`      ${dartString(field.name)}: ${writeExpression(field)},`);
  }
  lines.push('    };');
  lines.push('  }');
  lines.push('');
  lines.push('  /// Decodes a record produced by [toJson].');
  lines.push(`  factory ${cls}.fromJson(Map<String, Object?> json) {`);
  lines.push(`    return ${cls}(`);
  lines.push("      id: json['id'] as String? ?? '',");
  for (const field of entity.fields) {
    lines.push(`      ${field.name}: ${jsonRead(field)},`);
  }
  lines.push('    );');
  lines.push('  }');
  lines.push('');
  lines.push('  @override');
  lines.push('  bool operator ==(Object other) {');
  lines.push('    if (identical(this, other)) return true;');
  lines.push(`    return other is ${cls} && other.id == id;`);
  lines.push('  }');
  lines.push('');
  lines.push('  @override');
  lines.push('  int get hashCode => id.hashCode;');
  lines.push('}');

  return { path: modelFile(entity), content: `${lines.join('\n')}\n`, layer: 'data' };
}

/** `test/data/<entity>_model_test.dart` — JSON, copyWith and identity checks. */
export function emitModelTest(spec: AppSpec, entity: EntitySpec): GeneratedFile {
  const cls = entityClass(entity);
  const entityId = seedId(entity, 0);
  const copiedId = `${snake(entity.name)}_copy`;
  const otherId = `${snake(entity.name)}_other`;
  const ctx = { spec, entity, index: 0 };

  const jsonLines: string[] = [`    'id': ${dartString(entityId)},`];
  const roundtripAssertions: string[] = [
    `      expect(restored.id, ${dartString(entityId)}, reason: 'id roundtrips through JSON');`,
  ];
  const copyAssertions: string[] = [`      expect(copy.id, ${dartString(copiedId)});`];

  for (const field of entity.fields) {
    const sample = sampleLiteral(field, ctx);
    const label = dartString(`${fieldLabel(field)} roundtrips through JSON`);
    const copyReason = dartString(`copyWith preserves ${fieldLabel(field)}`);
    jsonLines.push(`    ${dartString(field.name)}: ${sample.json},`);
    roundtripAssertions.push(`      expect(restored.${field.name}, ${sample.expected}, reason: ${label});`);
    copyAssertions.push(`      expect(copy.${field.name}, note.${field.name}, reason: ${copyReason});`);
  }

  const enumFields = entity.fields.filter((field) => field.type === 'enum');
  const enumTest =
    enumFields.length === 0
      ? ''
      : `\n    test('enum fields expose their allowed values', () {\n${enumFields
          .map(
            (field) =>
              `      expect(${cls}.${field.name}Values, <String>[${enumValues(field).map(dartString).join(', ')}]);`,
          )
          .join('\n')}\n    });\n`;

  const content = `import 'package:flutter_test/flutter_test.dart';

import 'package:${spec.app.packageName}/data/models/${snake(entity.name)}.dart';

void main() {
  group('${cls}', () {
    test('JSON roundtrip preserves every field', () {
      final Map<String, Object?> json = _sampleJson();
      final ${cls} note = ${cls}.fromJson(json);
      final ${cls} restored = ${cls}.fromJson(note.toJson());

${roundtripAssertions.join('\n')}
      expect(restored.toJson(), json);
    });

    test('copyWith replaces id and preserves every field', () {
      final ${cls} note = ${cls}.fromJson(_sampleJson());
      final ${cls} copy = note.copyWith(id: ${dartString(copiedId)});

${copyAssertions.join('\n')}
    });

    test('equality and hashCode are keyed by id', () {
      final ${cls} first = ${cls}.fromJson(_sampleJson());
      final ${cls} second = ${cls}.fromJson(_sampleJson());
      final ${cls} other = first.copyWith(id: ${dartString(otherId)});

      expect(first, second);
      expect(first.hashCode, second.hashCode);
      expect(first == other, isFalse);
      expect(first == first, isTrue);
    });
${enumTest}  });
}

Map<String, Object?> _sampleJson() {
  return <String, Object?>{
${jsonLines.join('\n')}
  };
}
`;

  return { path: modelTestFile(entity), content, layer: 'test' };
}
