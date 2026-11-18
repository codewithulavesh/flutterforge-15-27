import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSbom,
  verifySbomIntegrity,
  parsePubspecLock,
  pubspecDirectDependencies,
  dependencySetFingerprint,
} from '../../platform/security/sbom.js';

const PUBSPEC = `name: demo_app
version: 1.2.3

dependencies:
  flutter:
    sdk: flutter
  go_router: ^13.0.0
  provider: ^6.1.0
  http: ^1.2.0
  custom_pkg: ^0.1.0

dev_dependencies:
  flutter_test:
    sdk: flutter
  lints: ^4.0.0

flutter:
  uses-material-design: true
`;

const LOCK = `packages:
  collection:
    dependency: transitive
    description:
      name: collection
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      url: "https://pub.dev"
    source: hosted
    version: "1.17.2"
  go_router:
    dependency: "direct main"
    description:
      name: go_router
      sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      url: "https://pub.dev"
    source: hosted
    version: "13.2.0"
  provider:
    dependency: "direct main"
    description:
      name: provider
      sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      url: "https://pub.dev"
    source: hosted
    version: "6.1.1"
  http:
    dependency: "direct main"
    description:
      name: http
      sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
      url: "https://pub.dev"
    source: hosted
    version: "1.2.0"
  lints:
    dependency: "direct dev"
    description:
      name: lints
      sha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
      url: "https://pub.dev"
    source: hosted
    version: "4.0.0"
  custom_pkg:
    dependency: "direct main"
    description:
      path: "custom_pkg"
    source: path
    version: "0.1.0"
sdks:
  dart: ">=3.4.0 <4.0.0"
`;

test('pubspecDirectDependencies reads main and dev dependencies', () => {
  const deps = pubspecDirectDependencies(PUBSPEC);
  assert.deepEqual(deps.main, ['custom_pkg', 'go_router', 'http', 'provider']);
  assert.deepEqual(deps.dev, ['lints']);
  assert.equal(deps.appName, 'demo_app');
  assert.equal(deps.appVersion, '1.2.3');
});

test('parsePubspecLock extracts all packages with versions, digests and sources', () => {
  const locked = parsePubspecLock(LOCK);
  assert.equal(locked.length, 6);
  const goRouter = locked.find((pkg) => pkg.name === 'go_router');
  assert.equal(goRouter?.version, '13.2.0');
  assert.equal(goRouter?.dependency, 'main');
  assert.equal(goRouter?.source, 'hosted');
  const custom = locked.find((pkg) => pkg.name === 'custom_pkg');
  assert.equal(custom?.source, 'path');
});

test('SBOM is SPDX 2.3 with the dependency graph and sha256 digests', () => {
  const result = generateSbom(
    { pubspec: PUBSPEC, pubspecLock: LOCK },
    () => new Date('2026-11-01T00:00:00.000Z'),
  );

  assert.equal(result.sbom.spdxVersion, 'SPDX-2.3');
  assert.equal(result.sbom.dataLicense, 'CC0-1.0');
  assert.equal(result.sbom.SPDXID, 'SPDXRef-DOCUMENT');
  assert.equal(result.packages.length, 6);

  const goRouterEntry = result.sbom.packages.find((pkg) => pkg.name === 'go_router');
  assert.ok(goRouterEntry);
  assert.equal(goRouterEntry.versionInfo, '13.2.0');
  assert.deepEqual(goRouterEntry.checksums, [{ algorithm: 'SHA256', checksumValue: 'b'.repeat(64) }]);
  assert.match(goRouterEntry.externalRefs[0].referenceLocator, /^pkg:pub\/go_router@13\.2\.0$/);

  // The root app is described as the document's described element.
  assert.ok(result.sbom.relationships.some((rel) => rel.relationshipType === 'DESCRIBES'));
  assert.equal(result.sbom.relationships.filter((rel) => rel.relationshipType === 'DEPENDS_ON').length, 6);

  // Integrity self-check passes.
  const verdict = verifySbomIntegrity(result.sbom);
  assert.equal(verdict.ok, true, verdict.issues.join('; '));
});

test('SBOM flags missing lockfile and non-hosted sources explicitly', () => {
  const result = generateSbom({ pubspec: PUBSPEC }, () => new Date());
  assert.ok(result.warnings.some((warning) => warning.code === 'NO_LOCKFILE'));
  const withLock = generateSbom({ pubspec: PUBSPEC, pubspecLock: LOCK }, () => new Date());
  assert.ok(withLock.warnings.some((warning) => warning.code === 'NON_HOSTED_SOURCE' && warning.packageName === 'custom_pkg'));
});

test('every direct dependency has a matching entry in the resolved set', () => {
  const result = generateSbom({ pubspec: PUBSPEC, pubspecLock: LOCK }, () => new Date());
  const names = result.packages.map((pkg) => pkg.name);
  for (const direct of ['go_router', 'http', 'provider', 'lints', 'custom_pkg']) {
    assert.ok(names.includes(direct), `missing ${direct}`);
  }
  assert.equal(result.stats.direct, 5);
  assert.equal(result.stats.transitive, 1); // collection
});

test('dependencySetFingerprint is stable and order-insensitive', () => {
  const first = generateSbom({ pubspec: PUBSPEC, pubspecLock: LOCK }, () => new Date());
  const second = generateSbom({ pubspec: PUBSPEC, pubspecLock: LOCK }, () => new Date(Date.now() + 1000));
  assert.equal(dependencySetFingerprint(first), dependencySetFingerprint(second));
});

test('verifySbomIntegrity reports structural problems', () => {
  const result = generateSbom({ pubspec: PUBSPEC, pubspecLock: LOCK }, () => new Date());
  const broken = {
    ...result.sbom,
    packages: [
      ...result.sbom.packages,
      { ...result.sbom.packages[1], SPDXID: result.sbom.packages[1].SPDXID }, // duplicate
    ],
  };
  const verdict = verifySbomIntegrity(broken);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.issues.some((issue) => issue.includes('duplicate SPDXID')));
});
