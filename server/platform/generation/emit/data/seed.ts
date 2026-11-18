/**
 * Deterministic seed emitter.
 *
 * Seed rows are what make a generated app feel real on first launch: they use
 * domain vocabulary instead of placeholders, keep ids stable across runs and
 * give DateTime fields believable timestamps. The same sample-value kernel is
 * exported for the generated Dart tests so fixtures and seeds cannot drift.
 */
import type { AppDomain, AppSpec, EntitySpec, FieldSpec, GeneratedFile } from '../../contracts.js';
import {
  dartString,
  entityClass,
  pascal,
  pluralize,
  primaryField,
  seedFile,
  seedId,
  snake,
} from '../shared.js';

export interface SampleContext {
  spec: AppSpec;
  entity: EntitySpec;
  index: number;
}

/**
 * One value rendered three ways:
 *  - `value`    Dart expression for the model constructor (DateTime stays a DateTime)
 *  - `json`     Dart expression for a `Map<String, Object?>` JSON fixture
 *  - `expected` Dart expression for an `expect()` assertion after decoding
 */
export interface SampleLiteral {
  value: string;
  json: string;
  expected: string;
}

// ── vocabulary ────────────────────────────────────────────────────────────

const PEOPLE = [
  { first: 'Avery', last: 'Chen' },
  { first: 'Jordan', last: 'Patel' },
  { first: 'Maya', last: 'Rodriguez' },
  { first: 'Noah', last: 'Williams' },
  { first: 'Priya', last: 'Nair' },
  { first: 'Elena', last: 'Fischer' },
  { first: 'Marcus', last: 'Lee' },
  { first: 'Sofia', last: 'Almeida' },
  { first: 'Theo', last: 'Grant' },
  { first: 'Nina', last: 'Kowalski' },
] as const;

const COMPANIES = [
  'Northwind Studio',
  'Juniper Labs',
  'Harbor & Pine',
  'Fieldwork Co.',
  'Brightline Works',
  'Copper Lane',
] as const;

const ROLES = [
  'Product designer',
  'Staff engineer',
  'Operations lead',
  'Research analyst',
  'Community manager',
  'Finance partner',
] as const;

const LOCATIONS = [
  'Portland, OR',
  'Lisbon, Portugal',
  'Kyoto, Japan',
  'Copenhagen, Denmark',
  'Austin, TX',
  'Vancouver, BC',
  'Barcelona, Spain',
  'Reykjavik, Iceland',
] as const;

const COUNTRIES = ['United States', 'Portugal', 'Japan', 'Denmark', 'Canada', 'Spain', 'Iceland'] as const;

const ADDRESSES = [
  '12 Harbour Street, Portland, OR 97209',
  '48 Rua da Boavista, 1200-067 Lisbon',
  '301 Nakagyo Ward, Kyoto 604-8004',
  '7 Vesterbrogade, 1620 Copenhagen',
  '2201 South Congress Ave, Austin, TX 78704',
  '18 Powell Street, Vancouver, BC V6A 1B2',
] as const;

const STATUSES = ['active', 'in progress', 'paused', 'completed', 'archived'] as const;

const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY'] as const;

const COLORS = ['#2F6F5F', '#C46A3A', '#4A5FA5', '#8C6A3F', '#A33E4B', '#3A7D8C'] as const;

const REVIEWS = [
  'Clear and easy to follow, with the right amount of detail.',
  'A solid first pass; one open question remains for the next review.',
  'Worth revisiting after the next release.',
  'The shorter version lands better with new teammates.',
  'Good structure, but the middle section can be tighter.',
] as const;

const INGREDIENTS = [
  'olive oil',
  'sea salt',
  'lemon',
  'garlic',
  'chickpeas',
  'tomatoes',
  'brown rice',
  'spinach',
  'almonds',
  'yogurt',
] as const;

const GENERIC_STEPS = [
  'Collect the source material',
  'Draft the first pass',
  'Review with a teammate',
  'Refine the weak spots',
  'Ship and note what to improve',
] as const;

const FEATURES = [
  'Works offline',
  'Exports to PDF',
  'Keyboard shortcuts',
  'Shared workspaces',
  'Dark mode',
  'Weekly digest',
] as const;

