/**
 * Hierarchical, tenant-scoped RBAC.
 *
 * Rank order (highest first): owner > admin > lead_engineer > contributor >
 * reviewer > viewer. Each `ROLE_PERMISSIONS` entry is the *cumulative*
 * effective set for that rank; a higher role therefore always carries every
 * permission of the roles below it. The matrix is explicit (rather than
 * computed at runtime) so a security review can read exactly what each role
 * grants, and it is frozen so plugins cannot widen it accidentally.
 *
 * Authorisation is deny-by-default: unknown roles, permissions, resource
 * types, malformed principals and un-scoped project permissions all fail.
 * Org-level roles apply across the tenant. Project roles apply only to the
 * named project (and to sandbox resources bound to that project).
 */
export const ROLE_HIERARCHY = Object.freeze([
  'owner',
  'admin',
  'lead_engineer',
  'contributor',
  'reviewer',
  'viewer',
] as const);

/** Same ordering as ROLE_HIERARCHY, kept for call sites that prefer the plural name. */
export const ROLES: readonly Role[] = ROLE_HIERARCHY;

export type Role = (typeof ROLE_HIERARCHY)[number];

export const ROLE_RANK: Readonly<Record<Role, number>> = Object.freeze({
  viewer: 1,
  reviewer: 2,
  contributor: 3,
  lead_engineer: 4,
  admin: 5,
  owner: 6,
});

export const PERMISSIONS = [
  'project:read',
  'project:write',
  'project:delete',
  'project:deploy',
  'project:approve',
  'project:rollback',
  'project:export',
  'member:invite',
  'member:manage',
  'secrets:manage',
  'billing:manage',
  'audit:read',
  'sandbox:execute',
  'workflow:cancel',
  'workflow:start',
  'org:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const RESOURCE_TYPES = ['project', 'org', 'billing', 'audit', 'sandbox'] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

function permissions(...values: Permission[]): readonly Permission[] {
  return Object.freeze(values);
}

function resourceTypes(...values: ResourceType[]): readonly ResourceType[] {
  return Object.freeze(values);
}

/**
 * Explicit cumulative permission matrix. Every entry is the complete effective
 * set for that rank; a higher role always carries every permission of the
 * roles below it.
 *
 * viewer        project:read, project:export
 * reviewer      + project:approve
 * contributor   + project:write, workflow:start, workflow:cancel
 * lead_engineer + project:rollback, sandbox:execute, audit:read (no delete, no deploy)
 * admin         everything except org:manage
 * owner         everything, including org:manage
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  viewer: permissions(
    'project:read',
    'project:export',
  ),
  reviewer: permissions(
    'project:read',
    'project:export',
    'project:approve',
  ),
  contributor: permissions(
    'project:read',
    'project:export',
    'project:approve',
    'project:write',
    'workflow:start',
    'workflow:cancel',
  ),
  lead_engineer: permissions(
    'project:read',
    'project:export',
    'project:approve',
    'project:write',
    'workflow:start',
    'workflow:cancel',
    'project:rollback',
    'sandbox:execute',
    'audit:read',
  ),
  admin: permissions(
    'project:read',
    'project:write',
    'project:delete',
    'project:deploy',
    'project:approve',
    'project:rollback',
    'project:export',
    'member:invite',
    'member:manage',
    'secrets:manage',
    'billing:manage',
    'audit:read',
    'sandbox:execute',
    'workflow:cancel',
    'workflow:start',
  ),
  owner: permissions(
    'project:read',
    'project:write',
    'project:delete',
    'project:deploy',
    'project:approve',
    'project:rollback',
    'project:export',
    'member:invite',
    'member:manage',
    'secrets:manage',
    'billing:manage',
    'audit:read',
    'sandbox:execute',
    'workflow:cancel',
    'workflow:start',
    'org:manage',
  ),
});

/** A permission is only meaningful on the resource types listed here. */
export const PERMISSION_RESOURCE_TYPES: Readonly<Record<Permission, readonly ResourceType[]>> = Object.freeze({
  'project:read': resourceTypes('project'),
  'project:write': resourceTypes('project'),
  'project:delete': resourceTypes('project'),
  'project:deploy': resourceTypes('project'),
  'project:approve': resourceTypes('project'),
  'project:rollback': resourceTypes('project'),
  'project:export': resourceTypes('project'),
  'member:invite': resourceTypes('org'),
  'member:manage': resourceTypes('org'),
  'secrets:manage': resourceTypes('project'),
  'billing:manage': resourceTypes('billing'),
  'audit:read': resourceTypes('audit'),
  'sandbox:execute': resourceTypes('sandbox'),
  'workflow:cancel': resourceTypes('project'),
  'workflow:start': resourceTypes('project'),
  'org:manage': resourceTypes('org'),
});

const PROJECT_ROLE_RESOURCE_TYPES: ReadonlySet<ResourceType> = new Set(['project', 'sandbox']);
const ROLE_SET: ReadonlySet<string> = new Set(ROLES);
const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);
const RESOURCE_TYPE_SET: ReadonlySet<string> = new Set(RESOURCE_TYPES);
const OWN = Object.prototype.hasOwnProperty;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const IDENTIFIER = /^[^\u0000-\u001F\u007F\s]+$/;
const MAX_IDENTIFIER_LENGTH = 256;

