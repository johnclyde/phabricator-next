import test from 'node:test';
import assert from 'node:assert/strict';
import { filterDiscussionThreads, moveDiscussionCursor, orderedDiscussionThreads } from '../shared/discussion-navigation.ts';
import type { ReviewComment, ReviewThread, RevisionDetail, RevisionVersion } from '../shared/types.ts';
import { DISCUSSION_SPEECH_LIMIT, discussionSummary, discussionThreadNarration, parseCommand, type DiscussionVoiceAction } from '../client/voice.ts';

const firstTime = '2026-01-01T00:00:00.000Z';
const laterTime = '2026-01-02T00:00:00.000Z';
const thread = (id: string, status: ReviewThread['status'] = 'open', createdAt = firstTime): ReviewThread => ({ id, revisionId: 'P1', rootCommentId: id, status, version: 1, createdAt, updatedAt: createdAt });
const comment = (id: string, body: string, extra: Partial<ReviewComment> = {}): ReviewComment => ({ id, revisionId: 'P1', versionId: 'version-seven', filePath: 'paper.tex', line: 4, body, author: 'Researcher', createdAt: firstTime, ...extra });
const version = (id: string, number: number): RevisionVersion => ({ id, revisionId: 'P1', number, files: [{ path: 'paper.tex', content: 'Original paper source.' }], message: 'Source', contentHash: String(number).repeat(64), createdAt: firstTime });
type Discussion = Pick<RevisionDetail, 'comments' | 'threads' | 'versions'>;
const discussion = (): Discussion => ({
  threads: [thread('a', 'resolved')],
  versions: [version('version-nine', 9), version('version-seven', 7)],
  comments: [
    comment('a', 'Check the original evidence.', { threadId: 'a', anchor: { versionId: 'version-seven', contentHash: '7'.repeat(64), filePath: 'paper.tex', start: 0, end: 12, quote: 'Original quote.', prefix: '', suffix: '' } }),
    comment('b', 'A reply from a later version.', { threadId: 'a', viewedVersionId: 'version-nine', createdAt: laterTime }),
    comment('c', 'Another reply.', { threadId: 'a', createdAt: laterTime }),
    comment('d', 'A fourth comment must not be read.', { threadId: 'a', createdAt: laterTime }),
  ],
});

test('discussion ordering is chronological with deterministic ID ties and legacy roots', () => {
  const existing = thread('z', 'resolved');
  const data = { threads: [thread('later', 'open', laterTime), existing], comments: [comment('legacy-z', 'Old comment', { createdAt: laterTime }), comment('reply', 'Reply', { threadId: 'z', createdAt: laterTime }), comment('a', 'Old root')] };
  const before = structuredClone(data);
  const ordered = orderedDiscussionThreads(data);
  assert.deepEqual(ordered.map(item => item.id), ['a', 'z', 'later', 'legacy-z']);
  assert.equal(ordered[1], existing, 'existing thread metadata and resolution win over comments');
  assert.deepEqual(ordered[0], { id: 'a', revisionId: 'P1', rootCommentId: 'a', status: 'open', version: 1, createdAt: firstTime, updatedAt: firstTime });
  assert.deepEqual(orderedDiscussionThreads({ threads: [...data.threads].reverse(), comments: [...data.comments].reverse() }), ordered);
  assert.deepEqual(data, before, 'ordering does not rewrite comments or threads');
  assert.deepEqual(filterDiscussionThreads(ordered, 'open').map(item => item.id), ['a', 'later', 'legacy-z']);
  assert.deepEqual(filterDiscussionThreads(ordered, 'resolved').map(item => item.id), ['z']);
  assert.deepEqual(filterDiscussionThreads(ordered, 'all'), ordered);
  assert.notEqual(filterDiscussionThreads(ordered, 'all'), ordered);
});