const DOMAIN_TITLES: Record<AppDomain, readonly string[]> = {
  productivity: [
    'Quarterly planning review',
    'Inbox zero sweep',
    'Design sprint retrospective',
    'Roadmap checkpoint',
    'Weekly focus session',
  ],
  commerce: [
    'Stoneware pour-over set',
    'Linen apron',
    'Walnut desk tray',
    'Canvas tote bag',
    'Glass storage jars',
  ],
  social: [
    'Weekend photo walk',
    'Community meetup',
    'Sunday supper club',
    'Neighborhood clean-up',
    'Book club gathering',
  ],
  finance: [
    'Monthly budget review',
    'Emergency fund transfer',
    'Index fund rebalance',
    'Subscription audit',
    'Quarterly tax check',
  ],
  health: [
    'Morning mobility routine',
    'Strength session A',
    'Meal prep Sunday',
    'Evening wind-down',
    'Weekend trail run',
  ],
  education: [
    'Chapter 4: cellular respiration',
    'Linear algebra problem set',
    'History essay outline',
    'Flashcards: irregular verbs',
    'Lab report draft',
  ],
  travel: [
    'Kyoto temple walk',
    'Coastal train route',
    'Old town food tour',
    'Museum morning',
    'Sunset harbor cruise',
  ],
  media: [
    'Album of the week',
    'Directors cut notes',
    'Photo essay draft',
    'Season finale recap',
    'Sound design pass',
  ],
  developer: [
    'Fix flaky CI pipeline',
    'Cache invalidation design',
    'API pagination cleanup',
    'Release 2.4 checklist',
    'Dependency upgrade pass',
  ],
  custom: [
    'First workspace entry',
    'Planning session',
    'Follow-up review',
    'Weekly checkpoint',
    'Reference notes',
  ],
};

const DOMAIN_DESCRIPTIONS: Record<AppDomain, readonly string[]> = {
  productivity: [
    'Breaks the work into two focused sessions with a short retrospective at the end.',
    'Captures the decisions, open questions and the next concrete step.',
    'Keeps the weekly rhythm visible without adding another meeting.',
    'A small, finishable slice that unblocks the rest of the plan.',
  ],
  commerce: [
    'Small-batch stoneware with a matte glaze and a comfortable balance in the hand.',
    'Built from heavyweight natural fibre and finished with reinforced seams.',
    'Designed to stack neatly and look good on an open shelf.',
    'Packaging is recyclable and the supplier ships within two days.',
  ],
  social: [
    'A low-key gathering for neighbours who want to compare notes and make plans.',
    'Photos, quotes and loose thoughts collected while the day was still fresh.',
    'A short recap of who came, what changed and what happens next.',
    'Open to everyone; bring something to share and a story from the week.',
  ],
  finance: [
    'Moves the monthly surplus into savings before everyday spending begins.',
    'Tracks the recurring charges that are easy to forget between statements.',
    'A calm review of what came in, what went out and what is left.',
    'Keeps a three-month buffer and reviews the allocation each quarter.',
  ],
  health: [
    'A short session that prioritises form, breathing and steady progress.',
    'Prepares the week ahead with simple ingredients and clear portions.',
    'Low impact, repeatable and easy to fit around a busy day.',
    'Warms up thoroughly, then adds one small progression over last week.',
  ],
  education: [
    'Summarises the core idea, one worked example and three practice questions.',
    'Links the reading to the previous week with a short concept map.',
    'A study block with spaced repetition built in.',
    'Marks the tricky definitions and leaves room for a second pass.',
  ],
  travel: [
    'A walkable route with two coffee stops and time for photos.',
    'Reserved seats, a late check-out and a backup plan for rain.',
    'Notes on transport, timings and the places worth returning to.',
    'Packs light, stays central and leaves one afternoon unscheduled.',
  ],
  media: [
    'A tight edit that keeps the strongest moment and cuts the rest.',
    'References, colour notes and the feeling the piece should leave behind.',
    'A listening pass for balance, pacing and clarity.',
    'Keeps the through-line simple and lets the details carry the texture.',
  ],
  developer: [
    'Documents the failure mode, the fix and the guardrail that prevents a repeat.',
    'A small, reversible change with tests around the risky edge cases.',
    'Profiles the slow path first, then removes the unnecessary work.',
    'Ships behind a flag and rolls out to ten percent of traffic first.',
  ],
  custom: [
    'A clear description with enough context to act on later.',
    'Notes the current state, the open question and the next step.',
    'Keeps the important detail close without extra ceremony.',
    'A useful reference for the next person who picks this up.',
  ],
};

