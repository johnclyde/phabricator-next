import test from 'node:test';
import assert from 'node:assert/strict';
import { docxReplacement, docxReceiptVersion, type DocxIntent } from '../client/docx-client.ts';
import type { RevisionDetail, RevisionVersion } from '../shared/types.ts';
import type { DocxProjection } from '../shared/docx.ts';
const projection: DocxProjection = { format: 'phabricator.docx.projection.v1', mainPart: 'word/document.xml', blocks: [], notes: [], comments: [], changes: [], editableRanges: [], warnings: [] };
const sourceFile = { fileId: 'F1', sha256: 'a'.repeat(64), bytes: 42 };
const version: RevisionVersion = { id: 'L1-v1', revisionId: 'L1', number: 1, contentHash: 'content-one', files: [], message: 'Imported Word document', createdAt: '', docx: { format: 'docx', fileName: 'test.docx', ...sourceFile, sha256: sourceFile.sha256, sourceFile, projection } };
function detail(versions: RevisionVersion[]): RevisionDetail { return { revision: { id: 'L1', kind: 'document', currentVersion: versions.length }, versions, reviews: [], comments: [] } as unknown as RevisionDetail; }
test('Word replacement binds one exact UTF-16 passage and preserves literal text', () => {
  const range = { id: 'range1', part: 'word/document.xml', blockId: 'block1', text: 'The 😀 original result.' };
  assert.deepEqual(docxReplacement(range, 7, 15, '<literal>& 😀'), { rangeId: range.id, start: 7, end: 15, quote: 'original', replacement: '<literal>& 😀' });
  assert.equal(docxReplacement(range, 7, 15, '').replacement, '');
  for (const [start, end] of [[-1, 2], [1, 1], [0, 999], [4, 5], [5, 6], [0.5, 2]]) assert.throws(() => docxReplacement(range, start!, end!, 'new'));
  for (const replacement of ['\0', '\n', '\t', '\u001f', '\uFFFE', '\uD800', 'x'.repeat(20001), 'original']) assert.throws(() => docxReplacement(range, 7, 15, replacement));
});
test('Word receipt recovery accepts historical result and rejects changed package, base or target', () => {
  const imported: DocxIntent = { id: 'request', path: '/api/revisions/docx', body: { title: 'Document', sourceFile, expectedAccessEpoch: 1, shareSource: false }, sourceFile, draftKey: 'docx-draft:S1:create', draft: {} };
  assert.equal(docxReceiptVersion(detail([version]), imported), version);
  assert.equal(docxReceiptVersion(detail([{ ...version, docx: { ...version.docx!, sha256: 'b'.repeat(64) } }]), imported), null);
  const next = { ...version, id: 'L1-v2', number: 2, contentHash: 'content-two', message: 'Edit', docx: { ...version.docx!, sha256: 'b'.repeat(64) } }, latest = { ...next, id: 'L1-v3', number: 3 };
  const intent: DocxIntent = { ...imported, path: '/api/revisions/L1/docx/replace', body: { expectedVersion: 1, expectedVersionId: version.id, expectedContentHash: version.contentHash, expectedAccessEpoch: 1, rangeId: 'range', start: 0, end: 1, quote: 'x', replacement: 'y', message: 'Edit' }, base: { id: version.id, number: 1, contentHash: version.contentHash, packageHash: version.docx!.sha256 } };
  assert.equal(docxReceiptVersion(detail([version, next, latest]), intent), next);
  assert.equal(docxReceiptVersion(detail([version, next]), { ...intent, path: '/api/revisions/L2/docx/replace' }), null);
  assert.equal(docxReceiptVersion(detail([version, next]), { ...intent, base: { ...intent.base!, contentHash: 'wrong' } }), null);
  assert.equal(docxReceiptVersion(detail([version, { ...next, message: 'Other' }]), intent), null);
});

