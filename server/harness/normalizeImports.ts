import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * LLM-generated Dart files regularly hallucinate a package namespace
 * (e.g. `import 'package:production/app.dart';`) that does not match the
 * `name:` declared in pubspec.yaml. `flutter build web` then fails with
 * "Couldn't resolve the package 'production'". This pass rewrites any
 * `package:<unknown>/…` import to the pubspec package name. Imports of
 * declared dependencies (flutter, provider, …) and the app's own package
 * are left untouched.
 */

export interface DeclaredPackages {
  name: string | null;
  packages: Set<string>;
}

export function declaredPackages(yamlText: string): DeclaredPackages {
  const packages = new Set<string>(['flutter', 'dart', 'sky_engine', 'cupertino_icons']);
  const nameMatch = yamlText.match(/^name\s*:\s*([A-Za-z0-9_]+)/m);
  const name = nameMatch?.[1] ?? null;
  if (name) packages.add(name);

  let section: 'deps' | null = null;
  for (const raw of yamlText.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^(dependencies|dev_dependencies)\s*:/.test(trimmed)) {
      section = 'deps';
      continue;
    }
    if (/^[A-Za-z0-9_-]+\s*:/.test(raw)) {
      section = null; // any other top-level key
      continue;
    }
    if (section) {
      const indent = raw.match(/^\s*/)![0].length;
      if (indent >= 2 && indent < 4) {
        const m = trimmed.match(/^([A-Za-z0-9_]+)\s*:/);
        if (m && m[1] !== 'sdk') packages.add(m[1]);
      }
    }
  }

  return { name, packages };
}

export function normalizeImportsInSource(source: string, declared: DeclaredPackages): { content: string; rewritten: string[] } {
  if (!declared.name) return { content: source, rewritten: [] };
  const name = declared.name;
  const rewritten = new Set<string>();
  const content = source.replace(/(package:)([A-Za-z0-9_]+)(\/[^'"\s]*)/g, (whole, prefix, pkg, rest) => {
    if (declared.packages.has(pkg)) return whole;
    rewritten.add(pkg);
    return `${prefix}${name}${rest}`;
  });
  return { content, rewritten: [...rewritten] };
}

export async function normalizePackageImports(directory: string, pubspecContent: string, log: (line: string) => void) {
  const declared = declaredPackages(pubspecContent);
  if (!declared.name) return;

  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else if (entry.name.endsWith('.dart')) out.push(full);
    }
    return out;
  };

  for (const file of await walk(path.join(directory, 'lib'))) {
    const content = await fs.readFile(file, 'utf8').catch(() => '');
    if (!content) continue;
    const { content: next, rewritten } = normalizeImportsInSource(content, declared);
    if (next === content) continue;
    await fs.writeFile(file, next, 'utf8');
    log(
      `[preview] Rewrote hallucinated import(s) ${rewritten.map((bad) => `package:${bad}/* → package:${declared.name}/*`).join(', ')} in ${path.relative(directory, file)}`,
    );
  }
}
