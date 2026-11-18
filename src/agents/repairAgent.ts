import type { ProjectState, GeneratedFile, GateDiagnostic } from '../orchestrator/state';
import { callLLMText, agentModelFor } from './llmClient';
import { enforceProjectContract } from './projectContract';

/** Max chars of a file we inline into a repair prompt verbatim. */
const MAX_INLINE_CONTENT_CHARS = 12_000;
/** Lines kept from the top of an oversized file. */
const HEAD_LINES = 200;
/** Half-window (in lines) kept around each diagnostic's line. */
const ERROR_WINDOW_RADIUS = 60;
/** Hard cap for the truncated content block, keeping prompts token-cheap. */
const MAX_TRUNCATED_CONTENT_CHARS = 13_000;

function languageFor(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.dart')) return 'dart';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.sql')) return 'sql';
  return 'text';
}

function diagnosticFilePath(d: GateDiagnostic): string {
  return (d.filePath ?? d.file ?? '').trim();
}

/** `code` is not part of GateDiagnostic yet — fall back to the gate id. */
function diagnosticCode(d: GateDiagnostic): string {
  const withCode = d as GateDiagnostic & { code?: unknown };
  const raw = withCode.code ?? d.gate ?? '';
  return String(raw);
}

/** Stable identity for a diagnostic: `${level}|${code}|${filePath}|${message}`. */
export function repairFingerprint(d: GateDiagnostic): string {
  return `${d.level}|${diagnosticCode(d)}|${diagnosticFilePath(d)}|${d.message}`;
}

function fingerprintSet(diags: GateDiagnostic[]): string[] {
  return [...new Set(diags.map(repairFingerprint))].sort();
}

function sameFingerprintSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Per-file fingerprint sets recorded by the previous repair pass (via state). */
function readRecordedFingerprints(state: ProjectState): Record<string, string[]> {
  const raw = (state as Record<string, unknown>)._repairFingerprints;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [filePath, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      out[filePath] = value.map((v) => String(v)).sort();
    }
  }
  return out;
}

interface PromptContent {
  text: string;
  truncated: boolean;
}

/**
 * Token-budget guard: files larger than MAX_INLINE_CONTENT_CHARS are reduced to
 * the first HEAD_LINES lines plus a ±ERROR_WINDOW_RADIUS line window around each
 * diagnostic's line, joined with `// ... (truncated)` markers.
 */
function buildPromptContent(existing: string, fileDiags: GateDiagnostic[]): PromptContent {
  if (existing.length <= MAX_INLINE_CONTENT_CHARS) {
    return { text: existing, truncated: false };
  }
  const lines = existing.split('\n');
  const total = lines.length;
  const ranges: Array<[number, number]> = [[0, Math.min(HEAD_LINES, total)]];
  const errorLines = fileDiags
    .map((d) => d.line)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 1);
  for (const lineNo of errorLines) {
    const idx = lineNo - 1;
    ranges.push([
      Math.max(0, idx - ERROR_WINDOW_RADIUS),
      Math.min(total, idx + ERROR_WINDOW_RADIUS + 1),
    ]);
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  const parts: string[] = [];
  for (let i = 0; i < merged.length; i += 1) {
    if (i > 0) parts.push('// ... (truncated)');
    parts.push(lines.slice(merged[i][0], merged[i][1]).join('\n'));
  }
  if (merged[merged.length - 1][1] < total) {
    parts.push('// ... (truncated)');
  }
  let text = parts.join('\n');
  if (text.length > MAX_TRUNCATED_CONTENT_CHARS) {
    text = `${text.slice(0, MAX_TRUNCATED_CONTENT_CHARS)}\n// ... (truncated)`;
  }
  return { text, truncated: true };
}

const DART_TOKEN_LINE =
  /^\s*(import|part|library|abstract|class|final|void\s+main|@|export|typedef|enum|mixin|extension)\b/;
const FENCE_BLOCK = /```[^\n`]*\n([\s\S]*?)```/;
const TRAILING_FENCE = /\n?```[A-Za-z]*\s*$/;

/**
 * Tolerant extraction of the candidate file body from raw LLM output.
 * Accepts a fenced code block, or raw file content where leading prose is
 * skipped by locating the first Dart-looking token line. Returns null when
 * no usable file body can be located (non-Dart files fall back to the raw
 * text itself, since their first line carries no Dart token).
 */
