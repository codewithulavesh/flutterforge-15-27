/**
 * Form emitter — validated create/edit forms bound to the entity contract.
 *
 * The emitted widget owns text controllers, keeps a `GlobalKey<FormState>`,
 * hydrates from `controller.items` when editing and calls `create` / `update`
 * exactly once per save. Busy state disables the submit button; failures keep
 * the user on the form with an actionable message.
 */
import type {
  AppSpec,
  EmitContext,
  EntitySpec,
  FieldSpec,
  GeneratedFile,
  ScreenSpec,
} from '../../contracts.js';
import {
  dartString,
  entityVar as sharedEntityVar,
  enumValues,
  fieldLabel,
  pascal,
  screenClass,
  screenFile,
  snake,
} from '../shared.js';
import {
  APP_SCOPE,
  component,
  displayExpr,
  findEntity,
  importBlock,
  singularLabel,
} from './screens.js';

const TEXT_TYPES = new Set<FieldSpec['type']>(['string', 'text', 'stringList', 'int', 'double']);

function controllerFor(field: FieldSpec): string {
  return `_${field.name}Controller`;
}

function valueFor(field: FieldSpec): string {
  return `_value${pascal(field.name)}`;
}

function usesTextController(field: FieldSpec, spec: AppSpec): boolean {
  if (TEXT_TYPES.has(field.type)) return true;
  if (field.type === 'relation' && !findEntity(spec, field.target)) return true;
  return false;
}

function enumConst(field: FieldSpec): string {
  return `_${field.name}Values`;
}

function initLines(entity: EntitySpec, spec: AppSpec): string {
  return entity.fields
    .filter((field) => usesTextController(field, spec))
    .map((field) => `    ${controllerFor(field)} = TextEditingController();`)
    .join('\n');
}

function disposeLines(entity: EntitySpec, spec: AppSpec): string {
  return entity.fields
    .filter((field) => usesTextController(field, spec))
    .map((field) => `    ${controllerFor(field)}.dispose();`)
    .join('\n');
}

function defaultState(field: FieldSpec): string | undefined {
  if (field.type === 'enum' && field.required) {
    const values = enumValues(field);
    return values.length ? `  String? ${valueFor(field)} = ${dartString(values[0])};` : undefined;
  }
  if (field.type === 'bool' && field.required) return `  bool ${valueFor(field)} = false;`;
  if (field.type === 'bool') return `  bool? ${valueFor(field)};`;
  if (field.type === 'enum') return `  String? ${valueFor(field)};`;
  if (field.type === 'relation') return `  String? ${valueFor(field)};`;
  if (field.type === 'datetime') return `  DateTime? ${valueFor(field)};`;
  return undefined;
}

function hydrateLines(entity: EntitySpec, spec: AppSpec): string {
  return entity.fields
    .map((field) => {
      const access = `item.${field.name}`;
      if (usesTextController(field, spec)) {
        if (field.type === 'stringList') {
          return field.required
            ? `    ${controllerFor(field)}.text = ${access}.join(', ');`
            : `    ${controllerFor(field)}.text = (${access} ?? const <String>[]).join(', ');`;
        }
        if (field.type === 'int' || field.type === 'double') {
          return field.required
            ? `    ${controllerFor(field)}.text = ${access}.toString();`
            : `    ${controllerFor(field)}.text = ${access} == null ? '' : ${access}.toString();`;
        }
        return field.required
          ? `    ${controllerFor(field)}.text = ${access};`
          : `    ${controllerFor(field)}.text = ${access} ?? '';`;
      }
      if (field.type === 'enum') {
        const values = enumConst(field);
        return field.required
          ? `    ${valueFor(field)} = ${values}.contains(${access}) ? ${access} : ${dartString(enumValues(field)[0] ?? '')};`
          : `    ${valueFor(field)} = ${values}.contains(${access}) ? ${access} : null;`;
      }
      if (field.type === 'bool') {
        return field.required
          ? `    ${valueFor(field)} = ${access};`
          : `    ${valueFor(field)} = ${access};`;
      }
      return `    ${valueFor(field)} = ${access};`;
    })
    .join('\n');
}

