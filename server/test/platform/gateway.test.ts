/**
 * Gateway auth primitives: JWS verification, hierarchical RBAC, distributed
 * token bucket and request-context plumbing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHmac,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';
import {
  createHs256Verifier,
  createJwtVerifier,
  JwtError,
  type JwtErrorCode,
} from '../../platform/gateway/jwt.js';
import {
  authorize,
  AuthzError,
  PERMISSION_RESOURCE_TYPES,
  PERMISSIONS,
  ROLE_HIERARCHY,
  ROLE_PERMISSIONS,
  ROLES,
  type Permission,
  type Principal,
  type ResourceType,
} from '../../platform/gateway/rbac.js';
import {
  MemoryTokenBucketStore,
  rateLimitHeaders,
  RATE_TIERS,
  TokenBucketLimiter,
} from '../../platform/gateway/rateLimit.js';
import {
  claimsToPrincipal,
  createRequestContext,
  extractBearerToken,
  mapClaimsToPrincipal,
} from '../../platform/gateway/context.js';
import { ManualClock } from '../../platform/kernel/clock.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const fixedNow = () => NOW_MS;

const b64url = (input: string | Buffer): string =>
  Buffer.from(input).toString('base64url');

function base64urlJson(value: unknown): string {
  return b64url(JSON.stringify(value));
}

function hs256Token(
  payload: Record<string, unknown>,
  secret: string | Buffer = 'unit-test-secret',
  header: Record<string, unknown> = {},
): string {
  const headerSegment = base64urlJson({ alg: 'HS256', typ: 'JWT', ...header });
  const payloadSegment = base64urlJson(payload);
  const input = `${headerSegment}.${payloadSegment}`;
  const signature = createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${signature}`;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'user-1',
    iss: 'flutterforge',
    aud: 'flutterforge-api',
    iat: NOW_S - 60,
    exp: NOW_S + 3600,
    ...overrides,
  };
}

async function assertJwtRejects(
  promise: Promise<unknown>,
  code: JwtErrorCode,
): Promise<JwtError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof JwtError, `expected JwtError, got: ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected JwtError with code ${code}, but verification succeeded`);
}

/** Pure assert.throws predicate: error is an AuthzError with the given code. */
function isAuthz(code: 'FORBIDDEN' | 'TENANT_MISMATCH'): (error: unknown) => boolean {
  return (error: unknown) => error instanceof AuthzError && error.code === code;
}

/* -------------------------------------------------------------------------- */
/* 1. HS256 roundtrip, signature failures, algorithm families, alg:none       */
/* -------------------------------------------------------------------------- */

test('HS256 token roundtrips through createHs256Verifier', async () => {
  const verifier = createHs256Verifier({
    secret: 'unit-test-secret',
    issuer: 'flutterforge',
    audience: 'flutterforge-api',
    now: fixedNow,
  });
  const token = hs256Token(validPayload({ scope: 'read' }), 'unit-test-secret');
  const verified = await verifier.verify(token);
  assert.equal(verified.header.alg, 'HS256');
  assert.equal(verified.payload.sub, 'user-1');
  assert.equal(verified.payload.scope, 'read');
});

test('HS256 token with a wrong signature is rejected as BAD_SIGNATURE', async () => {
  const verifier = createHs256Verifier({ secret: 'unit-test-secret', now: fixedNow });
  const token = hs256Token(validPayload(), 'a-different-secret');
  await assertJwtRejects(verifier.verify(token), 'BAD_SIGNATURE');
});

test('HS256 token tampered in the payload is rejected as BAD_SIGNATURE', async () => {
  const verifier = createHs256Verifier({ secret: 'unit-test-secret', now: fixedNow });
  const token = hs256Token(validPayload(), 'unit-test-secret');
  const [header, , signature] = token.split('.');
  const forgedPayload = base64urlJson(validPayload({ sub: 'attacker' }));
  await assertJwtRejects(verifier.verify(`${header}.${forgedPayload}.${signature}`), 'BAD_SIGNATURE');
});