function extractCandidateFile(raw: string, filePath: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const fence = FENCE_BLOCK.exec(text);
  if (fence) {
    const inner = fence[1].trim();
    return inner.length > 0 ? inner : null;
  }
  if (!filePath.toLowerCase().endsWith('.dart')) {
    const candidate = text.replace(TRAILING_FENCE, '').trim();
    return candidate.length > 0 ? candidate : null;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (DART_TOKEN_LINE.test(lines[i])) {
      const candidate = lines.slice(i).join('\n').replace(TRAILING_FENCE, '').trim();
      return candidate.length > 0 ? candidate : null;
    }
  }
  return null;
}

const CLOSE_TO_OPEN: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

type ScanState =
  | 'code'
  | 'lineComment'
  | 'blockComment'
  | 'singleQuote'
  | 'doubleQuote'
  | 'tripleSingle'
  | 'tripleDouble';

/** Full Dart-aware scan: strings, comments, nested block comments, brackets. */
function isDartDelimiterBalanced(source: string): boolean {
  const stack: string[] = [];
  let state: ScanState = 'code';
  let blockDepth = 0;
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source.charAt(i);
    const next = source.charAt(i + 1);
    const next2 = source.charAt(i + 2);

    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'lineComment'; i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'blockComment'; blockDepth = 1; i += 2; continue; }
      if (ch === "'") {
        if (next === "'" && next2 === "'") { state = 'tripleSingle'; i += 3; continue; }
        state = 'singleQuote'; i += 1; continue;
      }
      if (ch === '"') {
        if (next === '"' && next2 === '"') { state = 'tripleDouble'; i += 3; continue; }
        state = 'doubleQuote'; i += 1; continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
      else if (ch === ')' || ch === ']' || ch === '}') {
        const open = stack.pop();
        if (open !== CLOSE_TO_OPEN[ch]) return false;
      }
      i += 1;
      continue;
    }

    if (state === 'lineComment') {
      if (ch === '\n') state = 'code';
      i += 1;
      continue;
    }

    if (state === 'blockComment') {
      if (ch === '/' && next === '*') { blockDepth += 1; i += 2; continue; }
      if (ch === '*' && next === '/') {
        blockDepth -= 1;
        if (blockDepth === 0) state = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (state === 'singleQuote' || state === 'doubleQuote') {
      const quote = state === 'singleQuote' ? "'" : '"';
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) { state = 'code'; i += 1; continue; }
      // Single-line strings cannot span a newline in Dart.
      if (ch === '\n') return false;
      i += 1;
      continue;
    }

    if (state === 'tripleSingle') {
      if (ch === "'" && next === "'" && next2 === "'") { state = 'code'; i += 3; continue; }
      i += 1;
      continue;
    }

    // tripleDouble
    if (ch === '"' && next === '"' && next2 === '"') { state = 'code'; i += 3; continue; }
    i += 1;
  }
  if (state !== 'code' && state !== 'lineComment') return false;
  return stack.length === 0;
}

/** Bracket-only scan for non-Dart candidates (yaml/sql have no string rules). */
function isBracketBalanced(source: string): boolean {
  const stack: string[] = [];
  for (const ch of source) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch === ')' || ch === ']' || ch === '}') {
      const open = stack.pop();
      if (open !== CLOSE_TO_OPEN[ch]) return false;
    }
  }
  return stack.length === 0;
}

/** Local structural sanity check applied to every repair candidate. */
function candidatePassesDelimiterCheck(candidate: string, filePath: string): boolean {
  if (filePath.toLowerCase().endsWith('.dart')) {
    return isDartDelimiterBalanced(candidate);
  }
  return isBracketBalanced(candidate);
}

