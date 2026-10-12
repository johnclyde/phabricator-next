import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRemarkup } from '../shared/remarkup';
import { remarkupHeadingAnchor, remarkupOutline } from '../shared/remarkup-outline';
import { parseWikiLinkHash, wikiContentHref } from '../shared/wiki-navigation';

function outline(body: string) {
  const result = remarkupOutline(parseRemarkup(body), body);
  assert.equal(result.fallback, null);
  return result.headings;
}

test('pinned upstream toc fixture uses link labels, unwrapped bold and source heading levels', () => {
  // reference/phabricator/.../remarkup/__tests__/remarkup/toc.txt:1–20.
  const body = '= [[ http://www.example.com/ | link_name ]] =\n\n== **bold** ==\n\n= http://www.example.com =\n';
  assert.deepEqual(outline(body).map(({ label, anchor, level }) => ({ label, anchor, level })), [
    { label: 'link_name', anchor: 'link-name', level: 2 },
    { label: 'bold', anchor: 'bold', level: 3 },
    { label: 'http://www.example.com', anchor: 'http-www-example-com', level: 2 },
  ]);
});

test('upstream restored HTML affects heading names while readable labels remain unescaped', () => {
  // HeaderBlockRule::generateAnchor restores SafeHTML, not textContent. Only
  // BoldRule removes its wrapper in anchor mode. Other styles retain tags.
  // render.php uses ENT_QUOTES (HTML401), including decimal &#039;.
  for (const [source, label, anchor] of [
    ['**B**', 'B', 'b'],
    ['//i//', 'i', 'em-i-em'],
    ['~~d~~', 'd', 'del-d-del'],
    ['__u__', 'u', 'u-u-u'],
    ['!!h!!', 'h', 'span-class-remarkup-highlight-h'],
    ['`c`', 'c', 'tt-class-remarkup-monospaced-c'],
    ['A & B', 'A & B', 'a-amp-b'],
    ["'", "'", '039'],
    ['"', '"', 'quot'],
    ['<', '<', 'lt'],
    ['&amp;', '&amp;', 'amp-amp'],
    ['[[ https://example.test | **B** ]]', '**B**', 'b'],
  ] as const) {
    const heading = outline(`= ${source}`)[0]!;
    assert.equal(heading.label, label, source);
    assert.equal(heading.anchor, anchor, source);
  }
});

test('production mentions are omitted before delayed resolution without altering code or link labels', () => {
  // MentionRemarkupRule initially stores empty replacement tokens. Heading
  // anchors are generated before the user lookup in postprocessText, including
  // names which ultimately do not resolve. This requires no native lookup.
  const body = '= Read @not__known__ here\n\n= @only__unknown__\n\n= [[ https://example.test | @linkname ]]\n\n= `@z`';
  assert.deepEqual(outline(body).map(({ label, anchor }) => ({ label, anchor })), [
    { label: 'Read @not__known__ here', anchor: 'read-here' },
    { label: '@linkname', anchor: 'linkname' },
    { label: '@z', anchor: 'tt-class-remarkup-monospaced-z' },
  ]);
});

test('legacy truncation searches only the latter half and removes hanging stopwords afterward', () => {
  assert.equal(remarkupHeadingAnchor('a'.repeat(15) + '-' + 'b'.repeat(36)), 'a'.repeat(15) + '-' + 'b'.repeat(16));
  assert.equal(remarkupHeadingAnchor('a'.repeat(16) + '-' + 'b'.repeat(36)), 'a'.repeat(16));
  assert.equal(remarkupHeadingAnchor('12345678901234567890-and-abcdefghijklmnop'), '12345678901234567890');
  assert.equal(remarkupHeadingAnchor('Title and'), 'title');
  assert.equal(remarkupHeadingAnchor('And'), 'and', 'standalone stopwords are not removed');
  assert.equal(remarkupHeadingAnchor(('e\u0301').repeat(33)), ('e\u0301').repeat(32));
  assert.equal(remarkupHeadingAnchor('😀'.repeat(33)), '😀'.repeat(32), 'surrogate pairs are single legacy glyphs');
  assert.equal(remarkupHeadingAnchor('東京—Δοκιμή'), '東京—δοκιμή');
});

test('duplicate names reserve generated suffixes and exact sections round-trip in pinned links', () => {
  const body = '= Foo\n\n= Foo\n\n= Foo-1\n\n= Foo\n\n= 東京\n\n= !!!';
  const headings = outline(body);
  assert.deepEqual(headings.map(heading => heading.anchor), ['foo', 'foo-1', 'foo-1-1', 'foo-2', '東京']);
  for (const heading of headings) {
    const href = wikiContentHref('W42', 7, heading.anchor), route = parseWikiLinkHash(href)!;
    assert.equal(route.documentId, 'W42');
    assert.equal(route.navigation.version, 7);
    assert.equal(route.navigation.section, heading.anchor);
    assert.equal(route.navigation.error, null);
  }
});

test('outline uses parsed headings only and preserves immutable source and parser nodes', () => {
  const body = '= First\r\n\r\n> == Quoted\r\n\r\n- = Listed inline\r\n\r\n```\r\n= Code\r\n```\r\n\r\n%%%\r\n= Literal\r\n%%%\r\n\r\ngraphviz {{{\r\n= Interpreted\r\n}}}';
  const document = parseRemarkup(body), before = structuredClone(document);
  const result = remarkupOutline(document, body);
  assert.equal(result.fallback, null);
  assert.deepEqual(result.headings.map(heading => heading.anchor), ['first', 'quoted']);
  assert.deepEqual(document, before, 'projection does not alter the parser or original source spans');
  for (const heading of result.headings) assert.ok(body.slice(heading.start, heading.end).includes(heading.label));
});
