// Tokenisation for BM25 (exact terms) and feature extraction for embeddings.

export interface Tokenized {
  /** Exact term frequencies, stopword-filtered, lowercased. */
  terms: Map<string, number>;
  length: number;
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'while',
  'of', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'as', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'shall',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'we', 'our', 'you', 'your', 'he', 'she', 'his', 'her', 'i', 'me', 'my',
  'mine', 'not', 'no', 'nor', 'so', 'such', 'than', 'too', 'very', 'just',
  'also', 'into', 'over', 'under', 'again', 'further', 'once', 'here', 'there',
  'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more',
  'most', 'other', 'some', 'only', 'own', 'same', 's', 't', 'don', 'now',
  // Flutter/Dart code noise
  'void', 'final', 'const', 'class', 'return', 'import', 'export', 'new',
  'super', 'override', 'widget', 'build', 'context', 'static', 'async', 'await',
  'string', 'int', 'double', 'bool', 'var', 'dynamic', 'extends', 'implements',
]);

/** Split camelCase/snake_case/kebab-case and lower-case into raw words. */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase → camel Case
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2') // ACRONYMWord → ACRONYM Word
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

export function tokenize(text: string): Tokenized {
  const terms = new Map<string, number>();
  let length = 0;
  for (const w of words(text)) {
    terms.set(w, (terms.get(w) ?? 0) + 1);
    length += 1;
  }
  return { terms, length };
}

export function tokenizeQuery(text: string): string[] {
  return Array.from(new Set(words(text)));
}
