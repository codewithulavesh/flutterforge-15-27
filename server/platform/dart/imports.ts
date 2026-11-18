/**
 * Project-wide import graph for a set of Dart files.
 *
 * Resolution rules (Dart semantics):
 * - `package:<self>/…` resolves into `lib/…` of the project.
 * - Relative URIs are always relative to the importing file (Dart relative
 *   imports are always relative; no leading `./` is required).
 * - `dart:…` URIs are external (Dart SDK core libraries).
 * - Other `package:…` URIs are external dependencies.
 * - `part` URIs are resolved relative to the declaring library file (Dart
 *   rule); the referenced part file is expected to carry `part of` back.
 *
 * All reported arrays are deterministically sorted. Paths in and out of this
 * module are POSIX-style, project-relative where possible (e.g.
 * `lib/main.dart`); backslashes are normalized on the way in.
 *
 * Path traversal (`..` escaping the project root) is rejected for both
 * relative and `package:self` URIs.
 */
import posix from 'node:path/posix';

export interface GraphFileInput {
  path: string;
  content: string;
}

export type GraphEdgeKind = 'import' | 'export' | 'part' | 'partOf';

export interface GraphEdge {
  from: string;
  to: string;
  uri: string;
  kind: GraphEdgeKind;
  line: number;
  column: number;
}

export interface ImportGraphNode {
  path: string;
  symbolCount: number;
  importCount: number;
  exportCount: number;
  /** Resolved project-library targets of import/export directives, sorted. */
  imports: string[];
  /** Resolved targets of `part` directives, sorted. */
  parts: string[];
}

export interface UnresolvedImport {
  /** File containing the directive. */
  path: string;
  /** Raw URI as written. */
  uri: string;
  /** Normalized would-be target, when it could be computed. */
  resolved: string | null;
  line: number;
  column: number;
  reason: string;
}

export interface ExternalPackage {
  /** Package name, or the `dart:` library name (e.g. `dart:io`). */
  name: string;
  kind: 'dart' | 'package';
  importCount: number;
  /** Project files importing/exporting this package, sorted. */
  importedBy: string[];
}

export interface SelfPackageMismatch {
  /** File containing the directive. */
  path: string;
  /** Raw URI as written. */
  uri: string;
  /** The (foreign) package namespace used in the URI. */
  packageName: string;
  line: number;
  column: number;
}

export interface PartOfIssue {
  /** The part file with the problem. */
  path: string;
  reason: 'missing' | 'mismatch';
  detail: string;
  /** URI as written in the part-of directive, if any. */
  uri: string | null;
  line: number;
  column: number;
}

export interface MissingPartTarget {
  /** File declaring the `part` directive. */
  path: string;
  uri: string;
  /** Normalized would-be location of the missing part file. */
  resolved: string;
  line: number;
  column: number;
}

export interface ImportGraph {
  nodes: ImportGraphNode[];
  edges: GraphEdge[];
  unresolved: UnresolvedImport[];
  externalPackages: ExternalPackage[];
  selfPackageMismatches: SelfPackageMismatch[];
  partFilesMissingOf: PartOfIssue[];
  missingPartTargets: MissingPartTarget[];
  /** Import/export cycles among project files; each cycle is sorted, cycles are sorted. */
  importCycles: string[][];
  stats: {
    files: number;
    projectEdges: number;
    unresolved: number;
    externalPackages: number;
    importCycles: number;
  };
}

import { analyzeDart } from './ast.js';

/** Normalize a project-relative path to POSIX form. Deterministic on all hosts. */
export function normalizeProjectPath(input: string): string {
  const withForwardSlashes = String(input ?? '').replace(/\\/g, '/');
  const withoutDrive = /^[A-Za-z]:/.test(withForwardSlashes) ? withForwardSlashes.slice(2) : withForwardSlashes;
  const normalized = posix.normalize(withoutDrive).replace(/\/{2,}/g, '/');
  return normalized.replace(/\/+$/, '') || '.';
}

interface ResolvedTarget {
  type: 'project' | 'external';
  /** Project file path (for project targets) or external package/library name. */
  target: string;
  kind: 'dart' | 'package' | 'project';
}

type ResolveResult =
  | { ok: true; resolved: ResolvedTarget }
  | { ok: false; reason: string; resolved: string | null };

function stripFragmentAndQuery(uri: string): string {
  const fragment = uri.indexOf('#');
  const query = uri.indexOf('?');
  const cut = fragment === -1 ? query : query === -1 ? fragment : Math.min(fragment, query);
  return cut === -1 ? uri : uri.slice(0, cut);
}