test('RS256 token is rejected under an HS256 allowlist (no algorithm confusion)', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const headerSegment = base64urlJson({ alg: 'RS256', typ: 'JWT' });
  const payloadSegment = base64urlJson(validPayload());
  const input = `${headerSegment}.${payloadSegment}`;
  const signature = cryptoSign('sha256', Buffer.from(input, 'ascii'), privateKey);
  const token = `${input}.${signature.toString('base64url')}`;

  const hsVerifier = createJwtVerifier({ algorithms: ['HS256'], key: 'unit-test-secret', now: fixedNow });
  await assertJwtRejects(hsVerifier.verify(token), 'UNSUPPORTED_ALG');

  // And an HS256 token is rejected when only RS256 is allowed.
  const rsVerifier = createJwtVerifier({ algorithms: ['RS256'], key: 'irrelevant', now: fixedNow });
  await assertJwtRejects(rsVerifier.verify(hs256Token(validPayload())), 'UNSUPPORTED_ALG');
});

test('alg:none token is rejected as UNSUPPORTED_ALG', async () => {
  const verifier = createHs256Verifier({ secret: 'unit-test-secret', now: fixedNow });
  const headerSegment = base64urlJson({ alg: 'none', typ: 'JWT' });
  const payloadSegment = base64urlJson(validPayload());
  await assertJwtRejects(verifier.verify(`${headerSegment}.${payloadSegment}.`), 'UNSUPPORTED_ALG');
  // Even a non-empty signature blob must not change the verdict for alg:none.
  await assertJwtRejects(
    verifier.verify(`${headerSegment}.${payloadSegment}.${b64url('forged')}`),
    'UNSUPPORTED_ALG',
  );
});

test('oversized tokens and non-object headers are MALFORMED', async () => {
  const verifier = createHs256Verifier({ secret: 'unit-test-secret', now: fixedNow });
  await assertJwtRejects(verifier.verify(`a.${'x'.repeat(17 * 1024)}.c`), 'MALFORMED');
  const arrayHeader = b64url(JSON.stringify(['HS256']));
  const payloadSegment = base64urlJson(validPayload());
  await assertJwtRejects(verifier.verify(`${arrayHeader}.${payloadSegment}.${b64url('s')}`), 'MALFORMED');
});

test('key resolver failures surface as KEY_RESOLUTION_FAILED', async () => {
  const token = hs256Token(validPayload(), 'unit-test-secret');
  const throws = createJwtVerifier({
    algorithms: ['HS256'],
    keyResolver: () => { throw new Error('jwks unavailable'); },
    now: fixedNow,
  });
  await assertJwtRejects(throws.verify(token), 'KEY_RESOLUTION_FAILED');

  const missing = createJwtVerifier({
    algorithms: ['HS256'],
    keyResolver: () => undefined,
    now: fixedNow,
  });
  await assertJwtRejects(missing.verify(token), 'KEY_RESOLUTION_FAILED');
});

test('createHs256Verifier only trusts HS256 (HS384/HS512 rejected)', async () => {
  const verifier = createHs256Verifier({ secret: 'unit-test-secret', now: fixedNow });
  const headerSegment = base64urlJson({ alg: 'HS384', typ: 'JWT' });
  const payloadSegment = base64urlJson(validPayload());
  const input = `${headerSegment}.${payloadSegment}`;
  const signature = createHmac('sha384', 'unit-test-secret').update(input).digest('base64url');
  await assertJwtRejects(verifier.verify(`${input}.${signature}`), 'UNSUPPORTED_ALG');
});

/* -------------------------------------------------------------------------- */
/* 2. Claims: exp / nbf / iat / iss / aud                                    */
/* -------------------------------------------------------------------------- */

test('expired token beyond the skew window is EXPIRED; inside skew it passes', async () => {
  const verifier = createHs256Verifier({ secret: 'unit-test-secret', now: fixedNow, clockSkewSeconds: 30 });
  await assertJwtRejects(
    verifier.verify(hs256Token(validPayload({ exp: NOW_S - 31 }))),
    'EXPIRED',
  );
  const within = await verifier.verify(hs256Token(validPayload({ exp: NOW_S - 10 })));
  assert.equal(within.payload.sub, 'user-1');
});

