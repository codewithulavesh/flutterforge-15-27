// Deterministic, offline embeddings: hashed bag-of-words + character trigrams.
// Not a transformer — but a stable, dependency-free signal that makes the hybrid
// retriever robust to typos and word-order changes. A remote embeddings endpoint
// can be layered in later without changing the store interface.

export const EMBED_DIM = 256;

/** FNV-1a 32-bit string hash — stable across processes and platforms. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function bucket(value: number): number {
  return value % EMBED_DIM;
}

function add(v: number[], index: number, weight: number): void {
  v[index] += weight;
}

/** Character trigrams of a lowercased, space-padded token. */
function trigrams(token: string): string[] {
  const padded = ` ${token} `;
  if (padded.length < 3) return [token];
  const out: string[] = [];
  for (let i = 0; i + 3 <= padded.length; i += 1) out.push(padded.slice(i, i + 3));
  return out;
}

export function embedText(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  const lowered = text.toLowerCase();
  // Exact terms (hashed) with sublinear tf weighting.
  const terms = new Map<string, number>();
  for (const m of lowered.matchAll(/[a-z0-9]{2,}/g)) {
    terms.set(m[0], (terms.get(m[0]) ?? 0) + 1);
  }
  for (const [term, freq] of terms) {
    add(v, bucket(fnv1a(term)), 1 + Math.log(freq));
    for (const tg of trigrams(term)) add(v, bucket(fnv1a('tg:' + tg)), 0.6);
  }
  return l2Normalise(v);
}

export function l2Normalise(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i += 1) dot += a[i] * b[i];
  return dot; // inputs are already L2-normalised → cosine == dot product
}
