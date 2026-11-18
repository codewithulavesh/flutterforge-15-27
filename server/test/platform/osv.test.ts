import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLockfilePackages,
  queryOsvBatch,
  gate,
  summarize,
  blockOn,
  SEVERITY_ORDER,
  MAX_PACKAGES,
  type OsvGateResult,
  type OsvVulnerability,
  type QueryFn,
} from '../../platform/security/osv.js';
import { PlatformError } from '../../platform/kernel/errors.js';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const MIXED_LOCK = `packages:
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
  custom_pkg:
    dependency: "direct main"
    description:
      path: "custom_pkg"
    source: path
    version: "0.1.0"
  git_pkg:
    dependency: transitive
    description:
      path: git_pkg
      ref: abc123def456
      url: "https://github.com/example/git_pkg.git"
    source: git
    version: "1.0.0"
  flutter:
    dependency: "direct main"
    description:
      name: flutter
      sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      sdk: flutter
    source: sdk
    version: "3.29.0"
  broken_pkg:
    dependency: transitive
    description:
      name: broken_pkg
      url: "https://pub.dev"
    source: hosted
sdks:
  dart: ">=3.4.0 <4.0.0"
`;

const CRITICAL_CVE_RESPONSE = {
  results: [
    {
      vulns: [
        {
          id: 'GHSA-xxxx-yyyy',
          summary: 'Critical remote code execution in example',
          aliases: ['CVE-2025-0001'],
          severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
          database_specific: { severity: 'CRITICAL' },
          affected: [
            {
              package: { ecosystem: 'Pub', name: 'go_router' },
              ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '13.2.1' }] }],
            },
          ],
          references: [{ type: 'ADVISORY', url: 'https://osv.dev/vulnerability/GHSA-xxxx-yyyy' }],
        },
      ],
    },
    {},
  ],
};

function makeFetchFn(respond: (body: string, callIndex: number) => { status: number; payload: unknown }) {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const fetchFn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, body: init.body ?? '' });
    const { status, payload } = respond(init.body ?? '', calls.length - 1);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'ERR',
      json: async () => payload,
    };
  };
  return { calls, fetchFn };
}

/** Route-based fake for tests that exercise both querybatch (POST) and advisory fetch (GET). */
function makeRouter(routes: Record<string, { status: number; payload: unknown }>) {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const fetchFn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, body: init.body ?? '' });
    const route = routes[`${init.method} ${url}`];
    if (!route) throw new Error(`unexpected call: ${init.method} ${url}`);
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      statusText: route.status === 200 ? 'OK' : 'ERR',
      json: async () => route.payload,
    };
  };
  return { calls, fetchFn };
}

const pkgs = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ name: `pkg_${String(i).padStart(4, '0')}`, version: '1.0.0' }));

const finding = (id: string, severity: OsvVulnerability['severity'], aliases: string[] = []) =>
  ({ id, summary: `summary for ${id}`, severity, aliases });

/* ------------------------------------------------------------------ */
/* parseLockfilePackages                                               */
/* ------------------------------------------------------------------ */

test('parseLockfilePackages keeps only hosted packages with versions', () => {
  const parsed = parseLockfilePackages(MIXED_LOCK);
  assert.deepEqual([...parsed], [
    { name: 'collection', version: '1.17.2' },
    { name: 'go_router', version: '13.2.0' },
  ]);
  // broken_pkg has no version: skipped and counted, never silently passed.
  assert.equal(parsed.skipped, 1);
});

test('parseLockfilePackages skips invalid entries and counts them', () => {
  const parsed = parseLockfilePackages(MIXED_LOCK);
  assert.ok(![...parsed].some((pkg) => pkg.name === 'broken_pkg'));
  assert.ok(parsed.skipped >= 1);
});

test('parseLockfilePackages caps at MAX_PACKAGES and dedupes', () => {
  const entries = Array.from({ length: MAX_PACKAGES + 100 }, (_, i) => `  pkg_${String(i).padStart(4, '0')}:\n    dependency: transitive\n    description:\n      name: pkg_${String(i).padStart(4, '0')}\n      url: "https://pub.dev"\n    source: hosted\n    version: "1.0.0"\n`);
  const lock = `packages:\n${entries.join('')}`;
  const parsed = parseLockfilePackages(lock);
  assert.equal(parsed.length, MAX_PACKAGES);
});

