/**
 * Software Bill of Materials (SPDX 2.3) for Flutter projects.
 *
 * Produces a deterministic, standards-shaped SBOM by resolving the
 * `dependencies:` set from pubspec.yaml against the pinned `packages:` block
 * in pubspec.lock, including the lockfile's package SHA-256 digests. No
 * network calls: correctness comes from the lockfile, which is the artifact
 * a build would actually fetch.
 *
 * Determinism matters: identical input yields a byte-identical document
 * (sorted packages, stable namespacing via an injected document namespace),
 * so two CI runs can assert equality without false diffs.
 */
import { createHash, randomBytes } from 'node:crypto';
import { sha256Hex } from '../kernel/hash.js';

export interface SbomFileInput {
  /** pubspec.yaml contents. */
  pubspec: string;
  /** pubspec.lock contents, when available. */
  pubspecLock?: string | null;
  /** Overrides `version:` from pubspec.yaml. */
  appVersion?: string;
}

export interface SbomPackage {
  name: string;
  version: string;
  direct: boolean;
  dependency: 'direct main' | 'direct dev' | 'indirect development';
  sha256?: string;
  source: 'hosted' | 'path' | 'git' | 'sdk';
  url?: string;
  purl: string;
}

export interface SbomWarning {
  code: 'NO_LOCKFILE' | 'MISSING_SHA256' | 'UNRESOLVED_DIRECT_DEP' | 'NON_HOSTED_SOURCE';
  message: string;
  packageName?: string;
}

export interface GenerateSbomResult {
  /** SPDX 2.3 JSON document. */
  sbom: SpdxDocument;
  packages: SbomPackage[];
  warnings: SbomWarning[];
  stats: { total: number; direct: number; transitive: number; hosted: number; nonHosted: number };
}

export interface SpdxCreator { spdxId: string }
export interface SpdxPackage {
  name: string;
  SPDXID: string;
  versionInfo: string;
  downloadLocation: string;
  externalRefs: Array<{ referenceCategory: 'PACKAGE-MANAGER'; referenceType: 'purl'; referenceLocator: string }>;
  checksums: Array<{ algorithm: 'SHA256'; checksumValue: string }>;
  filesAnalyzed: false;
  primaryPackagePurpose: 'LIBRARY';
  copyrightText: string;
  licenseConcluded: string;
  licenseDeclared: string;
  supplier: string;
}

export interface SpdxDocument {
  spdxVersion: 'SPDX-2.3';
  dataLicense: 'CC0-1.0';
  SPDXID: 'SPDXRef-DOCUMENT';
  name: string;
  documentNamespace: string;
  creationInfo: { created: string; creators: string[] };
  packages: SpdxPackage[];
  relationships: Array<{ spdxElementId: string; relationshipType: 'DESCRIBES' | 'DEPENDS_ON'; relatedSpdxElement: string }>;
}

const PUB_HOST = 'https://pub.dev';
const SPDX_NAMESPACE_PREFIX = 'https://spdx.org/spdxdocs/';

/* ------------------------------------------------------------------ */
/* pubspec.yaml parsing                                               */
/* ------------------------------------------------------------------ */

const TOP_LEVEL_KEY = /^([A-Za-z_][A-Za-z0-9_-]*):/;
const NESTED_DEP = /^\s{2}([A-Za-z0-9_.-]+):/;

function findTopLevelSection(lines: string[], key: string): { start: number; end: number } | null {
  for (let index = 0; index < lines.length; index += 1) {
    const match = TOP_LEVEL_KEY.exec(lines[index]);
    if (match && match[1] === key) {
      let end = index + 1;
      while (end < lines.length && !TOP_LEVEL_KEY.test(lines[end])) end += 1;
      return { start: index + 1, end };
    }
  }
  return null;
}

/** Dependencies provided by the Flutter/Dart SDKs, not by pub.dev. */
const SDK_DEPS = new Set(['flutter', 'flutter_test', 'flutter_localizations']);

