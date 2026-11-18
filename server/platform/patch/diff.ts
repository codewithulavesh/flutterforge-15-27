/**
 * Line-oriented diff and unified-patch engine.
 *
 * Line model
 * ----------
 * `splitLines` returns line *content* without its terminator. A CRLF pair is
 * treated as one terminator, so a CRLF file and an LF file diff equal line by
 * line; `crlf` records whether CRLF is the dominant style so callers can
 * re-emit text in the original style. Only the final line may be unterminated
 * — that distinction is part of line identity during diffing, which is what
 * makes appending a trailing newline a real, observable change.
 *
 * Ranges in `DiffOperation` are zero-based and half-open over the line arrays.
 *
 * Algorithm
 * ---------
 * `diffLines` trims the common prefix and suffix, then runs Myers' O(ND)
 * middle-snake search with linear space. Two guards keep the work bounded:
 * inputs longer than {@link MYERS_MAX_LINES_PER_SIDE} per side skip Myers
 * entirely, and the edit-distance budget {@link MYERS_MAX_EDIT_DISTANCE}
 * caps how much search the middle snake may do. Either guard trip falls back
 * to a prefix/suffix-trim + replace-block diff, which is correct for any
 * input (it just sacrifices hunk granularity). Output is deterministic.
 */

export interface SplitLinesResult {
  lines: string[];
  finalNewline: boolean;
  /** True when CRLF terminators outnumber (or tie and beat zero) lone LFs. */
  crlf: boolean;
}

export interface DiffOperation {
  type: 'equal' | 'insert' | 'delete';
  /** Zero-based, half-open range into the old line array. */
  aStart: number;
  aEnd: number;
  /** Zero-based, half-open range into the new line array. */
  bStart: number;
  bEnd: number;
  /**
   * The line content this operation covers. `equal`/`delete` carry the old
   * lines, `insert` carries the new lines.
   */
  lines: string[];
}

export type DiffInput =
  | string
  | readonly string[]
  | { lines: readonly string[]; finalNewline?: boolean };

/** Inputs larger than this many lines per side skip the Myers search. */
export const MYERS_MAX_LINES_PER_SIDE = 40_000;
/**
 * Edit-distance budget for the Myers search. Past this the prefix/suffix
 * trim + replace-block fallback is used instead. Keeps worst-case work
 * bounded even for pathological inputs.
 */
export const MYERS_MAX_EDIT_DISTANCE = 2048;

interface PreparedInput {
  lines: string[];
  /** terminated[i] === true when line i is followed by a terminator. */
  terminated: boolean[];
  finalNewline: boolean;
}

function fail(message: string): never {
  throw new TypeError(message);
}

function checkText(text: unknown, label: string): string {
  if (typeof text !== 'string') fail(`${label} must be a string.`);
  return text;
}

function checkPath(path: unknown, label: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    fail(`${label} must be a non-empty string.`);
  }
  if (/[\0\r\n]/.test(path)) {
    fail(`${label} must not contain NUL or newline characters.`);
  }
  return path;
}

/**
 * Split text into lines. CRLF is recognised as a single terminator and is
 * not included in the line content; a lone CR is preserved as content.
 * `finalNewline` reports whether the last line was terminated.
 */
export function splitLines(text: string): SplitLinesResult {
  const checked = checkText(text, 'text');
  const lines: string[] = [];
  let crlfCount = 0;
  let lfCount = 0;

  let index = 0;
  while (index < checked.length) {
    const newline = checked.indexOf('\n', index);
    if (newline === -1) {
      lines.push(checked.slice(index));
      index = checked.length;
      break;
    }
    let end = newline;
    if (newline > index && checked.charCodeAt(newline - 1) === 13 /* \r */) {
      end = newline - 1;
      crlfCount += 1;
    } else {
      lfCount += 1;
    }
    lines.push(checked.slice(index, end));
    index = newline + 1;
  }

  return {
    lines,
    finalNewline: checked.endsWith('\n'),
    crlf: crlfCount > 0 && crlfCount >= lfCount,
  };
}