function textValidator(field: FieldSpec): string {
  const label = fieldLabel(field);
  const lines: string[] = [];
  lines.push('      final text = value?.trim() ?? \'\';');
  if (field.required) {
    lines.push(`      if (text.isEmpty) return ${dartString(`${label} is required`)};`);
  } else {
    lines.push('      if (text.isEmpty) return null;');
  }
  if (field.type === 'int') {
    lines.push(`      if (int.tryParse(text) == null) return 'Enter a whole number';`);
  } else if (field.type === 'double') {
    lines.push(`      if (double.tryParse(text) == null) return 'Enter a number';`);
  }
  const name = field.name.toLowerCase();
  if (field.type === 'string' || field.type === 'text') {
    if (name.includes('email')) {
      lines.push(`      if (!RegExp(r'^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$').hasMatch(text)) {`);
      lines.push(`        return 'Enter a valid email address';`);
      lines.push('      }');
    } else if (name.includes('url') || name.includes('website') || name.includes('link')) {
      lines.push('      final uri = Uri.tryParse(text);');
      lines.push("      if (uri == null || !(uri.isScheme('http') || uri.isScheme('https')) || uri.host.isEmpty) {");
      lines.push(`        return 'Enter a valid URL';`);
      lines.push('      }');
    }
  }
  lines.push('      return null;');
  return lines.join('\n');
}

function textField(field: FieldSpec): string {
  const label = fieldLabel(field);
  const name = field.name.toLowerCase();
  const extras: string[] = [];
  if (field.type === 'text') {
    extras.push('      minLines: 3,');
    extras.push('      maxLines: 6,');
    extras.push('      keyboardType: TextInputType.multiline,');
  } else if (field.type === 'int') {
    extras.push('      keyboardType: TextInputType.number,');
  } else if (field.type === 'double') {
    extras.push('      keyboardType: const TextInputType.numberWithOptions(decimal: true),');
  } else if (name.includes('email')) {
    extras.push('      keyboardType: TextInputType.emailAddress,');
    extras.push('      autofillHints: const <String>[AutofillHints.email],');
  } else if (name.includes('url') || name.includes('website') || name.includes('link')) {
    extras.push('      keyboardType: TextInputType.url,');
  }
  const inputAction = field.type === 'text' ? 'TextInputAction.newline' : 'TextInputAction.next';
  const helper = field.type === 'stringList' ? "        helperText: 'Separate values with commas.',\n" : '';
  return `TextFormField(
      controller: ${controllerFor(field)},
      textInputAction: ${inputAction},
${extras.join('\n')}${extras.length ? '\n' : ''}      decoration: const InputDecoration(
        labelText: ${dartString(label)},
        border: OutlineInputBorder(),
${helper}      ),
      validator: (value) {
${textValidator(field)}
      },
    )`;
}

function enumField(field: FieldSpec): string {
  const label = fieldLabel(field);
  const validator = field.required
    ? `      validator: (value) {
        if (value == null || value.isEmpty) return ${dartString(`${label} is required`)};
        return null;
      },`
    : '';
  return `DropdownButtonFormField<String>(
      initialValue: ${valueFor(field)},
      isExpanded: true,
      decoration: const InputDecoration(
        labelText: ${dartString(label)},
        border: OutlineInputBorder(),
      ),
      hint: Text(${dartString(`Select ${label.toLowerCase()}`)}),
      items: ${enumConst(field)}
          .map(
            (value) => DropdownMenuItem<String>(
              value: value,
              child: Text(_label(value)),
            ),
          )
          .toList(growable: false),${validator ? `\n${validator}` : ''}
      onChanged: (value) {
        setState(() {
          ${valueFor(field)} = value;
        });
      },
    )`;
}

function boolField(field: FieldSpec): string {
  const value = field.required ? valueFor(field) : `(${valueFor(field)} ?? false)`;
  return `SwitchListTile(
      contentPadding: EdgeInsets.zero,
      title: Text(${dartString(fieldLabel(field))}),
      subtitle: const Text('Toggle when this applies.'),
      value: ${value},
      onChanged: (value) {
        setState(() {
          ${valueFor(field)} = value;
        });
      },
    )`;
}

function dateField(field: FieldSpec): string {
  const required = field.required ? 'true' : 'false';
  return `_dateField(
      label: ${dartString(fieldLabel(field))},
      value: ${valueFor(field)},
      isRequired: ${required},
      onChanged: (value) {
        setState(() {
          ${valueFor(field)} = value;
        });
      },
    )`;
}

