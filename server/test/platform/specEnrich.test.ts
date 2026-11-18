import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AppSpec,
  LlmComplete,
  LlmCompletionRequest,
  LlmCompletionResult,
} from '../../platform/generation/contracts.js';
import { validateSpec } from '../../platform/generation/emit/shared.js';
import { enrichSpec } from '../../platform/generation/spec/enrich.js';

function baseSpec(): AppSpec {
  return {
    version: 1,
    app: {
      name: 'Habit Harbor',
      packageName: 'habit_harbor',
      tagline: 'A simple app for habits',
      description: 'An app that helps you build habits.',
      domain: 'health',
    },
    audience: { primary: 'People building routines' },
    entities: [
      {
        name: 'Habit',
        plural: 'habits',
        description: 'A recurring habit',
        fields: [
          { name: 'title', type: 'string', required: true, primary: true, label: 'Title' },
          { name: 'streak', type: 'int', required: false, label: 'Streak' },
        ],
        searchField: 'title',
        sortField: 'streak',
      },
    ],
    screens: [
      {
        id: 'dashboard',
        title: 'Dashboard',
        route: '/',
        kind: 'dashboard',
        purpose: 'See today at a glance',
        inNavigation: true,
      },
      {
        id: 'habit_list',
        title: 'Habits',
        route: '/habits',
        kind: 'list',
        purpose: 'Browse and search habits',
        entity: 'Habit',
        inNavigation: true,
      },
      {
        id: 'habit_detail',
        title: 'Habit',
        route: '/habits/:id',
        kind: 'detail',
        purpose: 'Review one habit and its streak',
        entity: 'Habit',
      },
      {
        id: 'habit_form',
        title: 'Edit habit',
        route: '/habits/:id/edit',
        kind: 'form',
        purpose: 'Create or edit a habit',
        entity: 'Habit',
      },
    ],
    flows: [
      {
        id: 'first_habit',
        name: 'Create your first habit',
        steps: [
          { screenId: 'habit_list', action: 'Tap new habit' },
          { screenId: 'habit_form', action: 'Save habit' },
        ],
      },
    ],
    design: {
      seedColor: '#2E7D32',
      brightness: 'system',
      spacing: [4, 8, 12, 16, 24, 32],
      radii: { sm: 4, md: 8, lg: 16, xl: 24 },
      motionMs: 200,
      shape: 'rounded',
    },
    requirements: [
      {
        id: 'offline_first',
        statement: 'Habits persist locally and survive an app restart.',
        category: 'reliability',
        verifiedBy: 'test',
      },
    ],
    backend: 'local',
    seedCount: 6,
  };
}

const HAPPY_PAYLOAD = {
  app: {
    tagline: 'Build routines that stick, one check-in at a time',
    description: 'Habit Harbor tracks streaks, reminders and weekly reviews so momentum survives a busy week.',
  },
  entities: [
    {
      name: 'Workout',
      plural: 'workouts',
      description: 'A training session with sets, reps and RPE',
      fields: [
        { name: 'focus', type: 'string', required: true, primary: true, label: 'Focus' },
        { name: 'sets', type: 'int', required: false, label: 'Sets' },
        { name: 'rpe', type: 'double', required: false, label: 'RPE' },
      ],
    },
  ],
  screens: [
    {
      id: 'workout_list',
      title: 'Workouts',
      route: '/workouts',
      kind: 'list',
      purpose: 'Log a workout with sets, reps and RPE',
      entity: 'Workout',
      primaryAction: 'Log workout',
      inNavigation: true,
      icon: 'fitness_center',
    },
  ],
  flows: [
    {
      id: 'log_workout',
      name: 'Log a workout',
      steps: [
        { screenId: 'workout_list', action: 'Tap log workout' },
        { screenId: 'dashboard', action: 'Review today' },
      ],
    },
  ],
  requirements: [
    {
      id: 'workout_offline',
      statement: 'Workouts can be logged without a network connection.',
      category: 'reliability',
      verifiedBy: 'test',
    },
  ],
  notes: ['added workout tracking'],
};

function resultFor(text: string): LlmCompletionResult {
  return { text, model: 'stub', usage: { promptTokens: 1, completionTokens: 1 } };
}

function stub(payload: unknown): LlmComplete {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return async () => resultFor(text);
}

function capturingStub(payload: unknown, seen: LlmCompletionRequest[]): LlmComplete {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return async (request: LlmCompletionRequest) => {
    seen.push(request);
    return resultFor(text);
  };
}

