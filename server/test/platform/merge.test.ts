import test from 'node:test';
import assert from 'node:assert/strict';

import {
  splitLines,
  diffLines,
  createUnifiedDiff,
  applyUnifiedDiff,
  summarizeDiff,
  MYERS_MAX_LINES_PER_SIDE,
} from '../../platform/patch/diff.js';
import { merge3 } from '../../platform/patch/merge3.js';

const nl = (lines: readonly string[]): string => `${lines.join('\n')}\n`;
const crlf = (lines: readonly string[]): string => `${lines.join('\r\n')}\r\n`;
const numbered = (count: number, prefix = 'line'): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(5, '0')}`);
const loneLfCount = (text: string): number => (text.match(/(^|[^\r])\n/g) ?? []).length;
const loneCrCount = (text: string): number => (text.match(/\r(?!\n)/g) ?? []).length;

test('splitLines splits content without terminators and reports style', () => {
  const lf = splitLines('alpha\nbeta\n');
  assert.deepEqual(lf.lines, ['alpha', 'beta']);
  assert.equal(lf.finalNewline, true);
  assert.equal(lf.crlf, false);

  const noTralingNewline = splitLines('alpha\nbeta');
  assert.deepEqual(noTralingNewline.lines, ['alpha', 'beta']);
  assert.equal(noTralingNewline.finalNewline, false);

  const windows = splitLines('alpha\r\nbeta\r\n');
  assert.deepEqual(windows.lines, ['alpha', 'beta']);
  assert.equal(windows.finalNewline, true);
  assert.equal(windows.crlf, true);

  const mixed = splitLines('alpha\nbeta\r\n');
  assert.deepEqual(mixed.lines, ['alpha', 'beta']);
  assert.equal(mixed.crlf, true); // CRLF wins ties over lone LF

  assert.deepEqual(splitLines(''), { lines: [], finalNewline: false, crlf: false });
  // A lone CR is content, not a terminator.
  assert.deepEqual(splitLines('a\rb\n').lines, ['a\rb']);
});

test('diffLines produces half-open operations covering both sides', () => {
  const ops = diffLines('a\nb\nc\n', 'a\nX\nc\n');
  assert.deepEqual(
    ops.map((op) => op.type),
    ['equal', 'delete', 'insert', 'equal'],
  );
  const inserted = ops.find((op) => op.type === 'insert');
  assert.deepEqual(inserted?.lines, ['X']);
  assert.equal(inserted?.bStart, 1);
  assert.equal(inserted?.bEnd, 2);
});

test('createUnifiedDiff emits valid headers and hunks with count omitted when 1', () => {
  const oldText = 'one\ntwo\nthree\n';
  const newText = 'one\nTWO\nthree\n';

  const contextZero = createUnifiedDiff({ path: 'f.txt', oldText, newText, context: 0 });
  assert.match(contextZero, /^--- a\/f\.txt\n\+\+\+ b\/f\.txt\n/);
  assert.match(contextZero, /@@ -2 \+2 @@\n/);
  assert.match(contextZero, /-two\n/);
  assert.match(contextZero, /\+TWO\n/);

  const fullContext = createUnifiedDiff({ path: 'f.txt', oldText, newText });
  assert.match(fullContext, /@@ -1,3 \+1,3 @@\n/);

  const created = createUnifiedDiff({ path: 'f.txt', oldText: '', newText: 'a\nb\n', context: 3 });
  assert.match(created, /@@ -0,0 \+1,2 @@\n/);

  // Deleting a single line: new side count is 0 -> "+0?" still explicit.
  const shrinkToNewFile = createUnifiedDiff({
    path: 'f.txt',
    oldText: 'only\n',
    newText: 'left\nright\n',
    context: 0,
  });
  assert.match(shrinkToNewFile, /@@ -1 \+1,2 @@\n/);

  // Identical inputs produce an empty patch.
  assert.equal(createUnifiedDiff({ path: 'f.txt', oldText, newText: oldText }), '');

  // Reject bad paths and non-string inputs.
  assert.throws(() => createUnifiedDiff({ path: 'a\nb', oldText: '', newText: '' }));
  assert.throws(() => createUnifiedDiff({ path: '', oldText: '', newText: '' }));
});

test('unified diff roundtrip: createUnifiedDiff + applyUnifiedDiff restores newText', () => {
  const cases: Array<{ oldText: string; newText: string; context?: number }> = [
    { oldText: 'a\nb\nc\n', newText: 'a\nB\nc\n', context: 3 },
    { oldText: 'a\nb\nc\n', newText: 'a\nB\nc\n', context: 0 },
    { oldText: 'keep\nshared\n', newText: 'new-top\nkeep\nshared\n', context: 3 },
    { oldText: 'keep\nshared\ntail\n', newText: 'shared\n', context: 3 },
    { oldText: '', newText: 'fresh\nlines\n', context: 3 },
    { oldText: 'gone\nstale\n', newText: '', context: 3 },
    { oldText: 'x\n'.repeat(50), newText: 'x\n'.repeat(25) + 'y\n' + 'x\n'.repeat(24), context: 2 },
  ];
  for (const { oldText, newText, context } of cases) {
    const patch = createUnifiedDiff({ path: 'sample.txt', oldText, newText, context });
    const applied = applyUnifiedDiff(oldText, patch);
    assert.equal(applied.ok, true, `apply failed: ${JSON.stringify(applied)}`);
    if (applied.ok) assert.equal(applied.text, newText);
  }

  // Multi-hunk patch: two changes far apart, apply in one go.
  const wide = numbered(40);
  const edited = [...wide];
  edited[2] = 'CHANGED-TOP';
  edited[37] = 'CHANGED-BOTTOM';
  const oldText = nl(wide);
  const newText = nl(edited);
  const patch = createUnifiedDiff({ path: 'wide.txt', oldText, newText, context: 3 });
  assert.equal((patch.match(/^@@ /gm) ?? []).length, 2, 'expected two hunks');
  const applied = applyUnifiedDiff(oldText, patch);
  assert.equal(applied.ok, true);
  if (applied.ok) assert.equal(applied.text, newText);
});

test('applyUnifiedDiff rejects context mismatch with a line number', () => {
  const oldText = 'alpha\nbeta\ngamma\n';
  const patch = createUnifiedDiff({ path: 'f.txt', oldText, newText: 'alpha\nBETA\ngamma\n', context: 3 });

  const tampered = patch.replace(' gamma', ' GAMMA'); // context now lies
  const applied = applyUnifiedDiff(oldText, tampered);
  assert.equal(applied.ok, false);
  if (!applied.ok) {
    assert.match(applied.error, /context mismatch/i);
    assert.equal(typeof applied.line, 'number');
    assert.ok((applied.line ?? 0) > 0);
  }

  // Removed line must match exactly too.
  const wrongSource = applyUnifiedDiff('alpha\nWRONG\ngamma\n', patch);
  assert.equal(wrongSource.ok, false);

  // Patch with no hunks is rejected.
  const empty = applyUnifiedDiff(oldText, '');
  assert.equal(empty.ok, false);

  // A hunk anchored past the end of the source text is rejected.
  const outOfRange = applyUnifiedDiff('only\n', '@@ -5,0 +6,1 @@\n+added\n');
  assert.equal(outOfRange.ok, false);

  // A marker on a context line that is not the file's final unterminated
  // line is rejected (dangling marker fabricated by hand).
  const danglingMarker =
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n a\n\\ No newline at end of file\n';
  const markerResult = applyUnifiedDiff('a\nb\n', danglingMarker);
  assert.equal(markerResult.ok, false);

  // expectedPath validation.
  const wrongPath = applyUnifiedDiff(oldText, patch, 'other/path.txt');
  assert.equal(wrongPath.ok, false);
  const rightPath = applyUnifiedDiff(oldText, patch, 'f.txt');
  assert.equal(rightPath.ok, true);
});

test('unified diff handles missing final newlines via \\ No newline marker', () => {
  const oldText = 'a\nb'; // unterminated final line
  const newText = 'a\nB';
  const patch = createUnifiedDiff({ path: 'f.txt', oldText, newText, context: 3 });
  assert.match(patch, /\\ No newline at end of file\n/g);
  const applied = applyUnifiedDiff(oldText, patch);
  assert.equal(applied.ok, true);
  if (applied.ok) assert.equal(applied.text, newText);

  // Removing the final newline: old ends \n, new does not.
  const withNewline = 'a\nB\n';
  const patchDrop = createUnifiedDiff({ path: 'f.txt', oldText: withNewline, newText: 'a\nB', context: 3 });
  assert.match(patchDrop, /-B\n\+B\n\\ No newline at end of file\n/);
  const appliedDrop = applyUnifiedDiff(withNewline, patchDrop);
  assert.equal(appliedDrop.ok, true);
  if (appliedDrop.ok) assert.equal(appliedDrop.text, 'a\nB');

  // Adding the final newline: old does not end with \n, new does.
  const patchAdd = createUnifiedDiff({ path: 'f.txt', oldText: 'a\nB', newText: withNewline, context: 3 });
  const appliedAdd = applyUnifiedDiff('a\nB', patchAdd);
  assert.equal(appliedAdd.ok, true);
  if (appliedAdd.ok) assert.equal(appliedAdd.text, withNewline);
});

test('summarizeDiff counts inserted and deleted lines', () => {
  const summary = summarizeDiff('a\nb\nc\nd\n', 'a\nX\nd\ne\nf\n');
  assert.equal(summary.added, 3); // X, e, f
  assert.equal(summary.removed, 2); // b, c
  assert.deepEqual(summarizeDiff('same\n', 'same\n'), { added: 0, removed: 0 });
});

test('merge3 merges non-overlapping edits on both sides cleanly', () => {
  const base = nl(numbered(12));
  const oursLines = numbered(12);
  oursLines[1] = 'OURS-EDIT';
  const theirsLines = numbered(12);
  theirsLines[10] = 'THEIRS-EDIT';
  const result = merge3({ base, ours: nl(oursLines), theirs: nl(theirsLines) });
  assert.equal(result.ok, true);
  assert.equal(result.conflictCount, 0);
  assert.deepEqual(result.conflicts, []);
  assert.ok(result.text.includes('OURS-EDIT'));
  assert.ok(result.text.includes('THEIRS-EDIT'));
  assert.equal(result.text.split('\n').length, 13); // 12 lines + trailing newline split
});

test('merge3 reports overlapping conflicts with labels and result line numbers', () => {
  const base = nl(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  const ours = nl(['a', 'b', 'c', 'OURS', 'e', 'f', 'g']);
  const theirs = nl(['a', 'b', 'c', 'THEIRS', 'e', 'f', 'g']);
  const result = merge3({ base, ours, theirs, oursLabel: 'HEAD', theirsLabel: 'feature' });

  assert.equal(result.ok, false);
  assert.equal(result.conflictCount, 1);
  const [conflict] = result.conflicts;
  assert.deepEqual(conflict.oursLines, ['OURS']);
  assert.deepEqual(conflict.theirsLines, ['THEIRS']);

  const resultLines = result.text.split('\n');
  assert.equal(resultLines[conflict.startLine - 1], '<<<<<<< HEAD');
  assert.equal(resultLines[conflict.endLine - 1], '>>>>>>> feature');
  assert.ok(result.text.includes('=======\n'));

  // Two separated conflicts come out in ascending order.
  const bothSides = {
    ours: nl(['A1', 'b', 'c', 'd', 'e', 'f', 'OURS-7']),
    theirs: nl(['B1', 'b', 'c', 'd', 'e', 'f', 'THEIRS-7']),
  };
  const twice = merge3({ base, ours: bothSides.ours, theirs: bothSides.theirs });
  assert.equal(twice.conflictCount, 2);
  assert.ok(twice.conflicts[0].startLine < twice.conflicts[1].startLine);
});

test('merge3 deduplicates identical changes on both sides', () => {
  const base = 'x\ny\n';
  // Both sides insert the same lines at the top; theirs also edits the tail.
  const ours = 'SHARED\nx\ny\n';
  const theirs = 'SHARED\nx\ny\nq\n';
  const result = merge3({ base, ours, theirs });
  assert.equal(result.ok, true);
  assert.equal(result.text.match(/SHARED/g)?.length, 1);
  assert.equal(result.text, 'SHARED\nx\ny\nq\n');
});

test('merge3 delete vs modify produces a conflict', () => {
  const base = nl(['l1', 'l2', 'l3', 'l4', 'l5', 'l6']);
  const ours = nl(['l1', 'l2', 'l6']); // deletes l3..l5
  const theirs = nl(['l1', 'l2', 'l3', 'L4-CHANGED', 'l5', 'l6']); // modifies l4
  const result = merge3({ base, ours, theirs, oursLabel: 'ours', theirsLabel: 'theirs' });

  assert.equal(result.ok, false);
  assert.equal(result.conflictCount, 1);
  const [conflict] = result.conflicts;
  assert.deepEqual(conflict.oursLines, []); // ours deleted the whole segment
  assert.deepEqual(conflict.theirsLines, ['l3', 'L4-CHANGED', 'l5']);
});

test('merge3 add/add at the same position conflicts', () => {
  const base = 'stable\n';
  const ours = 'OURS-TOP\nstable\n';
  const theirs = 'THEIRS-TOP\nstable\n';
  const result = merge3({ base, ours, theirs });

  assert.equal(result.ok, false);
  assert.equal(result.conflictCount, 1);
  const [conflict] = result.conflicts;
  assert.equal(conflict.startLine, 1); // conflict block starts the file
  assert.deepEqual(conflict.oursLines, ['OURS-TOP']);
  assert.deepEqual(conflict.theirsLines, ['THEIRS-TOP']);
});

test('merge3 returns the unchanged side verbatim when one side has no edits', () => {
  const baseCrlf = crlf(numbered(8));
  const theirsCrlfNoNewline = crlf([...numbered(8), 'tail-no-newline']).replace(/\r\n$/, '');
  const verbatim = merge3({ base: baseCrlf, ours: baseCrlf, theirs: theirsCrlfNoNewline });
  assert.equal(verbatim.ok, true);
  assert.equal(verbatim.text, theirsCrlfNoNewline); // byte-verbatim, no added newline

  const verbatimOther = merge3({ base: 'keep\n', ours: 'keep\nplus\n', theirs: 'keep\n' });
  assert.equal(verbatimOther.text, 'keep\nplus\n');
});

test('merge3 preserves CRLF line endings in merged output', () => {
  const base = crlf(numbered(10));
  const oursLines = numbered(10);
  oursLines[2] = 'OURS-EDIT';
  const theirsLines = numbered(10);
  theirsLines[7] = 'THEIRS-EDIT';
  const result = merge3({ base, ours: crlf(oursLines), theirs: crlf(theirsLines) });
  assert.equal(result.ok, true);
  assert.equal(loneLfCount(result.text), 0, 'merged output must not contain lone LFs');
  assert.equal(loneCrCount(result.text), 0, 'merged output must not contain lone CRs');
  assert.ok(result.text.endsWith('\r\n'));
  assert.ok(result.text.includes('OURS-EDIT\r\n'));
  assert.ok(result.text.includes('THEIRS-EDIT\r\n'));
});

test('diffLines stays bounded on 30k-line inputs (trim-then-replace fallback)', () => {
  assert.ok(MYERS_MAX_LINES_PER_SIDE >= 40_000);
  const common = numbered(15_000, 'common');
  const left = nl([...common, ...numbered(15_000, 'aaa')]);
  const right = nl([...common, ...numbered(15_000, 'bbb')]);

  // Edit distance (30_000) far exceeds the Myers budget: nothing may hang or
  // throw, and the result must still roundtrip through the patch engine.
  const summary = summarizeDiff(left, right);
  assert.deepEqual(summary, { added: 15_000, removed: 15_000 });

  const patch = createUnifiedDiff({ path: 'big.txt', oldText: left, newText: right, context: 0 });
  const applied = applyUnifiedDiff(left, patch);
  assert.equal(applied.ok, true);
  if (applied.ok) assert.equal(applied.text, right);
});

test('merge3 on a 30k-line file merges a one-line edit fast', () => {
  const baseLines = numbered(30_000);
  const oursLines = [...baseLines];
  oursLines[15_000] = 'OURS-MIDDLE';
  const theirsLines = [...baseLines];
  theirsLines[29_999] = 'THEIRS-TAIL';
  const base = nl(baseLines);
  const result = merge3({ base, ours: nl(oursLines), theirs: nl(theirsLines) });
  assert.equal(result.ok, true);
  assert.ok(result.text.includes('OURS-MIDDLE'));
  assert.ok(result.text.includes('THEIRS-TAIL'));
});

test('merge3 treats adjacent (touching) edits from both sides as a conflict', () => {
  const base = nl(['one', 'two', 'three', 'four', 'five']);
  // ours rewrites line 3, theirs rewrites line 4 — no unchanged base line
  // between the two edits, so they cannot merge cleanly.
  const ours = nl(['one', 'two', 'OURS-THREE', 'four', 'five']);
  const theirs = nl(['one', 'two', 'three', 'THEIRS-FOUR', 'five']);
  const result = merge3({ base, ours, theirs });
  assert.equal(result.ok, false);
  assert.equal(result.conflictCount, 1);
  const [conflict] = result.conflicts;
  assert.ok(conflict.oursLines.includes('OURS-THREE'));
  assert.ok(conflict.theirsLines.includes('THEIRS-FOUR'));
});

test('applyUnifiedDiff handles count-zero old ranges and CRLF-encoded patches', () => {
  // Pure mid-file insertion: old side of the hunk has count 0.
  const oldText = 'a\nb\nc\n';
  const inserted = createUnifiedDiff({
    path: 'f.txt',
    oldText,
    newText: 'a\nNEW\nb\nc\n',
    context: 0,
  });
  assert.match(inserted, /@@ -1,0 \+2 @@/);
  const applied = applyUnifiedDiff(oldText, inserted);
  assert.equal(applied.ok, true);
  if (applied.ok) assert.equal(applied.text, 'a\nNEW\nb\nc\n');

  // A patch whose own line endings are CRLF still applies cleanly.
  const crlfPatch = inserted.replace(/\n/g, '\r\n');
  const crlfApplied = applyUnifiedDiff('a\nb\nc\n', crlfPatch);
  assert.equal(crlfApplied.ok, true);
  if (crlfApplied.ok) assert.equal(crlfApplied.text, 'a\nNEW\nb\nc\n');

  // Metadata headers (diff --git, index) before the hunk are tolerated.
  const withMetadata =
    'diff --git a/f.txt b/f.txt\n' +
    'index 1234567..89abcde 100644\n' +
    inserted;
  const metaApplied = applyUnifiedDiff(oldText, withMetadata);
  assert.equal(metaApplied.ok, true);
  if (metaApplied.ok) assert.equal(metaApplied.text, 'a\nNEW\nb\nc\n');
});

test('unified diff roundtrip is an exact inverse on seeded random inputs', () => {
  // Deterministic PRNG so the fuzz corpus is stable across runs.
  let seed = 0x2f6e2b1;
  const rng = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = ['alpha', 'beta', 'gamma', 'delta = 4', '}', 'return value;', '', '  indent();'];
  const randomLines = (max: number): string[] =>
    Array.from({ length: Math.floor(rng() * max) }, () => pool[Math.floor(rng() * pool.length)]);

  for (let i = 0; i < 150; i += 1) {
    // Case A: mutate a random base — always produces a related pair.
    const base = randomLines(25);
    const mutated = [...base];
    const edits = 1 + Math.floor(rng() * 4);
    for (let e = 0; e < edits; e += 1) {
      const at = Math.floor(rng() * (mutated.length + 1));
      const pick = rng();
      if (pick < 0.34 && mutated.length > 0) mutated.splice(at % mutated.length, 1);
      else if (pick < 0.67) mutated.splice(at, 0, pool[Math.floor(rng() * pool.length)]);
      else if (mutated.length > 0) mutated[at % mutated.length] = pool[Math.floor(rng() * pool.length)];
    }
    const oldText = nl(base);
    const newText = nl(mutated);
    const patch = createUnifiedDiff({ path: 'fuzz.txt', oldText, newText, context: 3 });
    if (patch === '') {
      // Identical inputs produce an empty patch, which applyUnifiedDiff
      // rejects by design (no hunks). The invariant for identical sides is
      // simply equality.
      assert.equal(oldText, newText);
    } else {
      const applied = applyUnifiedDiff(oldText, patch);
      assert.equal(
        applied.ok,
        true,
        `roundtrip failed for case A#${i}: ${JSON.stringify(applied)}`,
      );
      if (applied.ok) assert.equal(applied.text, newText, `roundtrip text mismatch for case A#${i}`);
    }

    // Case B: two fully random texts — the extreme end of the input space.
    const otherText = nl(randomLines(25));
    const patchB = createUnifiedDiff({ path: 'fuzz.txt', oldText, newText: otherText, context: 2 });
    if (patchB === '') {
      assert.equal(oldText, otherText);
    } else {
      const appliedB = applyUnifiedDiff(oldText, patchB);
      assert.equal(appliedB.ok, true, `roundtrip failed for case B#${i}: ${JSON.stringify(appliedB)}`);
      if (appliedB.ok) assert.equal(appliedB.text, otherText);
    }
  }
});