function relationField(field: FieldSpec): string {
  return `_build${pascal(field.name)}Field(context)`;
}

function relationBuilder(field: FieldSpec, target: EntitySpec): string {
  const targetVar = sharedEntityVar(target);
  const validator = field.required
    ? `      validator: (value) {
        if (value == null || value.isEmpty) return ${dartString(`${fieldLabel(field)} is required`)};
        return null;
      },`
    : '';
  return `  Widget _build${pascal(field.name)}Field(BuildContext context) {
    final items = AppScope.of(context).${targetVar}.items;
    final hasCurrent = ${valueFor(field)} != null &&
        items.any((entry) => entry.id == ${valueFor(field)});
    return DropdownButtonFormField<String>(
      key: ObjectKey(items),
      initialValue: hasCurrent ? ${valueFor(field)} : null,
      isExpanded: true,
      decoration: const InputDecoration(
        labelText: ${dartString(fieldLabel(field))},
        border: OutlineInputBorder(),
      ),
      hint: Text(${dartString(`Select ${fieldLabel(field).toLowerCase()}`)}),
      items: items
          .map(
            (entry) => DropdownMenuItem<String>(
              value: entry.id,
              child: Text(
                ${displayExpr(target, 'entry')},
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          )
          .toList(growable: false),${validator ? `\n${validator}` : ''}
      onChanged: (value) {
        setState(() {
          ${valueFor(field)} = value;
        });
      },
    );
  }`;
}

function fieldWidget(field: FieldSpec, spec: AppSpec): string {
  switch (field.type) {
    case 'bool':
      return boolField(field);
    case 'enum':
      return enumField(field);
    case 'datetime':
      return dateField(field);
    case 'relation': {
      const target = findEntity(spec, field.target);
      return target ? relationField(field) : textField(field);
    }
    default:
      return textField(field);
  }
}

function constructorValue(field: FieldSpec, spec: AppSpec): string {
  const controller = controllerFor(field);
  const value = valueFor(field);
  if (field.type === 'relation') {
    if (!findEntity(spec, field.target)) {
      return field.required ? `${controller}.text.trim()` : `_nullableText(${controller}.text)`;
    }
    return value;
  }
  switch (field.type) {
    case 'string':
    case 'text':
      return field.required
        ? `${controller}.text.trim()`
        : `_nullableText(${controller}.text)`;
    case 'stringList':
      return field.required
        ? `${controller}.text
            .split(',')
            .map((part) => part.trim())
            .where((part) => part.isNotEmpty)
            .toList(growable: false)`
        : `_nullableList(${controller}.text)`;
    case 'int':
      return field.required
        ? `int.tryParse(${controller}.text.trim()) ?? 0`
        : `int.tryParse(${controller}.text.trim())`;
    case 'double':
      return field.required
        ? `double.tryParse(${controller}.text.trim()) ?? 0`
        : `double.tryParse(${controller}.text.trim())`;
    case 'enum': {
      const values = enumValues(field);
      return field.required
        ? `${value} ?? ${dartString(values[0] ?? '')}`
        : value;
    }
    case 'bool':
      return value;
    case 'datetime':
      return field.required ? `(${value} ?? DateTime.now())` : value;
    default:
      return value;
  }
}

