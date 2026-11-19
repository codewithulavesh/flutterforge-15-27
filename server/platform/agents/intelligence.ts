/**
 * Intelligence agents — observability and internationalisation.
 *
 * These are the capabilities teams add last and regret not having first:
 * knowing when the app breaks, and being able to translate it.
 */
import type { AgentDefinition, AgentFinding } from './types.js';
import {
  capFindings,
  countMatches,
  finding,
  libFiles,
  parsePubspec,
  stripDart,
} from './shared.js';

export const observabilityEngineerAgent: AgentDefinition = {
  id: 'observability-engineer',
  name: 'Bea',
  title: 'Observability Engineer',
  department: 'intelligence',
  description: 'Verifies the app can report its own failures: global error hooks, a logging seam and a crash/analytics integration point.',
  capabilities: ['error-hooks', 'logging', 'crash-reporting', 'analytics-seam'],
  mode: 'deterministic',
  run(context) {
    const findings: AgentFinding[] = [];
    const files = libFiles(context);
    if (files.length === 0) return findings;
    const corpus = files.map((file) => stripDart(file.content)).join('\n');

    const hasGlobalErrorHook = /\bFlutterError\.onError\b|\brunZonedGuarded\b|PlatformDispatcher\.instance\.onError/.test(corpus);
    if (!hasGlobalErrorHook) {
      findings.push(finding('OBS_NO_GLOBAL_ERROR_HOOK', 'major', 'No global error hook — uncaught framework errors disappear on release builds.', {
        suggestion: 'Set FlutterError.onError and PlatformDispatcher.instance.onError (or runZonedGuarded) in main().',
      }));
    }

    if (!/\bErrorWidget\.builder\b/.test(corpus)) {
      findings.push(finding('OBS_NO_ERROR_WIDGET', 'minor', 'No ErrorWidget.builder override — a widget exception shows Flutter’s red/grey screen.', {
        suggestion: 'Render a branded, non-leaking fallback in release builds.',
      }));
    }

    const hasLogger = /\bdeveloper\.log\b|\bAppLogger\b|\bLogger\b|\babstract\s+class\s+\w*Log\w*/i.test(corpus);
    if (!hasLogger) {
      findings.push(finding('OBS_NO_LOGGING_SEAM', 'minor', 'No logging seam was found (developer.log or a logger abstraction).', {
        suggestion: 'Route diagnostics through one logger so levels and sinks are controllable.',
      }));
    }

    const pubspec = parsePubspec(context.pubspec);
    const deps = new Set([...pubspec.dependencies.keys(), ...pubspec.devDependencies.keys()]);
    const hasCrashSink = [...deps].some((dep) => /sentry|crashlytics|firebase_crashlytics|datadog|bugsnag/.test(dep));
    if (!hasCrashSink) {
      findings.push(finding('OBS_NO_CRASH_SINK', 'info', 'No crash reporting dependency is declared.', {
        suggestion: 'Wire a crash sink before a production release; local logs are not enough.',
      }));
    }

    const hasAnalytics = [...deps].some((dep) => /analytics|posthog|amplitude|mixpanel|segment/.test(dep));
    if (!hasAnalytics) {
      findings.push(finding('OBS_NO_ANALYTICS', 'info', 'No product analytics dependency is declared.', {
        suggestion: 'Add an analytics seam if activation/retention matter to the product.',
      }));
    }

    return capFindings(findings);
  },
};

export const i18nEngineerAgent: AgentDefinition = {
  id: 'i18n-engineer',
  name: 'Lea',
  title: 'Internationalisation Engineer',
  department: 'intelligence',
  description: 'Measures hardcoded UI copy and RTL/locale hazards, and reports whether the app is structurally translatable.',
  capabilities: ['l10n-readiness', 'hardcoded-copy', 'rtl-safety'],
  mode: 'deterministic',
  run(context) {
    const findings: AgentFinding[] = [];
    const files = libFiles(context);
    if (files.length === 0) return findings;

    const pubspec = parsePubspec(context.pubspec);
    const hasFlutterLocalizations = pubspec.dependencies.has('flutter_localizations')
      || context.files.some((file) => file.path.endsWith('l10n.yaml'))
      || context.files.some((file) => file.path.endsWith('.arb'))
      || files.some((file) => /\/l10n\//.test(file.path));

    let literalWidgets = 0;
    let literalFile: string | null = null;
    let directionalInsets = 0;
    for (const file of files) {
      const literals = countMatches(file.content, /\b(?:Text|SelectableText)\s*\(\s*(?:const\s+)?['"][^'"]{2,}['"]/g);
      if (literals > 0 && !literalFile) literalFile = file.path;
      literalWidgets += literals;
      directionalInsets += countMatches(stripDart(file.content), /\bEdgeInsets\.only\s*\(\s*(?:left|right)\s*:/g);
      directionalInsets += countMatches(stripDart(file.content), /\bAlignment\.(?:centerLeft|centerRight)\b/g);
    }

    if (!hasFlutterLocalizations) {
      findings.push(finding('I18N_NO_LOCALIZATION', 'info', 'No localization setup (flutter_localizations/l10n.yaml/.arb) was found.', {
        suggestion: 'Add gen-l10n now if the product will ever ship in more than one language.',
      }));
    }

    if (literalWidgets > 100) {
      findings.push(finding('I18N_HARDCODED_COPY', 'major', `${literalWidgets} user-facing strings are hardcoded in widgets.`, {
        file: literalFile ?? undefined,
        suggestion: 'Move copy into an l10n resource now; retrofitting thousands of strings is far more expensive.',
      }));
    } else if (literalWidgets > 25 && !hasFlutterLocalizations) {
      findings.push(finding('I18N_HARDCODED_COPY_SMALL', 'minor', `${literalWidgets} user-facing strings are hardcoded and there is no l10n setup.`, {
        file: literalFile ?? undefined,
      }));
    }

    if (directionalInsets > 0) {
      findings.push(finding('I18N_RTL_HAZARD', 'minor', `${directionalInsets} left/right-only layout value(s) break under RTL.`, {
        suggestion: 'Use start/end variants (EdgeInsetsDirectional, AlignmentDirectional, textDirection-aware padding).',
      }));
    }

    return capFindings(findings);
  },
};
