import { ConversationContextManager, type RawChatMessage, type ValidatedChatMessage } from './chatHistory';
import type { AssistantIntent } from './chatTypes';

export interface ProjectFileItem {
  path: string;
  content: string;
  is_directory?: boolean;
}

export interface ChatContextInput {
  projectName: string;
  projectDescription?: string | null;
  files: ProjectFileItem[];
  messages: RawChatMessage[];
  activeFile?: string | null;
  buildErrors?: string[];
  question?: string;
  attachedFiles?: string[];
  intent?: AssistantIntent;
  maxHistoryTokens?: number;
}

export interface ProjectPubspecSummary {
  name?: string;
  description?: string;
  dependencies: string[];
  devDependencies: string[];
  flutterSdk?: string;
}

export interface ProjectAwareness {
  projectName: string;
  projectDescription: string;
  directoryTree: string;
  pubspec?: ProjectPubspecSummary;
  stateManagement: string;
  screens: Array<{ name: string; path: string }>;
  widgets: Array<{ name: string; path: string }>;
  routes: string[];
  themeSummary?: string;
  relevantFiles: Array<{ path: string; content: string; relevanceReason: string }>;
  buildErrors: string[];
}

export interface ChatContextOutput {
  summary: string;
  history: ValidatedChatMessage[];
  historySummary?: string;
  tokenEstimate: number;
  projectContext: ProjectAwareness;
  formattedPromptContext: string;
}

/** Parse dependencies and SDK constraints from pubspec.yaml */
function parsePubspec(yamlContent: string): ProjectPubspecSummary {
  const dependencies: string[] = [];
  const devDependencies: string[] = [];
  let name: string | undefined;
  let description: string | undefined;
  let flutterSdk: string | undefined;

  let currentSection: 'deps' | 'dev_deps' | 'other' = 'other';

  const lines = yamlContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('name:')) {
      name = trimmed.replace('name:', '').trim();
      continue;
    }
    if (trimmed.startsWith('description:')) {
      description = trimmed.replace('description:', '').trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    if (trimmed.startsWith('dependencies:')) {
      currentSection = 'deps';
      continue;
    }
    if (trimmed.startsWith('dev_dependencies:')) {
      currentSection = 'dev_deps';
      continue;
    }
    if (/^[a-zA-Z0-9_-]+:/.test(line) && !line.startsWith(' ') && !line.startsWith('\t')) {
      currentSection = 'other';
      continue;
    }

    if ((line.startsWith('  ') || line.startsWith('\t')) && currentSection !== 'other') {
      const match = trimmed.match(/^([a-zA-Z0-9_-]+):/);
      if (match && match[1]) {
        const pkg = match[1];
        if (pkg === 'flutter') {
          flutterSdk = 'flutter';
        } else if (currentSection === 'deps') {
          dependencies.push(pkg);
        } else if (currentSection === 'dev_deps') {
          devDependencies.push(pkg);
        }
      }
    }
  }

  return { name, description, dependencies, devDependencies, flutterSdk };
}

/** Detect state management solution from dependencies and imports */
function detectStateManagement(dependencies: string[], files: ProjectFileItem[]): string {
  const deps = dependencies.map((d) => d.toLowerCase());
  if (deps.includes('flutter_riverpod') || deps.includes('riverpod')) return 'Riverpod';
  if (deps.includes('flutter_bloc') || deps.includes('bloc')) return 'BLoC';
  if (deps.includes('provider')) return 'Provider';
  if (deps.includes('get')) return 'GetX';
  if (deps.includes('mobx') || deps.includes('flutter_mobx')) return 'MobX';

  // Check code imports
  for (const f of files) {
    if (f.content?.includes('package:flutter_riverpod/')) return 'Riverpod';
    if (f.content?.includes('package:flutter_bloc/')) return 'BLoC';
    if (f.content?.includes('package:provider/')) return 'Provider';
  }

  return 'ChangeNotifier / StatefulWidget';
}

/** Extract screens from file paths and code */
function extractScreens(files: ProjectFileItem[]): Array<{ name: string; path: string }> {
  const screens: Array<{ name: string; path: string }> = [];
  for (const f of files) {
    if (f.is_directory || !f.path.endsWith('.dart')) continue;
    if (f.path.includes('/screens/') || f.path.includes('/pages/') || f.path.endsWith('_screen.dart') || f.path.endsWith('_page.dart')) {
      const classMatch = f.content?.match(/class\s+([A-Z]\w*(Screen|Page))\b/);
      const name = classMatch?.[1] || f.path.split('/').pop()?.replace('.dart', '') || 'Screen';
      screens.push({ name, path: f.path });
    }
  }
  return screens;
}