export function emitFormPage(ctx: EmitContext, screen: ScreenSpec): GeneratedFile {
  const spec = ctx.spec;
  const entity = findEntity(spec, screen.entity);
  if (!entity) {
    const clsFallback = screenClass(screen);
    return {
      path: screenFile(screen),
      layer: 'ui',
      content: `import 'package:flutter/material.dart';

class ${clsFallback} extends StatelessWidget {
  const ${clsFallback}({super.key, this.entityId});

  final String? entityId;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(${dartString(screen.title)})),
      body: const Center(child: Text('This form needs an entity in the app spec.')),
    );
  }
}
`,
    };
  }

  const cls = screenClass(screen);
  const entityVar = sharedEntityVar(entity);
  const modelClass = pascal(entity.name);
  const singular = singularLabel(entity);
  const enumFields = entity.fields.filter((field) => field.type === 'enum');
  const listFields = entity.fields.filter((field) => field.type === 'stringList');
  const needsNullableText = entity.fields.some(
    (field) =>
      ((field.type === 'string' || field.type === 'text') && !field.required) ||
      (field.type === 'relation' && !field.required),
  );
  const dateFields = entity.fields.filter((field) => field.type === 'datetime');
  const relationTargets = [
    ...new Map(
      entity.fields
        .filter((field) => field.type === 'relation')
        .map((field) => findEntity(spec, field.target))
        .filter((target): target is EntitySpec => Boolean(target))
        .map((target) => [sharedEntityVar(target), target] as const),
    ).values(),
  ];

  const imports = [APP_SCOPE, component('app_async_view.dart')];
  if (dateFields.length) imports.push(component('app_icon_button.dart'));
  imports.push(`../../data/models/${snake(entity.name)}.dart`);

  const stateDeclarations = entity.fields
    .map((field) => defaultState(field))
    .filter((line): line is string => Boolean(line))
    .join('\n');

  const enumConstants = enumFields
    .map(
      (field) =>
        `const List<String> ${enumConst(field)} = <String>[${enumValues(field).map((value) => dartString(value)).join(', ')}];`,
    )
    .join('\n');

  const widgets = entity.fields.map((field) => fieldWidget(field, spec)).join(',\n    ');

  const relationBuilders = entity.fields
    .filter((field) => field.type === 'relation')
    .map((field) => {
      const target = findEntity(spec, field.target);
      return target ? relationBuilder(field, target) : '';
    })
    .filter(Boolean)
    .join('\n\n');

  const constructorFields = entity.fields
    .map((field) => `      ${field.name}: ${constructorValue(field, spec)},`)
    .join('\n');

  const listenables = [
    'controller',
    ...relationTargets.map((target) => `scope.${sharedEntityVar(target)}`),
  ].join(', ');

  const content = `import 'package:flutter/material.dart';

${importBlock(imports)}

class ${cls} extends StatefulWidget {
  const ${cls}({super.key, this.entityId});

  final String? entityId;

  @override
  State<${cls}> createState() => _${cls}State();
}

class _${cls}State extends State<${cls}> {
  final GlobalKey<FormState> _formKey = GlobalKey<FormState>();
${entity.fields
  .filter((field) => usesTextController(field, spec))
  .map((field) => `  late final TextEditingController ${controllerFor(field)};`)
  .join('\n')}
${stateDeclarations}
  AppScope? _scope;
  ${modelClass}? _existing;
  bool _hydrated = false;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
${initLines(entity, spec)}
    _hydrated = widget.entityId == null;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final scope = AppScope.of(context);
    if (identical(scope, _scope)) return;
    _scope?.${entityVar}.removeListener(_handleControllerChanged);
    _scope = scope;
    scope.${entityVar}.addListener(_handleControllerChanged);
    if (_hydrated) return;
    final item = _find(scope.${entityVar}.items);
    if (item != null) {
      _applyItem(item);
      _existing = item;
      _hydrated = true;
    }
  }

  @override
  void dispose() {
    _scope?.${entityVar}.removeListener(_handleControllerChanged);
${disposeLines(entity, spec)}
    super.dispose();
  }

  void _handleControllerChanged() {
    if (!mounted) return;
    final scope = _scope;
    if (scope == null) return;
    if (!_hydrated) {
      final item = _find(scope.${entityVar}.items);
      if (item != null) {
        _applyItem(item);
        setState(() {
          _existing = item;
          _hydrated = true;
        });
        return;
      }
    }
    setState(() {});
  }

  ${modelClass}? _find(List<${modelClass}> items) {
    final id = widget.entityId;
    if (id == null) return null;
    for (final item in items) {
      if (item.id == id) return item;
    }
    return null;
  }

  void _applyItem(${modelClass} item) {
${hydrateLines(entity, spec)}
  }

  Future<void> _save() async {
    final form = _formKey.currentState;
    if (form == null || !form.validate()) return;
    final scope = AppScope.of(context);
    final controller = scope.${entityVar};
    setState(() {
      _saving = true;
    });
    try {
      final draft = ${modelClass}(
        id: _existing?.id ?? '',
${constructorFields}
      );
      if (_existing == null) {
        final created = await controller.create(draft);
        if (!mounted) return;
        if (created == null) {
          setState(() {
            _saving = false;
          });
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Could not save. Please try again.')),
          );
          return;
        }
      } else {
        await controller.update(draft);
        if (!mounted) return;
      }
      setState(() {
        _saving = false;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Saved')),
      );
      Navigator.of(context).maybePop();
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not save: ' + error.toString())),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final scope = AppScope.of(context);
    final controller = scope.${entityVar};
    final isEditing = widget.entityId != null;
    return Scaffold(
      appBar: AppBar(
        title: Text(${dartString(screen.title)}),
      ),
      body: ListenableBuilder(
        listenable: Listenable.merge(<Listenable>[${listenables}]),
        builder: (context, _) {
          if (isEditing && !_hydrated) {
            return AppAsyncView(
              isLoading: controller.isLoading,
              error: controller.error,
              onRetry: controller.load,
              isEmpty: !controller.isLoading,
              emptyIcon: Icons.search_off,
              emptyTitle: 'Record not found',
              emptyMessage: 'It may have been removed. Go back and try again.',
              emptyAction: OutlinedButton.icon(
                onPressed: () {
                  Navigator.of(context).maybePop();
                },
                icon: const Icon(Icons.arrow_back),
                label: const Text('Back'),
                style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
              ),
              child: const SizedBox.shrink(),
            );
          }
          return _formBody(context);
        },
      ),
    );
  }

  Widget _formBody(BuildContext context) {
    final theme = Theme.of(context);
    final editing = _existing != null;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 720),
        child: Form(
          key: _formKey,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: <Widget>[
    ${widgets},
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: _saving ? null : _save,
                icon: _saving
                    ? SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: theme.colorScheme.onPrimary,
                        ),
                      )
                    : const Icon(Icons.check),
                label: Text(
                  _saving
                      ? 'Saving…'
                      : editing
                          ? 'Save changes'
                          : ${dartString(screen.primaryAction ?? `Create ${singular}`)},
                ),
                style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
              ),
              const SizedBox(height: 8),
              OutlinedButton(
                onPressed: _saving
                    ? null
                    : () {
                        Navigator.of(context).maybePop();
                      },
                style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
                child: const Text('Cancel'),
              ),
              const SizedBox(height: 24),
            ],
          ),
        ),
      ),
    );
  }

${dateFields.length ? dateHelper() : ''}${relationBuilders ? `\n${relationBuilders}\n` : ''}
${needsNullableText ? `  String? _nullableText(String value) {
    final text = value.trim();
    return text.isEmpty ? null : text;
  }
` : ''}${listFields.some((field) => !field.required) ? `
  List<String>? _nullableList(String value) {
    final parts = value
        .split(',')
        .map((part) => part.trim())
        .where((part) => part.isNotEmpty)
        .toList(growable: false);
    return parts.isEmpty ? null : parts;
  }
` : ''}${enumFields.length ? `
  String _label(String value) {
    if (value.isEmpty) return '';
    final text = value.replaceAll('_', ' ');
    return text[0].toUpperCase() + text.substring(1);
  }
` : ''}}

${enumConstants}
`;

  return { path: screenFile(screen), content, layer: 'ui' };
}

