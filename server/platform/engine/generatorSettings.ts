import { z } from 'zod';
import type { Database } from '../storage/database.js';
import { ConflictError, ValidationError } from '../kernel/errors.js';
import { SKILL_DEFINITIONS } from './skillCatalog.js';

const role = z.enum(['planner', 'reviewer']);
const known = new Set(SKILL_DEFINITIONS.map(skill => skill.id));
const schema = z.object({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  skills: z.array(z.string().refine(id => known.has(id), 'Unknown skill')).max(known.size),
  specialists: z.array(role).max(2),
}).strict();
export type GeneratorSettings = z.infer<typeof schema>;

const key = (tenant: string, project: string) => 'generator:' + JSON.stringify([tenant, project]);

export async function loadGeneratorSettings(db: Database, tenant: string, project: string): Promise<GeneratorSettings> {
  const row = await db.get<{value_json: string}>('SELECT value_json FROM platform_settings WHERE key = ?', key(tenant, project));
  return row ? schema.parse(JSON.parse(row.value_json)) : {
    revision: 0,
    skills: SKILL_DEFINITIONS.filter(skill => skill.enabledByDefault).map(skill => skill.id),
    specialists: [],
  };
}

export async function saveGeneratorSettings(db: Database, tenant: string, project: string, input: unknown) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ValidationError('Invalid generator settings.');
  const { revision, skills, specialists } = parsed.data;
  const next = { revision: revision + 1, skills: [...new Set(skills)], specialists: [...new Set(specialists)] };
  const args = [JSON.stringify(next), next.revision, key(tenant, project)] as const;
  const result = revision === 0
    ? await db.run('INSERT INTO platform_settings (value_json, updated_at, key) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING', ...args)
    : await db.run('UPDATE platform_settings SET value_json = ?, updated_at = ? WHERE key = ? AND updated_at = ?', ...args, revision);
  if (!result.changes) throw new ConflictError('Generator settings changed in another session. Reload the settings before saving.');
  return next;
}

export function projectSkillContext(selected: string[]) {
  const rules = SKILL_DEFINITIONS.filter(skill => selected.includes(skill.id)).map(skill => skill.name + ': ' + skill.rules.join('. '));
  return 'Current project skills (supersede earlier skill preferences):\n' + (rules.join('\n') || 'None selected.');
}
