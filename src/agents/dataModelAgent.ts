import type { ProjectState, DataSchema, TableDefinition, TableColumn, GateDiagnostic } from '../orchestrator/state';
import { callLLMJsonStrict, agentModelFor } from './llmClient';
import { validate } from './schema';
import { DataModelOutput } from './schemas';

const TABLE_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
const COLUMN_TYPES = new Set(['text', 'integer', 'boolean', 'timestamptz', 'uuid', 'jsonb', 'numeric', 'date']);
const POLICY_ACTIONS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL']);

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (v === null || v === undefined ? '' : String(v).trim()))
    .filter((v) => v.length > 0);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalize a table name to lower snake_case matching TABLE_NAME_RE, or null if unsalvageable. */
function normalizeTableName(raw: unknown): string | null {
  let name = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!name) return null;
  if (!/^[a-z]/.test(name)) name = `t_${name}`;
  name = name.slice(0, 64);
  return TABLE_NAME_RE.test(name) ? name : null;
}

/** Normalize a column name to lower snake_case; returns null if unsalvageable. */
function normalizeColumnName(raw: unknown): string | null {
  const name = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!name) return null;
  return /^[a-z]/.test(name) ? name.slice(0, 63) : `c_${name.slice(0, 60)}`;
}

/** Map an arbitrary model-emitted column type onto the primitive set; anything else becomes text. */
function normalizeColumnType(raw: unknown): { type: string; coerced: boolean } {
  const t = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\(.*\)$/, '')
    .trim();
  if (COLUMN_TYPES.has(t)) return { type: t, coerced: false };
  return { type: 'text', coerced: true };
}

/** Deterministic baseline table used when Supabase is requested but the model emits nothing usable. */
function synthesizedProfilesTable(): TableDefinition {
  return {
    name: 'profiles',
    columns: [
      { name: 'id', type: 'uuid', isPrimary: true, isNullable: false },
      { name: 'email', type: 'text', isNullable: false },
      { name: 'full_name', type: 'text', isNullable: true },
      { name: 'avatar_url', type: 'text', isNullable: true },
      { name: 'created_at', type: 'timestamptz', isNullable: false, defaultValue: 'NOW()' },
      { name: 'updated_at', type: 'timestamptz', isNullable: false, defaultValue: 'NOW()' },
    ],
    enableRLS: true,
    policies: [
      { name: 'users_read_own_profile', action: 'SELECT', rule: 'auth.uid() = id' },
      { name: 'users_update_own_profile', action: 'UPDATE', rule: 'auth.uid() = id' },
    ],
  };
}

