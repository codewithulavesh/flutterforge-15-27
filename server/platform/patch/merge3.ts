/**
 * Three-way line merge (base / ours / theirs).
 *
 * Algorithm
 * ---------
 * Base→ours and base→theirs change regions are computed with the Myers line
 * diff from `./diff.js` and turned into *change chunks*: maximal runs of
 * non-equal operations carrying the replacement lines and their terminators.
 * Chunks from both sides that overlap or touch (including zero-width
 * insertions at a shared position) are grouped into clusters. Clusters are
 * emitted in base order. Non-clustered chunks on the same side never
 * overlap, so emission is deterministic and conflict ordering is the order of
 * the corresponding base regions.
 *
 * For each cluster the base segment it covers is re-rendered on each side.
 * Identical renders deduplicate; differing renders produce a conflict block
 * with `<<<<<<< label` / `=======` / `>>>>>>> label` markers. The union rule
 * handles delete-vs-modify (empty vs. modified render), add/add at the same
 * position (empty base segment, both sides insert), and overlapping deletes.
 *
 * CRLF: the merged text uses the majority newline style of the three inputs;
 * when one side is unchanged the other side is returned verbatim (newline
 * style and final-newline property included). Conflict line numbers are
 * 1-based and count lines of the resulting text.
 */
import { diffLines, splitLines } from './diff.js';
import type { DiffOperation, SplitLinesResult } from './diff.js';

export interface Merge3Input {
  base: string;
  ours: string;
  theirs: string;
  oursLabel?: string;
  theirsLabel?: string;
  /** Optional path, accepted for API symmetry with patch tooling. */
  path?: string;
}

export interface Merge3Conflict {
  /** 1-based line in the result text where the `<<<<<<<` marker sits. */
  startLine: number;
  /** 1-based line in the result text where the `>>>>>>>` marker sits. */
  endLine: number;
  oursLines: string[];
  theirsLines: string[];
}

export interface Merge3Result {
  ok: boolean;
  text: string;
  conflicts: Merge3Conflict[];
  conflictCount: number;
}

interface PreparedSide {
  parsed: SplitLinesResult;
  lines: string[];
  terminated: boolean[];
}

function prepare(text: string): PreparedSide {
  const parsed = splitLines(text);
  const terminated = parsed.lines.map(
    (_, i) => i < parsed.lines.length - 1 || parsed.finalNewline,
  );
  return { parsed, lines: parsed.lines, terminated };
}

interface ChangeChunk {
  side: 'ours' | 'theirs';
  /** Base range, zero-based half-open. Zero-width for pure insertions. */
  aStart: number;
  aEnd: number;
  lines: string[];
  terms: boolean[];
}

function extractChunks(
  side: 'ours' | 'theirs',
  operations: readonly DiffOperation[],
  source: PreparedSide,
): ChangeChunk[] {
  const chunks: ChangeChunk[] = [];
  let current: ChangeChunk | null = null;
  const flush = (): void => {
    if (current) chunks.push(current);
    current = null;
  };

  for (const operation of operations) {
    if (operation.type === 'equal') {
      flush();
      continue;
    }
    if (!current) {
      current = { side, aStart: operation.aStart, aEnd: operation.aEnd, lines: [], terms: [] };
    }
    current.aEnd = Math.max(current.aEnd, operation.aEnd);
    if (operation.type === 'insert') {
      for (let i = operation.bStart; i < operation.bEnd; i += 1) {
        current.lines.push(source.lines[i]);
        current.terms.push(source.terminated[i]);
      }
    }
  }
  flush();
  return chunks;
}

interface Cluster {
  /** Union base range covered by this cluster. */
  start: number;
  end: number;
  chunks: ChangeChunk[];
}

/**
 * Group chunks that overlap or touch into clusters. "Touch" means
 * `chunk.aStart <= cluster.end`, which catches zero-width insertions at the
 * cluster boundary. Deterministic: chunks are sorted by base position, with
 * ours before theirs for ties.
 */
function buildClusters(chunks: readonly ChangeChunk[]): Cluster[] {
  const sorted = [...chunks].sort((a, b) => {
    if (a.aStart !== b.aStart) return a.aStart - b.aStart;
    if (a.aEnd !== b.aEnd) return a.aEnd - b.aEnd;
    return a.side === b.side ? 0 : a.side === 'ours' ? -1 : 1;
  });

  const clusters: Cluster[] = [];
  for (const chunk of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && chunk.aStart <= last.end) {
      last.end = Math.max(last.end, chunk.aEnd);
      last.chunks.push(chunk);
    } else {
      clusters.push({ start: chunk.aStart, end: chunk.aEnd, chunks: [chunk] });
    }
  }
  return clusters;
}

interface RenderedSegment {
  lines: string[];
  terms: boolean[];
}

/** Re-render the base segment [start, end) with one side's chunks applied. */
function renderSegment(
  base: PreparedSide,
  start: number,
  end: number,
  sideChunks: readonly ChangeChunk[],
): RenderedSegment {
  const lines: string[] = [];
  const terms: boolean[] = [];
  let cursor = start;
  const sorted = [...sideChunks].sort((a, b) => a.aStart - b.aStart || a.aEnd - b.aEnd);
  for (const chunk of sorted) {
    for (let i = cursor; i < chunk.aStart; i += 1) {
      lines.push(base.lines[i]);
      terms.push(base.terminated[i]);
    }
    for (let i = 0; i < chunk.lines.length; i += 1) {
      lines.push(chunk.lines[i]);
      terms.push(chunk.terms[i]);
    }
    cursor = Math.max(cursor, chunk.aEnd);
  }
  for (let i = cursor; i < end; i += 1) {
    lines.push(base.lines[i]);
    terms.push(base.terminated[i]);
  }
  return { lines, terms };
}