test('happy path adds an entity, a screen, a flow, a requirement and refines copy', async () => {
  const base = baseSpec();
  const result = await enrichSpec(base, stub(HAPPY_PAYLOAD));

  assert.equal(result.enriched, true);
  assert.equal(validateSpec(result.spec).ok, true, validateSpec(result.spec).errors.join('; '));
  assert.equal(result.spec.app.tagline, HAPPY_PAYLOAD.app.tagline);
  assert.equal(result.spec.app.description, HAPPY_PAYLOAD.app.description);
  assert.ok(result.spec.entities.some((entity) => entity.name === 'Workout'));
  assert.ok(result.spec.entities.some((entity) => entity.name === 'Habit'), 'base entity is retained');
  assert.ok(result.spec.screens.some((screen) => screen.id === 'workout_list'));
  assert.ok(result.spec.screens.some((screen) => screen.id === 'habit_list'), 'base screen is retained');
  assert.ok(result.spec.flows.some((flow) => flow.id === 'log_workout'));
  assert.ok(result.spec.requirements.some((requirement) => requirement.id === 'workout_offline'));

  const notes = result.notes.join('\n');
  assert.match(notes, /added entity Workout/);
  assert.match(notes, /added screen workout_list/);
  assert.match(notes, /refined description/);
  assert.match(notes, /refined tagline/);
  assert.match(notes, /added flow log_workout/);
  assert.match(notes, /added requirements: 1/);

  // The caller's base spec must never be mutated.
  assert.equal(base.entities.length, 1);
  assert.equal(base.screens.length, 4);
  assert.deepEqual(base, baseSpec());
});

test('parses JSON wrapped in a json fence with leading and trailing prose', async () => {
  const payload = {
    app: {
      description: 'A focused habit tracker with streaks, reminders and a weekly review ritual.',
    },
  };
  const text = `Here is the enrichment you asked for:\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\nHope that helps!`;
  const result = await enrichSpec(baseSpec(), stub(text));

  assert.equal(result.enriched, true);
  assert.equal(result.spec.app.description, payload.app.description);
  assert.ok(result.notes.includes('refined description'));
});

test('trivially repairable JSON (single quotes, trailing commas, prose braces) is parsed', async () => {
  const text =
    "Here's the enrichment for {the app}: {'app': {'description': 'A specific habit tracker with streaks, reminders and weekly reviews.',},}";
  const result = await enrichSpec(baseSpec(), stub(text));

  assert.equal(result.enriched, true);
  assert.equal(
    result.spec.app.description,
    'A specific habit tracker with streaks, reminders and weekly reviews.',
  );
});

test('malformed JSON returns the base spec unchanged with a note', async () => {
  const base = baseSpec();
  const result = await enrichSpec(base, stub('{"app": {"tagline": "broken",'));

  assert.equal(result.enriched, false);
  assert.deepEqual(result.spec, base);
  assert.ok(result.notes.length >= 1);
  assert.match(result.notes.join(' '), /JSON/i);
});

test('LLM errors return the base spec unchanged', async () => {
  const base = baseSpec();
  const failing: LlmComplete = async () => {
    throw new Error('provider exploded');
  };
  const result = await enrichSpec(base, failing);

  assert.equal(result.enriched, false);
  assert.deepEqual(result.spec, base);
  assert.match(result.notes.join(' '), /provider exploded/);
});

test('deletions proposed by the model are ignored', async () => {
  const base = baseSpec();
  const result = await enrichSpec(
    base,
    stub({ entities: [], screens: [], flows: [], requirements: [] }),
  );

  assert.equal(result.enriched, false);
  assert.deepEqual(result.spec, base);
  assert.equal(result.spec.entities.length, 1);
  assert.equal(result.spec.screens.length, 4);
  assert.equal(result.spec.flows.length, 1);
  assert.equal(result.spec.requirements.length, 1);
});

test('invalid duplicates are rejected while valid additions are kept', async () => {
  const payload = {
    entities: [
      {
        name: 'Workout',
        plural: 'workouts',
        description: 'A training session',
        fields: [{ name: 'title', type: 'string', required: true, primary: true }],
      },
    ],
    screens: [
      {
        id: 'workout_list',
        title: 'Workouts',
        route: '/workouts',
        kind: 'list',
        purpose: 'Log a workout with sets and reps',
        entity: 'Workout',
      },
      {
        id: 'workout_catalog',
        title: 'Catalog',
        route: '/workouts',
        kind: 'list',
        purpose: 'Browse every workout',
        entity: 'Workout',
      },
      {
        id: 'meal_list',
        title: 'Meals',
        route: '/meals',
        kind: 'list',
        purpose: 'Browse meals',
        entity: 'Meal',
      },
      {
        id: 'workout_detail',
        title: 'Workout',
        route: '/workouts/:id',
        kind: 'detail',
        purpose: 'Review sets, reps and RPE for one session',
        entity: 'Workout',
      },
    ],
  };
  const result = await enrichSpec(baseSpec(), stub(payload));

  assert.equal(result.enriched, true);
  assert.equal(validateSpec(result.spec).ok, true);
  const ids = result.spec.screens.map((screen) => screen.id);
  assert.ok(ids.includes('workout_list'));
  assert.ok(ids.includes('workout_detail'));
  assert.ok(!ids.includes('workout_catalog'));
  assert.ok(!ids.includes('meal_list'));
  assert.equal(new Set(result.spec.screens.map((screen) => screen.route)).size, result.spec.screens.length);

  const notes = result.notes.join('\n');
  assert.match(notes, /duplicate route \/workouts/);
  assert.match(notes, /unknown entity Meal/);
});

