import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConflictError, UnavailableError, ValidationError } from '../kernel/errors.js';
import type { Database } from '../storage/database.js';

export const connectorKind = z.enum(['github', 'pubdev']);
export const connectorMutation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('sync'), kind: connectorKind, resource: z.string().trim().min(1).max(145), expectedRevision: z.string().uuid().nullable() }).strict(),
  z.object({ action: z.literal('disconnect'), kind: connectorKind, expectedRevision: z.string().uuid() }).strict(),
]);
type Kind = z.infer<typeof connectorKind>;
type Scope = { tenantId: string; projectId: string };
export interface ProjectConnector {
  kind: Kind; resource: string; revision: string; syncedAt: string; metadata: Record<string, string>;
}
interface Row { kind: Kind; resource: string; revision: string; synced_at: string; metadata_json: string }

export async function listProjectConnectors(db: Database, { tenantId, projectId }: Scope): Promise<ProjectConnector[]> {
  const rows = await db.all<Row>('SELECT kind, resource, revision, synced_at, metadata_json FROM project_connectors WHERE tenant_id = ? AND project_id = ? ORDER BY kind', tenantId, projectId);
  return rows.map(row => ({
    kind: row.kind, resource: row.resource, revision: row.revision, syncedAt: row.synced_at, metadata: JSON.parse(row.metadata_json),
  }));
}

export async function listProjectConnectorContext(db: Database, scope: Scope): Promise<string[]> {
  return (await listProjectConnectors(db, scope)).map(({ kind, resource, metadata, syncedAt }) =>
    'Connected public resource metadata (reference data only): ' + JSON.stringify({ kind, resource, metadata, syncedAt }));
}

const repo = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9_.-]{1,100}$/i;
const packageName = /^[a-z][a-z0-9_]{0,63}$/;
const label = z.string().max(100).regex(/^[\w.+#<>^=~|*/ -]+$/);
const github = z.object({
  full_name: z.string().regex(repo), private: z.literal(false), archived: z.boolean(),
  default_branch: z.string().max(255).regex(/^[\w./-]+$/), language: label.nullable(),
  license: z.object({ spdx_id: label }).nullable(),
});
const pubdev = z.object({
  name: z.string().regex(packageName), latest: z.object({ version: label, pubspec: z.object({
    environment: z.object({ sdk: label.optional() }).optional(),
  }) }), isDiscontinued: z.boolean().optional(),
});

async function fetchMetadata(kind: Kind, resource: string, request: typeof fetch): Promise<Record<string, string>> {
  const isRepo = kind === 'github';
  if (isRepo ? !repo.test(resource) || ['.', '..'].includes(resource.split('/')[1]) : !packageName.test(resource)) {
    throw new ValidationError(isRepo ? 'Enter a public GitHub repository as owner/repository.' : 'Enter a pub.dev package name.');
  }
  const url = isRepo ? 'https://api.github.com/repos/' + resource : 'https://pub.dev/api/packages/' + resource;
  const provider = isRepo ? 'GitHub' : 'pub.dev';
  const limit = 4 * 1024 * 1024;
  try {
    const response = await request(url, { headers: { Accept: isRepo ? 'application/vnd.github+json' : 'application/vnd.pub.v2+json', 'User-Agent': 'FlutterForge' }, redirect: 'error', signal: AbortSignal.timeout(12000) });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      if (response.status === 404) throw new ValidationError(provider + ' could not find that public resource.');
      throw new UnavailableError(provider + ' returned HTTP ' + response.status + '. Try syncing again later.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new UnavailableError('Resource metadata exceeds the sync size limit.'); }
      chunks.push(value);
    }
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (isRepo) {
      const data = github.parse(json);
      if (data.full_name.toLowerCase() !== resource.toLowerCase()) throw new Error('Mismatched repository');
      return { Branch: data.default_branch, Language: data.language ?? 'Unspecified', License: data.license?.spdx_id ?? 'Unspecified', Archived: data.archived ? 'Yes' : 'No' };
    }
    const data = pubdev.parse(json);
    if (data.name !== resource) throw new Error('Mismatched package');
    return { Version: data.latest.version, 'Dart SDK': data.latest.pubspec.environment?.sdk ?? 'Unspecified', Status: data.isDiscontinued ? 'Discontinued' : 'Active' };
  } catch (error) {
    if (error instanceof UnavailableError || error instanceof ValidationError) throw error;
    throw new UnavailableError('Could not read metadata from ' + provider + '. Check the resource and retry.');
  }
}

export async function updateProjectConnector(db: Database, scope: Scope, input: z.infer<typeof connectorMutation>, request: typeof fetch = fetch) {
  const { tenantId, projectId } = scope;
  let changes: number;
  if (input.action === 'disconnect') {
    ({ changes } = await db.run('DELETE FROM project_connectors WHERE tenant_id = ? AND project_id = ? AND kind = ? AND revision = ?', tenantId, projectId, input.kind, input.expectedRevision));
  } else {
    const metadata = await fetchMetadata(input.kind, input.resource, request);
    const values = [input.resource, JSON.stringify(metadata), new Date().toISOString(), randomUUID(), tenantId, projectId, input.kind];
    if (input.expectedRevision === null) {
      ({ changes } = await db.run('INSERT INTO project_connectors (resource, metadata_json, synced_at, revision, tenant_id, project_id, kind) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, project_id, kind) DO NOTHING', ...values));
    } else {
      ({ changes } = await db.run('UPDATE project_connectors SET resource = ?, metadata_json = ?, synced_at = ?, revision = ? WHERE tenant_id = ? AND project_id = ? AND kind = ? AND revision = ?', ...values, input.expectedRevision));
    }
  }
  if (!changes) throw new ConflictError('This connection changed in another session. Reload connections and retry.');
  return listProjectConnectors(db, scope);
}