function segmentEquals(a: RenderedSegment, b: RenderedSegment): boolean {
  if (a.lines.length !== b.lines.length) return false;
  for (let i = 0; i < a.lines.length; i += 1) {
    if (a.lines[i] !== b.lines[i] || a.terms[i] !== b.terms[i]) return false;
  }
  return true;
}

function sanitizeLabel(label: string | undefined, fallback: string): string {
  const value = label === undefined ? fallback : String(label);
  // Markers must stay on one line.
  return value.replace(/[\r\n]+/g, ' ').trim() || fallback;
}

/** Majority rule across the three inputs; ties are impossible with three. */
function mergedCrlf(a: boolean, b: boolean, c: boolean): boolean {
  return Number(a) + Number(b) + Number(c) >= 2;
}

/**
 * Merge three texts. Returns the merged text, or the other side verbatim when
 * exactly one side changed. `conflicts` lists every conflict block in result
 * order (deterministic — conflicts appear in base order); `ok` is true iff
 * there are none.
 */
export function merge3(input: Merge3Input): Merge3Result {
  const { base, ours, theirs, path } = input;
  if (typeof base !== 'string' || typeof ours !== 'string' || typeof theirs !== 'string') {
    throw new TypeError('base, ours and theirs must be strings.');
  }
  // Accepted for API symmetry; reserved for diagnostics.
  void path;

  // Fast path: unchanged sides return the other side byte-verbatim. This
  // preserves CRLF style and final-newline properties exactly.
  if (ours === theirs) {
    return { ok: true, text: ours, conflicts: [], conflictCount: 0 };
  }
  if (base === ours) {
    return { ok: true, text: theirs, conflicts: [], conflictCount: 0 };
  }
  if (base === theirs) {
    return { ok: true, text: ours, conflicts: [], conflictCount: 0 };
  }

  const oursLabel = sanitizeLabel(input.oursLabel, 'ours');
  const theirsLabel = sanitizeLabel(input.theirsLabel, 'theirs');

  const baseSide = prepare(base);
  const oursSide = prepare(ours);
  const theirsSide = prepare(theirs);

  const oursOps = diffLines(
    { lines: baseSide.lines, finalNewline: baseSide.parsed.finalNewline },
    { lines: oursSide.lines, finalNewline: oursSide.parsed.finalNewline },
  );
  const theirsOps = diffLines(
    { lines: baseSide.lines, finalNewline: baseSide.parsed.finalNewline },
    { lines: theirsSide.lines, finalNewline: theirsSide.parsed.finalNewline },
  );

  const oursChunks = extractChunks('ours', oursOps, oursSide);
  const theirsChunks = extractChunks('theirs', theirsOps, theirsSide);
  const clusters = buildClusters([...oursChunks, ...theirsChunks]);

  const outLines: string[] = [];
  const outTerms: boolean[] = [];
  const conflicts: Merge3Conflict[] = [];

  const copyBase = (from: number, to: number): void => {
    for (let i = from; i < to; i += 1) {
      outLines.push(baseSide.lines[i]);
      outTerms.push(baseSide.terminated[i]);
    }
  };
  const emitSegment = (segment: RenderedSegment): void => {
    for (let i = 0; i < segment.lines.length; i += 1) {
      outLines.push(segment.lines[i]);
      outTerms.push(segment.terms[i]);
    }
  };
  const pushMarker = (text: string): void => {
    outLines.push(text);
    outTerms.push(true);
  };

  let cursor = 0;
  for (const cluster of clusters) {
    copyBase(cursor, cluster.start);

    const sideChunks = (side: 'ours' | 'theirs'): ChangeChunk[] =>
      cluster.chunks.filter((chunk) => chunk.side === side);
    const oursRender = renderSegment(baseSide, cluster.start, cluster.end, sideChunks('ours'));
    const theirsRender = renderSegment(baseSide, cluster.start, cluster.end, sideChunks('theirs'));

    const hasOurs = cluster.chunks.some((chunk) => chunk.side === 'ours');
    const hasTheirs = cluster.chunks.some((chunk) => chunk.side === 'theirs');

    if (!hasTheirs) {
      emitSegment(oursRender);
    } else if (!hasOurs) {
      emitSegment(theirsRender);
    } else if (segmentEquals(oursRender, theirsRender)) {
      // Identical changes on both sides: keep once, no conflict.
      emitSegment(oursRender);
    } else {
      const startLine = outLines.length + 1;
      pushMarker(`<<<<<<< ${oursLabel}`);
      emitSegment(oursRender);
      pushMarker('=======');
      emitSegment(theirsRender);
      pushMarker(`>>>>>>> ${theirsLabel}`);
      conflicts.push({
        startLine,
        endLine: outLines.length,
        oursLines: oursRender.lines.slice(),
        theirsLines: theirsRender.lines.slice(),
      });
    }
    cursor = cluster.end;
  }
  copyBase(cursor, baseSide.lines.length);

  // Assemble: every line except possibly the last is terminated. The last
  // line honours its source's termination flag, which is how a deleted
  // trailing newline survives a merge.
  const crlf = mergedCrlf(baseSide.parsed.crlf, oursSide.parsed.crlf, theirsSide.parsed.crlf);
  const eol = crlf ? '\r\n' : '\n';
  let text: string;
  if (outLines.length === 0) {
    text = '';
  } else {
    const body = outLines.join(eol);
    text = outTerms[outTerms.length - 1] ? `${body}${eol}` : body;
  }

  return {
    ok: conflicts.length === 0,
    text,
    conflicts,
    conflictCount: conflicts.length,
  };
}