function dateHelper(): string {
  return `  Widget _dateField({
    required String label,
    required DateTime? value,
    required bool isRequired,
    required ValueChanged<DateTime?> onChanged,
  }) {
    return FormField<DateTime>(
      initialValue: value,
      validator: (current) {
        if (isRequired && current == null) {
          return label + ' is required';
        }
        return null;
      },
      builder: (field) {
        final theme = Theme.of(field.context);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.event_outlined),
              title: Text(label),
              subtitle: Text(
                field.value == null
                    ? 'Not set'
                    : MaterialLocalizations.of(field.context).formatMediumDate(
                        field.value!.toLocal(),
                      ),
              ),
              trailing: field.value == null
                  ? null
                  : AppIconButton(
                      icon: Icons.close,
                      tooltip: 'Clear ' + label,
                      onPressed: () {
                        field.didChange(null);
                        onChanged(null);
                      },
                    ),
              onTap: () async {
                final picked = await showDatePicker(
                  context: field.context,
                  initialDate: field.value ?? DateTime.now(),
                  firstDate: DateTime(1900),
                  lastDate: DateTime(2100),
                );
                if (picked == null) return;
                field.didChange(picked);
                onChanged(picked);
              },
            ),
            if (field.hasError)
              Padding(
                padding: const EdgeInsets.only(left: 16, bottom: 8),
                child: Text(
                  field.errorText!,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.error,
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
`;
}
