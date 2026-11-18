/**
 * Optional LLM enrichment for a compiled AppSpec.
 *
 * The deterministic compiler is the floor. This pass may only refine copy and
 * add entities/screens/flows/requirements; it can never delete user intent,
 * rename identity fields, or produce a spec that fails `validateSpec`. Every
 * failure path returns the untouched base spec, so enrichment is always safe
 * to run on the critical path.
 */
import type {
  AppSpec,
  EntitySpec,
  FieldSpec,
  FieldType,
  FlowSpec,
  FlowStep,
  LlmComplete,
  LlmCompletionRequest,
  RequirementCategory,
  RequirementSpec,
  ScreenKind,
  ScreenSpec,
} from '../contracts.js';
import { SCREEN_KINDS } from '../contracts.js';
import { camel, pascal, pluralize, routeOf, snake, validateSpec } from '../emit/shared.js';

export interface EnrichOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Hard cap on added entities/screens. Defaults 4 / 7. */
  maxEntities?: number;
  maxScreens?: number;
}

export interface EnrichResult {
  spec: AppSpec;
  enriched: boolean;
  notes: string[];
}

const DEFAULT_MAX_ENTITIES = 4;
const DEFAULT_MAX_SCREENS = 7;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 3000;
const DEFAULT_TEMPERATURE = 0.2;
const PROMPT_CHAR_BUDGET = 60_000;
const MAX_NOTES = 30;
const MAX_ENTITY_FIELD_COUNT = 24;

const FIELD_TYPES: readonly FieldType[] = [
  'string',
  'text',
  'int',
  'double',
  'bool',
  'datetime',
  'enum',
  'stringList',
  'relation',
];

const REQUIREMENT_CATEGORIES: readonly RequirementCategory[] = [
  'functional',
  'ux',
  'accessibility',
  'data',
  'performance',
  'reliability',
];

const DART_RESERVED = new Set([
  'abstract', 'as', 'assert', 'async', 'await', 'base', 'break', 'case', 'catch', 'class', 'const',
  'continue', 'covariant', 'default', 'deferred', 'do', 'dynamic', 'else', 'enum', 'export',
  'extends', 'extension', 'external', 'factory', 'final', 'finally', 'for', 'function', 'get',
  'hide', 'if', 'implements', 'import', 'in', 'interface', 'is', 'late', 'library', 'mixin',
  'new', 'on', 'operator', 'part', 'patch', 'required', 'rethrow', 'return', 'sealed', 'set',
  'show', 'static', 'super', 'switch', 'sync', 'this', 'throw', 'try', 'typedef', 'var', 'void',
  'when', 'while', 'with', 'yield',
]);

type JsonObject = Record<string, unknown>;

interface MergeLimits {
  maxEntities: number;
  maxScreens: number;
}

interface PromptBundle {
  system: string;
  user: string;
  truncated: boolean;
}

// ── small helpers ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

function cleanNote(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return cleanNote(raw || 'unknown error');
}

function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function cloneSpec(spec: AppSpec): AppSpec {
  try {
    return structuredClone(spec);
  } catch {
    return JSON.parse(JSON.stringify(spec)) as AppSpec;
  }
}

function isAppSpecLike(value: unknown): value is AppSpec {
  return (
    isRecord(value) &&
    isRecord(value.app) &&
    isRecord(value.design) &&
    Array.isArray(value.entities) &&
    Array.isArray(value.screens) &&
    Array.isArray(value.flows) &&
    Array.isArray(value.requirements)
  );
}

function clampCount(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function limitedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function normalizeRoute(raw: string): string {
  let route = raw.trim();
  if (!route) return '';
  if (!route.startsWith('/')) route = `/${route}`;
  route = route.replace(/\/{2,}/g, '/');
  if (route.length > 1 && route.endsWith('/')) route = route.slice(0, -1);
  return route;
}

function safeFieldName(raw: string): string {
  const name = camel(raw);
  if (name.length > 40 || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) return '';
  if (DART_RESERVED.has(name) || name === 'id') return '';
  return name;
}

function validSnakeId(value: string, maxLength = 60): boolean {
  return value.length > 0 && value.length <= maxLength && /^[a-z][a-z0-9_]*$/.test(value);
}

function canonicalEntityName(entities: EntitySpec[], raw: string): string | null {
  const key = pascal(raw);
  if (!key) return null;
  return entities.find((entity) => pascal(entity.name) === key)?.name ?? null;
}

function enforcePrimary(entity: EntitySpec): void {
  let seen = false;
  for (const field of entity.fields) {
    if (!field.primary) continue;
    if (seen) field.primary = false;
    else seen = true;
  }
  if (!seen) {
    const fallback = entity.fields.find((field) => field.type === 'string' || field.type === 'text');
    if (fallback) fallback.primary = true;
  }
}

function summarizeFieldNames(fields: FieldSpec[]): string {
  const names = fields.slice(0, 6).map((field) => field.name);
  return fields.length > 6 ? `${names.join(', ')}, …` : names.join(', ');
}

function finalizeNotes(rawNotes: string[]): string[] {
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawNotes) {
    const note = cleanNote(raw);
    if (!note || seen.has(note)) continue;
    seen.add(note);
    notes.push(note);
  }
  if (notes.length <= MAX_NOTES) return notes;
  return [...notes.slice(0, MAX_NOTES - 1), `${notes.length - (MAX_NOTES - 1)} more notes omitted`];
}