export async function runDataModelAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const brief = state.productBrief;
  const intake = (state as Record<string, unknown>)._intakeData as Record<string, unknown> | undefined;
  const screens = state.screenGraph?.screens || [];
  const domain = str(intake?.domain, 'general');
  const needsSupabase = asBool(intake?.needsSupabase) === true;
  const archBackendMode = state.architectureSpec?.backendMode;
  const supabaseMode = needsSupabase || archBackendMode === 'supabase';
  const keyFeatures = asStringArray(intake?.keyFeatures);

  if (!supabaseMode) {
    return {
      dataSchema: { tables: [], migrations: [] },
      logs: [...state.logs, `[Data Model Agent] Local-only app — no database schema required.`],
    };
  }

  const diagnostics: GateDiagnostic[] = [];

  interface DataModelOutput {
    tables: Array<{
      name: string;
      description: string;
      columns: Array<{ name: string; type: string; isPrimary?: boolean; isNullable?: boolean; defaultValue?: string }>;
      enableRLS: boolean;
      policies: Array<{ name: string; action: string; rule: string }>;
      indexes: string[];
    }>;
    migrations: string[];
    relationships: Array<{ from: string; to: string; type: string; via?: string }>;
  }

  let output: DataModelOutput;
  try {
    output = await callLLMJsonStrict<DataModelOutput>(
      [
        {
          role: 'system',
          content: `You are the Data Model Agent for FlutterForge. You are a PostgreSQL and Supabase expert.

Your job: Design a complete, production-ready PostgreSQL schema for a Supabase-backed Flutter app.

RULES:
1. Always include a "profiles" table extending Supabase auth.users (id UUID FK auth.users)
2. Use UUID primary keys (id UUID DEFAULT gen_random_uuid() PRIMARY KEY)
3. Add created_at TIMESTAMPTZ DEFAULT NOW() and updated_at TIMESTAMPTZ DEFAULT NOW() to all tables
4. Enable RLS (Row Level Security) on all tables
5. Write real, secure RLS policies (not just "true")
6. Add user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE for user-owned data
7. Create indexes on foreign keys and frequently queried columns
8. Use correct PostgreSQL types: TEXT, UUID, INTEGER, BOOLEAN, TIMESTAMPTZ, JSONB, NUMERIC

Return ONLY valid JSON:
{
  "tables": [
    {
      "name": "profiles",
      "description": "User profile data",
      "columns": [
        {"name": "id", "type": "UUID", "isPrimary": true, "isNullable": false},
        {"name": "email", "type": "TEXT", "isNullable": false},
        {"name": "full_name", "type": "TEXT", "isNullable": true},
        {"name": "avatar_url", "type": "TEXT", "isNullable": true},
        {"name": "created_at", "type": "TIMESTAMPTZ", "defaultValue": "NOW()"}
      ],
      "enableRLS": true,
      "policies": [
        {"name": "users_read_own_profile", "action": "SELECT", "rule": "auth.uid() = id"},
        {"name": "users_update_own_profile", "action": "UPDATE", "rule": "auth.uid() = id"}
      ],
      "indexes": ["CREATE INDEX ON profiles(email)"]
    }
  ],
  "migrations": ["SQL migration content as a string"],
  "relationships": [
    {"from": "table_a", "to": "profiles", "type": "many-to-one", "via": "user_id"}
  ]
}`,
        },
        {
          role: 'user',
          content: `Design database schema for "${brief?.appName}" — a ${domain} app.
Brief: ${brief?.oneLiner}
Key features: ${keyFeatures.join(', ')}
Screens: ${screens.map((s) => s.purpose).join('; ')}

Design a complete schema. Include profiles + all domain-specific tables needed for ${domain}.`,
        },
      ],
      (data) => validate<DataModelOutput>(DataModelOutput, data),
      {
        model: agentModelFor('data-model'),
        temperature: 0.2,
        maxTokens: 4000,
        responseFormat: 'json',
      }
    );
  } catch (err) {
    console.warn('[DataModelAgent] LLM failed, using domain schema fallback:', err);
    output = {
      tables: [
        {
          name: 'profiles',
          description: 'User profiles',
          columns: [
            { name: 'id', type: 'UUID', isPrimary: true, isNullable: false },
            { name: 'email', type: 'TEXT', isNullable: false },
            { name: 'full_name', type: 'TEXT', isNullable: true },
            { name: 'avatar_url', type: 'TEXT', isNullable: true },
            { name: 'created_at', type: 'TIMESTAMPTZ', defaultValue: 'NOW()' },
            { name: 'updated_at', type: 'TIMESTAMPTZ', defaultValue: 'NOW()' },
          ],
          enableRLS: true,
          policies: [
            { name: 'users_read_own_profile', action: 'SELECT', rule: 'auth.uid() = id' },
            { name: 'users_update_own_profile', action: 'UPDATE', rule: 'auth.uid() = id' },
          ],
          indexes: ['CREATE INDEX ON profiles(email)'],
        },
      ],
      migrations: [],
      relationships: [],
    };
  }

  // --- Sanitize tables before they reach shared state ---
  const rawTables = Array.isArray(output.tables) ? (output.tables as unknown as Array<Record<string, unknown>>) : [];
  const tables: TableDefinition[] = [];
  const seenNames = new Set<string>();

  for (const rawTable of rawTables) {
    if (!isPlainObject(rawTable)) {
      droppedInvalidTable(diagnostics, '(non-object entry)');
      continue;
    }
    const name = normalizeTableName(rawTable.name);
    if (!name) {
      droppedInvalidTable(diagnostics, String(rawTable.name ?? '(missing name)'));
      continue;
    }
    if (seenNames.has(name)) {
      diagnostics.push({
        gate: 'data-model',
        level: 'info',
        message: `Dropped duplicate table "${name}" — first definition wins`,
      });
      continue;
    }
    seenNames.add(name);

    const rawColumns = Array.isArray(rawTable.columns) ? (rawTable.columns as Array<Record<string, unknown>>) : [];
    const columns: TableColumn[] = [];
    const coercedTypes: string[] = [];
    for (const rawColumn of rawColumns) {
      if (!isPlainObject(rawColumn)) continue;
      const colName = normalizeColumnName(rawColumn.name);
      if (!colName) continue;
      const { type, coerced } = normalizeColumnType(rawColumn.type);
      if (coerced) coercedTypes.push(`${colName}: ${String(rawColumn.type ?? '(missing)')} → text`);
      const column: TableColumn = { name: colName, type, isPrimary: asBool(rawColumn.isPrimary) === true };
      const isNullable = asBool(rawColumn.isNullable);
      if (isNullable !== undefined) column.isNullable = isNullable;
      const defaultValue = str(rawColumn.defaultValue);
      if (defaultValue) column.defaultValue = defaultValue;
      columns.push(column);
    }
    if (coercedTypes.length > 0) {
      diagnostics.push({
        gate: 'data-model',
        level: 'info',
        message: `Table "${name}": coerced unsupported column type(s) to text — ${coercedTypes.join(', ')}`,
      });
    }

    if (columns.length === 0) {
      columns.push({ name: 'id', type: 'uuid', isPrimary: true, isNullable: false });
      diagnostics.push({
        gate: 'data-model',
        level: 'info',
        message: `Table "${name}": model emitted no usable columns — synthesized "id uuid PRIMARY KEY"`,
      });
    }

    // Primary key: detect, else synthesize/mark "id uuid PRIMARY KEY".
    if (!columns.some((c) => c.isPrimary)) {
      const idColumn = columns.find((c) => c.name === 'id');
      if (idColumn) {
        idColumn.isPrimary = true;
        idColumn.isNullable = false;
        diagnostics.push({
          gate: 'data-model',
          level: 'info',
          message: `Table "${name}": no primary key detected — marked existing "id" column as primary key`,
        });
      } else {
        columns.unshift({ name: 'id', type: 'uuid', isPrimary: true, isNullable: false });
        diagnostics.push({
          gate: 'data-model',
          level: 'info',
          message: `Table "${name}": no primary key detected — synthesized "id uuid PRIMARY KEY"`,
        });
      }
    }

    // Policies: clamp action, drop empty-rule policies with a diagnostic.
    const rawPolicies = Array.isArray(rawTable.policies) ? (rawTable.policies as Array<Record<string, unknown>>) : [];
    const policies: TableDefinition['policies'] = [];
    for (const rawPolicy of rawPolicies) {
      if (!isPlainObject(rawPolicy)) continue;
      const name = str(rawPolicy.name, 'policy');
      const actionRaw = str(rawPolicy.action).toUpperCase();
      const action = (POLICY_ACTIONS.has(actionRaw) ? actionRaw : 'ALL') as TableDefinition['policies'][number]['action'];
      const rule = str(rawPolicy.rule);
      if (!rule) {
        diagnostics.push({
          gate: 'data-model',
          level: 'warning',
          message: `Dropped policy "${name}" (${action}) on table "${name}" — empty rule SQL`,
        });
        continue;
      }
      policies.push({ name, action, rule });
    }

    // RLS: default true; enforced when Supabase is the backend mode.
    const enableRLS = supabaseMode ? true : asBool(rawTable.enableRLS) ?? true;

    tables.push({ name, columns, enableRLS, policies });
  }

  if (supabaseMode && tables.length === 0) {
    tables.push(synthesizedProfilesTable());
    diagnostics.push({
      gate: 'data-model',
      level: 'warning',
      message: 'Model emitted no usable tables for a Supabase-backed app — synthesized baseline "profiles" table with RLS',
    });
  }

  const migrations = asStringArray(output.migrations);

  const schema: DataSchema = {
    tables,
    migrations,
  };

  return {
    dataSchema: schema,
    diagnostics: [...state.diagnostics, ...diagnostics],
    logs: [
      ...state.logs,
      `[Data Model Agent] Designed ${schema.tables.length} tables: ${schema.tables.map((t) => t.name).join(', ')}. RLS enabled on all tables.`,
    ],
  };
}

function droppedInvalidTable(diagnostics: GateDiagnostic[], rawName: string): void {
  diagnostics.push({
    gate: 'data-model',
    level: 'warning',
    message: `Dropped table with unsalvageable name "${rawName}" — table names must match ^[a-z][a-z0-9_]{1,63}$`,
  });
}