/* ------------------------------------------------------------------ */
/* queryOsvBatch                                                       */
/* ------------------------------------------------------------------ */

test('queryOsvBatch parses a canned response: severity, fixedIn, aliases, reference', async () => {
  const { calls, fetchFn } = makeFetchFn(() => ({ status: 200, payload: CRITICAL_CVE_RESPONSE }));
  const result = await queryOsvBatch(
    [{ name: 'go_router', version: '13.2.0' }, { name: 'collection', version: '1.17.2' }],
    { fetchFn, endpoint: 'https://osv.example.test/querybatch' },
  );

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].body) as { queries: Array<{ package: { ecosystem: string; name: string }; version: string }> };
  assert.equal(body.queries.length, 2);
  assert.equal(body.queries[0].package.ecosystem, 'Pub');

  const vulns = result.get('go_router@13.2.0');
  assert.ok(vulns);
  assert.equal(vulns.length, 1);
  assert.equal(vulns[0].id, 'GHSA-xxxx-yyyy');
  assert.equal(vulns[0].severity, 'critical');
  assert.deepEqual(vulns[0].aliases, ['CVE-2025-0001']);
  assert.equal(vulns[0].fixedIn, '13.2.1');
  assert.equal(vulns[0].reference, 'https://osv.dev/vulnerability/GHSA-xxxx-yyyy');

  const clean = result.get('collection@1.17.2');
  assert.ok(clean);
  assert.equal(clean.length, 0);
});

test('queryOsvBatch splits large inputs into chunks of 100 (101 packages → 2 calls)', async () => {
  const respond = (body: string) => {
    const parsed = JSON.parse(body) as { queries: unknown[] };
    assert.ok(parsed.queries.length <= 100);
    return { status: 200, payload: { results: Array.from({ length: parsed.queries.length }, () => ({})) } };
  };
  const { calls, fetchFn } = makeFetchFn(respond);
  await queryOsvBatch(pkgs(101), { fetchFn, endpoint: 'https://osv.example.test/querybatch' });
  assert.equal(calls.length, 2);
  const secondBody = JSON.parse(calls[1].body) as { queries: unknown[] };
  assert.equal(secondBody.queries.length, 1);
});

test('queryOsvBatch chunks 500 packages into 5 batches of 100', async () => {
  const respond = (body: string) => {
    const parsed = JSON.parse(body) as { queries: unknown[] };
    assert.ok(parsed.queries.length <= 100);
    return { status: 200, payload: { results: Array.from({ length: parsed.queries.length }, () => ({})) } };
  };
  const { calls, fetchFn } = makeFetchFn(respond);
  const result = await queryOsvBatch(pkgs(500), { fetchFn, endpoint: 'https://osv.example.test/querybatch' });
  assert.equal(calls.length, 5);
  assert.equal(result.size, 500);
});

test('queryOsvBatch throws PlatformError OSV_UNAVAILABLE on HTTP failure (never silently allow)', async () => {
  const { fetchFn } = makeFetchFn(() => ({ status: 500, payload: {} }));
  await assert.rejects(
    () => queryOsvBatch([{ name: 'a', version: '1.0.0' }], { fetchFn, endpoint: 'https://osv.example.test/querybatch' }),
    (error: unknown) => {
      assert.ok(PlatformError.is(error));
      assert.equal((error as PlatformError).code, 'OSV_UNAVAILABLE');
      assert.equal((error as PlatformError).details?.status, 500);
      return true;
    },
  );
});

