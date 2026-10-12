import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRemarkup, safeRemarkupHref, REMARKUP_LIMITS, type RemarkupDocument, type RemarkupNode } from '../shared/remarkup.ts';
import { scanMentions } from '../shared/mentions.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiscussionBody } from '../client/Remarkup.tsx';
import { execFileSync } from 'node:child_process';

// Independent expectations from archived Phabricator 5720a38c, under
// src/infrastructure/markup/remarkup/__tests__/remarkup/*.txt. These tests
// compare semantic output, not upstream HTML classes or parser implementation.
function children(node: RemarkupNode): RemarkupNode[] {
  if (node.type === 'list') return node.items;
  if (node.type === 'quote') return [...(node.header ?? []), ...node.children];
  return 'children' in node ? node.children : [];
}
function nodes(document: RemarkupDocument): RemarkupNode[] {
  const result: RemarkupNode[] = [];
  const visit = (node: RemarkupNode) => { result.push(node); for (const child of children(node)) visit(child); };
  for (const block of document.blocks) visit(block);
  return result;
}
const content = (node: RemarkupNode): string => 'text' in node ? node.text : node.type === 'break' ? node.soft ? ' ' : '\n' : children(node).map(content).join('');
function parsed(body: string): RemarkupDocument {
  const document = parseRemarkup(body);
  assert.equal(document.format, 'phabricator.remarkup.v1'); assert.equal(document.fallback, null, body);
  return document;
}
const ofType = <T extends RemarkupNode['type']>(document: RemarkupDocument, type: T): Extract<RemarkupNode, { type: T }>[] => nodes(document).filter((node): node is Extract<RemarkupNode, { type: T }> => node.type === type);

function sourceSpans(document: RemarkupDocument, body: string): void {
  const check = (node: RemarkupNode, parent: { start: number; end: number }) => {
    assert.ok(Number.isSafeInteger(node.start) && Number.isSafeInteger(node.end));
    assert.ok(node.start >= parent.start && node.end >= node.start && node.end <= parent.end, JSON.stringify(node));
    if ('text' in node) assert.equal(node.text, body.slice(node.start, node.end), 'text must refer to exact source, including UTF-16 and CRLF');
    let previous = node.start;
    for (const child of children(node)) { assert.ok(child.start >= previous, 'sibling spans must retain source order without overlap'); check(child, node); previous = child.end; }
  };
  let previous = 0;
  for (const block of document.blocks) { assert.ok(block.start >= previous); check(block, { start: 0, end: body.length }); previous = block.end; }
}

test('pinned monospace precedence keeps nested delimiters literal while styles may cross newlines', () => {
  // monospaced-in-monospaced.txt and across-newlines.txt.
  const document = parsed('query ##SELECT * FROM `table`##\n\n`SELECT * FROM ##table##`\n\n`**x**`\n\n**duck\nquack**');
  assert.deepEqual(ofType(document, 'code').map(content), ['SELECT * FROM `table`', 'SELECT * FROM ##table##', '**x**']);
  assert.deepEqual(ofType(document, 'strong').map(content), ['duck\nquack']);
  assert.equal(ofType(document, 'em').length, 0);
  const outside = parsed('**bold //italic//** and https://example.test/**literal**');
  assert.equal(ofType(outside, 'strong').length, 1); assert.equal(ofType(outside, 'em').length, 1);
  assert.deepEqual(ofType(outside, 'link').map(node => node.href), ['https://example.test/**literal**']);
});