test('future nbf beyond the skew window is NOT_YET_VALID; inside skew it passes', async () => {
  const verifier = createHs256Verifier({ secret: 'unit-test-secret', now: fixedNow, clockSkewSeconds: 30 });
  await assertJwtRejects(
    verifier.verify(hs256Token(validPayload({ nbf: NOW_S + 31 }))),
    'NOT_YET_VALID',
  );
  const within = await verifier.verify(hs256Token(validPayload({ nbf: NOW_S + 10 })));
  assert.equal(within.payload.sub, 'user-1');
});

test('iat in the future beyond skew is NOT_YET_VALID', async () => {
  const verifier = createHs256Verifier({ secret: 'unit-test-secret', now: fixedNow, clockSkewSeconds: 30 });
  await assertJwtRejects(
    verifier.verify(hs256Token(validPayload({ iat: NOW_S + 31 }))),
    'NOT_YET_VALID',
  );
});

test('issuer mismatch is BAD_ISSUER; missing iss is MISSING_CLAIM', async () => {
  const verifier = createHs256Verifier({
    secret: 'unit-test-secret',
    issuer: 'flutterforge',
    now: fixedNow,
  });
  await assertJwtRejects(
    verifier.verify(hs256Token(validPayload({ iss: 'someone-else' }))),
    'BAD_ISSUER',
  );
  const { iss: _omit, ...withoutIss } = validPayload();
  await assertJwtRejects(verifier.verify(hs256Token(withoutIss)), 'MISSING_CLAIM');
  const ok = await verifier.verify(hs256Token(validPayload()));
  assert.equal(ok.payload.iss, 'flutterforge');
});

test('audience string mismatch is BAD_AUDIENCE', async () => {
  const verifier = createHs256Verifier({
    secret: 'unit-test-secret',
    audience: 'flutterforge-api',
    now: fixedNow,
  });
  await assertJwtRejects(
    verifier.verify(hs256Token(validPayload({ aud: 'some-other-api' }))),
    'BAD_AUDIENCE',
  );
  const ok = await verifier.verify(hs256Token(validPayload()));
  assert.equal(ok.payload.aud, 'flutterforge-api');
});

test('audience array must intersect the accepted audiences', async () => {
  const verifier = createHs256Verifier({
    secret: 'unit-test-secret',
    audience: ['flutterforge-api', 'flutterforge-admin'],
    now: fixedNow,
  });
  const ok = await verifier.verify(
    hs256Token(validPayload({ aud: ['unrelated', 'flutterforge-admin'] })),
  );
  assert.deepEqual(ok.payload.aud, ['unrelated', 'flutterforge-admin']);

  await assertJwtRejects(
    verifier.verify(hs256Token(validPayload({ aud: ['a', 'b', 'c'] }))),
    'BAD_AUDIENCE',
  );

  const { aud: _omit, ...withoutAud } = validPayload();
  await assertJwtRejects(verifier.verify(hs256Token(withoutAud)), 'MISSING_CLAIM');
});

test('missing exp is MISSING_CLAIM unless requireExp is false', async () => {
  const { exp: _omit, ...withoutExp } = validPayload();
  const required = createHs256Verifier({ secret: 'unit-test-secret', now: fixedNow });
  await assertJwtRejects(required.verify(hs256Token(withoutExp)), 'MISSING_CLAIM');

  const optional = createHs256Verifier({ secret: 'unit-test-secret', now: fixedNow, requireExp: false });
  const ok = await optional.verify(hs256Token(withoutExp));
  assert.equal(ok.payload.sub, 'user-1');
});

/* -------------------------------------------------------------------------- */
/* 3. ES256 with generated EC keys (JOSE raw r||s -> DER for crypto.verify)   */
/* -------------------------------------------------------------------------- */

