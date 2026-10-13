import test from 'node:test';
import assert from 'node:assert/strict';
import { createPassageAnchor } from '../shared/anchors.ts';
import { compareFile, type ComparisonRange, type ReadyComparison } from '../shared/comparison.ts';
import { compareParagraphFile } from '../shared/paragraph-comparison.ts';
import { comparisonDiscussionThreads, comparisonPassage, type ComparisonDiscussionContext, type ComparisonSide } from '../shared/comparison-discussion.ts';
import type { PassageAnchor, RevisionDetail, RevisionVersion, ReviewComment, ReviewThread } from '../shared/types.ts';

const at = '2026-10-12T00:00:00.000Z';
const later = '2026-10-12T01:00:00.000Z';
const path = 'motion.md';
type Discussion = Pick<RevisionDetail, 'comments' | 'threads'>;
function version(content: string, number = 1): RevisionVersion {
  return { id: `V${number}`, revisionId: 'L1', number, files: [{ path, content }], message: '', contentHash: `hash-${number}`, createdAt: at };
}
function context(base: RevisionVersion | null, target: RevisionVersion | null): ComparisonDiscussionContext { return { revisionId: 'L1', base, target, filePath: path }; }
function anchor(source: RevisionVersion, quote: string, from = 0): PassageAnchor {
  const start = source.files[0]!.content.indexOf(quote, from);
  assert.ok(start >= 0);
  return createPassageAnchor(source, path, { start, end: start + quote.length, quote });
}
function root(id: string, selected: PassageAnchor, extra: Partial<ReviewComment> = {}): ReviewComment {
  return { id, threadId: id, revisionId: 'L1', versionId: selected.versionId, filePath: path, line: null, body: `${id} discussion`, author: 'Reviewer', createdAt: at, anchor: selected, ...extra };
}
function thread(id: string, extra: Partial<ReviewThread> = {}): ReviewThread {
  return { id, revisionId: 'L1', rootCommentId: id, status: 'open', version: 1, createdAt: at, updatedAt: at, ...extra };
}
function fixture() {
  const base = version('Intro 😀.\r\nOld claim survives.\n\nSecond original passage.\n');
  const target = version('Intro 😀.\r\nNew claim survives.\n\nSecond original passage.\n', 2);
  return { base, target, selected: context(base, target), compared: compareFile(base.files[0]!, target.files[0]!) as ReadyComparison };
}

test('source-side passages keep immutable version, exact Unicode, CRLF and context without editing input', () => {
  const { base, target, selected } = fixture();
  const snapshot = JSON.stringify(selected);
  for (const [side, source] of [['before', base], ['after', target]] as const) {
    const quote = source.files[0]!.content.slice(0, 17);
    const result = comparisonPassage(selected, side, { start: 0, end: 17 });
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') assert.fail('Expected an available exact source passage.');
    assert.equal(result.side, side);
    assert.equal(result.versionId, source.id);
    assert.equal(result.versionNumber, source.number);
    assert.deepEqual(result.anchor, createPassageAnchor(source, path, { start: 0, end: 17, quote }));
    assert.ok(result.anchor.quote.includes('😀.\r\n'));
  }
  assert.equal(JSON.stringify(selected), snapshot);
});

test('reversing the pair changes the role while retaining the exact original anchor', () => {
  const { base, target, selected } = fixture();
  const range = { start: 0, end: 9 };
  const before = comparisonPassage(selected, 'before', range);
  const after = comparisonPassage(context(target, base), 'after', range);
  assert.equal(before.status, 'ready'); assert.equal(after.status, 'ready');
  if (before.status === 'ready' && after.status === 'ready') {
    assert.deepEqual(before.anchor, after.anchor);
    assert.equal(before.versionId, 'V1'); assert.equal(after.versionId, 'V1');
  }
});

test('absent versions/files and foreign revisions explicitly refuse source passage creation', () => {
  const { base, target, selected } = fixture(); const range = { start: 0, end: 2 };
  for (const [input, side, reason] of [
    [context(null, target), 'before', 'missing_version'],
    [context(base, null), 'after', 'missing_version'],
    [{ ...selected, filePath: 'missing.md' }, 'before', 'missing_file'],
    [context({ ...base, files: [] }, target), 'before', 'missing_file'],
    [context({ ...base, revisionId: 'L2' }, target), 'before', 'wrong_revision'],
    [context(base, { ...target, revisionId: 'L2' }), 'after', 'wrong_revision'],
    [context({ ...base, files: [...base.files, ...base.files] }, target), 'before', 'missing_file'],
  ] as const) {
    const result = comparisonPassage(input, side, range);
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') assert.equal(result.reason, reason);
    assert.ok(!('anchor' in result));
  }
});