const DOMAIN_TAGS: Record<AppDomain, readonly string[]> = {
  productivity: ['planning', 'deep-work', 'review', 'admin', 'follow-up'],
  commerce: ['new', 'best-seller', 'limited', 'restock', 'gift'],
  social: ['community', 'weekend', 'outdoors', 'food', 'creative'],
  finance: ['savings', 'monthly', 'essential', 'review', 'tax'],
  health: ['mobility', 'strength', 'nutrition', 'recovery', 'routine'],
  education: ['reading', 'practice', 'notes', 'exam-prep', 'research'],
  travel: ['walkable', 'food', 'culture', 'budget', 'weekend'],
  media: ['draft', 'edit', 'reference', 'playlist', 'archive'],
  developer: ['bug', 'infra', 'release', 'testing', 'refactor'],
  custom: ['general', 'reference', 'follow-up', 'archive'],
};

const DOMAIN_CATEGORIES: Record<AppDomain, readonly string[]> = {
  productivity: ['Planning', 'Design', 'Research', 'Operations', 'Admin'],
  commerce: ['Home', 'Kitchen', 'Apparel', 'Outdoors', 'Gifts'],
  social: ['Meetup', 'Workshop', 'Outdoors', 'Food', 'Creative'],
  finance: ['Housing', 'Food', 'Transport', 'Savings', 'Leisure'],
  health: ['Strength', 'Mobility', 'Nutrition', 'Recovery', 'Endurance'],
  education: ['Science', 'Mathematics', 'History', 'Languages', 'Writing'],
  travel: ['City', 'Coast', 'Museums', 'Food', 'Nature'],
  media: ['Music', 'Film', 'Photography', 'Writing', 'Podcast'],
  developer: ['Bug', 'Feature', 'Infrastructure', 'Docs', 'Release'],
  custom: ['General', 'Planning', 'Reference', 'Archive'],
};

interface EntityTitlePools {
  [key: string]: readonly string[];
}

const ENTITY_TITLES: EntityTitlePools = {
  task: ['Draft sprint goals', 'Review onboarding flow', 'Ship accessibility fixes', 'Plan customer interviews', 'Tidy the design backlog'],
  note: ['Kickoff decisions', 'Customer call highlights', 'Launch retrospective', 'Reading list for Q3', 'Architecture trade-offs'],
  journal_entry: ['A clear Monday', 'On finishing things', 'Notes from the train', 'Small wins this week', 'The case for slower mornings'],
  project: ['Harbor redesign', 'Mobile beta', 'Billing migration', 'Growth experiments', 'Design system refresh'],
  habit: ['Morning stretch', 'Read twenty pages', 'Walk after lunch', 'Journal before bed', 'Weekly review'],
  goal: ['Run a half marathon', 'Ship the portfolio', 'Save for a sabbatical', 'Learn conversational Spanish', 'Publish six essays'],
  product: ['Stoneware mug', 'Linen tea towel', 'Oak cutting board', 'Canvas weekender', 'Brass desk lamp'],
  order: ['Order 1042', 'Order 1043', 'Order 1044', 'Order 1045', 'Order 1046'],
  invoice: ['Invoice 2026-014', 'Invoice 2026-015', 'Invoice 2026-016', 'Invoice 2026-017', 'Invoice 2026-018'],
  transaction: ['Grocery run', 'Monthly rent', 'Coffee subscription', 'Train fare', 'Bookshop purchase'],
  expense: ['Team lunch', 'Train ticket', 'Software subscription', 'Studio supplies', 'Client coffee'],
  budget: ['Groceries', 'Transport', 'Home office', 'Travel', 'Entertainment'],
  workout: ['Upper body strength', 'Tempo run', 'Mobility reset', 'Long ride', 'Core circuit'],
  meal: ['Miso salmon bowl', 'Lemon chickpea stew', 'Roasted tomato pasta', 'Overnight oats', 'Charred broccoli bowl'],
  recipe: ['Roasted tomato pasta', 'Miso butter salmon', 'Lemon chickpea stew', 'Overnight oats', 'Charred broccoli bowl'],
  course: ['Foundations of Statistics', 'Modern JavaScript', 'Plant Biology', 'World History Since 1900', 'Design Systems'],
  lesson: ['Variables and types', 'Cell structure', 'The Industrial Revolution', 'Chord progressions', 'Color and contrast'],
  book: ['The Overstory', 'Thinking in Systems', 'Piranesi', 'A Brief History of Time', 'The Art of Noticing'],
  trip: ['Lisbon long weekend', 'Kyoto in autumn', 'Pacific coast road trip', 'Copenhagen design week', 'Reykjavik in winter'],
  booking: ['Window seat to Seattle', 'Hotel near the Duomo', 'Studio for two nights', 'Table for four', 'Cabin by the lake'],
  post: ['A slower morning', 'Three lessons from shipping weekly', 'Notes from the coast', 'What I read in October', 'A small kitchen upgrade'],
  article: ['The quiet economics of repair', 'How teams make decisions', 'A field guide to deep work', 'Why small tools last', 'The case for walking meetings'],
  event: ['Design systems meetup', 'Founders breakfast', 'Spring gallery opening', 'Community potluck', 'Weekend workshop'],
  ticket: ['General admission: Friday', 'Balcony seat', 'Workshop pass', 'Weekend day pass', 'Members preview'],
  playlist: ['Deep focus', 'Sunday slow', 'Morning run', 'Late night coding', 'Kitchen radio'],
  track: ['Golden Hour', 'Northbound', 'Paper Planes', 'Slow Current', 'First Light'],
  movie: ['The Quiet Coast', 'Midnight Transit', 'Aperture', 'Second Summer', 'A Room of One Year'],
  message: ['Kickoff update', 'Schedule change', 'Quick question', 'Notes from the call', 'Follow-up on the brief'],
  category: ['Planning', 'Design', 'Research', 'Operations', 'Admin'],
  tag: ['focus', 'research', 'priority', 'later', 'reference'],
  company: COMPANIES,
  organization: COMPANIES,
  ingredient: INGREDIENTS,
  team: ['Platform', 'Design', 'Growth', 'Operations', 'Customer success'],
};

