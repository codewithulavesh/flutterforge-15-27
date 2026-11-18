/**
 * Shared presentational components for the generated UI layer.
 *
 * These files are the only place a screen may reach for a repeated visual
 * primitive. They deliberately know nothing about entities, controllers or
 * navigation: every callback and every piece of data is supplied by the page.
 * Colour comes exclusively from `Theme.of(context).colorScheme` / `textTheme`
 * so light, dark and high-contrast themes all work without extra code.
 */
import type { GeneratedFile } from '../../contracts.js';

const ASYNC_VIEW = `import 'package:flutter/material.dart';

import 'app_empty_state.dart';

/// Uniform loading / error / empty gate used by every data-bound screen.
///
/// Pages decide when a state applies; this widget only presents it. Keeping the
/// gate in one place means retry behaviour, spacing and semantics are identical
/// across the app.
class AppAsyncView extends StatelessWidget {
  const AppAsyncView({
    super.key,
    required this.child,
    this.isLoading = false,
    this.error,
    this.onRetry,
    this.isEmpty = false,
    this.emptyIcon = Icons.inbox_outlined,
    this.emptyTitle = 'Nothing here yet',
    this.emptyMessage,
    this.emptyAction,
  });

  /// Content shown when no state gate is active.
  final Widget child;

  /// Initial load in progress (usually \`isLoading && items.isEmpty\`).
  final bool isLoading;

  /// Human readable failure message. Rendered as a retryable card.
  final String? error;

  /// Called when the user taps "Try again".
  final Future<void> Function()? onRetry;

  /// True when the request succeeded but produced no rows.
  final bool isEmpty;

  final IconData emptyIcon;
  final String emptyTitle;
  final String? emptyMessage;

  /// Optional primary action for the empty state, e.g. "New note".
  final Widget? emptyAction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (isLoading) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: CircularProgressIndicator(),
        ),
      );
    }
    if (error != null) {
      return SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(24),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Icon(
                      Icons.error_outline,
                      size: 40,
                      color: theme.colorScheme.error,
                    ),
                    const SizedBox(height: 12),
                    Text(
                      'Something went wrong',
                      style: theme.textTheme.titleMedium,
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      error!,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                      textAlign: TextAlign.center,
                    ),
                    if (onRetry != null) ...<Widget>[
                      const SizedBox(height: 16),
                      FilledButton.icon(
                        onPressed: () {
                          onRetry!();
                        },
                        icon: const Icon(Icons.refresh),
                        label: const Text('Try again'),
                        style: FilledButton.styleFrom(
                          minimumSize: const Size(48, 48),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    }
    if (isEmpty) {
      return AppEmptyState(
        icon: emptyIcon,
        title: emptyTitle,
        message: emptyMessage,
        action: emptyAction,
      );
    }
    return child;
  }
}
`;

const EMPTY_STATE = `import 'package:flutter/material.dart';

/// Friendly, non-technical empty state. Scrollable so it can live inside a
/// [RefreshIndicator] without breaking pull-to-refresh.
class AppEmptyState extends StatelessWidget {
  const AppEmptyState({
    super.key,
    this.icon = Icons.inbox_outlined,
    required this.title,
    this.message,
    this.action,
  });

  final IconData icon;
  final String title;
  final String? message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SingleChildScrollView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              CircleAvatar(
                radius: 32,
                backgroundColor: theme.colorScheme.secondaryContainer,
                child: Icon(
                  icon,
                  size: 32,
                  color: theme.colorScheme.onSecondaryContainer,
                ),
              ),
              const SizedBox(height: 16),
              Text(
                title,
                style: theme.textTheme.titleMedium,
                textAlign: TextAlign.center,
              ),
              if (message != null) ...<Widget>[
                const SizedBox(height: 8),
                Text(
                  message!,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  textAlign: TextAlign.center,
                ),
              ],
              if (action != null) ...<Widget>[
                const SizedBox(height: 20),
                action!,
              ],
            ],
          ),
        ),
      ),
    );
  }
}
`;

const SECTION_HEADER = `import 'package:flutter/material.dart';

/// Section title plus an optional trailing action ("View all", "Manage").
///
/// The action is given a 48dp minimum tap target regardless of the widget the
/// caller passes in, so text buttons stay accessible on touch devices.
class AppSectionHeader extends StatelessWidget {
  const AppSectionHeader({super.key, required this.title, this.action});

  final String title;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: <Widget>[
          Expanded(
            child: Text(
              title,
              style: theme.textTheme.titleMedium,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (action != null) ...<Widget>[
            const SizedBox(width: 8),
            ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 48, minWidth: 48),
              child: Align(
                alignment: Alignment.centerRight,
                widthFactor: 1,
                heightFactor: 1,
                child: action,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
`;

