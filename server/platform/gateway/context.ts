/**
 * Request identity plumbing shared by every gateway entry point.
 *
 * A RequestContext is created once at the edge, after the bearer token has
 * been verified and its claims mapped. Downstream code gets immutable
 * identity fields; it never sees the raw token.
 *
 * Claim mapping rules:
 *  - Namespaced claims (`https://flutterforge.dev/roles`,
 *    `https://flutterforge.dev/tenant_id`,
 *    `https://flutterforge.dev/project_roles`,
 *    `https://flutterforge.dev/scopes`) win over flat fallbacks
 *    (`roles`, `tenant_id`, `project_roles`, `scope`/`scopes`).
 *  - A present-but-malformed namespaced claim fails closed: it is not
 *    "repaired" from the flat fallback.
 *  - Unknown or invalid roles are dropped, never rejected the request.
 *  - Empty roles mean no roles; authorisation then denies by default.
 *  - A missing tenant claim is not an error here: `tenantId` is `null` and
 *    the caller decides (reject the request, or proceed into a
 *    tenant-less deny-by-default authorisation path).
 */
import { randomUUID } from 'node:crypto';
import { systemClock, type Clock } from '../kernel/clock.js';
import {
  isRole,
  isSafeRecordKey,
  type Principal,
  type Role,
} from './rbac.js';

export interface RequestContext {
  readonly requestId: string;
  readonly traceId: string;
  /** Null when the verified claims carry no usable tenant identifier. */
  readonly tenantId: string | null;
  readonly userId: string;
  readonly roles: readonly Role[];
  readonly scopes: readonly string[];
  readonly ip?: string;
  /** Epoch milliseconds when the request entered the gateway. */
  readonly startedAtMs: number;
}

export interface CreateRequestContextInput {
  requestId?: string;
  traceId?: string;
  ip?: string;
  /** Claims of a *verified* token. Never pass unverified claims. */
  claims: unknown;
}

export interface CreateRequestContextOptions {
  /** Injected clock; defaults to the system clock. Used for startedAtMs. */
  clock?: Clock;
  /** ID generator for requestId/traceId; defaults to randomUUID. */
  idFactory?: () => string;
}

// eslint-disable-next-line no-control-regex -- intentional: rejects control characters in identifiers
const IDENTIFIER = /^[^\u0000-\u001F\u007F\s]+$/;
const SCOPE = /^[A-Za-z0-9*:_./-]+$/;
const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]+)$/;
const MAX_ID_LENGTH = 128;
const MAX_SUBJECT_LENGTH = 256;
const MAX_IP_LENGTH = 64;
const MAX_SCOPE_LENGTH = 128;
/** Same bound as MAX_JWT_BYTES in ./jwt.ts. */
const MAX_BEARER_LENGTH = 16 * 1024;
const MAX_CLAIM_PROJECT_ROLES = 256;

export const CLAIM_ROLES = 'https://flutterforge.dev/roles';
export const CLAIM_TENANT_ID = 'https://flutterforge.dev/tenant_id';
export const CLAIM_PROJECT_ROLES = 'https://flutterforge.dev/project_roles';
export const CLAIM_SCOPES = 'https://flutterforge.dev/scopes';

const OWN = Object.prototype.hasOwnProperty;

function hasOwn(object: object, key: string): boolean {
  return OWN.call(object, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeId(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  if (value.length === 0 || value.length > MAX_ID_LENGTH || !IDENTIFIER.test(value)) {
    throw new TypeError(`${label} must be 1-${MAX_ID_LENGTH} non-whitespace, non-control characters.`);
  }
  return value;
}

function normalizeIp(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError('ip must be a string.');
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_IP_LENGTH || !IDENTIFIER.test(trimmed)) {
    throw new TypeError(`ip must be at most ${MAX_IP_LENGTH} non-whitespace, non-control characters.`);
  }
  return trimmed;
}

function isClaimIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SUBJECT_LENGTH
    && IDENTIFIER.test(value);
}

interface ClaimSelection {
  present: boolean;
  value: unknown;
}

/** First present key wins (namespaced first, flat fallback second). */
function pick(record: Record<string, unknown>, keys: readonly string[]): ClaimSelection {
  for (const key of keys) {
    if (hasOwn(record, key)) return { present: true, value: record[key] };
  }
  return { present: false, value: undefined };
}

/** Parse a roles claim: an array of unknown entries, or a single role string. */
function parseRoleClaim(value: unknown): Role[] {
  if (Array.isArray(value)) {
    const roles: Role[] = [];
    const seen = new Set<Role>();
    for (const entry of value) {
      if (isRole(entry) && !seen.has(entry)) {
        seen.add(entry);
        roles.push(entry);
      }
    }
    return roles;
  }
  // A single known role string is unambiguous and cannot elevate the caller.
  if (isRole(value)) return [value];
  return [];
}

function parseProjectRoles(value: unknown): Record<string, Role> {
  if (!isPlainObject(value)) return {};
  const roles: Record<string, Role> = {};
  let entries = 0;
  for (const [projectId, role] of Object.entries(value)) {
    if (entries >= MAX_CLAIM_PROJECT_ROLES) break;
    if (!isSafeRecordKey(projectId) || !isRole(role)) continue;
    roles[projectId] = role;
    entries += 1;
  }
  return roles;
}

function parseScopes(value: unknown): string[] {
  const entries = typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : value;
  if (!Array.isArray(entries)) return [];
  const scopes: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_SCOPE_LENGTH) continue;
    if (!SCOPE.test(entry) || seen.has(entry)) continue;
    seen.add(entry);
    scopes.push(entry);
  }
  return scopes;
}

