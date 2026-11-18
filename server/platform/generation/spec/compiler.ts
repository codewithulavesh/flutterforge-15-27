/**
 * Deterministic prompt → AppSpec compiler.
 *
 * This is the front door of the "any prompt → top app" lane. It is:
 *  - total: never throws for any input, including empty/emoji/non-English;
 *  - deterministic: no clocks, no randomness, stable ordering;
 *  - honest: unknown prompts land in `custom` with a usable generic app.
 *
 * The spec is pure data and always satisfies `validateSpec`. Emitters may
 * trust every entity/screen/flow reference without re-deriving it.
 */
import type {
  AppDomain,
  AppSpec,
  CompileInput,
  EntitySpec,
  FieldSpec,
  FieldType,
  FlowSpec,
  RequirementCategory,
  RequirementSpec,
  ScreenSpec,
} from '../contracts.js';
import { APP_DOMAINS, SPEC_VERSION } from '../contracts.js';
import { pascal, pluralize, snake, words } from '../emit/shared.js';

// ── domain inference ──────────────────────────────────────────────────────

/**
 * Fixed tie-break priority. Earlier domains win equal keyword scores, so the
 * same prompt always resolves to the same domain regardless of map order.
 */
const DOMAIN_PRIORITY: readonly AppDomain[] = [
  'productivity',
  'commerce',
  'social',
  'finance',
  'health',
  'education',
  'travel',
  'media',
  'developer',
  'custom',
];

interface Keyword {
  term: string;
  weight: number;
}

const DOMAIN_PURPOSE: Record<AppDomain, string> = {
  productivity: 'planning and task management',
  commerce: 'buying, selling, and order management',
  social: 'community and conversation',
  finance: 'money tracking and budgeting',
  health: 'fitness and healthy routines',
  education: 'learning and study planning',
  travel: 'trip planning and travel notes',
  media: 'media collection and recommendations',
  developer: 'code snippets and developer workflow',
  custom: 'personal collection management',
};

const DOMAIN_KEYWORDS: Record<AppDomain, readonly Keyword[]> = {
  productivity: [
    { term: 'todo', weight: 4 },
    { term: 'to do', weight: 4 },
    { term: 'task', weight: 4 },
    { term: 'tasks', weight: 4 },
    { term: 'checklist', weight: 4 },
    { term: 'note', weight: 3 },
    { term: 'notes', weight: 3 },
    { term: 'notebook', weight: 3 },
    { term: 'productivity', weight: 5 },
    { term: 'planner', weight: 3 },
    { term: 'planning', weight: 2 },
    { term: 'kanban', weight: 4 },
    { term: 'reminder', weight: 2 },
    { term: 'reminders', weight: 2 },
    { term: 'goal', weight: 2 },
    { term: 'goals', weight: 2 },
    { term: 'calendar', weight: 2 },
    { term: 'event', weight: 3 },
    { term: 'events', weight: 3 },
    { term: 'conference', weight: 2 },
    { term: 'check in', weight: 3 },
    { term: 'checkin', weight: 3 },
    { term: 'attendee', weight: 2 },
    { term: 'attendees', weight: 2 },
    { term: 'organizer', weight: 2 },
    { term: 'workspace', weight: 2 },
  ],
  commerce: [
    { term: 'store', weight: 4 },
    { term: 'storefront', weight: 4 },
    { term: 'shop', weight: 4 },
    { term: 'shopping', weight: 4 },
    { term: 'ecommerce', weight: 5 },
    { term: 'e commerce', weight: 5 },
    { term: 'commerce', weight: 5 },
    { term: 'product', weight: 3 },
    { term: 'products', weight: 3 },
    { term: 'cart', weight: 3 },
    { term: 'checkout', weight: 3 },
    { term: 'order', weight: 3 },
    { term: 'orders', weight: 3 },
    { term: 'inventory', weight: 4 },
    { term: 'crm', weight: 4 },
    { term: 'lead', weight: 3 },
    { term: 'leads', weight: 3 },
    { term: 'pipeline', weight: 3 },
    { term: 'sales', weight: 2 },
    { term: 'customer', weight: 2 },
    { term: 'customers', weight: 2 },
    { term: 'marketplace', weight: 4 },
  ],
  social: [
    { term: 'social', weight: 5 },
    { term: 'chat', weight: 3 },
    { term: 'chatting', weight: 3 },
    { term: 'community', weight: 4 },
    { term: 'communities', weight: 4 },
    { term: 'post', weight: 2 },
    { term: 'posts', weight: 2 },
    { term: 'feed', weight: 3 },
    { term: 'friend', weight: 3 },
    { term: 'friends', weight: 3 },
    { term: 'followers', weight: 3 },
    { term: 'following', weight: 2 },
    { term: 'message', weight: 4 },
    { term: 'messages', weight: 4 },
    { term: 'messaging', weight: 4 },
    { term: 'dm', weight: 4 },
    { term: 'forum', weight: 3 },
    { term: 'dating', weight: 4 },
    { term: 'event', weight: 2 },
    { term: 'events', weight: 2 },
    { term: 'meetup', weight: 3 },
    { term: 'meetups', weight: 3 },
    { term: 'conversation', weight: 3 },
  ],
  finance: [
    { term: 'expense', weight: 4 },
    { term: 'expenses', weight: 4 },
    { term: 'budget', weight: 4 },
    { term: 'budgets', weight: 4 },
    { term: 'budgeting', weight: 4 },
    { term: 'invoice', weight: 4 },
    { term: 'invoices', weight: 4 },
    { term: 'invoicing', weight: 4 },
    { term: 'finance', weight: 5 },
    { term: 'financial', weight: 5 },
    { term: 'finances', weight: 5 },
    { term: 'money', weight: 3 },
    { term: 'bill', weight: 3 },
    { term: 'bills', weight: 3 },
    { term: 'split', weight: 3 },
    { term: 'splitting', weight: 3 },
    { term: 'transaction', weight: 4 },
    { term: 'transactions', weight: 4 },
    { term: 'tax', weight: 3 },
    { term: 'taxes', weight: 3 },
    { term: 'banking', weight: 3 },
    { term: 'payment', weight: 3 },
    { term: 'payments', weight: 3 },
    { term: 'wallet', weight: 3 },
    { term: 'investing', weight: 3 },
    { term: 'portfolio', weight: 3 },
  ],
  health: [
    { term: 'health', weight: 5 },
    { term: 'workout', weight: 5 },
    { term: 'workouts', weight: 5 },
    { term: 'exercise', weight: 5 },
    { term: 'exercises', weight: 5 },
    { term: 'fitness', weight: 5 },
    { term: 'gym', weight: 5 },
    { term: 'habit', weight: 4 },
    { term: 'habits', weight: 4 },
    { term: 'meal', weight: 4 },
    { term: 'meals', weight: 4 },
    { term: 'nutrition', weight: 4 },
    { term: 'diet', weight: 4 },
    { term: 'calorie', weight: 4 },
    { term: 'calories', weight: 4 },
    { term: 'sleep', weight: 4 },
    { term: 'meditation', weight: 4 },
    { term: 'mindfulness', weight: 4 },
    { term: 'symptom', weight: 4 },
    { term: 'symptoms', weight: 4 },
    { term: 'medication', weight: 4 },
    { term: 'steps', weight: 2 },
    { term: 'water', weight: 2 },
    { term: 'weight', weight: 2 },
  ],
  education: [
    { term: 'education', weight: 4 },
    { term: 'learning', weight: 4 },
    { term: 'course', weight: 4 },
    { term: 'courses', weight: 4 },
    { term: 'lesson', weight: 4 },
    { term: 'lessons', weight: 4 },
    { term: 'study', weight: 4 },
    { term: 'studying', weight: 4 },
    { term: 'flashcard', weight: 5 },
    { term: 'flashcards', weight: 5 },
    { term: 'flash card', weight: 5 },
    { term: 'quiz', weight: 3 },
    { term: 'quizzes', weight: 3 },
    { term: 'school', weight: 3 },
    { term: 'class', weight: 3 },
    { term: 'classes', weight: 3 },
    { term: 'student', weight: 3 },
    { term: 'students', weight: 3 },
    { term: 'teacher', weight: 3 },
    { term: 'teachers', weight: 3 },
    { term: 'exam', weight: 3 },
    { term: 'exams', weight: 3 },
    { term: 'language', weight: 2 },
    { term: 'languages', weight: 2 },
  ],
  travel: [
    { term: 'travel', weight: 5 },
    { term: 'trip', weight: 5 },
    { term: 'trips', weight: 5 },
    { term: 'itinerary', weight: 5 },
    { term: 'vacation', weight: 4 },
    { term: 'holiday', weight: 4 },
    { term: 'flight', weight: 4 },
    { term: 'flights', weight: 4 },
    { term: 'hotel', weight: 3 },
    { term: 'hotels', weight: 3 },
    { term: 'booking', weight: 3 },
    { term: 'bookings', weight: 3 },
    { term: 'destination', weight: 4 },
    { term: 'destinations', weight: 4 },
    { term: 'packing', weight: 3 },
    { term: 'pack', weight: 3 },
    { term: 'map', weight: 1 },
    { term: 'maps', weight: 1 },
    { term: 'backpacking', weight: 4 },
  ],
  media: [
    { term: 'media', weight: 4 },
    { term: 'movie', weight: 5 },
    { term: 'movies', weight: 5 },
    { term: 'film', weight: 5 },
    { term: 'films', weight: 5 },
    { term: 'cinema', weight: 5 },
    { term: 'book', weight: 4 },
    { term: 'books', weight: 4 },
    { term: 'library', weight: 4 },
    { term: 'reading list', weight: 5 },
    { term: 'reading', weight: 3 },
    { term: 'music', weight: 4 },
    { term: 'album', weight: 4 },
    { term: 'albums', weight: 4 },
    { term: 'playlist', weight: 4 },
    { term: 'playlists', weight: 4 },
    { term: 'song', weight: 4 },
    { term: 'songs', weight: 4 },
    { term: 'podcast', weight: 4 },
    { term: 'podcasts', weight: 4 },
    { term: 'photo', weight: 3 },
    { term: 'photos', weight: 3 },
    { term: 'photography', weight: 3 },
    { term: 'gallery', weight: 3 },
    { term: 'video', weight: 3 },
    { term: 'videos', weight: 3 },
    { term: 'watchlist', weight: 3 },
    { term: 'streaming', weight: 3 },
    { term: 'recipe', weight: 4 },
    { term: 'recipes', weight: 4 },
    { term: 'cookbook', weight: 4 },
    { term: 'cooking', weight: 3 },
    { term: 'collection', weight: 1 },
    { term: 'collections', weight: 1 },
    { term: 'article', weight: 2 },
    { term: 'articles', weight: 2 },
  ],
  developer: [
    { term: 'developer', weight: 4 },
    { term: 'developers', weight: 4 },
    { term: 'dev', weight: 4 },
    { term: 'code', weight: 4 },
    { term: 'coding', weight: 4 },
    { term: 'programming', weight: 4 },
    { term: 'snippet', weight: 4 },
    { term: 'snippets', weight: 4 },
    { term: 'api', weight: 3 },
    { term: 'apis', weight: 3 },
    { term: 'endpoint', weight: 3 },
    { term: 'endpoints', weight: 3 },
    { term: 'git', weight: 3 },
    { term: 'github', weight: 3 },
    { term: 'repo', weight: 3 },
    { term: 'repository', weight: 3 },
    { term: 'bug', weight: 3 },
    { term: 'bugs', weight: 3 },
    { term: 'debug', weight: 3 },
    { term: 'deploy', weight: 3 },
    { term: 'deployment', weight: 3 },
    { term: 'terminal', weight: 3 },
    { term: 'cli', weight: 3 },
    { term: 'database', weight: 2 },
    { term: 'sql', weight: 2 },
    { term: 'devops', weight: 4 },
  ],
  custom: [
    { term: 'custom', weight: 5 },
    { term: 'pet', weight: 3 },
    { term: 'pets', weight: 3 },
    { term: 'plant', weight: 3 },
    { term: 'plants', weight: 3 },
    { term: 'garden', weight: 3 },
    { term: 'wedding', weight: 3 },
    { term: 'journal', weight: 2 },
    { term: 'journals', weight: 2 },
    { term: 'diary', weight: 2 },
    { term: 'tracker', weight: 1 },
    { term: 'manager', weight: 1 },
    { term: 'organizer', weight: 1 },
    { term: 'collection', weight: 1 },
    { term: 'qr', weight: 6 },
    { term: 'scanner', weight: 4 },
    { term: 'timer', weight: 4 },
    { term: 'stopwatch', weight: 4 },
    { term: 'calculator', weight: 4 },
    { term: 'flashlight', weight: 4 },
    { term: 'compass', weight: 4 },
    { term: 'metronome', weight: 4 },
    { term: 'wallpaper', weight: 3 },
    { term: 'soundboard', weight: 4 },
  ],
};