test('packageName, app name, domain and seedColor changes are ignored', async () => {
  const base = baseSpec();
  const result = await enrichSpec(
    base,
    stub({
      app: { name: 'Pwned', packageName: 'pwned_app', domain: 'finance' },
      design: { ...base.design, seedColor: '#000000' },
      backend: 'supabase',
      seedCount: 99,
    }),
  );

  assert.equal(result.enriched, false);
  assert.deepEqual(result.spec, base);
  assert.equal(result.spec.app.packageName, 'habit_harbor');
  assert.equal(result.spec.design.seedColor, '#2E7D32');
  assert.equal(result.spec.backend, 'local');
  const notes = result.notes.join('\n');
  assert.match(notes, /app\.packageName/);
  assert.match(notes, /design\.seedColor/);
});

test('maxEntities and maxScreens caps are enforced', async () => {
  const payload = {
    entities: [
      {
        name: 'Workout',
        plural: 'workouts',
        description: 'A training session',
        fields: [{ name: 'title', type: 'string', required: true, primary: true }],
      },
      {
        name: 'Meal',
        plural: 'meals',
        description: 'A meal with macros',
        fields: [{ name: 'title', type: 'string', required: true, primary: true }],
      },
    ],
    screens: [
      {
        id: 'workout_list',
        title: 'Workouts',
        route: '/workouts',
        kind: 'list',
        purpose: 'Log a workout with sets and reps',
        entity: 'Workout',
      },
      {
        id: 'today',
        title: 'Today',
        route: '/today',
        kind: 'dashboard',
        purpose: 'See today at a glance',
      },
    ],
  };
  const result = await enrichSpec(baseSpec(), stub(payload), { maxEntities: 1, maxScreens: 1 });

  assert.equal(result.spec.entities.filter((entity) => entity.name === 'Workout').length, 1);
  assert.ok(!result.spec.entities.some((entity) => entity.name === 'Meal'));
  assert.ok(result.spec.screens.some((screen) => screen.id === 'workout_list'));
  assert.ok(!result.spec.screens.some((screen) => screen.id === 'today'));
  const notes = result.notes.join('\n');
  assert.match(notes, /entity cap reached \(1\)/);
  assert.match(notes, /screen cap reached \(1\)/);
});

test('identical base and LLM output produce identical specs and notes', async () => {
  const base = baseSpec();
  const first = await enrichSpec(base, stub(HAPPY_PAYLOAD));
  const second = await enrichSpec(base, stub(HAPPY_PAYLOAD));

  assert.deepEqual(first.spec, second.spec);
  assert.deepEqual(first.notes, second.notes);
  assert.equal(first.enriched, second.enriched);
});

test('oversized base spec is truncated in the prompt and still returns a valid spec', async () => {
  const base = baseSpec();
  base.entities = Array.from({ length: 60 }, (_, index) => ({
    name: `Record${index}`,
    plural: `records_${index}`,
    description: `Record ${index} captures ${'detailed operational context '.repeat(25)}`,
    fields: [
      { name: 'title', type: 'string' as const, required: true, primary: true, label: 'Title' },
      { name: 'summary', type: 'text' as const, required: false, label: 'Summary' },
      { name: 'score', type: 'int' as const, required: false, label: 'Score' },
      {
        name: 'status',
        type: 'enum' as const,
        required: true,
        values: ['draft', 'active', 'archived'],
        label: 'Status',
      },
      { name: 'occurredAt', type: 'datetime' as const, required: false, label: 'Occurred at' },
    ],
  }));
  base.screens = [
    { id: 'dashboard', title: 'Dashboard', route: '/', kind: 'dashboard', purpose: 'See today at a glance' },
    {
      id: 'record_list',
      title: 'Records',
      route: '/records',
      kind: 'list',
      purpose: 'Browse records',
      entity: 'Record0',
      inNavigation: true,
    },
    {
      id: 'record_detail',
      title: 'Record',
      route: '/records/:id',
      kind: 'detail',
      purpose: 'Review one record',
      entity: 'Record0',
    },
  ];
  base.flows = [
    { id: 'browse', name: 'Browse records', steps: [{ screenId: 'record_list', action: 'Open a record' }] },
  ];

  const seen: LlmCompletionRequest[] = [];
  const result = await enrichSpec(base, capturingStub({}, seen), { timeoutMs: 5_000 });

  assert.equal(seen.length, 1);
  assert.ok(seen[0].system.length + seen[0].user.length <= 60_000, 'prompt stays near the 60k budget');
  assert.ok(result.notes.some((note) => note.includes('truncated')));
  assert.equal(validateSpec(result.spec).ok, true);
  assert.equal(result.spec.entities.length, 60);
});