export async function runRepairAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const cycle = state.repairAttempts + 1;
  const files = new Map<string, GeneratedFile>(state.generatedFiles);
  const errorDiags = state.diagnostics.filter((d) => d.level === 'error');

  if (errorDiags.length === 0) {
    return {
      repairAttempts: state.repairAttempts + 1,
      logs: [...state.logs, `[Repair Agent] No errors to repair.`],
    };
  }

  const appName = state.productBrief?.appName || 'App';
  const pkgName = appName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
  const repaired: string[] = [];
  const passLogs: string[] = [];

  // Group error diagnostics by file; repair scope = those files only.
  const diagsByFile = new Map<string, GateDiagnostic[]>();
  for (const diag of errorDiags) {
    const filePath = diagnosticFilePath(diag);
    if (!filePath) continue;
    const bucket = diagsByFile.get(filePath);
    if (bucket) bucket.push(diag);
    else diagsByFile.set(filePath, [diag]);
  }

  // Deterministic scope ordering — stable diffs across runs.
  const scopedFiles = [...diagsByFile.keys()].sort();

  // Fingerprint sets for THIS pass's diagnostics (recorded for the next pass
  // so it can detect a no-op repair loop and bail out early).
  const currentFingerprints: Record<string, string[]> = {};
  for (const filePath of scopedFiles) {
    currentFingerprints[filePath] = fingerprintSet(diagsByFile.get(filePath) ?? []);
  }
  const previousFingerprints = readRecordedFingerprints(state);

  let llmCalls = 0;
  let oscillations = 0;
  let parseFailures = 0;

  for (const filePath of scopedFiles) {
    const fileDiags = diagsByFile.get(filePath) ?? [];

    // Oscillation guard: identical diagnostics to a previous pass → repairing
    // again would burn tokens without progress. Keep the file unchanged.
    const previous = previousFingerprints[filePath];
    if (previous && sameFingerprintSet(previous, currentFingerprints[filePath])) {
      passLogs.push(`[Repair Agent] oscillation detected for ${filePath}; keeping previous content`);
      oscillations += 1;
      continue;
    }

    const existing = files.get(filePath)?.content ?? '';
    const { text: promptContent, truncated } = buildPromptContent(existing, fileDiags);
    const diagnosticsBlock = fileDiags
      .map((d, idx) => {
        const at = typeof d.line === 'number' ? ` (line ${d.line})` : '';
        const suggestion = d.suggestion ? `\n   suggestion: ${d.suggestion}` : '';
        return `${idx + 1}. [${d.gate}] ${d.message}${at}${suggestion}`;
      })
      .join('\n');

    // Exactly one LLM call per diagnostics-file pair per pass.
    llmCalls += 1;
    try {
      const raw = await callLLMText(
        [
          {
            role: 'system',
            content: `You are the Repair Agent for FlutterForge. Fix Flutter/Dart code issues.

RULES:
1. Output ONLY the corrected file content — no explanations, no markdown fences
2. The file must compile cleanly
3. Keep all existing functionality — only fix the specific error
4. Use correct Flutter/Dart imports`,
          },
          {
            role: 'user',
            content: `Repair this Flutter file for "${appName}" (package: ${pkgName}).

File path: ${filePath}
Error diagnostics for this file (${fileDiags.length}):
${diagnosticsBlock}

Current content${truncated ? ' (truncated)' : ''}:
${promptContent || '(empty — create from scratch)'}

Output the complete, fixed file content:`,
          },
        ],
        {
          model: agentModelFor('repair'),
          temperature: 0.1,
          maxTokens: 3000,
        }
      );

      const candidate = extractCandidateFile(raw, filePath);
      if (!candidate || !candidatePassesDelimiterCheck(candidate, filePath)) {
        // Never write a corrupt candidate — leave the file untouched.
        passLogs.push(`[Repair Agent] repair parse failed for ${filePath}; left unchanged`);
        parseFailures += 1;
        continue;
      }

      files.set(filePath, {
        path: filePath,
        content: candidate,
        action: existing ? 'modified' : 'created',
        language: languageFor(filePath),
      });
      repaired.push(filePath);
    } catch (err) {
      console.warn(`[RepairAgent] LLM repair failed for ${filePath}:`, err);
      // Structural fallback repairs
      await applyStructuralRepair(files, filePath, fileDiags[0], appName, pkgName);
      repaired.push(`${filePath} (structural)`);
    }
  }

  passLogs.push(
    `[Repair Agent] Cycle ${cycle}: ${llmCalls} LLM call(s) made this pass (${scopedFiles.length} file(s) scoped, ${oscillations} oscillation(s), ${parseFailures} parse failure(s)).`
  );

  // Also check for critical missing files and backfill
  const critical = [
    'pubspec.yaml',
    'lib/main.dart',
    'lib/app/app.dart',
    'lib/core/router/app_router.dart',
    'lib/app/app_theme.dart',
  ];
  for (const c of critical) {
    if (!files.has(c) || (files.get(c)?.content || '').trim().length < 20) {
      const content = getMinimalFallback(c, appName, pkgName);
      if (content) {
        files.set(c, { path: c, content, action: 'created', language: c.endsWith('.dart') ? 'dart' : 'yaml' });
        repaired.push(`${c} (backfilled)`);
      }
    }
  }

  // Ensure at least one home screen exists if missing
  const hasScreens = [...files.keys()].some((k) => k.startsWith('lib/features/') && k.endsWith('_screen.dart'));
  if (!hasScreens) {
    const homeScreenPath = 'lib/features/home/screens/home_screen.dart';
    const content = getMinimalFallback(homeScreenPath, appName, pkgName);
    if (content) {
      files.set(homeScreenPath, { path: homeScreenPath, content, action: 'created', language: 'dart' });
      repaired.push(`${homeScreenPath} (backfilled)`);
    }
  }

  // Ensure SupabaseService exists if supabase is referenced
  const usesSupabase = [...files.values()].some((f) => f.content.includes('supabase_flutter') || f.content.includes('Supabase.initialize'));
  if (usesSupabase && !files.has('lib/core/services/supabase_service.dart')) {
    const supabaseServicePath = 'lib/core/services/supabase_service.dart';
    const content = getMinimalFallback(supabaseServicePath, appName, pkgName);
    if (content) {
      files.set(supabaseServicePath, { path: supabaseServicePath, content, action: 'created', language: 'dart' });
      repaired.push(`${supabaseServicePath} (backfilled)`);
    }
  }

  const contract = enforceProjectContract(files, {
    appName,
    pkgName,
    usesSupabase,
  });

  return {
    generatedFiles: contract.files,
    // Keep the diagnostics. QA recomputes them against the repaired files;
    // clearing them here made a failed final repair look successful.
    diagnostics: state.diagnostics,
    repairAttempts: state.repairAttempts + 1,
    logs: [
      ...state.logs,
      ...passLogs,
      `[Repair Agent] Cycle ${cycle}: Repaired ${repaired.length} files: ${repaired.join(', ')}`,
      ...(contract.changes.length > 0 ? [`[Project Contract] ${contract.changes.slice(0, 6).join('; ')}`] : []),
    ],
    // Recorded for the next pass — the oscillation guard compares against it.
    _repairFingerprints: currentFingerprints,
  };
}