test('pinned header/list ambiguity, first-marker style and list-before-code precedence are preserved', () => {
  // list-header.txt, list-header-last.txt, header-skip.txt,
  // list-first-style-wins.txt and list-vs-codeblock.txt.
  const heading = parsed('## Small Header\n\nThis should be a small header.');
  assert.deepEqual(ofType(heading, 'heading').map(node => [node.level, content(node)]), [[3, 'Small Header']]);
  assert.equal(ofType(parsed('#2 is my favorite.\n\n#project'), 'heading').length, 0);
  const last = ofType(parsed('# At the end of a block, this should be a list.'), 'list');
  assert.equal(last.length, 1); assert.equal(last[0]!.ordered, true);
  const mixed = ofType(parsed('# item\n- item\n- item\n\nderp'), 'list');
  assert.equal(mixed.length, 1); assert.equal(mixed[0]!.ordered, true); assert.equal(mixed[0]!.items.length, 3);
  const indented = parsed('This should be a list:\n\n  - apple\n  - banana\n');
  assert.equal(ofType(indented, 'code-block').length, 0);
  assert.deepEqual(ofType(indented, 'list')[0]!.items.map(content), ['apple', 'banana']);
});

test('pinned checkbox lists distinguish checkmarks from numbered footnote prose', () => {
  // list-checkboxes.txt (first and last blocks).
  const document = parsed('- [] a\n- [ ] b\n- [X] c\n- d\n\n[1] footnote');
  const list = ofType(document, 'list')[0]!;
  assert.deepEqual(list.items.map(item => [item.checked, content(item)]), [[false, 'a'], [false, 'b'], [true, 'c'], [null, 'd']]);
  assert.ok(document.blocks.some(block => block.type === 'paragraph' && content(block) === '[1] footnote'));
});

test('pinned wrapped list lines render spaces while a following unindented line starts a paragraph', () => {
  // list-multiline.txt.
  const body = '- a\n  a\n- b\nb', document = parsed(body);
  assert.deepEqual(document.blocks.map(node => node.type), ['list', 'paragraph']);
  assert.deepEqual(ofType(document, 'list')[0]!.items.map(content), ['a a', 'b']);
  assert.equal(content(document.blocks[1]!), 'b');
  assert.ok(ofType(document, 'break').some(node => node.soft));
  const html = renderToStaticMarkup(createElement(DiscussionBody, { body }));
  assert.match(html, /<p>a a<\/p>/); assert.doesNotMatch(html, /a<br\/?>(?: |)a/);
});

test('pinned quotes preserve block structure and explicit reply headers', () => {
  // quoted-lists.txt, quoted-angry.txt and reply-basic.txt.
  const document = parsed('> # X\n> # Y\n>\n> B\n>\n> * C');
  const quote = ofType(document, 'quote')[0]!;
  assert.deepEqual(quote.children.map(node => node.type), ['list', 'paragraph', 'list']);
  assert.deepEqual(ofType(document, 'list').map(node => [node.ordered, node.items.map(content)]), [[true, ['X', 'Y']], [false, ['C']]]);
  assert.equal(ofType(parsed(">>> REQUESTING CHANGES BECAUSE I'M ANGRY!"), 'quote').length, 3);
  const reply = ofType(parsed('>>! In comment #123, alincoln wrote:\n> Four score and twenty years ago...'), 'quote')[0]!;
  assert.equal(reply.header?.map(content).join(''), 'In comment #123, alincoln wrote:');
  assert.equal(reply.children.map(content).join(''), 'Four score and twenty years ago...');
});

test('pinned code whitespace and note continuation do not use Markdown approximations', () => {
  // backticks-whitespace.txt, code-block-whitespace.txt and note-multiline.txt.
  assert.deepEqual(ofType(parsed('```x```\n\n```\ny\n```'), 'code-block').map(content), ['x', 'y']);
  const indented = ofType(parsed('  lang=txt\n    x\n  y'), 'code-block')[0]!;
  assert.equal(indented.language, 'txt'); assert.equal(content(indented), '  x\ny');
  const note = parsed('NOTE: a\na\n\nb');
  assert.deepEqual(note.blocks.map(node => node.type), ['note', 'paragraph']);
  assert.equal(note.blocks[0]!.type === 'note' && note.blocks[0]!.showLabel, true);
  assert.equal(content(note.blocks[0]!), 'a\na'); assert.equal(content(note.blocks[1]!), 'b');
  const quiet = ofType(parsed('(WARNING) Be careful.'), 'note')[0]!;
  assert.equal(quiet.kind, 'warning'); assert.equal(quiet.showLabel, false);
});

