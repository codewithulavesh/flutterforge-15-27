/**
 * Frontend Builder Agent — generates PROFESSIONAL, domain-specific Flutter screens.
 * Each screen is generated individually with full context = maximum quality.
 * No generic "Item 1", "Item 2". Real UI for real apps.
 */
import type { ProjectState, GeneratedFile, ScreenDefinition, GateDiagnostic, DesignTokens } from '../orchestrator/state';
import { callLLMText, parseFilesFromLLMOutput, agentModelFor } from './llmClient';

const SCREEN_SYSTEM_PROMPT = `You are a WORLD-CLASS Flutter developer who builds PRODUCTION apps.

MANDATORY RULES — ZERO TOLERANCE:
1. Write REAL, domain-specific code. No "Item 1", no "Data goes here", no "TODO", no placeholder text.
2. Every screen implements ALL 4 UI states:
   - loading: shimmer skeleton that matches the content shape
   - empty: beautiful illustration area + motivational text + primary CTA
   - error: clear error message + retry button + optional details
   - content: THE REAL UI with real data, real interactions
3. All buttons, FABs, IconButtons, ListTiles MUST have real handlers. Zero onPressed: null.
4. Use Theme.of(context).colorScheme for ALL colors. Never hardcode hex.
5. Data must be realistic mock objects from domain model classes — proper typed variables.
6. Animations: use AnimatedList, Hero, AnimatedContainer, FadeTransition where appropriate.
7. Navigation: context.go('/route') for GoRouter.
8. Screen widgets must be broken into small private widget methods (_buildHeader, _buildList, etc.)
9. Provider state: use Consumer<XProvider> or context.watch<XProvider>() — no setState for business logic.
10. Pull-to-refresh: RefreshIndicator on scrollable content.
11. Proper keyboard handling: ScrollController, FocusNode, resizeToAvoidBottomInset.
12. Material 3 components: use Card, FilledButton, Chip, Badge, NavigationBar, SearchBar where relevant.
13. Dart null safety: prefer ?., ?? and late final. NEVER use the ! operator on values that may be null (async results, JSON maps, nullable model fields, optional parameters).
14. Design tokens: use ONLY the design tokens listed in the prompt for brand colors. If a token is missing, fall back to Theme.of(context).colorScheme. NEVER hardcode hex/neon colors and NEVER invent a new palette.
15. Every file must compile. If you cannot complete a file, truncate nothing — emit the FULL file or emit nothing.

PROFESSIONAL CODE PATTERNS:
- Use const constructors everywhere possible
- Extract reusable widgets as private methods
- AnimatedSwitcher for state transitions
- Proper dispose() for controllers
- MediaQuery for responsive layouts
- SliverAppBar for scrollable screens

Output format:
// FILE: lib/features/{feature}/screens/{screen_name}.dart
\`\`\`dart
import 'package:{pkg}/...';
// complete production screen code
\`\`\`

// FILE: lib/features/{feature}/widgets/{widget_name}.dart  
\`\`\`dart
// reusable widget extracted from screen
\`\`\``;