async function applyStructuralRepair(
  files: Map<string, GeneratedFile>,
  filePath: string,
  diag: { gate: string; message: string; level?: string; filePath?: string },
  appName: string,
  pkgName: string
): Promise<void> {
  // Fix missing runApp
  if (diag.gate === 'G2-runapp' && filePath === 'lib/main.dart') {
    const existing = files.get('lib/main.dart')?.content || '';
    if (!existing.includes('runApp(')) {
      files.set('lib/main.dart', {
        path: 'lib/main.dart',
        content: `import 'package:flutter/material.dart';\nimport 'package:${pkgName}/app/app.dart';\n\nvoid main() async {\n  WidgetsFlutterBinding.ensureInitialized();\n  runApp(const App());\n}\n`,
        action: 'modified',
        language: 'dart',
      });
    }
  }

  // Fix missing MaterialApp
  if (diag.gate === 'G3-materialapp' && filePath === 'lib/app/app.dart') {
    files.set('lib/app/app.dart', {
      path: 'lib/app/app.dart',
      content: `import 'package:flutter/material.dart';\nimport 'package:${pkgName}/core/router/app_router.dart';\nimport 'package:${pkgName}/app/app_theme.dart';\n\nclass App extends StatelessWidget {\n  const App({super.key});\n  @override\n  Widget build(BuildContext context) {\n    return MaterialApp.router(\n      title: '${appName}',\n      debugShowCheckedModeBanner: false,\n      theme: AppTheme.lightTheme,\n      darkTheme: AppTheme.darkTheme,\n      routerConfig: appRouter,\n    );\n  }\n}\n`,
      action: 'modified',
      language: 'dart',
    });
  }
}