test('ES256 sign and verify roundtrip through the JOSE raw->DER conversion', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const headerSegment = base64urlJson({ alg: 'ES256', typ: 'JWT' });
  const payloadSegment = base64urlJson(validPayload());
  const input = `${headerSegment}.${payloadSegment}`;
  // dsaEncoding 'ieee-p1363' produces the JOSE raw r||s signature.
  const signature = cryptoSign(
    'sha256',
    Buffer.from(input, 'ascii'),
    { key: privateKey, dsaEncoding: 'ieee-p1363' },
  );
  assert.equal(signature.length, 64);
  const token = `${input}.${signature.toString('base64url')}`;

  // 1. KeyObject from a PEM string exercises the createPublicKey path.
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fromPem = createJwtVerifier({ algorithms: ['ES256'], key: pem, now: fixedNow });
  const verifiedFromPem = await fromPem.verify(token);
  assert.equal(verifiedFromPem.payload.sub, 'user-1');

  // 2. KeyObject via keyResolver with the token header.
  const fromResolver = createJwtVerifier({
    algorithms: ['ES256'],
    keyResolver: (header) => {
      assert.equal(header.alg, 'ES256');
      return publicKey;
    },
    now: fixedNow,
  });
  const verifiedFromResolver = await fromResolver.verify(token);
  assert.equal(verifiedFromResolver.payload.sub, 'user-1');

  // 3. Tampered signature fails verification, not parsing.
  const signatureBytes = Buffer.from(signature);
  signatureBytes[0] ^= 0x01;
  const tampered = `${input}.${signatureBytes.toString('base64url')}`;
  await assertJwtRejects(fromPem.verify(tampered), 'BAD_SIGNATURE');

  // 4. An RSA key must not verify an ES256 token (key-type confusion).
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const rsaVerifier = createJwtVerifier({ algorithms: ['ES256'], key: rsaPem, now: fixedNow });
  await assertJwtRejects(rsaVerifier.verify(token), 'UNSUPPORTED_ALG');
});

test('ES256 rejects a truncated raw signature', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const headerSegment = base64urlJson({ alg: 'ES256', typ: 'JWT' });
  const payloadSegment = base64urlJson(validPayload());
  const input = `${headerSegment}.${payloadSegment}`;
  const signature = cryptoSign(
    'sha256',
    Buffer.from(input, 'ascii'),
    { key: privateKey, dsaEncoding: 'ieee-p1363' },
  );
  const truncated = signature.subarray(0, signature.length - 1);
  const token = `${input}.${truncated.toString('base64url')}`;
  const verifier = createJwtVerifier({ algorithms: ['ES256'], key: publicKey, now: fixedNow });
  await assertJwtRejects(verifier.verify(token), 'BAD_SIGNATURE');
});

/* -------------------------------------------------------------------------- */
/* 4. RBAC matrix, tenancy, project-role scoping                              */
/* -------------------------------------------------------------------------- */

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';

function principal(roles: Principal['roles'], projectRoles?: Principal['projectRoles']): Principal {
  return {
    userId: 'user-1',
    tenantId: TENANT,
    roles,
    ...(projectRoles !== undefined ? { projectRoles } : {}),
  };
}

const project = (projectId: string, tenantId = TENANT) =>
  ({ type: 'project', tenantId, projectId }) as const;

test('RBAC matrix: role capabilities across the hierarchy', () => {
  assert.throws(
    () => authorize(principal(['viewer']), 'project:write', project('p1')),
    (error) => isAuthz('FORBIDDEN')(error),
  );

  // Reviewer can approve but cannot write (viewer + approve only).
  const reviewer = authorize(principal(['reviewer']), 'project:approve', project('p1'));
  assert.equal(reviewer.allowed, true);
  assert.equal(reviewer.effectiveRole, 'reviewer');
  assert.throws(
    () => authorize(principal(['reviewer']), 'project:write', project('p1')),
    (error) => isAuthz('FORBIDDEN')(error),
  );

  // Lead engineer cannot delete or deploy.
  assert.throws(
    () => authorize(principal(['lead_engineer']), 'project:delete', project('p1')),
    (error) => isAuthz('FORBIDDEN')(error),
  );
  assert.throws(
    () => authorize(principal(['lead_engineer']), 'project:deploy', project('p1')),
    (error) => isAuthz('FORBIDDEN')(error),
  );
  // ...but can roll back and execute in the sandbox.
  assert.equal(authorize(principal(['lead_engineer']), 'project:rollback', project('p1')).allowed, true);
  assert.equal(
    authorize(principal(['lead_engineer']), 'sandbox:execute', { type: 'sandbox', tenantId: TENANT, projectId: 'p1' }).allowed,
    true,
  );

  // Admin can delete, but not org:manage.
  assert.equal(authorize(principal(['admin']), 'project:delete', project('p1')).allowed, true);
  assert.throws(
    () => authorize(principal(['admin']), 'org:manage', { type: 'org', tenantId: TENANT }),
    (error) => isAuthz('FORBIDDEN')(error),
  );

  // Owner: every permission on its compatible resource type.
  for (const permission of PERMISSIONS) {
    const resourceType = PERMISSION_RESOURCE_TYPES[permission as Permission][0];
    const resource = resourceType === 'project'
      ? project('p1')
      : resourceType === 'sandbox'
        ? { type: 'sandbox' as const, tenantId: TENANT, projectId: 'p1' }
        : { type: resourceType as ResourceType, tenantId: TENANT };
    const decision = authorize(principal(['owner']), permission as Permission, resource);
    assert.equal(decision.allowed, true, `owner should hold ${permission}`);
    assert.equal(decision.effectiveRole, 'owner');
  }
});