export type AuthzErrorCode = 'FORBIDDEN' | 'TENANT_MISMATCH';

export class AuthzError extends Error {
  readonly code: AuthzErrorCode;
  readonly statusCode = 403;
  readonly details?: Record<string, unknown>;

  constructor(code: AuthzErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AuthzError';
    this.code = code;
    this.details = details;
  }
}

export function isAuthzError(error: unknown, code?: AuthzErrorCode): error is AuthzError {
  return error instanceof AuthzError && (code === undefined || error.code === code);
}

export interface Principal {
  userId: string;
  tenantId: string;
  roles: readonly Role[];
  projectRoles?: Readonly<Record<string, Role>>;
  /** Optional API-key scopes. When present they further restrict permissions. */
  scopes?: readonly string[];
}

export interface AuthzResource {
  type: ResourceType;
  tenantId: string;
  projectId?: string;
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && ROLE_SET.has(value);
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

export function isResourceType(value: unknown): value is ResourceType {
  return typeof value === 'string' && RESOURCE_TYPE_SET.has(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && IDENTIFIER.test(value);
}

/** Keep known roles, drop unknown entries, de-duplicate while preserving order. */
export function normalizeRoles(input: unknown): Role[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<Role>();
  const roles: Role[] = [];
  for (const value of input) {
    if (isRole(value) && !seen.has(value)) {
      seen.add(value);
      roles.push(value);
    }
  }
  return roles;
}

export function listPermissions(role: Role | string): readonly Permission[] {
  if (!isRole(role)) return Object.freeze([]);
  return ROLE_PERMISSIONS[role];
}

/** True when `role` carries `permission`. Unknown roles/permissions deny. */
export function hasPermission(role: Role | string, permission: Permission | string): boolean {
  if (!isRole(role) || !isPermission(permission)) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Alias kept for call sites written against the previous name. */
export const roleHasPermission = hasPermission;

function higherRole(current: Role | null, candidate: Role | null): Role | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return ROLE_RANK[candidate] > ROLE_RANK[current] ? candidate : current;
}

/**
 * Highest role granted to this principal for a project. Org roles always
 * count; a project role is considered only when a projectId is supplied.
 */
export function resolveEffectiveRole(principal: Principal, projectId?: string): Role | null {
  if (!isPlainObject(principal)) return null;

  let effective: Role | null = null;
  for (const role of normalizeRoles(principal.roles)) {
    effective = higherRole(effective, role);
  }

  if (typeof projectId === 'string' && isIdentifier(projectId) && isPlainObject(principal.projectRoles)) {
    if (hasOwn(principal.projectRoles, projectId)) {
      const projectRole = principal.projectRoles[projectId];
      if (isRole(projectRole)) effective = higherRole(effective, projectRole);
    }
  }

  return effective;
}

function forbidden(message: string, details?: Record<string, unknown>): never {
  throw new AuthzError('FORBIDDEN', message, details);
}

function hasOwn(object: object, key: string): boolean {
  return OWN.call(object, key);
}

function assertPrincipal(principal: unknown): asserts principal is Principal {
  if (!isPlainObject(principal)) forbidden('Invalid principal.');
  if (!isIdentifier(principal.tenantId)) forbidden('Principal has an invalid tenant identifier.');
  if (!isIdentifier(principal.userId)) forbidden('Principal has an invalid user identifier.');
  if (!Array.isArray(principal.roles)) forbidden('Principal roles must be an array.');
  if (principal.projectRoles !== undefined && !isPlainObject(principal.projectRoles)) {
    forbidden('Principal projectRoles must be an object.');
  }
  if (principal.scopes !== undefined && !Array.isArray(principal.scopes)) {
    forbidden('Principal scopes must be an array.');
  }
}

function assertResource(resource: unknown): asserts resource is AuthzResource {
  if (!isPlainObject(resource)) forbidden('Invalid authorization resource.');
  if (!isIdentifier(resource.tenantId)) forbidden('Resource has an invalid tenant identifier.');
  if (!isResourceType(resource.type)) forbidden('Unknown authorization resource type.');
  if (resource.projectId !== undefined && !isIdentifier(resource.projectId)) {
    forbidden('Resource has an invalid project identifier.');
  }
}

function scopeAllows(scope: string, permission: Permission): boolean {
  if (scope === '*' || scope === permission) return true;
  if (scope.endsWith(':*') && scope.length > 2) {
    return permission.startsWith(scope.slice(0, -1));
  }
  return false;
}

function validateScopes(scopes: unknown): readonly string[] | undefined {
  if (scopes === undefined) return undefined;
  if (!Array.isArray(scopes)) forbidden('Principal scopes must be an array.');
  const result: string[] = [];
  for (const scope of scopes) {
    if (typeof scope !== 'string' || scope.length === 0 || scope.length > 128 || /\s/.test(scope)) {
      forbidden('Principal contains an invalid scope.');
    }
    result.push(scope);
  }
  return result;
}

export interface AuthorizationDecision {
  readonly allowed: true;
  /** Highest role that satisfied the check (org role, or project role when elevated). */
  readonly effectiveRole: Role;
}

/**
 * Throws unless the principal may perform `permission` on `resource`.
 * Returns `{ allowed: true, effectiveRole }` on success (it never throws on
 * the allow path). Throws AuthzError: TENANT_MISMATCH for cross-tenant
 * access, FORBIDDEN otherwise.
 */
export function authorize(principal: Principal, permission: Permission, resource: AuthzResource): AuthorizationDecision {
  assertPrincipal(principal);
  assertResource(resource);

  // Cross-tenant access is rejected before any role/permission evaluation.
  if (principal.tenantId !== resource.tenantId) {
    throw new AuthzError('TENANT_MISMATCH', 'Cross-tenant access is not allowed.');
  }

  if (!isPermission(permission)) forbidden('Unknown permission.');

  const allowedTypes = PERMISSION_RESOURCE_TYPES[permission];
  if (!allowedTypes.includes(resource.type)) {
    forbidden(`Permission "${permission}" cannot be used on a ${resource.type} resource.`, {
      permission,
      resourceType: resource.type,
    });
  }

  if (resource.type === 'project' && resource.projectId === undefined) {
    forbidden('A project-scoped permission requires a projectId.');
  }

  const scopes = validateScopes(principal.scopes);
  if (scopes !== undefined && !scopes.some((scope) => scopeAllows(scope, permission))) {
    forbidden(`Token scope does not allow "${permission}".`, { permission });
  }

  let effective = resolveEffectiveRole(principal);
  if (resource.projectId !== undefined && PROJECT_ROLE_RESOURCE_TYPES.has(resource.type)) {
    const projectRole = isPlainObject(principal.projectRoles) && hasOwn(principal.projectRoles, resource.projectId)
      ? principal.projectRoles[resource.projectId]
      : undefined;
    if (isRole(projectRole)) effective = higherRole(effective, projectRole);
  }

  if (effective === null) {
    forbidden('Principal has no recognised role.');
  }
  if (!ROLE_PERMISSIONS[effective].includes(permission)) {
    forbidden(`Role "${effective}" does not grant "${permission}".`, {
      permission,
      role: effective,
      resourceType: resource.type,
      projectId: resource.projectId,
    });
  }

  return { allowed: true, effectiveRole: effective };
}

/** Assert that a principal belongs to the expected tenant. */
export function assertSameTenant(principal: Principal, tenantId: string): void {
  assertPrincipal(principal);
  if (!isIdentifier(tenantId)) forbidden('Invalid tenant identifier.');
  if (principal.tenantId !== tenantId) {
    throw new AuthzError('TENANT_MISMATCH', 'Cross-tenant access is not allowed.');
  }
}

/** Reject prototype-pollution keys in caller-supplied project role maps. */
export function isSafeRecordKey(key: string): boolean {
  return !DANGEROUS_KEYS.has(key) && isIdentifier(key);
}