test('empty, reversed, noninteger, out-of-bounds and split-surrogate ranges never clip or guess', () => {
  const source = version('A😀e\u0301\r\nZ'), selected = context(source, source);
  const invalid: ComparisonRange[] = [
    { start: 0, end: 0 }, { start: 1, end: 0 }, { start: -1, end: 3 }, { start: 0.5, end: 3 },
    { start: 0, end: Infinity }, { start: NaN, end: 3 }, { start: 0, end: 99 },
    { start: 1, end: 2 }, { start: 2, end: 3 }, null as unknown as ComparisonRange,
  ];
  for (const range of invalid) {
    const result = comparisonPassage(selected, 'before', range);
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') { assert.equal(result.reason, 'invalid_range'); assert.ok(result.message.length); }
    assert.ok(!('anchor' in result));
  }
  assert.equal(comparisonPassage(selected, 'left' as ComparisonSide, { start: 0, end: 1 }).status, 'unavailable');
  const result = comparisonPassage(selected, 'after', { start: 1, end: 5 });
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.anchor.quote, '😀e\u0301');
});

test('oversized exact quotations are unavailable, never silently shortened', () => {
  const source = version('x'.repeat(20_001)), selected = context(source, source);
  const full = comparisonPassage(selected, 'after', { start: 0, end: 20_001 });
  assert.equal(full.status, 'unavailable');
  if (full.status === 'unavailable') assert.match(full.message, /20,000/);
  assert.ok(!('anchor' in full));
  const within = comparisonPassage(selected, 'after', { start: 0, end: 20_000 });
  assert.equal(within.status, 'ready');
  if (within.status === 'ready') assert.equal(within.anchor.quote.length, 20_000);
});

test('Word projections never acquire source-text anchors on either comparison side', () => {
  const { base, target } = fixture(); const word = { ...target, docx: {} as NonNullable<RevisionVersion['docx']> };
  for (const selected of [context(base, word), context(word, base)]) for (const side of ['before', 'after'] as const) {
    const result = comparisonPassage(selected, side, { start: 0, end: 3 });
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') assert.equal(result.reason, 'word_projection');
  }
});

test('threads on removed and added text place on their original side and preserve anchors on swap', () => {
  const { base, target, selected, compared } = fixture();
  const data: Discussion = { threads: [thread('b'), thread('a')], comments: [root('b', anchor(target, 'New')), root('a', anchor(base, 'Old'))] };
  const snapshot = JSON.stringify(data);
  const placed = comparisonDiscussionThreads(data, selected, compared);
  assert.deepEqual(placed.map(item => [item.thread.id, item.side]), [['a', 'before'], ['b', 'after']]);
  for (const item of placed) {
    assert.equal(compared.segments[item.segmentIndex]!.kind, item.side === 'before' ? 'removed' : 'added');
    assert.equal(item.anchor, item.root.anchor);
    assert.deepEqual(item.segmentIndexes, [item.segmentIndex]);
  }
  const swapped = comparisonDiscussionThreads(data, context(target, base), compareFile(target.files[0]!, base.files[0]!));
  assert.deepEqual(swapped.map(item => [item.thread.id, item.side]), [['a', 'after'], ['b', 'before']]);
  assert.deepEqual(swapped.map(item => item.anchor), placed.map(item => item.anchor));
  assert.equal(JSON.stringify(data), snapshot);
});

test('quotations across changed and unchanged segments use all exact overlaps and the final segment', () => {
  const { base, target, selected } = fixture();
  const data: Discussion = { threads: [], comments: [root('a', anchor(base, 'Old claim survives.\n\nSecond')), root('b', anchor(target, 'New claim survives.\n\nSecond'))] };
  for (const mode of ['words', 'lines'] as const) {
    const compared = compareFile(base.files[0]!, target.files[0]!, mode) as ReadyComparison;
    const placed = comparisonDiscussionThreads(data, selected, compared);
    assert.equal(placed.length, 2);
    for (const item of placed) {
      assert.ok(item.segmentIndexes.length >= 2);
      assert.equal(item.segmentIndex, item.segmentIndexes.at(-1));
      const text = item.segmentIndexes.map(index => {
        const segment = compared.segments[index]!, range = segment[item.side];
        return segment.text.slice(Math.max(range.start, item.anchor.start) - range.start, Math.min(range.end, item.anchor.end) - range.start);
      }).join('');
      assert.equal(text, item.anchor.quote);
    }
  }
});