function prepareInput(input: DiffInput, label: string): PreparedInput {
  if (typeof input === 'string') {
    const parsed = splitLines(input);
    const terminated = parsed.lines.map(
      (_, i) => i < parsed.lines.length - 1 || parsed.finalNewline,
    );
    return { lines: parsed.lines, terminated, finalNewline: parsed.finalNewline };
  }

  let rawLines: readonly string[];
  let finalNewline: boolean;
  if (Array.isArray(input)) {
    rawLines = input as readonly string[];
    finalNewline = true;
  } else if (
    input !== null &&
    typeof input === 'object' &&
    Array.isArray((input as { lines?: unknown }).lines)
  ) {
    const seq = input as { lines: readonly string[]; finalNewline?: boolean };
    rawLines = seq.lines;
    finalNewline = seq.finalNewline ?? true;
  } else {
    fail(`${label} must be a string, an array of lines, or a { lines, finalNewline } sequence.`);
  }

  const lines: string[] = [];
  for (const line of rawLines) {
    if (typeof line !== 'string') fail(`${label} contains a non-string line.`);
    if (line.includes('\n') || line.includes('\r')) {
      fail(`${label} lines must not contain line terminators.`);
    }
    lines.push(line);
  }
  const terminated = lines.map((_, i) => i < lines.length - 1 || finalNewline);
  return { lines, terminated, finalNewline };
}

function sameLine(a: PreparedInput, ai: number, b: PreparedInput, bi: number): boolean {
  // Termination is part of line identity: "a\n" and "a" (unterminated) differ.
  return a.lines[ai] === b.lines[bi] && a.terminated[ai] === b.terminated[bi];
}

interface SplitPoint {
  x: number;
  y: number;
}

interface SearchState {
  steps: number;
  aborted: boolean;
}

function charge(state: SearchState, amount = 1): boolean {
  state.steps += amount;
  if (state.steps > 8_000_000) {
    state.aborted = true;
    return false;
  }
  return true;
}

/**
 * Myers' middle-snake search in linear space. Returns where the forward and
 * reverse frontiers meet, in absolute coordinates, or null when no split
 * exists within the edit-distance budget.
 */
function bisect(
  a: PreparedInput,
  aLo: number,
  aHi: number,
  b: PreparedInput,
  bLo: number,
  bHi: number,
  state: SearchState,
): SplitPoint | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.min(Math.ceil((n + m) / 2), MYERS_MAX_EDIT_DISTANCE);
  if (maxD <= 0) return null;

  // Frontier arrays indexed by k + OFFSET; size covers 2 * maxD + a margin.
  const offset = maxD + 1;
  const length = 2 * maxD + 3;
  const forward = new Int32Array(length).fill(-1);
  const reverse = new Int32Array(length).fill(-1);
  forward[offset + 1] = 0;
  reverse[offset + 1] = 0;

  const delta = n - m;
  const front = (delta & 1) !== 0;
  let k1Start = 0;
  let k1End = 0;
  let k2Start = 0;
  let k2End = 0;

  for (let d = 0; d < maxD; d += 1) {
    if (!charge(state)) return null;

    for (let k1 = -d + k1Start; k1 <= d - k1End; k1 += 2) {
      if (!charge(state)) return null;
      const k1Offset = offset + k1;
      let x1: number;
      if (k1 === -d || (k1 !== d && forward[k1Offset - 1] < forward[k1Offset + 1])) {
        x1 = forward[k1Offset + 1];
      } else {
        x1 = forward[k1Offset - 1] + 1;
      }
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && sameLine(a, aLo + x1, b, bLo + y1)) {
        x1 += 1;
        y1 += 1;
        if (!charge(state)) return null;
      }
      forward[k1Offset] = x1;

      if (x1 > n) {
        k1End += 2;
      } else if (y1 > m) {
        k1Start += 2;
      } else if (front) {
        const k2Offset = offset + delta - k1;
        if (k2Offset >= 0 && k2Offset < length && reverse[k2Offset] !== -1) {
          const x2 = n - reverse[k2Offset];
          if (x1 >= x2) return { x: aLo + x1, y: bLo + y1 };
        }
      }
    }

    for (let k2 = -d + k2Start; k2 <= d - k2End; k2 += 2) {
      if (!charge(state)) return null;
      const k2Offset = offset + k2;
      let x2: number;
      if (k2 === -d || (k2 !== d && reverse[k2Offset - 1] < reverse[k2Offset + 1])) {
        x2 = reverse[k2Offset + 1];
      } else {
        x2 = reverse[k2Offset - 1] + 1;
      }
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && sameLine(a, aHi - x2 - 1, b, bHi - y2 - 1)) {
        x2 += 1;
        y2 += 1;
        if (!charge(state)) return null;
      }
      reverse[k2Offset] = x2;

      if (x2 > n) {
        k2End += 2;
      } else if (y2 > m) {
        k2Start += 2;
      } else if (!front) {
        const k1Offset = offset + delta - k2;
        if (k1Offset >= 0 && k1Offset < length && forward[k1Offset] !== -1) {
          const x1 = forward[k1Offset];
          const y1 = x1 - (delta - k2);
          const x2Abs = n - x2;
          if (x1 >= x2Abs) return { x: aLo + x1, y: bLo + y1 };
        }
      }
    }
  }
  return null;
}

