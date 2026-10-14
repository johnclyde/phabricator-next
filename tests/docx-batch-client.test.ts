import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { docxBatchParagraphs, docxBatchInputCanonical, validateDocxBatch, type DocxReplaceBatchInput } from '../shared/docx-batch.ts';
import type { DocxProjection } from '../shared/docx.ts';
import type { RevisionDetail, RevisionVersion } from '../shared/types.ts';
import { docxBatchDigest, docxReceiptVersion, type DocxIntent } from '../client/docx-client.ts';
import { canQueue, createWorkspaceClient } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';
const projection: DocxProjection = { format: 'phabricator.docx.projection.v1', mainPart: 'word/document.xml', blocks: [{ id: 'p1', part: 'word/document.xml', kind: 'paragraph', text: 'One 😀 two three', runs: [{ text: 'One 😀 ', rangeId: 'r1' }, { text: 'two three', rangeId: 'r2' }] }], notes: [], changes: [], comments: [], warnings: [], editableRanges: [{ id: 'r1', part: 'word/document.xml', blockId: 'p1', text: 'One 😀 ' }, { id: 'r2', part: 'word/document.xml', blockId: 'p1', text: 'two three' }] };
const edits = [{ blockId: 'p1', start: 4, end: 10, quote: '😀 two', replacement: 'revised' }, { blockId: 'p1', start: 11, end: 16, quote: 'three', replacement: '' }];
test('portable Word batch validation binds complete cross-run paragraphs and rejects overlap, unknown source and incomplete characters', () => {
  assert.equal(docxBatchParagraphs(projection).length, 1); validateDocxBatch(projection, edits);
  for (const last of [edits[0]!, { ...edits[1]!, quote: 'other' }, { ...edits[1]!, blockId: 'missing' }, { ...edits[1]!, replacement: '\ud800' }, { ...edits[0]!, start: 5, end: 6, quote: '\ude00' }, { ...edits[1]!, replacement: 'three' }]) assert.throws(() => validateDocxBatch(projection, [edits[0]!, last]));
  const adjacent = [{ ...edits[0]!, start: 0, end: 4, quote: 'One ', replacement: 'A ' }, edits[0]!]; validateDocxBatch(projection, adjacent);
  for (const run of [{ text: 'One 😀 ', rangeId: 'r1', change: 'inserted' as const }, { text: 'One 😀 ', rangeId: 'r1', noteId: 'note' }, { text: 'One 😀 ', rangeId: 'r1', commentIds: ['7'] }, { text: 'One 😀 ' }]) assert.equal(docxBatchParagraphs({ ...projection, blocks: [{ ...projection.blocks[0]!, runs: [run, projection.blocks[0]!.runs[1]!] }] }).length, 0);
});

test('batch receipt identity includes every original quotation, replacement and order, and accepts only its original resulting version', async () => {
  const input: DocxReplaceBatchInput = { expectedVersion: 1, expectedVersionId: 'v1', expectedContentHash: 'c'.repeat(64), expectedAccessEpoch: 5, replacements: edits, message: ' All changes ' };
  const hash = await docxBatchDigest(input); assert.equal(hash, createHash('sha256').update(docxBatchInputCanonical(input)).digest('hex')); assert.notEqual(await docxBatchDigest({ ...input, replacements: [...edits].reverse() }), hash);
  assert.notEqual(await docxBatchDigest({ ...input, replacements: [edits[0]!, { ...edits[1]!, replacement: 'changed' }] }), hash);
  const sourceFile = { fileId: 'F1', sha256: 'a'.repeat(64), bytes: 42 }, original: RevisionVersion = { id: 'v1', revisionId: 'L1', number: 1, contentHash: input.expectedContentHash, createdAt: '', files: [], message: 'Import', docx: { format: 'docx', fileName: 'motion.docx', ...sourceFile, sourceFile, projection } };
  const saved: RevisionVersion = { ...original, id: 'v2', number: 2, contentHash: 'b'.repeat(64), message: input.message, docx: { ...original.docx!, sha256: 'd'.repeat(64) }, docxOperation: { kind: 'replace-batch', inputSha256: hash } };
  const detail = { revision: { id: 'L1', kind: 'document', currentVersion: 3 }, versions: [original, saved, { ...saved, id: 'v3', number: 3 }] } as unknown as RevisionDetail;
  const intent: DocxIntent = { id: 'batch', path: '/api/revisions/L1/docx/replace-batch', body: input, sourceFile, operationSha256: hash, draftKey: 'docx-draft:L1:v1:replace-batch', draft: {}, base: { id: original.id, number: original.number, contentHash: original.contentHash, packageHash: original.docx!.sha256 } };
  assert.equal(docxReceiptVersion(detail, intent), saved);
  for (const patch of [{ operationSha256: undefined }, { operationSha256: '0'.repeat(64) }, { base: { ...intent.base!, packageHash: '0'.repeat(64) } }]) assert.equal(docxReceiptVersion(detail, { ...intent, ...patch }), null);
  assert.equal(docxReceiptVersion({ ...detail, versions: [original, { ...saved, docxOperation: { kind: 'replace', inputSha256: hash } }] }, intent), null);
});

test('batch drafts and exact requests retire with source access or password session and cannot enter the outbox', async () => {
  const access = (id: string): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
  const session = (principal: string) => activateSession({ mode: 'password', workspaceId: 'word-batch', account: { id: principal, username: principal, displayName: principal, disabled: false }, sessionContext: principal, csrfToken: principal, expiresAt: null });
  const client = createWorkspaceClient(session('U1')), previous = globalThis.fetch;
  const sourceFile = { fileId: 'F1', bytes: 42, sha256: 'a'.repeat(64) }, key = 'docx-draft:L1:v1:replace-batch', body: DocxReplaceBatchInput = { expectedVersion: 1, expectedVersionId: 'v1', expectedContentHash: 'b'.repeat(64), expectedAccessEpoch: 1, replacements: edits, message: 'Retained batch' }, draft = { sourceFile, replacements: edits, message: 'Retained draft' }, intent = { id: 'batch-request', path: '/api/revisions/L1/docx/replace-batch', body, sourceFile, draftKey: key, draft };
  try {
    client.reconcileAccess({ L1: access('L1'), F1: access('F1') }, 1, ['S1']); client.writeStored(key, draft); client.writeStored('docx-request:L1', intent);
    assert.equal(canQueue(intent.path, 'POST', body), false); await assert.rejects(client.request(intent.path, { method: 'POST', body, id: intent.id, queued: true }), /explicit online save/);
    client.retireUnavailableObject('F1'); assert.equal(client.draftIsHeld(key), true); assert.equal(client.draftIsHeld('docx-request:L1'), true); assert.equal(client.readStored(key, null), null); assert.deepEqual(client.quarantinedDrafts().find(item => item.key === key)?.value, draft);
    const fresh = createWorkspaceClient(session('U2')); fresh.reconcileAccess({ L1: access('L1'), F1: access('F1') }, 1, ['S1']); assert.equal(fresh.readStored(key, null), null);
    let release!: (response: Response) => void; globalThis.fetch = async () => await new Promise<Response>(resolve => { release = resolve; }); const pending = fresh.request(intent.path, { method: 'POST', body, id: intent.id }, ['F1']);
    const next = createWorkspaceClient(session('U3')); release(Response.json({})); await assert.rejects(pending, SessionChangedError); assert.equal(next.readStored('docx-request:L1', null), null);
  } finally { globalThis.fetch = previous; lockSession(); }
});
