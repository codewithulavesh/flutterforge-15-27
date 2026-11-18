/**
 * Screen emitters for the generated Flutter UI layer.
 *
 * Every screen is composed from the shared components in `lib/ui/components`
 * and the controller/model contract emitted by the data layer. Screens never
 * invent data: dashboards compute KPIs from live controller items, lists use
 * `controller.search`, details look up by id and forms round-trip through
 * `create` / `update`.
 *
 * Dart is emitted as text. Helpers here are exported so `forms.ts` can share
 * the exact same naming, import and display rules without a second source of
 * truth.
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
  primaryField,
  screenClass,
  screenFile,
  snake,
  routeOf,
} from '../shared.js';

// ── lookup helpers ────────────────────────────────────────────────────────

export function findEntity(spec: AppSpec, name?: string): EntitySpec | undefined {
  if (!name) return undefined;
  const target = pascal(name);
  return (spec.entities ?? []).find((entity) => pascal(entity.name) === target);
}

export function findScreen(
  spec: AppSpec,
  kind: ScreenSpec['kind'],
  entity?: EntitySpec,
): ScreenSpec | undefined {
  const wanted = entity ? pascal(entity.name) : undefined;
  return (spec.screens ?? []).find(
    (screen) =>
      screen.kind === kind &&
      (wanted === undefined || (screen.entity ? pascal(screen.entity) === wanted : false)),
  );
}

export function listScreenFor(spec: AppSpec, entity: EntitySpec): ScreenSpec | undefined {
  return findScreen(spec, 'list', entity);
}

export function detailScreenFor(spec: AppSpec, entity: EntitySpec): ScreenSpec | undefined {
  return findScreen(spec, 'detail', entity);
}

export function formScreenFor(spec: AppSpec, entity: EntitySpec): ScreenSpec | undefined {
  return findScreen(spec, 'form', entity);
}

export function settingsScreen(spec: AppSpec): ScreenSpec | undefined {
  return (spec.screens ?? []).find((screen) => screen.kind === 'settings');
}

/** Dashboard focus entity: explicit binding, then first list, then first entity. */
export function primaryEntity(spec: AppSpec): EntitySpec | undefined {
  const explicit = spec.screens?.find((screen) => screen.kind === 'dashboard' && screen.entity);
  if (explicit) {
    const resolved = findEntity(spec, explicit.entity);
    if (resolved) return resolved;
  }
  for (const screen of spec.screens ?? []) {
    if (screen.kind === 'list' && screen.entity) {
      const resolved = findEntity(spec, screen.entity);
      if (resolved) return resolved;
    }
  }
  return spec.entities?.[0];
}

export function pluralLabel(entity: EntitySpec): string {
  return (entity.plural || entity.name).replace(/_/g, ' ').toLowerCase();
}

export function singularLabel(entity: EntitySpec): string {
  return entity.name.replace(/_/g, ' ').toLowerCase();
}