const PERSON_ENTITIES = new Set([
  'contact',
  'customer',
  'client',
  'member',
  'guest',
  'employee',
  'patient',
  'student',
  'author',
  'attendee',
  'person',
  'user',
  'lead',
  'speaker',
  'host',
  'traveler',
  'traveller',
  'player',
]);

// ── sampling kernel ───────────────────────────────────────────────────────

function pick<T>(values: readonly T[], index: number): T {
  return values[((index % values.length) + values.length) % values.length];
}

function take(values: readonly string[], start: number, count: number): string[] {
  return Array.from({ length: Math.min(count, values.length) }, (_, offset) => values[(start + offset) % values.length]);
}

function slug(text: string): string {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'entry'
  );
}

function titlePool(ctx: SampleContext): readonly string[] {
  const domain = ctx.spec.app?.domain ?? 'custom';
  return ENTITY_TITLES[snake(ctx.entity.name)] ?? DOMAIN_TITLES[domain] ?? DOMAIN_TITLES.custom;
}

function domainOf(ctx: SampleContext): AppDomain {
  const domain = ctx.spec.app?.domain;
  return domain && DOMAIN_TITLES[domain] ? domain : 'custom';
}

function personAt(index: number): { first: string; last: string } {
  return pick(PEOPLE, index);
}