function collectMatches(
  a: PreparedInput,
  b: PreparedInput,
  state: SearchState,
): Array<[number, number]> | null {
  const matches: Array<[number, number]> = [];

  const walk = (a0: number, a1: number, b0: number, b1: number, depth = 0): boolean => {
    while (a0 < a1 && b0 < b1 && sameLine(a, a0, b, b0)) {
      matches.push([a0, b0]);
      a0 += 1;
      b0 += 1;
      if (!charge(state)) return false;
    }

    let suffix = 0;
    while (a0 < a1 && b0 < b1 && sameLine(a, a1 - 1, b, b1 - 1)) {
      a1 -= 1;
      b1 -= 1;
      suffix += 1;
      if (!charge(state)) return false;
    }

    if (a0 < a1 && b0 < b1) {
      if (depth < 512) {
        const split = bisect(a, a0, a1, b, b0, b1, state);
        if (state.aborted) return false;
        // A split on the boundary is valid progress as long as one side
        // shrank: recurse both halves. Boundary splits are common (a side is
        // fully consumed by the middle snake) and must not be dropped.
        if (
          split &&
          split.x > a0 &&
          split.y > b0 &&
          (split.x < a1 || split.y < b1)
        ) {
          if (!walk(a0, split.x, b0, split.y, depth + 1)) return false;
          if (!walk(split.x, a1, split.y, b1, depth + 1)) return false;
        }
      }
    }

    // Re-attach the suffix matches that were trimmed for the search.
    for (let i = 0; i < suffix; i += 1) matches.push([a1 + i, b1 + i]);
    return true;
  };

  return walk(0, a.lines.length, 0, b.lines.length) ? matches : null;
}

function pushOperation(
  operations: DiffOperation[],
  type: DiffOperation['type'],
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
  lines: string[],
): void {
  // Merge into the previous operation when it has the same type and touches.
  const last = operations[operations.length - 1];
  if (last && last.type === type && last.aEnd === aStart && last.bEnd === bStart) {
    last.aEnd = aEnd;
    last.bEnd = bEnd;
    for (const line of lines) last.lines.push(line);
    return;
  }
  operations.push({ type, aStart, aEnd, bStart, bEnd, lines });
}

function buildOperations(
  a: PreparedInput,
  b: PreparedInput,
  matches: ReadonlyArray<[number, number]>,
): DiffOperation[] {
  const operations: DiffOperation[] = [];
  let ai = 0;
  let bi = 0;
  for (const [ma, mb] of matches) {
    if (ai < ma) {
      pushOperation(operations, 'delete', ai, ma, bi, bi, a.lines.slice(ai, ma));
    }
    if (bi < mb) {
      pushOperation(operations, 'insert', ma, ma, bi, mb, b.lines.slice(bi, mb));
    }
    pushOperation(operations, 'equal', ma, ma + 1, mb, mb + 1, [a.lines[ma]]);
    ai = ma + 1;
    bi = mb + 1;
  }
  if (ai < a.lines.length) {
    pushOperation(operations, 'delete', ai, a.lines.length, bi, bi, a.lines.slice(ai));
  }
  if (bi < b.lines.length) {
    pushOperation(operations, 'insert', a.lines.length, a.lines.length, bi, b.lines.length, b.lines.slice(bi));
  }
  return operations;
}