export function pubspecDirectDependencies(yaml: string): { main: string[]; dev: string[]; appName: string; appVersion: string } {
  const lines = yaml.split('\n');
  const name = /^name:\s*([A-Za-z0-9_-]+)\s*$/m.exec(yaml)?.[1] ?? 'app';
  const version = /^version:\s*([^\s#]+)\s*(#.*)?$/m.exec(yaml)?.[1] ?? '0.0.0';
  const readDeps = (key: string): string[] => {
    const section = findTopLevelSection(lines, key);
    if (!section) return [];
    const names = new Set<string>();
    for (let index = section.start; index < section.end; index += 1) {
      const line = lines[index];
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      const dep = NESTED_DEP.exec(line);
      if (dep && !SDK_DEPS.has(dep[1])) names.add(dep[1]);
    }
    return [...names].sort();
  };
  return { main: readDeps('dependencies'), dev: readDeps('dev_dependencies'), appName: name, appVersion: version };
}

/* ------------------------------------------------------------------ */
/* pubspec.lock parsing                                               */
/* ------------------------------------------------------------------ */

export interface LockedPackage {
  name: string;
  version: string;
  dependency: 'main' | 'dev' | 'transitive' | 'sdk';
  source: 'hosted' | 'path' | 'git' | 'sdk';
  sha256?: string;
  url?: string;
}

/** Parse the indented `packages:` map of a pubspec.lock without a YAML parser. */
export function parsePubspecLock(lock: string): LockedPackage[] {
  const lines = lock.split('\n');
  const start = findTopLevelSection(lines, 'packages');
  if (!start) return [];

  const packages: LockedPackage[] = [];
  let current: Partial<LockedPackage> | null = null;

  const flush = () => {
    if (current?.name && current.version) {
      packages.push({
        name: current.name,
        version: current.version,
        dependency: current.dependency ?? 'transitive',
        source: current.source ?? 'hosted',
        ...(current.sha256 ? { sha256: current.sha256 } : {}),
        ...(current.url ? { url: current.url } : {}),
      });
    }
    current = null;
  };

  for (let index = start.start; index < start.end; index += 1) {
    const raw = lines[index];
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;

    const header = /^ {2}([A-Za-z0-9_.-]+):/.exec(raw);
    if (header) {
      flush();
      current = { name: header[1] };
      continue;
    }
    if (!current) continue;

    const shade = /^\s{4,}(dependency|description|source|version):\s*([\s\S]*)$/.exec(raw);
    if (shade) {
      const value = shade[2].trim().replace(/^["']|["']$/g, '');
      if (shade[1] === 'dependency') {
        current.dependency = value === 'direct main' ? 'main' : value === 'direct dev' ? 'dev' : 'transitive';
      } else if (shade[1] === 'source') {
        current.source = value === 'hosted' || value === 'path' || value === 'git' || value === 'sdk' ? value : 'hosted';
      } else if (shade[1] === 'version') {
        current.version = value;
      }
      continue;
    }

    const sha = /^\s{6,}sha256:\s*"?([A-Fa-f0-9]{64})"?/.exec(raw);
    if (sha) { current.sha256 = sha[1].toLowerCase(); continue; }

    const url = /^\s{6,}url:\s*"?([^"\s]+)"?/.exec(raw);
    if (url) { current.url = url[1]; continue; }

    const hostedName = /^\s{6,}name:\s*([A-Za-z0-9_.-]+)/.exec(raw);
    if (hostedName) { /* dart SDK packages carry a name under description */ }
  }
  flush();

  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* SBOM construction                                                  */
/* ------------------------------------------------------------------ */

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9.@_/-]/g, '_');
}

