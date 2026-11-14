/**
 * editAgent — surgical single-pass edit for existing Flutter apps.
 * Called when isNewApp=false. Makes targeted changes without rerunning
 * the full 13-step generation pipeline.
 */
import { callLLMText, parseFilesFromLLMOutput, agentModelFor } from './llmClient';

export interface EditResult {
  files: Array<{ path: string; content: string; language: string }>;
  summary: string;
}

const NAMED_FILE = /[\w./-]+\.(?:dart|yaml|yml|json|sql|md|lock|xml)/gi;

export async function runEditAgent(
  editRequest: string,
  currentFiles: Array<{ path: string; content: string | null }>,
  onProgress?: (phase: string, message: string) => void,
): Promise<EditResult> {
  onProgress?.('edit', '🔍 Analyzing edit request…');

  const textFiles = currentFiles.filter(
    (f): f is { path: string; content: string } => Boolean(f.path && f.content)
  );

  const editLower = editRequest.toLowerCase();

  // Pick contextually relevant files
  const relevant = textFiles.filter((f) => {
    if (!f.path.endsWith('.dart')) return false;
    if (f.path.includes('main.dart') || f.path.includes('app.dart') || f.path.includes('router')) return true;
    if (/color|theme|style|dark|light|font|material/.test(editLower) && f.path.includes('theme')) return true;
    const filename = (f.path.split('/').pop() ?? '').replace(/_screen\.dart$/, '').replace(/\.dart$/, '').replace(/_/g, ' ');
    if (filename && editLower.includes(filename)) return true;
    return false;
  });

  // Files explicitly named in the request (e.g. "pubspec.yaml has a syntax error")
  const namedPaths = [...new Set((editRequest.match(NAMED_FILE) ?? []).map((value) => value.replace(/^\.\//, '')))];
  const named = textFiles.filter((f) =>
    namedPaths.some((name) => f.path === name || f.path.endsWith('/' + name)),
  );

  // Build failures almost always trace to pubspec.yaml — always include it.
  const pubspec = textFiles.filter((f) => /(^|\/)pubspec\.yaml$/.test(f.path));

  const byPath = new Map<string, { path: string; content: string }>();
  for (const file of [...named, ...pubspec, ...relevant]) byPath.set(file.path, file);
  if (byPath.size === 0) for (const file of textFiles.filter((f) => f.path.endsWith('.dart')).slice(0, 5)) byPath.set(file.path, file);

  const contextFiles = [...byPath.values()].slice(0, 8);

  const fileContext = contextFiles
    .map((f) => `// FILE: ${f.path}\n${f.content.slice(0, 3000)}`)
    .join('\n\n---\n\n');

  onProgress?.('edit', '✏️ Generating changes…');

  const systemPrompt = `You are FlutterForge, a professional Flutter developer making surgical edits to an existing app.
Apply ONLY the requested change — do not rewrite unrelated code, do not add features not asked for.

Output ONLY the changed files in this exact format:
// FILE: lib/path/to/file.dart
\`\`\`dart
<complete updated file content — not a diff, the whole file>
\`\`\`

Rules:
- Output at most 6 files
- Only output files that actually change
- Preserve all existing functionality
- Use Material 3 patterns
- Professional production Dart code — no TODOs, no placeholders
- Non-Dart files (pubspec.yaml, JSON, SQL) may be required by build errors — fix them too, using the fence that matches the file type (e.g. \`\`\`yaml)
- If the change is purely visual (color, text, spacing), only output the affected widget file`;

  const userPrompt = `Edit request: "${editRequest}"

Current relevant project files:
${fileContext}

Apply exactly the edit requested. Output only changed files.`;

  let raw = '';
  try {
    raw = await callLLMText(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { model: agentModelFor('edit'), temperature: 0.2, maxTokens: 8000 }
    );
  } catch (err) {
    console.warn('[EditAgent] LLM edit call failed:', err);
    return {
      files: [],
      summary: `Edit failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = parseFilesFromLLMOutput(raw);

  onProgress?.('edit', `✅ ${parsed.length} file${parsed.length !== 1 ? 's' : ''} updated`);

  return {
    files: parsed,
    summary: `Applied: ${editRequest.slice(0, 100)}`,
  };
}