test('boundary quotations exclude adjacent and opposite-side zero-width segments', () => {
  const base = version('start old end'), target = version('start new end', 2), selected = context(base, target);
  const compared = compareFile(base.files[0]!, target.files[0]!) as ReadyComparison;
  for (const source of [base, target]) for (const quote of ['start ', ' end', source === base ? 'old' : 'new']) {
    const placed = comparisonDiscussionThreads({ threads: [], comments: [root('a', anchor(source, quote))] }, selected, compared);
    assert.equal(placed.length, 1);
    assert.equal(placed[0]!.segmentIndexes.length, 1);
    assert.equal(compared.segments[placed[0]!.segmentIndex]!.text, quote);
  }
});

test('unchanged repeated source stays at its original offset without projecting to a matching new version', () => {
  const base = version('Repeated text. Repeated text.'), target = version(base.files[0]!.content, 2);
  const selected = context(base, target), second = anchor(base, 'Repeated text.', 1);
  const data: Discussion = { threads: [], comments: [root('a', second)] };
  const placed = comparisonDiscussionThreads(data, selected, compareFile(base.files[0]!, target.files[0]!));
  assert.equal(placed.length, 1); assert.equal(placed[0]!.side, 'before'); assert.equal(placed[0]!.anchor.start, 15);
  const next = version(`Moved ${base.files[0]!.content}`, 3);
  assert.deepEqual(comparisonDiscussionThreads(data, context(target, next), compareFile(target.files[0]!, next.files[0]!)), []);
});

test('an identical version pair places a thread once on after; conflicting immutable hashes refuse placement', () => {
  const base = version('Exact original source.'), data: Discussion = { threads: [], comments: [root('a', anchor(base, 'original'))] };
  const compared = compareFile(base.files[0]!, base.files[0]!);
  const placed = comparisonDiscussionThreads(data, context(base, structuredClone(base)), compared);
  assert.equal(placed.length, 1); assert.equal(placed[0]!.side, 'after');
  assert.deepEqual(comparisonDiscussionThreads(data, context(base, { ...base, contentHash: 'corrupt' }), compared), []);
});

test('exact moved-paragraph display retains each original anchor and never maps it onto its counterpart', () => {
  const base = version('First source paragraph.\n\nSecond source paragraph.\n\nThird source paragraph.'), target = version('Second source paragraph.\n\nFirst source paragraph.\n\nThird source paragraph.', 2);
  const data: Discussion = { threads: [], comments: [root('a', anchor(base, 'First source paragraph.')), root('b', anchor(target, 'First source paragraph.'))] };
  const compared = compareParagraphFile(base.files[0]!, target.files[0]!);
  const placed = comparisonDiscussionThreads(data, context(base, target), compared);
  assert.equal(placed.length, 2);
  assert.deepEqual(placed.map(item => [item.side, item.anchor.start]), [['before', 0], ['after', 26]]);
  assert.deepEqual(placed.map(item => item.anchor), data.comments.map(item => item.anchor));
});

test('forged anchor hash, context, offsets, quote and metadata are not silently projected', () => {
  const { base, selected, compared } = fixture(); const original = root('a', anchor(base, 'Old'));
  const mutations: Partial<PassageAnchor>[] = [
    { contentHash: 'other' }, { prefix: 'incorrect' }, { suffix: 'incorrect' }, { start: -1 }, { end: 999 },
    { quote: 'New' }, { filePath: 'another.md' }, { versionId: 'V3' }, { quote: '' },
  ];
  for (const change of mutations) {
    const data = { threads: [thread('a')], comments: [{ ...original, anchor: { ...original.anchor!, ...change } }] };
    assert.deepEqual(comparisonDiscussionThreads(data, selected, compared), [], JSON.stringify(change));
  }
  for (const change of [
    { versionId: 'V2' }, { revisionId: 'L2' }, { filePath: 'other.md' }, { filePath: null },
    { threadId: 'another-thread' }, { viewedVersionId: 'V2' }, { anchor: undefined },
    { docxAnchor: {} as NonNullable<ReviewComment['docxAnchor']> },
  ]) {
    assert.deepEqual(comparisonDiscussionThreads({ threads: [thread('a')], comments: [{ ...original, ...change }] }, selected, compared), [], JSON.stringify(change));
  }
  assert.deepEqual(comparisonDiscussionThreads({ threads: [thread('a', { revisionId: 'L2' })], comments: [original] }, selected, compared), []);
  assert.deepEqual(comparisonDiscussionThreads({ threads: [thread('a', { rootCommentId: 'missing' })], comments: [original] }, selected, compared), []);
});