test('n/p skips collapsed threads while N/P includes them without changing personal state', () => {
  const threads = [thread('a'), thread('b'), thread('c')]; const collapsed = new Set(['b']);
  assert.deepEqual(moveDiscussionCursor(threads, null, 1, collapsed), { threadId: 'a', boundary: null });
  assert.deepEqual(moveDiscussionCursor(threads, 'a', 1, collapsed), { threadId: 'c', boundary: null });
  assert.deepEqual(moveDiscussionCursor(threads, 'c', -1, collapsed), { threadId: 'a', boundary: null });
  assert.deepEqual(moveDiscussionCursor(threads, 'a', 1, collapsed, true), { threadId: 'b', boundary: null });
  assert.deepEqual(moveDiscussionCursor(threads, 'c', -1, collapsed, true), { threadId: 'b', boundary: null });
  assert.deepEqual(moveDiscussionCursor(threads, 'b', 1, collapsed), { threadId: 'c', boundary: null });
  assert.deepEqual(moveDiscussionCursor(threads, 'b', -1, collapsed), { threadId: 'a', boundary: null });
  assert.deepEqual([...collapsed], ['b']); assert.equal(threads.every(item => item.version === 1 && item.status === 'open'), true);
});

test('cursor boundaries never wrap, unknown selection resets and previous without a cursor stays unselected', () => {
  const threads = [thread('a'), thread('b', 'resolved')]; const collapsed = new Set<string>();
  assert.deepEqual(moveDiscussionCursor(threads, 'a', -1, collapsed), { threadId: 'a', boundary: 'first' });
  assert.deepEqual(moveDiscussionCursor(threads, 'b', 1, collapsed), { threadId: 'b', boundary: 'last' });
  for (const current of [null, 'missing']) {
    assert.deepEqual(moveDiscussionCursor(threads, current, -1, collapsed), { threadId: null, boundary: 'first' });
    assert.deepEqual(moveDiscussionCursor(threads, current, 1, collapsed), { threadId: 'a', boundary: null });
  }
  assert.deepEqual(moveDiscussionCursor(filterDiscussionThreads(threads, 'open'), 'b', 1, collapsed), { threadId: 'a', boundary: null });
  assert.deepEqual(moveDiscussionCursor(filterDiscussionThreads(threads, 'open'), 'b', -1, collapsed), { threadId: null, boundary: 'first' });
});

test('empty and all-collapsed lists report no navigable threads and preserve a known cursor', () => {
  const threads = [thread('a'), thread('b')]; const collapsed = new Set(['a', 'b']);
  for (const direction of [-1, 1] as const) {
    assert.deepEqual(moveDiscussionCursor([], 'a', direction, collapsed), { threadId: null, boundary: 'empty' });
    assert.deepEqual(moveDiscussionCursor(threads, null, direction, collapsed), { threadId: null, boundary: 'empty' });
    assert.deepEqual(moveDiscussionCursor(threads, 'a', direction, collapsed), { threadId: 'a', boundary: 'empty' });
  }
  assert.deepEqual(moveDiscussionCursor(threads, null, 1, collapsed, true), { threadId: 'a', boundary: null });
  assert.deepEqual(moveDiscussionCursor([thread('only')], null, 1, new Set()), { threadId: 'only', boundary: null });
  assert.deepEqual(moveDiscussionCursor([thread('only')], 'only', 1, new Set()), { threadId: 'only', boundary: 'last' });
});

test('discussion phrases name navigation or personal presentation without accepting compound mutations', () => {
  const examples: [DiscussionVoiceAction, string[]][] = [
    ['nextThread', ['next thread', 'Read the next thread.', 'go to next thread']],
    ['previousThread', ['previous thread', 'show the prior thread']],
    ['nextThreadIncludingCollapsed', ['next thread including collapsed', 'go to the next thread including collapsed threads']],
    ['previousThreadIncludingCollapsed', ['previous thread including collapsed', 'read the prior thread including collapsed threads']],
    ['currentThread', ['read thread', 'Read the current thread!', 'read this thread']],
    ['collapseThread', ['collapse thread', 'collapse the current thread', 'collapse selected thread']],
    ['expandThread', ['expand current thread', 'expand this thread']],
    ['toggleThread', ['toggle current thread', 'toggle the selected thread']],
  ];
  for (const [type, phrases] of examples) for (const phrase of phrases) assert.deepEqual(parseCommand(phrase), { type }, phrase);
  for (const phrase of ['next thread and accept it', 'collapse all threads', 'resolve current thread', 'publish current thread', 'delete thread', 'read current thread and reply', 'next comment', 'expand all threads', 'next thread including secret threads']) assert.equal(parseCommand(phrase).type, 'unknown', phrase);
  assert.deepEqual(parseCommand('read discussion'), { type: 'discussion' });
  assert.deepEqual(parseCommand('read open threads'), { type: 'discussion' });
});

