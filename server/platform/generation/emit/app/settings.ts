/**
 * App settings state.
 *
 * The generated app deliberately ships without a storage package, so the
 * preference lives in memory for the session. The controller still owns the
 * full contract the settings UI compiles against: `themeMode`, `isDark`,
 * `setThemeMode` and `toggleTheme`.
 */

export const APP_SETTINGS_FILE = 'lib/state/app_settings_controller.dart';

export function appSettingsControllerDart(): string {
  return `import 'package:flutter/material.dart';

/// Owns the app-wide theme preference for the lifetime of the process.
///
/// The generated app has no persistence dependency, so the choice resets on a
/// cold start. Keeping the controller in memory means every theme change is
/// synchronous for the UI and never waits on storage or the network.
class AppSettingsController extends ChangeNotifier {
  AppSettingsController({ThemeMode initialThemeMode = ThemeMode.system})
      : _themeMode = initialThemeMode;

  ThemeMode _themeMode;

  /// The mode the user has chosen. Defaults to [ThemeMode.system].
  ThemeMode get themeMode => _themeMode;

  /// True when the effective theme is dark.
  ///
  /// [ThemeMode.system] follows the platform brightness. MaterialApp responds to
  /// live platform changes; this getter is for switch state and descriptive
  /// labels in settings.
  bool get isDark => switch (_themeMode) {
        ThemeMode.dark => true,
        ThemeMode.light => false,
        ThemeMode.system =>
          WidgetsBinding.instance.platformDispatcher.platformBrightness ==
              Brightness.dark,
      };

  /// Applies [mode] and notifies listeners only when the value changes.
  Future<void> setThemeMode(ThemeMode mode) {
    if (_themeMode == mode) {
      return Future<void>.value();
    }
    _themeMode = mode;
    notifyListeners();
    return Future<void>.value();
  }

  /// Flips to the opposite of the currently effective brightness.
  Future<void> toggleTheme() {
    return setThemeMode(isDark ? ThemeMode.light : ThemeMode.dark);
  }
}
`;
}