/**
 * Prefix/suffix-trim + replace-block diff. Correct for arbitrary inputs; used
 * when Myers is skipped or gives up. After identical leading and trailing
 * lines are matches, the differing middle is one delete plus one insert.
 */
function fallbackOperations(a: PreparedInput, b: PreparedInput): DiffOperation[] {
  let prefix = 0;
  const maxPrefix = Math.min(a.lines.length, b.lines.length);
  while (prefix < maxPrefix && sameLine(a, prefix, b, prefix)) prefix += 1;

  let aEnd = a.lines.length;
  let bEnd = b.lines.length;
  while (aEnd > prefix && bEnd > prefix && sameLine(a, aEnd - 1, b, bEnd - 1)) {
    aEnd -= 1;
    bEnd -= 1;
  }

  const operations: DiffOperation[] = [];
  if (prefix > 0) {
    operations.push({
      type: 'equal',
      aStart: 0,
      aEnd: prefix,
      bStart: 0,
      bEnd: prefix,
      lines: a.lines.slice(0, prefix),
    });
  }
  if (aEnd > prefix) {
    operations.push({
      type: 'delete',
      aStart: prefix,
      aEnd,
      bStart: prefix,
      bEnd: prefix,
      lines: a.lines.slice(prefix, aEnd),
    });
  }
  if (bEnd > prefix) {
    operations.push({
      type: 'insert',
      aStart: aEnd,
      aEnd,
      bStart: prefix,
      bEnd,
      lines: b.lines.slice(prefix, bEnd),
    });
  }
  if (aEnd < a.lines.length) {
    operations.push({
      type: 'equal',
      aStart: aEnd,
      aEnd: a.lines.length,
      bStart: bEnd,
      bEnd: b.lines.length,
      lines: a.lines.slice(aEnd),
    });
  }
  return operations;
}

/**
 * Diff two line sequences (zero-based, half-open ranges). Falls back to a
 * trim-then-replace diff when either side exceeds
 * {@link MYERS_MAX_LINES_PER_SIDE} lines or the edit distance budget, so the
 * work stays bounded on pathological inputs.
 */
export function diffLines(aInput: DiffInput, bInput: DiffInput): DiffOperation[] {
  const a = prepareInput(aInput, 'a');
  const b = prepareInput(bInput, 'b');

  if (a.lines.length > MYERS_MAX_LINES_PER_SIDE || b.lines.length > MYERS_MAX_LINES_PER_SIDE) {
    return fallbackOperations(a, b);
  }

  const state: SearchState = { steps: 0, aborted: false };
  const matches = collectMatches(a, b, state);
  if (!matches || state.aborted) return fallbackOperations(a, b);

  const editDistance = a.lines.length + b.lines.length - 2 * matches.length;
  if (editDistance > MYERS_MAX_EDIT_DISTANCE) return fallbackOperations(a, b);

  return buildOperations(a, b, matches);
}

export interface DiffSummary {
  added: number;
  removed: number;
}

/** Count inserted and deleted lines between two inputs. */
export function summarizeDiff(a: DiffInput, b: DiffInput): DiffSummary {
  let added = 0;
  let removed = 0;
  for (const operation of diffLines(a, b)) {
    if (operation.type === 'insert') added += operation.lines.length;
    else if (operation.type === 'delete') removed += operation.lines.length;
  }
  return { added, removed };
}

export interface UnifiedDiffOptions {
  path: string;
  oldText: string;
  newText: string;
  /** Lines of context around each change. Defaults to 3. */
  context?: number;
}

/** Zero-based position + count. Unified headers display count === 0 with the
 * position *before* the gap (`-0,0` for an insertion into an empty file) and
 * 1-based positions otherwise, omitting `,1` when the count is exactly one. */