test('hierarchy: higher roles imply every lower-role permission', () => {
  for (let i = 0; i < ROLE_HIERARCHY.length; i += 1) {
    for (let j = i + 1; j < ROLE_HIERARCHY.length; j += 1) {
      const higher = ROLE_HIERARCHY[i];
      const lower = ROLE_HIERARCHY[j];
      for (const permission of ROLE_PERMISSIONS[lower]) {
        assert.ok(
          ROLE_PERMISSIONS[higher].includes(permission),
          `${higher} must imply ${permission} from ${lower}`,
        );
      }
    }
  }
});

test('cross-tenant access throws TENANT_MISMATCH', () => {
  assert.throws(
    () => authorize(principal(['owner']), 'project:read', project('p1', OTHER_TENANT)),
    (error) => isAuthz('TENANT_MISMATCH')(error),
  );
});

test('project role elevates within its project only', () => {
  const elevated = principal(['viewer'], { p1: 'admin' });
  const inScope = authorize(elevated, 'project:delete', project('p1'));
  assert.equal(inScope.allowed, true);
  assert.equal(inScope.effectiveRole, 'admin');

  // Same principal, another project: org-level viewer applies, delete denied.
  assert.throws(
    () => authorize(elevated, 'project:delete', project('p2')),
    (error) => isAuthz('FORBIDDEN')(error),
  );

  // Project roles never grant org-level permissions, even owner-in-project.
  const projectOwner = principal(['viewer'], { p1: 'owner' });
  assert.throws(
    () => authorize(projectOwner, 'org:manage', { type: 'org', tenantId: TENANT }),
    (error) => isAuthz('FORBIDDEN')(error),
  );

  // A sandbox bound to the elevated project sees the elevation too.
  const sandboxOk = authorize(elevated, 'sandbox:execute', {
    type: 'sandbox',
    tenantId: TENANT,
    projectId: 'p1',
  });
  assert.equal(sandboxOk.allowed, true);
  assert.equal(
    authorize(elevated, 'project:read', project('p1')).allowed,
    true,
  );
});

test('unknown permission, unknown role and role-less principal are denied', () => {
  assert.throws(
    () => authorize(
      principal(['admin']),
      'project:frobnicate' as Permission,
      project('p1'),
    ),
    (error) => isAuthz('FORBIDDEN')(error),
  );
  assert.throws(
    () => authorize(principal([]), 'project:read', project('p1')),
    (error) => isAuthz('FORBIDDEN')(error),
  );
  assert.throws(
    () => authorize(
      { userId: 'user-1', tenantId: TENANT, roles: ['bogus' as Principal['roles'][number]] },
      'project:read',
      project('p1'),
    ),
    (error) => isAuthz('FORBIDDEN')(error),
  );
});

test('role order sanity: ROLES and ROLE_HIERARCHY agree on membership', () => {
  assert.deepEqual([...ROLES].sort(), [...ROLE_HIERARCHY].sort());
  assert.equal(ROLE_HIERARCHY[0], 'owner');
  assert.equal(ROLE_HIERARCHY[ROLE_HIERARCHY.length - 1], 'viewer');
});

/* -------------------------------------------------------------------------- */
/* 5. Token bucket: refill math, exhaustion, headers, consumeAll              */
/* -------------------------------------------------------------------------- */

function makeLimiter(clock: ManualClock, store?: MemoryTokenBucketStore) {
  const backend = store ?? new MemoryTokenBucketStore({ clock, sweepIntervalMs: 0 });
  return { store: backend, limiter: new TokenBucketLimiter({ store: backend, clock }) };
}

