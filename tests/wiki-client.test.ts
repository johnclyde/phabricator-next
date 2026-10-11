import test from 'node:test';
import assert from 'node:assert/strict';
import { wikiAuthority, wikiHref, wikiMoveReceiptMatches, type WikiMoveIntent } from '../client/wiki-client.ts';
import type { WikiMoveReceipt, WikiPathResult } from '../shared/wiki.ts';

test('wiki routes canonicalize root and nested paths without changing W identity links', () => {
  assert.equal(wikiHref('/'), '#wiki/');
  assert.equal(wikiHref('/Some Page/Nested/'), '#wiki/some_page/nested/');
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