// ── prompt construction ────────────────────────────────────────────────────

const RESPONSE_SCHEMA = {
  app: {
    tagline: 'string — only when the base tagline is generic',
    description: 'string — only when the base description is generic',
  },
  entities: [
    {
      name: 'PascalCase singular entity name (new entities only)',
      plural: 'snake_case plural (new entities only)',
      description: 'string',
      fields: [
        {
          name: 'camelCase field name',
          type: FIELD_TYPES.join(' | '),
          required: 'boolean',
          values: 'string[] — required and non-empty for enum',
          target: 'EntityName — required for relation',
          primary: 'boolean — at most one per entity',
          label: 'human label',
        },
      ],
    },
  ],
  screens: [
    {
      id: 'snake_case unique id',
      title: 'string',
      route: '/path — detail/form routes must contain :id',
      kind: SCREEN_KINDS.join(' | '),
      purpose: 'string — concrete product purpose',
      entity: 'existing or newly added EntityName',
      primaryAction: 'string',
      inNavigation: 'boolean',
      icon: 'snake_case material icon',
    },
  ],
  flows: [
    {
      id: 'snake_case unique id',
      name: 'string',
      steps: [{ screenId: 'existing or newly added screen id', action: 'string' }],
    },
  ],
  requirements: [
    {
      id: 'snake_case unique id',
      statement: 'string',
      category: REQUIREMENT_CATEGORIES.join(' | '),
      verifiedBy: 'analyze | test | score | string',
    },
  ],
  notes: ['short human-readable notes'],
};

function systemPrompt(limits: MergeLimits): string {
  return [
    'You enrich an existing Flutter app specification. The deterministic compiler has already produced a valid BASE SPEC.',
    'Return ONE JSON object that refines and extends it. Your output is merged by a strict deterministic program; invalid or destructive suggestions are ignored.',
    '',
    'HARD RULES:',
    '- Additive/refinement only. Never remove, rename or reorder existing entities, screens, flows or requirements.',
    '- Never change app.name, app.packageName, app.domain, app.version, audience, design, backend or seedCount.',
    '- Existing entity names, screen ids, routes and screen kinds are immutable.',
    `- Add at most ${limits.maxEntities} entities and at most ${limits.maxScreens} screens.`,
    '- Every screen that references an entity must use an entity that exists in BASE SPEC or is added in your response.',
    '- Enum fields need a non-empty `values` array. Relation fields need `target` naming an existing or added entity.',
    `- Screen kinds must be one of: ${SCREEN_KINDS.join(', ')}.`,
    '- detail and form screen routes must contain `:id`.',
    '- At most one `primary` field per entity. Do not mark a new field primary if the entity already has one.',
    '- Output a single JSON object with keys: app, entities, screens, flows, requirements, notes. No markdown or prose outside the JSON.',
    '',
    'QUALITY BAR:',
    '- Be concrete and product-specific: "Log a workout with sets, reps and RPE", not "Manage workouts" or marketing copy.',
    '- Refine app.tagline and app.description only when the base values are generic (they contain the word "app" or repeat the app name).',
    '- Prefer specific enums over free strings for status/type fields, and give every added field a human label.',
    '- Add missing screens only when they complete a real journey (e.g. a form to create the core record).',
    '- Add requirements only when they are verifiable by analyze, test or score.',
    '',
    'RESPONSE JSON SCHEMA (exact field names and value domains):',
    JSON.stringify(RESPONSE_SCHEMA, null, 2),
    '',
    'Omitted fields are unchanged. Empty arrays mean no additions.',
  ].join('\n');
}

function userPrompt(spec: AppSpec, limits: MergeLimits): string {
  return [
    'BASE SPEC JSON:',
    JSON.stringify(spec),
    '',
    `Enrich this app now. Additive/refinement only: at most ${limits.maxEntities} entities and ${limits.maxScreens} screens, one JSON object as your entire reply.`,
  ].join('\n');
}