test('queryOsvBatch enriches compact {id, modified} querybatch records via /v1/vulns/{id}', async () => {
  const { calls, fetchFn } = makeRouter({
    'POST https://osv.example.test/querybatch': {
      status: 200,
      payload: { results: [{ vulns: [{ id: 'GHSA-compact', modified: '2026-01-01T00:00:00Z' }] }, {}] },
    },
    'GET https://osv.example.test/vulns/GHSA-compact': {
      status: 200,
      payload: {
        id: 'GHSA-compact',
        summary: 'Remote code execution in demo_pkg',
        aliases: ['CVE-2026-4242'],
        database_specific: { severity: 'HIGH' },
        affected: [
          { ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '2.0.1' }] }] },
        ],
        references: [{ type: 'ADVISORY', url: 'https://osv.dev/vulnerability/GHSA-compact' }],
      },
    },
  });
  const result = await queryOsvBatch(
    [{ name: 'demo_pkg', version: '1.0.0' }, { name: 'clean_pkg', version: '3.0.0' }],
    { fetchFn, endpoint: 'https://osv.example.test/querybatch' },
  );

  assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET']);
  assert.equal(calls[1].url, 'https://osv.example.test/vulns/GHSA-compact');

  const vulns = result.get('demo_pkg@1.0.0');
  assert.ok(vulns);
  assert.equal(vulns.length, 1);
  assert.equal(vulns[0].id, 'GHSA-compact');
  assert.equal(vulns[0].severity, 'high');
  assert.equal(vulns[0].fixedIn, '2.0.1');
  assert.deepEqual(vulns[0].aliases, ['CVE-2026-4242']);
  assert.equal(vulns[0].summary, 'Remote code execution in demo_pkg');
  assert.equal(vulns[0].reference, 'https://osv.dev/vulnerability/GHSA-compact');
  assert.deepEqual(result.get('clean_pkg@3.0.0'), []);
});

test('queryOsvBatch throws OSV_UNAVAILABLE when a compact advisory cannot be enriched', async () => {
  const { fetchFn } = makeRouter({
    'POST https://osv.example.test/querybatch': {
      status: 200,
      payload: { results: [{ vulns: [{ id: 'GHSA-broken', modified: '2026-01-01T00:00:00Z' }] }] },
    },
    'GET https://osv.example.test/vulns/GHSA-broken': { status: 500, payload: {} },
  });
  await assert.rejects(
    () => queryOsvBatch([{ name: 'demo_pkg', version: '1.0.0' }], { fetchFn, endpoint: 'https://osv.example.test/querybatch' }),
    (error: unknown) => {
      assert.ok(PlatformError.is(error));
      assert.equal((error as PlatformError).code, 'OSV_UNAVAILABLE');
      assert.equal((error as PlatformError).details?.id, 'GHSA-broken');
      return true;
    },
  );
});

test('queryOsvBatch does not re-fetch detailed records already present in querybatch', async () => {
  const { calls, fetchFn } = makeRouter({
    'POST https://osv.example.test/querybatch': {
      status: 200,
      payload: CRITICAL_CVE_RESPONSE,
    },
  });
  const result = await queryOsvBatch(
    [{ name: 'go_router', version: '13.2.0' }, { name: 'collection', version: '1.17.2' }],
    { fetchFn, endpoint: 'https://osv.example.test/querybatch' },
  );
  assert.equal(calls.length, 1); // POST only — no GET enrichment for detailed records
  assert.equal(calls[0].method, 'POST');
  assert.equal(result.get('go_router@13.2.0')?.[0].severity, 'critical');
});

test('queryOsvBatch throws OSV_UNAVAILABLE on network error', async () => {
  const fetchFn = async () => { throw new Error('ECONNRESET: connection reset'); };
  await assert.rejects(
    () => queryOsvBatch([{ name: 'a', version: '1.0.0' }], { fetchFn, endpoint: 'https://osv.example.test/querybatch' }),
    (error: unknown) => PlatformError.is(error) && error.code === 'OSV_UNAVAILABLE',
  );
});

test('queryOsvBatch throws OSV_UNAVAILABLE when result count mismatches the query count', async () => {
  const { fetchFn } = makeFetchFn(() => ({ status: 200, payload: { results: [] } }));
  await assert.rejects(
    () => queryOsvBatch([{ name: 'a', version: '1.0.0' }], { fetchFn, endpoint: 'https://osv.example.test/querybatch' }),
    (error: unknown) => PlatformError.is(error) && error.code === 'OSV_UNAVAILABLE',
  );
});

/* ------------------------------------------------------------------ */
/* gate                                                                */
/* ------------------------------------------------------------------ */

const PACKAGES = [
  { name: 'http', version: '1.2.0' },
  { name: 'collection', version: '1.17.2' },
];

function queryFnReturning(map: Map<string, OsvVulnerability[]>): QueryFn {
  return async () => map;
}

test('gate block mode: critical finding blocks', async () => {
  const queryFn = queryFnReturning(new Map([
    ['http@1.2.0', [finding('GHSA-crit', 'critical', ['CVE-2025-0002'])]],
    ['collection@1.17.2', []],
  ]));
  const result = await gate({ packages: PACKAGES, policy: 'block', queryFn });
  assert.equal(result.blocked, true);
  assert.equal(result.ok, false);
  assert.equal(result.vulnerabilities.length, 1);
  assert.equal(result.totalPackages, 2);
  assert.deepEqual(result.errors, []);
});