function sampleString(field: FieldSpec, ctx: SampleContext): string {
  const key = field.name.toLowerCase();
  const entityKey = snake(ctx.entity.name);
  const domain = domainOf(ctx);
  const person = personAt(ctx.index);
  const titles = titlePool(ctx);
  const isPerson = PERSON_ENTITIES.has(entityKey);
  const primary = primaryField(ctx.entity);
  const isPrimary = primary?.name === field.name;

  if (/(email|e-mail)/.test(key)) {
    return `${person.first.toLowerCase()}.${person.last.toLowerCase()}@example.com`;
  }
  if (/(phone|mobile|tel)/.test(key)) {
    return `+1 (415) 555-${String(100 + ctx.index).padStart(4, '0')}`;
  }
  if (/(url|website|link|homepage|permalink)/.test(key)) {
    return `https://example.com/${entityKey}/${slug(pick(titles, ctx.index))}`;
  }
  if (/(address|street)/.test(key)) return pick(ADDRESSES, ctx.index);
  if (/(city|location|place|destination|venue|town)/.test(key)) return pick(LOCATIONS, ctx.index);
  if (/(country)/.test(key)) return pick(COUNTRIES, ctx.index);
  if (/(company|organization|organisation|employer|vendor|merchant|brand)/.test(key)) {
    return pick(COMPANIES, ctx.index);
  }
  if (/(author|owner|assignee|editor|organizer|organiser|host|speaker|manager|lead)/.test(key)) {
    return `${person.first} ${person.last}`;
  }
  if (/(role|position)/.test(key)) return pick(ROLES, ctx.index);
  if (isPerson && /(full_?name|display_?name|name|title|label)/.test(key)) {
    return `${person.first} ${person.last}`;
  }
  if (/(category|genre|kind|group|section|department|collection)/.test(key)) {
    return pick(DOMAIN_CATEGORIES[domain], ctx.index);
  }
  if (/(status|state|stage|phase)/.test(key)) return pick(STATUSES, ctx.index);
  if (/(priority|severity|urgency|importance)/.test(key)) return pick(PRIORITIES, ctx.index);
  if (/(currency)/.test(key)) return pick(CURRENCIES, ctx.index);
  if (/(color|colour|swatch)/.test(key)) return pick(COLORS, ctx.index);
  if (/(sku|code|reference|ref|isbn|number|plate|license|licence)/.test(key)) {
    return `${key.replace(/[^a-z]/g, '').slice(0, 3).toUpperCase()}-${1000 + ctx.index}`;
  }
  if (/(slug|handle|username)/.test(key)) return slug(pick(titles, ctx.index));
  if (/(tag)/.test(key)) return pick(DOMAIN_TAGS[domain], ctx.index);
  if (/(description|summary|notes?|content|body|detail|excerpt|bio|about|instructions?|prep|directions)/.test(key)) {
    return pick(DOMAIN_DESCRIPTIONS[domain], ctx.index);
  }
  if (/(comment|review|feedback|message|quote|memo)/.test(key)) return pick(REVIEWS, ctx.index);
  if (/(ingredient|component|material|supply)/.test(key)) return pick(INGREDIENTS, ctx.index);
  if (isPrimary) return pick(titles, ctx.index);
  if (/(title|name|label|headline|subject)/.test(key)) return pick(titles, ctx.index);
  return pick(titles, ctx.index + 1);
}

function sampleInt(field: FieldSpec, index: number): number {
  const key = field.name.toLowerCase();
  if (/(price|amount|cost|budget|total|fee|balance|salary|revenue|spend)/.test(key)) {
    return 45 + index * 17;
  }
  if (/(rating|score|stars)/.test(key)) return 3 + (index % 3);
  if (/(year)/.test(key)) return 2024 + (index % 3);
  if (/(age)/.test(key)) return 24 + index * 3;
  if (/(quantity|count|stock|servings|guests|seats|players|pages|minutes|duration|reps|sets|calories|points|level)/.test(key)) {
    return 1 + index;
  }
  return 1 + index;
}

function sampleDouble(field: FieldSpec, index: number): string {
  const key = field.name.toLowerCase();
  if (/(rating|score)/.test(key)) return (4.2 + (index % 5) * 0.1).toFixed(1);
  if (/(latitude|longitude|lat|lng)/.test(key)) return (37.77 + index * 0.01).toFixed(2);
  if (/(weight|distance|duration|hours)/.test(key)) return (1.5 + index * 0.75).toFixed(2);
  return (24.5 + index * 7.25).toFixed(2);
}

function sampleBool(field: FieldSpec, index: number): boolean {
  const key = field.name.toLowerCase();
  if (/(archived|deleted|draft)/.test(key)) return false;
  if (/(completed|done|finished|resolved|paid)/.test(key)) return index % 2 === 0;
  if (/(favorite|favourite|pinned|starred|featured)/.test(key)) return index % 2 === 0;
  return index % 2 === 0;
}

function sampleDateTime(field: FieldSpec, index: number): SampleLiteral {
  const key = field.name.toLowerCase();
  let date: Date;
  if (/created/.test(key)) {
    date = new Date(Date.UTC(2026, 0, 5 + index * 2, 9, 30, 0, 0));
  } else if (/(updated|modified)/.test(key)) {
    date = new Date(Date.UTC(2026, 0, 12 + index * 2, 16, 45, 0, 0));
  } else if (/(due|deadline)/.test(key)) {
    date = new Date(Date.UTC(2026, 1, 2 + index * 3, 17, 0, 0, 0));
  } else if (/(start|begin)/.test(key)) {
    date = new Date(Date.UTC(2026, 2, 2 + index * 7, 10, 0, 0, 0));
  } else if (/(end|finish|completed)/.test(key)) {
    date = new Date(Date.UTC(2026, 2, 2 + index * 7, 12, 30, 0, 0));
  } else if (/(birth)/.test(key)) {
    date = new Date(Date.UTC(1990 + (index % 8), (index * 2) % 12, 4 + (index % 20), 8, 0, 0, 0));
  } else {
    date = new Date(Date.UTC(2026, 3, 6 + index * 2, 14, 0, 0, 0));
  }
  const value = `DateTime.utc(${date.getUTCFullYear()}, ${date.getUTCMonth() + 1}, ${date.getUTCDate()}, ${date.getUTCHours()}, ${date.getUTCMinutes()})`;
  return { value, json: dartString(date.toISOString()), expected: value };
}