import { docxBytes } from '../client/docx-client.ts';
import { createWorkspaceClient } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import { createHash } from 'node:crypto';
import type { ObjectAccess } from '../shared/policy.ts';
const access = (id: string): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
function byteFixture() { const client = createWorkspaceClient(activateSession({ mode: 'password', workspaceId: 'docx-download', account: { id: 'U1', username: 'reader', displayName: 'Reader', disabled: false }, sessionContext: 'context', csrfToken: 'csrf', expiresAt: null })); client.reconcileAccess({ L1: access('L1'), F1: access('F1') }, 1, ['S1']); const bytes = Buffer.from('exact package bytes'), exact = { ...version, docx: { ...version.docx!, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }; const headers = { 'Content-Length': String(bytes.length), 'X-Content-SHA256': exact.docx.sha256, 'X-Content-Version': String(exact.number), 'X-Revision-Version-ID': exact.id, 'X-Access-Epoch': '1' }; return { client, bytes, exact, headers }; }
test('Word download verifies version, size and digest without retiring parent for missing historical child', async () => {
  const { client, bytes, exact, headers } = byteFixture(), previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(bytes, { headers }); assert.deepEqual(Buffer.from(await docxBytes(client, 'L1', exact, new AbortController().signal)), bytes);
    for (const patch of [{ 'X-Content-Version': '2' }, { 'X-Content-SHA256': 'b'.repeat(64) }, { 'Content-Length': '1' }, { 'X-Access-Epoch': '2' }]) { globalThis.fetch = async () => new Response(bytes, { headers: { ...headers, ...patch } }); await assert.rejects(docxBytes(client, 'L1', exact, new AbortController().signal), /does not match/); }
    globalThis.fetch = async () => new Response(Buffer.from('altered package byt'), { headers }); await assert.rejects(docxBytes(client, 'L1', exact, new AbortController().signal), /integrity/);
    globalThis.fetch = async () => Response.json({ code: 'DOCX_VERSION_UNAVAILABLE' }, { status: 404 }); await assert.rejects(docxBytes(client, 'L1', exact, new AbortController().signal)); assert.equal(client.unavailableObject('L1'), false);
    globalThis.fetch = async () => Response.json({ code: 'DOCX_SOURCE_UNAVAILABLE' }, { status: 404 }); await assert.rejects(docxBytes(client, 'L1', exact, new AbortController().signal)); assert.equal(client.unavailableObject('F1'), true);
  } finally { globalThis.fetch = previous; lockSession(); }
});
test('Word download rejects a completed response after source access changes', async () => {
  const { client, bytes, exact, headers } = byteFixture(), previous = globalThis.fetch; let release!: (response: Response) => void;
  try { globalThis.fetch = async () => await new Promise<Response>(resolve => { release = resolve; }); const pending = docxBytes(client, 'L1', exact, new AbortController().signal); client.retireUnavailableObject('F1'); release(new Response(bytes, { headers })); await assert.rejects(pending, /access changed/); } finally { globalThis.fetch = previous; lockSession(); }
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WordReader } from '../client/DocxWorkspace.tsx';
test('Word structural reading escapes imported text and discloses bounded annotations', () => {
  const block = (index: number) => ({ id: `block${index}`, part: 'word/document.xml', kind: 'paragraph' as const, text: `paragraph ${index}`, runs: [{ text: index === 0 ? '<script>alert(1)</script>' : `paragraph ${index}` }] });
  const content = { ...projection, blocks: Array.from({ length: 201 }, (_, index) => block(index)), notes: [{ id: 'note1', kind: 'footnote' as const, blocks: Array.from({ length: 201 }, (_, index) => block(index)) }], comments: [{ id: 'comment1', author: '<img onerror=alert(1)>', blocks: Array.from({ length: 201 }, (_, index) => block(index)) }] };
  const html = renderToStaticMarkup(createElement(WordReader, { projection: content }));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;')); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img'));
  assert.ok(html.includes('Show More Document Text')); assert.ok(html.includes('remaining text in this note')); assert.ok(html.includes('remaining text in this comment')); assert.ok(!html.includes('paragraph 200'));
  assert.ok(html.includes('separate from verified workspace discussion'));
});