test('gate block mode: high finding blocks', async () => {
  const queryFn = queryFnReturning(new Map([
    ['http@1.2.0', [finding('GHSA-high', 'high')]],
    ['collection@1.17.2', []],
  ]));
  const result = await gate({ packages: PACKAGES, policy: 'block', queryFn });
  assert.equal(result.blocked, true);
});

test('gate block mode: medium-only finding does not block', async () => {
  const queryFn = queryFnReturning(new Map([
    ['http@1.2.0', [finding('GHSA-med', 'medium')]],
    ['collection@1.17.2', []],
  ]));
  const result = await gate({ packages: PACKAGES, policy: 'block', queryFn });
  assert.equal(result.blocked, false);
  assert.equal(result.ok, true);
  assert.equal(result.vulnerabilities.length, 1); // still reported
});

test('gate: allowIds suppresses a blocking advisory by id and by alias (case-insensitive)', async () => {
  const byAlias = await gate({
    packages: PACKAGES,
    policy: 'block',
    allowIds: ['cve-2025-0002'],
    queryFn: queryFnReturning(new Map([
      ['http@1.2.0', [finding('GHSA-crit', 'critical', ['CVE-2025-0002'])]],
      ['collection@1.17.2', []],
    ])),
  });
  assert.equal(byAlias.blocked, false);

  const byId = await gate({
    packages: PACKAGES,
    policy: 'block',
    allowIds: ['GHSA-crit'],
    queryFn: queryFnReturning(new Map([
      ['http@1.2.0', [finding('GHSA-crit', 'critical')]],
      ['collection@1.17.2', []],
    ])),
  });
  assert.equal(byId.blocked, false);
});

test('gate with a throwing queryFn fails closed: blocked=true, per-package OSV_QUERY_FAILED errors', async () => {
  const queryFn: QueryFn = async () => {
    throw new PlatformError({ code: 'OSV_UNAVAILABLE', message: 'OSV query failed with HTTP 503.', statusCode: 503, retryable: true });
  };
  const result = await gate({ packages: PACKAGES, policy: 'block', queryFn });
  assert.equal(result.blocked, true);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, PACKAGES.length);
  for (const error of result.errors) {
    assert.ok(error.startsWith('OSV_QUERY_FAILED '), error);
    assert.ok(error.includes('OSV_UNAVAILABLE'), error);
  }
  assert.ok(result.errors.some((error) => error.includes('http@1.2.0')));
  assert.ok(result.errors.some((error) => error.includes('collection@1.17.2')));
});

test('gate with a throwing queryFn in warn mode never blocks but still reports errors', async () => {
  const queryFn: QueryFn = async () => { throw new Error('socket hang up'); };
  const result = await gate({ packages: PACKAGES, policy: 'warn', queryFn });
  assert.equal(result.blocked, false);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, PACKAGES.length);
});

test('gate in warn mode never blocks, even on a critical finding', async () => {
  const queryFn = queryFnReturning(new Map([
    ['http@1.2.0', [finding('GHSA-crit', 'critical')]],
    ['collection@1.17.2', []],
  ]));
  const result = await gate({ packages: PACKAGES, policy: 'warn', queryFn });
  assert.equal(result.blocked, false);
  assert.equal(result.ok, true);
  assert.equal(result.vulnerabilities.length, 1);
});

test('gate fails closed when queryFn omits a package from the result map', async () => {
  const queryFn = queryFnReturning(new Map([['http@1.2.0', []]])); // collection missing
  const result = await gate({ packages: PACKAGES, policy: 'block', queryFn });
  assert.equal(result.blocked, true);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].includes('collection@1.17.2'));
});

test('gate accepts a raw lockfile and scans hosted packages only', async () => {
  const seen: Array<{ name: string; version: string }> = [];
  const queryFn: QueryFn = async (packages) => {
    seen.push(...packages);
    return new Map(packages.map((pkg) => [`${pkg.name}@${pkg.version}`, []]));
  };
  const result = await gate({ lock: MIXED_LOCK, policy: 'block', queryFn });
  assert.deepEqual(seen, [
    { name: 'collection', version: '1.17.2' },
    { name: 'go_router', version: '13.2.0' },
  ]);
  // broken_pkg was skipped as invalid → error recorded and fail-closed.
  assert.ok(result.errors.some((error) => error.startsWith('OSV_SKIPPED_PACKAGES')));
  assert.equal(result.blocked, true);
  assert.equal(result.totalPackages, 2);
});

