// Shared studio contracts — knowledge (RAG) + collaboration + plan.
// Transport-agnostic: the server router, stores, and UI all speak this vocabulary.

export type KnowledgeSourceKind = 'note' | 'url' | 'file' | 'project' | 'run';

export interface KnowledgeSource {
  id: string;
  projectId: string;
  kind: KnowledgeSourceKind;
  title: string;
  uri?: string;
  tags: string[];
  addedAt: string;
  updatedAt: string;
  bytes: number;
  chunkCount: number;
}

export interface KnowledgeChunk {
  id: string;
  sourceId: string;
  ordinal: number;
  heading: string;
  text: string;
  startLine: number;
  endLine: number;
  tokens: number;
  /** Hashed bag-of-words + char-trigram vector, L2-normalised. */
  embedding: number[];
  /** Net relevance-feedback votes (positive = boosted). */
  feedback: number;
}

export interface KnowledgeIndex {
  version: 1;
  projectId: string;
  updatedAt: string;
  sources: KnowledgeSource[];
  chunks: KnowledgeChunk[];
  /** Document frequency across the corpus (BM25 idf). */
  df: Record<string, number>;
  avgLength: number;
  totalTokens: number;
}

export interface KnowledgeHit {
  chunk: KnowledgeChunk;
  source: KnowledgeSource;
  score: number;
  bm25: number;
  cosine: number;
}

export interface SearchResult {
  projectId: string;
  query: string;
  hits: KnowledgeHit[];
  elapsedMs: number;
}

export interface KnowledgeStats {
  projectId: string;
  sourceCount: number;
  chunkCount: number;
  totalTokens: number;
  sources: KnowledgeSource[];
}

export interface IngestResult {
  source: KnowledgeSource;
  stats: KnowledgeStats;
}

/* ── Collaboration ─────────────────────────────────────────────────────── */

export interface CollabParticipant {
  clientId: string;
  name: string;
  color: string;
  view: string;
  filePath?: string;
  joinedAt: string;
  lastSeen: string;
}

export type CollabEventType =
  | 'hello'
  | 'presence'
  | 'activity'
  | 'comment'
  | 'comment.updated';

export interface CollabEvent {
  type: CollabEventType;
  at: string;
  actor?: { clientId: string; name: string; color: string };
  payload: unknown;
}

export interface CollabCommentReply {
  id: string;
  author: { name: string; color: string };
  body: string;
  createdAt: string;
}

export interface CollabComment {
  id: string;
  projectId: string;
  filePath: string;
  line: number;
  body: string;
  author: { name: string; color: string };
  createdAt: string;
  resolved: boolean;
  replies: CollabCommentReply[];
}

export interface CollabSnapshot {
  projectId: string;
  participants: CollabParticipant[];
  comments: CollabComment[];
}

/* ── Plan ──────────────────────────────────────────────────────────────── */

export interface PlanTask {
  id: string;
  title: string;
  detail: string;
  owner: 'ui' | 'data' | 'plumbing' | 'qa';
  estimate: 's' | 'm' | 'l';
  status: 'pending' | 'building' | 'done' | 'blocked';
}

export interface PlanScreen {
  name: string;
  route: string;
  purpose: string;
  widgets: string[];
}

export interface PlanEntity {
  name: string;
  description: string;
  fields: { name: string; type: string }[];
}

export interface PlanFlow {
  name: string;
  steps: string[];
}

export interface Plan {
  id: string;
  title: string;
  summary: string;
  domain: string;
  source: 'deterministic' | 'llm';
  screens: PlanScreen[];
  entities: PlanEntity[];
  flows: PlanFlow[];
  tasks: PlanTask[];
  design: { primaryColor: string; mode: 'light' | 'dark' | 'system' };
  risks: string[];
}