test('field validation rejects bad enums and relations and keeps valid additions', async () => {
  const payload = {
    entities: [
      {
        name: 'Workout',
        plural: 'workouts',
        description: 'A training session',
        fields: [
          { name: 'title', type: 'string', required: true, primary: true },
          { name: 'kind', type: 'enum', required: true, values: ['strength', 'cardio'] },
          { name: 'mood', type: 'enum', required: true },
          { name: 'habit', type: 'relation', required: false, target: 'habit' },
          { name: 'ghost', type: 'relation', required: false, target: 'Ghost' },
          { name: 'title', type: 'text', required: false },
          { name: 'class', type: 'string', required: false },
        ],
      },
      {
        name: 'Empty',
        plural: 'empties',
        description: 'No usable fields',
        fields: [{ name: 'x', type: 'wat' }],
      },
      {
        name: 'Habit',
        fields: [{ name: 'priority', type: 'int', required: false, primary: true }],
      },
    ],
    screens: [
      {
        id: 'workout_detail',
        title: 'Workout',
        route: '/workouts',
        kind: 'detail',
        purpose: 'Review a workout',
        entity: 'Workout',
      },
      {
        id: 'workout_new',
        title: 'New workout',
        route: '/workouts/:id/new',
        kind: 'form',
        purpose: 'Log sets, reps and RPE',
        entity: 'Workout',
      },
    ],
  };
  const result = await enrichSpec(baseSpec(), stub(payload));

  const workout = result.spec.entities.find((entity) => entity.name === 'Workout');
  assert.ok(workout);
  assert.deepEqual(workout.fields.map((field) => field.name), ['title', 'kind', 'habit']);
  assert.equal(workout.fields.filter((field) => field.primary).length, 1);
  assert.equal(workout.fields.find((field) => field.name === 'title')?.type, 'string');
  assert.equal(workout.fields.find((field) => field.name === 'habit')?.target, 'Habit');
  assert.ok(!result.spec.entities.some((entity) => entity.name === 'Empty'));

  const habit = result.spec.entities.find((entity) => entity.name === 'Habit');
  assert.equal(habit?.fields.find((field) => field.name === 'title')?.primary, true);
  assert.notEqual(habit?.fields.find((field) => field.name === 'priority')?.primary, true);

  const ids = result.spec.screens.map((screen) => screen.id);
  assert.ok(ids.includes('workout_new'));
  assert.ok(!ids.includes('workout_detail'));

  const notes = result.notes.join('\n');
  assert.match(notes, /enum needs values/);
  assert.match(notes, /unknown relation target Ghost/);
  assert.match(notes, /missing :id/);
  assert.match(notes, /invalid name/);
  assert.equal(validateSpec(result.spec).ok, true);
});

test('relations to rejected entities are dropped without losing the valid entity', async () => {
  const payload = {
    entities: [
      {
        name: 'Workout',
        plural: 'workouts',
        description: 'A training session',
        fields: [
          { name: 'title', type: 'string', required: true, primary: true },
          { name: 'habit', type: 'relation', required: false, target: 'Ghost' },
        ],
      },
      {
        name: 'Ghost',
        plural: 'ghosts',
        description: 'An entity with no salvageable fields',
        fields: [{ name: 'bad', type: 'not-a-type' }],
      },
    ],
  };
  const result = await enrichSpec(baseSpec(), stub(payload));

  assert.equal(result.enriched, true);
  assert.equal(validateSpec(result.spec).ok, true);
  const workout = result.spec.entities.find((entity) => entity.name === 'Workout');
  assert.ok(workout);
  assert.deepEqual(workout.fields.map((field) => field.name), ['title']);
  assert.ok(!result.spec.entities.some((entity) => entity.name === 'Ghost'));
  assert.match(result.notes.join('\n'), /unknown relation target Ghost/);
});

test('a hanging provider is bounded by timeoutMs', async () => {
  const base = baseSpec();
  const hanging: LlmComplete = () => new Promise<LlmCompletionResult>(() => {});
  const started = Date.now();
  const result = await enrichSpec(base, hanging, { timeoutMs: 25 });

  assert.equal(result.enriched, false);
  assert.deepEqual(result.spec, base);
  assert.ok(Date.now() - started < 2_000);
  assert.match(result.notes.join(' '), /timed out/);
});