function capEntityFields(spec: AppSpec, cap: number): void {
  for (const entity of spec.entities) entity.fields = entity.fields.slice(0, cap);
}

function shrinkCopy(spec: AppSpec, max: number): void {
  const text = (value: unknown): string => {
    const raw = typeof value === 'string' ? value : '';
    return raw.length > max ? raw.slice(0, max) : raw;
  };
  spec.app.tagline = text(spec.app.tagline);
  spec.app.description = text(spec.app.description);
  for (const entity of spec.entities) entity.description = text(entity.description);
  for (const screen of spec.screens) screen.purpose = text(screen.purpose);
  for (const requirement of spec.requirements) requirement.statement = text(requirement.statement);
}

function trimCollections(spec: AppSpec): void {
  spec.entities = spec.entities.slice(0, 40);
  spec.screens = spec.screens.slice(0, 60);
  spec.flows = spec.flows.slice(0, 40);
  spec.requirements = spec.requirements.slice(0, 60);
}

/**
 * Build a prompt that stays near the 60k character budget. Truncation happens
 * only in the copy sent to the model; the result always merges into the
 * untouched base spec.
 */
function buildPrompt(base: AppSpec, limits: MergeLimits): PromptBundle {
  const system = systemPrompt(limits);
  const spec = cloneSpec(base);
  const caps: Array<number | null> = [null, 8, 4, 2, 1, 0];
  let usedStage = false;
  let user = '';

  for (const cap of caps) {
    if (cap !== null) {
      capEntityFields(spec, cap);
      usedStage = true;
    }
    user = userPrompt(spec, limits);
    if (system.length + user.length <= PROMPT_CHAR_BUDGET) {
      return { system, user, truncated: usedStage };
    }
  }

  shrinkCopy(spec, 160);
  user = userPrompt(spec, limits);
  if (system.length + user.length <= PROMPT_CHAR_BUDGET) return { system, user, truncated: true };

  shrinkCopy(spec, 60);
  user = userPrompt(spec, limits);
  if (system.length + user.length <= PROMPT_CHAR_BUDGET) return { system, user, truncated: true };

  trimCollections(spec);
  user = userPrompt(spec, limits);
  return { system, user, truncated: true };
}

// ── defensive response parsing ─────────────────────────────────────────────