function getMinimalFallback(path: string, appName: string, pkgName: string): string | null {
  if (path === 'lib/main.dart') {
    return "import 'package:flutter/material.dart';\nimport 'package:" + pkgName + "/app/app.dart';\n\nvoid main() async {\n  WidgetsFlutterBinding.ensureInitialized();\n  runApp(const App());\n}\n";
  }
  if (path === 'lib/app/app.dart') {
    return "import 'package:flutter/material.dart';\nimport 'package:" + pkgName + "/core/router/app_router.dart';\nimport 'package:" + pkgName + "/app/app_theme.dart';\n\nclass App extends StatelessWidget {\n  const App({super.key});\n  @override\n  Widget build(BuildContext context) {\n    return MaterialApp.router(\n      title: '" + appName + "',\n      debugShowCheckedModeBanner: false,\n      theme: AppTheme.lightTheme,\n      darkTheme: AppTheme.darkTheme,\n      routerConfig: appRouter,\n    );\n  }\n}\n";
  }
  if (path === 'lib/core/router/app_router.dart') {
    return "import 'package:flutter/material.dart';\nimport 'package:go_router/go_router.dart';\nimport 'package:" + pkgName + "/features/home/screens/home_screen.dart';\n\nfinal appRouter = GoRouter(\n  initialLocation: '/',\n  routes: [\n    GoRoute(\n      path: '/',\n      name: 'home',\n      builder: (context, state) => const HomeScreen(),\n    ),\n  ],\n);\n";
  }
  if (path === 'lib/app/app_theme.dart') {
    return "import 'package:flutter/material.dart';\n\nclass AppTheme {\n  static final ThemeData lightTheme = ThemeData(\n    useMaterial3: true,\n    colorScheme: ColorScheme.fromSeed(\n      seedColor: const Color(0xFF2563EB),\n      brightness: Brightness.light,\n    ),\n  );\n  static final ThemeData darkTheme = ThemeData(\n    useMaterial3: true,\n    colorScheme: ColorScheme.fromSeed(\n      seedColor: const Color(0xFF2563EB),\n      brightness: Brightness.dark,\n    ),\n  );\n}\n";
  }
  if (path === 'lib/core/services/supabase_service.dart' || path === 'lib/core/services/auth_service.dart') {
    return "import 'package:flutter/foundation.dart';\n\nclass SupabaseService {\n  static bool get isConfigured => false;\n  static Future<void> initialize() async {\n    debugPrint('[SupabaseService] Initialized (local mode)');\n  }\n}\n";
  }
  if (path === 'lib/features/home/screens/home_screen.dart') {
    return "import 'package:flutter/material.dart';\n\nclass HomeScreen extends StatelessWidget {\n  const HomeScreen({super.key});\n  @override\n  Widget build(BuildContext context) {\n    final theme = Theme.of(context);\n    return Scaffold(\n      appBar: AppBar(\n        title: Text('" + appName + "'),\n        centerTitle: false,\n      ),\n      body: Center(\n        child: Column(\n          mainAxisAlignment: MainAxisAlignment.center,\n          children: [\n            Icon(Icons.check_circle_outline, size: 64, color: theme.colorScheme.primary),\n            const SizedBox(height: 16),\n            Text('" + appName + "', style: theme.textTheme.headlineMedium),\n            const SizedBox(height: 8),\n            Text('Generated by FlutterForge', style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.outline)),\n          ],\n        ),\n      ),\n    );\n  }\n}\n";
  }
  if (path === 'pubspec.yaml') {
    return "name: " + pkgName + "\ndescription: Generated by FlutterForge\npublish_to: none\nversion: 1.0.0+1\n\nenvironment:\n  sdk: '>=3.3.0 <4.0.0'\n\ndependencies:\n  flutter:\n    sdk: flutter\n  go_router: ^14.2.0\n  provider: ^6.1.2\n\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n  flutter_lints: ^4.0.0\n\nflutter:\n  uses-material-design: true\n";
  }
  return null;
}
