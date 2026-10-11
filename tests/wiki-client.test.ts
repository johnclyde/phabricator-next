import test from 'node:test';
import assert from 'node:assert/strict';
import { wikiAuthority, wikiHref, wikiMoveReceiptMatches, wikiActionReceipt, wikiPins, type WikiMoveIntent, type WikiActionIntent } from '../client/wiki-client.ts';
import type { WikiMoveReceipt, WikiPathResult, WikiLifecycleReceipt, WikiLifecycleHistory } from '../shared/wiki.ts';
import type { WikiDetail, WikiDocument } from '../shared/types.ts';
import { mergeWikiLifecycle } from '../client/wiki-history.ts';

test('wiki routes canonicalize root and nested paths without changing W identity links', () => {
  assert.equal(wikiHref('/'), '#wiki/');
  assert.equal(wikiHref('/Some Page/Nested/'), '#wiki/some_page/nested/');
});
test('wiki lifecycle pins separate publication revisions from immutable content numbers', () => {
  const publication = { revision: 8, headVersion: 5, headVersionId: 'head5', publishedVersion: 2, publishedVersionId: 'old2' };
  const detail = { document: { publication }, accessEpoch: 9 } as WikiDetail;
  assert.deepEqual(wikiPins(detail), { expectedVersion: 5, expectedHeadVersionId: 'head5', expectedPublishedVersionId: 'old2', expectedPublicationRevision: 8, expectedAccessEpoch: 9 });
  assert.throws(() => wikiPins({ document: {} } as WikiDetail));
});
test('publication receipts bind the selected historical pointer without advancing content head', () => {
  const before = { revision: 8, headVersion: 5, headVersionId: 'head5', publishedVersion: 2, publishedVersionId: 'old2' }, after = { ...before, revision: 9, publishedVersion: 1, publishedVersionId: 'old1' };
  const document = { id: 'W1', version: 5, publication: after } as WikiDocument, intent = { documentId: 'W1', kind: 'publish', body: { expectedVersion: 5, expectedHeadVersionId: 'head5', expectedPublishedVersionId: 'old2', expectedPublicationRevision: 8, targetVersionId: 'old1' } } as WikiActionIntent;
  const receipt = { document, transaction: { documentId: 'W1', kind: 'publish', before: { publication: before }, after: { publication: after } } } as WikiLifecycleReceipt;
  assert.equal(wikiActionReceipt(receipt, intent), document);
  assert.equal(wikiActionReceipt(receipt, { ...intent, body: { ...intent.body, targetVersionId: 'old3' } }), null);
  assert.equal(wikiActionReceipt({ ...receipt, document: { ...document, publication: { ...after, revision: 10 } } }, intent), null);
  assert.equal(wikiActionReceipt({ ...receipt, transaction: { ...receipt.transaction, kind: 'delete' } }, intent), null);
});
test('lifecycle history preserves publication-only entries and leaves intervening gaps pageable', () => {
  const page = (sequences: number[]): WikiLifecycleHistory => ({ transactions: sequences.map(sequence => ({ id: `tx${sequence}`, sequence })) as WikiLifecycleHistory['transactions'], firstAvailableSequence: 4, nextBefore: 4 });
  const merged = mergeWikiLifecycle(10, page([10, 9]), page([6, 5, 4]));
  assert.deepEqual(merged.transactions.map(item => item.sequence), [10, 9, 6, 5, 4]); assert.equal(merged.nextBefore, 9);
  assert.equal(mergeWikiLifecycle(10, page([8, 7]), merged).nextBefore, null);
});
test('edit and restore receipts preserve exact surrounding title whitespace', () => {
  const document = { id: 'W1', version: 3, title: '  Exact title  ', content: 'Exact source.', location: { path: 'page/', status: 'active', movedToId: null }, publication: { revision: 4, headVersion: 3, headVersionId: 'head3', publishedVersion: 3, publishedVersionId: 'head3' } } as WikiDocument;
  for (const kind of ['edit', 'restore'] as const) {
    const intent = { documentId: 'W1', kind, body: { expectedVersion: 2, expectedHeadVersionId: 'head2', expectedPublishedVersionId: 'head2', expectedPublicationRevision: 3, title: document.title, content: document.content }, ...(kind === 'restore' ? { target: { id: 'old1', number: 1, title: document.title, content: document.content } } : {}) } as WikiActionIntent;
    assert.equal(wikiActionReceipt(document, intent), document);
    assert.equal(wikiActionReceipt({ ...document, title: document.title.trim() }, intent), null);
  }
});
test('wiki creation authority binds all visible ancestors and immediate parent', () => {
  const result = { path: 'guides/child/', accessEpoch: 42, hierarchy: { ancestors: [{ path: '/', document: { id: 'W1' } }, { path: 'guides/', document: { id: 'W2' } }] } } as WikiPathResult;
  assert.deepEqual(wikiAuthority(result), { path: result.path, accessEpoch: 42, ancestorIds: ['W1', 'W2'], parentId: 'W2' });
  result.hierarchy.ancestors[1]!.document = null;
  assert.equal(wikiAuthority(result).parentId, null);
});
test('wiki move receipts must bind both original and destination identities and versions', () => {
  const intent = { sourceId: 'W2', preview: { source: { path: 'old/' } }, input: { expectedVersion: 3, expectedDestinationId: 'W3', expectedDestinationVersion: 5, destinationPath: 'new/' } } as WikiMoveIntent;
  const receipt = { source: { id: 'W2', version: 4, location: { status: 'moved', path: 'old/', movedToId: 'W3' } }, destination: { id: 'W3', version: 6, location: { status: 'active', path: 'new/', movedToId: null } }, sourceVersionId: 'source-v4', destinationVersionId: 'dest-v6', operationId: 'move' } as WikiMoveReceipt;
  assert.equal(wikiMoveReceiptMatches(receipt, intent), true);
  for (const changed of [{ ...receipt, source: { ...receipt.source, id: 'W9' } }, { ...receipt, destination: { ...receipt.destination, version: 7 } }, { ...receipt, destination: { ...receipt.destination, location: { ...receipt.destination.location!, path: 'elsewhere/' } } }, { ...receipt, operationId: '' }]) assert.equal(wikiMoveReceiptMatches(changed, intent), false);
  assert.equal(wikiMoveReceiptMatches(receipt, { ...intent, input: { ...intent.input, expectedDestinationId: null } }), true);
});