function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```[ \t]*(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) blocks.push(match[1]);
  return blocks;
}

/** All top-level `{...}` regions, aware of quoted strings. */
function balancedObjects(text: string, singleQuotes: boolean): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || (singleQuotes && char === "'")) {
      quote = char;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (char === '}') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function stripTrailingCommas(text: string): string | null {
  let out = '';
  let quote = '';
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"') {
      quote = char;
      out += char;
      continue;
    }
    if (char === ',') {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === '}' || text[next] === ']') continue;
    }
    out += char;
  }
  return quote ? null : out;
}

/** Convert single-quoted strings and drop trailing commas outside strings. */
function repairJson(text: string): string | null {
  let out = '';
  let changed = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      let j = i + 1;
      let escaped = false;
      while (j < text.length) {
        const inner = text[j];
        if (escaped) escaped = false;
        else if (inner === '\\') escaped = true;
        else if (inner === '"') break;
        j++;
      }
      if (j >= text.length) return null;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (char !== "'") {
      out += char;
      i++;
      continue;
    }
    let j = i + 1;
    let value = '';
    let closed = false;
    while (j < text.length) {
      const inner = text[j];
      if (inner === '\\') {
        const next = text[j + 1];
        if (next === undefined) return null;
        if (next === "'") value += "'";
        else if (next === '"') value += '\\"';
        else value += `\\${next}`;
        j += 2;
        continue;
      }
      if (inner === "'") {
        closed = true;
        j++;
        break;
      }
      if (inner === '"') {
        value += '\\"';
        j++;
        continue;
      }
      if (inner === '\n' || inner === '\r') return null;
      value += inner;
      j++;
    }
    if (!closed) return null;
    out += `"${value}"`;
    changed = true;
    i = j;
  }
  const withoutTrailing = stripTrailingCommas(out);
  if (withoutTrailing === null) return null;
  return changed || withoutTrailing !== out ? withoutTrailing : out;
}

function tryObject(text: string): JsonObject | null {
  const candidates: string[] = [];
  for (const block of fencedBlocks(text)) {
    candidates.push(block.trim());
    candidates.push(...balancedObjects(block, true));
    candidates.push(...balancedObjects(block, false));
  }
  const trimmed = text.trim();
  if (trimmed) candidates.push(trimmed);
  candidates.push(...balancedObjects(trimmed, true));
  candidates.push(...balancedObjects(trimmed, false));

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // fall through to the loose repair pass
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    const repaired = repairJson(candidate);
    if (repaired === null || repaired === candidate) continue;
    try {
      const parsed = JSON.parse(repaired);
      if (isRecord(parsed)) return parsed;
    } catch {
      // not trivially repairable
    }
  }
  return null;
}

function parseEnrichment(text: unknown): { ok: true; value: JsonObject } | { ok: false; reason: string } {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, reason: 'llm response was empty' };
  }
  const parsed = tryObject(text);
  if (!parsed) return { ok: false, reason: 'llm response was not a parsable JSON object' };
  return { ok: true, value: parsed };
}

// ── merge: app copy ────────────────────────────────────────────────────────

function isGenericCopy(value: unknown, name: unknown): boolean {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!text) return true;
  const appName = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (appName && text === appName) return true;
  return /\bapp\b/.test(text) || /\bapplication\b/.test(text);
}

function mergeAppCopy(spec: AppSpec, proposed: unknown, notes: string[]): boolean {
  if (!isRecord(proposed)) return false;
  let changed = false;
  const tagline = cleanText(proposed.tagline, 200);
  if (tagline && tagline !== spec.app.tagline && isGenericCopy(spec.app.tagline, spec.app.name)) {
    spec.app.tagline = tagline;
    notes.push('refined tagline');
    changed = true;
  }
  const description = cleanText(proposed.description, 600);
  if (description && description !== spec.app.description && isGenericCopy(spec.app.description, spec.app.name)) {
    spec.app.description = description;
    notes.push('refined description');
    changed = true;
  }
  return changed;
}

function noteImmutableAttempts(base: AppSpec, proposed: JsonObject, notes: string[]): void {
  const app = isRecord(proposed.app) ? proposed.app : null;
  if (app) {
    if (asString(app.name)?.trim() && app.name !== base.app.name) notes.push('ignored app.name change (immutable)');
    if (asString(app.packageName)?.trim() && app.packageName !== base.app.packageName) {
      notes.push('ignored app.packageName change (immutable)');
    }
    if (asString(app.domain)?.trim() && app.domain !== base.app.domain) notes.push('ignored app.domain change (immutable)');
  }
  const design = isRecord(proposed.design) ? proposed.design : null;
  const seedColor = design ? asString(design.seedColor) : undefined;
  if (seedColor && seedColor !== base.design.seedColor) notes.push('ignored design.seedColor change (immutable)');
  if (proposed.backend !== undefined && proposed.backend !== base.backend) notes.push('ignored backend change (immutable)');
  if (proposed.seedCount !== undefined && proposed.seedCount !== base.seedCount) {
    notes.push('ignored seedCount change (immutable)');
  }
}

// ── merge: entities and fields ─────────────────────────────────────────────

function sanitizeField(
  raw: unknown,
  entityName: string,
  allowedTargets: Set<string>,
  notes: string[],
): FieldSpec | null {
  if (!isRecord(raw)) return null;
  const rawName = asString(raw.name) ?? '';
  const name = safeFieldName(rawName);
  if (!name) {
    notes.push(`rejected field ${entityName}.${rawName || '(missing)'}: invalid name`);
    return null;
  }

  const rawType = asString(raw.type);
  let type: FieldType | null = FIELD_TYPES.includes(rawType as FieldType) ? (rawType as FieldType) : null;
  if (!type) {
    if (Array.isArray(raw.values)) type = 'enum';
    else if (asString(raw.target)) type = 'relation';
    else {
      notes.push(`rejected field ${entityName}.${name}: unknown type ${String(raw.type ?? '(missing)')}`);
      return null;
    }
  }

  if (type === 'enum') {
    const values = dedupeStrings(
      (Array.isArray(raw.values) ? raw.values : [])
        .map((value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''))
        .filter(Boolean),
    );
    if (values.length === 0) {
      notes.push(`rejected field ${entityName}.${name}: enum needs values`);
      return null;
    }
    const field: FieldSpec = { name, type, required: raw.required === true, values };
    const label = cleanText(raw.label, 60);
    if (label) field.label = label;
    if (raw.primary === true) field.primary = true;
    return field;
  }

  if (type === 'relation') {
    const rawTarget = asString(raw.target) ?? '';
    const target = pascal(rawTarget);
    if (!target || !allowedTargets.has(target)) {
      notes.push(`rejected field ${entityName}.${name}: unknown relation target ${rawTarget || '(missing)'}`);
      return null;
    }
    const field: FieldSpec = { name, type, required: raw.required === true, target };
    const label = cleanText(raw.label, 60);
    if (label) field.label = label;
    if (raw.primary === true) field.primary = true;
    return field;
  }

  const field: FieldSpec = { name, type, required: raw.required === true };
  const label = cleanText(raw.label, 60);
  if (label) field.label = label;
  if (raw.primary === true) field.primary = true;
  return field;
}

function sanitizeFields(
  rawFields: unknown,
  entityName: string,
  allowedTargets: Set<string>,
  notes: string[],
): FieldSpec[] {
  if (!Array.isArray(rawFields)) return [];
  const out: FieldSpec[] = [];
  const seen = new Set<string>();
  for (const raw of rawFields) {
    const field = sanitizeField(raw, entityName, allowedTargets, notes);
    if (!field) continue;
    if (seen.has(field.name)) continue;
    seen.add(field.name);
    out.push(field);
  }
  return out.slice(0, MAX_ENTITY_FIELD_COUNT);
}

interface EntityCandidate {
  entity: EntitySpec;
  fields: FieldSpec[];
}

interface FieldRefinement {
  entity: EntitySpec;
  fields: FieldSpec[];
}

function appendFields(refinement: FieldRefinement, notes: string[]): boolean {
  if (refinement.fields.length === 0) return false;
  const existing = new Set(refinement.entity.fields.map((field) => camel(field.name)));
  const added: FieldSpec[] = [];
  for (const field of refinement.fields) {
    if (existing.has(field.name)) continue;
    if (refinement.entity.fields.some((candidate) => candidate.primary) && field.primary) field.primary = false;
    existing.add(field.name);
    refinement.entity.fields.push(field);
    added.push(field);
  }
  if (added.length === 0) return false;
  enforcePrimary(refinement.entity);
  notes.push(`added fields to ${pascal(refinement.entity.name)}: ${summarizeFieldNames(added)}`);
  return true;
}

function mergeEntities(
  spec: AppSpec,
  proposedEntities: unknown,
  limits: MergeLimits,
  notes: string[],
): boolean {
  const baseEntities = new Map<string, EntitySpec>();
  for (const entity of spec.entities) baseEntities.set(pascal(entity.name), entity);

  const candidateNames = new Set<string>();
  const skeletons: Array<{ entity: EntitySpec; raw: JsonObject }> = [];
  const pluralSeen = new Set(spec.entities.map((entity) => snake(entity.plural)).filter(Boolean));
  const list = Array.isArray(proposedEntities) ? proposedEntities : [];

  // Pass 1: classify proposals into refinements and new-entity skeletons.
  for (const raw of list) {
    if (!isRecord(raw)) {
      notes.push('rejected entity: proposal is not an object');
      continue;
    }
    const name = pascal(asString(raw.name) ?? '');
    if (!name) {
      notes.push('rejected entity: missing name');
      continue;
    }
    if (baseEntities.has(name)) continue;
    if (name.length > 60) {
      notes.push(`rejected entity ${name.slice(0, 40)}…: name is too long`);
      continue;
    }
    if (candidateNames.has(name)) {
      notes.push(`rejected entity ${name}: duplicate name`);
      continue;
    }
    const rawPlural = asString(raw.plural);
    const plural = rawPlural ? snake(rawPlural) : snake(pluralize(name));
    if (!validSnakeId(plural)) {
      notes.push(`rejected entity ${name}: invalid plural ${plural || '(empty)'}`);
      continue;
    }
    if (pluralSeen.has(plural)) {
      notes.push(`rejected entity ${name}: duplicate plural ${plural}`);
      continue;
    }
    const description = cleanText(raw.description, 400) ?? `${name} records tracked by the app.`;
    candidateNames.add(name);
    pluralSeen.add(plural);
    skeletons.push({ entity: { name, plural, description, fields: [] }, raw });
  }

  const tentativeTargets = new Set([...baseEntities.keys(), ...candidateNames]);

  // Pass 2: sanitize fields. Relation targets may point at any accepted skeleton.
  const refinements: FieldRefinement[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const name = pascal(asString(raw.name) ?? '');
    const entity = baseEntities.get(name);
    if (!entity) continue;
    const fields = sanitizeFields(raw.fields, entity.name, tentativeTargets, notes);
    if (fields.length > 0) refinements.push({ entity, fields });
  }

  const candidates: EntityCandidate[] = [];
  for (const skeleton of skeletons) {
    const fields = sanitizeFields(skeleton.raw.fields, skeleton.entity.name, tentativeTargets, notes);
    if (fields.length === 0) {
      notes.push(`rejected entity ${skeleton.entity.name}: no valid fields`);
      continue;
    }
    skeleton.entity.fields = fields;
    candidates.push({ entity: skeleton.entity, fields });
  }

  // Apply the hard cap only to entities that already have salvageable fields,
  // so invalid proposals never consume a slot.
  if (candidates.length > limits.maxEntities) {
    for (const extra of candidates.slice(limits.maxEntities)) {
      notes.push(`rejected entity ${extra.entity.name}: entity cap reached (${limits.maxEntities})`);
    }
    candidates.length = limits.maxEntities;
  }

  // Fixed point: every relation must point at an entity that survived.
  let stable = false;
  while (!stable) {
    stable = true;
    const allowed = new Set([...baseEntities.keys(), ...candidates.map((candidate) => candidate.entity.name)]);
    for (let index = candidates.length - 1; index >= 0; index--) {
      const candidate = candidates[index];
      const kept: FieldSpec[] = [];
      for (const field of candidate.fields) {
        const target = field.type === 'relation' ? pascal(field.target ?? '') : '';
        if (field.type === 'relation' && !allowed.has(target)) {
          notes.push(`rejected field ${candidate.entity.name}.${field.name}: unknown relation target ${field.target ?? '(missing)'}`);
          stable = false;
          continue;
        }
        if (field.type === 'relation') field.target = target;
        kept.push(field);
      }
      candidate.fields = kept;
      candidate.entity.fields = kept;
      if (kept.length === 0) {
        candidates.splice(index, 1);
        notes.push(`rejected entity ${candidate.entity.name}: no fields survive relation checks`);
        stable = false;
      }
    }
    for (const refinement of refinements) {
      const kept: FieldSpec[] = [];
      for (const field of refinement.fields) {
        const target = field.type === 'relation' ? pascal(field.target ?? '') : '';
        if (field.type === 'relation' && !allowed.has(target)) {
          notes.push(`rejected field ${refinement.entity.name}.${field.name}: unknown relation target ${field.target ?? '(missing)'}`);
          stable = false;
          continue;
        }
        if (field.type === 'relation') field.target = target;
        kept.push(field);
      }
      refinement.fields = kept;
    }
  }

  let changed = false;
  for (const refinement of refinements) {
    if (appendFields(refinement, notes)) changed = true;
  }
  for (const candidate of candidates) {
    enforcePrimary(candidate.entity);
    spec.entities.push(candidate.entity);
    notes.push(`added entity ${candidate.entity.name}`);
    changed = true;
  }
  return changed;
}

// ── merge: screens ─────────────────────────────────────────────────────────

const ENTITY_SCREEN_KINDS: readonly ScreenKind[] = ['list', 'detail', 'form'];

function sanitizeIcon(raw: unknown): string | undefined {
  const icon = snake(asString(raw) ?? '');
  return /^[a-z][a-z0-9_]*$/.test(icon) ? icon : undefined;
}

function mergeScreens(
  spec: AppSpec,
  proposedScreens: unknown,
  maxScreens: number,
  notes: string[],
): boolean {
  const list = Array.isArray(proposedScreens) ? proposedScreens : [];
  const ids = new Set(spec.screens.map((screen) => snake(screen.id)));
  const routes = new Set(spec.screens.map((screen) => normalizeRoute(routeOf(screen))));
  let added = 0;
  let changed = false;

  for (const raw of list) {
    if (!isRecord(raw)) {
      notes.push('rejected screen: proposal is not an object');
      continue;
    }
    const id = snake(asString(raw.id) ?? '');
    if (!id) {
      notes.push('rejected screen: missing id');
      continue;
    }
    const existing = spec.screens.find((screen) => snake(screen.id) === id);
    if (existing) {
      const proposedRoute = normalizeRoute(asString(raw.route) ?? '');
      const proposedKind = asString(raw.kind);
      if (
        (proposedRoute && proposedRoute !== normalizeRoute(routeOf(existing))) ||
        (proposedKind && proposedKind !== existing.kind)
      ) {
        notes.push(`ignored screen ${id}: existing screens are immutable`);
      }
      continue;
    }
    if (ids.has(id)) {
      notes.push(`rejected screen ${id}: duplicate id`);
      continue;
    }

    const kind = String(raw.kind ?? '') as ScreenKind;
    if (!SCREEN_KINDS.includes(kind)) {
      notes.push(`rejected screen ${id}: unknown kind ${String(raw.kind ?? '(missing)')}`);
      continue;
    }
    const title = cleanText(raw.title, 80);
    if (!title) {
      notes.push(`rejected screen ${id}: missing title`);
      continue;
    }
    const purpose = cleanText(raw.purpose, 240);
    if (!purpose) {
      notes.push(`rejected screen ${id}: missing purpose`);
      continue;
    }
    const rawRoute = asString(raw.route) ?? '';
    if (!rawRoute.trim()) {
      notes.push(`rejected screen ${id}: missing route`);
      continue;
    }
    if (/[\s?#]/.test(rawRoute)) {
      notes.push(`rejected screen ${id}: invalid route ${rawRoute}`);
      continue;
    }
    const route = normalizeRoute(rawRoute);
    if (!/^\/[A-Za-z0-9_\-/:.]*$/.test(route)) {
      notes.push(`rejected screen ${id}: invalid route ${rawRoute}`);
      continue;
    }
    if (routes.has(route)) {
      notes.push(`rejected screen ${id}: duplicate route ${route}`);
      continue;
    }

    let entity: string | undefined;
    const rawEntity = asString(raw.entity);
    if (rawEntity !== undefined && rawEntity.trim()) {
      const canonical = canonicalEntityName(spec.entities, rawEntity);
      if (!canonical) {
        notes.push(`rejected screen ${id}: unknown entity ${rawEntity}`);
        continue;
      }
      entity = canonical;
    }
    if (!entity && ENTITY_SCREEN_KINDS.includes(kind)) {
      notes.push(`rejected screen ${id}: ${kind} screen requires an entity`);
      continue;
    }
    if ((kind === 'detail' || kind === 'form') && !route.includes(':id')) {
      notes.push(`rejected screen ${id}: ${kind} route ${route} is missing :id`);
      continue;
    }
    if (added >= maxScreens) {
      notes.push(`rejected screen ${id}: screen cap reached (${maxScreens})`);
      continue;
    }

    const screen: ScreenSpec = { id, title, route, kind, purpose };
    if (entity) screen.entity = entity;
    const primaryAction = cleanText(raw.primaryAction, 60);
    if (primaryAction) screen.primaryAction = primaryAction;
    if (typeof raw.inNavigation === 'boolean') screen.inNavigation = raw.inNavigation;
    const icon = sanitizeIcon(raw.icon);
    if (icon) screen.icon = icon;

    spec.screens.push(screen);
    ids.add(id);
    routes.add(route);
    added++;
    changed = true;
    notes.push(`added screen ${id}`);
  }
  return changed;
}

// ── merge: flows and requirements ──────────────────────────────────────────

function mergeFlows(spec: AppSpec, proposedFlows: unknown, notes: string[]): boolean {
  const list = Array.isArray(proposedFlows) ? proposedFlows : [];
  const flowIds = new Set(spec.flows.map((flow) => snake(flow.id)));
  const screenIds = new Set(spec.screens.map((screen) => screen.id));
  let changed = false;

  for (const raw of list) {
    if (!isRecord(raw)) {
      notes.push('rejected flow: proposal is not an object');
      continue;
    }
    const id = snake(asString(raw.id) ?? '');
    if (!id) {
      notes.push('rejected flow: missing id');
      continue;
    }
    if (flowIds.has(id)) {
      notes.push(`rejected flow ${id}: duplicate id`);
      continue;
    }
    const name = cleanText(raw.name, 100) ?? id.replace(/_/g, ' ');
    const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
    const steps: FlowStep[] = [];
    for (const rawStep of rawSteps) {
      if (!isRecord(rawStep)) continue;
      const screenId = asString(rawStep.screenId)?.trim() ?? '';
      if (!screenId || !screenIds.has(screenId)) {
        notes.push(`rejected flow ${id} step: unknown screen ${screenId || '(missing)'}`);
        continue;
      }
      const action = cleanText(rawStep.action, 80) ?? 'Open';
      steps.push({ screenId, action });
    }
    if (steps.length === 0) {
      notes.push(`rejected flow ${id}: no valid steps`);
      continue;
    }
    const flow: FlowSpec = { id, name, steps };
    spec.flows.push(flow);
    flowIds.add(id);
    changed = true;
    notes.push(`added flow ${id}`);
  }
  return changed;
}

function mergeRequirements(spec: AppSpec, proposedRequirements: unknown, notes: string[]): boolean {
  const list = Array.isArray(proposedRequirements) ? proposedRequirements : [];
  const ids = new Set(spec.requirements.map((requirement) => snake(requirement.id)));
  let added = 0;

  for (const raw of list) {
    if (!isRecord(raw)) {
      notes.push('rejected requirement: proposal is not an object');
      continue;
    }
    const id = snake(asString(raw.id) ?? '');
    if (!id) {
      notes.push('rejected requirement: missing id');
      continue;
    }
    if (ids.has(id)) {
      notes.push(`rejected requirement ${id}: duplicate id`);
      continue;
    }
    const statement = cleanText(raw.statement, 400);
    if (!statement) {
      notes.push(`rejected requirement ${id}: missing statement`);
      continue;
    }
    const categoryRaw = asString(raw.category) ?? '';
    if (!REQUIREMENT_CATEGORIES.includes(categoryRaw as RequirementCategory)) {
      notes.push(`rejected requirement ${id}: unknown category ${categoryRaw || '(missing)'}`);
      continue;
    }
    const verifiedBy = cleanText(raw.verifiedBy, 60);
    if (!verifiedBy) {
      notes.push(`rejected requirement ${id}: missing verifiedBy`);
      continue;
    }
    const requirement: RequirementSpec = {
      id,
      statement,
      category: categoryRaw as RequirementCategory,
      verifiedBy,
    };
    spec.requirements.push(requirement);
    ids.add(id);
    added++;
  }
  if (added > 0) notes.push(`added requirements: ${added}`);
  return added > 0;
}

// ── orchestration ──────────────────────────────────────────────────────────

async function callLlm(llm: LlmComplete, request: LlmCompletionRequest, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`llm timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const result = await Promise.race([llm(request), timeout]);
    if (!result || typeof result.text !== 'string') throw new Error('llm returned no text');
    return result.text;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mergeEnrichment(
  base: AppSpec,
  proposed: JsonObject,
  limits: MergeLimits,
  notes: string[],
): { spec: AppSpec; changed: boolean } {
  const spec = cloneSpec(base);
  let changed = false;

  if (mergeAppCopy(spec, proposed.app, notes)) changed = true;
  noteImmutableAttempts(base, proposed, notes);
  if (mergeEntities(spec, proposed.entities, limits, notes)) changed = true;
  if (mergeScreens(spec, proposed.screens, limits.maxScreens, notes)) changed = true;
  if (mergeFlows(spec, proposed.flows, notes)) changed = true;
  if (mergeRequirements(spec, proposed.requirements, notes)) changed = true;

  // Global invariant: one primary per entity. Only normalize when the LLM
  // actually contributed, so a no-op response leaves the base byte-identical.
  if (changed) {
    for (const entity of spec.entities) enforcePrimary(entity);
  }

  return { spec, changed };
}