function sampleList(field: FieldSpec, ctx: SampleContext): string[] {
  const key = field.name.toLowerCase();
  const domain = domainOf(ctx);
  if (/(ingredient|component|material|supply)/.test(key)) {
    return take(INGREDIENTS, ctx.index, 3);
  }
  if (/(step|instruction|direction)/.test(key)) {
    return take(GENERIC_STEPS, ctx.index, 3);
  }
  if (/(feature|benefit|highlight)/.test(key)) {
    return take(FEATURES, ctx.index, 3);
  }
  return take(DOMAIN_TAGS[domain], ctx.index, 3);
}

function relationLiteral(field: FieldSpec, ctx: SampleContext): SampleLiteral {
  const targetName = field.target ? pascal(field.target) : '';
  const target = (ctx.spec.entities ?? []).find((candidate) => entityClass(candidate) === targetName);
  if (!target) {
    const value = dartString(`${snake(field.target ?? 'record')}_001`);
    return { value, json: value, expected: value };
  }
  const count = Number.isFinite(ctx.spec.seedCount) ? Math.max(0, Math.floor(ctx.spec.seedCount)) : 0;
  const limit = count > 0 ? count : 3;
  const value = dartString(seedId(target, ctx.index % limit));
  return { value, json: value, expected: value };
}

function literal(value: string): SampleLiteral {
  return { value, json: value, expected: value };
}

/** Deterministic value for a field, rendered for the seed row and Dart tests. */
export function sampleLiteral(field: FieldSpec, ctx: SampleContext): SampleLiteral {
  switch (field.type) {
    case 'int':
      return literal(String(sampleInt(field, ctx.index)));
    case 'double':
      return literal(sampleDouble(field, ctx.index));
    case 'bool':
      return literal(sampleBool(field, ctx.index) ? 'true' : 'false');
    case 'datetime':
      return sampleDateTime(field, ctx.index);
    case 'enum': {
      const values = field.values ?? [];
      return literal(dartString(values.length > 0 ? pick(values, ctx.index) : ''));
    }
    case 'stringList': {
      const values = sampleList(field, ctx);
      return literal(`<String>[${values.map(dartString).join(', ')}]`);
    }
    case 'relation':
      return relationLiteral(field, ctx);
    case 'text':
    case 'string':
    default:
      return literal(dartString(sampleString(field, ctx)));
  }
}

// ── emitter ───────────────────────────────────────────────────────────────

function seedRows(entity: EntitySpec, spec: AppSpec, count: number): string {
  const cls = entityClass(entity);
  const rows: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const lines: string[] = [`      id: ${dartString(seedId(entity, index))},`];
    for (const field of entity.fields) {
      const sample = sampleLiteral(field, { spec, entity, index });
      lines.push(`      ${field.name}: ${sample.value},`);
    }
    rows.push(`    ${cls}(\n${lines.join('\n')}\n    ),`);
  }
  return rows.join('\n');
}

/** `lib/data/seed/<entity>_seed.dart` with deterministic, domain-real rows. */
export function emitSeed(spec: AppSpec, entity: EntitySpec): GeneratedFile {
  const cls = entityClass(entity);
  const fn = `seed${pluralize(entity.name)}`;
  const count = Number.isFinite(spec.seedCount) ? Math.max(0, Math.floor(spec.seedCount)) : 0;
  const importLine = `import '../models/${snake(entity.name)}.dart';\n\n`;

  let body: string;
  if (count === 0) {
    body = `/// Deterministic sample data for [${cls}]. Empty by design: this app starts from\n/// its empty state.\nList<${cls}> ${fn}() => const <${cls}>[];\n`;
  } else {
    const rows = seedRows(entity, spec, count);
    const constList = entity.fields.some((field) => field.type === 'datetime') ? '' : 'const ';
    body = `/// Deterministic sample data for [${cls}].\nList<${cls}> ${fn}() {\n  return ${constList}<${cls}>[\n${rows}\n  ];\n}\n`;
  }

  return { path: seedFile(entity), content: `${importLine}${body}`, layer: 'data' };
}
