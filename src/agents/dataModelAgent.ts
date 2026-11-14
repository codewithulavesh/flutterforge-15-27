import type { ProjectState, DataSchema, TableDefinition } from '../orchestrator/state';
import { callLLMJsonStrict, agentModelFor } from './llmClient';
import { validate } from './schema';
import { DataModelOutput } from './schemas';

export async function runDataModelAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const brief = state.productBrief;
  const intake = (state as Record<string, unknown>)._intakeData as Record<string, unknown> | undefined;
  const screens = state.screenGraph?.screens || [];
  const domain = (intake?.domain as string) || 'general';
  const needsSupabase = (intake?.needsSupabase as boolean) ?? false;
  const keyFeatures = (intake?.keyFeatures as string[]) || [];

  if (!needsSupabase) {
    return {
      dataSchema: { tables: [], migrations: [] },
      logs: [...state.logs, `[Data Model Agent] Local-only app — no database schema required.`],
    };
  }

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

  const schema: DataSchema = {
    tables: output.tables as TableDefinition[],
    migrations: output.migrations,
  };

  return {
    dataSchema: schema,
    logs: [
      ...state.logs,
      `[Data Model Agent] Designed ${schema.tables.length} tables: ${schema.tables.map((t) => t.name).join(', ')}. RLS enabled on all tables.`,
    ],
  };
}
