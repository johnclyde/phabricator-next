import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseRemarkup, REMARKUP_LIMITS, type RemarkupDocument, type RemarkupHeading, type RemarkupNode, type RemarkupQuote } from '../shared/remarkup';
import { remarkupHeadingAnchor, remarkupOutline } from '../shared/remarkup-outline';

const outline = (body: string) => remarkupOutline(parseRemarkup(body), body);
const headings = (body: string) => { const result = outline(body); assert.equal(result.fallback, null); return result.headings; };

test('pinned toc fixture preserves link labels, bold naming and HTML heading levels', () => {
  // Archived Phabricator 5720a38c, remarkup/__tests__/remarkup/toc.txt.
  const body = '= [[ http://www.example.com/ | link_name ]] =\n\n== **bold** ==\n\n= http://www.example.com =\n';
  assert.deepEqual(headings(body).map(({ level, label, anchor }) => ({ level, label, anchor })), [
    { level: 2, label: 'link_name', anchor: 'link-name' },
    { level: 3, label: 'bold', anchor: 'bold' },
    { level: 2, label: 'http://www.example.com', anchor: 'http-www-example-com' },
  ]);
});

test('duplicate anchors avoid prior generated suffixes and literal suffixed headings', () => {
  const body = ['foo', 'foo', 'foo-1', 'foo', 'foo-2', 'foo', '!?', '', 'foo-1'].map(text => `= ${text} =`).join('\n\n');
  assert.deepEqual(headings(body).map(item => item.anchor), ['foo', 'foo-1', 'foo-1-1', 'foo-2', 'foo-2-1', 'foo-3', 'foo-1-2']);
});

test('nested source-addressed headings keep document order and do not mistake code or list text for headings', () => {
  const body = '= 😀 First =\r\n\r\n> == Quoted ==\r\n>\r\n> More text.\r\n\r\n- = List text =\r\n\r\n```\r\n= Code =\r\n```\r\n\r\n==== Last ====\r\n';
  const document = parseRemarkup(body), before = JSON.stringify(document), result = remarkupOutline(document, body);
  assert.equal(result.fallback, null);
  assert.deepEqual(result.headings.map(item => [item.level, item.label, item.anchor]), [[2, '😀 First', '😀-first'], [3, 'Quoted', 'quoted'], [5, 'Last', 'last']]);
  for (const item of result.headings) { assert.ok(body.slice(item.start, item.end).includes(item.label)); assert.ok(item.start >= 0 && item.end <= body.length); }
  assert.equal(result.headings[1]!.start, body.indexOf('== Quoted'));
  assert.equal(JSON.stringify(document), before, 'outline projection does not change the parser result');
});

test('bare quoted CRLF lines preserve the same heading, paragraph and list structure as LF with exact source spans', () => {
  // QuotedBlockRule's common-prefix and leading-empty-line semantics plus the
  // quoted-lists.txt fixture. Treating CRLF as empty fixes a historical PHP
  // first-character oversight; it does not normalize or rewrite saved source.
  for (const ending of ['\n', '\r\n']) {
    const body = ['>', '> == Section ==', '>', '> A paragraph.', '> next line.', '>', '> - Item', '> - Other', ''].join(ending);
    const document = parseRemarkup(body); assert.equal(document.fallback, null);
    const quote = document.blocks[0] as RemarkupQuote; assert.equal(quote.type, 'quote');
    assert.deepEqual(quote.children.map(node => node.type), ['heading', 'paragraph', 'list']);
    assert.deepEqual(remarkupOutline(document, body).headings.map(item => [item.level, item.label, item.anchor]), [[3, 'Section', 'section']]);
    const pending: RemarkupNode[] = [...document.blocks];
    while (pending.length) {
      const node = pending.pop()!;
      if ('text' in node) assert.equal(node.text, body.slice(node.start, node.end));
      if (node.type === 'break') assert.equal(body.slice(node.start, node.end), ending);
      if (node.type === 'list') pending.push(...node.items);
      else if ('children' in node) pending.push(...node.children);
    }
    const uneven = ['>Bare first', '> == Not a heading ==', '>', '> Last'].join(ending);
    assert.deepEqual(headings(uneven), [], 'an unspaced nonempty line still prevents common-prefix stripping');
  }
});

test('all supported container nodes can contain headings without recursive traversal', () => {
  const body = '= Heading =', document = parseRemarkup(body), heading = document.blocks[0] as RemarkupHeading;
  const nested: RemarkupDocument = { format: document.format, fallback: null, blocks: [{
    type: 'note', kind: 'note', showLabel: true, start: 0, end: body.length, children: [{
      type: 'list', ordered: false, startNumber: 1, start: 0, end: body.length, items: [{
        type: 'list-item', checked: null, start: 0, end: body.length, children: [heading],
      }],
    }],
  }] };
  assert.deepEqual(remarkupOutline(nested, body).headings, [{ start: 0, end: body.length, level: 2, label: 'Heading', anchor: 'heading' }]);
});