test('merge3 invariants hold on seeded random inputs', () => {
  let seed = 0x51ed3a7;
  const rng = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = ['one', 'two', 'three', 'four', 'five', 'six'];
  const randomLines = (max: number): string[] =>
    Array.from({ length: Math.floor(rng() * max) }, () => pool[Math.floor(rng() * pool.length)]);

  for (let i = 0; i < 100; i += 1) {
    const base = nl(randomLines(20));
    const oursLines = [...base.slice(0, -1).split('\n')];
    const at = Math.floor(rng() * (oursLines.length + 1));
    oursLines.splice(at, 0, `ours-${i}`);
    const ours = nl(oursLines);

    // Invariant 1: theirs unchanged -> ours is returned verbatim.
    const first = merge3({ base, ours, theirs: base });
    assert.equal(first.ok, true);
    assert.equal(first.text, ours);

    // Invariant 2: ours unchanged -> theirs is returned verbatim.
    const theirsLines = [...base.slice(0, -1).split('\n')];
    const at2 = Math.floor(rng() * (theirsLines.length + 1));
    theirsLines.splice(at2, 0, `theirs-${i}`);
    const theirs = nl(theirsLines);
    const second = merge3({ base, ours: base, theirs });
    assert.equal(second.ok, true);
    assert.equal(second.text, theirs);

    // Invariant 3: both sides make the identical edit -> clean merge, no conflicts.
    const third = merge3({ base, ours, theirs: ours });
    assert.equal(third.ok, true);
    assert.equal(third.text, ours);
  }
});

test('patch barrel exports the full public API', async () => {
  const barrel = await import('../../platform/patch/index.js');
  for (const name of [
    'splitLines',
    'diffLines',
    'createUnifiedDiff',
    'applyUnifiedDiff',
    'summarizeDiff',
    'merge3',
    'MYERS_MAX_LINES_PER_SIDE',
    'MYERS_MAX_EDIT_DISTANCE',
  ]) {
    assert.ok(name in barrel, `missing export: ${name}`);
  }
});

test('createUnifiedDiff roundtrip preserves CRLF and terminator properties', () => {
  const oldText = crlf(numbered(20));
  const edited = numbered(20);
  edited[5] = 'CHANGED';
  const newText = crlf(edited);
  const patch = createUnifiedDiff({ path: 'crlf.txt', oldText, newText, context: 3 });
  const applied = applyUnifiedDiff(oldText, patch);
  assert.equal(applied.ok, true);
  if (applied.ok) {
    assert.equal(applied.text, newText);
    assert.equal(loneLfCount(applied.text), 0);
  }
});