/** Extract reusable widgets */
function extractWidgets(files: ProjectFileItem[]): Array<{ name: string; path: string }> {
  const widgets: Array<{ name: string; path: string }> = [];
  for (const f of files) {
    if (f.is_directory || !f.path.endsWith('.dart')) continue;
    if (f.path.includes('/widgets/') || f.path.includes('/components/')) {
      const classMatch = f.content?.match(/class\s+([A-Z]\w*)\s+extends\s+(StatelessWidget|StatefulWidget)/);
      const name = classMatch?.[1] || f.path.split('/').pop()?.replace('.dart', '') || 'Widget';
      widgets.push({ name, path: f.path });
    }
  }
  return widgets;
}

/** Extract navigation routes from main.dart or router files */
function extractRoutes(files: ProjectFileItem[]): string[] {
  const routes = new Set<string>();
  for (const f of files) {
    if (f.is_directory || !f.path.endsWith('.dart')) continue;
    if (f.path.includes('main.dart') || f.path.includes('router') || f.path.includes('routes')) {
      // Find GoRoute paths: path: '/xyz'
      const goRouteMatches = f.content?.matchAll(/path:\s*['"]([/a-zA-Z0-9_-]+)['"]/g);
      if (goRouteMatches) {
        for (const m of goRouteMatches) {
          if (m[1]) routes.add(m[1]);
        }
      }
      // Find Named routes: '/xyz': (context) => ...
      const namedRouteMatches = f.content?.matchAll(/['"]([/a-zA-Z0-9_-]+)['"]\s*:\s*\([^)]*\)\s*=>/g);
      if (namedRouteMatches) {
        for (const m of namedRouteMatches) {
          if (m[1]) routes.add(m[1]);
        }
      }
    }
  }
  if (routes.size === 0) routes.add('/');
  return Array.from(routes);
}

/** Extract theme overview */
function extractThemeSummary(files: ProjectFileItem[]): string | undefined {
  for (const f of files) {
    if (f.is_directory || !f.path.endsWith('.dart')) continue;
    if (f.path.includes('theme') || f.content?.includes('ThemeData(')) {
      const isM3 = f.content?.includes('useMaterial3: true');
      const seedColorMatch = f.content?.match(/colorSchemeSeed:\s*(?:Colors\.(\w+)|Color\((0x[0-9a-fA-F]+)\))/i);
      const color = seedColorMatch?.[1] || seedColorMatch?.[2] || 'Material 3 default';
      return `Material 3 (${isM3 !== false ? 'enabled' : 'disabled'}), Seed Color: ${color}, defined in ${f.path}`;
    }
  }
  return undefined;
}

/** Score and retrieve relevant Dart files based on user question and intent */
function findRelevantFiles(
  question: string,
  files: ProjectFileItem[],
  attachedFiles: string[] = [],
  activeFile?: string | null
): Array<{ path: string; content: string; relevanceReason: string }> {
  const nonDirFiles = files.filter((f) => !f.is_directory && Boolean(f.content));
  const scored: Array<{ file: ProjectFileItem; score: number; reason: string }> = [];

  const qLower = question.toLowerCase();
  const qWords = qLower.split(/\W+/).filter((w) => w.length > 2);

  for (const f of nonDirFiles) {
    let score = 0;
    const reasons: string[] = [];

    // Attached files have highest priority
    if (attachedFiles.includes(f.path)) {
      score += 100;
      reasons.push('explicitly attached file');
    }

    // Currently active file in the editor
    if (activeFile && f.path === activeFile) {
      score += 50;
      reasons.push('currently active in editor');
    }

    // Path mentions in question (e.g. "look at lib/main.dart")
    if (qLower.includes(f.path.toLowerCase()) || qLower.includes(f.path.split('/').pop()?.toLowerCase() ?? '')) {
      score += 40;
      reasons.push('explicitly mentioned in question');
    }

    // Filename keyword overlap
    const filenameNoExt = (f.path.split('/').pop() ?? '').replace(/\.(dart|yaml)$/, '').toLowerCase();
    for (const word of qWords) {
      if (filenameNoExt.includes(word)) {
        score += 15;
        reasons.push(`file name matches "${word}"`);
        break;
      }
    }

    // Core application entrypoints
    if (f.path === 'lib/main.dart') {
      score += 5;
      reasons.push('application entrypoint');
    }

    if (score > 0) {
      scored.push({ file: f, score, reason: reasons.join(', ') });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // Return top 3-4 files with a truncated preview to protect the token budget
  return scored.slice(0, 4).map(({ file, reason }) => {
    const lines = (file.content || '').split('\n');
    const snippet = lines.length > 80
      ? `${lines.slice(0, 75).join('\n')}\n// ... [${lines.length - 75} more lines omitted for brevity]`
      : file.content;
    return {
      path: file.path,
      content: snippet,
      relevanceReason: reason,
    };
  });
}

/** Build compact directory tree representation */
function buildDirectoryTree(files: ProjectFileItem[]): string {
  const paths = files
    .filter((f) => !f.is_directory && f.path)
    .map((f) => f.path)
    .sort();

  if (paths.length <= 30) {
    return paths.map((p) => `- ${p}`).join('\n');
  }

  // If large, show lib/ files and summarize root files
  const libFiles = paths.filter((p) => p.startsWith('lib/'));
  const otherFiles = paths.filter((p) => !p.startsWith('lib/'));

  const lines = [
    ...libFiles.slice(0, 35).map((p) => `- ${p}`),
    ...(libFiles.length > 35 ? [`- ... (${libFiles.length - 35} more lib files)`] : []),
    ...otherFiles.slice(0, 10).map((p) => `- ${p}`),
    ...(otherFiles.length > 10 ? [`- ... (${otherFiles.length - 10} other project files)`] : []),
  ];

  return lines.join('\n');
}

export class ChatContextHandler {
  public static build(input: ChatContextInput): ChatContextOutput {
    const rawFiles = input.files || [];
    const nonDirFiles = rawFiles.filter((f) => !f.is_directory);
    const projectName = input.projectName || 'FlutterApp';
    const projectDescription = input.projectDescription || '';

    // 1. Pubspec analysis
    const pubspecFile = nonDirFiles.find((f) => f.path === 'pubspec.yaml');
    const pubspec = pubspecFile?.content ? parsePubspec(pubspecFile.content) : undefined;

    // 2. Structural metrics
    const stateManagement = detectStateManagement(pubspec?.dependencies ?? [], nonDirFiles);
    const screens = extractScreens(nonDirFiles);
    const widgets = extractWidgets(nonDirFiles);
    const routes = extractRoutes(nonDirFiles);
    const themeSummary = extractThemeSummary(nonDirFiles);
    const directoryTree = buildDirectoryTree(nonDirFiles);
    const buildErrors = (input.buildErrors || []).filter((e) => typeof e === 'string' && e.trim()).slice(-5);

    // 3. Selective relevant files retrieval
    const relevantFiles = findRelevantFiles(
      input.question || '',
      nonDirFiles,
      input.attachedFiles,
      input.activeFile
    );

    // 4. Conversation history management
    const managedHistory = ConversationContextManager.manage(input.messages || [], {
      maxTokens: input.maxHistoryTokens ?? 2500,
      currentPrompt: input.question,
    });

    const projectContext: ProjectAwareness = {
      projectName,
      projectDescription,
      directoryTree,
      pubspec,
      stateManagement,
      screens,
      widgets,
      routes,
      themeSummary,
      relevantFiles,
      buildErrors,
    };

    // 5. Assemble formatted prompt context (tailored to request)
    const promptSections: string[] = [
      `### Project: ${projectName}${projectDescription ? ` — ${projectDescription}` : ''}`,
      `- State Management: ${stateManagement}`,
      `- Total Files: ${nonDirFiles.length} files (${screens.length} screens, ${widgets.length} reusable widgets)`,
    ];

    if (routes.length > 0) {
      promptSections.push(`- Routes: ${routes.join(', ')}`);
    }

    if (pubspec && pubspec.dependencies.length > 0) {
      promptSections.push(`- Key Dependencies: ${pubspec.dependencies.slice(0, 15).join(', ')}`);
    }

    if (themeSummary) {
      promptSections.push(`- Theme: ${themeSummary}`);
    }

    if (buildErrors.length > 0) {
      promptSections.push(
        `### Current Build / Analysis Errors:\n${buildErrors.map((e) => `\`\`\`\n${e.slice(0, 300)}\n\`\`\``).join('\n')}`
      );
    }

    if (relevantFiles.length > 0) {
      promptSections.push(
        `### Relevant Project Files:\n` +
        relevantFiles
          .map((f) => `// FILE: ${f.path} (${f.relevanceReason})\n\`\`\`dart\n${f.content}\n\`\`\``)
          .join('\n\n')
      );
    }

    const formattedPromptContext = promptSections.join('\n');

    // Token estimate computation
    const promptChars = formattedPromptContext.length;
    const historyChars = managedHistory.messages.reduce((acc, m) => acc + m.content.length, 0);
    const tokenEstimate = Math.max(120, Math.ceil((promptChars + historyChars) / 3.8));

    const summary = `${projectName} (${nonDirFiles.length} files, ${stateManagement})`;

    return {
      summary,
      history: managedHistory.messages,
      historySummary: managedHistory.summary,
      tokenEstimate,
      projectContext,
      formattedPromptContext,
    };
  }
}