test('anchor normalization follows historical ASCII punctuation and short-word rules without Unicode slugification', () => {
  assert.equal(remarkupHeadingAnchor('  Punctuation: A/B_C.D!  '), 'punctuation-a-b-c-d');
  assert.equal(remarkupHeadingAnchor('ÜBER 中文 😀 — “Quoted”\u00a0word'), 'über-中文-😀-—-“quoted”\u00a0word');
  assert.equal(remarkupHeadingAnchor('A title of'), 'a-title');
  assert.equal(remarkupHeadingAnchor('the'), 'the');
  assert.equal(remarkupHeadingAnchor('!?'), null);
  assert.equal(remarkupHeadingAnchor('a'.repeat(16) + '-' + 'x'.repeat(30)), 'a'.repeat(16));
  assert.equal(remarkupHeadingAnchor('a'.repeat(15) + '-' + 'x'.repeat(30)), 'a'.repeat(15) + '-' + 'x'.repeat(16));
});

test('legacy glyph truncation retains combining ranges and intentionally counts newer emoji components separately', () => {
  const combined = 'e\u0301';
  assert.equal(remarkupHeadingAnchor(combined.repeat(33)), combined.repeat(32));
  assert.equal(remarkupHeadingAnchor('界'.repeat(33)), '界'.repeat(32));
  assert.equal(remarkupHeadingAnchor('😀'.repeat(33)), '😀'.repeat(32));
  assert.equal(remarkupHeadingAnchor('a'.repeat(31) + '👍🏽tail'), 'a'.repeat(31) + '👍');
  assert.equal(remarkupHeadingAnchor('a'.repeat(31) + 'x\u1ab0tail'), 'a'.repeat(31) + 'x', 'Combining Diacritical Marks Extended is not in the historical ranges');
  assert.equal(remarkupHeadingAnchor('\u0301' + 'x'.repeat(33)), ' \u0301' + 'x'.repeat(31), 'libphutil prefixes the leading mark only when truncating');
  assert.equal(remarkupHeadingAnchor('\u0301x'), '\u0301x');
});

test('serialized inline naming keeps readable labels separate and omits only actual unprotected mentions', () => {
  const body = ['//i//', '~~d~~', '__u__', '!!h!!', '`c`', '**B**', 'A & B', 'Hello @not__known', '`@xy`', '[[ https://example.test | @link ]]', '@onlymention'].map(text => `= ${text} =`).join('\n\n');
  assert.deepEqual(headings(body).map(item => [item.label, item.anchor]), [
    ['i', 'em-i-em'], ['d', 'del-d-del'], ['u', 'u-u-u'], ['h', 'span-class-remarkup-highlight-h'],
    ['c', 'tt-class-remarkup-monospaced-c'], ['B', 'b'], ['A & B', 'a-amp-b'], ['Hello @not__known', 'hello'],
    ['@xy', 'tt-class-remarkup-monospaced-xy'], ['@link', 'link'],
  ]);
});

test('invalid spans, route-unsafe controls and malformed Unicode retire the entire outline', () => {
  for (const text of ['Good\n\n= bad\ud800', 'Good\n\n= bad\udc00', 'Good\n\n= bad\u0085control']) {
    assert.deepEqual(outline(`= ${text} =`), { headings: [], fallback: 'invalid' });
  }
  const body = '= Heading =', document = parseRemarkup(body);
  assert.deepEqual(remarkupOutline(document, '= Changed ='), { headings: [], fallback: 'invalid' });
  assert.throws(() => remarkupHeadingAnchor('\ud800'), RangeError);
  assert.throws(() => remarkupHeadingAnchor('x\u009fy'), RangeError);
});

test('parser fallback and adversarial AST depth, node and work budgets never publish partial outlines', () => {
  assert.deepEqual(outline('= Header =\n' + 'x'.repeat(REMARKUP_LIMITS.bodyLength)), { headings: [], fallback: 'parser' });
  assert.deepEqual(outline('No headings.'), { headings: [], fallback: null });
  const body = '= Heading =', parsed = parseRemarkup(body), heading = parsed.blocks[0] as RemarkupHeading;
  const deep: RemarkupQuote = { type: 'quote', header: null, start: 0, end: body.length, children: [] }; deep.children.push(deep);
  assert.deepEqual(remarkupOutline({ ...parsed, blocks: [heading, deep] }, body), { headings: [], fallback: 'depth' });
  assert.deepEqual(remarkupOutline({ ...parsed, blocks: Array.from({ length: REMARKUP_LIMITS.nodes + 1 }, () => heading) }, body), { headings: [], fallback: 'nodes' });
  const long = '= ' + 'a'.repeat(1000) + ' =', longDocument = parseRemarkup(long);
  assert.deepEqual(remarkupOutline({ ...longDocument, blocks: Array.from({ length: REMARKUP_LIMITS.nodes }, () => longDocument.blocks[0]!) }, long), { headings: [], fallback: 'work' });
  assert.throws(() => remarkupHeadingAnchor('x'.repeat(REMARKUP_LIMITS.work + 1)), RangeError);
});

test('mismatched source cannot bypass the parser preflight and enter a pathological frozen scan', () => {
  const script = `import assert from 'node:assert/strict';
    import { remarkupOutline } from './shared/remarkup-outline.ts';
    const empty = { format: 'phabricator.remarkup.v1', blocks: [], fallback: null };
    for (const body of ['['.repeat(19000), '[' + ' '.repeat(19000) + ']']) {
      assert.deepEqual(remarkupOutline(empty, body), { headings: [], fallback: 'work' });
    }`;
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), timeout: 5000, stdio: 'pipe' });
});