/**
 * Strict RFC 6750 bearer extraction.
 *
 * Matches exactly `^Bearer ([A-Za-z0-9._~+/=-]+)$` on the trimmed header with
 * the token bounded to 16384 characters. Every malformed shape — wrong
 * scheme, case variants, extra whitespace, embedded spaces, oversize or
 * non-ASCII input — returns null so an edge handler can answer a uniform 401.
 */
export function extractBearerToken(authorizationHeader?: string): string | null {
  if (typeof authorizationHeader !== 'string') return null;
  const header = authorizationHeader.trim();
  if (header.length === 0) return null;
  if (header.length > MAX_BEARER_LENGTH + 'Bearer '.length) return null;
  const match = BEARER.exec(header);
  if (!match) return null;
  const token = match[1];
  if (token.length === 0 || token.length > MAX_BEARER_LENGTH) return null;
  return token;
}

export interface ClaimsPrincipal {
  userId: string;
  /** Null when no usable tenant claim is present; the caller decides. */
  tenantId: string | null;
  roles: readonly Role[];
  projectRoles: Readonly<Record<string, Role>>;
  /** API-key scopes from the token, if any. Passed through to RBAC. Undefined = unrestricted. */
  scopes: readonly string[] | undefined;
}

/**
 * Map verified JWT claims to the RBAC input shape.
 *
 * Returns null when the subject is missing or invalid. A missing/invalid
 * tenant claim does NOT fail the mapping; `tenantId` is null and the caller
 * decides what to do. Unknown roles and project-role entries are dropped.
 */
export function mapClaimsToPrincipal(payload: unknown): ClaimsPrincipal | null {
  if (!isPlainObject(payload)) return null;

  const userIdSelection = pick(payload, ['sub', 'user_id', 'userId']);
  if (!userIdSelection.present || !isClaimIdentifier(userIdSelection.value)) return null;
  const userId = userIdSelection.value;

  const tenantSelection = pick(payload, [CLAIM_TENANT_ID, 'tenant_id', 'tenantId']);
  const tenantId = tenantSelection.present && isClaimIdentifier(tenantSelection.value)
    ? tenantSelection.value
    : null;

  // Namespaced roles win outright; a malformed namespaced claim fails closed
  // rather than falling back to the flat claim.
  const rolesSelection = hasOwn(payload, CLAIM_ROLES)
    ? { present: true, value: payload[CLAIM_ROLES] }
    : pick(payload, ['roles']);
  const roles = rolesSelection.present ? parseRoleClaim(rolesSelection.value) : [];

  const projectRolesSelection = hasOwn(payload, CLAIM_PROJECT_ROLES)
    ? { present: true, value: payload[CLAIM_PROJECT_ROLES] }
    : pick(payload, ['project_roles', 'projectRoles']);
  const projectRoles = projectRolesSelection.present
    ? parseProjectRoles(projectRolesSelection.value)
    : {};

  const scopeSelection = hasOwn(payload, CLAIM_SCOPES)
    ? { present: true, value: payload[CLAIM_SCOPES] }
    : pick(payload, ['scopes', 'scope']);
  // No scope claim → undefined (unrestricted), never [] (nothing allowed).
  const scopes = scopeSelection.present ? parseScopes(scopeSelection.value) : undefined;

  return {
    userId,
    tenantId,
    roles: Object.freeze(roles),
    projectRoles: Object.freeze(projectRoles),
    scopes: scopes === undefined ? undefined : Object.freeze(scopes),
  };
}

/**
 * Build the immutable per-request identity record from verified claims.
 *
 * Throws TypeError when the claims are missing a usable subject. Empty roles
 * stay empty — authorisation denies by default, so there is no implicit
 * "viewer" grant. `ip` is only present when supplied.
 */
export function createRequestContext(
  input: CreateRequestContextInput,
  options: CreateRequestContextOptions = {},
): RequestContext {
  if (!isPlainObject(input)) throw new TypeError('Request context input is required.');
  const clock = options.clock ?? systemClock;
  if (!clock || typeof clock.now !== 'function') throw new TypeError('clock must implement now().');
  const idFactory = options.idFactory ?? randomUUID;
  if (typeof idFactory !== 'function') throw new TypeError('idFactory must be a function.');

  const mapped = mapClaimsToPrincipal(input.claims);
  if (!mapped) {
    throw new TypeError('claims are missing a usable subject identifier.');
  }

  const scopes = mapped.scopes ?? [];

  const requestId = input.requestId === undefined
    ? normalizeId(idFactory(), 'requestId')
    : normalizeId(input.requestId, 'requestId');
  const traceId = input.traceId === undefined
    ? normalizeId(idFactory(), 'traceId')
    : normalizeId(input.traceId, 'traceId');

  const startedAtMs = clock.now();
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs) || startedAtMs < 0) {
    throw new TypeError('clock must return finite epoch milliseconds.');
  }

  const ip = normalizeIp(input.ip);

  return Object.freeze({
    requestId,
    traceId,
    tenantId: mapped.tenantId,
    userId: mapped.userId,
    roles: Object.freeze([...mapped.roles]),
    scopes: Object.freeze(scopes),
    ...(ip !== undefined ? { ip } : {}),
    startedAtMs,
  });
}

/**
 * Convert the claim mapping into the RBAC principals used by authorize().
 * Returns null when there is no usable tenant — cross-tenant authorisation
 * must never be attempted with a placeholder tenant.
 */
export function claimsToPrincipal(claims: unknown): Principal | null {
  const mapped = mapClaimsToPrincipal(claims);
  if (!mapped) return null;
  if (mapped.tenantId === null) return null;
  return {
    userId: mapped.userId,
    tenantId: mapped.tenantId,
    roles: mapped.roles,
    projectRoles: mapped.projectRoles,
    // Pass API-key scopes through so RBAC can further restrict permissions.
    scopes: mapped.scopes,
  };
}
