import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRemarkup, safeRemarkupHref, REMARKUP_LIMITS, type RemarkupDocument, type RemarkupNode, type RemarkupText } from '../shared/remarkup';
import { scanMentions } from '../shared/mentions';

function nodes(value: RemarkupDocument): RemarkupNode[] {
  const result: RemarkupNode[] = [];
  const visit = (node: RemarkupNode): void => {
    result.push(node);
    if ('children' in node) node.children.forEach(visit);
    if (node.type === 'list') node.items.forEach(visit);
    if (node.type === 'quote') node.header?.forEach(visit);
  };
  value.blocks.forEach(visit); return result;
}
const leaves = (value: RemarkupDocument): RemarkupText[] => nodes(value).filter((node): node is RemarkupText => node.type === 'text');
function sourceInvariant(body: string, value = parseRemarkup(body)): void {
  for (const node of nodes(value)) {
    assert.ok(Number.isSafeInteger(node.start) && Number.isSafeInteger(node.end) && node.start >= 0 && node.end >= node.start && node.end <= body.length, JSON.stringify(node));
    if ('text' in node) assert.equal(node.text, body.slice(node.start, node.end));
    const children = 'children' in node ? node.children : node.type === 'list' ? node.items : [];
    for (const child of children) assert.ok(child.start >= node.start && child.end <= node.end, `${node.type} must contain ${child.type}`);
  }
}

test('nested typography retains real code and source-exact text while code never executes markup', () => {
  const body = '**Strong //emphasis// with `__literal__ @alice`** and __underline__ ~~removed~~ !!notice!!!';
  const parsed = parseRemarkup(body), flat = nodes(parsed);
  assert.equal(parsed.fallback, null);
  const strong = flat.find(node => node.type === 'strong'); assert.ok(strong && 'children' in strong);
  assert.ok(strong.children.some(node => node.type === 'em')); assert.ok(strong.children.some(node => node.type === 'code'));
  assert.equal(flat.filter(node => node.type === 'underline').length, 1);
  const code = flat.find(node => node.type === 'code'); assert.ok(code?.type === 'code');
  assert.equal(code.children.map(node => node.text).join(''), '__literal__ @alice');
  const highlight = flat.find(node => node.type === 'highlight'); assert.ok(highlight?.type === 'highlight');
  assert.equal(highlight.children.map(node => node.type === 'text' ? node.text : '').join(''), 'notice!');
  assert.equal(highlight.children.at(-1)!.start, body.length - 1, 'extra exclamation keeps its original final offset');
  sourceInvariant(body, parsed);
});

test('all syntactic usernames stay atomic before typography, including unresolved and legacy bodies', () => {
  const body = '**@alice__name__** //@__alice__// ~~@dot.user-name~~ __@under_name__ !!@A-B.C!!\n> - @other__person__\n> - `@code__person__`';
  const before = scanMentions(body), parsed = parseRemarkup(body);
  assert.equal(parsed.fallback, null);
  for (const token of before) assert.ok(leaves(parsed).some(leaf => leaf.start === token.start && leaf.end === token.end && leaf.text === body.slice(token.start, token.end)), JSON.stringify(token));
  assert.deepEqual(scanMentions(body), before, 'rendering does not change F024 proof interpretation');
  sourceInvariant(body, parsed);
});

test('CRLF and Unicode source positions survive nested quote/list normalization and exact code dedentation', () => {
  const body = '😀 lead\r\nnext\r\n\r\n> - @Alice wrapped\r\n>   continuation\r\n>   - [x] child **bold**\r\n\r\n```lang=ts\r\n  const value = "😀";\r\n  value;\r\n```';
  const parsed = parseRemarkup(body), all = nodes(parsed);
  assert.equal(parsed.fallback, null); sourceInvariant(body, parsed);
  assert.ok(all.some(node => node.type === 'break' && !node.soft && body.slice(node.start, node.end) === '\r\n'));
  assert.ok(all.some(node => node.type === 'break' && node.soft));
  assert.ok(all.some(node => node.type === 'list-item' && node.checked));
  const code = all.find(node => node.type === 'code-block'); assert.ok(code?.type === 'code-block');
  assert.equal(code.language, 'ts'); assert.equal(code.children.map(node => node.text).join(''), 'const value = "😀";\r\nvalue;');
});

test('core block semantics distinguish published prose, literal text, notes and reply attribution', () => {
  const body = '= Heading =\n\n>>! @alice wrote\n> NOTE: **important**\n> continued\n\n(WARNING) Body **bold**\n\n%%% **literal** @nobody %%%\n\n---\n';
  const parsed = parseRemarkup(body), all = nodes(parsed);
  assert.equal(parsed.fallback, null); sourceInvariant(body, parsed);
  assert.ok(all.some(node => node.type === 'heading' && node.level === 2));
  const reply = all.find(node => node.type === 'quote'); assert.ok(reply?.type === 'quote' && reply.header?.some(node => node.type === 'text' && node.text === '@alice'));
  assert.ok(all.some(node => node.type === 'note' && node.kind === 'note' && node.showLabel));
  assert.ok(all.some(node => node.type === 'note' && node.kind === 'warning' && !node.showLabel));
  assert.ok(all.some(node => node.type === 'text' && node.text.includes('**literal** @nobody')));
  assert.equal(all.filter(node => node.type === 'rule').length, 1);
});

