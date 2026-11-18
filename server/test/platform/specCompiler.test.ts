import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSpec, inferDomain } from '../../platform/generation/spec/index.js';
import { validateSpec } from '../../platform/generation/emit/shared.js';
import type { AppSpec, FieldSpec, ScreenSpec } from '../../platform/generation/contracts.js';

const VERIFIERS = new Set(['analyze', 'widget-test', 'score', 'structural']);
const NAME_RE = /^[A-Za-z][A-Za-z0-9 '&.-]{0,60}$/;
const PACKAGE_RE = /^[a-z][a-z0-9_]{1,39}$/;
const SCREEN_ID_RE = /^[a-z][a-z0-9_]*$/;

function primaryField(entity: { fields: FieldSpec[] }): FieldSpec | undefined {
  return entity.fields.find((field) => field.primary);
}

/** Invariants every compiled spec must hold, independent of the prompt. */
function assertWellFormed(spec: AppSpec, label: string): void {
  const result = validateSpec(spec);
  assert.equal(result.ok, true, `${label}: ${result.errors.join('; ')}`);

  assert.match(spec.app.name, NAME_RE, `${label}: app.name`);
  assert.match(spec.app.packageName, PACKAGE_RE, `${label}: packageName`);
  assert.ok(spec.app.packageName.length <= 40, `${label}: packageName <= 40`);
  assert.ok(spec.app.tagline.length >= 12, `${label}: tagline specific`);
  assert.ok(spec.app.description.length >= 40, `${label}: description specific`);
  assert.ok(spec.app.description.toLowerCase() !== 'lorem ipsum');

  assert.ok(spec.entities.length >= 1 && spec.entities.length <= 4, `${label}: 1-4 entities`);
  const entityNames = new Set(spec.entities.map((entity) => entity.name));
  for (const entity of spec.entities) {
    assert.ok(entity.fields.length >= 3 && entity.fields.length <= 8, `${label}: ${entity.name} fields 3-8`);
    assert.equal(entity.fields.filter((field) => field.primary).length, 1, `${label}: ${entity.name} one primary`);
    assert.ok(primaryField(entity), `${label}: ${entity.name} has a primary field`);
    assert.ok(!entity.fields.some((field) => field.name === 'id'), `${label}: ${entity.name} implicit id`);
    for (const field of entity.fields) {
      assert.ok(field.name && field.label, `${label}: ${entity.name} field labels`);
      if (field.type === 'enum') {
        assert.ok(Array.isArray(field.values) && field.values.length >= 2, `${label}: ${entity.name}.${field.name} enum values`);
      }
      if (field.type === 'relation') {
        assert.ok(field.target && entityNames.has(field.target), `${label}: ${entity.name}.${field.name} relation target`);
      }
    }
    if (entity.searchField) {
      assert.ok(entity.fields.some((field) => field.name === entity.searchField), `${label}: ${entity.name} searchField`);
    }
    if (entity.sortField) {
      assert.ok(entity.fields.some((field) => field.name === entity.sortField), `${label}: ${entity.name} sortField`);
    }
  }

  assert.ok(spec.screens.length >= 4 && spec.screens.length <= 7, `${label}: 4-7 screens`);
  const screenIds = new Set<string>();
  const routes = new Set<string>();
  for (const screen of spec.screens) {
    assert.match(screen.id, SCREEN_ID_RE, `${label}: screen id ${screen.id}`);
    assert.ok(!screenIds.has(screen.id), `${label}: duplicate screen id ${screen.id}`);
    screenIds.add(screen.id);
    assert.ok(screen.route.startsWith('/'), `${label}: route ${screen.route}`);
    assert.ok(!routes.has(screen.route), `${label}: duplicate route ${screen.route}`);
    routes.add(screen.route);
    assert.ok(screen.title.trim().length > 0, `${label}: screen title`);
    assert.ok(screen.purpose.trim().length > 12, `${label}: screen purpose specific`);
    assert.ok(screen.icon && /^[a-z][a-z0-9_]*$/.test(screen.icon), `${label}: icon`);
    if (screen.entity) {
      assert.ok(entityNames.has(screen.entity), `${label}: ${screen.id} unknown entity ${screen.entity}`);
    }
    if ((screen.kind === 'detail' || screen.kind === 'form') && screen.entity) {
      assert.ok(screen.route.includes(':'), `${label}: ${screen.id} needs :id`);
    }
  }
  const navCount = spec.screens.filter((screen) => screen.inNavigation).length;
  assert.ok(navCount >= 2 && navCount <= 4, `${label}: 2-4 nav screens (got ${navCount})`);

  assert.ok(spec.flows.length >= 2 && spec.flows.length <= 3, `${label}: 2-3 flows`);
  for (const flow of spec.flows) {
    assert.ok(flow.steps.length >= 2, `${label}: flow ${flow.id} steps`);
    for (const step of flow.steps) {
      assert.ok(screenIds.has(step.screenId), `${label}: flow ${flow.id} unknown screen ${step.screenId}`);
      assert.ok(step.action.trim().length > 0, `${label}: flow ${flow.id} action`);
    }
  }

  assert.equal(spec.design.brightness, 'system', `${label}: brightness`);
  assert.deepEqual(spec.design.spacing, [4, 8, 12, 16, 24, 32], `${label}: spacing scale`);
  assert.deepEqual(spec.design.radii, { sm: 8, md: 12, lg: 16, xl: 24 }, `${label}: radii`);
  assert.equal(spec.design.motionMs, 200, `${label}: motion`);
  assert.equal(spec.design.shape, 'rounded', `${label}: shape`);
  assert.match(spec.design.seedColor, /^#[0-9A-F]{6}$/, `${label}: seedColor`);

  assert.ok(spec.requirements.length >= 8 && spec.requirements.length <= 12, `${label}: 8-12 requirements`);
  const categories = new Set<string>();
  for (const requirement of spec.requirements) {
    assert.match(requirement.id, /^REQ-\d{2}$/, `${label}: requirement id`);
    assert.ok(requirement.statement.trim().length > 20, `${label}: requirement statement`);
    assert.ok(VERIFIERS.has(requirement.verifiedBy), `${label}: verifier ${requirement.verifiedBy}`);
    categories.add(requirement.category);
  }
  for (const category of ['functional', 'ux', 'accessibility', 'data', 'performance', 'reliability']) {
    assert.ok(categories.has(category), `${label}: category ${category}`);
  }
}

interface Case {
  id: string;
  prompt: string;
  domain: AppSpec['app']['domain'];
  entity: string;
  kinds: AppSpec['screens'][number]['kind'][];
  optionalKinds?: AppSpec['screens'][number]['kind'][];
}

const CASES: Case[] = [
  {
    id: 'notes',
    prompt: 'Build a notes app for capturing ideas and meeting notes',
    domain: 'productivity',
    entity: 'Note',
    kinds: ['dashboard', 'list', 'detail', 'form', 'settings'],
  },
  {
    id: 'habit-tracker',
    prompt: 'habit tracker app with streaks and daily reminders',
    domain: 'health',
    entity: 'Habit',
    kinds: ['dashboard', 'list', 'detail', 'form', 'profile', 'settings'],
  },
  {
    id: 'expense-splitter',
    prompt: 'app for splitting bills with friends',
    domain: 'finance',
    entity: 'Expense',
    kinds: ['dashboard', 'list', 'detail', 'form', 'profile', 'settings'],
  },
  {
    id: 'recipe-box',
    prompt: 'Recipe box app for family recipes',
    domain: 'media',
    entity: 'Recipe',
    kinds: ['dashboard', 'list', 'detail', 'form', 'settings'],
  },
  {
    id: 'workout-log',
    prompt: 'workout log to track gym sessions and training intensity',
    domain: 'health',
    entity: 'Workout',
    kinds: ['dashboard', 'list', 'detail', 'form', 'profile', 'settings'],
  },
  {
    id: 'trip-planner',
    prompt: 'trip planner with an itinerary and saved places',
    domain: 'travel',
    entity: 'Trip',
    kinds: ['dashboard', 'list', 'detail', 'form', 'settings'],
  },
  {
    id: 'reading-list',
    prompt: 'reading list app to track books I want to read',
    domain: 'media',
    entity: 'Book',
    kinds: ['dashboard', 'list', 'detail', 'form', 'settings'],
  },
  {
    id: 'crm-leads',
    prompt: 'CRM leads pipeline for a small sales team',
    domain: 'commerce',
    entity: 'Lead',
    kinds: ['dashboard', 'list', 'detail', 'form', 'profile', 'settings'],
  },
  {
    id: 'invoice-manager',
    prompt: 'invoice manager for freelancers with client billing',
    domain: 'finance',
    entity: 'Invoice',
    kinds: ['dashboard', 'list', 'detail', 'form', 'profile', 'settings'],
  },
  {
    id: 'event-check-in',
    prompt: 'event check-in app for conferences and meetups',
    domain: 'productivity',
    entity: 'Event',
    kinds: ['dashboard', 'list', 'detail', 'form', 'settings'],
  },
  {
    id: 'chat-community',
    prompt: 'chat community app with a message feed',
    domain: 'social',
    entity: 'Message',
    kinds: ['dashboard', 'list', 'detail', 'form', 'profile', 'chat', 'settings'],
  },
  {
    id: 'ecommerce-store',
    prompt: 'e-commerce store with products and orders',
    domain: 'commerce',
    entity: 'Product',
    kinds: ['dashboard', 'list', 'detail', 'form', 'profile', 'settings'],
  },
];

for (const testCase of CASES) {
  test(`compiles ${testCase.id} into a coherent spec`, () => {
    const spec = compileSpec({ prompt: testCase.prompt });
    assertWellFormed(spec, testCase.id);
    assert.equal(spec.app.domain, testCase.domain, `${testCase.id}: domain`);
    assert.ok(
      spec.entities.some((entity) => entity.name === testCase.entity),
      `${testCase.id}: expected ${testCase.entity} in ${spec.entities.map((e) => e.name).join(',')}`,
    );
    assert.equal(spec.entities[0].name, testCase.entity, `${testCase.id}: primary entity leads`);
    const kinds = new Set(spec.screens.map((screen) => screen.kind));
    for (const kind of testCase.kinds) {
      assert.ok(kinds.has(kind), `${testCase.id}: missing ${kind}`);
    }
    assert.ok(spec.seedCount >= 6 && spec.seedCount <= 12, `${testCase.id}: seedCount ${spec.seedCount}`);
  });
}

test('screen archetypes cover dashboard, list, detail, form, settings, profile, chat across cases', () => {
  const seen = new Set<string>();
  for (const testCase of CASES) {
    for (const screen of compileSpec({ prompt: testCase.prompt }).screens) seen.add(screen.kind);
  }
  for (const kind of ['dashboard', 'list', 'detail', 'form', 'settings', 'profile', 'chat']) {
    assert.ok(seen.has(kind), `missing archetype ${kind}`);
  }
});

test('onboarding prompts add an onboarding screen while keeping at most seven screens', () => {
  const spec = compileSpec({ prompt: 'habit tracker app with onboarding, personalization, and daily reminders' });
  assert.equal(spec.app.domain, 'health');
  const kinds = spec.screens.map((screen) => screen.kind);
  assert.ok(kinds.includes('onboarding'));
  assert.ok(kinds.includes('profile'));
  assert.ok(spec.screens.length <= 7);
  assert.ok(spec.flows.some((flow) => flow.id === 'first_run'));
  assertWellFormed(spec, 'onboarding');
});

test('commerce prompts expose a checkout journey over real screens', () => {
  const spec = compileSpec({ prompt: 'e-commerce store with products and orders' });
  const checkout = spec.flows.find((flow) => flow.id === 'checkout');
  assert.ok(checkout);
  const ids = new Set(spec.screens.map((screen) => screen.id));
  for (const step of checkout!.steps) assert.ok(ids.has(step.screenId));
});

test('a CRM pipeline does not inherit a catalog checkout journey', () => {
  const spec = compileSpec({ prompt: 'CRM leads pipeline for a small sales team' });
  assert.equal(spec.app.domain, 'commerce');
  assert.equal(spec.entities[0].name, 'Lead');
  assert.ok(!spec.flows.some((flow) => flow.id === 'checkout'));
});

test('descriptions are prompt-specific and do not duplicate the app name', () => {
  const notes = compileSpec({ prompt: 'Build a notes app for capturing ideas and meeting notes' });
  assert.match(notes.app.description, /capturing ideas and meeting notes/i);
  const event = compileSpec({ prompt: 'event check-in app for conferences and meetups' });
  assert.match(event.app.description, /conferences and meetups/i);
  assert.ok(!/event check-in app for/i.test(event.app.description));
  const crm = compileSpec({ prompt: 'CRM leads pipeline for a small sales team' });
  assert.match(crm.app.description, /a small sales team/i);
  assert.match(crm.app.description, /prospect|pipeline/i);
});

test('identical input compiles to a deep-equal spec', () => {
  const prompts = CASES.map((testCase) => testCase.prompt).slice(0, 6);
  for (const prompt of prompts) {
    const input = { prompt, seedColor: '#123456', backend: 'supabase' as const, seedCount: 5 };
    assert.deepEqual(compileSpec(input), compileSpec(input));
    assert.equal(JSON.stringify(compileSpec({ prompt })), JSON.stringify(compileSpec({ prompt })));
  }
});

test('domain inference spot checks every domain', () => {
  const expectations: Array<[string, AppSpec['app']['domain']]> = [
    ['notes and tasks', 'productivity'],
    ['online store checkout', 'commerce'],
    ['chat community feed', 'social'],
    ['expense and budget tracker', 'finance'],
    ['workout habit tracker', 'health'],
    ['flashcard study course', 'education'],
    ['trip planner itinerary', 'travel'],
    ['movie watchlist', 'media'],
    ['code snippets repository', 'developer'],
    ['pet grooming journal', 'custom'],
    ['', 'custom'],
    ['🚀✨', 'custom'],
  ];
  for (const [prompt, domain] of expectations) {
    assert.equal(inferDomain(prompt), domain, prompt);
  }
});

test('domain ties resolve by fixed priority and explicit overrides win', () => {
  assert.equal(inferDomain('store invoice'), 'commerce');
  const overridden = compileSpec({ prompt: 'habit tracker for the gym', domain: 'developer' });
  assert.equal(overridden.app.domain, 'developer');
  assertWellFormed(overridden, 'override');
});

test('app names are derived from product nouns and title-cased', () => {
  assert.equal(compileSpec({ prompt: 'habit tracker' }).app.name, 'Habit Tracker');
  assert.equal(compileSpec({ prompt: 'app for splitting bills' }).app.name, 'Split Bills');
  assert.equal(compileSpec({ prompt: 'notes' }).app.name, 'Notes');
  assert.equal(compileSpec({ prompt: 'build me a recipe box app' }).app.name, 'Recipe Box');
  assert.equal(compileSpec({ prompt: 'reading list app' }).app.name, 'Reading List');
  assert.equal(compileSpec({ prompt: 'crm leads' }).app.name, 'CRM Leads');
  assert.equal(compileSpec({ prompt: 'watch everything', appName: 'Trail Notes' }).app.name, 'Trail Notes');
});

test('package names are snake_case, letter-first, and at most 40 chars', () => {
  for (const prompt of CASES.map((testCase) => testCase.prompt).concat([
    '',
    'A very long habit tracker with a name that will not fit in a Dart package at all',
  ])) {
    const spec = compileSpec({ prompt });
    assert.match(spec.app.packageName, PACKAGE_RE, prompt);
    assert.ok(spec.app.packageName.length <= 40, prompt);
    assert.ok(spec.app.packageName.endsWith('_app'));
  }
  assert.equal(compileSpec({ prompt: 'habit tracker' }).app.packageName, 'habit_tracker_app');
  assert.equal(compileSpec({ prompt: 'anything', packageName: 'my_custom_package' }).app.packageName, 'my_custom_package');
});

test('empty, emoji, non-English, punctuation, and absurd prompts never throw and always validate', () => {
  const seedless = new Set(['', '   ', '🚀✨🦄', '!!!???...', '日本語のアプリを作ってください', 'Приложение для заметок']);
  const prompts = [
    '',
    '   ',
    '🚀✨🦄',
    '!!!???...',
    '日本語のアプリを作ってください',
    'Приложение для заметок',
    'null',
    undefined as unknown as string,
    123 as unknown as string,
  ];
  for (const prompt of prompts) {
    let spec: AppSpec | undefined;
    assert.doesNotThrow(() => {
      spec = compileSpec({ prompt });
    });
    assert.ok(spec);
    assertWellFormed(spec!, `edge:${String(prompt).slice(0, 16)}`);
    if (seedless.has(prompt as string)) {
      assert.equal(spec!.seedCount, 0, `edge seed:${String(prompt).slice(0, 16)}`);
    }
  }
});

test('a 5000-character prompt stays deterministic and valid', () => {
  const prompt = 'habit tracker app with streaks, reminders, and daily check-ins. '.repeat(80).slice(0, 5000);
  assert.ok(prompt.length >= 5000);
  const first = compileSpec({ prompt });
  const second = compileSpec({ prompt });
  assertWellFormed(first, 'long');
  assert.deepEqual(first, second);
});

test('seed counts are zero only for empty intent and otherwise deterministic 6-12', () => {
  assert.equal(compileSpec({ prompt: '' }).seedCount, 0);
  assert.equal(compileSpec({ prompt: 'blank app with no seed data' }).seedCount, 0);
  assert.equal(compileSpec({ prompt: 'notes app', seedCount: 3 }).seedCount, 3);
  const spec = compileSpec({ prompt: 'notes app' });
  assert.deepEqual(spec, compileSpec({ prompt: 'notes app' }));
  assert.ok(spec.seedCount >= 6 && spec.seedCount <= 12);
});

test('design respects an explicit seed color and falls back safely on invalid input', () => {
  const custom = compileSpec({ prompt: 'notes', seedColor: '#1a2b3c' });
  assert.equal(custom.design.seedColor, '#1A2B3C');
  const lowercase = compileSpec({ prompt: 'notes', seedColor: 'abcdef' });
  assert.equal(lowercase.design.seedColor, '#ABCDEF');
  const invalid = compileSpec({ prompt: 'notes', seedColor: 'not-a-color' });
  assert.match(invalid.design.seedColor, /^#[0-9A-F]{6}$/);
  const domainSeed = compileSpec({ prompt: 'workout log' });
  assert.notEqual(domainSeed.design.seedColor, compileSpec({ prompt: 'invoice manager' }).design.seedColor);
});

test('backend and seed count overrides are carried through', () => {
  const spec = compileSpec({ prompt: 'notes', backend: 'supabase', seedCount: 12 });
  assert.equal(spec.backend, 'supabase');
  assert.equal(spec.seedCount, 12);
  assert.equal(compileSpec({ prompt: 'notes', backend: 'local' }).backend, 'local');
  assert.equal(compileSpec({ prompt: 'notes' }).backend, 'local');
});

test('no emitted screen references an entity outside the spec across all cases', () => {
  for (const testCase of CASES) {
    const spec = compileSpec({ prompt: testCase.prompt });
    const entities = new Set(spec.entities.map((entity) => entity.name));
    for (const screen of spec.screens as ScreenSpec[]) {
      if (screen.entity) assert.ok(entities.has(screen.entity), `${testCase.id}: ${screen.id}`);
    }
    for (const flow of spec.flows) {
      const ids = new Set(spec.screens.map((screen) => screen.id));
      for (const step of flow.steps) assert.ok(ids.has(step.screenId), `${testCase.id}: ${flow.id}`);
    }
  }
});

test('flows include create and browse journeys for the primary entity', () => {
  for (const testCase of CASES) {
    const spec = compileSpec({ prompt: testCase.prompt });
    const singular = spec.entities[0].name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    assert.ok(spec.flows.some((flow) => flow.id === `create_${singular}`), testCase.id);
    assert.ok(spec.flows.some((flow) => flow.id === `browse_${spec.entities[0].plural}`), testCase.id);
  }
});

test('screens use unique routes and human titles', () => {
  for (const testCase of CASES) {
    const spec = compileSpec({ prompt: testCase.prompt });
    const routes = spec.screens.map((screen) => screen.route);
    assert.equal(new Set(routes).size, routes.length, testCase.id);
    for (const screen of spec.screens) {
      assert.ok(/^[A-Z]/.test(screen.title), `${testCase.id}: title ${screen.title}`);
    }
  }
});