test('thread narration names original source, resolution and reply context without projecting onto the current version', () => {
  const detail = discussion(); const before = structuredClone(detail);
  const narration = discussionThreadNarration(detail, 'a', false);
  assert.match(narration, /Thread from original version 7\./);
  assert.match(narration, /File paper\.tex, line 4\. Resolved, 4 comments\./);
  assert.match(narration, /Reading the first 3 of 4 comments\./);
  assert.match(narration, /Original passage: Original quote\./);
  assert.match(narration, /Original comment: Check the original evidence\./);
  assert.match(narration, /Reply while viewing version 9: A reply from a later version\./);
  assert.ok(!narration.includes('fourth comment')); assert.ok(!narration.includes('Original paper source'));
  assert.deepEqual(detail, before);
});

test('collapsed navigation reads only a header while explicit reading does not mutate collapse or content', () => {
  const detail = discussion(); const collapsed = discussionThreadNarration(detail, 'a', true);
  assert.match(collapsed, /original version 7/); assert.match(collapsed, /Resolved, 4 comments/); assert.match(collapsed, /Collapsed for you/);
  for (const text of ['Original quote', 'Check the original evidence', 'A reply from a later version']) assert.ok(!collapsed.includes(text));
  assert.match(discussionThreadNarration(detail, 'a', false), /Check the original evidence/);
  assert.equal(discussionThreadNarration(detail, 'a', true), collapsed);
});

test('multi-passage narration identifies the complete proposal without presenting a thread excerpt as its edit preview', () => {
  const detail = discussion(), root = detail.comments[0]!;
  root.suggestion = { replacement: 'Proposed original change.', additionalEdits: [
    { anchor: { ...root.anchor!, filePath: 'appendix.tex' }, replacement: 'Private replacement text.', explanation: 'Additional explanation.' },
    { anchor: { ...root.anchor!, start: 50, end: 65 }, replacement: '', explanation: 'Deletion explanation.' },
  ] };
  const before = structuredClone(detail);
  for (const collapsed of [false, true]) {
    const narration = discussionThreadNarration(detail, root.id, collapsed);
    assert.match(narration, /3 suggested passages across 2 files/);
    assert.match(narration, /complete edit preview is available in the discussion/);
    assert.doesNotMatch(narration, /Private replacement text|Additional explanation/);
  }
  assert.deepEqual(detail, before);
});

test('narration handles legacy general discussion and unavailable originals without reading a replacement version', () => {
  const detail: Discussion = { versions: [version('version-seven', 7)], threads: [], comments: [comment('legacy', 'Legacy general comment.', { filePath: null, line: null })] };
  assert.match(discussionThreadNarration(detail, 'legacy', false), /original version 7\. General discussion\. Open, 1 comment/);
  assert.match(discussionSummary(detail), /1 open and 0 resolved/);
  assert.equal(discussionThreadNarration(detail, null, false), 'No discussion thread is selected.');
  assert.equal(discussionThreadNarration(detail, 'missing', false), 'The selected discussion thread is unavailable.');
  assert.equal(discussionThreadNarration({ ...detail, threads: [thread('missing')] }, 'missing', false), 'The selected discussion thread has no loaded original comment.');
  const wrongRevision = { ...detail, versions: [{ ...detail.versions[0]!, revisionId: 'P2' }] };
  assert.match(discussionThreadNarration(wrongRevision, 'legacy', false), /original version unavailable/);
  assert.ok(!discussionThreadNarration(wrongRevision, 'legacy', false).includes('version 7'));
});

test('long Unicode metadata, quotations and replies have explicit bounds and never split surrogate pairs', () => {
  const detail = discussion(); detail.comments = detail.comments.map(item => ({ ...item, filePath: '📚'.repeat(500), body: '🧬'.repeat(2_000), ...(item.anchor ? { anchor: { ...item.anchor, quote: '🔬'.repeat(2_000) } } : {}) }));
  for (const collapsed of [false, true]) {
    const narration = discussionThreadNarration(detail, 'a', collapsed);
    assert.ok(Array.from(narration).length <= DISCUSSION_SPEECH_LIMIT);
    assert.ok(!Array.from(narration).some(point => point.length === 1 && point.charCodeAt(0) >= 0xd800 && point.charCodeAt(0) <= 0xdfff));
    assert.match(narration, /Filename shortened/);
    if (!collapsed) assert.match(narration, /Excerpt shortened/);
  }
});