test('refill math is exact with an injected clock', async () => {
  const clock = new ManualClock(1_000_000);
  const { store, limiter } = makeLimiter(clock);
  try {
    const first = await limiter.consume('bucket', { capacity: 10, refillPerSecond: 1, cost: 4 });
    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 6);
    assert.equal(first.limit, 10);

    clock.advance(3_000);
    const second = await limiter.consume('bucket', { capacity: 10, refillPerSecond: 1, cost: 1 });
    // 6 remaining + 3 refilled = 9, minus 1 consumed = 8.
    assert.equal(second.remaining, 8);

    // Refill is capped at capacity.
    clock.advance(60_000);
    const third = await limiter.consume('bucket', { capacity: 10, refillPerSecond: 1, cost: 1 });
    assert.equal(third.remaining, 9);
    assert.equal(third.allowed, true);
  } finally {
    store.dispose();
  }
});

test('denial after exhaustion with a deterministic Retry-After', async () => {
  const clock = new ManualClock(5_000_000);
  const { store, limiter } = makeLimiter(clock);
  try {
    const first = await limiter.consume('tight', { capacity: 1, refillPerSecond: 1, cost: 1 });
    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 0);

    const denied = await limiter.consume('tight', { capacity: 1, refillPerSecond: 1, cost: 1 });
    assert.equal(denied.allowed, false);
    assert.equal(denied.remaining, 0);
    assert.equal(denied.retryAfterMs, 1000);

    const headers = rateLimitHeaders(denied, clock.now());
    assert.equal(headers['RateLimit-Limit'], '1');
    assert.equal(headers['RateLimit-Remaining'], '0');
    assert.equal(headers['Retry-After'], '1');

    // An allowed result carries no Retry-After header.
    const allowedHeaders = rateLimitHeaders(first, clock.now());
    assert.equal(allowedHeaders['Retry-After'], undefined);
  } finally {
    store.dispose();
  }
});

test('Retry-After rounds up to whole seconds', async () => {
  const clock = new ManualClock(9_000_000);
  const { store, limiter } = makeLimiter(clock);
  try {
    await limiter.consume('slow', { capacity: 1, refillPerSecond: 0.4, cost: 1 });
    const denied = await limiter.consume('slow', { capacity: 1, refillPerSecond: 0.4, cost: 1 });
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterMs, 2500);
    const headers = rateLimitHeaders(denied, clock.now());
    assert.equal(headers['Retry-After'], '3');
  } finally {
    store.dispose();
  }
});

test('backwards clock movement cannot mint tokens', async () => {
  const clock = new ManualClock(10_000_000);
  const { store, limiter } = makeLimiter(clock);
  try {
    const first = await limiter.consume('backwards', { capacity: 5, refillPerSecond: 1, cost: 5 });
    assert.equal(first.remaining, 0);
    clock.set(1_000_000); // wall clock jumps backwards
    const denied = await limiter.consume('backwards', { capacity: 5, refillPerSecond: 1, cost: 1 });
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterMs > 0, true);
  } finally {
    store.dispose();
  }
});

test('consumeAll reports the most restrictive bucket', async () => {
  const clock = new ManualClock(20_000_000);
  const { store, limiter } = makeLimiter(clock);
  try {
    // Exhaust the tight bucket.
    await limiter.consume('tight-a', { capacity: 1, refillPerSecond: 1, cost: 1 });

    const composite = await limiter.consumeAll([
      { key: 'tight-a', capacity: 1, refillPerSecond: 1, cost: 1 },
      { key: 'roomy-b', capacity: 100, refillPerSecond: 1, cost: 1 },
    ]);
    assert.equal(composite.allowed, false);
    assert.equal(composite.remaining, 0); // min remaining
    assert.equal(composite.limit, 1); // min limit
    assert.equal(composite.retryAfterMs, 1000); // max retryAfter

    // A fully allowed composite has zero retryAfter.
    const fresh = await limiter.consumeAll([
      { key: 'fresh-a', capacity: 10, refillPerSecond: 1, cost: 1 },
      { key: 'fresh-b', capacity: 10, refillPerSecond: 1, cost: 1 },
    ]);
    assert.equal(fresh.allowed, true);
    assert.equal(fresh.retryAfterMs, 0);
    assert.equal(fresh.remaining, 9);
  } finally {
    store.dispose();
  }
});