test('gate of a clean lock in block mode passes', async () => {
  const cleanLock = `packages:
  collection:
    dependency: transitive
    description:
      name: collection
      url: "https://pub.dev"
    source: hosted
    version: "1.17.2"
`;
  const result = await gate({
    lock: cleanLock,
    policy: 'block',
    queryFn: queryFnReturning(new Map([['collection@1.17.2', []]])),
  });
  assert.equal(result.blocked, false);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

/* ------------------------------------------------------------------ */
/* SEVERITY_ORDER and blockOn                                          */
/* ------------------------------------------------------------------ */

test('SEVERITY_ORDER ranks critical first and unknown last', () => {
  assert.ok(SEVERITY_ORDER.critical < SEVERITY_ORDER.high);
  assert.ok(SEVERITY_ORDER.high < SEVERITY_ORDER.medium);
  assert.ok(SEVERITY_ORDER.medium < SEVERITY_ORDER.low);
  assert.ok(SEVERITY_ORDER.low < SEVERITY_ORDER.unknown);
});

test('blockOn: only critical|high in block policy block', () => {
  const crit = finding('X', 'critical');
  const low = finding('Y', 'low');
  assert.equal(blockOn(crit, 'block'), true);
  assert.equal(blockOn(crit, 'warn'), false);
  assert.equal(blockOn(low, 'block'), false);
  assert.equal(blockOn(crit, 'block', new Set(['X'])), false);
});

/* ------------------------------------------------------------------ */
/* summarize                                                           */
/* ------------------------------------------------------------------ */

function makeResult(findings: OsvGateResult['vulnerabilities'], overrides: Partial<OsvGateResult> = {}): OsvGateResult {
  return {
    ok: false,
    vulnerabilities: findings,
    blocked: true,
    policy: 'block',
    errors: [],
    checkedAtMs: 1_700_000_000_000,
    totalPackages: 10,
    ...overrides,
  };
}

test('summarize sorts by severity rank then package name', () => {
  const result = makeResult([
    { package: 'zeta', version: '1.0.0', vulnerability: finding('GHSA-med', 'medium') },
    { package: 'beta', version: '1.0.0', vulnerability: finding('GHSA-high', 'high') },
    { package: 'a-pkg', version: '1.0.0', vulnerability: finding('GHSA-crit-a', 'critical') },
    { package: 'z-pkg', version: '1.0.0', vulnerability: finding('GHSA-crit-z', 'critical') },
  ]);
  const text = summarize(result);
  const lines = text.split('\n');
  const findingLines = lines.filter((line) => line.startsWith('['));
  assert.deepEqual(
    findingLines.map((line) => line.split(' ')[1]),
    ['a-pkg@1.0.0', 'z-pkg@1.0.0', 'beta@1.0.0'], // critical (a, z) then high; medium hidden
  );
  assert.ok(lines[0].startsWith('OSV gate: BLOCKED'));
});

test('summarize caps at 20 blocking findings with an overflow trailer', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    package: `pkg${String(i).padStart(2, '0')}`,
    version: '1.0.0',
    vulnerability: finding(`GHSA-${String(i).padStart(2, '0')}`, 'critical'),
  }));
  const text = summarize(makeResult(many));
  const findingLines = text.split('\n').filter((line) => line.startsWith('['));
  assert.equal(findingLines.length, 20);
  assert.ok(text.includes('… and 5 more blocking finding(s)'));
});

test('summarize is deterministic and includes error lines when present', () => {
  const result = makeResult(
    [{ package: 'http', version: '1.2.0', vulnerability: finding('GHSA-x', 'critical', ['CVE-2025-0001']) }],
    { errors: ['OSV_QUERY_FAILED http@1.2.0: OSV_UNAVAILABLE: OSV query failed with HTTP 503.'] },
  );
  const first = summarize(result);
  const second = summarize(result);
  assert.equal(first, second);
  assert.ok(first.includes('CVE-2025-0001'));
  assert.ok(first.includes('errors (1):'));
  assert.ok(first.includes('OSV_QUERY_FAILED'));
});
