import test from 'node:test';
import assert from 'node:assert/strict';
import { isWorkspaceHashReference, parseWikiLinkHash, wikiContentHref, WIKI_LINK_LIMITS } from '../shared/wiki-navigation';

test('wiki links pin exact versions and preserve encoded Unicode section identity', () => {
  for (const section of ['introduction', 'a-b-1', 'δοκιμή-東京-😀', 'e\u0301', 'non\u00a0breaking', 'name?version=9&section=else#end', 'literal+plus']) {
    const href = wikiContentHref('W42', 7, section), result = parseWikiLinkHash(href)!;
    assert.equal(result.documentId, 'W42');
    assert.deepEqual(result.navigation, { version: 7, section, error: null, key: href.slice(1) });
  }
  assert.equal(wikiContentHref('W1', 1), '#W1?version=1');
  assert.equal(wikiContentHref('W1', Number.MAX_SAFE_INTEGER, null), '#W1?version=9007199254740991');
  assert.deepEqual(parseWikiLinkHash('#W42')?.navigation, { version: null, section: null, error: null, key: 'W42' });
  assert.equal(parseWikiLinkHash('#%57%34%32?section=second&version=7')?.documentId, 'W42');
  assert.equal(parseWikiLinkHash('W42?section=second&version=7')?.navigation.version, 7);
});

test('malformed recognized wiki links cannot silently select current published content', () => {
  for (const suffix of [
    '?', '?section=introduction', '?version=', '?version=0', '?version=-1', '?version=1.5', '?version=01', '?version=1e2', '?version=Infinity', '?version=9007199254740992',
    '?version=1&version=2', '?version=1&%76ersion=2', '?version=1&section=a&section=b', '?version=1&other=x', '?version=1&section=',
    '?version=1&section=%', '?version=1&section=%zz', '?version=1&section=%C0%AF', '?version=1&section=%ED%A0%80', '?version=1&section=%00', '?version=1&section=%0A', '?version=1&section=%C2%85', '?version=1&section=%5C',
  ]) {
    const parsed = parseWikiLinkHash(`#W9${suffix}`)!;
    assert.equal(parsed.documentId, 'W9', suffix); assert.ok(parsed.navigation.error, suffix);
    assert.equal(parsed.navigation.version, null, suffix); assert.equal(parsed.navigation.section, null, suffix);
  }
});

test('wiki link parser leaves other application hashes and wiki paths alone', () => {
  for (const hash of ['#home', '#wiki', '#wiki/research/', '#D3', '#PA2', '#T8', '#PROJ1/workboard', '#R2', '#F1', '#introduction', '#W1%3Fversion=2', '#W1/2', '#W%zz']) assert.equal(parseWikiLinkHash(hash), null, hash);
  assert.equal(parseWikiLinkHash('#W1?version=3&section=a%2520b')?.navigation.section, 'a%20b', 'decode exactly once');
  assert.equal(parseWikiLinkHash('#W1?version=3&section=a+b')?.navigation.section, 'a b');
});

test('wiki link bounds reject oversized or unencodable targets without truncation', () => {
  for (const [id, version, section] of [['T1', 1, 'a'], ['W1', 0, 'a'], ['W1', NaN, 'a'], ['W1', 1, ''], ['W1', 1, '\ud800'], ['W1', 1, 'a'.repeat(WIKI_LINK_LIMITS.section + 1)]] as const) assert.throws(() => wikiContentHref(id, version, section), RangeError);
  const maximal = '漢'.repeat(WIKI_LINK_LIMITS.section), href = wikiContentHref('W1', 2, maximal);
  assert.equal(parseWikiLinkHash(href)?.navigation.section, maximal);
  assert.ok(parseWikiLinkHash('#W1?version=2&section=' + 'x'.repeat(WIKI_LINK_LIMITS.hash))?.navigation.error);
  assert.ok(parseWikiLinkHash('#W1?version=2&section=' + 'x'.repeat(WIKI_LINK_LIMITS.section + 1))?.navigation.error);
});

test('existing workspace references remain distinguishable from local wiki sections', () => {
  for (const href of ['#home', '#wiki', '#wiki/research/', '#D3', '#PA2', '#T8', '#PROJ1/workboard', '#R2', '#F1', '#W1?version=3&section=heading', '#W1?version=bad', '#%44%33']) assert.equal(isWorkspaceHashReference(href), true, href);
  for (const href of ['#introduction', '#d3', '#homework', '#references', '#home?other=value', 'https://example.test/#home', '/#home', '#%zz']) assert.equal(isWorkspaceHashReference(href), false, href);
});