test('URL helper permits explicit encoded spaces without enabling authority confusion or executable schemes', () => {
  const accepted = ['https://example.test/My%20Paper.pdf', 'mailto:user@example.test?subject=Paper%20review', 'HTTP://example.test/path#fragment', '/phabricator/#P1', '#section', '/a%20b'];
  for (const value of accepted) assert.equal(safeRemarkupHref(value), value);
  const rejected = ['//evil.test', '/%2Fevil.test', '/%5cevil.test', '\\evil.test', 'https://alice:secret@example.test/', 'https:example.test', 'javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'blob:https://example.test/a', 'https://example.test/%0afoo', 'mailto:user@example.test?subject=x%0D%0ABcc:other@example.test', 'https://example.test/raw space', '#x\u0001', 'https://%'];
  for (const value of rejected) assert.equal(safeRemarkupHref(value), null, value);
  const body = '[[https://example.test/My%20Paper.pdf | Read the paper]] [[mailto:user@example.test?subject=Paper%20review | Email]]';
  const parsed = parseRemarkup(body); assert.equal(nodes(parsed).filter(node => node.type === 'link').length, 2); sourceInvariant(body, parsed);
});

test('unsupported links, embeds and interpreted source remain inert, with no executable node kinds', () => {
  const body = '[[Wiki page|unresolved]] {https://example.test/embed} ${\u007b\u007b**do not evaluate**\u007d\u007d}\n\nmath {{{\n<script>alert(1)</script> **literal** @alice\n}}}\n\n[Run](javascript:alert(1)) and <img src=x onerror=alert(1)> &lt;script&gt;';
  const parsed = parseRemarkup(body), all = nodes(parsed); assert.equal(parsed.fallback, null);
  assert.equal(all.filter(node => node.type === 'link').length, 0);
  assert.ok(all.some(node => node.type === 'literal' && node.text.includes('<script>alert(1)</script> **literal** @alice')));
  assert.ok(leaves(parsed).some(node => node.text.includes('[[Wiki page|unresolved]]')));
  assert.ok(leaves(parsed).some(node => node.text.includes('${{{**do not evaluate**}}}')));
  sourceInvariant(body, parsed);
});

test('complete bounds retain every original byte with deterministic fallback instead of partial rich output', () => {
  const cases: [string, string][] = [
    ['x'.repeat(REMARKUP_LIMITS.bodyLength + 1), 'length'],
    ['>'.repeat(REMARKUP_LIMITS.depth + 1) + ' **end**', 'depth'],
    ['**a**'.repeat(2000), 'nodes'],
    ['>'.repeat(32) + 'x'.repeat(19000), 'work'],
    [Array.from({ length: 101 }, (_, i) => `@person${i}`).join(' '), 'work'],
  ];
  for (const [body, reason] of cases) {
    const parsed = parseRemarkup(body); assert.equal(parsed.fallback, reason);
    assert.deepEqual(parsed.blocks, [{ type: 'literal', text: body, start: 0, end: body.length }]);
  }
  assert.equal(parseRemarkup('x'.repeat(REMARKUP_LIMITS.bodyLength)).fallback, null);
  assert.equal(parseRemarkup('>'.repeat(REMARKUP_LIMITS.depth) + 'text').fallback, null);
  assert.throws(() => parseRemarkup(null as never), /source must be text/);
});

test('bounded malformed and mixed syntax never invents text leaves or mutates source', () => {
  let state = 123456789;
  const choose = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const parts = ['**', '//', '__', '~~', '!!', '`', '##', '[[', ']]', '(https://example.test/a)', '@person__name__', '😀', '\r\n', '\n', '> ', '- ', '[x] ', '%%% ', '<script>', '${{{x}}}', 'plain'];
  for (let n = 0; n < 120; n++) {
    const body = Array.from({ length: 40 }, () => parts[choose() % parts.length]).join('');
    const parsed = parseRemarkup(body); sourceInvariant(body, parsed); assert.deepEqual(parseRemarkup(body), parsed);
  }
});

test('link-search preflight falls back completely while long ordinary indentation stays supported', () => {
  for (const body of ['['.repeat(20_000), '[x](' + ' '.repeat(19_995) + 'x']) {
    const parsed = parseRemarkup(body);
    assert.equal(parsed.fallback, 'work');
    assert.deepEqual(parsed.blocks, [{ type: 'literal', text: body, start: 0, end: body.length }]);
  }
  for (const body of [' '.repeat(19_998) + 'x', ' '.repeat(19_999) + '-']) {
    const parsed = parseRemarkup(body);
    assert.equal(parsed.fallback, null); assert.equal(parsed.blocks[0]?.type, 'code-block'); sourceInvariant(body, parsed);
  }
});
