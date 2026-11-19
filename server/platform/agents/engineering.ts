/**
 * Engineering agents — architecture, Dart, backend, data, state and supply chain.
 *
 * These are the specialists that would block a pull request in a real Flutter
 * team. They work on the emitted source, not on intentions.
 */
import type { AgentDefinition, AgentFinding, ReviewContext, ReviewFile } from './types.js';
import { analyzeDart, buildImportGraph } from '../dart/index.js';
import {
  callBlocks,
  capFindings,
  countMatches,
  dartFiles,
  finding,
  firstMatchLine,
  importedPackages,
  importRoots,
  libFiles,
  parsePubspec,
  stripDart,
} from './shared.js';

function repositoryFiles(context: ReviewContext): ReviewFile[] {
  return libFiles(context).filter((file) => /\/data\/repositories\//.test(file.path));
}

/** Feature screens, across the naming conventions real Flutter projects use. */
function pageFiles(context: ReviewContext): ReviewFile[] {
  return libFiles(context).filter(
    (file) => /\/features\//.test(file.path) && /(?:_page|_screen|_view)\.dart$/.test(file.path),
  );
}

function lineCount(source: string): number {
  return source.split(/\r?\n/).length;
}

export const flutterArchitectAgent: AgentDefinition = {
  id: 'flutter-architect',
  name: 'Aksel',
  title: 'Flutter Architect',
  department: 'engineering',
  description: 'Enforces feature-first layering: screens depend on controllers, controllers on repositories, and nothing points upward.',
  capabilities: ['layering', 'clean-architecture', 'reverse-dependency-detection'],
  mode: 'deterministic',
  run(context) {
    const findings: AgentFinding[] = [];
    const lib = libFiles(context);
    if (lib.length === 0) {
      return [finding('ARCH_NO_LIB', 'blocker', 'No lib/ Dart files exist.', { suggestion: 'Scaffold or generate the project before reviewing architecture.' })];
    }

    if (!lib.some((file) => file.path.startsWith('lib/features/'))) {
      findings.push(finding('ARCH_NO_FEATURE_LAYER', 'blocker', 'There is no lib/features layer — screens and logic are not separated by feature.', {
        suggestion: 'Adopt feature-first folders: lib/features/<feature>/presentation|domain|data.',
      }));
    }

    for (const page of pageFiles(context)) {
      const code = stripDart(page.content);
      if (/(?:import\s+['"][^'"]*\/data\/repositories\/)|(?:Repository\s*\()|(?:repository\.\w+\s*\()/i.test(code)) {
        findings.push(finding('ARCH_PAGE_REACHES_REPOSITORY', 'blocker', 'A page talks to a repository directly, bypassing its controller.', {
          file: page.path,
          suggestion: 'Call the controller and let it own data access, loading and error state.',
        }));
      }
      if (callBlocks(code, 'build').some((block) => /\bawait\b/.test(block.body))) {
        findings.push(finding('ARCH_ASYNC_BUILD', 'major', 'A build() method contains an await, so the widget tree is built from unfinished work.', {
          file: page.path,
          suggestion: 'Move async work into the controller/initState and render state instead.',
        }));
      }
    }

    for (const file of lib) {
      if (file.path.startsWith('lib/data/') && /import\s+['"][^'"]*\/features\//.test(stripDart(file.content))) {
        findings.push(finding('ARCH_REVERSE_DEPENDENCY', 'blocker', 'The data layer imports a feature layer (upward dependency).', {
          file: file.path,
          suggestion: 'Invert the dependency: features depend on data, never the reverse.',
        }));
      }
      if (lineCount(file.content) > 800) {
        findings.push(finding('ARCH_OVERSIZED_FILE', 'minor', `${lineCount(file.content)} lines in one file — likely a god widget/controller.`, {
          file: file.path,
          suggestion: 'Split by responsibility (components, sections, helpers).',
        }));
      }
    }

    return capFindings(findings);
  },
};

export const dartEngineerAgent: AgentDefinition = {
  id: 'dart-engineer',
  name: 'Lio',
  title: 'Dart Engineer',
  department: 'engineering',
  description: 'Parses every Dart file, checks import graph integrity and flags unsafe language patterns such as dynamic leakage and lint suppression.',
  capabilities: ['parse-integrity', 'import-graph', 'null-safety', 'lint-hygiene'],
  mode: 'deterministic',
  run(context) {
    const findings: AgentFinding[] = [];
    const files = dartFiles(context);
    if (files.length === 0) {
      return [finding('DART_NO_FILES', 'blocker', 'There are no Dart files to review.', { suggestion: 'Generate the project first.' })];
    }

    let parseErrors = 0;
    let parseErrorFile: string | null = null;
    for (const file of files) {
      const analysis = analyzeDart(file.content);
      if (analysis.errors.length > 0) {
        parseErrors += analysis.errors.length;
        parseErrorFile ??= file.path;
      }
    }
    if (parseErrors > 0) {
      findings.push(finding('DART_PARSE_ERROR', 'blocker', `${parseErrors} parse error(s) across the project — the code cannot compile.`, {
        file: parseErrorFile ?? undefined,
        suggestion: 'Fix the first parser error, re-run the analyzer, repeat.',
      }));
    }

    if (context.packageName) {
      const graph = buildImportGraph(
        files.map((file) => ({ path: file.path, content: file.content })),
        context.packageName,
      );
      if (graph.unresolved.length > 0) {
        const first = graph.unresolved[0];
        findings.push(finding('DART_UNRESOLVED_IMPORT', 'blocker', `${graph.unresolved.length} import(s) point at files that do not exist.`, {
          file: first.path,
          line: first.line,
          evidence: first.uri,
          suggestion: 'Emit the missing file or correct the URI.',
        }));
      }
      // The graph reports every non-self package import; only those that are
      // also absent from the declared dependencies are actually wrong.
      const declared = importRoots(parsePubspec(context.pubspec));
      const undeclared = graph.selfPackageMismatches.filter(
        (mismatch) => mismatch.packageName !== context.packageName && !declared.has(mismatch.packageName),
      );
      if (undeclared.length > 0) {
        findings.push(finding('DART_SELF_PACKAGE_MISMATCH', 'major', `${undeclared.length} import(s) use a package that is neither the project nor a declared dependency.`, {
          file: undeclared[0].path,
          line: undeclared[0].line,
          evidence: undeclared[0].uri,
          suggestion: 'Declare the package in pubspec.yaml or remove the import.',
        }));
      }
      if (graph.importCycles.length > 0) {
        findings.push(finding('DART_IMPORT_CYCLE', 'minor', `${graph.importCycles.length} import cycle(s) make the dependency direction ambiguous.`, {
          evidence: graph.importCycles[0].join(' → '),
          suggestion: 'Extract the shared contract into a lower layer.',
        }));
      }
    }

    let dynamicCount = 0;
    let assertionCount = 0;
    let printCount = 0;
    let ignoreCount = 0;
    for (const file of libFiles(context)) {
      const code = stripDart(file.content);
      dynamicCount += countMatches(code, /\bdynamic\b/g);
      assertionCount += countMatches(code, /[A-Za-z0-9_\])]!(?![=])/g);
      printCount += countMatches(code, /\bprint\s*\(/g);
      ignoreCount += countMatches(code, /\/\/\s*ignore\s*:/g);
    }
    if (dynamicCount > 5) {
      findings.push(finding('DART_DYNAMIC_LEAK', 'minor', `${dynamicCount} dynamic annotations in shipped code weaken type safety.`, {
        suggestion: 'Replace dynamic with concrete types or generics at boundaries.',
      }));
    }
    if (assertionCount > 10) {
      findings.push(finding('DART_FORCE_UNWRAP', 'minor', `${assertionCount} non-null assertions (!) — a null crash waiting to happen.`, {
        suggestion: 'Use pattern matching, null-aware access or an explicit fallback.',
      }));
    }
    if (printCount > 0) {
      findings.push(finding('DART_PRINT_IN_LIB', 'minor', `${printCount} print() call(s) in lib/ — not structured logging.`, {
        suggestion: 'Use developer.log or the project logger so output can be filtered in release.',
      }));
    }
    if (ignoreCount > 0) {
      findings.push(finding('DART_LINT_SUPPRESSION', 'minor', `${ignoreCount} // ignore: suppression(s) hide analyzer signal.`, {
        suggestion: 'Fix the underlying issue or scope the ignore to a single documented line.',
      }));
    }

    return capFindings(findings);
  },
};

export const backendEngineerAgent: AgentDefinition = {
  id: 'backend-engineer',
  name: 'Rafael',
  title: 'Backend & API Engineer',
  department: 'engineering',
  description: 'Reviews repository seams, network timeouts, error propagation and list pagination in the app’s data layer.',
  capabilities: ['repository-contracts', 'timeouts', 'error-propagation', 'pagination'],
  mode: 'deterministic',
  run(context) {
    const findings: AgentFinding[] = [];
    const lib = libFiles(context);
    if (lib.length === 0) return findings;

    for (const repo of repositoryFiles(context)) {
      const code = stripDart(repo.content);
      const abstractClass = /\babstract\s+(?:interface\s+)?class\s+/.test(code);
      if (!abstractClass) {
        findings.push(finding('BACKEND_NO_CONTRACT', 'major', 'Repository has no abstract contract, so callers are coupled to the implementation.', {
          file: repo.path,
          suggestion: 'Declare an abstract repository interface plus an in-memory/remote implementation.',
        }));
      }
    }

    let networkFiles = 0;
    for (const file of lib) {
      const code = stripDart(file.content);
      const usesNetwork = /\b(http\.(?:get|post|put|delete|patch)\s*\()|\bDio\s*\(|\bHttpClient\s*\(/.test(code);
      if (!usesNetwork) continue;
      networkFiles += 1;
      if (!/\btimeout\s*:|\bconnectTimeout\b|\breceiveTimeout\b|\b\.timeout\s*\(/.test(code)) {
        findings.push(finding('BACKEND_NO_TIMEOUT', 'major', 'A network client is created without any timeout.', {
          file: file.path,
          suggestion: 'Set connect/receive timeouts and surface a retryable error to the controller.',
        }));
      }
    }

    const dataFiles = lib.filter((file) => file.path.startsWith('lib/data/'));
    let unguardedAwait = 0;
    for (const file of dataFiles) {
      const code = stripDart(file.content);
      const awaits = countMatches(code, /\bawait\b/g);
      const catches = countMatches(code, /\btry\s*\{|\bcatch\s*\(|\bon\s+[A-Za-z]+\s+catch\b/g);
      if (awaits > 0 && catches === 0) unguardedAwait += awaits;
    }
    if (unguardedAwait > 0) {
      findings.push(finding('BACKEND_UNGUARDED_AWAIT', 'minor', `${unguardedAwait} awaited data call(s) have no try/catch on the path.`, {
        suggestion: 'Convert transport failures into a typed result the controller can render.',
      }));
    }

    if (networkFiles > 0) {
      const hasPagination = lib.some((file) => /\b(limit|page|offset|cursor|pageSize)\b/i.test(stripDart(file.content)));
      if (!hasPagination) {
        findings.push(finding('BACKEND_NO_PAGINATION', 'minor', 'Network-backed lists have no pagination/limit seam.', {
          suggestion: 'Accept limit/cursor in the repository so large collections do not load at once.',
        }));
      }
    }

    return capFindings(findings);
  },
};

export const databaseEngineerAgent: AgentDefinition = {
  id: 'database-engineer',
  name: 'Priya',
  title: 'Database Engineer',
  department: 'engineering',
  description: 'Audits SQL/RLS artifacts: every table protected by row-level security, no destructive migration, declared foreign keys.',
  capabilities: ['rls', 'migrations', 'foreign-keys', 'schema-safety'],
  mode: 'deterministic',
  run(context) {
    const findings: AgentFinding[] = [];
    const sqlFiles = context.files.filter((file) => file.path.endsWith('.sql') || /migrations?\//.test(file.path));
    const pubspec = parsePubspec(context.pubspec);
    const supabase = [...pubspec.dependencies.keys()].some((dep) => dep.startsWith('supabase')) || pubspec.dependencies.has('supabase_flutter');

    if (sqlFiles.length === 0) {
      if (supabase) {
        findings.push(finding('DB_RLS_ARTIFACTS_MISSING', 'major', 'The project uses Supabase but ships no SQL/RLS artifacts.', {
          suggestion: 'Version schema and policies in supabase/migrations and review them like code.',
        }));
      } else {
        findings.push(finding('DB_NO_SURFACE', 'info', 'No SQL/RLS surface in this project — local repository only.', {}));
      }
      return findings;
    }

    let tables = 0;
    let tablesWithRls = 0;
    let destructive: { file: string; line?: number; statement: string } | null = null;
    const fkColumns: Array<{ file: string; table: string; column: string }> = [];

    for (const file of sqlFiles) {
      const sql = file.content;
      const tableMatches = [...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([A-Za-z_][\w.]*)/gi)];
      tables += tableMatches.length;
      for (const match of tableMatches) {
        const table = match[1];
        const after = sql.slice(match.index ?? 0);
        const enable = new RegExp(`alter\\s+table\\s+${table.replace(/[.]/g, '\\.')}\\s+enable\\s+row\\s+level\\s+security`, 'i');
        if (enable.test(after) || enable.test(sql)) tablesWithRls += 1;
      }

      if (!destructive) {
        const drop = /(drop\s+table|truncate\s+table|drop\s+column|alter\s+column[^;]*type)/i.exec(sql);
        if (drop) {
          destructive = { file: file.path, line: firstMatchLine(sql, /(drop\s+table|truncate\s+table|drop\s+column|alter\s+column[^;]*type)/i), statement: drop[0] };
        }
      }

      for (const match of sql.matchAll(/([A-Za-z_]\w*)_id\s+(?:uuid|bigint|int|integer|text|serial)/gi)) {
        fkColumns.push({ file: file.path, table: 'unknown', column: match[0] });
      }
    }

    if (tables > 0 && tablesWithRls < tables) {
      findings.push(finding('DB_RLS_MISSING', 'blocker', `${tables - tablesWithRls} of ${tables} table(s) have no row-level security policy.`, {
        file: sqlFiles[0].path,
        suggestion: 'Enable RLS on every table and write per-tenant/per-user policies; deny by default.',
      }));
    }

    if (destructive) {
      findings.push(finding('DB_DESTRUCTIVE_MIGRATION', 'major', 'A migration contains a destructive statement.', {
        file: destructive.file,
        line: destructive.line,
        evidence: destructive.statement,
        suggestion: 'Split into expand → backfill → contract, and gate the contract step behind approval.',
      }));
    }

    if (fkColumns.length > 0) {
      findings.push(finding('DB_UNCHECKED_FOREIGN_KEY', 'minor', `${fkColumns.length} *_id column(s) declare no foreign key reference.`, {
        file: fkColumns[0].file,
        suggestion: 'Add `references <table>(id) on delete …` so orphan rows are impossible.',
      }));
    }

    const hasIndex = sqlFiles.some((file) => /create\s+(?:unique\s+)?index/i.test(file.content));
    if (fkColumns.length > 0 && !hasIndex) {
      findings.push(finding('DB_NO_FK_INDEX', 'info', 'Foreign-key columns have no supporting index.', {
        suggestion: 'Index every FK column — policy checks and joins scan on them.',
      }));
    }

    return capFindings(findings);
  },
};

export const stateManagementAgent: AgentDefinition = {
  id: 'state-management',
  name: 'Jonas',
  title: 'State Management Engineer',
  department: 'engineering',
  description: 'Looks for setState-after-await, missing mounted guards, leaked listeners and notifiers rebuilt inside build().',
  capabilities: ['async-lifecycle', 'listener-leaks', 'notifier-hygiene'],
  mode: 'deterministic',
  run(context) {
    const findings: AgentFinding[] = [];
    const files = libFiles(context);
    if (files.length === 0) return findings;

    for (const file of files) {
      const code = stripDart(file.content);

      const afterAwait = /await[^;]*;[\s\S]{0,400}?\bsetState\s*\(/.test(code);
      if (afterAwait) {
        findings.push(finding('STATE_SETSTATE_AFTER_AWAIT', 'blocker', 'setState() runs after an await without a mounted check.', {
          file: file.path,
          line: firstMatchLine(code, /\bsetState\s*\(/),
          suggestion: 'Guard with `if (!mounted) return;` immediately after every await.',
        }));
      }

      const hasAddListener = /\baddListener\s*\(/.test(code);
      const hasDispose = /\bvoid\s+dispose\s*\(\s*\)/.test(code);
      if (hasAddListener && !hasDispose) {
        findings.push(finding('STATE_LISTENER_LEAK', 'major', 'Listener registered but the State has no dispose() to remove it.', {
          file: file.path,
          line: firstMatchLine(code, /\.addListener\s*\(/),
          suggestion: 'Remove the listener in dispose() (and call super.dispose()).',
        }));
      }

      if (/\bValueNotifier\s*<[^>]*>\s*\(/.test(code) && hasAddListener) {
        const inBuild = /\bbuild\s*\([\s\S]*\bValueNotifier\s*</.test(code);
        if (inBuild) {
          findings.push(finding('STATE_NOTIFIER_IN_BUILD', 'major', 'A ValueNotifier is constructed inside build() and loses its state on every rebuild.', {
            file: file.path,
            suggestion: 'Create notifiers in State fields (or the controller) and dispose them.',
          }));
        }
      }

      if (/\baddListener\s*\(/.test(code) && !/removeListener\s*\(/.test(code) && hasDispose) {
        findings.push(finding('STATE_NO_REMOVE_LISTENER', 'minor', 'addListener() is called but removeListener() never is.', {
          file: file.path,
          suggestion: 'Pair every addListener with a removeListener in dispose().',
        }));
      }
    }

    const anyChangeNotifier = files.some((file) => /extends\s+ChangeNotifier/.test(stripDart(file.content)));
    if (!anyChangeNotifier && !files.some((file) => /extends\s+(?:ConsumerWidget|ConsumerStatefulWidget)/.test(stripDart(file.content)))) {
      findings.push(finding('STATE_NO_REACTIVE_LAYER', 'minor', 'No ChangeNotifier or Riverpod consumer was found — UI state ownership is unclear.', {
        suggestion: 'Pick one reactive primitive and use it consistently.',
      }));
    }

    return capFindings(findings);
  },
};

export const dependencyAuditorAgent: AgentDefinition = {
  id: 'dependency-auditor',
  name: 'Sana',
  title: 'Dependency & Supply Chain Auditor',
  department: 'engineering',
  description: 'Verifies pubspec hygiene: declared, resolvable, pinned, used dependencies and a test toolchain.',
  capabilities: ['pubspec-audit', 'unused-dependencies', 'version-pinning', 'supply-chain'],
  mode: 'deterministic',
  run(context) {
    const findings: AgentFinding[] = [];
    if (!context.pubspec) {
      return [finding('DEP_NO_PUBSPEC', 'blocker', 'pubspec.yaml is missing — the project cannot resolve dependencies.', { file: 'pubspec.yaml' })];
    }

    const pubspec = parsePubspec(context.pubspec);
    if (!pubspec.name) {
      findings.push(finding('DEP_NO_NAME', 'blocker', 'pubspec.yaml has no `name:` — package imports cannot resolve.', { file: 'pubspec.yaml' }));
    }

    for (const [name, version] of pubspec.dependencies) {
      if (!version.trim() || /^any$/i.test(version.trim())) {
        findings.push(finding('DEP_UNVERSIONED', 'blocker', `Dependency "${name}" has no version constraint.`, {
          file: 'pubspec.yaml',
          suggestion: 'Pin a concrete range so resolution is reproducible.',
        }));
      } else if (/^(git|path|hosted):/i.test(version)) {
        findings.push(finding('DEP_EXOTIC_SOURCE', 'major', `Dependency "${name}" comes from a non-pub source.`, {
          file: 'pubspec.yaml',
          suggestion: 'Vendor or publish it; git/path sources break reproducibility and audit.',
        }));
      } else if (/^>=/.test(version) || /\|\|/.test(version)) {
        findings.push(finding('DEP_OPEN_RANGE', 'minor', `Dependency "${name}" uses an open version range.`, {
          file: 'pubspec.yaml',
          evidence: `${name}: ${version}`,
        }));
      }
    }

    if (!pubspec.devDependencies.has('flutter_test') && !pubspec.dependencies.has('flutter_test')) {
      findings.push(finding('DEP_NO_FLUTTER_TEST', 'major', 'flutter_test is not declared — widget tests cannot run.', { file: 'pubspec.yaml' }));
    }

    const packages = importedPackages(libFiles(context));
    const unused = [...pubspec.dependencies.keys()].filter(
      (dep) => dep !== 'flutter' && dep !== 'cupertino_icons' && !packages.has(dep) && !pubspec.dependencies.get(dep)?.includes('sdk: flutter'),
    );
    for (const dep of unused.slice(0, 4)) {
      findings.push(finding('DEP_UNUSED', 'minor', `Dependency "${dep}" is declared but never imported.`, {
        file: 'pubspec.yaml',
        suggestion: 'Remove it to shrink the supply-chain surface.',
      }));
    }

    const total = pubspec.dependencies.size + pubspec.devDependencies.size;
    if (total > 25) {
      findings.push(finding('DEP_SURFACE_LARGE', 'minor', `${total} direct dependencies — every one is a supply-chain and upgrade liability.`, {
        file: 'pubspec.yaml',
        suggestion: 'Justify or remove dependencies that do not pay for themselves.',
      }));
    }

    if (!pubspec.sdkConstraint) {
      findings.push(finding('DEP_NO_SDK_CONSTRAINT', 'minor', 'No Dart SDK constraint was found in pubspec.yaml.', { file: 'pubspec.yaml' }));
    }

    return capFindings(findings);
  },
};
