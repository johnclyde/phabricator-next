import test from 'node:test';
import assert from 'node:assert/strict';
import { wordDiscussionSnapshot, wordDiscussionThreads, wordPassage } from '../client/docx-discussion.ts';
import { createDocxPassageAnchor } from '../shared/docx-discussion.ts';
import { discussionThreadNarration } from '../client/voice.ts';
import type { RevisionDetail, RevisionVersion, ReviewComment, ReviewThread } from '../shared/types.ts';

const text = 'Exact 😀 Word passage.';
const version: RevisionVersion = { id: 'word-v1', revisionId: 'L1', number: 1, contentHash: 'a'.repeat(64), files: [], message: 'Original', createdAt: '2026-01-01T00:00:00.000Z', docx: { format: 'docx', fileName: 'source.docx', sha256: 'b'.repeat(64), bytes: 1, sourceFile: { fileId: 'F1', sha256: 'b'.repeat(64), bytes: 1 }, projection: { format: 'phabricator.docx.projection.v1', mainPart: 'word/document.xml', blocks: [{ id: 'block1', part: 'word/document.xml', kind: 'paragraph', text, runs: [{ text, rangeId: 'range1' }] }], editableRanges: [{ id: 'range1', blockId: 'block1', part: 'word/document.xml', text }], notes: [], comments: [], changes: [], warnings: [] } } };
const root: ReviewComment = { id: 'C1', threadId: 'C1', revisionId: 'L1', versionId: version.id, filePath: null, line: null, body: 'Inspect this exact wording.', author: 'Reviewer', createdAt: version.createdAt, docxAnchor: createDocxPassageAnchor(version, { rangeId: 'range1', start: 0, end: 5, quote: 'Exact' }) };
const thread: ReviewThread = { id: 'C1', rootCommentId: 'C1', revisionId: 'L1', version: 1, status: 'open', createdAt: version.createdAt, updatedAt: version.createdAt };
const detail: Pick<RevisionDetail, 'comments' | 'threads' | 'versions'> = { comments: [root], threads: [thread], versions: [version] };

test('Word passage selection preserves exact text and rejects unsupported or split character boundaries', () => {
  assert.deepEqual(wordPassage(version, 'range1', 6, 8), { rangeId: 'range1', start: 6, end: 8, quote: '😀' });
  assert.throws(() => wordPassage(version, 'range1', 6, 7), /Unicode/);
  assert.throws(() => wordPassage(version, 'range1', 8, 8), /nonempty/);
  assert.throws(() => wordPassage(version, 'range-missing', 0, 5), /ordinary/);
});

test('export candidates bind the original Word package and never relocate even an identical quotation', () => {
  assert.equal(wordDiscussionThreads(detail, version).length, 1);
  assert.equal(wordDiscussionThreads(detail, { ...version, id: 'word-v2', number: 2 }).length, 0);
  assert.equal(wordDiscussionThreads(detail, { ...version, contentHash: 'c'.repeat(64) }).length, 0);
  assert.equal(wordDiscussionThreads({ ...detail, comments: [{ ...root, docxAnchor: { ...root.docxAnchor!, blockId: 'different' } }] }, version).length, 0);
  assert.equal(wordDiscussionThreads({ ...detail, comments: [{ ...root, docxAnchor: undefined }] }, version).length, 0);
});

test('prepared Word discussion identity changes with reply text, thread state, version pins and original quotation', () => {
  const original = wordDiscussionSnapshot(detail, version);
  assert.notEqual(wordDiscussionSnapshot({ ...detail, comments: [...detail.comments, { ...root, id: 'C2', body: 'A reply', docxAnchor: undefined }] }, version), original);
  assert.notEqual(wordDiscussionSnapshot({ ...detail, threads: [{ ...thread, status: 'resolved', version: 2 }] }, version), original);
  assert.notEqual(wordDiscussionSnapshot(detail, { ...version, contentHash: 'd'.repeat(64) }), original);
  assert.notEqual(wordDiscussionSnapshot({ ...detail, comments: [{ ...root, body: 'Updated loaded snapshot' }] }, version), original);
});

test('discussion narration labels Word quotations and never claims they are general or relocated text discussion', () => {
  const narration = discussionThreadNarration(detail, 'C1', false);
  assert.match(narration, /Original Word passage: Exact/);
  assert.doesNotMatch(narration, /General discussion/);
  assert.doesNotMatch(discussionThreadNarration(detail, 'C1', true), /Inspect this exact wording/);
});