test('tier presets match the published contract', () => {
  assert.equal(RATE_TIERS.public.capacity, 60);
  assert.equal(RATE_TIERS.public.refillPerSecond, 1); // 60 per 60s
  assert.equal(RATE_TIERS.developer.capacity, 600);
  assert.equal(RATE_TIERS.developer.refillPerSecond, 10); // 600 per 60s
  assert.equal(RATE_TIERS.build.capacity, 4);
  assert.equal(RATE_TIERS.workflow_start.capacity, 10);
  assert.equal(RATE_TIERS.streaming.capacity, 120);
  assert.equal(RATE_TIERS.streaming.refillPerSecond, 60); // 60 per 1s
});

test('sweepExpired() removes expired entries from the memory store', () => {
  const clock = new ManualClock(30_000_000);
  const store = new MemoryTokenBucketStore({ clock, sweepIntervalMs: 0 });
  try {
    store.set('sweep-me', { tokens: 5, updatedAtMs: clock.now() }, 1000);
    clock.advance(1_001);
    assert.equal(store.sweepExpired(), 1);
    assert.equal(store.get('sweep-me'), null);
  } finally {
    store.dispose();
  }
});

/* -------------------------------------------------------------------------- */
/* 6. extractBearerToken strictness and claim mapping                         */
/* -------------------------------------------------------------------------- */

test('extractBearerToken enforces the strict RFC 6750 shape', () => {
  assert.equal(extractBearerToken('Bearer abc.def-123_~+/='), 'abc.def-123_~+/=');
  assert.equal(extractBearerToken('  Bearer padded.token  '), 'padded.token');
  assert.equal(extractBearerToken(`Bearer ${'a'.repeat(16384)}`), 'a'.repeat(16384));

  // Rejected shapes.
  assert.equal(extractBearerToken(''), null);
  assert.equal(extractBearerToken('   '), null);
  assert.equal(extractBearerToken('Bearer'), null);
  assert.equal(extractBearerToken('Bearer '), null);
  assert.equal(extractBearerToken('Bearer  double-space'), null);
  assert.equal(extractBearerToken('Bearer\ttab.token'), null);
  assert.equal(extractBearerToken('bearer lowercase.token'), null);
  assert.equal(extractBearerToken('BEARER upper.token'), null);
  assert.equal(extractBearerToken('Basic abc.def'), null);
  assert.equal(extractBearerToken('Bearer büser.token'), null);
  assert.equal(extractBearerToken('Bearer two words.token'), null);
  assert.equal(extractBearerToken('Bearer token with space'), null);
  assert.equal(extractBearerToken(`Bearer ${'a'.repeat(16385)}`), null);
  assert.equal(extractBearerToken(undefined), null);
  // @ts-expect-error runtime validation of non-string input
  assert.equal(extractBearerToken(42), null);
});

test('claim mapping drops invalid roles and keeps valid ones', () => {
  const mapped = mapClaimsToPrincipal({
    sub: 'user-1',
    tenant_id: 'tenant-1',
    roles: ['admin', 'not-a-role', 7, null, 'viewer', 'admin'],
    project_roles: {
      p1: 'lead_engineer',
      p2: 'bogus-role',
      '__proto__': 'owner',
    },
  });
  assert.ok(mapped);
  assert.equal(mapped.userId, 'user-1');
  assert.equal(mapped.tenantId, 'tenant-1');
  assert.deepEqual(mapped.roles, ['admin', 'viewer']);
  assert.deepEqual(mapped.projectRoles, { p1: 'lead_engineer' });
});

