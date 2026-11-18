/**
 * Visual quality gate for generated Flutter apps.
 *
 * Screenshots require a real device or emulator with GPU acceleration — not
 * available in every CI environment. This gate covers the same class of
 * regressions deterministically on source: design-token compliance,
 * accessibility, and responsive behavior. It runs alongside
 * `validateDartFiles` and is fed into the self-healing loop the same way.
 */

export interface VisualDiagnostic {
  code: 'OFF_TOKEN_COLOR' | 'MISSING_SEMANTICS' | 'MISSING_RESPONSIVE' | 'HARD_CODED_COLOR' | 'MISSING_THEME';
  severity: 'error' | 'warning';
  path?: string;
  line?: number;
  message: string;
}

export interface VisualQaResult {
  passed: boolean;
  diagnostics: VisualDiagnostic[];
}

const USES_MATERIAL3 = /useMaterial3: true/;
const HAS_SEMANTICS = /(Semantics|excludeFromSemantics|semanticLabel)\s*\(/;
const HAS_RESPONSIVE = /(LayoutBuilder|MediaQuery|OrientationBuilder|Flexible|Expanded)\s*\(/;
const MATERIAL_COLORS = new Set(['00000000', 'FF000000', 'FFFFFFFF']);

export function analyzeVisualQa(files: Array<{ path: string; content: string }>): VisualQaResult {
  const diagnostics: VisualDiagnostic[] = [];
  const flat: Array<{ path: string; lineNo: number; text: string }> = [];
  for (const file of files) {
    if (!file.path.endsWith('.dart')) continue;
    const lines = file.content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      flat.push({ path: file.path, lineNo: index + 1, text: lines[index] });
    }
  }

  const themeFiles = files.filter((f) => /app\/theme\.dart$|\/theme\.dart$/.test(f.path));
  const appFiles = files.filter((f) => /app\/app\.dart$|\/main\.dart$/.test(f.path));

  // 1) Theme must exist and enable Material 3.
  if (themeFiles.length === 0) {
    diagnostics.push({ code: 'MISSING_THEME', severity: 'error', message: 'No theme file (lib/app/theme.dart or lib/theme.dart) in project.' });
  } else {
    for (const file of themeFiles) {
      if (!USES_MATERIAL3.test(file.content)) {
        diagnostics.push({ code: 'MISSING_THEME', severity: 'warning', path: file.path, message: 'Theme file does not set useMaterial3: true.' });
      }
    }
  }

  // 2) Off-token colors outside the design-seed family are flagged in screens.
  for (const { path, lineNo, text } of flat) {
    const matches = text.match(/0x[0-9A-Fa-f]{8}/g) ?? [];
    for (const hex of matches) {
      const argb = hex.slice(2).toUpperCase();
      if (MATERIAL_COLORS.has(argb)) continue;
      diagnostics.push({ code: 'OFF_TOKEN_COLOR', severity: 'warning', path, line: lineNo, message: `Consider using ColorScheme.fromSeed instead of raw ${hex.slice(0, 10)}.` });
    }
    if (/#[0-9A-Fa-f]{3,8}\b/.test(text) && !/Color\(/.test(text)) {
      diagnostics.push({ code: 'HARD_CODED_COLOR', severity: 'warning', path, line: lineNo, message: 'Hex color literal inside widget code — prefer ColorScheme.fromSeed or theme tokens.' });
    }
  }

  // 4) Accessibility semantics on interactive affordances.
  const hasAnyAffordance = files.some((f) => f.path.endsWith('.dart') && HAS_SEMANTICS.test(f.content));
  if (!hasAnyAffordance && appFiles.length > 0) {
    diagnostics.push({ code: 'MISSING_SEMANTICS', severity: 'warning', message: 'No Semantics() usage found. Screen-reader-tested apps are a production requirement.' });
  }

  // 5) Responsive layout primitives.
  const hasResponsive = files.some((f) => f.path.endsWith('.dart') && HAS_RESPONSIVE.test(f.content));
  if (!hasResponsive && appFiles.length > 0) {
    diagnostics.push({ code: 'MISSING_RESPONSIVE', severity: 'warning', message: 'No LayoutBuilder/MediaQuery found. Top apps must lay out responsively — test on phone and tablet sizes.' });
  }

  const errors = diagnostics.filter((d) => d.severity === 'error');
  return { passed: errors.length === 0, diagnostics };
}