test('pinned bare links balance punctuation while explicit brackets preserve it', () => {
  // link-edge-cases.txt, link-with-punctuation.txt and link-brackets.txt.
  const body = 'http://www.example.com/,\nhttp://www.example.com/..\nhttp://www.example.com/!!!\n\n(http://www.example.com/)\n\nhttp://www.example.com/wiki/example_(disambiguation)\n\n<http://www.zany.com/omg/weird_url,,,>';
  assert.deepEqual(ofType(parsed(body), 'link').map(node => node.href), [
    'http://www.example.com/', 'http://www.example.com/', 'http://www.example.com/', 'http://www.example.com/',
    'http://www.example.com/wiki/example_(disambiguation)', 'http://www.zany.com/omg/weird_url,,,',
  ]);
  assert.equal(ofType(parsed('{https://example.test/embed}'), 'link').length, 0, 'curly embed syntax must not invent an embed or ordinary anchor');
});

test('document-link boundaries reject source-code false positives and unknown wiki links stay literal', () => {
  // DocumentLinkRule::markupAlternateLink and special wiki-root branch.
  const body = 'x[0][1](y) [name](relative) [quoted]("/path") [[ / ]] [[ Unknown Wiki Page ]]';
  const document = parsed(body); assert.equal(ofType(document, 'link').length, 0); assert.equal(document.blocks.map(content).join(''), body);
  const linked = parsed('[[ /path | Name ]] [Other](https://example.test/a_(b)) [[ mailto:person@example.test | Mail ]] [[ #section | Section ]]');
  assert.deepEqual(ofType(linked, 'link').map(node => [node.href, content(node)]), [['/path', 'Name'], ['https://example.test/a_(b)', 'Other'], ['mailto:person@example.test', 'Mail'], ['#section', 'Section']]);
});

