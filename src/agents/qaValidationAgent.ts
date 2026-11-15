import type { ProjectState, GateDiagnostic } from '../orchestrator/state';

const CRITICAL_FILES = ['pubspec.yaml', 'lib/main.dart', 'lib/app/app.dart', 'lib/core/router/app_router.dart', 'lib/app/app_theme.dart', 'lib/core/theme/app_theme.dart', 'analysis_options.yaml'];

export async function runQAValidationAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const files = state.generatedFiles;
  const diagnostics: GateDiagnostic[] = [];
  let hasErrors = false;

  // G1 — Critical files exist and are non-empty
  for (const critical of CRITICAL_FILES) {
    const f = files.get(critical);
    if (!f || f.content.trim().length < 20) {
      diagnostics.push({
        gate: 'G1-critical-files',
        level: 'error',
        message: `Critical file missing or empty: ${critical}`,
        filePath: critical,
        suggestion: `Generate ${critical} with complete content`,
      });
      hasErrors = true;
    }
  }

  // G2 — main.dart has runApp()
  const mainDart = files.get('lib/main.dart');
  if (mainDart && !mainDart.content.includes('runApp(')) {
    diagnostics.push({
      gate: 'G2-runapp',
      level: 'error',
      message: 'lib/main.dart does not call runApp()',
      filePath: 'lib/main.dart',
      suggestion: 'Add runApp(const App()) in main() function',
    });
    hasErrors = true;
  }

  // G3 — app.dart / app_router.dart reference GoRouter
  const appDart = files.get('lib/app/app.dart');
  if (appDart && !appDart.content.includes('MaterialApp')) {
    diagnostics.push({
      gate: 'G3-materialapp',
      level: 'error',
      message: 'lib/app/app.dart does not use MaterialApp',
      filePath: 'lib/app/app.dart',
      suggestion: 'Use MaterialApp.router() with GoRouter config',
    });
    hasErrors = true;
  }

  // G4 — All planned screens exist
  const screenFiles = [...files.keys()].filter((k) => k.startsWith('lib/features/') && k.endsWith('_screen.dart'));
  if (screenFiles.length === 0) {
    diagnostics.push({
      gate: 'G4-screens',
      level: 'error',
      message: 'No screen files found in lib/features/',
      filePath: 'lib/features/home/screens/home_screen.dart',
      suggestion: 'Generate screen files in lib/features/<name>/screens/',
    });
    hasErrors = true;
  }

  // G5 — No dead onPressed: null in screens
  for (const [path, file] of files) {
    if (path.endsWith('.dart')) {
      const deadControls = (file.content.match(/onPressed:\s*null/g) || []).length;
      if (deadControls > 0) {
        diagnostics.push({
          gate: 'G5-dead-controls',
          level: 'warning',
          message: `${deadControls} dead control(s) with onPressed: null`,
          filePath: path,
          suggestion: 'Replace onPressed: null with real handlers',
        });
      }

      // Check for placeholder text
      const placeholders = (file.content.match(/TODO|FIXME|placeholder|coming soon|not implemented/gi) || []).length;
      if (placeholders > 0) {
        diagnostics.push({
          gate: 'G5-placeholders',
          level: 'warning',
          message: `${placeholders} placeholder/TODO(s) found`,
          filePath: path,
          suggestion: 'Replace placeholder content with real implementation',
        });
      }
    }
  }

  // G6 — Supabase consistency
  const hasSupabase = [...files.values()].some(
    (f) => f.content.includes('supabase_flutter') || f.content.includes('Supabase.initialize')
  );
  const hasSupabaseService = files.has('lib/core/services/supabase_service.dart') || files.has('lib/core/services/auth_service.dart');
  if (hasSupabase && !hasSupabaseService) {
    diagnostics.push({
      gate: 'G6-supabase',
      level: 'error',
      message: 'Supabase imported but SupabaseService/AuthService not found',
      filePath: 'lib/core/services/supabase_service.dart',
      suggestion: 'Generate supabase_service.dart and auth_service.dart',
    });
    hasErrors = true;
  }

  // G7 — pubspec.yaml has correct SDK constraint
  const pubspec = files.get('pubspec.yaml');
  if (pubspec) {
    if (!pubspec.content.includes('sdk:')) {
      diagnostics.push({
        gate: 'G7-pubspec',
        level: 'error',
        message: 'pubspec.yaml missing sdk environment constraint',
        filePath: 'pubspec.yaml',
        suggestion: "Add: environment:\n  sdk: '>=3.3.0 <4.0.0'",
      });
      hasErrors = true;
    }
  }

  const errorCount = diagnostics.filter((d) => d.level === 'error').length;
  const warnCount = diagnostics.filter((d) => d.level === 'warning').length;

  return {
    diagnostics,
    repairAttempts: state.repairAttempts,
    logs: [
      ...state.logs,
      `[QA Validation Agent] Gates: ${errorCount} errors, ${warnCount} warnings. Files checked: ${files.size}. ${!hasErrors ? '✅ All critical gates passed.' : '❌ Errors require repair.'}`,
    ],
  };
}
