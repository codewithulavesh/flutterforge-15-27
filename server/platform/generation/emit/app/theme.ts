/**
 * Material 3 theme emitter.
 *
 * Design tokens come from the spec, never from arbitrary literals: spacing is
 * derived from `spec.design.spacing`, radii from `spec.design.radii` and colour
 * from the seed/accent pair. Both light and dark themes are emitted together so
 * the settings controller can switch at runtime.
 */
import type { AppSpec, DesignSpec } from '../../contracts.js';
import { dartColor, normalizeHex, radiusOf, spacingScale } from '../shared.js';

/** Relative luminance of an `#RRGGBB` value, used to pick readable accent text. */
function luminance(hex: string): number {
  const raw = normalizeHex(hex).slice(1);
  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(raw.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function radiusKeys(design: DesignSpec): { card: 'sm' | 'md' | 'lg' | 'xl'; control: 'sm' | 'md' | 'lg' | 'xl' } {
  if (design.shape === 'soft') return { card: 'xl', control: 'lg' };
  if (design.shape === 'square') return { card: 'sm', control: 'sm' };
  return { card: 'lg', control: 'md' };
}

function textThemeDart(): string {
  return `TextTheme _textThemeFor(Brightness brightness) {
  final Typography typography = Typography.material2021(
    platform: TargetPlatform.android,
  );
  final TextTheme base =
      brightness == Brightness.dark ? typography.white : typography.black;
  return base.copyWith(
    displaySmall: base.displaySmall?.copyWith(
      fontWeight: FontWeight.w700,
      letterSpacing: -0.8,
      height: 1.1,
    ),
    headlineMedium: base.headlineMedium?.copyWith(
      fontWeight: FontWeight.w700,
      letterSpacing: -0.5,
      height: 1.15,
    ),
    headlineSmall: base.headlineSmall?.copyWith(
      fontWeight: FontWeight.w700,
      letterSpacing: -0.3,
      height: 1.2,
    ),
    titleLarge: base.titleLarge?.copyWith(
      fontWeight: FontWeight.w600,
      letterSpacing: -0.2,
      height: 1.25,
    ),
    titleMedium: base.titleMedium?.copyWith(
      fontWeight: FontWeight.w600,
      letterSpacing: 0,
    ),
    titleSmall: base.titleSmall?.copyWith(
      fontWeight: FontWeight.w600,
      letterSpacing: 0.1,
    ),
    bodyLarge: base.bodyLarge?.copyWith(
      height: 1.5,
      letterSpacing: 0.1,
    ),
    bodyMedium: base.bodyMedium?.copyWith(
      height: 1.45,
      letterSpacing: 0.1,
    ),
    bodySmall: base.bodySmall?.copyWith(
      height: 1.4,
      letterSpacing: 0.2,
    ),
    labelLarge: base.labelLarge?.copyWith(
      fontWeight: FontWeight.w600,
      letterSpacing: 0.2,
    ),
    labelMedium: base.labelMedium?.copyWith(
      fontWeight: FontWeight.w500,
      letterSpacing: 0.3,
    ),
    labelSmall: base.labelSmall?.copyWith(
      fontWeight: FontWeight.w500,
      letterSpacing: 0.3,
    ),
  );
}`;
}

export function themeDart(spec: AppSpec): string {
  const design = spec.design;
  const space = spacingScale(design);
  const radii = design.radii ?? { sm: 4, md: 12, lg: 20, xl: 28 };
  const keys = radiusKeys(design);
  const accent = String(design.accentColor ?? '').trim();
  const hasAccent = /^#[0-9a-fA-F]{6}$/.test(accent);
  const accentOn = hasAccent ? (luminance(accent) > 0.45 ? '#000000' : '#FFFFFF') : '#FFFFFF';

  const accentConstants = hasAccent
    ? `const Color appAccentColor = ${dartColor(accent)};
const Color appAccentOnColor = ${dartColor(accentOn)};
`
    : '';

  const schemeBody = hasAccent
    ? `  final ColorScheme scheme = ColorScheme.fromSeed(
    seedColor: appSeedColor,
    brightness: brightness,
  );
  return scheme.copyWith(
    secondary: appAccentColor,
    onSecondary: appAccentOnColor,
  );`
    : `  return ColorScheme.fromSeed(
    seedColor: appSeedColor,
    brightness: brightness,
  );`;

  return `import 'package:flutter/material.dart';

// ── design tokens ─────────────────────────────────────────────────────────

/// Spacing scale in logical pixels, compiled from the product spec.
const double appSpaceXs = ${space.xs};
const double appSpaceSm = ${space.sm};
const double appSpaceMd = ${space.md};
const double appSpaceLg = ${space.lg};
const double appSpaceXl = ${space.xl};
const double appSpaceXxl = ${space.xxl};

/// Corner radii in logical pixels, compiled from the product spec.
const double appRadiusSm = ${radii.sm};
const double appRadiusMd = ${radii.md};
const double appRadiusLg = ${radii.lg};
const double appRadiusXl = ${radii.xl};

/// The card and control corners selected by the spec's shape language.
const double appRadiusCard = ${radiusOf(design, keys.card)};
const double appRadiusControl = ${radiusOf(design, keys.control)};

/// Minimum touch target, matching Material accessibility guidance.
const double appTouchTarget = 48;

const Color appSeedColor = ${dartColor(design.seedColor)};
${accentConstants}
// ── themes ────────────────────────────────────────────────────────────────

ColorScheme _schemeFor(Brightness brightness) {
${schemeBody}
}

${textThemeDart()}

ThemeData _buildTheme(Brightness brightness) {
  final ColorScheme scheme = _schemeFor(brightness);
  final bool isDark = brightness == Brightness.dark;
  final TextTheme textTheme = _textThemeFor(brightness);
  final BorderRadius controlRadius = BorderRadius.circular(appRadiusControl);
  final BorderRadius cardRadius = BorderRadius.circular(appRadiusCard);

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    brightness: brightness,
    visualDensity: VisualDensity.standard,
    materialTapTargetSize: MaterialTapTargetSize.padded,
    scaffoldBackgroundColor: scheme.surface,
    canvasColor: scheme.surface,
    dividerColor: scheme.outlineVariant,
    textTheme: textTheme,
    primaryTextTheme: textTheme.apply(
      bodyColor: scheme.onPrimary,
      displayColor: scheme.onPrimary,
    ),
    appBarTheme: AppBarThemeData(
      backgroundColor: scheme.surface,
      foregroundColor: scheme.onSurface,
      surfaceTintColor: scheme.surfaceTint,
      elevation: 0,
      scrolledUnderElevation: 1,
      centerTitle: false,
      titleTextStyle: textTheme.titleLarge?.copyWith(color: scheme.onSurface),
    ),
    cardTheme: CardThemeData(
      color: isDark
          ? scheme.surfaceContainerHigh
          : scheme.surfaceContainerLowest,
      surfaceTintColor: Colors.transparent,
      shadowColor: scheme.shadow,
      elevation: 0,
      margin: const EdgeInsets.all(appSpaceMd),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: cardRadius,
        side: BorderSide(color: scheme.outlineVariant),
      ),
    ),
    inputDecorationTheme: InputDecorationThemeData(
      filled: true,
      fillColor: scheme.surfaceContainerHighest,
      contentPadding: const EdgeInsets.symmetric(
        horizontal: appSpaceLg,
        vertical: appSpaceMd,
      ),
      border: OutlineInputBorder(
        borderRadius: controlRadius,
        borderSide: BorderSide.none,
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: controlRadius,
        borderSide: BorderSide(color: scheme.outlineVariant),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: controlRadius,
        borderSide: BorderSide(color: scheme.primary, width: 1.5),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: controlRadius,
        borderSide: BorderSide(color: scheme.error),
      ),
      focusedErrorBorder: OutlineInputBorder(
        borderRadius: controlRadius,
        borderSide: BorderSide(color: scheme.error, width: 1.5),
      ),
      disabledBorder: OutlineInputBorder(
        borderRadius: controlRadius,
        borderSide: BorderSide(color: scheme.outlineVariant),
      ),
      labelStyle: textTheme.bodyMedium?.copyWith(
        color: scheme.onSurfaceVariant,
      ),
      hintStyle: textTheme.bodyMedium?.copyWith(
        color: scheme.onSurfaceVariant,
      ),
      prefixIconColor: scheme.onSurfaceVariant,
      suffixIconColor: scheme.onSurfaceVariant,
      errorStyle: textTheme.bodySmall?.copyWith(color: scheme.error),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: scheme.primary,
        foregroundColor: scheme.onPrimary,
        minimumSize: const Size(0, appTouchTarget),
        padding: const EdgeInsets.symmetric(
          horizontal: appSpaceXl,
          vertical: appSpaceMd,
        ),
        shape: RoundedRectangleBorder(borderRadius: controlRadius),
        textStyle: textTheme.labelLarge?.copyWith(
          fontWeight: FontWeight.w600,
          letterSpacing: 0.2,
        ),
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      height: 72,
      backgroundColor: scheme.surfaceContainer,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      indicatorColor: scheme.secondaryContainer,
      indicatorShape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(appRadiusControl),
      ),
      labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
      labelPadding: const EdgeInsets.symmetric(horizontal: appSpaceXs),
      labelTextStyle: WidgetStateProperty.resolveWith<TextStyle?>(
        (Set<WidgetState> states) {
          final TextStyle? label = textTheme.labelSmall;
          if (states.contains(WidgetState.selected)) {
            return label?.copyWith(
              color: scheme.onSurface,
              fontWeight: FontWeight.w600,
            );
          }
          return label?.copyWith(
            color: scheme.onSurfaceVariant,
            fontWeight: FontWeight.w500,
          );
        },
      ),
      iconTheme: WidgetStateProperty.resolveWith<IconThemeData?>(
        (Set<WidgetState> states) {
          return IconThemeData(
            size: 24,
            color: states.contains(WidgetState.selected)
                ? scheme.onSecondaryContainer
                : scheme.onSurfaceVariant,
          );
        },
      ),
    ),
    navigationRailTheme: NavigationRailThemeData(
      backgroundColor: scheme.surfaceContainer,
      elevation: 0,
      indicatorColor: scheme.secondaryContainer,
      indicatorShape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(appRadiusControl),
      ),
      selectedIconTheme: IconThemeData(
        color: scheme.onSecondaryContainer,
      ),
      unselectedIconTheme: IconThemeData(
        color: scheme.onSurfaceVariant,
      ),
      selectedLabelTextStyle: textTheme.labelLarge?.copyWith(
        color: scheme.onSurface,
        fontWeight: FontWeight.w600,
      ),
      unselectedLabelTextStyle: textTheme.labelLarge?.copyWith(
        color: scheme.onSurfaceVariant,
      ),
    ),
    dividerTheme: DividerThemeData(
      color: scheme.outlineVariant,
      thickness: 1,
      space: 1,
    ),
    listTileTheme: ListTileThemeData(
      contentPadding: const EdgeInsets.symmetric(
        horizontal: appSpaceLg,
        vertical: appSpaceXs,
      ),
      minLeadingWidth: 24,
      iconColor: scheme.onSurfaceVariant,
      textColor: scheme.onSurface,
      titleTextStyle: textTheme.titleMedium,
      subtitleTextStyle: textTheme.bodyMedium?.copyWith(
        color: scheme.onSurfaceVariant,
      ),
      shape: RoundedRectangleBorder(borderRadius: controlRadius),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: scheme.inverseSurface,
      contentTextStyle: textTheme.bodyMedium?.copyWith(
        color: scheme.onInverseSurface,
      ),
      actionTextColor: scheme.inversePrimary,
      elevation: 4,
      shape: RoundedRectangleBorder(borderRadius: controlRadius),
      insetPadding: const EdgeInsets.all(appSpaceLg),
    ),
  );
}

/// The light theme. Uses the spec seed and accent at light brightness.
ThemeData buildLightTheme() => _buildTheme(Brightness.light);

/// The dark theme. Uses the same seed and accent at dark brightness.
ThemeData buildDarkTheme() => _buildTheme(Brightness.dark);
`;
}