test('URI safety rejects script schemes, control encodings, authority confusion and credentials', () => {
  for (const unsafe of ['javascript:alert(1)', 'javascript://alert(1)', 'data:text/html,<script>x</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'ftp://host/file', 'tel:5551234', '//other.test', '/%2fother.test', '/\\other.test', 'https://user:secret@example.test', 'https://user@example.test', 'https://good.test\\@evil.test', 'https://good.test/%5cpath', 'https://good.test/%00', 'https://good.test/%0Apath', 'https://good.test/%09path', 'https://good.test/%7fpath', 'https://good.test/\rpath', 'https://good.test/\u0000path', 'https://good.test/%', ' mailto:person@example.test', 'mailto:', 'mailto://other.test']) {
    assert.equal(safeRemarkupHref(unsafe), null, unsafe);
    if (unsafe === unsafe.trim()) assert.equal(ofType(parsed(`[[ ${unsafe} | Open ]]`), 'link').length, 0, `an unsafe destination stays literal: ${unsafe}`);
  }
  for (const safe of ['https://example.test/a?b=c#d', 'http://example.test:8080/', '/path?q=1', '#section', 'mailto:person@example.test']) assert.equal(safeRemarkupHref(safe), safe);
  assert.deepEqual(ofType(parsed('[[  mailto:person@example.test  | Open ]]'), 'link').map(node => node.href), ['mailto:person@example.test'], 'document-link syntax trims URI padding before validation');
});

test('HTML, entities, interpreter bodies and malformed markers are retained as inert text', () => {
  // entities.txt is exact source; unknown interpreter functionality is deliberately absent.
  for (const body of ['< > & "', '<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '&lt;script&gt;not decoded&lt;/script&gt;', '${{{alert(1)}}}', 'graphviz {{{\n<img src=x>\n}}}', '%%%\n<script>do not run</script>\n%%%', '**unclosed //unfinished', '[[ missing end', '[empty]()']) {
    const document = parsed(body); sourceSpans(document, body);
    assert.ok(nodes(document).every(node => !Object.hasOwn(node, 'html') && !Object.hasOwn(node, 'dangerouslySetInnerHTML')));
    assert.equal(ofType(document, 'link').length, 0);
    assert.ok(document.blocks.map(content).join('\n').includes(body.includes('\n') ? body.split('\n')[1]! : body), body);
  }
});

test('source spans remain exact through CRLF, Unicode, nested blocks, links and captured mentions', () => {
  const body = '😀 **@Alice**\r\nnext //text//\r\n\r\n> - first @Bob\r\n> - second `@hidden`\r\n\r\n[[ https://example.test/a | 🧑🏽‍💻 ]]\r\n\r\n  code @literal\r\n';
  const document = parsed(body); sourceSpans(document, body);
  const text = ofType(document, 'text');
  assert.deepEqual(scanMentions(body).map(token => token.username), ['alice', 'bob']);
  for (const token of scanMentions(body)) assert.ok(text.some(node => node.start <= token.start && node.end >= token.end), 'captured mention can be rendered against its original contiguous source span');
  assert.deepEqual(parseRemarkup(body), document, 'parsing is deterministic and does not mutate source or mention interpretation');
});

test('syntactic mention tokens precede inline styles even without resolved or legacy identity proof', () => {
  // MentionRemarkupRule priority500 stores every syntactic token before the
  // underline/style rules at1000; resolution is not a parsing prerequisite.
  for (const body of ['@alice__name__', '**@alice__name__**', 'Unknown @not__registered__ and __ordinary underline__.']) {
    const document = parsed(body), text = ofType(document, 'text');
    sourceSpans(document, body);
    for (const token of scanMentions(body)) assert.ok(text.some(node => node.start <= token.start && node.end >= token.end), 'a username must remain one exact text span');
    const underlined = ofType(document, 'underline').map(content);
    assert.deepEqual(underlined, body.includes('ordinary underline') ? ['ordinary underline'] : []);
    const html = renderToStaticMarkup(createElement(DiscussionBody, { body }));
    for (const token of scanMentions(body)) assert.ok(html.includes(body.slice(token.start, token.end)), 'legacy/unresolved names are literal until optional proof is verified');
    assert.doesNotMatch(html, /class="person-mention"/, 'no proof must not invent a resolved person');
  }
  const wrapped = parsed('**@alice__name__**');
  assert.deepEqual(ofType(wrapped, 'strong').map(content), ['@alice__name__']);
});

test('bounded fallback preserves the entire raw source and never returns partial rich output', () => {
  for (const [body, expected] of [['x'.repeat(REMARKUP_LIMITS.bodyLength + 1), 'length'], ['> '.repeat(REMARKUP_LIMITS.depth + 1) + 'nested', 'depth']] as const) {
    const document = parseRemarkup(body);
    assert.equal(document.fallback, expected);
    assert.deepEqual(document.blocks, [{ type: 'literal', text: body, start: 0, end: body.length }]);
  }
  assert.equal(parseRemarkup('x'.repeat(REMARKUP_LIMITS.bodyLength)).fallback, null);
  const crowded = '`a` '.repeat(4500), bounded = parseRemarkup(crowded);
  assert.ok(bounded.fallback === 'nodes' || bounded.fallback === 'work');
  assert.deepEqual(bounded.blocks, [{ type: 'literal', text: crowded, start: 0, end: crowded.length }]);
});

test('discussion rendering creates only safe structural elements and keeps exact raw source available', () => {
  const body = '**Important**\n\n- [X] Complete\n\n[[ https://example.test/a?x=1&y=2 | External ]]\n\n[[ javascript://alert(1) | Unsafe ]]\n\n<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>';
  const html = renderToStaticMarkup(createElement(DiscussionBody, { body }));
  assert.match(html, /<strong>Important<\/strong>/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*disabled=""/);
  assert.match(html, /href="https:\/\/example\.test\/a\?x=1&amp;y=2"/);
  assert.match(html, /rel="nofollow noopener noreferrer"/); assert.match(html, /referrerPolicy="no-referrer"/i);
  assert.doesNotMatch(html, /<(?:script|img|iframe|object|embed)\b/i);
  assert.doesNotMatch(html, /<a\b[^>]*href="(?:javascript|data|vbscript):/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /aria-label="Exact comment source"/);
  assert.match(html, /\*\*Important\*\*/); assert.match(html, /Copy Source/);
});

test('deterministic malformed-input fuzz preserves every leaf and span without crashes', () => {
  const fragments = ['a', '😀', '🧑🏽‍💻', '\r\n', '\r', '\n', '\u0001', '\0', '**', '//', '__', '~~', '!!', '`', '##', '[[', ']]', '[', ']', '(', ')', '>', '> ', '>>!', '  ', '- ', '3. ', '[X] ', '%%%\n', '```\n', 'lang=js\n', 'NOTE: ', 'graphviz {{{', '}}}', 'https://x/', '@alice__name__', '&lt;', '<script>'];
  let state = 0x10293847;
  const random = (max: number) => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % max; };
  for (let sample = 0; sample < 1200; sample++) {
    let body = ''; const length = 1 + random(50);
    for (let at = 0; at < length; at++) body += fragments[random(fragments.length)]!;
    const document = parseRemarkup(body);
    try {
      sourceSpans(document, body);
      assert.ok(nodes(document).length <= REMARKUP_LIMITS.nodes);
      assert.ok(ofType(document, 'link').every(node => safeRemarkupHref(node.href) === node.href));
      assert.deepEqual(parseRemarkup(body), document);
      if (document.fallback) assert.deepEqual(document.blocks, [{ type: 'literal', text: body, start: 0, end: body.length }]);
    } catch (failure) { throw new Error(`Malformed-input sample ${sample}: ${JSON.stringify(body)}`, { cause: failure }); }
  }
});

test('pathological marker and URL patterns stay bounded in a separate process', () => {
  const cases = [
    '['.repeat(20_000), ']('.repeat(10_000), '[a]('.repeat(4999), '[label](' + '('.repeat(19_990),
    '[[https://a/' + '('.repeat(19_980), '`'.repeat(20_000), '*'.repeat(20_000), '__'.repeat(10_000),
    'http' + 'a'.repeat(19_990) + '://x', 'http://x/' + ')'.repeat(19_990),
    '> '.repeat(9999) + 'x', '  '.repeat(9999) + 'x', ' '.repeat(19_999) + '-',
    ('[x](https://a/(b)) **bold** __u__ @unknown\r\n').repeat(450),
    '[x](' + ' '.repeat(19_995) + 'x',
  ];
  assert.ok(cases.every(body => body.length <= REMARKUP_LIMITS.bodyLength));
  const script = `import { readFileSync } from 'node:fs'; import { parseRemarkup } from './shared/remarkup.ts'; const cases=JSON.parse(readFileSync(0,'utf8')); const results=cases.map(body=>{const start=performance.now();const doc=parseRemarkup(body);return {ms:performance.now()-start,fallback:doc.fallback,valid:doc.format==='phabricator.remarkup.v1'&&(!doc.fallback||(doc.blocks.length===1&&doc.blocks[0].type==='literal'&&doc.blocks[0].text===body))};});process.stdout.write(JSON.stringify(results));`;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { input: JSON.stringify(cases), encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024 });
  const results = JSON.parse(output) as { ms: number; valid: boolean; fallback: string | null }[];
  assert.equal(results.length, cases.length);
  assert.equal(results[0]!.fallback, 'work', 'dense unmatched brackets must retire before either link regex or frozen mention scan');
  assert.equal(results[11]!.fallback, null, 'long code indentation is processed linearly without losing supported formatting');
  assert.equal(results[12]!.fallback, null, 'leading whitespace plus a lone marker is not itself a reason to discard formatting');
  assert.equal(results[14]!.fallback, 'work', 'long ambiguous link whitespace must retire before regex backtracking');
  // Actual local patterns stay well below100ms; one-second CI headroom is not
  // the algorithmic guard. The structural preflight assertions above are.
  for (const [index, result] of results.entries()) { assert.equal(result.valid, true); assert.ok(result.ms < 1000, `Pattern ${index} exceeded one second (${result.ms}ms)`); }
});