function formatRange(start0: number, count: number): string {
  if (count === 0) return `${start0},0`;
  const start = start0 + 1;
  return count === 1 ? `${start}` : `${start},${count}`;
}

interface HunkRange {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

const NO_NEWLINE_MARKER = '\\ No newline at end of file';

/**
 * Produce a unified diff with `--- a/path` / `+++ b/path` headers. Identical
 * inputs yield the empty string. Hunks merge their context when the gap
 * between changes is at most twice the context size. Lines are emitted with
 * LF terminators and a `\ No newline at end of file` marker wherever a final
 * line is unterminated.
 */
export function createUnifiedDiff(options: UnifiedDiffOptions): string {
  const path = checkPath(options.path, 'path');
  const oldText = checkText(options.oldText, 'oldText');
  const newText = checkText(options.newText, 'newText');
  const context =
    options.context === undefined || Number.isNaN(options.context)
      ? 3
      : Math.max(0, Math.min(10_000, Math.floor(options.context)));

  const oldParsed = splitLines(oldText);
  const newParsed = splitLines(newText);
  const oldSeq = { lines: oldParsed.lines, finalNewline: oldParsed.finalNewline };
  const newSeq = { lines: newParsed.lines, finalNewline: newParsed.finalNewline };
  const operations = diffLines(oldSeq, newSeq);

  const hasChanges = operations.some((operation) => operation.type !== 'equal');
  if (!hasChanges) return '';

  // Group change operations into hunks, merging when their context would
  // touch or overlap (gap between changes <= 2 * context).
  const changeIndices: number[] = [];
  for (let i = 0; i < operations.length; i += 1) {
    if (operations[i].type !== 'equal') changeIndices.push(i);
  }

  const groups: Array<{ first: number; last: number }> = [];
  let groupStart = changeIndices[0];
  let groupEnd = changeIndices[0];
  for (let i = 1; i < changeIndices.length; i += 1) {
    const index = changeIndices[i];
    const gap = operations[index].aStart - operations[groupEnd].aEnd;
    const bGap = operations[index].bStart - operations[groupEnd].bEnd;
    if (Math.max(gap, bGap) <= context * 2) {
      groupEnd = index;
    } else {
      groups.push({ first: groupStart, last: groupEnd });
      groupStart = index;
      groupEnd = index;
    }
  }
  groups.push({ first: groupStart, last: groupEnd });

  const oldTerminated = oldParsed.lines.map(
    (_, i) => i < oldParsed.lines.length - 1 || oldParsed.finalNewline,
  );
  const newTerminated = newParsed.lines.map(
    (_, i) => i < newParsed.lines.length - 1 || newParsed.finalNewline,
  );

  const output: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let opIndex = 0;

  const emit = (prefix: string, line: string, terminated: boolean): void => {
    output.push(`${prefix}${line}`);
    if (!terminated) output.push(NO_NEWLINE_MARKER);
  };

  for (const group of groups) {
    const firstChange = operations[group.first];
    const lastChange = operations[group.last];
    // Clamp the context window; bStart/bEnd use the same leading/trailing
    // context sizes so both sides stay aligned.
    const leading = Math.min(context, firstChange.aStart);
    const aStart = firstChange.aStart - leading;
    const bStart = Math.max(0, firstChange.bStart - leading);
    const trailing = Math.min(context, oldParsed.lines.length - lastChange.aEnd);
    const aEnd = lastChange.aEnd + trailing;
    const bEnd = Math.min(newParsed.lines.length, lastChange.bEnd + trailing);
    const hunk: HunkRange = { aStart, aEnd, bStart, bEnd };

    // Fast-forward past operations that end before this hunk.
    while (opIndex < operations.length) {
      const operation = operations[opIndex];
      const before =
        operation.type === 'insert'
          ? operation.aStart < hunk.aStart
          : operation.aEnd <= hunk.aStart;
      if (!before) break;
      opIndex += 1;
    }

    output.push(`@@ -${formatRange(hunk.aStart, hunk.aEnd - hunk.aStart)} +${formatRange(hunk.bStart, hunk.bEnd - hunk.bStart)} @@`);

    let cursor = opIndex;
    while (cursor < operations.length) {
      const operation = operations[cursor];
      if (operation.type === 'insert') {
        if (operation.aStart > hunk.aEnd) break;
        if (operation.aStart < hunk.aStart) {
          cursor += 1;
          continue;
        }
        for (let i = operation.bStart; i < operation.bEnd; i += 1) {
          emit('+', newParsed.lines[i], newTerminated[i]);
        }
        cursor += 1;
        continue;
      }
      if (operation.aStart >= hunk.aEnd) break;
      const from = Math.max(operation.aStart, hunk.aStart);
      const to = Math.min(operation.aEnd, hunk.aEnd);
      for (let i = from; i < to; i += 1) {
        if (operation.type === 'equal') emit(' ', oldParsed.lines[i], oldTerminated[i]);
        else emit('-', oldParsed.lines[i], oldTerminated[i]);
      }
      if (operation.aEnd > hunk.aEnd) break;
      cursor += 1;
    }
    opIndex = cursor;
  }

  return `${output.join('\n')}\n`;
}

export type ApplyResult =
  | { ok: true; text: string }
  | { ok: false; error: string; line?: number };

interface HunkHeader {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  line: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s.*)?$/;

function parseHunkHeader(line: string, lineNumber: number): HunkHeader | null {
  const match = HUNK_RE.exec(line);
  if (!match) return null;
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  // A count of zero is only meaningful with an explicit ",0" (start then
  // denotes the line *before* the gap). A bare number is a count of one.
  return { oldStart, oldCount, newStart, newCount, line: lineNumber };
}

function stripPatchPath(raw: string): string | null {
  let value = raw.trim();
  if (value === '/dev/null') return null;
  // Drop a single trailing timestamp some tools append ("path<TAB>date").
  const tab = value.indexOf('\t');
  if (tab !== -1) value = value.slice(0, tab).replace(/\s+$/, '');
  if (value.startsWith('a/') || value.startsWith('b/')) return value.slice(2);
  return value;
}

function assemble(lines: readonly string[], terminated: readonly boolean[], crlf: boolean): string {
  if (lines.length === 0) return '';
  const eol = crlf ? '\r\n' : '\n';
  const body = lines.join(eol);
  return terminated[terminated.length - 1] ? `${body}${eol}` : body;
}

/**
 * Apply a unified diff to `oldText`. Every context and removed line is
 * validated byte-exactly against the source; any mismatch is rejected with
 * the patch line number at which it was detected. CRLF sources produce CRLF
 * output; a final line without a terminator is only produced when the patch
 * carries a `\ No newline at end of file` marker for it (or the source's own
 * final line, when untouched, had none).
 */
export function applyUnifiedDiff(
  oldText: string,
  patchText: string,
  expectedPath?: string,
): ApplyResult {
  const oldChecked = checkText(oldText, 'oldText');
  const patchChecked = checkText(patchText, 'patchText');

  // Tolerate patches whose own lines end in CR: strip one trailing CR from
  // each patch line. (Content lines compare against terminator-free source
  // lines, so this normalization is required for round-tripping.)
  const rawPatchLines = patchChecked.split('\n');
  const patchLines = rawPatchLines.map((line) =>
    line.endsWith('\r') ? line.slice(0, -1) : line,
  );

  const oldParsed = splitLines(oldChecked);
  const oldLines = oldParsed.lines;
  const oldTerminated = oldLines.map(
    (_, i) => i < oldLines.length - 1 || oldParsed.finalNewline,
  );
  const useCrlf = oldParsed.crlf;

  const outLines: string[] = [];
  const outTerminated: boolean[] = [];
  let oldCursor = 0;
  let sawHunk = false;
  let sawHeader = false;
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let oldIsDevNull = false;
  let newIsDevNull = false;
  /** Line index in patchLines (0-based) of the header we last validated. */
  let index = 0;

  const failAt = (error: string, line?: number): ApplyResult => ({ ok: false, error, line });

  const finish = (): { lines: string[]; terminated: boolean[] } => {
    for (let i = oldCursor; i < oldLines.length; i += 1) {
      outLines.push(oldLines[i]);
      outTerminated.push(oldTerminated[i]);
    }
    return { lines: outLines, terminated: outTerminated };
  };

  // A line is ours to consume only when it belongs to the current hunk body.
  // First scan: locate headers and hunks, applying each hunk strictly.
  while (index < patchLines.length) {
    const line = patchLines[index];
    const lineNumber = index + 1;

    if (line === '' && index === patchLines.length - 1) {
      index += 1; // trailing newline after the last line
      break;
    }

    if (line.startsWith('--- ')) {
      if (sawHunk) return failAt('File header after hunks are not allowed.', lineNumber);
      const parsed = stripPatchPath(line.slice(4));
      if (parsed === null) {
        // /dev/null: creating a new file.
        if (oldLines.length !== 0) {
          return failAt('Patch creates a new file but the source text is not empty.', lineNumber);
        }
        oldPath = null;
        oldIsDevNull = true;
      } else {
        oldPath = parsed;
        oldIsDevNull = false;
      }
      sawHeader = true;
      index += 1;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (sawHunk) return failAt('File header after hunks are not allowed.', lineNumber);
      const parsed = stripPatchPath(line.slice(4));
      // parsed === null means /dev/null: the file is being deleted.
      newPath = parsed;
      newIsDevNull = parsed === null;
      sawHeader = true;
      index += 1;
      continue;
    }
    if (
      !sawHunk &&
      (line.startsWith('diff ') ||
        line.startsWith('index ') ||
        line.startsWith('new file mode') ||
        line.startsWith('deleted file mode') ||
        line.startsWith('old mode') ||
        line.startsWith('new mode') ||
        line.startsWith('similarity index') ||
        line.startsWith('rename from') ||
        line.startsWith('rename to') ||
        line.startsWith('copy from') ||
        line.startsWith('copy to'))
    ) {
      index += 1; // well-known patch metadata; not needed for application
      continue;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      return failAt('Binary patches cannot be applied.', lineNumber);
    }

    const header = parseHunkHeader(line, lineNumber);
    if (!header && line.startsWith('@@')) {
      return failAt(`Malformed hunk header: ${line.slice(0, 80)}`, lineNumber);
    }
    if (header) {
      sawHunk = true;
      // Copy untouched lines before the hunk. A zero old-count denotes an
      // insertion *after* line oldStart (0 means before the first line);
      // otherwise oldStart is a 1-based line number.
      const aStart0 = header.oldCount === 0 ? header.oldStart : header.oldStart - 1;
      if (aStart0 < oldCursor) {
        return failAt('Hunk starts before the previous hunk ended (overlapping hunks).', lineNumber);
      }
      if (aStart0 > oldLines.length) {
        return failAt(`Hunk starts past the end of the source text (line ${aStart0 + 1}).`, lineNumber);
      }
      for (let i = oldCursor; i < aStart0; i += 1) {
        outLines.push(oldLines[i]);
        outTerminated.push(oldTerminated[i]);
      }
      oldCursor = aStart0;

      let oldSeen = 0;
      let newSeen = 0;
      index += 1;
      let bodyLastWasPush = false;
      let bodyLastWasOld = false;

      while (oldSeen < header.oldCount || newSeen < header.newCount) {
        if (index >= patchLines.length) {
          return failAt('Unexpected end of patch inside hunk.', patchLines.length);
        }
        const bodyLine = patchLines[index];
        const bodyLineNumber = index + 1;
        const prefix = bodyLine.charAt(0);

        if (prefix === '\\') {
          if (bodyLine !== NO_NEWLINE_MARKER) {
            return failAt(`Unknown marker line: ${bodyLine}`, bodyLineNumber);
          }
          if (!bodyLastWasPush && !bodyLastWasOld) {
            return failAt('Marker without a preceding +/-/context line.', bodyLineNumber);
          }
          if (bodyLastWasPush) {
            // The last added line is unterminated.
            outTerminated[outTerminated.length - 1] = false;
          } else {
            // The last consumed source line must be the final, unterminated one.
            if (oldCursor !== oldLines.length || oldTerminated[oldLines.length - 1]) {
              return failAt('Marker after a context/removed line that is not the final unterminated line.', bodyLineNumber);
            }
          }
          bodyLastWasPush = false;
          bodyLastWasOld = false;
          index += 1;
          continue;
        }

        if (prefix === ' ') {
          if (oldSeen >= header.oldCount) {
            return failAt('More context lines than the hunk header declares.', bodyLineNumber);
          }
          if (oldCursor >= oldLines.length) {
            return failAt('Context line past the end of the source text.', bodyLineNumber);
          }
          const expected = oldLines[oldCursor];
          const content = bodyLine.slice(1);
          if (expected !== content) {
            return failAt(
              `Context mismatch at source line ${oldCursor + 1}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(content)}.`,
              bodyLineNumber,
            );
          }
          outLines.push(expected);
          outTerminated.push(oldTerminated[oldCursor]);
          oldCursor += 1;
          oldSeen += 1;
          newSeen += 1;
          bodyLastWasPush = false;
          bodyLastWasOld = true;
          index += 1;
          continue;
        }
        if (prefix === '-') {
          if (oldSeen >= header.oldCount) {
            return failAt('More removed lines than the hunk header declares.', bodyLineNumber);
          }
          if (oldCursor >= oldLines.length) {
            return failAt('Removed line past the end of the source text.', bodyLineNumber);
          }
          const expected = oldLines[oldCursor];
          const content = bodyLine.slice(1);
          if (expected !== content) {
            return failAt(
              `Removed line mismatch at source line ${oldCursor + 1}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(content)}.`,
              bodyLineNumber,
            );
          }
          oldCursor += 1;
          oldSeen += 1;
          bodyLastWasPush = false;
          bodyLastWasOld = true;
          index += 1;
          continue;
        }
        if (prefix === '+') {
          if (newSeen >= header.newCount) {
            return failAt('More added lines than the hunk header declares.', bodyLineNumber);
          }
          outLines.push(bodyLine.slice(1));
          outTerminated.push(true);
          newSeen += 1;
          bodyLastWasPush = true;
          bodyLastWasOld = false;
          index += 1;
          continue;
        }
        return failAt(`Unexpected line in hunk body: ${bodyLine.slice(0, 80)}`, bodyLineNumber);
      }

      // A marker may trail the final body line (after the counts are
      // fulfilled). Validate and consume it exactly like a mid-body marker.
      if (index < patchLines.length && patchLines[index] === NO_NEWLINE_MARKER) {
        if (bodyLastWasPush) {
          outTerminated[outTerminated.length - 1] = false;
        } else if (bodyLastWasOld) {
          if (oldCursor !== oldLines.length || oldTerminated[oldLines.length - 1]) {
            return failAt(
              'Marker after a context/removed line that is not the final unterminated line.',
              index + 1,
            );
          }
        } else {
          return failAt('Marker without a preceding +/-/context line.', index + 1);
        }
        index += 1;
      }
      continue;
    }

    if (sawHunk) return failAt(`Unexpected line after hunks: ${line.slice(0, 80)}`, lineNumber);
    if (line.trim() === '') return failAt('Unexpected blank line before the first hunk.', lineNumber);
    return failAt(`Unrecognized patch line: ${line.slice(0, 80)}`, lineNumber);
  }

  if (!sawHunk) return failAt('Patch contains no hunks.');

  // Validate the expected path against the headers, if the caller cares.
  if (expectedPath !== undefined) {
    if (!sawHeader) return failAt('Patch has no file headers to validate the path against.');
    if (typeof expectedPath !== 'string' || expectedPath.length === 0) {
      return failAt('expectedPath must be a non-empty string.');
    }
    const expected = expectedPath.replace(/^[ab]\//, '');
    const matches =
      oldPath === expected ||
      newPath === expected ||
      (expectedPath === '/dev/null' && (oldIsDevNull || newIsDevNull));
    if (!matches) {
      return failAt(`Patch path does not match expected path ${expectedPath}.`);
    }
  }

  const finished = finish();
  return { ok: true, text: assemble(finished.lines, finished.terminated, useCrlf) };
}
