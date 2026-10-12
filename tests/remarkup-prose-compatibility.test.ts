import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RemarkupBody } from '../client/Remarkup';

const escapeText = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[character]!);
function exactSource(markup: string, label: string): string {
  const match = markup.match(new RegExp(`<pre\\b[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)<\\/pre>`));
  assert.ok(match, `the source remains separately accessible as ${label}`);
  return match[1]!;
}

test('authored wiki and metadata limits preserve complete source when core formatting is bounded', () => {
  // These are allowed authored-field sizes, not the smaller discussion limit.
  // Fallback must preserve the end of the document as well as its opening.
  for (const [size, sourceLabel, fallbackNoun] of [
    [500_000, 'Exact wiki version 7 source', 'document'],
    [100_000, 'Exact task description source', 'description'],
    [100_000, 'Exact revision summary source', 'summary'],
    [100_000, 'Exact Test Plan source', 'Test Plan'],
  ] as const) {
    const first = '**Opening**\r\n😀 & <script>never run</script>\n', last = '\r\n**Final clause** — e\u0301 @al__ice__\n';
    const body = first + 'x'.repeat(size - first.length - last.length) + last;
    const html = renderToStaticMarkup(createElement(RemarkupBody, { body, sourceLabel, fallbackNoun }));
    assert.equal(body.length, size);
    assert.equal(exactSource(html, sourceLabel), escapeText(body), 'source is exact, including CRLF, combining marks and trailing newline');
    assert.ok(html.includes(`<div class="remarkup-literal">${escapeText(body)}</div>`), 'the visible fallback includes every authored code unit');
    assert.ok(html.includes(`This ${fallbackNoun} is shown as plain text`));
    assert.doesNotMatch(html, /<strong>Opening<\/strong>|<script\b|class="person-mention"/);
  }
});

test('prose links and raw source cannot create active HTML, media fetches or unsafe destinations', () => {
  const body = [
    '**Instructions**',
    '[[ https://example.test/paper?a=1&b=2 | Read ]]',
    '[[ /reference/item | Local ]]',
    '[[ mailto:editor@example.test | Email ]]',
    '[[ javascript://alert(1) | Run ]]',
    '[[ data:text/html,attack | Data ]]',
    '[[ //example.test/hidden | Network path ]]',
    '<script>globalThis.compromised = true</script>',
    '<img src="/tracker" onerror="alert(1)">',
    '<iframe srcdoc="<svg onload=alert(1)>"></iframe>',
    '<style>body { background: url(/tracker) }</style>',
  ].join('\n\n');
  const label = 'Exact wiki version 2 source';
  const html = renderToStaticMarkup(createElement(RemarkupBody, { body, sourceLabel: label }));
  assert.match(html, /<strong>Instructions<\/strong>/);
  assert.deepEqual([...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1]), [
    'https://example.test/paper?a=1&amp;b=2', '/reference/item', 'mailto:editor@example.test',
  ]);
  assert.equal([...html.matchAll(/rel="nofollow noopener noreferrer"/g)].length, 3);
  assert.equal([...html.matchAll(/referrerPolicy="no-referrer"/gi)].length, 3);
  assert.doesNotMatch(html, /<(?:script|style|img|iframe|object|embed|svg|link)\b/i);
  assert.equal(exactSource(html, label), escapeText(body));
});

test('prose keeps mention spellings atomic without inventing saved people or formatting source text', () => {
  // Upstream MentionRemarkupRule stores syntax before typography, including
  // unknown names. Prose has no immutable binding proof: it must keep spelling
  // without manufacturing a person from a contemporary account directory.
  const body = '**Read @al__ice__** and __ordinary underline__.\r\n\r\n> @missing__person__ said ##@bob##.\r\n\r\n[[ https://example.test/@alice | @label__person__ ]]';
  const sourceLabel = 'Exact revision summary source';
  const html = renderToStaticMarkup(createElement(RemarkupBody, { body, sourceLabel }));
  assert.match(html, /<strong>Read @al__ice__<\/strong>/);
  assert.match(html, /<u>ordinary underline<\/u>/);
  assert.match(html, /<blockquote><p>@missing__person__ said <code>@bob<\/code>\.<\/p><\/blockquote>/);
  assert.match(html, />@label__person__<\/a>/);
  assert.doesNotMatch(html, /class="person-mention"|@al<u>|@missing<u>|@label<u>/);
  assert.equal(exactSource(html, sourceLabel), escapeText(body));
});