export function humanize(value: string): string {
  const text = String(value ?? '').replace(/_/g, ' ').trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** String-ish field used for the headline of a record. */
export function displayFieldOf(entity: EntitySpec): FieldSpec | undefined {
  const candidate =
    primaryField(entity) ??
    entity.fields.find((field) => field.type === 'string') ??
    entity.fields.find((field) => field.type === 'text');
  if (!candidate) return undefined;
  if (candidate.type !== 'string' && candidate.type !== 'text' && candidate.type !== 'enum') return undefined;
  return candidate;
}

/** Dart expression producing a non-null String display label from `expr`. */
export function displayExpr(entity: EntitySpec, expr: string): string {
  const field = displayFieldOf(entity);
  if (!field) return `${expr}.id`;
  const access = `${expr}.${field.name}`;
  return field.required ? access : `${access} ?? ${expr}.id`;
}

/** Field picked for the second and third line of list rows. */
export function summaryFields(entity: EntitySpec): FieldSpec[] {
  const primary = displayFieldOf(entity);
  const candidates = entity.fields.filter((field) => field !== primary && field.name !== 'createdAt');
  const preferred = candidates.filter(
    (field) => field.type === 'enum' || field.type === 'bool' || field.type === 'int' || field.type === 'double' || field.type === 'string',
  );
  const ordered = [...preferred, ...candidates.filter((field) => !preferred.includes(field))];
  return ordered.slice(0, 2);
}

export function filterFieldOf(entity: EntitySpec): FieldSpec | undefined {
  return entity.fields.find((field) => field.type === 'enum' && enumValues(field).length > 0);
}

// ── import helpers ────────────────────────────────────────────────────────

export const APP_SCOPE = '../../app/app_scope.dart';

export function component(importPath: string): string {
  return `../../ui/components/${importPath}`;
}

export function pageImport(from: ScreenSpec, to: ScreenSpec): string {
  const target = snake(to.id);
  const own = snake(from.id);
  const targetFolder = `../${target}/${target}_page.dart`;
  // Both pages live in lib/features/<id>/, so a sibling import is always `../`.
  return own === target ? `./${target}_page.dart` : targetFolder;
}

export function importBlock(extra: string[] = [], includeMaterial = false): string {
  const relatives = [...new Set(extra.filter(Boolean))].sort();
  const lines: string[] = [];
  if (includeMaterial) lines.push("import 'package:flutter/material.dart';");
  if (relatives.length) {
    if (lines.length) lines.push('');
    for (const path of relatives) lines.push(`import '${path}';`);
  }
  return lines.join('\n');
}

// ── shared page shapes ────────────────────────────────────────────────────



// ── dashboard ─────────────────────────────────────────────────────────────

interface Kpi {
  label: string;
  value: string;
  icon: string;
  delta?: string;
}

function kpiForEntity(entity: EntitySpec): Kpi[] {
  const items = entity.plural.replace(/_/g, ' ');
  const kpis: Kpi[] = [
    {
      label: `Total ${items}`,
      value: 'items.length.toString()',
      icon: 'Icons.dashboard_customize_outlined',
    },
  ];

  const boolField = entity.fields.find((field) => field.type === 'bool');
  if (boolField) {
    kpis.push({
      label: fieldLabel(boolField),
      value: `items.where((item) => item.${boolField.name}).length.toString()`,
      icon: 'Icons.task_alt',
      delta: "'of ' + items.length.toString()",
    });
  }

  const enumField = filterFieldOf(entity);
  if (enumField) {
    const first = enumValues(enumField)[0];
    kpis.push({
      label: `${fieldLabel(enumField)} · ${humanize(first)}`,
      value: `items.where((item) => item.${enumField.name} == ${dartString(first)}).length.toString()`,
      icon: 'Icons.label_outline',
    });
  }

  const numberField = entity.fields.find((field) => field.type === 'int' || field.type === 'double');
  if (numberField) {
    const access = numberField.required ? `item.${numberField.name}` : `(item.${numberField.name} ?? 0)`;
    if (numberField.type === 'double') {
      kpis.push({
        label: `Total ${fieldLabel(numberField)}`,
        value: `items.fold<double>(0, (sum, item) => sum + ${access}).toStringAsFixed(2)`,
        icon: 'Icons.calculate_outlined',
      });
    } else {
      kpis.push({
        label: `Total ${fieldLabel(numberField)}`,
        value: `items.fold<int>(0, (sum, item) => sum + ${access}).toString()`,
        icon: 'Icons.calculate_outlined',
      });
    }
  }

  const dateField = entity.fields.find((field) => field.type === 'datetime' && field.name !== 'createdAt');
  if (dateField) {
    const access = `item.${dateField.name}`;
    const guard = dateField.required ? '' : `${access} != null && `;
    const bang = dateField.required ? '' : '!';
    kpis.push({
      label: `Upcoming ${fieldLabel(dateField)}`,
      value: `items.where((item) => ${guard}${access}${bang}.isAfter(DateTime.now())).length.toString()`,
      icon: 'Icons.event_outlined',
    });
  }

  const created = entity.fields.find((field) => field.name === 'createdAt' && field.type === 'datetime');
  if (created) {
    kpis.push({
      label: 'Added this week',
      value: `items.where((item) => item.createdAt.isAfter(DateTime.now().subtract(const Duration(days: 7)))).length.toString()`,
      icon: 'Icons.trending_up',
    });
  }

  if (kpis.length < 2) {
    const primary = displayFieldOf(entity);
    if (primary) {
      kpis.push({
        label: `Distinct ${fieldLabel(primary)}`,
        value: `items.map((item) => item.${primary.name}).where((value) => value.trim().isNotEmpty).toSet().length.toString()`,
        icon: 'Icons.tag',
      });
    } else {
      kpis.push({
        label: 'Records loaded',
        value: 'items.length.toString()',
        icon: 'Icons.storage_outlined',
      });
    }
  }

  return kpis.slice(0, 4);
}

export function emitDashboard(ctx: EmitContext, screen: ScreenSpec): GeneratedFile {
  const spec = ctx.spec;
  const entity = findEntity(spec, screen.entity) ?? primaryEntity(spec);
  if (!entity) {
    return emitSimplePlaceholder(screen, 'Nothing to summarize yet', 'Add an entity and screens to populate this dashboard.');
  }
  const entityVar = sharedEntityVar(entity);
  const detail = detailScreenFor(spec, entity);
  const form = formScreenFor(spec, entity);
  const list = listScreenFor(spec, entity);
  const settings = settingsScreen(spec);
  const cls = screenClass(screen);

  const imports: string[] = [APP_SCOPE, component('app_async_view.dart'), component('app_icon_button.dart'), component('app_section_header.dart'), component('app_stat_tile.dart'), `../../data/models/${snake(entity.name)}.dart`];
  if (detail) imports.push(pageImport(screen, detail));
  if (form) imports.push(pageImport(screen, form));
  if (list) imports.push(pageImport(screen, list));

  const tapTarget = detail
    ? `() {
                    Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => ${screenClass(detail)}(entityId: item.id),
                      ),
                    );
                  }`
    : form
      ? `() {
                    Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => ${screenClass(form)}(entityId: item.id),
                      ),
                    );
                  }`
      : 'null';

  const createAction = form
    ? `FilledButton.icon(
                      onPressed: () {
                        Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => const ${screenClass(form)}(),
                          ),
                        );
                      },
                      icon: const Icon(Icons.add),
                      label: Text(${dartString(screen.primaryAction ?? `New ${singularLabel(entity)}`)}),
                      style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
                    )`
    : list
      ? `OutlinedButton.icon(
                      onPressed: () {
                        Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => const ${screenClass(list)}(),
                          ),
                        );
                      },
                      icon: const Icon(Icons.arrow_forward),
                      label: Text(${dartString(`Open ${pluralLabel(entity)}`)}),
                      style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
                    )`
      : 'null';

  const kpiTiles = kpiForEntity(entity)
    .map(
      (kpi) => `        AppStatTile(
          label: ${dartString(kpi.label)},
          value: ${kpi.value},
          icon: ${kpi.icon}${kpi.delta ? `,\n          delta: ${kpi.delta}` : ''},
        ),`,
    )
    .join('\n');

  const viewAll = list
    ? `
                AppSectionHeader(
                  title: ${dartString(`Recent ${pluralLabel(entity)}`)},
                  action: TextButton(
                    onPressed: () {
                      Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => const ${screenClass(list)}(),
                        ),
                      );
                    },
                    child: const Text('View all'),
                  ),
                ),`
    : `
                AppSectionHeader(title: ${dartString(`Recent ${pluralLabel(entity)}`)}),`;

  const settingsAction = settings
    ? `
      actions: <Widget>[
        AppIconButton(
          icon: Icons.settings_outlined,
          tooltip: 'Open settings',
          onPressed: () {
            Navigator.of(context).pushNamed(${dartString(routeOf(settings))});
          },
        ),
      ],`
    : '';

  const content = `import 'package:flutter/material.dart';

${importBlock(imports)}

class ${cls} extends StatelessWidget {
  const ${cls}({super.key, this.entityId});

  final String? entityId;

  @override
  Widget build(BuildContext context) {
    final scope = AppScope.of(context);
    final controller = scope.${entityVar};
    return Scaffold(
      appBar: AppBar(
        title: Text(${dartString(spec.app.name)}),${settingsAction}
      ),
      body: ListenableBuilder(
        listenable: controller,
        builder: (context, _) {
          final items = controller.items;
          return RefreshIndicator(
            onRefresh: controller.load,
            child: AppAsyncView(
              isLoading: controller.isLoading && items.isEmpty,
              error: items.isEmpty ? controller.error : null,
              onRetry: controller.load,
              isEmpty: items.isEmpty,
              emptyIcon: Icons.inbox_outlined,
              emptyTitle: ${dartString(`No ${pluralLabel(entity)} yet`)},
              emptyMessage: ${dartString(entity.description)},
              emptyAction: ${createAction},
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(16),
                children: <Widget>[
                  _GreetingHeader(
                    appName: ${dartString(spec.app.name)},
                    tagline: ${dartString(spec.app.tagline)},
                  ),
                  const SizedBox(height: 16),
                  ${createAction === 'null'
                    ? ''
                    : `Align(
                    alignment: Alignment.centerLeft,
                    child: ${createAction},
                  ),`}
                  const SizedBox(height: 16),
                  LayoutBuilder(
                    builder: (context, constraints) {
                      const gap = 12.0;
                      final columns = constraints.maxWidth >= 700 ? 2 : 1;
                      final tileWidth =
                          columns == 1 ? constraints.maxWidth : (constraints.maxWidth - gap) / 2;
                      return Wrap(
                        spacing: gap,
                        runSpacing: gap,
                        children: <Widget>[
${kpiTiles}
                        ].map((tile) => SizedBox(width: tileWidth, child: tile)).toList(growable: false),
                      );
                    },
                  ),
                  if (controller.error != null) ...<Widget>[
                    const SizedBox(height: 12),
                    _InlineError(
                      message: controller.error!,
                      onRetry: controller.load,
                      onDismiss: controller.clearError,
                    ),
                  ],${viewAll}
                  const SizedBox(height: 4),
                  ...items.take(5).map(
                    (item) => Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Card(
                        clipBehavior: Clip.antiAlias,
                        child: ListTile(
                          leading: CircleAvatar(
                            backgroundColor: Theme.of(context).colorScheme.secondaryContainer,
                            child: Icon(
                              Icons.article_outlined,
                              color: Theme.of(context).colorScheme.onSecondaryContainer,
                            ),
                          ),
                          title: Text(
                            ${displayExpr(entity, 'item')},
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          subtitle: Text(
                            _summary(context, item),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          trailing: ${tapTarget === 'null' ? 'null' : 'const Icon(Icons.chevron_right)'},
                          onTap: ${tapTarget},
                        ),
                      ),
                    ),
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

${SUMMARY_HELPERS(entity)}
${INLINE_ERROR}
`;

  return { path: screenFile(screen), content, layer: 'ui' };
}

const INLINE_ERROR = `class _InlineError extends StatelessWidget {
  const _InlineError({
    required this.message,
    required this.onRetry,
    required this.onDismiss,
  });

  final String message;
  final Future<void> Function() onRetry;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      color: theme.colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        child: Row(
          children: <Widget>[
            Icon(Icons.error_outline, color: theme.colorScheme.onErrorContainer),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                message,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onErrorContainer,
                ),
              ),
            ),
            TextButton(
              onPressed: () {
                onRetry();
              },
              style: TextButton.styleFrom(
                foregroundColor: theme.colorScheme.onErrorContainer,
                minimumSize: const Size(48, 48),
              ),
              child: const Text('Retry'),
            ),
            AppIconButton(
              icon: Icons.close,
              tooltip: 'Dismiss error',
              onPressed: onDismiss,
              color: theme.colorScheme.onErrorContainer,
            ),
          ],
        ),
      ),
    );
  }
}`;

const GREETING = `class _GreetingHeader extends StatelessWidget {
  const _GreetingHeader({required this.appName, required this.tagline});

  final String appName;
  final String tagline;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          _greeting(),
          style: theme.textTheme.titleMedium?.copyWith(
            color: theme.colorScheme.primary,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          appName,
          style: theme.textTheme.headlineMedium,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
        ),
        const SizedBox(height: 4),
        Text(
          tagline,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
          maxLines: 3,
          overflow: TextOverflow.ellipsis,
        ),
      ],
    );
  }
}

String _greeting() {
  final hour = DateTime.now().hour;
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}`;

/** `_label`, `_dateLabel` and `_summary` helpers shared by dashboards/lists. */
function SUMMARY_HELPERS(entity: EntitySpec): string {
  const fields = summaryFields(entity);
  const parts = fields.map((field) => `      ${summaryExpr(field)},`).join('\n');
  const hasDate = fields.some((field) => field.type === 'datetime');
  const hasEnum = fields.some((field) => field.type === 'enum');
  return `${GREETING}
${hasEnum ? `
String _label(String value) {
  if (value.isEmpty) return '';
  final text = value.replaceAll('_', ' ');
  return text[0].toUpperCase() + text.substring(1);
}
` : ''}${hasDate ? `
String _dateLabel(BuildContext context, DateTime? value) {
  if (value == null) return '';
  return MaterialLocalizations.of(context).formatMediumDate(value.toLocal());
}
` : ''}
String _summary(BuildContext context, ${pascal(entity.name)} item) {
  final parts = <String>[
${parts}
  ].where((part) => part.isNotEmpty).toList(growable: false);
  return parts.isEmpty ? 'Open record' : parts.join(' • ');
}`;
}

function summaryExpr(field: FieldSpec): string {
  const access = field.required ? `item.${field.name}` : `item.${field.name}`;
  switch (field.type) {
    case 'datetime':
      return `_dateLabel(context, ${access})`;
    case 'bool':
      return `(${access} ? ${dartString(fieldLabel(field))} : '')`;
    case 'enum':
      return `${access}.isEmpty ? '' : _label(${access})`;
    case 'int':
    case 'double':
      return field.required ? `${access}.toString()` : `(${access} == null ? '' : ${access}!.toString())`;
    case 'stringList':
      return `${access}.join(', ')`;
    case 'relation':
    case 'text':
    case 'string':
    default:
      return field.required ? `${access}.trim()` : `(${access} ?? '').trim()`;
  }
}

// ── placeholder (spec has no entity for a data screen) ────────────────────

export function emitSimplePlaceholder(screen: ScreenSpec, title: string, message: string): GeneratedFile {
  const cls = screenClass(screen);
  const content = `import 'package:flutter/material.dart';

import '../../ui/components/app_empty_state.dart';

class ${cls} extends StatelessWidget {
  const ${cls}({super.key, this.entityId});

  final String? entityId;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(${dartString(screen.title)})),
      body: const AppEmptyState(
        icon: Icons.inbox_outlined,
        title: ${dartString(title)},
        message: ${dartString(message)},
      ),
    );
  }
}
`;
  return { path: screenFile(screen), content, layer: 'ui' };
}

// ── list ──────────────────────────────────────────────────────────────────

export function emitList(ctx: EmitContext, screen: ScreenSpec): GeneratedFile {
  const spec = ctx.spec;
  const entity = findEntity(spec, screen.entity);
  if (!entity) {
    return emitSimplePlaceholder(screen, 'No collection bound', 'This list needs an entity in the app spec.');
  }
  const entityVar = sharedEntityVar(entity);
  const detail = detailScreenFor(spec, entity);
  const form = formScreenFor(spec, entity);
  const filterField = filterFieldOf(entity);
  const needsLabel = Boolean(filterField) || summaryFields(entity).some((field) => field.type === 'enum');
  const cls = screenClass(screen);
  const values = filterField ? enumValues(filterField) : [];
  const createLabel = screen.primaryAction ?? `New ${singularLabel(entity)}`;

  const imports = [APP_SCOPE, component('app_async_view.dart'), component('app_icon_button.dart'), `../../data/models/${snake(entity.name)}.dart`];
  if (detail) imports.push(pageImport(screen, detail));
  if (form) imports.push(pageImport(screen, form));

  const tap = detail
    ? `() {
                          Navigator.of(context).push(
                            MaterialPageRoute<void>(
                              builder: (_) => ${screenClass(detail)}(entityId: item.id),
                            ),
                          );
                        }`
    : form
      ? `() {
                          Navigator.of(context).push(
                            MaterialPageRoute<void>(
                              builder: (_) => ${screenClass(form)}(entityId: item.id),
                            ),
                          );
                        }`
      : 'null';

  const openCreate = form
    ? `() {
                        Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => const ${screenClass(form)}(),
                          ),
                        );
                      }`
    : 'null';

  const appBarActions = form
    ? `
      actions: <Widget>[
        AppIconButton(
          icon: Icons.add,
          tooltip: ${dartString(createLabel)},
          onPressed: ${openCreate},
        ),
      ],`
    : '';

  const fab = form
    ? `
      floatingActionButton: Semantics(
        button: true,
        label: ${dartString(createLabel)},
        child: ExcludeSemantics(
          child: FloatingActionButton(
            tooltip: ${dartString(createLabel)},
            onPressed: ${openCreate},
            child: const Icon(Icons.add),
          ),
        ),
      ),`
    : '';

  const chips = filterField
    ? `
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
        child: Wrap(
          spacing: 8,
          runSpacing: 4,
          children: <Widget>[
            ChoiceChip(
              label: const Text('All'),
              selected: _filter == null,
              onSelected: (_) {
                setState(() {
                  _filter = null;
                });
              },
            ),
${values
  .map(
    (value) => `            ChoiceChip(
              label: Text(_label(${dartString(value)})),
              selected: _filter == ${dartString(value)},
              onSelected: (selected) {
                setState(() {
                  _filter = selected ? ${dartString(value)} : null;
                });
              },
            ),`,
  )
  .join('\n')}
          ],
        ),
      ),`
    : '';

  const emptyAction = form
    ? `FilledButton.icon(
                    onPressed: ${openCreate},
                    icon: const Icon(Icons.add),
                    label: const Text(${dartString(createLabel)}),
                    style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
                  )`
    : 'null';

  const content = `import 'package:flutter/material.dart';

${importBlock(imports)}

class ${cls} extends StatefulWidget {
  const ${cls}({super.key, this.entityId});

  final String? entityId;

  @override
  State<${cls}> createState() => _${cls}State();
}

class _${cls}State extends State<${cls}> {
  final TextEditingController _searchController = TextEditingController();
  String _query = '';${filterField ? `\n  String? _filter;` : ''}

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  List<${pascal(entity.name)}> _visible(List<${pascal(entity.name)}> source) {
${filterField ? `    final filter = _filter;
    if (filter == null) return source;
    return source.where((item) => item.${filterField.name} == filter).toList(growable: false);` : '    return source;'}
  }

  void _clearFilters() {
    _searchController.clear();
    setState(() {
      _query = '';${filterField ? '\n      _filter = null;' : ''}
    });
  }

  @override
  Widget build(BuildContext context) {
    final scope = AppScope.of(context);
    final controller = scope.${entityVar};
    return Scaffold(
      appBar: AppBar(
        title: Text(${dartString(screen.title)}),${appBarActions}
      ),${fab}
      body: Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: TextField(
              controller: _searchController,
              textInputAction: TextInputAction.search,
              onChanged: (value) {
                setState(() {
                  _query = value;
                });
              },
              decoration: InputDecoration(
                hintText: ${dartString(`Search ${pluralLabel(entity)}`)},
                prefixIcon: const Icon(Icons.search),
                border: const OutlineInputBorder(),
                suffixIcon: _query.isEmpty
                    ? null
                    : AppIconButton(
                        icon: Icons.clear,
                        tooltip: 'Clear search',
                        onPressed: _clearFilters,
                      ),
              ),
            ),
          ),${chips}
          Expanded(
            child: RefreshIndicator(
              onRefresh: controller.load,
              child: ListenableBuilder(
                listenable: controller,
                builder: (context, _) {
                  final items = controller.items;
                  final visible = _visible(controller.search(_query));
                  final filtered = _query.trim().isNotEmpty${filterField ? ' || _filter != null' : ''};
                  return AppAsyncView(
                    isLoading: controller.isLoading && items.isEmpty,
                    error: items.isEmpty ? controller.error : null,
                    onRetry: controller.load,
                    isEmpty: items.isEmpty || visible.isEmpty,
                    emptyIcon: filtered ? Icons.search_off : Icons.inbox_outlined,
                    emptyTitle: filtered
                        ? 'No matches'
                        : ${dartString(`No ${pluralLabel(entity)} yet`)},
                    emptyMessage: filtered
                        ? 'Try a different search or clear the filters.'
                        : ${dartString(entity.description)},
                    emptyAction: filtered
                        ? TextButton(
                            onPressed: _clearFilters,
                            child: const Text('Clear filters'),
                          )
                        : ${emptyAction},
                    child: ListView.builder(
                      physics: const AlwaysScrollableScrollPhysics(),
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 96),
                      itemCount: visible.length,
                      itemBuilder: (context, index) {
                        final item = visible[index];
                        final parts = _summary(context, item);
                        return Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: Card(
                            clipBehavior: Clip.antiAlias,
                            child: ListTile(
                              leading: CircleAvatar(
                                backgroundColor: Theme.of(context).colorScheme.secondaryContainer,
                                child: Icon(
                                  Icons.article_outlined,
                                  color: Theme.of(context).colorScheme.onSecondaryContainer,
                                ),
                              ),
                              title: Text(
                                ${displayExpr(entity, 'item')},
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              subtitle: Text(
                                parts,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                              ),
                              trailing: ${tap === 'null' ? 'null' : 'const Icon(Icons.chevron_right)'},
                              onTap: ${tap},
                            ),
                          ),
                        );
                      },
                    ),
                  );
                },
              ),
            ),
          ),
        ],
      ),
    );
  }
}

${needsLabel ? `String _label(String value) {
  if (value.isEmpty) return '';
  final text = value.replaceAll('_', ' ');
  return text[0].toUpperCase() + text.substring(1);
}
` : ''}${summaryHelperForList(entity)}
`;
  return { path: screenFile(screen), content, layer: 'ui' };
}

function summaryHelperForList(entity: EntitySpec): string {
  const fields = summaryFields(entity);
  const parts = fields.map((field) => `      ${summaryExpr(field)},`).join('\n');
  const hasDate = fields.some((field) => field.type === 'datetime');
  return `${hasDate ? `
String _dateLabel(BuildContext context, DateTime? value) {
  if (value == null) return '';
  return MaterialLocalizations.of(context).formatMediumDate(value.toLocal());
}
` : ''}
String _summary(BuildContext context, ${pascal(entity.name)} item) {
  final parts = <String>[
${parts}
  ].where((part) => part.isNotEmpty).toList(growable: false);
  return parts.isEmpty ? 'Open record' : parts.join(' • ');
}`;
}

// ── detail ────────────────────────────────────────────────────────────────

function fieldIcon(field: FieldSpec): string {
  switch (field.type) {
    case 'bool':
      return 'Icons.check_circle_outline';
    case 'datetime':
      return 'Icons.event_outlined';
    case 'enum':
      return 'Icons.label_outline';
    case 'stringList':
      return 'Icons.sell_outlined';
    case 'relation':
      return 'Icons.link';
    case 'int':
    case 'double':
      return 'Icons.numbers';
    case 'text':
      return 'Icons.notes';
    case 'string':
    default:
      return 'Icons.short_text';
  }
}

function detailValueExpr(field: FieldSpec): string {
  const access = `item.${field.name}`;
  switch (field.type) {
    case 'bool':
      return field.required
        ? `Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(
                ${access} ? Icons.check_circle_outline : Icons.cancel_outlined,
                size: 20,
                color: ${access} ? scheme.primary : scheme.onSurfaceVariant,
              ),
              const SizedBox(width: 6),
              Text(${access} ? 'Yes' : 'No'),
            ],
          )`
        : `${access} == null
            ? const Text('Not set')
            : Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Icon(
                    ${access}! ? Icons.check_circle_outline : Icons.cancel_outlined,
                    size: 20,
                    color: ${access}! ? scheme.primary : scheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 6),
                  Text(${access}! ? 'Yes' : 'No'),
                ],
              )`;
    case 'datetime':
      return `Text(_dateLabel(context, ${access}))`;
    case 'enum':
      return field.required
        ? `${access}.isEmpty
            ? const Text('Not set')
            : Align(
                alignment: Alignment.centerLeft,
                child: Chip(
                  label: Text(_label(${access})),
                ),
              )`
        : `${access} == null || ${access}!.isEmpty
            ? const Text('Not set')
            : Align(
                alignment: Alignment.centerLeft,
                child: Chip(
                  label: Text(_label(${access}!)),
                ),
              )`;
    case 'stringList':
      return field.required
        ? `${access}.isEmpty
            ? const Text('Not set')
            : Wrap(
                spacing: 8,
                runSpacing: 8,
                children: <Widget>[
                  for (final value in ${access}) Chip(label: Text(value)),
                ],
              )`
        : `(${access} ?? const <String>[]).isEmpty
            ? const Text('Not set')
            : Wrap(
                spacing: 8,
                runSpacing: 8,
                children: <Widget>[
                  for (final value in ${access}!) Chip(label: Text(value)),
                ],
              )`;
    case 'relation':
      return `Text(_resolve${pascal(field.name)}(context, ${access}))`;
    case 'int':
    case 'double':
      return field.required
        ? `Text(${access}.toString())`
        : `${access} == null ? const Text('Not set') : Text(${access}!.toString())`;
    case 'text':
    case 'string':
    default:
      return field.required
        ? `${access}.trim().isEmpty ? const Text('Not set') : Text(${access})`
        : `${access} == null || ${access}!.trim().isEmpty
            ? const Text('Not set')
            : Text(${access}!)`;
  }
}

/** Detail page: record lookup by id, metadata rows, edit and delete actions. */
export function emitDetail(ctx: EmitContext, screen: ScreenSpec): GeneratedFile {
  const spec = ctx.spec;
  const entity = findEntity(spec, screen.entity);
  if (!entity) {
    return emitSimplePlaceholder(screen, 'No record bound', 'This detail screen needs an entity in the app spec.');
  }
  const entityVar = sharedEntityVar(entity);
  const form = formScreenFor(spec, entity);
  const cls = screenClass(screen);
  const modelClass = pascal(entity.name);
  const imports = [
    APP_SCOPE,
    component('app_async_view.dart'),
    component('app_confirm_dialog.dart'),
    component('app_icon_button.dart'),
    component('app_info_row.dart'),
    component('app_section_header.dart'),
  ];
  if (form) imports.push(pageImport(screen, form));
  imports.push(`../../data/models/${snake(entity.name)}.dart`);

  const rows = entity.fields
    .map(
      (field) => `                AppInfoRow(
                  icon: ${fieldIcon(field)},
                  label: ${dartString(fieldLabel(field))},
                  value: ${detailValueExpr(field)},
                ),`,
    )
    .join('\n                const Divider(height: 1),\n');

  const actionWidgets: string[] = [];
  if (form) {
    actionWidgets.push(`          AppIconButton(
            icon: Icons.edit_outlined,
            tooltip: ${dartString(`Edit ${singularLabel(entity)}`)},
            onPressed: () {
              Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => ${screenClass(form)}(entityId: item.id),
                ),
              );
            },
          ),`);
  }
  actionWidgets.push(`          AppIconButton(
            icon: Icons.delete_outline,
            tooltip: ${dartString(`Delete ${singularLabel(entity)}`)},
            onPressed: () {
              _delete(context, item);
            },
          ),`);

  const helpers: string[] = [];
  if (entity.fields.some((field) => field.type === 'datetime')) {
    helpers.push(`String _dateLabel(BuildContext context, DateTime? value) {
  if (value == null) return 'Not set';
  return MaterialLocalizations.of(context).formatMediumDate(value.toLocal());
}`);
  }
  if (entity.fields.some((field) => field.type === 'enum')) {
    helpers.push(`String _label(String value) {
  if (value.isEmpty) return 'Not set';
  final text = value.replaceAll('_', ' ');
  return text[0].toUpperCase() + text.substring(1);
}`);
  }
  for (const field of entity.fields) {
    if (field.type !== 'relation') continue;
    const target = findEntity(spec, field.target);
    if (!target) continue;
    const targetVar = sharedEntityVar(target);
    helpers.push(`String _resolve${pascal(field.name)}(BuildContext context, String? id) {
  if (id == null || id.trim().isEmpty) return 'Not set';
  final related = AppScope.of(context).${targetVar}.items;
  for (final entry in related) {
    if (entry.id == id) {
      return ${displayExpr(target, 'entry')};
    }
  }
  return id;
}`);
  }

  const content = `import 'package:flutter/material.dart';

${importBlock(imports)}

class ${cls} extends StatelessWidget {
  const ${cls}({super.key, this.entityId});

  final String? entityId;

  ${modelClass}? _find(List<${modelClass}> items) {
    final id = entityId;
    if (id == null) return null;
    for (final item in items) {
      if (item.id == id) return item;
    }
    return null;
  }

  Future<void> _delete(BuildContext context, ${modelClass} item) async {
    final confirmed = await showConfirmDialog(
      context,
      title: ${dartString(`Delete ${singularLabel(entity)}?`)},
      message:
          'This permanently removes "' + (${displayExpr(entity, 'item')}) + '" from this device.',
      confirmLabel: 'Delete',
    );
    if (!confirmed) return;
    final controller = AppScope.of(context).${entityVar};
    try {
      await controller.remove(item.id);
      if (!context.mounted) return;
      Navigator.of(context).maybePop();
    } catch (error) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not delete: ' + error.toString())),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final scope = AppScope.of(context);
    final controller = scope.${entityVar};
    final scheme = Theme.of(context).colorScheme;
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final item = _find(controller.items);
        return Scaffold(
          appBar: AppBar(
            title: Text(${dartString(screen.title)}),
            actions: item == null
                ? null
                : <Widget>[
${actionWidgets.join('\n')}
                ],
          ),
          body: RefreshIndicator(
            onRefresh: controller.load,
            child: AppAsyncView(
              isLoading: controller.isLoading && controller.items.isEmpty,
              error: controller.items.isEmpty ? controller.error : null,
              onRetry: controller.load,
              isEmpty: item == null,
              emptyIcon: Icons.search_off,
              emptyTitle: 'Record not found',
              emptyMessage: 'It may have been removed. Go back and pick another record.',
              emptyAction: OutlinedButton.icon(
                onPressed: () {
                  Navigator.of(context).maybePop();
                },
                icon: const Icon(Icons.arrow_back),
                label: const Text('Back'),
                style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
              ),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 720),
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.all(16),
                    children: <Widget>[
                      _header(context, item!),
                      const SizedBox(height: 16),
                      const AppSectionHeader(title: 'Details'),
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                          child: Column(
                            children: <Widget>[
${rows}
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _header(BuildContext context, ${modelClass} item) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            CircleAvatar(
              radius: 28,
              backgroundColor: scheme.primaryContainer,
              child: Icon(
                Icons.article_outlined,
                color: scheme.onPrimaryContainer,
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    ${displayExpr(entity, 'item')},
                    style: theme.textTheme.headlineSmall,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 6),
                  Text(
                    ${dartString(entity.description)},
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
${helpers.length ? `\n${helpers.join('\n\n')}` : ''}
`;

  return { path: screenFile(screen), content, layer: 'ui' };
}

// ── chat ──────────────────────────────────────────────────────────────────

export function emitChat(ctx: EmitContext, screen: ScreenSpec): GeneratedFile {
  const spec = ctx.spec;
  const entity = primaryEntity(spec);
  const plural = entity ? pluralLabel(entity) : 'notes';
  const singular = entity ? singularLabel(entity) : 'note';
  const cls = screenClass(screen);
  const imports = [
    component('app_confirm_dialog.dart'),
    component('app_empty_state.dart'),
    component('app_icon_button.dart'),
  ];

  const content = `import 'package:flutter/material.dart';

${importBlock(imports)}

class ${cls} extends StatefulWidget {
  const ${cls}({super.key, this.entityId});

  final String? entityId;

  @override
  State<${cls}> createState() => _${cls}State();
}

class _${cls}State extends State<${cls}> {
  final TextEditingController _composer = TextEditingController();
  final ScrollController _scrollController = ScrollController();
  final List<_ChatMessage> _messages = <_ChatMessage>[];

  @override
  void initState() {
    super.initState();
    _messages.addAll(_starterMessages());
  }

  @override
  void dispose() {
    _composer.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  List<_ChatMessage> _starterMessages() {
    return <_ChatMessage>[
      const _ChatMessage(
        author: 'Guide',
        text: ${dartString(`Welcome to ${spec.app.name}. I am your local guide — ask me anything about your ${plural}.`)},
        isMine: false,
      ),
      const _ChatMessage(
        author: 'You',
        text: 'What should I focus on today?',
        isMine: true,
      ),
      const _ChatMessage(
        author: 'Guide',
        text: ${dartString(`Pick one ${singular} and move it forward. A small, finished step beats a big plan.`)},
        isMine: false,
      ),
    ];
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOut,
      );
    });
  }

  Future<void> _send() async {
    final text = _composer.text.trim();
    if (text.isEmpty) return;
    setState(() {
      _messages.add(_ChatMessage(author: 'You', text: text, isMine: true));
    });
    _composer.clear();
    _scrollToBottom();
    await Future<void>.delayed(const Duration(milliseconds: 350));
    if (!mounted) return;
    setState(() {
      _messages.add(
        const _ChatMessage(
          author: 'Guide',
          text: ${dartString(`Noted. I will keep that in mind for your ${plural}.`)},
          isMine: false,
        ),
      );
    });
    _scrollToBottom();
  }

  Future<void> _clearConversation() async {
    final confirmed = await showConfirmDialog(
      context,
      title: 'Clear conversation?',
      message: 'This removes every message on this screen. Nothing leaves your device.',
      confirmLabel: 'Clear',
    );
    if (!confirmed || !mounted) return;
    setState(() {
      _messages.clear();
    });
  }

  void _restoreConversation() {
    setState(() {
      _messages
        ..clear()
        ..addAll(_starterMessages());
    });
    _scrollToBottom();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(${dartString(screen.title)}),
        actions: <Widget>[
          AppIconButton(
            icon: Icons.delete_sweep_outlined,
            tooltip: 'Clear conversation',
            onPressed: () {
              _clearConversation();
            },
          ),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 720),
          child: Column(
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: Text(
                  'Local demo conversation — messages stay on this device.',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  textAlign: TextAlign.center,
                ),
              ),
              Expanded(
                child: _messages.isEmpty
                    ? AppEmptyState(
                        icon: Icons.forum_outlined,
                        title: 'No messages yet',
                        message: 'Start the conversation, or bring back the starter prompts.',
                        action: FilledButton(
                          onPressed: _restoreConversation,
                          style: FilledButton.styleFrom(
                            minimumSize: const Size(48, 48),
                          ),
                          child: const Text('Restore prompts'),
                        ),
                      )
                    : ListView.builder(
                        controller: _scrollController,
                        padding: const EdgeInsets.all(16),
                        itemCount: _messages.length,
                        itemBuilder: (context, index) {
                          final message = _messages[index];
                          return _ChatBubble(message: message);
                        },
                      ),
              ),
              SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: <Widget>[
                      Expanded(
                        child: TextField(
                          controller: _composer,
                          minLines: 1,
                          maxLines: 4,
                          textInputAction: TextInputAction.send,
                          onSubmitted: (_) {
                            _send();
                          },
                          decoration: InputDecoration(
                            labelText: 'Message',
                            hintText: 'Write a message',
                            border: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(16),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: AppIconButton(
                          icon: Icons.send,
                          tooltip: 'Send message',
                          onPressed: _send,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ChatBubble extends StatelessWidget {
  const _ChatBubble({required this.message});

  final _ChatMessage message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final background = message.isMine ? scheme.primaryContainer : scheme.secondaryContainer;
    final foreground = message.isMine ? scheme.onPrimaryContainer : scheme.onSecondaryContainer;
    return Semantics(
      label: message.author + ' said: ' + message.text,
      child: ExcludeSemantics(
        child: Align(
          alignment: message.isMine ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            margin: const EdgeInsets.symmetric(vertical: 4),
            constraints: const BoxConstraints(maxWidth: 480),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: background,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  message.author,
                  style: theme.textTheme.labelSmall?.copyWith(color: foreground),
                ),
                const SizedBox(height: 2),
                Text(
                  message.text,
                  style: theme.textTheme.bodyMedium?.copyWith(color: foreground),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ChatMessage {
  const _ChatMessage({
    required this.author,
    required this.text,
    required this.isMine,
  });

  final String author;
  final String text;
  final bool isMine;
}
`;

  return { path: screenFile(screen), content, layer: 'ui' };
}

// ── profile ───────────────────────────────────────────────────────────────

export function emitProfile(ctx: EmitContext, screen: ScreenSpec): GeneratedFile {
  const spec = ctx.spec;
  const entity = primaryEntity(spec);
  const form = entity ? formScreenFor(spec, entity) : undefined;
  const list = entity ? listScreenFor(spec, entity) : undefined;
  const settings = settingsScreen(spec);
  const cls = screenClass(screen);
  const imports = [
    APP_SCOPE,
    component('app_async_view.dart'),
    component('app_section_header.dart'),
    component('app_stat_tile.dart'),
  ];
  if (form) imports.push(pageImport(screen, form));

  const controllers = (spec.entities ?? []).map((item) => sharedEntityVar(item));
  const loads = (spec.entities ?? []).map((item) => `      scope.${sharedEntityVar(item)}.load(),`).join('\n');
  const isLoading = (spec.entities ?? []).map((item) => `scope.${sharedEntityVar(item)}.isLoading`).join(' || ') || 'false';
  const counts = (spec.entities ?? []).map((item) => `scope.${sharedEntityVar(item)}.items.length`).join(' +\n        ') || '0';
  const errors = (spec.entities ?? [])
    .map((item) => `      scope.${sharedEntityVar(item)}.error,`)
    .join('\n');

  const statTiles = [
    `AppStatTile(
              label: 'Records',
              value: totalRecords.toString(),
              icon: Icons.storage_outlined,
            )`,
    `AppStatTile(
              label: 'Collections',
              value: '${Math.max(1, spec.entities?.length ?? 0)}',
              icon: Icons.folder_outlined,
            )`,
    `AppStatTile(
              label: 'Screens',
              value: '${Math.max(1, spec.screens?.length ?? 0)}',
              icon: Icons.dashboard_outlined,
            )`,
    `AppStatTile(
              label: 'Theme',
              value: scope.settings.isDark ? 'Dark' : 'Light',
              icon: Icons.brightness_6_outlined,
            )`,
  ]
    .map((tile) => `          ${tile},`)
    .join('\n');

  const settingsTile = settings
    ? `            ListTile(
              leading: const Icon(Icons.settings_outlined),
              title: const Text('App settings'),
              subtitle: const Text('Theme, preferences and demo data'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () {
                Navigator.of(context).pushNamed(${dartString(routeOf(settings))});
              },
            ),
            const Divider(height: 1),`
    : '';

  const emptyAction = form
    ? `FilledButton.icon(
                onPressed: () {
                  Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => const ${screenClass(form)}(),
                    ),
                  );
                },
                icon: const Icon(Icons.add),
                label: const Text('Create your first record'),
                style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
              )`
    : list
      ? `OutlinedButton.icon(
                onPressed: () {
                  Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => const ${screenClass(list)}(),
                    ),
                  );
                },
                icon: const Icon(Icons.arrow_forward),
                label: const Text('Open the collection'),
                style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
              )`
      : 'null';

  const content = `import 'package:flutter/material.dart';

${importBlock(imports)}

class ${cls} extends StatelessWidget {
  const ${cls}({super.key, this.entityId});

  final String? entityId;

  Future<void> _reloadAll(BuildContext context) async {
    final scope = AppScope.of(context);
    await Future.wait(<Future<void>>[
${loads}
    ]);
  }

  String _initials(String name) {
    final parts = name
        .trim()
        .split(RegExp(r'\\s+'))
        .where((part) => part.isNotEmpty)
        .toList(growable: false);
    if (parts.isEmpty) return 'A';
    if (parts.length == 1) return parts.first.substring(0, 1).toUpperCase();
    return (parts.first.substring(0, 1) + parts.last.substring(0, 1)).toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final scope = AppScope.of(context);
    final controllers = <Listenable>[
${controllers.map((name) => `      scope.${name},`).join('\n')}
      scope.settings,
    ];
    return Scaffold(
      appBar: AppBar(title: Text(${dartString(screen.title)})),
      body: ListenableBuilder(
        listenable: Listenable.merge(controllers),
        builder: (context, _) {
          final theme = Theme.of(context);
          final totalRecords = ${counts};
          final errors = <String?>[
${errors}
          ].whereType<String>().toList(growable: false);
          return AppAsyncView(
            isLoading: ${isLoading} && totalRecords == 0,
            error: totalRecords == 0 && errors.isNotEmpty ? errors.first : null,
            onRetry: () async {
              await _reloadAll(context);
            },
            isEmpty: totalRecords == 0,
            emptyIcon: Icons.person_outline,
            emptyTitle: 'Nothing tracked yet',
            emptyMessage: 'Create a first record and your activity will show up here.',
            emptyAction: ${emptyAction},
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 720),
                child: ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.all(16),
                  children: <Widget>[
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.all(20),
                        child: Row(
                          children: <Widget>[
                            CircleAvatar(
                              radius: 32,
                              backgroundColor: theme.colorScheme.primaryContainer,
                              child: Text(
                                _initials(${dartString(spec.app.name)}),
                                style: theme.textTheme.titleLarge?.copyWith(
                                  color: theme.colorScheme.onPrimaryContainer,
                                ),
                              ),
                            ),
                            const SizedBox(width: 16),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: <Widget>[
                                  Text(
                                    ${dartString(spec.app.name)},
                                    style: theme.textTheme.headlineSmall,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    ${dartString(`Built for ${spec.audience?.primary ?? 'you'}`)},
                                    style: theme.textTheme.bodyMedium?.copyWith(
                                      color: theme.colorScheme.onSurfaceVariant,
                                    ),
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                  const SizedBox(height: 8),
                                  Chip(
                                    label: const Text('Local profile'),
                                    visualDensity: VisualDensity.compact,
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 8),
                    const AppSectionHeader(title: 'Your activity'),
                    LayoutBuilder(
                      builder: (context, constraints) {
                        const gap = 12.0;
                        final columns = constraints.maxWidth >= 700 ? 2 : 1;
                        final tileWidth =
                            columns == 1 ? constraints.maxWidth : (constraints.maxWidth - gap) / 2;
                        return Wrap(
                          spacing: gap,
                          runSpacing: gap,
                          children: <Widget>[
${statTiles}
                          ]
                              .map((tile) => SizedBox(width: tileWidth, child: tile))
                              .toList(growable: false),
                        );
                      },
                    ),
                    const SizedBox(height: 8),
                    const AppSectionHeader(title: 'Preferences'),
                    Card(
                      clipBehavior: Clip.antiAlias,
                      child: Column(
                        children: <Widget>[
${settingsTile}
                          ListTile(
                            leading: const Icon(Icons.info_outline),
                            title: const Text('About'),
                            subtitle: Text(
                              ${dartString(spec.app.tagline)},
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () {
                              showAboutDialog(
                                context: context,
                                applicationName: ${dartString(spec.app.name)},
                                applicationVersion: '1.0.0',
                                children: <Widget>[
                                  Text(${dartString(spec.app.description)}),
                                ],
                              );
                            },
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
`;

  return { path: screenFile(screen), content, layer: 'ui' };
}

// ── settings ──────────────────────────────────────────────────────────────

export function emitSettings(ctx: EmitContext, screen: ScreenSpec): GeneratedFile {
  const spec = ctx.spec;
  const cls = screenClass(screen);
  const loads = (spec.entities ?? []).map((entity) => `      scope.${sharedEntityVar(entity)}.load(),`).join('\n');
  const imports = [
    APP_SCOPE,
    component('app_confirm_dialog.dart'),
    component('app_section_header.dart'),
  ];

  const content = `import 'package:flutter/material.dart';

${importBlock(imports)}

class ${cls} extends StatefulWidget {
  const ${cls}({super.key, this.entityId});

  final String? entityId;

  @override
  State<${cls}> createState() => _${cls}State();
}

class _${cls}State extends State<${cls}> {
  bool _reminders = true;
  bool _haptics = false;
  bool _resetting = false;

  Future<void> _resetDemoData() async {
    final scope = AppScope.of(context);
    final confirmed = await showConfirmDialog(
      context,
      title: 'Reset demo data?',
      message: 'Reloads the seeded records for every collection on this device. Local changes are replaced by the demo data.',
      confirmLabel: 'Reset',
    );
    if (!confirmed || !mounted) return;
    setState(() {
      _resetting = true;
    });
    try {
      await Future.wait(<Future<void>>[
${loads}
      ]);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Demo data reloaded')),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not reset: ' + error.toString())),
      );
    } finally {
      if (mounted) {
        setState(() {
          _resetting = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final scope = AppScope.of(context);
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(${dartString(screen.title)})),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 720),
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: <Widget>[
              const AppSectionHeader(title: 'Appearance'),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text('Theme', style: theme.textTheme.titleSmall),
                      const SizedBox(height: 4),
                      Text(
                        'Choose how the app looks on this device.',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: 12),
                      ListenableBuilder(
                        listenable: scope.settings,
                        builder: (context, _) {
                          return SegmentedButton<ThemeMode>(
                            segments: const <ButtonSegment<ThemeMode>>[
                              ButtonSegment<ThemeMode>(
                                value: ThemeMode.system,
                                label: Text('System'),
                              ),
                              ButtonSegment<ThemeMode>(
                                value: ThemeMode.light,
                                label: Text('Light'),
                              ),
                              ButtonSegment<ThemeMode>(
                                value: ThemeMode.dark,
                                label: Text('Dark'),
                              ),
                            ],
                            selected: <ThemeMode>{scope.settings.themeMode},
                            showSelectedIcon: false,
                            onSelectionChanged: (selection) {
                              if (selection.isEmpty) return;
                              scope.settings.setThemeMode(selection.first);
                            },
                          );
                        },
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 8),
              const AppSectionHeader(title: 'Notifications'),
              Card(
                clipBehavior: Clip.antiAlias,
                child: Column(
                  children: <Widget>[
                    SwitchListTile(
                      title: const Text('Daily reminders'),
                      subtitle: const Text('Demo preference — saved on this screen only.'),
                      value: _reminders,
                      onChanged: (value) {
                        setState(() {
                          _reminders = value;
                        });
                      },
                    ),
                    const Divider(height: 1),
                    SwitchListTile(
                      title: const Text('Haptic feedback'),
                      subtitle: const Text('Demo preference — saved on this screen only.'),
                      value: _haptics,
                      onChanged: (value) {
                        setState(() {
                          _haptics = value;
                        });
                      },
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              const AppSectionHeader(title: 'Data'),
              Card(
                clipBehavior: Clip.antiAlias,
                child: Column(
                  children: <Widget>[
                    ListTile(
                      leading: const Icon(Icons.restart_alt),
                      title: const Text('Reset demo data'),
                      subtitle: const Text('Reload the seeded records from the local store.'),
                      trailing: _resetting
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text('Reload'),
                      enabled: !_resetting,
                      onTap: () {
                        _resetDemoData();
                      },
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              const AppSectionHeader(title: 'About'),
              Card(
                clipBehavior: Clip.antiAlias,
                child: Column(
                  children: <Widget>[
                    ListTile(
                      leading: const Icon(Icons.info_outline),
                      title: Text(${dartString(spec.app.name)}),
                      subtitle: Text(
                        ${dartString(spec.app.tagline)},
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      onTap: () {
                        showAboutDialog(
                          context: context,
                          applicationName: ${dartString(spec.app.name)},
                          applicationVersion: '1.0.0',
                          children: <Widget>[
                            Text(${dartString(spec.app.description)}),
                          ],
                        );
                      },
                    ),
                    const Divider(height: 1),
                    const ListTile(
                      leading: Icon(Icons.tag),
                      title: Text('App version'),
                      trailing: Text('1.0.0 (1)'),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 24),
            ],
          ),
        ),
      ),
    );
  }
}
`;

  return { path: screenFile(screen), content, layer: 'ui' };
}

// ── onboarding ────────────────────────────────────────────────────────────

export function emitOnboarding(ctx: EmitContext, screen: ScreenSpec): GeneratedFile {
  const spec = ctx.spec;
  const entity = primaryEntity(spec);
  const cls = screenClass(screen);
  const motion = Math.max(0, Math.round(Number(spec.design?.motionMs ?? 200) || 0));
  const pages = [
    {
      icon: 'Icons.auto_awesome_outlined',
      title: `Welcome to ${spec.app.name}`,
      body: spec.app.tagline,
    },
    {
      icon: 'Icons.checklist_rounded',
      title: entity ? `Track your ${pluralLabel(entity)}` : 'Stay organized',
      body: entity ? entity.description : spec.app.description,
    },
    {
      icon: 'Icons.rocket_launch_outlined',
      title: 'Ready when you are',
      body: `Built for ${spec.audience?.primary ?? 'you'}. ${spec.app.description}`,
    },
  ];

  const pageItems = pages
    .map(
      (page) => `  _OnboardingPage(
    icon: ${page.icon},
    title: ${dartString(page.title)},
    body: ${dartString(page.body)},
  ),`,
    )
    .join('\n');

  const content = `import 'package:flutter/material.dart';

class ${cls} extends StatefulWidget {
  const ${cls}({super.key, this.entityId});

  final String? entityId;

  @override
  State<${cls}> createState() => _${cls}State();
}

class _${cls}State extends State<${cls}> {
  static const List<_OnboardingPage> _pages = <_OnboardingPage>[
${pageItems}
  ];

  final PageController _controller = PageController();
  int _index = 0;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _next() {
    if (_index >= _pages.length - 1) {
      _finish();
      return;
    }
    _controller.nextPage(
      duration: const Duration(milliseconds: ${motion}),
      curve: Curves.easeOutCubic,
    );
  }

  void _finish() {
    final navigator = Navigator.of(context);
    if (navigator.canPop()) {
      navigator.pop();
    } else {
      navigator.pushNamedAndRemoveUntil('/', (route) => false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: Column(
              children: <Widget>[
                Expanded(
                  child: PageView.builder(
                    controller: _controller,
                    itemCount: _pages.length,
                    onPageChanged: (index) {
                      setState(() {
                        _index = index;
                      });
                    },
                    itemBuilder: (context, index) {
                      final page = _pages[index];
                      return SingleChildScrollView(
                        padding: const EdgeInsets.all(24),
                        child: Semantics(
                          container: true,
                          label: 'Page ' +
                              (index + 1).toString() +
                              ' of ' +
                              _pages.length.toString() +
                              ': ' +
                              page.title,
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: <Widget>[
                              CircleAvatar(
                                radius: 40,
                                backgroundColor: scheme.primaryContainer,
                                child: Icon(
                                  page.icon,
                                  size: 40,
                                  color: scheme.onPrimaryContainer,
                                ),
                              ),
                              const SizedBox(height: 24),
                              Text(
                                page.title,
                                style: theme.textTheme.headlineMedium,
                                textAlign: TextAlign.center,
                              ),
                              const SizedBox(height: 12),
                              Text(
                                page.body,
                                style: theme.textTheme.bodyLarge?.copyWith(
                                  color: scheme.onSurfaceVariant,
                                ),
                                textAlign: TextAlign.center,
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    children: <Widget>[
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: <Widget>[
                          for (var index = 0; index < _pages.length; index++)
                            Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 4),
                              child: Semantics(
                                label: 'Page ' +
                                    (index + 1).toString() +
                                    ' of ' +
                                    _pages.length.toString(),
                                selected: _index == index,
                                child: ExcludeSemantics(
                                  child: AnimatedContainer(
                                    duration: const Duration(milliseconds: ${motion}),
                                    width: _index == index ? 24 : 8,
                                    height: 8,
                                    decoration: BoxDecoration(
                                      color: _index == index
                                          ? scheme.primary
                                          : scheme.outlineVariant,
                                      borderRadius: BorderRadius.circular(4),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                        ],
                      ),
                      const SizedBox(height: 24),
                      Row(
                        children: <Widget>[
                          Expanded(
                            child: Align(
                              alignment: Alignment.centerLeft,
                              child: TextButton(
                                onPressed: _finish,
                                child: const Text('Skip'),
                              ),
                            ),
                          ),
                          FilledButton(
                            onPressed: _next,
                            style: FilledButton.styleFrom(
                              minimumSize: const Size(48, 48),
                            ),
                            child: Text(
                              _index == _pages.length - 1 ? 'Get started' : 'Continue',
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _OnboardingPage {
  const _OnboardingPage({
    required this.icon,
    required this.title,
    required this.body,
  });

  final IconData icon;
  final String title;
  final String body;
}
`;

  return { path: screenFile(screen), content, layer: 'ui' };
}