/** Accent-insensitive, punctuation-free, lowercased text used for inference. */
function normalizeText(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[-_/]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole-token or whole-phrase match against normalized text. */
function matchesTerm(text: string, term: string): boolean {
  if (!text || !term) return false;
  return ` ${text} `.includes(` ${term} `);
}

/**
 * Weighted keyword inference over the ten supported domains. Ties resolve by
 * `DOMAIN_PRIORITY`; zero signal is honestly `custom`.
 */
export function inferDomain(prompt: string): AppDomain {
  const text = normalizeText(prompt);
  if (!text) return 'custom';
  let winner: AppDomain = 'custom';
  let best = 0;
  for (const domain of DOMAIN_PRIORITY) {
    let score = 0;
    for (const keyword of DOMAIN_KEYWORDS[domain]) {
      if (matchesTerm(text, keyword.term)) score += keyword.weight;
    }
    if (score > best) {
      best = score;
      winner = domain;
    }
  }
  return best === 0 ? 'custom' : winner;
}

// ── entity templates ──────────────────────────────────────────────────────

function field(
  name: string,
  type: FieldType,
  label: string,
  extra: { required?: boolean; primary?: boolean; values?: readonly string[]; target?: string } = {},
): FieldSpec {
  const spec: FieldSpec = { name, type, required: extra.required ?? true, label };
  if (extra.primary) spec.primary = true;
  if (extra.values && extra.values.length > 0) spec.values = [...extra.values];
  if (extra.target) spec.target = extra.target;
  return spec;
}

interface EntityTemplate {
  name: string;
  description: string;
  fields: FieldSpec[];
  searchField?: string;
  sortField?: string;
}

const TEMPLATES: Record<string, EntityTemplate> = {
  Task: {
    name: 'Task',
    description: 'A single actionable item with a due date, priority, and completion state.',
    fields: [
      field('title', 'string', 'Title', { primary: true }),
      field('notes', 'text', 'Notes', { required: false }),
      field('dueAt', 'datetime', 'Due', { required: false }),
      field('priority', 'enum', 'Priority', { values: ['Low', 'Medium', 'High', 'Urgent'] }),
      field('completed', 'bool', 'Completed'),
      field('projectId', 'relation', 'Project', { required: false, target: 'Project' }),
      field('createdAt', 'datetime', 'Created'),
    ],
    sortField: 'dueAt',
  },
  Project: {
    name: 'Project',
    description: 'A container that groups related tasks and keeps work scoped.',
    fields: [
      field('name', 'string', 'Name', { primary: true }),
      field('description', 'text', 'Description', { required: false }),
      field('status', 'enum', 'Status', { values: ['Planning', 'Active', 'Paused', 'Done'] }),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Product: {
    name: 'Product',
    description: 'A sellable item with pricing, merchandising category, and stock state.',
    fields: [
      field('name', 'string', 'Name', { primary: true }),
      field('price', 'double', 'Price'),
      field('description', 'text', 'Description', { required: false }),
      field('category', 'enum', 'Category', {
        values: ['Electronics', 'Apparel', 'Home', 'Beauty', 'Grocery', 'Other'],
      }),
      field('inStock', 'bool', 'In stock'),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Order: {
    name: 'Order',
    description: 'A customer purchase with payment state, total, and fulfilment progress.',
    fields: [
      field('reference', 'string', 'Reference', { primary: true }),
      field('customerName', 'string', 'Customer'),
      field('total', 'double', 'Total'),
      field('status', 'enum', 'Status', {
        values: ['Pending', 'Paid', 'Shipped', 'Delivered', 'Cancelled'],
      }),
      field('placedAt', 'datetime', 'Placed'),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Post: {
    name: 'Post',
    description: 'A community update with a caption, author, and lightweight engagement count.',
    fields: [
      field('caption', 'string', 'Caption', { primary: true }),
      field('body', 'text', 'Body', { required: false }),
      field('author', 'string', 'Author'),
      field('likeCount', 'int', 'Likes'),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Comment: {
    name: 'Comment',
    description: 'A reply attached to a post, with author and engagement metadata.',
    fields: [
      field('body', 'text', 'Comment', { primary: true }),
      field('author', 'string', 'Author'),
      field('postId', 'relation', 'Post', { target: 'Post' }),
      field('likeCount', 'int', 'Likes'),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Transaction: {
    name: 'Transaction',
    description: 'A dated money movement with an amount, category, and optional note.',
    fields: [
      field('title', 'string', 'Title', { primary: true }),
      field('amount', 'double', 'Amount'),
      field('category', 'enum', 'Category', {
        values: ['Food', 'Transport', 'Housing', 'Shopping', 'Health', 'Entertainment', 'Income', 'Other'],
      }),
      field('occurredAt', 'datetime', 'Date'),
      field('notes', 'text', 'Notes', { required: false }),
      field('createdAt', 'datetime', 'Created'),
    ],
    sortField: 'occurredAt',
  },
  Budget: {
    name: 'Budget',
    description: 'A spending ceiling for a category and period.',
    fields: [
      field('name', 'string', 'Name', { primary: true }),
      field('limitAmount', 'double', 'Limit'),
      field('period', 'enum', 'Period', { values: ['Weekly', 'Monthly', 'Quarterly', 'Yearly'] }),
      field('category', 'enum', 'Category', {
        values: ['Food', 'Transport', 'Housing', 'Shopping', 'Health', 'Entertainment', 'Other'],
      }),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Workout: {
    name: 'Workout',
    description: 'A completed training session with duration, intensity, and notes.',
    fields: [
      field('name', 'string', 'Workout', { primary: true }),
      field('durationMinutes', 'int', 'Minutes'),
      field('intensity', 'enum', 'Intensity', { values: ['Light', 'Moderate', 'Vigorous', 'Max'] }),
      field('performedAt', 'datetime', 'Performed'),
      field('notes', 'text', 'Notes', { required: false }),
      field('createdAt', 'datetime', 'Created'),
    ],
    sortField: 'performedAt',
  },
  Habit: {
    name: 'Habit',
    description: 'A recurring behaviour with frequency, streak, and today’s completion state.',
    fields: [
      field('name', 'string', 'Habit', { primary: true }),
      field('frequency', 'enum', 'Frequency', { values: ['Daily', 'Weekly', 'Monthly'] }),
      field('streak', 'int', 'Streak'),
      field('completed', 'bool', 'Done today'),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Course: {
    name: 'Course',
    description: 'A structured learning path with an instructor and completion progress.',
    fields: [
      field('title', 'string', 'Course', { primary: true }),
      field('instructor', 'string', 'Instructor'),
      field('description', 'text', 'Description', { required: false }),
      field('progress', 'int', 'Progress %'),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Lesson: {
    name: 'Lesson',
    description: 'A single lesson inside a course with duration and completion state.',
    fields: [
      field('title', 'string', 'Lesson', { primary: true }),
      field('summary', 'text', 'Summary', { required: false }),
      field('completed', 'bool', 'Completed'),
      field('durationMinutes', 'int', 'Minutes'),
      field('courseId', 'relation', 'Course', { required: false, target: 'Course' }),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Trip: {
    name: 'Trip',
    description: 'A planned journey with destination, dates, and working notes.',
    fields: [
      field('name', 'string', 'Trip', { primary: true }),
      field('destination', 'string', 'Destination'),
      field('startDate', 'datetime', 'Starts'),
      field('endDate', 'datetime', 'Ends'),
      field('notes', 'text', 'Notes', { required: false }),
      field('createdAt', 'datetime', 'Created'),
    ],
    sortField: 'startDate',
  },
  Place: {
    name: 'Place',
    description: 'A saved location worth visiting, optionally attached to a trip.',
    fields: [
      field('name', 'string', 'Place', { primary: true }),
      field('city', 'string', 'City'),
      field('notes', 'text', 'Notes', { required: false }),
      field('visitedAt', 'datetime', 'Visited', { required: false }),
      field('tripId', 'relation', 'Trip', { required: false, target: 'Trip' }),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  MediaItem: {
    name: 'MediaItem',
    description: 'A book, film, series, album, podcast, or article worth tracking.',
    fields: [
      field('title', 'string', 'Title', { primary: true }),
      field('kind', 'enum', 'Kind', { values: ['Book', 'Movie', 'Series', 'Album', 'Podcast', 'Article'] }),
      field('rating', 'int', 'Rating', { required: false }),
      field('notes', 'text', 'Notes', { required: false }),
      field('status', 'enum', 'Status', { values: ['Backlog', 'In Progress', 'Finished'] }),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Collection: {
    name: 'Collection',
    description: 'A curated shelf that groups media, recipes, or other saved items.',
    fields: [
      field('name', 'string', 'Name', { primary: true }),
      field('description', 'text', 'Description', { required: false }),
      field('itemCount', 'int', 'Items'),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Snippet: {
    name: 'Snippet',
    description: 'A reusable code fragment tagged by language and searchable by title.',
    fields: [
      field('title', 'string', 'Title', { primary: true }),
      field('code', 'text', 'Code'),
      field('language', 'enum', 'Language', {
        values: ['Dart', 'TypeScript', 'Python', 'Go', 'Rust', 'SQL', 'Shell', 'Other'],
      }),
      field('tags', 'stringList', 'Tags'),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Item: {
    name: 'Item',
    description: 'A flexible record with a title, description, status, and optional due date.',
    fields: [
      field('title', 'string', 'Title', { primary: true }),
      field('description', 'text', 'Description', { required: false }),
      field('status', 'enum', 'Status', { values: ['Todo', 'In Progress', 'Done', 'Archived'] }),
      field('dueAt', 'datetime', 'Due', { required: false }),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Note: {
    name: 'Note',
    description: 'A free-form note with a title, body, tags, and pin state.',
    fields: [
      field('title', 'string', 'Title', { primary: true }),
      field('body', 'text', 'Body', { required: false }),
      field('tags', 'stringList', 'Tags'),
      field('pinned', 'bool', 'Pinned'),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Recipe: {
    name: 'Recipe',
    description: 'A family recipe with ingredients, method, cooking time, and meal category.',
    fields: [
      field('title', 'string', 'Recipe', { primary: true }),
      field('ingredients', 'stringList', 'Ingredients'),
      field('steps', 'text', 'Method'),
      field('minutes', 'int', 'Minutes'),
      field('category', 'enum', 'Category', {
        values: ['Breakfast', 'Lunch', 'Dinner', 'Dessert', 'Snack', 'Drink'],
      }),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Book: {
    name: 'Book',
    description: 'A reading-list entry with author, reading state, rating, and finish date.',
    fields: [
      field('title', 'string', 'Title', { primary: true }),
      field('author', 'string', 'Author'),
      field('status', 'enum', 'Status', { values: ['Want to Read', 'Reading', 'Finished', 'Paused'] }),
      field('rating', 'int', 'Rating', { required: false }),
      field('finishedAt', 'datetime', 'Finished', { required: false }),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Expense: {
    name: 'Expense',
    description: 'A shared cost with payer, participants, category, and settlement state.',
    fields: [
      field('title', 'string', 'Expense', { primary: true }),
      field('amount', 'double', 'Amount'),
      field('category', 'enum', 'Category', {
        values: ['Food', 'Transport', 'Housing', 'Shopping', 'Health', 'Entertainment', 'Other'],
      }),
      field('paidBy', 'string', 'Paid by'),
      field('sharedWith', 'stringList', 'Shared with'),
      field('settled', 'bool', 'Settled'),
      field('occurredAt', 'datetime', 'Date'),
      field('createdAt', 'datetime', 'Created'),
    ],
    sortField: 'occurredAt',
  },
  Person: {
    name: 'Person',
    description: 'A friend or group member with contact details and a running balance.',
    fields: [
      field('name', 'string', 'Name', { primary: true }),
      field('email', 'string', 'Email', { required: false }),
      field('balance', 'double', 'Balance'),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Invoice: {
    name: 'Invoice',
    description: 'A bill sent to a client with issue date, due date, and payment status.',
    fields: [
      field('number', 'string', 'Invoice #', { primary: true }),
      field('client', 'string', 'Client'),
      field('amount', 'double', 'Amount'),
      field('status', 'enum', 'Status', { values: ['Draft', 'Sent', 'Paid', 'Overdue', 'Void'] }),
      field('issuedAt', 'datetime', 'Issued'),
      field('dueAt', 'datetime', 'Due'),
      field('createdAt', 'datetime', 'Created'),
    ],
    sortField: 'dueAt',
  },
  Client: {
    name: 'Client',
    description: 'A customer or client record with contact details and notes.',
    fields: [
      field('name', 'string', 'Name', { primary: true }),
      field('email', 'string', 'Email', { required: false }),
      field('company', 'string', 'Company', { required: false }),
      field('notes', 'text', 'Notes', { required: false }),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Lead: {
    name: 'Lead',
    description: 'A sales prospect moving through a pipeline with an estimated value.',
    fields: [
      field('name', 'string', 'Name', { primary: true }),
      field('company', 'string', 'Company'),
      field('email', 'string', 'Email', { required: false }),
      field('stage', 'enum', 'Stage', {
        values: ['New', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost'],
      }),
      field('value', 'double', 'Value'),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Event: {
    name: 'Event',
    description: 'A scheduled gathering with venue, capacity, and live check-in count.',
    fields: [
      field('name', 'string', 'Event', { primary: true }),
      field('startsAt', 'datetime', 'Starts'),
      field('location', 'string', 'Location'),
      field('capacity', 'int', 'Capacity'),
      field('checkedInCount', 'int', 'Checked in'),
      field('createdAt', 'datetime', 'Created'),
    ],
    sortField: 'startsAt',
  },
  Attendee: {
    name: 'Attendee',
    description: 'A registered guest with ticket type and check-in state for an event.',
    fields: [
      field('name', 'string', 'Name', { primary: true }),
      field('email', 'string', 'Email', { required: false }),
      field('ticketType', 'enum', 'Ticket', { values: ['General', 'VIP', 'Speaker', 'Staff'] }),
      field('checkedIn', 'bool', 'Checked in'),
      field('checkedInAt', 'datetime', 'Checked in at', { required: false }),
      field('eventId', 'relation', 'Event', { target: 'Event' }),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Message: {
    name: 'Message',
    description: 'A chat message with author, channel, send time, and pin state.',
    fields: [
      field('body', 'text', 'Message', { primary: true }),
      field('author', 'string', 'Author'),
      field('channel', 'string', 'Channel'),
      field('sentAt', 'datetime', 'Sent'),
      field('pinned', 'bool', 'Pinned'),
      field('createdAt', 'datetime', 'Created'),
    ],
    sortField: 'sentAt',
  },
  Flashcard: {
    name: 'Flashcard',
    description: 'A question/answer study card with a deck and mastery state.',
    fields: [
      field('front', 'text', 'Front', { primary: true }),
      field('back', 'text', 'Back'),
      field('deck', 'string', 'Deck'),
      field('mastered', 'bool', 'Mastered'),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Pet: {
    name: 'Pet',
    description: 'A pet profile with species, birthday, and care notes.',
    fields: [
      field('name', 'string', 'Name', { primary: true }),
      field('species', 'enum', 'Species', { values: ['Dog', 'Cat', 'Bird', 'Fish', 'Reptile', 'Other'] }),
      field('birthDate', 'datetime', 'Birthday', { required: false }),
      field('notes', 'text', 'Notes', { required: false }),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
  Plant: {
    name: 'Plant',
    description: 'A houseplant with species, watering cadence, and care notes.',
    fields: [
      field('name', 'string', 'Name', { primary: true }),
      field('species', 'string', 'Species'),
      field('wateredAt', 'datetime', 'Last watered', { required: false }),
      field('notes', 'text', 'Notes', { required: false }),
      field('createdAt', 'datetime', 'Created'),
    ],
  },
};

/** Rich default entity set per domain; the first entry is the primary entity. */
const DOMAIN_ENTITY_SETS: Record<AppDomain, { primary: string; secondary: readonly string[] }> = {
  productivity: { primary: 'Task', secondary: ['Project'] },
  commerce: { primary: 'Product', secondary: ['Order'] },
  social: { primary: 'Post', secondary: ['Comment'] },
  finance: { primary: 'Transaction', secondary: ['Budget'] },
  health: { primary: 'Workout', secondary: ['Habit'] },
  education: { primary: 'Course', secondary: ['Lesson'] },
  travel: { primary: 'Trip', secondary: ['Place'] },
  media: { primary: 'MediaItem', secondary: ['Collection'] },
  developer: { primary: 'Snippet', secondary: ['Project'] },
  custom: { primary: 'Item', secondary: [] },
};

/**
 * A domain default only materializes when its trigger matches the prompt —
 * otherwise an unfocused app ships entities nobody asked for. Keys are the
 * TEMPLATES name; values are lowercase prompt patterns.
 */
const DEFAULT_TRIGGERS: Record<string, RegExp> = {
  Task: /task|todo|to-?do|checklist|to do/,
  Project: /project|workspace/,
  Product: /product|shop|store|catalog|inventory|e-?commerce|ecommerce/,
  Order: /order|checkout|purchase|cart/,
  Post: /post|feed|timeline|share|community|update/,
  Comment: /comment|reply|discussion/,
  Transaction: /transaction|income|cash ?flow|ledger/,
  Budget: /budget/,
  Workout: /workout|exercise|gym|sets|reps|training|cardio|strength/,
  Habit: /habit|habits|streak|routine|routines|daily check/,
  Course: /course|class|classes|curriculum/,
  Lesson: /lesson|lessons|study|module|modules|quiz|flashcard/,
  Trip: /trip|travel|itinerary|vacation|journey/,
  Place: /place|destination|city|cities|visit|visiting/,
  MediaItem: /movie|book|reading|show|music|podcast|media|photo/,
  Collection: /collection|playlist|shelf|list/,
  Snippet: /snippet|code|syntax|regex|terminal/,
  Item: /item|items/,
  Invoice: /invoice|billing|receipt/,
  Client: /client|customer|account/,
  Lead: /lead|prospect|crm/,
  Event: /event|conference|meetup/,
  Attendee: /attendee|guest|check-?in|badge/,
  Expense: /expense|split|bill|receipt|spending/,
  Person: /friend|roommate|person|people|member/,
  Note: /note|memo|journal|diary/,
  Book: /book|novel|reading|library/,
  Trip2: /trip/,
};

function defaultTriggered(name: string, text: string): boolean {
  const pattern = DEFAULT_TRIGGERS[name];
  return pattern ? pattern.test(text) : false;
}

interface NounRule {
  /** Lowercase tokens/phrases; multi-word keys match adjacent tokens. */
  keys: readonly string[];
  /** TEMPLATES key for the entity this noun implies. */
  template: string;
}

/**
 * Product nouns users actually type. Detection is whole-token, so "note"
 * never fires inside "notebook" and "post" never fires inside "poster".
 * Order is irrelevant; prompt position decides which entity leads.
 */
const NOUN_RULES: readonly NounRule[] = [
  { keys: ['note', 'notes', 'memo', 'memos', 'journal', 'journals', 'diary', 'diaries'], template: 'Note' },
  { keys: ['task', 'tasks', 'todo', 'todos', 'to do', 'checklist'], template: 'Task' },
  { keys: ['project', 'projects'], template: 'Project' },
  { keys: ['habit', 'habits', 'routine', 'routines'], template: 'Habit' },
  { keys: ['workout', 'workouts', 'exercise', 'exercises', 'training', 'gym'], template: 'Workout' },
  { keys: ['recipe', 'recipes', 'cookbook', 'cookbooks'], template: 'Recipe' },
  { keys: ['book', 'books', 'novel', 'novels', 'reading', 'reading list', 'library'], template: 'Book' },
  {
    keys: ['expense', 'expenses', 'bill', 'bills', 'split', 'splitting', 'splitter'],
    template: 'Expense',
  },
  { keys: ['friend', 'friends', 'roommate', 'roommates', 'person', 'people', 'member', 'members'], template: 'Person' },
  { keys: ['invoice', 'invoices', 'billing', 'receipt', 'receipts'], template: 'Invoice' },
  { keys: ['client', 'clients'], template: 'Client' },
  { keys: ['lead', 'leads', 'crm', 'prospect', 'prospects'], template: 'Lead' },
  { keys: ['budget', 'budgets', 'budgeting'], template: 'Budget' },
  { keys: ['transaction', 'transactions'], template: 'Transaction' },
  { keys: ['trip', 'trips', 'itinerary', 'itineraries', 'vacation', 'vacations'], template: 'Trip' },
  { keys: ['place', 'places', 'destination', 'destinations'], template: 'Place' },
  { keys: ['course', 'courses', 'class', 'classes'], template: 'Course' },
  { keys: ['lesson', 'lessons', 'module', 'modules'], template: 'Lesson' },
  {
    keys: ['flashcard', 'flashcards', 'flash card', 'flash cards', 'deck', 'decks'],
    template: 'Flashcard',
  },
  { keys: ['post', 'posts', 'update', 'updates'], template: 'Post' },
  { keys: ['comment', 'comments', 'reply', 'replies'], template: 'Comment' },
  {
    keys: ['message', 'messages', 'messaging', 'chat', 'chats', 'dm', 'dms', 'thread', 'threads', 'inbox'],
    template: 'Message',
  },
  { keys: ['event', 'events', 'meetup', 'meetups', 'conference', 'conferences'], template: 'Event' },
  {
    keys: ['attendee', 'attendees', 'guest', 'guests', 'check in', 'checkin', 'check ins'],
    template: 'Attendee',
  },
  { keys: ['product', 'products', 'inventory', 'catalog', 'catalogue'], template: 'Product' },
  { keys: ['order', 'orders', 'purchase', 'purchases'], template: 'Order' },
  { keys: ['collection', 'collections', 'shelf', 'shelves'], template: 'Collection' },
  { keys: ['snippet', 'snippets', 'code snippet', 'code snippets', 'source code'], template: 'Snippet' },
  { keys: ['pet', 'pets', 'dog', 'dogs', 'cat', 'cats'], template: 'Pet' },
  { keys: ['plant', 'plants', 'houseplant', 'houseplants'], template: 'Plant' },
];

/** Lowercase, alnum-only tokens used for keyword scoring and noun detection. */
function textTokens(text: string): string[] {
  return text ? text.split(' ') : [];
}

/** First normalized token index covered by a key, or -1. */
function findKeyIndex(tokens: string[], key: string): number {
  const parts = key.split(' ');
  if (parts.length === 1) return tokens.indexOf(key);
  for (let i = 0; i + parts.length <= tokens.length; i += 1) {
    let hit = true;
    for (let j = 0; j < parts.length; j += 1) {
      if (tokens[i + j] !== parts[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

/**
 * Templates implied by product nouns in the prompt, ordered by where they
 * first appear. Duplicate templates collapse to their first mention.
 */
function detectTemplates(prompt: string): string[] {
  const tokens = textTokens(normalizeText(prompt));
  if (tokens.length === 0) return [];
  const hits: Array<{ template: string; position: number; rule: number }> = [];
  for (let ruleIndex = 0; ruleIndex < NOUN_RULES.length; ruleIndex += 1) {
    const rule = NOUN_RULES[ruleIndex];
    let best = -1;
    for (const key of rule.keys) {
      const found = findKeyIndex(tokens, key);
      if (found >= 0 && (best < 0 || found < best)) best = found;
    }
    if (best >= 0) hits.push({ template: rule.template, position: best, rule: ruleIndex });
  }
  hits.sort((a, b) => (a.position - b.position) || (a.rule - b.rule));
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const hit of hits) {
    if (seen.has(hit.template)) continue;
    seen.add(hit.template);
    ordered.push(hit.template);
  }
  return ordered;
}

/** Deep clone a template so emitted specs never share mutable literals. */
function instantiate(template: EntityTemplate): EntitySpec {
  const entity: EntitySpec = {
    name: template.name,
    plural: snake(pluralize(template.name)),
    description: template.description,
    fields: template.fields.map((f) => {
      const copy: FieldSpec = { name: f.name, type: f.type, required: f.required, label: f.label };
      if (f.primary) copy.primary = true;
      if (f.values) copy.values = [...f.values];
      if (f.target) copy.target = f.target;
      return copy;
    }),
  };
  const primary = entity.fields.find((f) => f.primary);
  entity.searchField = template.searchField ?? primary?.name ?? entity.fields[0]?.name;
  if (template.sortField && entity.fields.some((f) => f.name === template.sortField)) {
    entity.sortField = template.sortField;
  } else if (entity.fields.some((f) => f.name === 'createdAt')) {
    entity.sortField = 'createdAt';
  }
  return entity;
}

function detects(detected: readonly string[], name: string): boolean {
  return detected.some((item) => pascal(item) === pascal(name) || item.toLowerCase() === name.toLowerCase());
}

function dedupeByName(names: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (!name || seen.has(name) || !TEMPLATES[name]) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function articleFor(word: string): string {
  return /^[aeiou]/i.test(String(word ?? '').trim()) ? 'an' : 'a';
}

/**
 * Domain defaults merged with prompt-specific nouns. Two or more detected
 * nouns signal a focused app, so defaults step aside; a single noun leads the
 * domain set. Relations to dropped entities are pruned to keep the spec valid.
 */
function buildEntities(domain: AppDomain, detected: readonly string[], prompt = ''): EntitySpec[] {
  const set = DOMAIN_ENTITY_SETS[domain];
  const text = String(prompt ?? '').toLowerCase();
  const crmScope = /crm|lead|pipeline|prospect|deal|follow[- ]?up/.test(text);
  const eventsScope = /event|check-?in|guest|badge|attendee/.test(text);
  let merited: string[];
  if (crmScope) merited = ['Lead', 'Client'].filter((name) => TEMPLATES[name]);
  else if (eventsScope && detects(detected, 'Event')) merited = ['Event', 'Attendee'].filter((name) => TEMPLATES[name]);
  else {
    // Detected entities lead (they are what the user asked for). Domain defaults
    // only materialize when their trigger matches the prompt — no unrelated
    // defaults ever materialize.
    merited = [set.primary, ...set.secondary].filter(
      (name) => detected.includes(name) || defaultTriggered(name, text),
    );
  }
  const ordered = dedupeByName([...detected, ...merited]);
  const chosen = (ordered.length > 0 ? ordered : [set.primary]).slice(0, 3);
  const entities = chosen.map((name) => instantiate(TEMPLATES[name]));
  const known = new Set(entities.map((entity) => pascal(entity.name)));
  for (const entity of entities) {
    entity.fields = entity.fields.filter((f) => {
      if (f.type !== 'relation') return true;
      return Boolean(f.target) && known.has(pascal(f.target ?? ''));
    });
    if (entity.searchField && !entity.fields.some((f) => f.name === entity.searchField)) {
      const primary = entity.fields.find((f) => f.primary) ?? entity.fields[0];
      entity.searchField = primary?.name;
    }
    if (entity.sortField && !entity.fields.some((f) => f.name === entity.sortField)) {
      entity.sortField = entity.fields.some((f) => f.name === 'createdAt') ? 'createdAt' : entity.fields[0]?.name;
    }
  }
  return entities;
}

// ── product naming ────────────────────────────────────────────────────────

const FALLBACK_NAMES: Record<AppDomain, string> = {
  productivity: 'Momentum Board',
  commerce: 'Corner Store',
  social: 'Common Ground',
  finance: 'Clear Ledger',
  health: 'Daily Vitals',
  education: 'Study Path',
  travel: 'Wander Plan',
  media: 'Media Shelf',
  developer: 'Dev Bench',
  custom: 'Starter App',
};

const IMPERATIVES = new Set([
  'build', 'create', 'make', 'design', 'develop', 'generate', 'write', 'craft', 'launch', 'prototype',
]);

const LEADING_FILLER = new Set([
  'please', 'kindly', 'i', 'we', 'want', 'need', 'would', 'like', 'to', 'a', 'an', 'the', 'my', 'our',
  'your', 'simple', 'small', 'mobile', 'web', 'modern', 'beautiful', 'lightweight', 'personal', 'new',
]);

const GENERIC_PRODUCT_WORDS = new Set([
  'app', 'apps', 'application', 'applications', 'tool', 'tools', 'platform', 'website', 'site', 'service',
  'dashboard', 'experience', 'system', 'solution',
]);

const EDGE_WORDS = new Set([
  'for', 'to', 'that', 'which', 'with', 'and', 'or', 'of', 'in', 'on', 'using', 'featuring', 'including',
  'plus', 'but', 'so', 'where', 'when', 'who', 'about', 'around', 'from', 'by',
]);

const INNER_DROP = new Set([
  'me', 'my', 'our', 'your', 'their', 'us', 'i', 'we', 'the', 'a', 'an', 'please', 'just', 'really',
]);

const ACRONYMS = new Set([
  'crm', 'api', 'apis', 'cms', 'erp', 'saas', 'ai', 'ml', 'ui', 'ux', 'sql', 'pos', 'hr', 'cbt', 'diy',
  'qr', 'pdf', 'csv', 'kpi', 'okr', 'crm',
]);

const GERUNDS: Record<string, string> = {
  splitting: 'split',
  tracking: 'track',
  managing: 'manage',
  budgeting: 'budget',
  planning: 'plan',
  logging: 'log',
  journaling: 'journal',
  organizing: 'organize',
  scheduling: 'schedule',
  saving: 'save',
  sharing: 'share',
  shopping: 'shop',
  cooking: 'cook',
  reading: 'read',
  writing: 'write',
  studying: 'study',
  learning: 'learn',
  building: 'build',
  making: 'make',
  creating: 'create',
  traveling: 'travel',
  booking: 'book',
  training: 'train',
  running: 'run',
  swimming: 'swim',
  cycling: 'cycle',
  rating: 'rate',
  collecting: 'collect',
  watching: 'watch',
  listening: 'listen',
};

interface RawToken {
  raw: string;
  lower: string;
}

/** Tokens that keep internal hyphens for display names, e.g. `check-in`. */
function rawTokens(raw: unknown): RawToken[] {
  const matches = String(raw ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? [];
  return matches.map((token) => ({ raw: token, lower: token.replace(/[’']/g, '').toLowerCase() }));
}

const COMPOUND_HEADS = new Set([
  'list', 'log', 'tracker', 'journal', 'planner', 'box', 'board', 'club', 'group', 'guide', 'card',
  'cards', 'deck', 'shelf', 'book', 'books', 'map', 'maps', 'feed',
]);

function deGerund(word: string): string {
  return GERUNDS[word] ?? word;
}

function capWord(raw: string): string {
  const lower = raw.toLowerCase();
  if (ACRONYMS.has(lower) || (/^[A-Z0-9]{2,5}$/.test(raw) && !/[a-z]/.test(raw))) {
    return raw.toUpperCase();
  }
  return raw
    .toLowerCase()
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}

function titleCaseTokens(tokens: readonly RawToken[]): string {
  return tokens.map((token) => capWord(token.raw)).filter(Boolean).join(' ');
}

/** Remove leading filler/imperatives and trailing generic product words. */
function trimWords(tokens: RawToken[]): RawToken[] {
  let start = 0;
  let end = tokens.length;
  let changed = true;
  while (changed && start < end) {
    changed = false;
    const first = tokens[start].lower;
    if (IMPERATIVES.has(first) || LEADING_FILLER.has(first) || EDGE_WORDS.has(first)) {
      start += 1;
      changed = true;
      continue;
    }
    const last = tokens[end - 1].lower;
    if (GENERIC_PRODUCT_WORDS.has(last) || EDGE_WORDS.has(last)) {
      end -= 1;
      changed = true;
    }
  }
  return tokens.slice(start, end);
}

/** Compact the raw prompt into a 1–3 word product-name noun phrase. */
function nameWordsFromPrompt(prompt: string): RawToken[] {
  const tokens = trimWords(rawTokens(prompt));
  if (tokens.length === 0) return [];

  // "notes app for X" → the words before `app` are the product name.
  const genericIndex = tokens.findIndex((token) => GENERIC_PRODUCT_WORDS.has(token.lower));
  let candidate: RawToken[];
  if (genericIndex > 0) {
    const before = trimWords(tokens.slice(0, genericIndex));
    candidate = before.length > 0 ? before : trimWords(tokens.slice(genericIndex + 1));
  } else if (genericIndex === 0) {
    candidate = trimWords(tokens.slice(1));
  } else {
    candidate = tokens;
  }

  candidate = trimWords(candidate);
  candidate = candidate.filter((token) => !INNER_DROP.has(token.lower));

  // Stop at a clause connector; the head noun phrase is what the user names.
  const cut = candidate.findIndex((token) => EDGE_WORDS.has(token.lower));
  if (cut > 0) candidate = candidate.slice(0, cut);

  candidate = trimWords(candidate);
  if (candidate.length === 0) return [];
  if (candidate.length > 3) candidate = candidate.slice(0, 3);
  if (candidate.length > 0) {
    const first = candidate[0];
    const compound = candidate.length > 1 && COMPOUND_HEADS.has(candidate[1].lower);
    const verb = compound ? first.lower : deGerund(first.lower);
    if (verb !== first.lower) candidate[0] = { raw: verb, lower: verb };
  }
  return candidate;
}

/** Sanitize to the contract's display-name grammar and title-case it. */
function sanitizeName(raw: string, fallback: string): string {
  let name = String(raw ?? '')
    .replace(/['’]/g, '')
    .replace(/[^A-Za-z0-9 &.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) name = fallback;
  if (!/^[A-Za-z]/.test(name)) name = `The ${name}`;
  if (name.length > 60) {
    name = name.slice(0, 60);
    while (name.length > 1 && /[\s&.-]$/.test(name)) name = name.slice(0, -1);
  }
  return name || fallback;
}

/** Title-case an already-clean display string, preserving acronyms. */
function sanitizeAppName(raw: unknown, domain: AppDomain): string {
  const tokens = rawTokens(raw);
  const title = titleCaseTokens(tokens);
  return sanitizeName(title, FALLBACK_NAMES[domain]);
}

/** Deterministic package name: snake_case, starts with a letter, max 40 chars. */
function derivePackageName(explicit: unknown, name: string): string {
  const normalize = (value: unknown): string =>
    String(value ?? '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase();

  let base = normalize(explicit);
  if (base) {
    if (!/^[a-z]/.test(base)) base = `app_${base}`.replace(/_+/g, '_');
    if (base.length > 40) base = base.slice(0, 40).replace(/_+$/g, '');
    if (base.length >= 2) return base;
  }
  base = normalize(name);
  if (!/^[a-z]/.test(base)) base = `app_${base}`.replace(/_+/g, '_');
  if (base.length < 2) base = 'app';
  if (base.length > 40) base = base.slice(0, 40).replace(/_+$/g, '');
  if (!base.endsWith('_app')) {
    if (base.length + 4 <= 40) {
      base = `${base}_app`;
    } else {
      base = `${base.slice(0, 36).replace(/_+$/g, '')}_app`;
    }
  }
  return base;
}

// ── screens ───────────────────────────────────────────────────────────────

const DOMAIN_ICON: Record<AppDomain, string> = {
  productivity: 'checklist',
  commerce: 'storefront',
  social: 'forum',
  finance: 'receipt_long',
  health: 'monitor_heart',
  education: 'school',
  travel: 'flight_takeoff',
  media: 'library_books',
  developer: 'code',
  custom: 'grid_view',
};

const DOMAIN_AUDIENCE: Record<AppDomain, string> = {
  productivity: 'Busy makers and small teams',
  commerce: 'Independent sellers and shop owners',
  social: 'Community builders and friend groups',
  finance: 'Budget-conscious households and freelancers',
  health: 'People building healthier routines',
  education: 'Students and self-directed learners',
  travel: 'Frequent travelers and trip planners',
  media: 'Readers, watchers, and collectors',
  developer: 'Developers who reuse code daily',
  custom: 'Anyone organizing a personal collection',
};

const PROFILE_DOMAINS = new Set<AppDomain>(['social', 'health', 'finance', 'commerce']);

interface PromptSignals {
  chat: boolean;
  onboarding: boolean;
  profile: boolean;
}

function promptSignals(text: string, domain: AppDomain): PromptSignals {
  const chat =
    matchesTerm(text, 'chat') ||
    matchesTerm(text, 'message') ||
    matchesTerm(text, 'messages') ||
    matchesTerm(text, 'messaging') ||
    matchesTerm(text, 'community') ||
    matchesTerm(text, 'forum') ||
    matchesTerm(text, 'support') ||
    matchesTerm(text, 'inbox') ||
    matchesTerm(text, 'conversation') ||
    matchesTerm(text, 'dm');
  const onboarding =
    matchesTerm(text, 'onboarding') ||
    matchesTerm(text, 'first run') ||
    matchesTerm(text, 'first time') ||
    matchesTerm(text, 'welcome') ||
    matchesTerm(text, 'get started') ||
    matchesTerm(text, 'personalize') ||
    matchesTerm(text, 'personalization') ||
    matchesTerm(text, 'setup') ||
    matchesTerm(text, 'set up') ||
    matchesTerm(text, 'calibrate');
  const profile =
    PROFILE_DOMAINS.has(domain) ||
    matchesTerm(text, 'profile') ||
    matchesTerm(text, 'account') ||
    matchesTerm(text, 'membership') ||
    matchesTerm(text, 'avatar');
  return { chat, onboarding, profile };
}

function humanSingular(entity: EntitySpec): string {
  return words(entity.name).map((part) => part.toLowerCase()).join(' ');
}

function humanPlural(entity: EntitySpec): string {
  return words(entity.plural).map((part) => part.toLowerCase()).join(' ');
}

function displayTitle(raw: string): string {
  return words(raw).map((part) => capWord(part)).join(' ');
}

function fieldLabels(entity: EntitySpec, limit = 3): string {
  return entity.fields
    .slice(0, limit)
    .map((f) => (f.label ?? pascal(f.name)).toLowerCase())
    .join(', ');
}

function kpiPhrase(entity: EntitySpec): string {
  if (entity.fields.some((f) => f.name === 'completed')) return 'completion rate';
  if (entity.fields.some((f) => f.type === 'enum' && f.name === 'status')) return 'status mix';
  if (entity.fields.some((f) => f.type === 'double')) return 'running total';
  if (entity.fields.some((f) => f.name === 'durationMinutes')) return 'minutes logged';
  return 'recent activity';
}

function buildScreens(
  name: string,
  domain: AppDomain,
  text: string,
  primary: EntitySpec,
  entities: readonly EntitySpec[],
): ScreenSpec[] {
  const singular = humanSingular(primary);
  const plural = humanPlural(primary);
  const singularTitle = displayTitle(primary.name);
  const pluralTitle = displayTitle(plural);
  const signals = promptSignals(text, domain);

  let wantsProfile = signals.profile;
  const wantsChat = signals.chat;
  const wantsOnboarding = signals.onboarding;
  // Base five screens + at most two optional keeps the 4–7 contract.
  if (wantsProfile && wantsChat && wantsOnboarding) wantsProfile = false;

  const screens: ScreenSpec[] = [];
  screens.push({
    id: 'dashboard',
    title: 'Dashboard',
    route: '/',
    kind: 'dashboard',
    purpose: `KPI overview of open ${plural}, ${kpiPhrase(primary)}, and the latest ${plural} with quick actions.`,
    entity: primary.name,
    primaryAction: `New ${singularTitle}`,
    inNavigation: true,
    icon: 'dashboard',
  });
  screens.push({
    id: `${snake(primary.name)}_list`,
    title: pluralTitle,
    route: `/${primary.plural}`,
    kind: 'list',
    purpose: `Search, filter, and sort ${plural} by ${fieldLabels(primary, 1)}; the empty state invites the first ${singular}.`,
    entity: primary.name,
    primaryAction: `New ${singularTitle}`,
    inNavigation: true,
    icon: DOMAIN_ICON[domain],
  });
  screens.push({
    id: `${snake(primary.name)}_detail`,
    title: `${singularTitle} Detail`,
    route: `/${primary.plural}/:id`,
    kind: 'detail',
    purpose: `Full ${singular} record with ${fieldLabels(primary)} metadata plus edit and delete actions.`,
    entity: primary.name,
    primaryAction: `Edit ${singularTitle}`,
    inNavigation: false,
    icon: 'description',
  });
  screens.push({
    id: `${snake(primary.name)}_form`,
    title: `Edit ${singularTitle}`,
    route: `/${primary.plural}/:id/edit`,
    kind: 'form',
    purpose: `Validated editor for ${singular} fields (${fieldLabels(primary)}); inline errors block invalid saves.`,
    entity: primary.name,
    primaryAction: `Save ${singularTitle}`,
    inNavigation: false,
    icon: 'edit',
  });

  if (wantsProfile) {
    screens.push({
      id: 'profile',
      title: 'Profile',
      route: '/profile',
      kind: 'profile',
      purpose: `Identity header, ${kpiPhrase(primary)} highlights, and preference shortcuts for ${DOMAIN_AUDIENCE[domain].toLowerCase()}.`,
      primaryAction: 'Edit profile',
      inNavigation: true,
      icon: 'person',
    });
  }
  if (wantsChat) {
    const chatEntity =
      entities.find((entity) => entity.name === 'Message') ??
      entities.find((entity) => entity.name === 'Post') ??
      primary;
    screens.push({
      id: 'chat',
      title: 'Messages',
      route: '/chat',
      kind: 'chat',
      purpose: `Message thread with composer, optimistic send, and a friendly empty conversation state for ${humanPlural(chatEntity)}.`,
      entity: chatEntity.name,
      primaryAction: 'Send message',
      inNavigation: !wantsProfile,
      icon: 'chat_bubble',
    });
  }
  if (wantsOnboarding) {
    screens.push({
      id: 'onboarding',
      title: 'Getting Started',
      route: '/onboarding',
      kind: 'onboarding',
      purpose: `First-run setup that captures intent and prepares the first ${singular} without a blank screen.`,
      primaryAction: 'Get started',
      inNavigation: false,
      icon: 'rocket_launch',
    });
  }
  screens.push({
    id: 'settings',
    title: 'Settings',
    route: '/settings',
    kind: 'settings',
    purpose: `Theme mode, seed color preview, local data reset, and about details for ${name}.`,
    primaryAction: 'Reset local data',
    inNavigation: false,
    icon: 'settings',
  });
  return screens;
}

// ── flows ─────────────────────────────────────────────────────────────────

function step(screenId: string, action: string): { screenId: string; action: string } {
  return { screenId, action };
}

function buildFlows(domain: AppDomain, primary: EntitySpec, screens: readonly ScreenSpec[]): FlowSpec[] {
  const ids = new Set(screens.map((screen) => screen.id));
  const singular = humanSingular(primary);
  const plural = humanPlural(primary);
  const singularTitle = displayTitle(primary.name);
  const pluralTitle = displayTitle(plural);
  const listId = `${snake(primary.name)}_list`;
  const detailId = `${snake(primary.name)}_detail`;
  const formId = `${snake(primary.name)}_form`;
  const labels = primary.fields
    .slice(0, 3)
    .map((f) => (f.label ?? pascal(f.name)).toLowerCase());

  const flows: FlowSpec[] = [
    {
      id: `create_${snake(primary.name)}`,
      name: `Create ${articleFor(singularTitle)} ${singularTitle}`,
      steps: [
        step('dashboard', 'Open the dashboard'),
        step(listId, `Tap New ${singularTitle}`),
        step(formId, `Fill ${labels.join(', ')} and save`),
        step(detailId, `Review the saved ${singular}`),
      ],
    },
    {
      id: `browse_${primary.plural}`,
      name: `Browse ${pluralTitle}`,
      steps: [
        step(listId, `Search or filter ${plural}`),
        step(detailId, `Open a ${singular} to inspect its details`),
        step(formId, 'Adjust fields and save changes'),
      ],
    },
  ];

  if (ids.has('onboarding')) {
    flows.push({
      id: 'first_run',
      name: 'First-run setup',
      steps: [
        step('onboarding', 'Answer the intention questions'),
        step('dashboard', 'Land on a prepared dashboard'),
        step(listId, `Open the first ${singular}`),
      ],
    });
  } else if (
    domain === 'commerce' &&
    (primary.name === 'Product' || primary.name === 'Order') &&
    ids.has(detailId)
  ) {
    flows.push({
      id: 'checkout',
      name: 'Shop and check out',
      steps: [
        step(listId, 'Browse the catalog'),
        step(detailId, 'Add the item to the cart and confirm the order'),
        step(listId, 'Return to the catalog for the next purchase'),
      ],
    });
  } else if (ids.has('chat') && ids.has(listId)) {
    flows.push({
      id: 'join_conversation',
      name: 'Join a conversation',
      steps: [
        step(listId, `Catch up on ${plural}`),
        step('chat', 'Send a message and read the reply'),
        step('dashboard', 'Return to the overview'),
      ],
    });
  }
  return flows.slice(0, 3);
}

// ── design ────────────────────────────────────────────────────────────────

const DOMAIN_SEED: Record<AppDomain, string> = {
  productivity: '#4F46E5',
  commerce: '#C2410C',
  social: '#DB2777',
  finance: '#047857',
  health: '#0D9488',
  education: '#2563EB',
  travel: '#0284C7',
  media: '#7C3AED',
  developer: '#334155',
  custom: '#6750A4',
};

function coerceHex(value: unknown, fallback: string): string {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toUpperCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw
      .split('')
      .map((ch) => `${ch}${ch}`)
      .join('')
      .toUpperCase()}`;
  }
  return fallback;
}

// ── requirements ──────────────────────────────────────────────────────────

interface RequirementDraft {
  statement: string;
  category: RequirementCategory;
  verifiedBy: 'analyze' | 'widget-test' | 'score' | 'structural';
}

const DOMAIN_REQUIREMENT: Record<AppDomain, RequirementDraft> = {
  productivity: {
    statement: 'Due dates sort predictably and overdue items are visually distinct from upcoming work.',
    category: 'ux',
    verifiedBy: 'score',
  },
  commerce: {
    statement: 'Order totals recalculate deterministically after any line-item or quantity edit.',
    category: 'functional',
    verifiedBy: 'widget-test',
  },
  social: {
    statement: 'Reported content is hidden locally pending moderation without breaking thread layout.',
    category: 'reliability',
    verifiedBy: 'structural',
  },
  finance: {
    statement: 'Currency totals round consistently to two decimal places across list and detail views.',
    category: 'data',
    verifiedBy: 'structural',
  },
  health: {
    statement: 'Streak counts derive from logged dates and never require manual editing.',
    category: 'functional',
    verifiedBy: 'widget-test',
  },
  education: {
    statement: 'Completing a lesson updates course progress deterministically and immediately.',
    category: 'functional',
    verifiedBy: 'widget-test',
  },
  travel: {
    statement: 'Itineraries remain readable offline using locally cached trip and place details.',
    category: 'reliability',
    verifiedBy: 'widget-test',
  },
  media: {
    statement: 'Ratings clamp to the 1–5 range on save and round-trip through JSON unchanged.',
    category: 'data',
    verifiedBy: 'widget-test',
  },
  developer: {
    statement: 'Snippets preserve whitespace and render in a monospace code block with selectable text.',
    category: 'ux',
    verifiedBy: 'score',
  },
  custom: {
    statement: 'Every field remains editable after creation without losing previously saved values.',
    category: 'functional',
    verifiedBy: 'widget-test',
  },
};

const ENTITY_REQUIREMENT: Record<string, RequirementDraft> = {
  Lead: {
    statement: 'Pipeline stage and value totals update deterministically whenever a lead moves stage.',
    category: 'functional',
    verifiedBy: 'widget-test',
  },
  Invoice: {
    statement: 'Invoice totals and overdue status derive deterministically from issue and due dates.',
    category: 'data',
    verifiedBy: 'structural',
  },
  Expense: {
    statement: 'Split balances settle to zero once every participant marks their share paid.',
    category: 'functional',
    verifiedBy: 'widget-test',
  },
  Event: {
    statement: 'Checked-in counts never exceed capacity and refresh immediately after each check-in.',
    category: 'data',
    verifiedBy: 'widget-test',
  },
  Attendee: {
    statement: 'A guest cannot be checked in twice, and the timestamp reflects the first arrival.',
    category: 'reliability',
    verifiedBy: 'widget-test',
  },
  Recipe: {
    statement: 'Ingredient lists preserve order and survive JSON round-trips without duplication.',
    category: 'data',
    verifiedBy: 'structural',
  },
  Book: {
    statement: 'Moving a book to Finished records a finish date without overwriting earlier ratings.',
    category: 'functional',
    verifiedBy: 'widget-test',
  },
  Message: {
    statement: 'Messages appear optimistically and keep stable ordering after reloading the thread.',
    category: 'reliability',
    verifiedBy: 'widget-test',
  },
  Habit: {
    statement: 'Streak counts derive from completion dates and never require manual editing.',
    category: 'functional',
    verifiedBy: 'widget-test',
  },
  Workout: {
    statement: 'Weekly training totals derive from performed dates and duration without double counting.',
    category: 'data',
    verifiedBy: 'structural',
  },
};

function buildRequirements(
  primary: EntitySpec,
  screens: readonly ScreenSpec[],
  domain: AppDomain,
): RequirementSpec[] {
  const singular = humanSingular(primary);
  const plural = humanPlural(primary);
  const singularTitle = displayTitle(primary.name);
  const primaryLabel = (primary.fields.find((f) => f.primary)?.label ?? 'title').toLowerCase();
  const labels = primary.fields
    .filter((f) => !f.primary)
    .slice(0, 2)
    .map((f) => (f.label ?? pascal(f.name)).toLowerCase());
  const secondLabel = labels[0] ?? 'created date';
  const listTitle = displayTitle(humanPlural(primary));
  const detailTitle = `${singularTitle} Detail`;
  const formTitle = `Edit ${singularTitle}`;
  const claims = kpiPhrase(primary);
  const domainExtra = ENTITY_REQUIREMENT[primary.name] ?? DOMAIN_REQUIREMENT[domain];

  const drafts: RequirementDraft[] = [
    {
      statement: `Users can create, edit, and delete ${plural} from the ${listTitle}, ${detailTitle}, and ${formTitle} screens.`,
      category: 'functional',
      verifiedBy: 'widget-test',
    },
    {
      statement: `Each ${singular} shows ${primaryLabel} and ${secondLabel} consistently across list, detail, and form views.`,
      category: 'functional',
      verifiedBy: 'widget-test',
    },
    {
      statement: `The dashboard surfaces ${claims} and the newest ${plural} without leaving the home screen.`,
      category: 'ux',
      verifiedBy: 'score',
    },
    {
      statement: `Empty states explain how to add the first ${singular} and expose a primary action.`,
      category: 'ux',
      verifiedBy: 'score',
    },
    {
      statement: 'Every tappable control exposes a semantic label and a 48x48 logical-pixel touch target.',
      category: 'accessibility',
      verifiedBy: 'analyze',
    },
    {
      statement: 'Text and icons meet WCAG AA contrast in both light and dark themes.',
      category: 'accessibility',
      verifiedBy: 'score',
    },
    {
      statement: `Each ${singular} persists locally and survives an app restart with JSON round-trip fidelity.`,
      category: 'data',
      verifiedBy: 'widget-test',
    },
    {
      statement: `Lists remain smooth at 500 ${plural} through lazy builders and const widgets.`,
      category: 'performance',
      verifiedBy: 'score',
    },
    {
      statement: `Invalid ${singular} input is blocked with inline field errors before any write occurs.`,
      category: 'reliability',
      verifiedBy: 'widget-test',
    },
    {
      statement: `Deep links to a missing ${singular} id land on a friendly not-found state.`,
      category: 'reliability',
      verifiedBy: 'structural',
    },
    {
      statement: 'Theme mode selection persists across launches and applies to every screen.',
      category: 'data',
      verifiedBy: 'widget-test',
    },
  ];
  // Keep the domain-specific requirement when the screen set is non-trivial.
  if (screens.length >= 5) drafts.push(domainExtra);
  return drafts.map((draft, index) => ({
    id: `REQ-${String(index + 1).padStart(2, '0')}`,
    statement: draft.statement,
    category: draft.category,
    verifiedBy: draft.verifiedBy,
  }));
}

// ── assembly ──────────────────────────────────────────────────────────────

function appTagline(domain: AppDomain, primary: EntitySpec): string {
  const plural = humanPlural(primary);
  const singular = humanSingular(primary);
  const entityTagline: Record<string, string> = {
    Note: 'Capture ideas fast, keep them tagged, and find them again in seconds.',
    Lead: 'Move every lead from first contact to a confident close.',
    Invoice: 'Send invoices, track payments, and keep cash flow clear.',
    Expense: 'Split shared costs, settle up, and keep every balance clear.',
    Event: 'Run check-in, watch capacity, and keep the door moving.',
    Attendee: 'Check guests in quickly and keep the door moving.',
    Recipe: 'Save family recipes, follow the method, and cook with confidence.',
    Book: 'Keep a reading list, rate every book, and remember what mattered.',
    Message: 'Keep conversations moving in one calm, searchable thread.',
    Habit: 'Build daily habits, protect streaks, and see progress add up.',
    Workout: 'Log sessions, track intensity, and watch training add up.',
    Flashcard: 'Review cards daily, mark mastery, and make recall stick.',
    Pet: 'Keep every pet profile, birthday, and care note in one place.',
    Plant: 'Track watering, notes, and care for every plant you keep.',
  };
  if (entityTagline[primary.name]) return entityTagline[primary.name];
  switch (domain) {
    case 'productivity':
      return `Plan, track, and finish every ${singular} in one focused workspace.`;
    case 'commerce':
      return `List ${plural}, follow orders, and keep the storefront moving.`;
    case 'social':
      return `Share ${plural}, join conversations, and keep your community close.`;
    case 'finance':
      return `Track ${plural}, stay on budget, and see where the money goes.`;
    case 'health':
      return `Log ${plural}, build streaks, and watch your progress compound.`;
    case 'education':
      return `Organize ${plural}, study with intent, and finish every lesson.`;
    case 'travel':
      return `Plan ${plural}, save places, and keep the whole journey in one place.`;
    case 'media':
      return `Collect ${plural}, rate what you love, and never lose a recommendation.`;
    case 'developer':
      return `Capture ${plural}, tag them by language, and reuse proven code in seconds.`;
    case 'custom':
    default:
      return `Keep every ${singular} organized, searchable, and easy to update.`;
  }
}

function capabilitySentence(domain: AppDomain, primary: EntitySpec): string {
  const plural = humanPlural(primary);
  const entityCapability: Record<string, string> = {
    Note: 'Write, tag, and pin notes, then surface recent ideas one tap away.',
    Lead: 'Track stage, value, and next steps for every prospect in the pipeline.',
    Invoice: 'Draft invoices, watch due dates, and mark payments received.',
    Expense: 'Record who paid, who owes, and what is already settled.',
    Event: 'Plan capacity, check guests in, and keep the door moving.',
    Attendee: 'Register guests, set ticket types, and check them in on arrival.',
    Recipe: 'Capture ingredients, method, and cooking time for every dish.',
    Book: 'Track author, reading status, rating, and finish dates.',
    Message: 'Send messages, pin decisions, and keep every channel tidy.',
    Habit: 'Log completions, protect streaks, and review consistency over time.',
    Workout: 'Record duration, intensity, and notes after every session.',
    Flashcard: 'Build decks, review daily, and mark cards as mastered.',
    Pet: 'Store species, birthday, and care notes for every pet.',
    Plant: 'Track species, watering history, and care notes for every plant.',
  };
  if (entityCapability[primary.name]) return entityCapability[primary.name];
  switch (domain) {
    case 'productivity':
      return `Create ${plural}, prioritize what matters, and keep recent work one tap away.`;
    case 'commerce':
      return `List products, follow orders end to end, and keep inventory trustworthy.`;
    case 'social':
      return `Post updates, follow conversations, and keep the community close.`;
    case 'finance':
      return `Record ${plural}, watch totals, and keep every category in balance.`;
    case 'health':
      return `Log ${plural}, spot streaks, and turn small sessions into steady progress.`;
    case 'education':
      return `Organize ${plural}, track completion, and keep study sessions focused.`;
    case 'travel':
      return `Plan ${plural}, collect places, and keep the itinerary readable offline.`;
    case 'media':
      return `Curate ${plural}, rate favorites, and keep every recommendation searchable.`;
    case 'developer':
      return `Capture ${plural}, tag them by language, and reuse proven code fast.`;
    case 'custom':
    default:
      return `Create and edit ${plural} with validated forms and clear empty states.`;
  }
}

const VERB_TO_GERUND: Record<string, string> = {
  track: 'tracking',
  manage: 'managing',
  plan: 'planning',
  log: 'logging',
  save: 'saving',
  organize: 'organizing',
  create: 'creating',
  share: 'sharing',
  split: 'splitting',
  scan: 'scanning',
  monitor: 'monitoring',
  collect: 'collecting',
  follow: 'following',
  find: 'finding',
  browse: 'browsing',
  build: 'building',
};

const TOPIC_LEAD = new Set([
  'for', 'to', 'that', 'which', 'with', 'and', 'or', 'of', 'in', 'on', 'using', 'featuring',
  'including', 'plus', 'where', 'when', 'who', 'me', 'my', 'our', 'your', 'i', 'we', 'about',
]);

/** Prompt remainder used in the description; strips the app name prefix. */
function promptTopic(prompt: string, name: string): string {
  const tokens = normalizeText(prompt).split(' ').filter(Boolean);
  while (tokens.length > 0 && (IMPERATIVES.has(tokens[0]) || LEADING_FILLER.has(tokens[0]))) {
    tokens.shift();
  }
  while (tokens.length > 0 && GENERIC_PRODUCT_WORDS.has(tokens[0])) tokens.shift();
  const nameParts = words(name).map((part) => part.toLowerCase());
  if (nameParts.length > 0 && nameParts.every((part, index) => tokens[index] === part)) {
    tokens.splice(0, nameParts.length);
  }
  while (tokens.length > 0 && GENERIC_PRODUCT_WORDS.has(tokens[0])) tokens.shift();
  while (tokens.length > 0 && TOPIC_LEAD.has(tokens[0])) tokens.shift();
  if (tokens.length > 1 && VERB_TO_GERUND[tokens[0]]) tokens[0] = VERB_TO_GERUND[tokens[0]];
  const topic = tokens.slice(0, 14).join(' ').trim();
  return topic.replace(/\bi\b/g, 'I');
}

function descriptionFor(
  name: string,
  domain: AppDomain,
  primary: EntitySpec,
  prompt: string,
): string {
  const topic = promptTopic(prompt, name);
  const lead = topic ? `A ${DOMAIN_PURPOSE[domain]} app for ${topic}.` : `A ${DOMAIN_PURPOSE[domain]} app built around ${humanPlural(primary)}.`;
  return `${lead} ${capabilitySentence(domain, primary)} Everything is editable, searchable, and available offline.`;
}

/** Deterministic 6–12 seed count unless the caller or prompt asks for none. */
function seedCountFor(prompt: string, domain: AppDomain, primary: EntitySpec): number {
  const text = normalizeText(prompt);
  if (!text) return 0;
  if (matchesTerm(text, 'empty') || matchesTerm(text, 'blank') || matchesTerm(text, 'from scratch') ||
      matchesTerm(text, 'no seed') || matchesTerm(text, 'seedless') || matchesTerm(text, 'skeleton')) {
    return 0;
  }
  const source = `${domain}:${primary.name}:${prompt.length}:${prompt.slice(0, 64)}`;
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 6 + (Math.abs(hash) % 7);
}

function isDomain(value: unknown): value is AppDomain {
  return typeof value === 'string' && (APP_DOMAINS as readonly string[]).includes(value);
}

function buildSpec(input: CompileInput): AppSpec {
  const source = input && typeof input === 'object' ? input : ({} as CompileInput);
  const prompt = typeof source.prompt === 'string' ? source.prompt : source.prompt == null ? '' : String(source.prompt);
  const text = normalizeText(prompt);
  const domain: AppDomain = isDomain(source.domain) ? source.domain : inferDomain(prompt);
  const scopedText = normalizeText(prompt);
  let detected = detectTemplates(prompt);
  // Cross-domain leaks of very narrow templates — only allowed in their own scope.
  const eventsScope = /event|meet-?up|conference|attendee|guest|check-?in|badge/.test(scopedText);
  if (!eventsScope) detected = detected.filter((name) => name !== 'Attendee');
  const crmScope = /crm|lead|pipeline|prospect|deal|follow[- ]?up/.test(scopedText);
  if (crmScope) detected = detected.filter((name) => !['Product', 'Order'].includes(name));
  const entities = buildEntities(domain, detected, prompt);
  const primary = entities[0];
  const appName = (() => {
    const explicit = typeof source.appName === 'string' ? source.appName.trim() : '';
    if (explicit) return sanitizeAppName(explicit, domain);
    const derived = nameWordsFromPrompt(prompt);
    if (derived.length > 0) return sanitizeAppName(titleCaseTokens(derived), domain);
    return sanitizeAppName(FALLBACK_NAMES[domain], domain);
  })();
  const packageName = derivePackageName(source.packageName, appName);
  const screens = buildScreens(appName, domain, text, primary, entities);
  const flows = buildFlows(domain, primary, screens);
  const tagline = appTagline(domain, primary);
  const description = descriptionFor(appName, domain, primary, prompt);
  const seedColor = coerceHex(source.seedColor, DOMAIN_SEED[domain]);
  const seedCount =
    typeof source.seedCount === 'number' && Number.isFinite(source.seedCount)
      ? Math.max(0, Math.min(100, Math.floor(source.seedCount)))
      : seedCountFor(prompt, domain, primary);
  const backend = source.backend === 'supabase' ? 'supabase' : 'local';

  return {
    version: SPEC_VERSION,
    app: {
      name: appName,
      packageName,
      tagline,
      description,
      domain,
    },
    audience: {
      primary: DOMAIN_AUDIENCE[domain],
      secondary: `Teams evaluating ${appName} for ${DOMAIN_PURPOSE[domain]}`,
    },
    entities,
    screens,
    flows,
    design: {
      seedColor,
      brightness: 'system',
      spacing: [4, 8, 12, 16, 24, 32],
      radii: { sm: 8, md: 12, lg: 16, xl: 24 },
      motionMs: 200,
      shape: 'rounded',
    },
    requirements: buildRequirements(primary, screens, domain),
    backend,
    seedCount,
  };
}

/** Last-resort spec used only if an unforeseen runtime shape escapes. */
function fallbackSpec(input: CompileInput): AppSpec {
  const source = input && typeof input === 'object' ? input : ({} as CompileInput);
  const name = sanitizeAppName(source.appName, 'custom');
  const entity = instantiate(TEMPLATES.Item);
  const screens: ScreenSpec[] = [
    {
      id: 'dashboard',
      title: 'Dashboard',
      route: '/',
      kind: 'dashboard',
      purpose: 'KPI overview with recent items and quick actions.',
      entity: entity.name,
      primaryAction: 'New Item',
      inNavigation: true,
      icon: 'dashboard',
    },
    {
      id: 'item_list',
      title: 'Items',
      route: '/items',
      kind: 'list',
      purpose: 'Search and filter items; the empty state invites the first item.',
      entity: entity.name,
      primaryAction: 'New Item',
      inNavigation: true,
      icon: 'grid_view',
    },
    {
      id: 'item_form',
      title: 'Edit Item',
      route: '/items/:id/edit',
      kind: 'form',
      purpose: 'Validated editor for item fields with inline errors.',
      entity: entity.name,
      primaryAction: 'Save Item',
      icon: 'edit',
    },
    {
      id: 'settings',
      title: 'Settings',
      route: '/settings',
      kind: 'settings',
      purpose: 'Theme mode, data reset, and about details.',
      primaryAction: 'Reset local data',
      icon: 'settings',
    },
  ];
  return {
    version: SPEC_VERSION,
    app: {
      name,
      packageName: derivePackageName(source.packageName, name),
      tagline: 'A small, dependable app that keeps every item in reach.',
      description: 'A focused workspace for creating, editing, and finding items. Everything is editable, searchable, and available offline.',
      domain: 'custom',
    },
    audience: { primary: DOMAIN_AUDIENCE.custom },
    entities: [entity],
    screens,
    flows: [
      {
        id: 'create_item',
        name: 'Create an Item',
        steps: [
          step('dashboard', 'Open the dashboard'),
          step('item_form', 'Fill in the item and save'),
        ],
      },
      {
        id: 'browse_items',
        name: 'Browse Items',
        steps: [step('item_list', 'Search or filter items'), step('item_form', 'Adjust fields and save')],
      },
    ],
    design: {
      seedColor: coerceHex(source.seedColor, DOMAIN_SEED.custom),
      brightness: 'system',
      spacing: [4, 8, 12, 16, 24, 32],
      radii: { sm: 8, md: 12, lg: 16, xl: 24 },
      motionMs: 200,
      shape: 'rounded',
    },
    requirements: buildRequirements(entity, screens, 'custom'),
    backend: source.backend === 'supabase' ? 'supabase' : 'local',
    seedCount: typeof source.seedCount === 'number' && Number.isFinite(source.seedCount)
      ? Math.max(0, Math.min(100, Math.floor(source.seedCount)))
      : 6,
  };
}

/**
 * Compile any prompt into a structurally valid AppSpec.
 *
 * Guarantees:
 *  - never throws (empty, emoji-only, non-English, malformed runtime input);
 *  - deterministic (same input → deep-equal output);
 *  - `validateSpec(compileSpec(input)).ok === true`.
 */
export function compileSpec(input: CompileInput): AppSpec {
  try {
    return buildSpec(input ?? ({} as CompileInput));
  } catch {
    try {
      return fallbackSpec(input ?? ({} as CompileInput));
    } catch {
      return fallbackSpec({ prompt: '' });
    }
  }
}