test('namespaced claims win over flat fallbacks; malformed namespace fails closed', () => {
  const mapped = mapClaimsToPrincipal({
    sub: 'user-1',
    'https://flutterforge.dev/tenant_id': 'tenant-ns',
    tenant_id: 'tenant-flat',
    'https://flutterforge.dev/roles': ['reviewer'],
    roles: ['owner'],
    'https://flutterforge.dev/project_roles': { p1: 'admin' },
    project_roles: { p1: 'viewer' },
  });
  assert.ok(mapped);
  assert.equal(mapped.tenantId, 'tenant-ns');
  assert.deepEqual(mapped.roles, ['reviewer']);
  assert.deepEqual(mapped.projectRoles, { p1: 'admin' });

  // Malformed namespaced roles are NOT repaired from the flat claim.
  const failClosed = mapClaimsToPrincipal({
    sub: 'user-1',
    'https://flutterforge.dev/roles': 'definitely-not-an-array',
    roles: ['owner'],
  });
  assert.ok(failClosed);
  assert.deepEqual(failClosed.roles, []);
});

test('missing sub yields null; missing tenant yields null tenantId (caller decides)', () => {
  assert.equal(mapClaimsToPrincipal({ tenant_id: 'tenant-1', roles: ['admin'] }), null);
  assert.equal(mapClaimsToPrincipal('not-an-object'), null);

  const noTenant = mapClaimsToPrincipal({ sub: 'user-1', roles: ['viewer'] });
  assert.ok(noTenant);
  assert.equal(noTenant.tenantId, null);

  // The caller decides: claimsToPrincipal refuses to build a principal
  // without a tenant instead of authorising against a placeholder.
  assert.equal(claimsToPrincipal({ sub: 'user-1', roles: ['viewer'] }), null);
  const bridged = claimsToPrincipal({ sub: 'user-1', tenant_id: 'tenant-1', roles: ['viewer'] });
  assert.ok(bridged);
  assert.equal(bridged.tenantId, 'tenant-1');
});

test('createRequestContext builds an immutable context from verified claims', () => {
  const clock = new ManualClock(42_000_000);
  let idCounter = 0;
  const context = createRequestContext(
    {
      ip: '203.0.113.7',
      claims: {
        sub: 'user-1',
        'https://flutterforge.dev/tenant_id': 'tenant-1',
        roles: ['admin', 'bogus'],
        scope: 'project:read project:write bad!scope',
      },
    },
    { clock, idFactory: () => `id-${(idCounter += 1)}` },
  );
  assert.equal(context.userId, 'user-1');
  assert.equal(context.tenantId, 'tenant-1');
  assert.deepEqual(context.roles, ['admin']);
  assert.deepEqual(context.scopes, ['project:read', 'project:write']);
  assert.equal(context.requestId, 'id-1');
  assert.equal(context.traceId, 'id-2');
  assert.equal(context.startedAtMs, 42_000_000);
  assert.equal(context.ip, '203.0.113.7');
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.roles), true);

  // Empty roles claim maps to zero roles (authorization denies by default).
  const emptyRoles = createRequestContext(
    { claims: { sub: 'user-1', tenant_id: 'tenant-1', roles: [] } },
    { clock },
  );
  assert.deepEqual(emptyRoles.roles, []);

  // Claims without a usable subject are rejected outright.
  assert.throws(() => createRequestContext({ claims: { roles: ['admin'] } }, { clock }), TypeError);

  // Explicit ids are honoured and validated.
  const explicit = createRequestContext(
    { requestId: 'req-1', traceId: 'trace-1', claims: { sub: 'user-1', tenant_id: 'tenant-1' } },
    { clock },
  );
  assert.equal(explicit.requestId, 'req-1');
  assert.equal(explicit.traceId, 'trace-1');
});

test('full pipeline: verified token claims drive the RBAC principal', async () => {
  const verifier = createHs256Verifier({
    secret: 'unit-test-secret',
    issuer: 'flutterforge',
    now: fixedNow,
  });
  const token = hs256Token(validPayload({
    'https://flutterforge.dev/tenant_id': 'tenant-1',
    roles: ['admin'],
  }));
  const verified = await verifier.verify(token);
  const bridged = claimsToPrincipal(verified.payload);
  assert.ok(bridged);

  const decision = authorize(
    bridged,
    'project:delete',
    { type: 'project', tenantId: 'tenant-1', projectId: 'p1' },
  );
  assert.equal(decision.allowed, true);

  const context = createRequestContext(
    { ip: '198.51.100.23', claims: verified.payload },
    { clock: new ManualClock(123) },
  );
  assert.equal(context.tenantId, 'tenant-1');
  assert.deepEqual(context.roles, ['admin']);
});