/**
 * Enrich a compiled spec with an LLM, then merge deterministically under hard
 * additive-only rules. Never throws: every failure returns the base spec.
 */
export async function enrichSpec(
  base: AppSpec,
  llm: LlmComplete,
  options: EnrichOptions = {},
): Promise<EnrichResult> {
  try {
    if (!isAppSpecLike(base)) {
      return { spec: base, enriched: false, notes: ['base spec is not a valid AppSpec object'] };
    }
    if (typeof llm !== 'function') {
      return { spec: base, enriched: false, notes: ['llm is not callable'] };
    }

    const limits: MergeLimits = {
      maxEntities: clampCount(options.maxEntities, DEFAULT_MAX_ENTITIES),
      maxScreens: clampCount(options.maxScreens, DEFAULT_MAX_SCREENS),
    };
    const maxTokens = limitedNumber(options.maxTokens, DEFAULT_MAX_TOKENS, 1, 32_000);
    const temperature = limitedNumber(options.temperature, DEFAULT_TEMPERATURE, 0, 2);
    const timeoutMs = limitedNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 10 * 60_000);
    const notes: string[] = [];

    const prompt = buildPrompt(base, limits);
    if (prompt.truncated) {
      notes.push('prompt truncated to fit the 60000 character budget (result unaffected)');
    }

    const request: LlmCompletionRequest = {
      system: prompt.system,
      user: prompt.user,
      json: true,
      maxTokens,
      temperature,
      timeoutMs,
      label: 'generation.spec.enrich',
    };

    const text = await callLlm(llm, request, timeoutMs);
    const parsed = parseEnrichment(text);
    if (parsed.ok === false) return { spec: base, enriched: false, notes: [parsed.reason] };

    const merged = mergeEnrichment(base, parsed.value, limits, notes);
    const validation = validateSpec(merged.spec);
    if (!validation.ok) {
      const detail = validation.errors.slice(0, 4).join('; ');
      return { spec: base, enriched: false, notes: [cleanNote(`merge produced an invalid spec: ${detail}`)] };
    }
    if (!merged.changed && notes.length === 0) notes.push('no usable changes from llm');

    return { spec: merged.spec, enriched: merged.changed, notes: finalizeNotes(notes) };
  } catch (error) {
    return { spec: base, enriched: false, notes: [cleanNote(`enrichment failed: ${errorMessage(error)}`)] };
  }
}