test('legacy roots, resolved threads and valid replies keep deterministic chronological ordering', () => {
  const { base, selected, compared } = fixture(), selectedAnchor = anchor(base, 'Old');
  const a = root('a', selectedAnchor), z = root('z', selectedAnchor, { threadId: undefined }), b = root('b', selectedAnchor, { createdAt: later });
  const reply = { ...a, id: 'reply', body: 'Exact original thread reply.', anchor: undefined, viewedVersionId: 'V2', createdAt: later };
  const data: Discussion = { threads: [thread('b', { createdAt: later }), thread('a', { status: 'resolved' })], comments: [b, z, reply, a] };
  const placed = comparisonDiscussionThreads(data, selected, compared);
  assert.deepEqual(placed.map(item => item.thread.id), ['a', 'z', 'b']);
  assert.equal(placed[0]!.thread.status, 'resolved');
  assert.deepEqual(placed[0]!.comments.map(comment => comment.id), ['a', 'reply']);
  assert.deepEqual(comparisonDiscussionThreads({ threads: [...data.threads].reverse(), comments: [...data.comments].reverse() }, selected, compared), placed);
});

test('foreign-revision/version messages and duplicated comment IDs never enter an inline thread', () => {
  const { base, selected, compared } = fixture(); const a = root('a', anchor(base, 'Old'));
  const data: Discussion = { threads: [], comments: [a,
    { ...a, id: 'foreign', revisionId: 'L2', anchor: undefined },
    { ...a, id: 'other-version', versionId: 'V2', anchor: undefined },
    { ...a, id: 'duplicate', anchor: undefined }, { ...a, id: 'duplicate', anchor: undefined },
  ] };
  const placed = comparisonDiscussionThreads(data, selected, compared);
  assert.equal(placed.length, 1); assert.deepEqual(placed[0]!.comments, [a]);
  assert.deepEqual(comparisonDiscussionThreads({ threads: [], comments: [a, { ...a }] }, selected, compared), []);
});

test('removed and newly added files place only the side that actually contains the immutable source', () => {
  const base = version('Removed source.'), target = version('Added source.', 2);
  const removed = { ...target, files: [] }, added = { ...base, files: [] };
  const oldData = { threads: [], comments: [root('a', anchor(base, 'Removed'))] };
  const newData = { threads: [], comments: [root('b', anchor(target, 'Added'))] };
  assert.equal(comparisonDiscussionThreads(oldData, context(base, removed), compareFile(base.files[0]!, null))[0]!.side, 'before');
  assert.equal(comparisonDiscussionThreads(newData, context(added, target), compareFile(null, target.files[0]!))[0]!.side, 'after');
  assert.equal(comparisonPassage(context(base, removed), 'after', { start: 0, end: 1 }).status, 'unavailable');
  assert.equal(comparisonPassage(context(added, target), 'before', { start: 0, end: 1 }).status, 'unavailable');
});

test('stale comparison text, paths, lengths, presence and ranges refuse placement without partial matches', () => {
  const { base, target, selected, compared } = fixture(); const data = { threads: [], comments: [root('a', anchor(base, 'Old'))] };
  const corrupt: ReadyComparison[] = [
    { ...compared, filePath: 'other.md' }, { ...compared, beforeLength: 0 }, { ...compared, afterLength: 0 },
    { ...compared, beforePresent: false }, { ...compared, afterPresent: false },
    { ...compared, segments: compared.segments.slice(1) },
    { ...compared, segments: compared.segments.map((segment, index) => index === 0 ? { ...segment, text: 'Other' } : segment) },
    { ...compared, segments: compared.segments.map((segment, index) => index === 0 ? { ...segment, after: { start: 0.5, end: segment.after.end } } : segment) },
  ];
  for (const changed of corrupt) assert.deepEqual(comparisonDiscussionThreads(data, selected, changed), []);
  assert.deepEqual(comparisonDiscussionThreads(data, selected, compareFile(base.files[0]!, target.files[0]!, 'words', { maxInputCodeUnits: 0 })), []);
  assert.deepEqual(comparisonDiscussionThreads(data, context({ ...base, revisionId: 'L2' }, target), compared), []);
  assert.deepEqual(comparisonDiscussionThreads(data, context(base, { ...target, docx: {} as NonNullable<RevisionVersion['docx']> }), compared), []);
  assert.deepEqual(comparisonDiscussionThreads(data, context({ ...base, files: [...base.files, ...base.files] }, target), compared), []);
});

test('empty files produce no invented range or thread location', () => {
  const base = version(''), target = version('', 2), selected = context(base, target);
  assert.equal(comparisonPassage(selected, 'before', { start: 0, end: 0 }).status, 'unavailable');
  assert.deepEqual(comparisonDiscussionThreads({ threads: [], comments: [] }, selected, compareFile(base.files[0]!, target.files[0]!)), []);
});