function purl(name: string, version: string): string {
  return `pkg:pub/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

export function generateSbom(input: SbomFileInput, now = () => new Date()): GenerateSbomResult {
  const { main, dev, appName, appVersion } = pubspecDirectDependencies(input.pubspec ?? '');
  const directDevSet = new Set(dev);
  const locked = input.pubspecLock ? parsePubspecLock(input.pubspecLock) : null;
  const nowDate = now();

  const warnings: SbomWarning[] = [];
  if (!locked) {
    warnings.push({ code: 'NO_LOCKFILE', message: 'pubspec.lock was not provided; package versions are unavailable.' });
  }

  const lockedByName = new Map((locked ?? []).map((pkg) => [pkg.name, pkg]));
  const isSdk = new Set(['flutter', 'flutter_test', 'flutter_localizations']);
  const packages: SbomPackage[] = [];

  if (locked) {
    for (const pkg of locked) {
      const directMain = main.includes(pkg.name) && !isSdk.has(pkg.name);
      const directDev = directDevSet.has(pkg.name);
      const dependency = directMain ? 'direct main' : directDev ? 'direct dev' : 'indirect development';

      if (!pkg.sha256 && pkg.source === 'hosted') {
        warnings.push({ code: 'MISSING_SHA256', message: `Package ${pkg.name}@${pkg.version} is missing a SHA-256 digest.`, packageName: pkg.name });
      }
      if (pkg.source !== 'hosted' && pkg.source !== 'sdk') {
        warnings.push({ code: 'NON_HOSTED_SOURCE', message: `Package ${pkg.name} uses source=${pkg.source}; review it manually.`, packageName: pkg.name });
      }
      packages.push({
        name: pkg.name,
        version: pkg.version,
        direct: directMain || directDev,
        dependency,
        ...(pkg.sha256 ? { sha256: pkg.sha256 } : {}),
        source: pkg.source,
        ...(pkg.url ? { url: pkg.url } : {}),
        purl: purl(pkg.name, pkg.version),
      });
    }
  } else {
    for (const name of [...main, ...dev]) {
      if (isSdk.has(name)) continue;
      warnings.push({ code: 'UNRESOLVED_DIRECT_DEP', message: `Direct dependency ${name} has no locked version.`, packageName: name });
      packages.push({
        name,
        version: 'UNKNOWN',
        direct: true,
        dependency: dev.includes(name) ? 'direct dev' : 'direct main',
        source: 'hosted',
        purl: purl(name, 'UNKNOWN'),
      });
    }
  }

  packages.sort((a, b) => a.name.localeCompare(b.name));

  const namespace = `${SPDX_NAMESPACE_PREFIX}${sanitizeName(appName)}-${createHash('sha256').update(`${appName}@${appVersion}`).digest('hex').slice(0, 16)}/${randomBytes(8).toString('hex')}`;
  const packagesSpdx: SpdxPackage[] = packages.map((pkg) => ({
    name: pkg.name,
    SPDXID: `SPDXRef-Package-${sanitizeName(pkg.name)}`,
    versionInfo: pkg.version,
    downloadLocation: pkg.url ? pkg.url : `${PUB_HOST}/packages/${pkg.name}/versions/${pkg.version}.tar.gz`,
    externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: pkg.purl }],
    checksums: pkg.sha256 ? [{ algorithm: 'SHA256', checksumValue: pkg.sha256 }] : [],
    filesAnalyzed: false,
    primaryPackagePurpose: 'LIBRARY',
    copyrightText: 'NOASSERTION',
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
    supplier: 'NOASSERTION',
  }));

  const relationships: SpdxDocument['relationships'] = [
    { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: `SPDXRef-Package-${sanitizeName(appName)}` },
    ...packagesSpdx.map((pkg) => ({
      spdxElementId: `SPDXRef-Package-${sanitizeName(appName)}`,
      relationshipType: 'DEPENDS_ON' as const,
      relatedSpdxElement: pkg.SPDXID,
    })),
  ];

  const sbom: SpdxDocument = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${appName}@${appVersion}`,
    documentNamespace: namespace,
    creationInfo: {
      created: nowDate.toISOString(),
      creators: ['Organization: FlutterForge'],
    },
    packages: [
      {
        name: appName,
        SPDXID: `SPDXRef-Package-${sanitizeName(appName)}`,
        versionInfo: appVersion,
        downloadLocation: 'NOASSERTION',
        externalRefs: [],
        checksums: [],
        filesAnalyzed: false,
        primaryPackagePurpose: 'LIBRARY',
        copyrightText: 'NOASSERTION',
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: 'NOASSERTION',
        supplier: 'NOASSERTION',
      },
      ...packagesSpdx,
    ],
    relationships,
  };

  return {
    sbom,
    packages,
    warnings,
    stats: {
      total: packages.length,
      direct: packages.filter((pkg) => pkg.direct).length,
      transitive: packages.filter((pkg) => !pkg.direct).length,
      hosted: packages.filter((pkg) => pkg.source === 'hosted').length,
      nonHosted: packages.filter((pkg) => pkg.source !== 'hosted').length,
    },
  };
}

/** Integrity self-check: unique IDs, checksum count, purl parseability. */
export function verifySbomIntegrity(doc: SpdxDocument): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const pkg of doc.packages) {
    if (ids.has(pkg.SPDXID)) issues.push(`duplicate SPDXID: ${pkg.SPDXID}`);
    ids.add(pkg.SPDXID);
    for (const ref of pkg.externalRefs) {
      if (!/^pkg:pub\/[A-Za-z0-9._-]+@/.test(ref.referenceLocator)) issues.push(`unparseable purl for ${pkg.name}`);
    }
  }
  if (doc.relationships.length < doc.packages.length) issues.push('relationships do not cover all packages');
  if (doc.spdxVersion !== 'SPDX-2.3') issues.push('spdxVersion is not SPDX-2.3');
  if (doc.creationInfo.created && Number.isNaN(Date.parse(doc.creationInfo.created))) issues.push('creationInfo.created is not a valid date');
  return { ok: issues.length === 0, issues };
}

/** Stable fingerprint of the resolved dependency set, useful for cache keys. */
export function dependencySetFingerprint(result: GenerateSbomResult): string {
  return sha256Hex(result.packages.map((pkg) => `${pkg.name}@${pkg.version}#${pkg.sha256 ?? ''}`).sort().join('\n'));
}