export async function runFrontendBuilderAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const appName = state.productBrief?.appName || 'App';
  const pkgName = sanitizePackageName(state.productBrief?.appName);
  const screens = state.screenGraph?.screens || [];
  const tokens = state.designTokens;
  const arch = state.architectureSpec || state.architecture;
  const intake = state._intakeData as Record<string, unknown> | undefined;
  const domain = (intake?.domain as string) || 'general';
  const keyFeatures = (intake?.keyFeatures as string[]) || [];
  const modelFiles = (state._modelFiles as string[]) || [];
  const providerFiles = (state._providerFiles as string[]) || [];
  const files = new Map<string, GeneratedFile>(state.generatedFiles);

  const stateManagement = arch?.stateManagement || 'provider';
  const radius = tokens?.borderRadius ?? 12;
  const designTokenSection = buildDesignTokensSection(tokens);

  // Build model import context
  const modelImports = modelFiles
    .map((f) => {
      const name = f.split('/').pop()?.replace('.dart', '') || '';
      return `import 'package:${pkgName}/shared/models/${name}.dart';`;
    })
    .join('\n');

  // Build provider import context
  const providerImports = providerFiles
    .map((f) => {
      const parts = f.split('/');
      const name = parts.pop()?.replace('.dart', '') || '';
      const feature = parts[parts.length - 2] || '';
      return `import 'package:${pkgName}/features/${feature}/providers/${name}.dart';`;
    })
    .join('\n');

  // Screens are independent LLM calls. Run 3-4 at a time so wall-clock time
  // drops ~3-4x without losing per-screen quality. Results are applied only
  // after the whole batch settles, keeping the shared file map deterministic.
  const configuredConcurrency = Number(
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SCREEN_CONCURRENCY)
    || 3
  );
  const CONCURRENCY = Math.max(1, Math.min(6, configuredConcurrency || 3));

  type ScreenResult = {
    target: string;
    screenName: string;
    files: Array<{ path: string; content: string }>;
    /** true when the LLM produced output for this screen but no valid screen file survived validation. */
    failed: boolean;
    diagnostics: GateDiagnostic[];
  };

  const pendingScreens = screens.filter((screen) => {
    const featureName = screen.id || screen.name.replace('Screen', '').toLowerCase();
    const screenFileName = toScreenFileName(screen.name);
    return !files.has(`lib/features/${featureName}/screens/${screenFileName}`);
  });

  // Pre-assign a unique, singularized class name per screen (derived from the
  // screen name) so class names never collide across the graph, regardless of
  // what the LLM emits. Deterministic order = screen graph order.
  const classNameByTarget = new Map<string, string>();
  const usedClassNames = new Set<string>();
  for (const screen of pendingScreens) {
    const featureName = screen.id || screen.name.replace('Screen', '').toLowerCase();
    const screenFileName = toScreenFileName(screen.name);
    classNameByTarget.set(
      `lib/features/${featureName}/screens/${screenFileName}`,
      uniquifyClassName(deriveScreenClassName(screen.name), usedClassNames),
    );
  }

  const generatedScreenPaths: string[] = [];
  const collectedDiagnostics: GateDiagnostic[] = [];
  const screenFailures: string[] = [];
  const allResults: ScreenResult[] = [];

  for (let offset = 0; offset < pendingScreens.length; offset += CONCURRENCY) {
    const batch = pendingScreens.slice(offset, offset + CONCURRENCY);
    const results = await Promise.all(batch.map(async (screen): Promise<ScreenResult> => {
      const featureName = screen.id || screen.name.replace('Screen', '').toLowerCase();
      const screenFileName = toScreenFileName(screen.name);
      const target = `lib/features/${featureName}/screens/${screenFileName}`;
      const className = classNameByTarget.get(target) ?? deriveScreenClassName(screen.name);

      let raw = '';
      try {
        raw = await callLLMText(
          [
            {
              role: 'system',
              content: SCREEN_SYSTEM_PROMPT,
            },
            {
              role: 'user',
              content: `Generate the COMPLETE Flutter screen: ${screen.name}

  App: "${appName}" (${domain} app)
  Package: ${pkgName}
  Route: ${screen.route}
  Output path (use EXACTLY): // FILE: lib/features/${featureName}/screens/${screenFileName}
  Screen class name (use EXACTLY): ${className}
  Any extracted widget must use: // FILE: lib/features/${featureName}/widgets/<widget_name>.dart
  Purpose: ${screen.purpose}
  Primary action: ${screen.primaryAction}
  Auth required: ${screen.isAuthRequired}
  Widgets to use: ${screen.widgets?.join(', ') || 'ListView, Card, AppBar, FloatingActionButton'}

  UI States:
    LOADING: ${screen.states.loading}
    EMPTY: ${screen.states.empty}
    ERROR: ${screen.states.error}
    CONTENT: ${screen.states.content}

  State management: ${stateManagement}
  Border radius: ${radius}px

  ${designTokenSection}

  Available models (use these for real typed data):
  ${modelImports}

  Available providers:
  ${providerImports}

  Domain context: ${domain} app
  Key features: ${keyFeatures.join(', ')}

  CRITICAL: This is a PRODUCTION ${domain} app. 
  - Use REAL data types from the models above
  - Show REAL ${domain} content (not generic items)
  - Implement REAL user interactions for a ${domain} app
  - Include domain-specific widgets (e.g. ${getDomainWidgetHints(domain)})

  Also generate any small reusable widget extracted from this screen.
  Use the // FILE: format for each file.`,
            },
          ],
          {
            model: agentModelFor('frontend-builder'),
            temperature: 0.35,
            maxTokens: 5000,
          }
        );
      } catch (err) {
        console.warn(`[FrontendBuilder] LLM failed for ${screen.name}:`, err);
      }

      const screenDiagnostics: GateDiagnostic[] = [];
      const parsed = parseFilesFromLLMOutput(raw);
      const produced: Array<{ path: string; content: string }> = [];
      const tokenHexes = designTokenHexes(tokens);
      for (const f of parsed) {
        let cleanContent = f.content.replace(/^```(?:dart)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        // Never trust LLM-emitted paths: force every screen/widget into the
        // canonical feature layout so the project contract and analyzer agree.
        const canonical = canonicalizeOutputPath(f.path, featureName, screenFileName);
        const isScreenFile = canonical === target;

        if (cleanContent.length <= 50) {
          screenDiagnostics.push(skippedFileDiagnostic(canonical, screen.name, 'file is too short to be valid Dart (likely truncated at maxTokens)'));
          continue;
        }

        if (isScreenFile) {
          // Guarantee a unique class name derived from the (singularized)
          // screen name — rename the emitted widget class and its State class.
          const renamed = renameMainWidgetClass(cleanContent, className);
          if (renamed === null) {
            screenDiagnostics.push({
              gate: 'frontend-builder',
              level: 'error',
              filePath: canonical,
              message: `Screen ${screen.name}: no widget class extending StatelessWidget/StatefulWidget/ConsumerWidget found; file rejected`,
              suggestion: 'Regenerate the screen with a top-level widget class',
            });
            continue;
          }
          cleanContent = renamed;
        }

        // Structural integrity: balanced braces/parens/brackets outside
        // strings and comments. Truncated/corrupt files are skipped, never
        // written into the pipeline.
        if (!isDartBalanced(cleanContent)) {
          screenDiagnostics.push(skippedFileDiagnostic(canonical, screen.name, 'unbalanced Dart delimiters (braces/parens) — output likely truncated at maxTokens'));
          continue;
        }

        const forbidden = forbiddenMarker(cleanContent);
        if (forbidden) {
          screenDiagnostics.push(skippedFileDiagnostic(canonical, screen.name, `contains forbidden marker "${forbidden}"`));
          continue;
        }

        if (isScreenFile && !/import\s+['"]package:flutter\/material\.dart['"]/.test(cleanContent)) {
          screenDiagnostics.push(skippedFileDiagnostic(canonical, screen.name, 'missing import of package:flutter/material.dart'));
          continue;
        }

        if (isScreenFile && !/Theme\.of\(context\)/.test(cleanContent)) {
          screenDiagnostics.push({
            gate: 'frontend-builder',
            level: 'warning',
            filePath: canonical,
            message: `Screen ${screen.name}: does not use Theme.of(context); Material 3 theming is required`,
            suggestion: 'Read colors/text styles via Theme.of(context).colorScheme and theme.textTheme',
          });
        }

        const offTokens = findOffTokenColorLiterals(cleanContent, tokenHexes);
        if (offTokens.length > 0) {
          screenDiagnostics.push({
            gate: 'frontend-builder',
            level: 'warning',
            filePath: canonical,
            message: `Screen ${screen.name}: hardcoded color literal(s) ${offTokens.slice(0, 5).join(', ')} not present in designTokens; fall back to Theme.of(context).colorScheme instead of inventing a palette`,
            suggestion: 'Use design tokens from state.designTokens or Theme.of(context).colorScheme',
          });
        }

        const bangCount = countNonNullAssertions(cleanContent);
        if (bangCount > 0) {
          screenDiagnostics.push({
            gate: 'frontend-builder',
            level: 'warning',
            filePath: canonical,
            message: `Screen ${screen.name}: ${bangCount} use(s) of the ! non-null assertion operator; prefer ?. and ?? for values the contract cannot guarantee non-null`,
            suggestion: 'Replace ! with ?. / ?? or late final where initialization is guaranteed',
          });
        }

        produced.push({ path: canonical, content: cleanContent });
      }

      const llmProducedAnything = parsed.length > 0;
      const screenSurvived = produced.some((p) => p.path === target);
      if (!screenSurvived) {
        if (llmProducedAnything) {
          // The model returned output but everything for this screen failed
          // validation — write NOTHING for it and flag it, rather than fall
          // back to a duplicate template or emit corrupt Dart.
          return { target, screenName: screen.name, files: [], failed: true, diagnostics: screenDiagnostics };
        }
        // No parseable LLM output at all (empty raw / LLM error) — keep the
        // deterministic, domain-aware fallback.
        produced.push({
          path: target,
          content: generateDomainScreen(screen, pkgName, appName, domain, stateManagement, radius, modelFiles, className),
        });
        return { target, screenName: screen.name, files: produced, failed: false, diagnostics: screenDiagnostics };
      }
      return { target, screenName: screen.name, files: produced, failed: false, diagnostics: screenDiagnostics };
    }));

    // Collect — do not apply yet. If more than half of the screens failed
    // validation, fail fast with the screen names; the pipeline owns the
    // failure policy.
    for (const result of results) {
      allResults.push(result);
      collectedDiagnostics.push(...result.diagnostics);
      if (result.failed) screenFailures.push(result.screenName);
      else generatedScreenPaths.push(result.target);
    }
  }

  if (pendingScreens.length > 0 && screenFailures.length * 2 > pendingScreens.length) {
    throw new Error(
      `[FrontendBuilder] ${screenFailures.length}/${pendingScreens.length} screen files failed structural validation. Failing screens: ${screenFailures.join(', ')}`,
    );
  }

  // Apply only after the whole run settles and the failure budget is
  // validated — no interleaved Map writes, no corrupt files.
  for (const result of allResults) {
    for (const produced of result.files) {
      files.set(produced.path, {
        path: produced.path,
        action: 'created',
        language: 'dart',
        content: produced.content,
      });
    }
  }

  const skippedScreens = pendingScreens.length - generatedScreenPaths.length;
  return {
    generatedFiles: files,
    diagnostics: [...state.diagnostics, ...collectedDiagnostics],
    logs: [
      ...state.logs,
      `[Frontend Builder Agent] Generated ${generatedScreenPaths.length}/${screens.length} screens in batches of ${CONCURRENCY}. Total files: ${files.size}. Domain: ${domain}.${skippedScreens > 0 ? ` Skipped ${skippedScreens} screen(s) whose LLM output failed validation: ${screenFailures.join(', ')}.` : ''}`,
    ],
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toSnakeCase(name: string): string {
  return name.replace(/([A-Z])/g, (m, _, i) => (i === 0 ? m.toLowerCase() : `_${m.toLowerCase()}`));
}

/** Always `home_screen.dart`, never `home.dart` or `homeScreen.dart`. */
function toScreenFileName(name: string): string {
  const base = name.replace(/Screen$/i, '');
  const snake = toSnakeCase(base).replace(/^_+|_+$/g, '');
  return `${snake || 'home'}_screen.dart`;
}

/** Force LLM output into the canonical feature screens/widgets layout. */
function canonicalizeOutputPath(rawPath: string, featureName: string, primaryFileName: string): string {
  const basename = (rawPath.split('/').pop() || '').replace(/\\/g, '');
  if (!basename.endsWith('.dart')) return `lib/features/${featureName}/screens/${primaryFileName}`;
  if (/widget/i.test(basename) || /\/widgets\//i.test(rawPath)) {
    return `lib/features/${featureName}/widgets/${basename}`;
  }
  if (basename.endsWith('_screen.dart') && basename !== primaryFileName) {
    return `lib/features/${featureName}/screens/${basename}`;
  }
  return `lib/features/${featureName}/screens/${primaryFileName}`;
}

function getDomainWidgetHints(domain: string): string {
  const hints: Record<string, string> = {
    ecommerce: 'ProductCard with image+price+rating, CartBadge, FilterChip row, PriceTag widget',
    fitness: 'WorkoutCard with progress ring, ExerciseSetRow, CalorieCounter, StreakBadge',
    tasks: 'TaskTile with priority color, ProgressBar, DueDateChip, AssigneeAvatar',
    social: 'PostCard with like/comment/share, AvatarWithBorder, TrendingHashtag, StoryCircle',
    finance: 'TransactionTile with category icon+amount color, BalanceCard, SpendingChart, BudgetBar',
    food: 'RecipeCard with time+calories, IngredientChip, StarRating, NutritionBadge',
    music: 'TrackTile with album art+duration, MiniPlayer, WaveformVisualizer, PlaylistCard',
    travel: 'DestinationCard with hero image, TripTimeline, BudgetProgress, WeatherWidget',
    education: 'CourseCard with progress, LessonTile, QuizResult, CertificateBadge',
    general: 'ItemCard with status badge, SearchBar, FilterBottomSheet, EmptyStateWidget',
  };
  return hints[domain] || hints['general'];
}

function generateDomainScreen(
  screen: ScreenDefinition,
  pkgName: string,
  appName: string,
  domain: string,
  stateManagement: string,
  radius: number,
  modelFiles: string[],
  className?: string,
): string {
    const widgetClass = className ?? deriveScreenClassName(screen.name);
  const title = screen.name.replace('Screen', '').replace(/([A-Z])/g, ' $1').trim();
  const mockData = getDomainMockData(domain);

  return `import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

enum _ViewState { loading, empty, error, content }

class ${widgetClass} extends StatefulWidget {
  const ${widgetClass}({super.key});

  @override
  State<${widgetClass}> createState() => _${widgetClass}State();
}

class _${widgetClass}State extends State<${widgetClass}> with SingleTickerProviderStateMixin {
  _ViewState _viewState = _ViewState.loading;
  late AnimationController _animController;
  late Animation<double> _fadeAnim;
  final List<Map<String, dynamic>> _items = [];
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _animController = AnimationController(vsync: this, duration: const Duration(milliseconds: 400));
    _fadeAnim = CurvedAnimation(parent: _animController, curve: Curves.easeOut);
    _loadData();
  }

  @override
  void dispose() {
    _animController.dispose();
    super.dispose();
  }

  Future<void> _loadData() async {
    if (!mounted) return;
    setState(() { _viewState = _ViewState.loading; _errorMessage = null; });
    try {
      await Future.delayed(const Duration(milliseconds: 900));
      final data = ${JSON.stringify(mockData).replace(/"/g, "'")};
      if (!mounted) return;
      setState(() {
        _items
          ..clear()
          ..addAll(data.map((d) => Map<String, dynamic>.from(d)));
        _viewState = _items.isEmpty ? _ViewState.empty : _ViewState.content;
      });
      _animController.forward(from: 0);
    } catch (e) {
      if (!mounted) return;
      setState(() { _viewState = _ViewState.error; _errorMessage = e.toString(); });
    }
  }

  Future<void> _onRefresh() => _loadData();

  void _onPrimaryAction() {
    _showCreateBottomSheet(context);
  }

  void _showCreateBottomSheet(BuildContext context) {
    final theme = Theme.of(context);
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(${radius * 2})),
      ),
      builder: (ctx) => DraggableScrollableSheet(
        initialChildSize: 0.6,
        minChildSize: 0.4,
        maxChildSize: 0.95,
        expand: false,
        builder: (_, controller) => Padding(
          padding: EdgeInsets.only(
            left: 24, right: 24, top: 16,
            bottom: MediaQuery.of(ctx).viewInsets.bottom + 24,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(child: Container(width: 40, height: 4, decoration: BoxDecoration(color: theme.colorScheme.outlineVariant, borderRadius: BorderRadius.circular(2)))),
              const SizedBox(height: 20),
              Text('${screen.primaryAction}', style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
              const SizedBox(height: 20),
              TextField(
                decoration: const InputDecoration(labelText: 'Title', hintText: 'Enter a title...'),
                autofocus: true,
              ),
              const SizedBox(height: 12),
              TextField(
                decoration: const InputDecoration(labelText: 'Description', hintText: 'Optional description...'),
                maxLines: 3,
              ),
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: () {
                    Navigator.of(ctx).pop();
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: const Text('Created successfully!'), behavior: SnackBarBehavior.floating),
                    );
                  },
                  child: const Text('Create'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    return Scaffold(
      appBar: _buildAppBar(theme, cs),
      body: AnimatedSwitcher(
        duration: const Duration(milliseconds: 300),
        child: _buildBody(theme, cs),
      ),
      floatingActionButton: _viewState == _ViewState.content
          ? FloatingActionButton.extended(
              onPressed: _onPrimaryAction,
              icon: const Icon(Icons.add_rounded),
              label: const Text('${screen.primaryAction}'),
            )
          : null,
    );
  }

  PreferredSizeWidget _buildAppBar(ThemeData theme, ColorScheme cs) {
    return AppBar(
      title: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${title}', style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
          if (_viewState == _ViewState.content)
            Text('\${_items.length} items', style: theme.textTheme.labelMedium?.copyWith(color: cs.outline)),
        ],
      ),
      actions: [
        IconButton(icon: const Icon(Icons.search_rounded), tooltip: 'Search', onPressed: () {}),
        IconButton(icon: const Icon(Icons.tune_rounded), tooltip: 'Filter', onPressed: () {}),
      ],
    );
  }

  Widget _buildBody(ThemeData theme, ColorScheme cs) {
    switch (_viewState) {
      case _ViewState.loading:
        return _buildShimmer(cs);
      case _ViewState.empty:
        return _buildEmpty(theme, cs);
      case _ViewState.error:
        return _buildError(theme, cs);
      case _ViewState.content:
        return _buildList(theme, cs);
    }
  }

  Widget _buildShimmer(ColorScheme cs) {
    return ListView.builder(
      key: const ValueKey('loading'),
      padding: const EdgeInsets.all(16),
      itemCount: 6,
      itemBuilder: (_, i) => _ShimmerCard(cs: cs, radius: ${radius}),
    );
  }

  Widget _buildEmpty(ThemeData theme, ColorScheme cs) {
    return Center(
      key: const ValueKey('empty'),
      child: Padding(
        padding: const EdgeInsets.all(40),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 120, height: 120,
              decoration: BoxDecoration(color: cs.primaryContainer, shape: BoxShape.circle),
              child: Icon(Icons.inbox_outlined, size: 56, color: cs.primary),
            ),
            const SizedBox(height: 24),
            Text('Nothing here yet', style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            Text(
              '${screen.states.empty}',
              style: theme.textTheme.bodyMedium?.copyWith(color: cs.outline),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 32),
            FilledButton.icon(
              onPressed: _onPrimaryAction,
              icon: const Icon(Icons.add_rounded),
              label: const Text('Get Started'),
              style: FilledButton.styleFrom(minimumSize: const Size(200, 48)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildError(ThemeData theme, ColorScheme cs) {
    return Center(
      key: const ValueKey('error'),
      child: Padding(
        padding: const EdgeInsets.all(40),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off_rounded, size: 72, color: cs.error),
            const SizedBox(height: 20),
            Text('Something went wrong', style: theme.textTheme.headlineSmall),
            const SizedBox(height: 8),
            Text(
              _errorMessage ?? '${screen.states.error}',
              style: theme.textTheme.bodyMedium?.copyWith(color: cs.outline),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 32),
            FilledButton.icon(
              onPressed: _loadData,
              icon: const Icon(Icons.refresh_rounded),
              label: const Text('Try Again'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildList(ThemeData theme, ColorScheme cs) {
    return FadeTransition(
      key: const ValueKey('content'),
      opacity: _fadeAnim,
      child: RefreshIndicator(
        onRefresh: _onRefresh,
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.all(16),
              sliver: SliverList(
                delegate: SliverChildBuilderDelegate(
                  (context, index) {
                    if (index >= _items.length) return null;
                    return _buildItemCard(theme, cs, _items[index], index);
                  },
                  childCount: _items.length,
                ),
              ),
            ),
            const SliverPadding(padding: EdgeInsets.only(bottom: 80)),
          ],
        ),
      ),
    );
  }

  Widget _buildItemCard(ThemeData theme, ColorScheme cs, Map<String, dynamic> item, int index) {
    return Dismissible(
      key: Key('\${item['id'] ?? index}'),
      direction: DismissDirection.endToStart,
      background: Container(
        margin: const EdgeInsets.only(bottom: 8),
        decoration: BoxDecoration(color: cs.errorContainer, borderRadius: BorderRadius.circular(${radius})),
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 20),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(Icons.delete_rounded, color: cs.error),
          const SizedBox(height: 4),
          Text('Remove', style: theme.textTheme.labelSmall?.copyWith(color: cs.error)),
        ]),
      ),
      onDismissed: (_) {
        final removed = _items[index];
        setState(() => _items.removeAt(index));
        if (_items.isEmpty) setState(() => _viewState = _ViewState.empty);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('"\${removed['title'] ?? 'Item'}" removed'),
            behavior: SnackBarBehavior.floating,
            action: SnackBarAction(
              label: 'Undo',
              onPressed: () => setState(() { _items.insert(index, removed); _viewState = _ViewState.content; }),
            ),
          ),
        );
      },
      child: Card(
        margin: const EdgeInsets.only(bottom: 8),
        child: InkWell(
          onTap: () {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('Opened: \${item['title'] ?? 'Item'}'), behavior: SnackBarBehavior.floating),
            );
          },
          borderRadius: BorderRadius.circular(${radius}),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                _buildItemIcon(cs, item, index),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '\${item['title'] ?? '${title} \${index + 1}'}',
                        style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      if (item['subtitle'] != null) ...[
                        const SizedBox(height: 2),
                        Text(
                          '\${item['subtitle']}',
                          style: theme.textTheme.bodyMedium?.copyWith(color: cs.outline),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                      if (item['badge'] != null) ...[
                        const SizedBox(height: 8),
                        _buildBadge(theme, cs, '\${item['badge']}', item['badgeColor']),
                      ],
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right_rounded, size: 20),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildItemIcon(ColorScheme cs, Map<String, dynamic> item, int index) {
    final colors = [cs.primaryContainer, cs.secondaryContainer, cs.tertiaryContainer];
    final fgColors = [cs.onPrimaryContainer, cs.onSecondaryContainer, cs.onTertiaryContainer];
    final bgColor = colors[index % colors.length];
    final fgColor = fgColors[index % fgColors.length];
    return Container(
      width: 48, height: 48,
      decoration: BoxDecoration(color: bgColor, borderRadius: BorderRadius.circular(${Math.round(radius * 0.75)})),
      child: Center(child: Text(
        '\${(item['title'] ?? '?')[0].toUpperCase()}',
        style: TextStyle(color: fgColor, fontWeight: FontWeight.bold, fontSize: 20),
      )),
    );
  }

  Widget _buildBadge(ThemeData theme, ColorScheme cs, String label, dynamic colorHint) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: cs.primaryContainer,
        borderRadius: BorderRadius.circular(100),
      ),
      child: Text(label, style: theme.textTheme.labelSmall?.copyWith(color: cs.onPrimaryContainer, fontWeight: FontWeight.w600)),
    );
  }
}

// ── Shimmer skeleton widget ────────────────────────────────────────────────────
class _ShimmerCard extends StatefulWidget {
  final ColorScheme cs;
  final double radius;
  const _ShimmerCard({required this.cs, required this.radius});

  @override
  State<_ShimmerCard> createState() => _ShimmerCardState();
}

class _ShimmerCardState extends State<_ShimmerCard> with SingleTickerProviderStateMixin {
  late AnimationController _ctrl;
  late Animation<double> _anim;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200))..repeat(reverse: true);
    _anim = CurvedAnimation(parent: _ctrl, curve: Curves.easeInOut);
  }

  @override
  void dispose() { _ctrl.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _anim,
      builder: (_, __) {
        final base = widget.cs.surfaceContainerHighest;
        final shine = widget.cs.surfaceContainerHighest.withOpacity(0.3 + _anim.value * 0.4);
        return Container(
          height: 76,
          margin: const EdgeInsets.only(bottom: 8),
          decoration: BoxDecoration(
            color: Color.lerp(base, shine, _anim.value),
            borderRadius: BorderRadius.circular(widget.radius),
          ),
        );
      },
    );
  }
}
`;
}

function getDomainMockData(domain: string): Array<Record<string, unknown>> {
  const mockSets: Record<string, Array<Record<string, unknown>>> = {
    ecommerce: [
      { id: '1', title: 'Wireless Noise-Cancelling Headphones', subtitle: 'Sony • Electronics', badge: 'In Stock', badgeColor: 'green' },
      { id: '2', title: 'Premium Running Shoes', subtitle: 'Nike Air Max 2024', badge: 'Sale 30%', badgeColor: 'red' },
      { id: '3', title: 'Leather Crossbody Bag', subtitle: 'Coach • Accessories', badge: 'New Arrival', badgeColor: 'blue' },
      { id: '4', title: 'Smart Watch Series 9', subtitle: 'Apple • Wearables', badge: 'Best Seller', badgeColor: 'purple' },
      { id: '5', title: 'Portable Coffee Maker', subtitle: 'Nespresso • Kitchen', badge: null, badgeColor: null },
    ],
    fitness: [
      { id: '1', title: 'Morning Power Run', subtitle: '45 min • 520 kcal • Cardio', badge: 'Completed', badgeColor: 'green' },
      { id: '2', title: 'Upper Body Strength', subtitle: '60 min • 380 kcal • Weights', badge: 'Today', badgeColor: 'blue' },
      { id: '3', title: 'Core & Flexibility', subtitle: '30 min • 180 kcal • Yoga', badge: 'Tomorrow', badgeColor: 'orange' },
      { id: '4', title: 'HIIT Interval Training', subtitle: '25 min • 420 kcal • Cardio', badge: 'Popular', badgeColor: 'red' },
      { id: '5', title: 'Evening Walk', subtitle: '50 min • 220 kcal • Outdoor', badge: null, badgeColor: null },
    ],
    tasks: [
      { id: '1', title: 'Design system review', subtitle: 'Due today • High priority', badge: 'Urgent', badgeColor: 'red' },
      { id: '2', title: 'API integration testing', subtitle: 'Due tomorrow • Medium', badge: 'In Progress', badgeColor: 'blue' },
      { id: '3', title: 'User research interviews', subtitle: 'Due this week • Low', badge: 'Planned', badgeColor: 'gray' },
      { id: '4', title: 'Write release notes', subtitle: 'Due Friday • Medium', badge: 'Blocked', badgeColor: 'orange' },
      { id: '5', title: 'Performance optimization', subtitle: 'Due next week • Low', badge: null, badgeColor: null },
    ],
    social: [
      { id: '1', title: '@alice_designs', subtitle: 'Just shared 12 new photos from Bali 🌴', badge: 'Following', badgeColor: 'green' },
      { id: '2', title: '@tech_startup', subtitle: 'Exciting announcement coming Monday! 🚀', badge: 'Trending', badgeColor: 'red' },
      { id: '3', title: '@foodie_world', subtitle: 'The best ramen recipe you will ever make 🍜', badge: null, badgeColor: null },
      { id: '4', title: '@travel_diaries', subtitle: 'Hidden gems in Southeast Asia thread 🗺️', badge: 'Hot', badgeColor: 'orange' },
    ],
    finance: [
      { id: '1', title: 'Grocery Shopping', subtitle: 'Whole Foods • Today 2:30 PM', badge: 'Food & Drink', badgeColor: 'green' },
      { id: '2', title: 'Netflix Subscription', subtitle: 'Monthly • Nov 14', badge: 'Entertainment', badgeColor: 'red' },
      { id: '3', title: 'Salary Deposit', subtitle: 'Company Inc. • Nov 1', badge: 'Income', badgeColor: 'blue' },
      { id: '4', title: 'Electric Bill', subtitle: 'City Power • Due Nov 20', badge: 'Utilities', badgeColor: 'orange' },
      { id: '5', title: 'Coffee & Lunch', subtitle: 'Starbucks • Yesterday', badge: 'Food & Drink', badgeColor: 'green' },
    ],
    food: [
      { id: '1', title: 'Creamy Butter Chicken', subtitle: '45 min • 520 kcal • Indian', badge: 'Popular', badgeColor: 'red' },
      { id: '2', title: 'Avocado Toast Deluxe', subtitle: '15 min • 380 kcal • Breakfast', badge: 'Quick', badgeColor: 'green' },
      { id: '3', title: 'Chocolate Lava Cake', subtitle: '30 min • 450 kcal • Dessert', badge: 'Trending', badgeColor: 'purple' },
      { id: '4', title: 'Green Buddha Bowl', subtitle: '20 min • 310 kcal • Healthy', badge: 'Vegan', badgeColor: 'green' },
    ],
    general: [
      { id: '1', title: 'Getting Started Guide', subtitle: 'Complete introduction to the app', badge: 'New', badgeColor: 'blue' },
      { id: '2', title: 'Feature Overview', subtitle: 'All features explained in detail', badge: 'Popular', badgeColor: 'green' },
      { id: '3', title: 'Quick Tips & Tricks', subtitle: 'Make the most of your experience', badge: null, badgeColor: null },
    ],
  };
  return mockSets[domain] || mockSets['general'];
}

/**
 * Sanitize an app name into a valid Dart package name using the exact rule
 * used elsewhere in the codebase (lowercase → non [a-z0-9] → '_' → collapse).
 * Falls back to 'flutterforge_app' when nothing usable remains; state carries
 * no pubspec, and projectContract rewrites imports against the real pubspec
 * name later if it differs.
 */
export function sanitizePackageName(rawAppName: string | null | undefined): string {
  const cleaned = (rawAppName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[a-z][a-z0-9_]*$/.test(cleaned) ? cleaned : 'flutterforge_app';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FORBIDDEN_MARKERS: Array<{ re: RegExp; label: string }> = [
  { re: /\bTODO\b/i, label: 'TODO' },
  { re: /\bFIXME\b/i, label: 'FIXME' },
  { re: /\bUnimplementedError\b/, label: 'UnimplementedError' },
  { re: /\bplaceholder\b/i, label: 'placeholder' },
];

/** Returns the first forbidden marker found in the file, or null. */
function forbiddenMarker(content: string): string | null {
  for (const marker of FORBIDDEN_MARKERS) {
    if (marker.re.test(content)) return marker.label;
  }
  return null;
}

function skippedFileDiagnostic(filePath: string, screenName: string, reason: string): GateDiagnostic {
  return {
    gate: 'frontend-builder',
    level: 'error',
    filePath,
    message: `Screen ${screenName}: rejected ${filePath} — ${reason}`,
    suggestion: 'The file was NOT written to the project. Regenerate the screen with complete, balanced Dart.',
  };
}

/**
 * Structural check: braces, parens and brackets must be balanced outside of
 * strings and comments. Handles line/block comments (block comments nest in
 * Dart), single/double-quoted strings, triple-quoted strings, raw strings and
 * string interpolation ($ident and ${ expression } — including nested strings).
 * Returns false for unterminated strings/comments or mismatched closers, which
 * is the signature of LLM output truncated at maxTokens.
 */
export function isDartBalanced(source: string): boolean {
  type Frame = {
    kind: 'code' | 'string' | 'line-comment' | 'block-comment';
    quote?: string;
    triple?: boolean;
    raw?: boolean;
    depth?: number;
  };
  const frames: Frame[] = [{ kind: 'code' }];
  const stack: string[] = [];
  const expectedOpener: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
  const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
  const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c);
  const n = source.length;
  let i = 0;

  while (i < n) {
    const frame = frames[frames.length - 1];
    const ch = source[i];

    if (frame.kind === 'line-comment') {
      if (ch === '\n') frames.pop();
      i += 1;
      continue;
    }

    if (frame.kind === 'block-comment') {
      if (ch === '/' && source[i + 1] === '*') {
        frame.depth = (frame.depth ?? 1) + 1;
        i += 2;
        continue;
      }
      if (ch === '*' && source[i + 1] === '/') {
        const depth = (frame.depth ?? 1) - 1;
        if (depth <= 0) frames.pop();
        else frame.depth = depth;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (frame.kind === 'string') {
      const quote = frame.quote ?? "'";
      if (frame.triple) {
        if (!frame.raw && ch === '\\') { i += 2; continue; }
        if (ch === quote && source[i + 1] === quote && source[i + 2] === quote) {
          frames.pop();
          i += 3;
          continue;
        }
      } else {
        if (ch === quote) { frames.pop(); i += 1; continue; }
        if (!frame.raw && ch === '\\') { i += 2; continue; }
      }
      if (!frame.raw && ch === '$') {
        const next = source[i + 1];
        if (next === '{') {
          frames.push({ kind: 'code', depth: 0 });
          stack.push('{');
          i += 2;
          continue;
        }
        if (next && isIdentStart(next)) {
          i += 2;
          while (i < n && isIdentPart(source[i])) i += 1;
          continue;
        }
      }
      i += 1;
      continue;
    }

    // code frame (a frame with depth !== undefined is a ${ ... } interpolation;
    // its depth counts braces opened inside the interpolation itself)
    const isInterpolation = frame.depth !== undefined;
    if (ch === '/' && source[i + 1] === '/') {
      frames.push({ kind: 'line-comment' });
      i += 2;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      frames.push({ kind: 'block-comment', depth: 1 });
      i += 2;
      continue;
    }
    if (ch === 'r' && (source[i + 1] === "'" || source[i + 1] === '"')) {
      const prev = i > 0 ? source[i - 1] : '';
      if (!prev || !isIdentPart(prev)) {
        const quote = source[i + 1];
        const triple = source[i + 2] === quote && source[i + 3] === quote;
        frames.push({ kind: 'string', quote, triple, raw: true });
        i += triple ? 4 : 2;
        continue;
      }
    }
    if (ch === "'" || ch === '"') {
      const triple = source[i + 1] === ch && source[i + 2] === ch;
      frames.push({ kind: 'string', quote: ch, triple, raw: false });
      i += triple ? 3 : 1;
      continue;
    }
    if (ch === '{') {
      if (isInterpolation) frame.depth = (frame.depth ?? 0) + 1;
      stack.push('{');
      i += 1;
      continue;
    }
    if (ch === '(' || ch === '[') {
      stack.push(ch);
      i += 1;
      continue;
    }
    if (ch === '}') {
      if (isInterpolation && frame.depth === 0) {
        // Closing brace of the ${ interpolation itself.
        frames.pop();
        if (stack.pop() !== '{') return false;
        i += 1;
        continue;
      }
      if (isInterpolation) frame.depth = (frame.depth ?? 1) - 1;
      if (stack.pop() !== '{') return false;
      i += 1;
      continue;
    }
    if (ch === ')' || ch === ']') {
      if (stack.pop() !== expectedOpener[ch]) return false;
      i += 1;
      continue;
    }
    i += 1;
  }

  // Well-formed only if we exited every string/comment/interpolation frame and
  // every delimiter was closed.
  return frames.length === 1 && frames[0].kind === 'code' && stack.length === 0;
}

function toPascalCase(value: string): string {
  const parts = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

function singularizeWord(word: string): string {
  const w = word;
  const lower = w.toLowerCase();
  if (/(series|species|status|analysis)$/.test(lower)) return w;
  if (/ies$/i.test(w)) {
    const stem = w.slice(0, -3);
    if (/s$/i.test(stem)) return stem; // classes → class
    return stem.length >= 3 && /[^aeiou]$/i.test(stem) ? `${stem}y` : `${stem}e`;
  }
  if (/(ses|xes|zes|ches|shes)$/i.test(w)) return w.slice(0, -2); // boxes → box, churches → church
  if (/s$/i.test(w) && !/(ss|us|is)$/i.test(w)) return w.slice(0, -1); // tasks → task, settings → setting
  return w;
}

/**
 * Derive a unique, singularized PascalCase class name from the screen name,
 * e.g. "UsersScreen" → "UserScreen", "TasksSettingsScreen" → "TasksSettingScreen".
 */
export function deriveScreenClassName(name: string): string {
  const base = (name || '').replace(/Screen$/i, '');
  const pascal = toPascalCase(base);
  const segments = pascal.match(/[A-Za-z]+[a-z0-9]*|[0-9]+|[A-Z]+/g) ?? [];
  if (segments.length === 0) return 'HomeScreen';
  // Singularize the final word (the screened noun).
  const last = segments.length - 1;
  segments[last] = singularizeWord(segments[last]);
  const joined = segments.join('');
  return `${joined || 'Home'}Screen`;
}

function uniquifyClassName(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const root = candidate.replace(/Screen$/, '');
  let n = 2;
  let next = `${root}${n}Screen`;
  while (used.has(next)) {
    n += 1;
    next = `${root}${n}Screen`;
  }
  used.add(next);
  return next;
}

const MAIN_WIDGET_CLASS_PATTERN = /class\s+([A-Za-z_][A-Za-z0-9_]*)\s+extends\s+(StatelessWidget|StatefulWidget|ConsumerWidget|ConsumerStatefulWidget|HookWidget|HookConsumerWidget)\b/;

/**
 * Rename the screen's main widget class (and its private State class) to the
 * canonical class name. Returns null when no widget class is declared.
 */
function renameMainWidgetClass(source: string, canonical: string): string | null {
  const match = source.match(MAIN_WIDGET_CLASS_PATTERN);
  if (!match) return null;
  const from = match[1];
  if (from === canonical) return source;
  // Longest, most specific identifier first: the private State class.
  let out = source.split(`_${from}State`).join(`_${canonical}State`);
  out = out.split(`${from}State`).join(`${canonical}State`);
  out = out.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, 'g'), canonical);
  return out;
}

function buildDesignTokensSection(tokens: DesignTokens | null | undefined): string {
  if (!tokens) {
    return [
      'Design tokens: NONE provided by the design system stage.',
      'Fall back to Theme.of(context).colorScheme for ALL colors and theme.textTheme for typography.',
      'NEVER hardcode hex colors and NEVER invent a palette.',
    ].join('\n');
  }
  const entries: Array<[string, string | number | undefined]> = [
    ['primaryColor', tokens.primaryColor],
    ['secondaryColor', tokens.secondaryColor],
    ['accentColor', tokens.accentColor],
    ['backgroundColor', tokens.backgroundColor],
    ['surfaceColor', tokens.surfaceColor],
    ['fontFamily', tokens.fontFamily],
    ['borderRadius', typeof tokens.borderRadius === 'number' ? `${tokens.borderRadius}px` : undefined],
  ];
  const lines = entries
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `- ${key}: ${value}`);
  return [
    'Design tokens (Material 3 — use ONLY these; never hardcode other hex/neon colors, never invent a palette):',
    ...lines,
    'If a token key is missing, fall back to Theme.of(context).colorScheme. Never invent a new palette.',
  ].join('\n');
}

function normalizeHexColor(raw: string): string {
  let h = raw.replace(/^#/, '').toLowerCase();
  if (h.length === 8 && h.startsWith('ff')) h = h.slice(2);
  return h;
}

/** Collect the hex colors present in the design tokens map (the only allowed hardcoded hexes). */
function designTokenHexes(tokens: DesignTokens | null | undefined): Set<string> {
  const hexes = new Set<string>();
  if (!tokens) return hexes;
  for (const value of Object.values(tokens)) {
    if (typeof value !== 'string') continue;
    for (const match of value.matchAll(/#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g)) {
      hexes.add(normalizeHexColor(match[1]));
    }
  }
  return hexes;
}

/** Find hardcoded color literals that do not correspond to a design token. */
function findOffTokenColorLiterals(content: string, tokenHexes: Set<string>): string[] {
  const findings: string[] = [];
  for (const match of content.matchAll(/0[xX]([0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g)) {
    if (!tokenHexes.has(normalizeHexColor(match[1]))) findings.push(`0x${match[1]}`);
  }
  for (const match of content.matchAll(/Color\.fromARGB\(\s*\d+\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g)) {
    const hex = [match[1], match[2], match[3]]
      .map((part) => Math.min(255, Math.max(0, Number(part) || 0)).toString(16).padStart(2, '0'))
      .join('');
    if (!tokenHexes.has(hex)) findings.push('Color.fromARGB(...)');
  }
  for (const match of content.matchAll(/Color\.fromRGBO\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g)) {
    void match;
    findings.push('Color.fromRGBO(...)');
  }
  return [...new Set(findings)];
}

/**
 * Count postfix `!` non-null assertions, ignoring `!=` and bangs that follow
 * whitespace (logical NOT) or quotes (punctuation inside strings).
 */
function countNonNullAssertions(content: string): number {
  const matches = content.match(/[A-Za-z0-9_)\]]!(?=[.[),;:]|\s|$)/g);
  return matches ? matches.length : 0;
}
