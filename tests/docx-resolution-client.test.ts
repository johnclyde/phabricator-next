import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { docxResolutionDigest, docxResolutionInputCanonical, docxResolutionPreview, validateDocxResolution, type DocxResolutionInspection, type DocxResolveInput } from '../shared/docx-resolution.ts';
import type { DocxProjection } from '../shared/docx.ts';
import { docxReceiptVersion, type DocxIntent } from '../client/docx-client.ts';
import type { RevisionDetail, RevisionVersion } from '../shared/types.ts';
import { canQueue, createWorkspaceClient } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const inspection: DocxResolutionInspection = { format: 'phabricator.docx.resolution.v1', changes: [{ changeId: 'ins', blockId: 'p1', kind: 'ins', text: 'new 😀', author: 'Unverified Word Author' }, { changeId: 'del', blockId: 'p1', kind: 'del', text: 'old ' }], paragraphs: [{ blockId: 'p1', segments: [{ text: 'Before ' }, { changeId: 'del', kind: 'del', text: 'old ' }, { changeId: 'ins', kind: 'ins', text: 'new 😀' }, { text: ' after.' }] }], unsupportedChanges: [{ changeId: 'format', reason: 'Formatting change' }] };
const projection: DocxProjection = { format: 'phabricator.docx.projection.v1', mainPart: 'word/document.xml', blocks: [], notes: [], comments: [], warnings: [], editableRanges: [], changes: [...inspection.changes.map(change => ({ id: change.changeId, part: 'word/document.xml', kind: change.kind, text: change.text })), { id: 'format', part: 'word/document.xml', kind: 'pPrChange', text: '' }, { id: 'note', part: 'word/footnotes.xml', kind: 'ins', text: 'note' }] };
test('complete paragraph previews distinguish accepting marks from removing or restoring text', () => {
  assert.deepEqual(docxResolutionPreview(inspection, [{ changeId: 'ins', action: 'accept' }, { changeId: 'del', action: 'accept' }]), [{ blockId: 'p1', before: 'Before new 😀 after.', after: 'Before new 😀 after.' }]);
  assert.deepEqual(docxResolutionPreview(inspection, [{ changeId: 'ins', action: 'reject' }, { changeId: 'del', action: 'reject' }]), [{ blockId: 'p1', before: 'Before new 😀 after.', after: 'Before old  after.' }]);
  assert.equal(docxResolutionPreview(inspection, [{ changeId: 'del', action: 'reject' }])[0]!.after, 'Before old new 😀 after.');
  validateDocxResolution(projection, [{ changeId: 'ins', action: 'accept' }], inspection);
  for (const changeId of ['missing', 'note', 'format']) assert.throws(() => validateDocxResolution(projection, [{ changeId: 'ins', action: 'accept' }, { changeId, action: 'reject' }], inspection));
  assert.throws(() => validateDocxResolution(projection, [{ changeId: 'ins', action: 'accept' }, { changeId: 'ins', action: 'reject' }], inspection));
});

test('resolution digests and receipts bind every action, original package and historical resulting version', async () => {
  const input: DocxResolveInput = { expectedVersion: 1, expectedVersionId: 'v1', expectedContentHash: 'c'.repeat(64), expectedAccessEpoch: 5, decisions: [{ changeId: 'ins', action: 'accept' }, { changeId: 'del', action: 'reject' }], message: ' Decisions ' }, digest = await docxResolutionDigest(input);
  assert.equal(digest, createHash('sha256').update(docxResolutionInputCanonical(input)).digest('hex')); assert.notEqual(await docxResolutionDigest({ ...input, decisions: [{ ...input.decisions[0]!, action: 'reject' }, input.decisions[1]!] }), digest);
  const sourceFile = { fileId: 'F1', sha256: 'a'.repeat(64), bytes: 100 }, original: RevisionVersion = { id: 'v1', revisionId: 'L1', number: 1, contentHash: input.expectedContentHash, createdAt: '', files: [], message: 'Import', docx: { format: 'docx', fileName: 'motion.docx', ...sourceFile, sourceFile, projection } }, resolved: RevisionVersion = { ...original, id: 'v2', number: 2, contentHash: 'd'.repeat(64), docx: { ...original.docx!, sha256: 'e'.repeat(64) }, message: input.message, docxOperation: { kind: 'resolve', inputSha256: digest } };
  const detail = { revision: { id: 'L1', kind: 'document', currentVersion: 3 }, versions: [original, resolved, { ...resolved, id: 'v3', number: 3 }] } as unknown as RevisionDetail;
  const intent: DocxIntent = { id: 'resolve', path: '/api/revisions/L1/docx/resolve', body: input, sourceFile, operationSha256: digest, draftKey: 'docx-draft:L1:v1:resolve', draft: {}, base: { id: 'v1', number: 1, contentHash: original.contentHash, packageHash: original.docx!.sha256 } };
  assert.equal(docxReceiptVersion(detail, intent), resolved); assert.equal(docxReceiptVersion(detail, { ...intent, operationSha256: '0'.repeat(64) }), null); assert.equal(docxReceiptVersion({ ...detail, versions: [original, { ...resolved, docxOperation: { kind: 'replace', inputSha256: digest } }] }, intent), null);
});

test('resolution drafts and previews use original source retirement and never enter the outbox', async () => {
  const access = (id: string): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
  const client = createWorkspaceClient(activateSession({ mode: 'password', workspaceId: 'word-resolution', account: { id: 'U1', username: 'reviewer', displayName: 'Reviewer', disabled: false }, sessionContext: 'verified-session', csrfToken: 'csrf', expiresAt: null }));
  const key = 'docx-draft:L1:v1:resolve', draft = { sourceFile: { fileId: 'F1', sha256: 'a'.repeat(64), bytes: 100 }, decisions: [{ changeId: 'ins', action: 'accept' }], inspected: { versionId: 'v1', contentHash: 'c'.repeat(64), packageHash: 'a'.repeat(64), accessEpoch: 1, inspection } };
  try {
    client.reconcileAccess({ L1: access('L1'), F1: access('F1') }, 1, ['S1']); client.writeStored(key, draft); client.writeStored('docx-request:L1', { sourceFile: draft.sourceFile, draft });
    assert.equal(canQueue('/api/revisions/L1/docx/resolve', 'POST', draft), false); await assert.rejects(client.request('/api/revisions/L1/docx/resolve', { method: 'POST', body: draft, id: 'request', queued: true }), /explicit online save/);
    client.retireUnavailableObject('F1'); assert.equal(client.readStored(key, null), null); assert.equal(client.draftIsHeld(key), true); assert.equal(client.draftIsHeld('docx-request:L1'), true); assert.deepEqual(client.quarantinedDrafts().find(item => item.key === key)?.value, draft);
  } finally { lockSession(); }
});