function resolveUri(uri: string, fromPath: string, packageName: string): ResolveResult {
  const clean = stripFragmentAndQuery(uri.trim());
  if (clean.length === 0) return { ok: false, reason: 'Empty URI', resolved: null };

  if (clean.startsWith('dart:')) {
    return { ok: true, resolved: { type: 'external', target: clean, kind: 'dart' } };
  }

  if (clean.startsWith('package:')) {
    const rest = clean.slice('package:'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) {
      return { ok: false, reason: 'Malformed package URI (missing package name or path)', resolved: null };
    }
    const pkg = rest.slice(0, slash);
    const sub = rest.slice(slash + 1);
    if (pkg === packageName) {
      if (sub.length === 0) {
        return { ok: false, reason: 'Malformed package URI (empty path)', resolved: null };
      }
      const candidate = normalizeProjectPath(posix.join('lib', sub));
      if (!candidate.startsWith('lib/') || candidate === 'lib') {
        return { ok: false, reason: 'Path traversal in package URI', resolved: candidate };
      }
      return { ok: true, resolved: { type: 'project', target: candidate, kind: 'project' } };
    }
    return { ok: true, resolved: { type: 'external', target: pkg, kind: 'package' } };
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(clean)) {
    return { ok: false, reason: `Unsupported URI scheme in ${JSON.stringify(clean)}`, resolved: null };
  }
  if (posix.isAbsolute(clean)) {
    return { ok: false, reason: 'Absolute URI is not resolvable', resolved: null };
  }
  const base = posix.dirname(fromPath);
  const candidate = normalizeProjectPath(posix.join(base, clean));
  if (candidate === '..' || candidate.startsWith('../') || posix.isAbsolute(candidate)) {
    return { ok: false, reason: 'Path escapes the project root', resolved: candidate };
  }
  return { ok: true, resolved: { type: 'project', target: candidate, kind: 'project' } };
}

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortEdge(a: GraphEdge, b: GraphEdge): number {
  return (
    byString(a.from, b.from) ||
    byString(a.to, b.to) ||
    byString(a.kind, b.kind) ||
    byString(a.uri, b.uri) ||
    a.line - b.line ||
    a.column - b.column
  );
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from} ${edge.kind} ${edge.to} ${edge.uri} ${edge.line}:${edge.column}`;
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const out: GraphEdge[] = [];
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

/** Tarjan's SCC, deterministic with sorted iteration everywhere. */
function findImportCycles(files: string[], adjacency: Map<string, string[]>): string[][] {
  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const components: string[][] = [];

  const connect = (node: string): void => {
    // Iterative Tarjan to stay safe on deep graphs.
    const work: Array<{ node: string; childIndex: number }> = [{ node, childIndex: 0 }];
    indexOf.set(node, counter);
    lowlink.set(node, counter);
    counter++;
    stack.push(node);
    onStack.add(node);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const successors = adjacency.get(frame.node) ?? [];
      if (frame.childIndex < successors.length) {
        const child = successors[frame.childIndex];
        frame.childIndex++;
        if (!indexOf.has(child)) {
          indexOf.set(child, counter);
          lowlink.set(child, counter);
          counter++;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, childIndex: 0 });
        } else if (onStack.has(child)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, indexOf.get(child)!));
        }
        continue;
      }
      // All successors processed: maybe close a component.
      work.pop();
      if (lowlink.get(frame.node) === indexOf.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        components.push(component.sort());
      }
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(frame.node)!));
      }
    }
  };

  for (const file of [...files].sort(byString)) {
    if (!indexOf.has(file)) connect(file);
  }

  const cycles: string[][] = [];
  for (const component of components) {
    if (component.length > 1) {
      cycles.push(component);
      continue;
    }
    const only = component[0];
    if (only && (adjacency.get(only) ?? []).includes(only)) {
      cycles.push([only]);
    }
  }
  cycles.sort((a, b) => byString(a.join('\u0000'), b.join('\u0000')));
  return cycles;
}

/**
 * Build the project import graph. `packageName` is the expected self-package
 * namespace (the `name:` from pubspec.yaml); files importing
 * `package:<other>/…` are reported as self-package mismatches in addition to
 * being tracked as external dependencies.
 */
export function buildImportGraph(files: GraphFileInput[], packageName: string): ImportGraph {
  const normalizedPackage = (packageName ?? '').trim();
  // Normalize + dedupe input paths (keep first occurrence, deterministic).
  const seenPaths = new Set<string>();
  const inputs: GraphFileInput[] = [];
  for (const file of files ?? []) {
    const norm = normalizeProjectPath(file?.path ?? '');
    if (!norm || norm === '.' || seenPaths.has(norm)) continue;
    seenPaths.add(norm);
    inputs.push({ path: norm, content: file?.content ?? '' });
  }
  inputs.sort((a, b) => byString(a.path, b.path));

  const fileSet = new Map(inputs.map((file) => [file.path, file.content]));
  const analyses = new Map(inputs.map((file) => [file.path, analyzeDart(file.content)]));

  const edges: GraphEdge[] = [];
  const unresolved: UnresolvedImport[] = [];
  const selfPackageMismatches: SelfPackageMismatch[] = [];
  const missingPartTargets: MissingPartTarget[] = [];
  const partFilesMissingOf: PartOfIssue[] = [];
  const externalCount = new Map<string, { kind: 'dart' | 'package'; importCount: number; importedBy: Set<string> }>();
  const nodes: ImportGraphNode[] = [];

  const addExternal = (kind: 'dart' | 'package', name: string, fromPath: string): void => {
    const entry = externalCount.get(name) ?? { kind, importCount: 0, importedBy: new Set<string>() };
    entry.importCount += 1;
    entry.importedBy.add(fromPath);
    externalCount.set(name, entry);
  };

  const resolveProjectTarget = (
    uri: string,
    fromPath: string,
    line: number,
    column: number,
  ): { ok: boolean; target: string | null } => {
    const result = resolveUri(uri, fromPath, normalizedPackage);
    if (result.ok === false) {
      unresolved.push({ path: fromPath, uri, resolved: result.resolved, line, column, reason: result.reason });
      return { ok: false, target: result.resolved };
    }
    if (result.resolved.type === 'external') {
      const pkgName = result.resolved.target;
      const extKind: 'dart' | 'package' = result.resolved.kind === 'dart' ? 'dart' : 'package';
      addExternal(extKind, pkgName, fromPath);
      if (extKind === 'package') {
        // Every non-self package: URI is reported as a potential mismatch;
        // callers with a declared-dependency list should filter this set.
        selfPackageMismatches.push({ path: fromPath, uri, packageName: pkgName, line, column });
      }
      return { ok: false, target: null };
    }
    const target = result.resolved.target;
    if (!fileSet.has(target)) {
      unresolved.push({
        path: fromPath,
        uri,
        resolved: target,
        line,
        column,
        reason: `File not found in project: ${target}`,
      });
      return { ok: false, target };
    }
    return { ok: true, target };
  };

  for (const file of inputs) {
    const analysis = analyses.get(file.path)!;
    const nodeImports = new Set<string>();
    const nodeParts = new Set<string>();

    for (const directive of analysis.imports) {
      const resolved = resolveProjectTarget(directive.uri, file.path, directive.line, directive.column);
      if (resolved.ok && resolved.target) {
        nodeImports.add(resolved.target);
        edges.push({ from: file.path, to: resolved.target, uri: directive.uri, kind: 'import', line: directive.line, column: directive.column });
      }
      // Conditional configurational branches resolve the same way; check them
      // for existence too, but don't create graph edges (platform-specific).
      for (const branch of directive.conditionals) {
        resolveProjectTarget(branch.uri, file.path, directive.line, directive.column);
      }
    }
    for (const directive of analysis.exports) {
      const resolved = resolveProjectTarget(directive.uri, file.path, directive.line, directive.column);
      if (resolved.ok && resolved.target) {
        nodeImports.add(resolved.target);
        edges.push({ from: file.path, to: resolved.target, uri: directive.uri, kind: 'export', line: directive.line, column: directive.column });
      }
      for (const branch of directive.conditionals) {
        resolveProjectTarget(branch.uri, file.path, directive.line, directive.column);
      }
    }

    // Conditional branches were recorded for completeness but should not be
    for (const directive of analysis.parts) {
      if (directive.kind === 'part' && directive.uri) {
        const result = resolveUri(directive.uri, file.path, normalizedPackage);
        if (result.ok === false) {
          unresolved.push({ path: file.path, uri: directive.uri, resolved: result.resolved, line: directive.line, column: directive.column, reason: result.reason });
          missingPartTargets.push({ path: file.path, uri: directive.uri, resolved: result.resolved ?? '<unresolvable>', line: directive.line, column: directive.column });
          continue;
        }
        if (result.resolved.type === 'external') {
          unresolved.push({ path: file.path, uri: directive.uri, resolved: null, line: directive.line, column: directive.column, reason: 'part directives must reference project files' });
          missingPartTargets.push({ path: file.path, uri: directive.uri, resolved: '<external>', line: directive.line, column: directive.column });
          continue;
        }
        const target = result.resolved.target;
        nodeParts.add(target);
        if (!fileSet.has(target)) {
          missingPartTargets.push({ path: file.path, uri: directive.uri, resolved: target, line: directive.line, column: directive.column });
          continue;
        }
        edges.push({ from: file.path, to: target, uri: directive.uri, kind: 'part', line: directive.line, column: directive.column });
      }
      if (directive.kind === 'partOf' && directive.uri) {
        const result = resolveUri(directive.uri, file.path, normalizedPackage);
        if (result.ok === false) {
          unresolved.push({ path: file.path, uri: directive.uri, resolved: result.resolved, line: directive.line, column: directive.column, reason: result.reason });
          continue;
        }
        if (result.resolved.type === 'project' && fileSet.has(result.resolved.target)) {
          edges.push({ from: file.path, to: result.resolved.target, uri: directive.uri, kind: 'partOf', line: directive.line, column: directive.column });
        }
      }
    }

    nodes.push({
      path: file.path,
      symbolCount: analysis.symbols.length,
      importCount: analysis.imports.length,
      exportCount: analysis.exports.length,
      imports: [...nodeImports].sort(byString),
      parts: [...nodeParts].sort(byString),
    });
  }

  // Linkage check: every resolved `part` target must itself declare `part of`.
  for (const file of inputs) {
    const analysis = analyses.get(file.path)!;
    const ownerRes = analysis.parts.filter((d) => d.kind === 'part');
    for (const partDir of ownerRes) {
      const result = resolveUri(partDir.uri ?? '', file.path, normalizedPackage);
      if (result.ok === false || result.resolved.type !== 'project') continue;
      const target = result.resolved.target;
      const partAnalysis = analyses.get(target);
      if (!partAnalysis) continue; // already reported as missingPartTargets
      const partOf = partAnalysis.parts.find((d) => d.kind === 'partOf');
      if (!partOf) {
        partFilesMissingOf.push({
          path: target,
          reason: 'missing',
          detail: `Part file does not declare \`part of\` (expected by ${file.path}).`,
          uri: null,
          line: 1,
          column: 1,
        });
        continue;
      }
      if (partOf.uri) {
        const resolved = resolveUri(partOf.uri, target, normalizedPackage);
        const resolvedPath = resolved.ok === true && resolved.resolved.type === 'project' ? resolved.resolved.target : null;
        if (resolvedPath !== file.path) {
          partFilesMissingOf.push({
            path: target,
            reason: 'mismatch',
            detail: `part of '${partOf.uri}' does not reference ${file.path}.`,
            uri: partOf.uri,
            line: partOf.line,
            column: partOf.column,
          });
        }
      }
      // `part of name;` (library-name form) cannot be verified without
      // requiring every library to carry a `library` directive; treated as ok.
    }
  }

  const dedupedEdges = dedupeEdges(edges).sort(sortEdge);

  // Cycle detection on import/export edges only (part linkage is not a dependency).
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.path, []);
  for (const edge of dedupedEdges) {
    if (edge.kind !== 'import' && edge.kind !== 'export') continue;
    adjacency.get(edge.from)!.push(edge.to);
  }
  for (const [key, value] of adjacency) adjacency.set(key, [...new Set(value)].sort(byString));
  const importCycles = findImportCycles(nodes.map((n) => n.path), adjacency);

  unresolved.sort((a, b) => byString(a.path, b.path) || a.line - b.line || a.column - b.column || byString(a.uri, b.uri));
  selfPackageMismatches.sort((a, b) => byString(a.path, b.path) || a.line - b.line || a.column - b.column || byString(a.uri, b.uri));
  missingPartTargets.sort((a, b) => byString(a.path, b.path) || a.line - b.line || a.column - b.column || byString(a.uri, b.uri));
  partFilesMissingOf.sort((a, b) => byString(a.path, b.path) || byString(a.reason, b.reason) || byString(a.detail, b.detail));

  const externalPackages: ExternalPackage[] = [...externalCount.entries()]
    .map(([name, entry]) => ({
      name,
      kind: entry.kind,
      importCount: entry.importCount,
      importedBy: [...entry.importedBy].sort(byString),
    }))
    .sort((a, b) => byString(a.name, b.name));

  const projectEdges = dedupedEdges.filter((edge) => edge.kind === 'import' || edge.kind === 'export').length;

  return {
    nodes,
    edges: dedupedEdges,
    unresolved,
    externalPackages,
    selfPackageMismatches,
    partFilesMissingOf,
    missingPartTargets,
    importCycles,
    stats: {
      files: inputs.length,
      projectEdges,
      unresolved: unresolved.length,
      externalPackages: externalPackages.length,
      importCycles: importCycles.length,
    },
  };
}