const STAT_TILE = `import 'package:flutter/material.dart';

/// Compact KPI tile. Values are computed by the page from controller data;
/// this widget never invents numbers.
class AppStatTile extends StatelessWidget {
  const AppStatTile({
    super.key,
    required this.label,
    required this.value,
    required this.icon,
    this.delta,
  });

  final String label;
  final String value;
  final IconData icon;

  /// Optional supporting line, e.g. "of 12" or "this week".
  final String? delta;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final description = delta == null ? label : label + ', ' + delta!;
    return Semantics(
      container: true,
      label: value + ' ' + description,
      child: ExcludeSemantics(
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                CircleAvatar(
                  radius: 20,
                  backgroundColor: theme.colorScheme.secondaryContainer,
                  child: Icon(
                    icon,
                    size: 20,
                    color: theme.colorScheme.onSecondaryContainer,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Text(
                        value,
                        style: theme.textTheme.headlineSmall?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        label,
                        style: theme.textTheme.bodyMedium,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      if (delta != null) ...<Widget>[
                        const SizedBox(height: 2),
                        Text(
                          delta!,
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
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
`;

const CONFIRM_DIALOG = `import 'package:flutter/material.dart';

/// Shared confirmation dialog. Returns \`true\` only when the user confirms;
/// dismissing the dialog is always a "no".
Future<bool> showConfirmDialog(
  BuildContext context, {
  required String title,
  required String message,
  String confirmLabel = 'Delete',
}) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (dialogContext) {
      final theme = Theme.of(dialogContext);
      return AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            style: FilledButton.styleFrom(
              backgroundColor: theme.colorScheme.error,
              foregroundColor: theme.colorScheme.onError,
              minimumSize: const Size(48, 48),
            ),
            child: Text(confirmLabel),
          ),
        ],
      );
    },
  );
  return confirmed ?? false;
}
`;

const ICON_BUTTON = `import 'package:flutter/material.dart';

/// Icon-only button with the two things icon buttons usually miss:
/// a tooltip for pointer users and an explicit semantic label for screen
/// readers. Always at least 48x48 so it satisfies touch target guidance.
class AppIconButton extends StatelessWidget {
  const AppIconButton({
    super.key,
    required this.icon,
    required this.tooltip,
    required this.onPressed,
    this.color,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback? onPressed;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      enabled: onPressed != null,
      label: tooltip,
      child: ExcludeSemantics(
        child: IconButton(
          tooltip: tooltip,
          onPressed: onPressed,
          color: color,
          constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
          icon: Icon(icon),
        ),
      ),
    );
  }
}
`;

const INFO_ROW = `import 'package:flutter/material.dart';

/// Label-over-value metadata row. Stacking (instead of two columns) keeps long
/// values legible at 360dp and with large text scales.
class AppInfoRow extends StatelessWidget {
  const AppInfoRow({
    super.key,
    required this.label,
    required this.value,
    this.icon,
  });

  final String label;
  final Widget value;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (icon != null) ...<Widget>[
            Icon(icon, size: 20, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(width: 12),
          ],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  label,
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 4),
                DefaultTextStyle.merge(
                  style: theme.textTheme.bodyLarge,
                  child: value,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
`;

export function emitComponents(): GeneratedFile[] {
  return [
    { path: 'lib/ui/components/app_async_view.dart', content: ASYNC_VIEW, layer: 'ui' },
    { path: 'lib/ui/components/app_empty_state.dart', content: EMPTY_STATE, layer: 'ui' },
    { path: 'lib/ui/components/app_section_header.dart', content: SECTION_HEADER, layer: 'ui' },
    { path: 'lib/ui/components/app_stat_tile.dart', content: STAT_TILE, layer: 'ui' },
    { path: 'lib/ui/components/app_confirm_dialog.dart', content: CONFIRM_DIALOG, layer: 'ui' },
    { path: 'lib/ui/components/app_icon_button.dart', content: ICON_BUTTON, layer: 'ui' },
    { path: 'lib/ui/components/app_info_row.dart', content: INFO_ROW, layer: 'ui' },
  ];
}
