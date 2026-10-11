import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyWikiSearch, mergeWikiSearch, wikiSearchParameters } from '../client/wiki-search.ts';
import type { WikiDocumentSearchItem, WikiDocumentSearchPage } from '../shared/wiki-search.ts';

test('wiki search uses canonical deduplicated path lists without treating punctuation as parameters', () => {
  const query = 'quoted & published=source', first = wikiSearchParameters({ ...emptyWikiSearch, queryKey: 'all', statuses: ['deleted', 'active', 'active'], paths: ' /Guides/First Page/\r\nguides/first_page\n/', parentPaths: '/Guides/', ancestorPaths: '/' }, query);
  const second = wikiSearchParameters({ ...emptyWikiSearch, queryKey: 'all', statuses: ['active', 'deleted'], paths: '/\nguides/first_page/', parentPaths: 'guides/', ancestorPaths: '/' }, query);
  assert.equal(first, second);
  const params = new URLSearchParams(first);
  assert.deepEqual(params.getAll('statuses'), ['active', 'deleted']); assert.deepEqual(params.getAll('paths'), ['/', 'guides/first_page/']); assert.equal(params.get('query'), query); assert.equal(params.has('published'), false);
  assert.equal(new URLSearchParams(wikiSearchParameters(emptyWikiSearch, '')).get('queryKey'), 'active');
});
test('wiki search rejects invalid or excessive path filters before issuing a request', () => {
  assert.throws(() => wikiSearchParameters({ ...emptyWikiSearch, paths: 'a'.repeat(513) }, ''), /512/);
  assert.throws(() => wikiSearchParameters({ ...emptyWikiSearch, paths: '\uD800' }, ''), /complete characters/);
  assert.throws(() => wikiSearchParameters({ ...emptyWikiSearch, paths: Array.from({ length: 101 }, (_, index) => `path-${index}`).join('\n') }, ''), /at most 100/);
});
test('wiki result merging keeps empty-page continuation, stable identity order and current published metadata', () => {
  const item = (id: string, title: string) => ({ id, title }) as WikiDocumentSearchItem;
  const page = (documents: WikiDocumentSearchItem[], nextAfter: string | null, accessEpoch = 7): WikiDocumentSearchPage => ({ documents, nextAfter, nextBefore: null, accessEpoch });
  const first = page([item('W3', 'Published three'), item('W2', 'Published two')], 'opaque-one');
  const scanned = mergeWikiSearch(first, page([], 'opaque-two'));
  assert.deepEqual(scanned.documents, first.documents); assert.equal(scanned.nextAfter, 'opaque-two');
  const merged = mergeWikiSearch(scanned, page([item('W2', 'Newly published two'), item('W1', 'Published one')], null));
  assert.deepEqual(merged.documents.map(document => [document.id, document.title]), [['W3', 'Published three'], ['W2', 'Newly published two'], ['W1', 'Published one']]); assert.equal(merged.nextAfter, null);
  assert.throws(() => mergeWikiSearch(first, page([], null, 8)), /access changed/);
});
