import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fromBufferPromise } from 'yauzl';
import { ZipFile } from 'yazl';
import { inspectDocx, exportDocxDiscussion } from './docx-package.ts';
import { DOCX_DISCUSSION_LIMITS, type DocxPackageComment, type DocxPassageInput } from '../shared/docx-discussion.ts';
import type { DocxProjection } from '../shared/docx.ts';

const fixture = () => readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url));
const who = { author: 'Workspace Reviewer', date: '2026-01-02T03:04:05.000Z' };
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const ct = 'http://schemas.openxmlformats.org/package/2006/content-types';
const rel = 'http://schemas.openxmlformats.org/package/2006/relationships';
const commentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
async function entries(bytes: Uint8Array): Promise<Map<string, Buffer>> {
  const zip = await fromBufferPromise(Buffer.from(bytes)); const result = new Map<string, Buffer>();
  try { for await (const entry of zip.eachEntry()) { const chunks: Buffer[] = []; for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(Buffer.from(chunk)); result.set(entry.fileName, Buffer.concat(chunks)); } }
  finally { zip.close(); } return result;
}
async function archive(parts: Map<string, Buffer>): Promise<Buffer> {
  const zip = new ZipFile(), chunks: Buffer[] = []; const done = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on('data', chunk => chunks.push(Buffer.from(chunk))); zip.outputStream.once('end', () => resolve(Buffer.concat(chunks))); zip.outputStream.once('error', reject); });
  for (const [name, bytes] of parts) zip.addBuffer(bytes, name); zip.end(); return done;
}
async function modify(transform: (parts: Map<string, Buffer>) => void): Promise<Buffer> { const parts = await entries(await fixture()); transform(parts); return archive(parts); }
function passage(projection: DocxProjection, text = 'The original result is clear.', start = 4, end = 12): DocxPassageInput {
  const range = projection.editableRanges.find(range => range.text === text); assert.ok(range, `expected editable range ${text}`);
  return { rangeId: range.id, start, end, quote: text.slice(start, end) };
}
const comment = (projection: DocxProjection, body = 'Please substantiate this result.'): DocxPackageComment => ({ passage: passage(projection), ...who, body });
const newComments = (projection: DocxProjection) => projection.comments.filter(comment => comment.author === who.author);
function anchoredText(projection: DocxProjection, id: string): string { return projection.blocks.flatMap(block => block.runs).filter(run => run.commentIds?.includes(id)).map(run => run.text).join(''); }

// ZIP entry payloads, not a reserialized DOM or a renderer, are the preservation oracle.
test('classic comment export preserves unrelated entry bytes, existing comments, manuscript text and lexical XML outside the selected run', async () => {
  const bytes = await fixture(), original = Buffer.from(bytes), before = await entries(bytes), p = await inspectDocx(bytes), input = comment(p);
  const result = await exportDocxDiscussion(bytes, [input]), after = await entries(result.bytes);
  assert.deepEqual(bytes, original); assert.deepEqual([...after.keys()], [...before.keys()]);
  for (const [name, data] of before) if (![p.mainPart, 'word/comments.xml'].includes(name)) assert.deepEqual(after.get(name), data, name);
  const span = JSON.parse(input.passage.rangeId) as [string, string, number, number], oldXml = before.get(p.mainPart)!.toString(), newXml = after.get(p.mainPart)!.toString();
  assert.ok(newXml.startsWith(oldXml.slice(0, span[2]))); assert.ok(newXml.endsWith(oldXml.slice(span[3])));
  const oldComments = before.get('word/comments.xml')!.toString(); assert.ok(after.get('word/comments.xml')!.toString().startsWith(oldComments.slice(0, oldComments.indexOf('</w:comments>'))));
  assert.deepEqual(result.projection.comments.find(comment => comment.id === '7'), p.comments[0]);
  assert.deepEqual(result.projection.blocks.map(block => block.text), p.blocks.map(block => block.text)); assert.deepEqual(result.projection.notes, p.notes);
  assert.deepEqual(result.projection.changes.map(({ id: _id, ...change }) => change), p.changes.map(({ id: _id, ...change }) => change));
  const added = newComments(result.projection); assert.equal(added.length, 1); assert.equal(anchoredText(result.projection, added[0]!.id), 'original');
  assert.deepEqual(await inspectDocx(result.bytes), result.projection);
});

test('crossing, nested and duplicate selections in one bold run retain exact independent anchors and formatting', async () => {
  const bytes = await fixture(), p = await inspectDocx(bytes), text = 'The original result is clear.';
  const selections = [[0, 12], [4, 20], [4, 12], [12, text.length], [4, 12]] as const;
  const comments = selections.map(([start, end], index) => ({ ...who, passage: passage(p, text, start, end), body: `Thread ${index}` }));
  const result = await exportDocxDiscussion(bytes, comments), added = newComments(result.projection), xml = (await entries(result.bytes)).get(p.mainPart)!.toString();
  assert.equal(added.length, comments.length); for (let index = 0; index < added.length; index++) { assert.equal(anchoredText(result.projection, added[index]!.id), comments[index]!.passage.quote); assert.equal(added[index]!.blocks[0]!.text, comments[index]!.body); }
  const paragraph = xml.slice(xml.indexOf('<w:p><docxComment:commentRangeStart'), xml.indexOf('A note supports'));
  const textRuns = [...paragraph.matchAll(/<w:r>(.*?)<\/w:r>/g)].map(match => match[1]!).filter(run => run.includes('<w:t'));
  assert.equal(textRuns.length, 4); assert.ok(textRuns.every(run => run.includes('<w:rPr><w:b/></w:rPr>')));
  assert.deepEqual(result.projection.blocks.map(block => block.text), p.blocks.map(block => block.text));
});

test('new ranges can overlap imported comments without changing their existing text, IDs or markers', async () => {
  const bytes = await fixture(), p = await inspectDocx(bytes), text = 'This passage has a reviewer comment.';
  const input = { ...who, passage: passage(p, text, 5, 12), body: 'Independent application discussion.' };
  const result = await exportDocxDiscussion(bytes, [input]), xml = (await entries(result.bytes)).get(p.mainPart)!.toString();
  assert.equal(anchoredText(result.projection, '7'), text); assert.equal(anchoredText(result.projection, newComments(result.projection)[0]!.id), 'passage');
  for (const marker of ['<w:commentRangeStart w:id="7"/>', '<w:commentRangeEnd w:id="7"/>', '<w:r><w:commentReference w:id="7"/></w:r>']) assert.ok(xml.includes(marker));
  assert.deepEqual(result.projection.comments[0], p.comments[0]);
});

function removeComments(parts: Map<string, Buffer>): void {
  parts.delete('word/comments.xml');
  parts.set('word/_rels/document.xml.rels', Buffer.from(parts.get('word/_rels/document.xml.rels')!.toString().replace(/<Relationship\b[^>]*Type="[^"]*\/comments"[^>]*\/>/, '')));
  parts.set('[Content_Types].xml', Buffer.from(parts.get('[Content_Types].xml')!.toString().replace(/<Override\b[^>]*PartName="\/word\/comments.xml"[^>]*\/>/, '')));
  parts.set('word/document.xml', Buffer.from(parts.get('word/document.xml')!.toString().replace(/<w:commentRange(?:Start|End)\b[^>]*\/>/g, '').replace(/<w:r><w:commentReference\b[^>]*\/><\/w:r>/g, '')));
}
test('new classic comments parts use collision-free part names and relationship IDs while preserving opaque orphan parts', async () => {
  const bytes = await modify(parts => {
    removeComments(parts); parts.set('word/COMMENTS.xml', Buffer.from('<opaque xmlns="urn:opaque">Leave me alone.</opaque>'));
    parts.set('[Content_Types].xml', Buffer.from(parts.get('[Content_Types].xml')!.toString().replace('</Types>', `<Override PartName="/word/comments-1.xml" ContentType="${commentType}"/></Types>`)));
    parts.set('word/_rels/document.xml.rels', Buffer.from(parts.get('word/_rels/document.xml.rels')!.toString().replace('</Relationships>', `<Relationship Id="rIdPhabricatorComments" Type="${office}hyperlink" Target="https://invalid.test/no-fetch" TargetMode="External"/></Relationships>`)));
  });
  const p = await inspectDocx(bytes), before = await entries(bytes), result = await exportDocxDiscussion(bytes, [comment(p)]), after = await entries(result.bytes);
  assert.ok(after.has('word/comments-2.xml')); assert.deepEqual(after.get('word/COMMENTS.xml'), before.get('word/COMMENTS.xml'));
  assert.match(after.get('word/_rels/document.xml.rels')!.toString(), /Id="rIdPhabricatorCommentsX"[^>]*Target="comments-2.xml"/);
  assert.equal(result.projection.comments.length, 1); assert.equal(anchoredText(result.projection, result.projection.comments[0]!.id), 'original');
  for (const [name, data] of before) if (![p.mainPart, 'word/_rels/document.xml.rels', '[Content_Types].xml'].includes(name)) assert.deepEqual(after.get(name), data, name);
});

async function minimal(strict: boolean, encoding: 'utf8' | 'utf16le' | 'utf16be', relationships: boolean): Promise<Buffer> {
  const namespace = strict ? 'http://purl.oclc.org/ooxml/wordprocessingml/main' : word, prefix = strict ? 'http://purl.oclc.org/ooxml/officeDocument/relationships/' : office;
  const main = `<?xml version="1.0" encoding="${encoding === 'utf8' ? 'UTF-8' : 'UTF-16'}"?><different:document xmlns:different="${namespace}"><different:body><different:p><different:r><different:rPr><different:b/></different:rPr><different:t xml:space="preserve">  A 😀 B&#13; end  </different:t></different:r></different:p></different:body></different:document>`;
  let encoded = Buffer.from(main, encoding === 'utf8' ? 'utf8' : 'utf16le'); if (encoding === 'utf16be') encoded = encoded.swap16(); if (encoding !== 'utf8') encoded = Buffer.concat([Buffer.from(encoding === 'utf16le' ? [255, 254] : [254, 255]), encoded]);
  const parts = new Map([
    ['[Content_Types].xml', Buffer.from(`<Types xmlns="${ct}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/alternate/manuscript.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)],
    ['_rels/.rels', Buffer.from(`<Relationships xmlns="${rel}"><Relationship Id="office" Type="${prefix}officeDocument" Target="alternate/manuscript.xml"/></Relationships>`)],
    ['alternate/manuscript.xml', encoded],
  ]);
  if (relationships) parts.set('alternate/_rels/manuscript.xml.rels', Buffer.from(`<r:Relationships xmlns:r="${rel}"/>`));
  return archive(parts);
}
test('Strict and Transitional namespaces, UTF-8/UTF-16, alternate main paths and absent/self-closing relationships export valid classic comments', async () => {
  for (const strict of [false, true]) for (const encoding of ['utf8', 'utf16le', 'utf16be'] as const) {
    const bytes = await minimal(strict, encoding, strict), p = await inspectDocx(bytes), range = p.editableRanges[0]!, body = '  Preserve & < > " \' 😀\r\nnext\ttab\rfinal  ';
    const result = await exportDocxDiscussion(bytes, [{ ...who, author: who.author + '\t&', passage: { rangeId: range.id, start: 4, end: 6, quote: '😀' }, body }]);
    const added = result.projection.comments[0]!; assert.equal(added.blocks[0]!.text, body); assert.equal(added.author, who.author + '\t&'); assert.equal(anchoredText(result.projection, added.id), '😀');
    assert.deepEqual(result.projection.blocks.map(block => block.text), p.blocks.map(block => block.text));
    const output = await entries(result.bytes); if (encoding !== 'utf8') assert.deepEqual(output.get(p.mainPart)!.subarray(0, 2), (await entries(bytes)).get(p.mainPart)!.subarray(0, 2));
    assert.match(output.get('alternate/_rels/manuscript.xml.rels')!.toString(), strict ? /purl.oclc.org\/ooxml\/officeDocument\/relationships\/comments/ : /schemas.openxmlformats.org\/officeDocument\/2006\/relationships\/comments/);
  }
});

test('existing empty self-closing comment collections expand without replacing their attributes or encoding', async () => {
  const bytes = await modify(parts => { removeComments(parts); const p = 'word/comments.xml'; parts.set(p, Buffer.from(`<?xml version="1.0"?><x:comments xmlns:x="${word}" xmlns:opaque="urn:opaque" opaque:retain="yes"/>`)); parts.set('word/_rels/document.xml.rels', Buffer.from(parts.get('word/_rels/document.xml.rels')!.toString().replace('</Relationships>', `<Relationship Id="comments" Type="${office}comments" Target="comments.xml"/></Relationships>`))); parts.set('[Content_Types].xml', Buffer.from(parts.get('[Content_Types].xml')!.toString().replace('</Types>', `<Override PartName="/${p}" ContentType="${commentType}"/></Types>`))); });
  const p = await inspectDocx(bytes), output = await exportDocxDiscussion(bytes, [comment(p)]), xml = (await entries(output.bytes)).get('word/comments.xml')!.toString();
  assert.match(xml, /opaque:retain="yes">/); assert.ok(xml.endsWith('</x:comments>')); assert.equal(output.projection.comments.length, 1);
});

test('existing UTF-16 comment parts, point comments and unreferenced imported bodies remain exact', async () => {
  for (const encoding of ['utf16le', 'utf16be'] as const) {
    const bytes = await modify(parts => {
      const comments = parts.get('word/comments.xml')!.toString().replace('encoding="UTF-8"', 'encoding="UTF-16"');
      let data = Buffer.from(comments, 'utf16le'); if (encoding === 'utf16be') data = data.swap16();
      parts.set('word/comments.xml', Buffer.concat([Buffer.from(encoding === 'utf16le' ? [255, 254] : [254, 255]), data]));
      let main = parts.get('word/document.xml')!.toString().replace(/<w:commentRange(?:Start|End)\b[^>]*\/>/g, '');
      if (encoding === 'utf16be') main = main.replace('<w:r><w:commentReference w:id="7"/></w:r>', '');
      parts.set('word/document.xml', Buffer.from(main));
    });
    const p = await inspectDocx(bytes), result = await exportDocxDiscussion(bytes, [comment(p)]), before = (await entries(bytes)).get('word/comments.xml')!, after = (await entries(result.bytes)).get('word/comments.xml')!;
    assert.deepEqual(after.subarray(0, 2), before.subarray(0, 2));
    assert.deepEqual(result.projection.comments[0], p.comments[0]);
    const closing = Buffer.from('</w:comments>', 'utf16le'); if (encoding === 'utf16be') closing.swap16();
    assert.deepEqual(after.subarray(0, before.indexOf(closing)), before.subarray(0, before.indexOf(closing)));
  }
});

test('valid signed-decimal and large imported IDs are preserved while aliases and dangling links reject atomically', async () => {
  for (const key of ['-99999999999999999999999999999999', '+0007', ' +0007 ', '999999999999999999999999999999999999']) {
    const bytes = await modify(parts => { for (const name of ['word/document.xml', 'word/comments.xml']) parts.set(name, Buffer.from(parts.get(name)!.toString().replaceAll('w:id="7"', `w:id="${key}"`))); });
    const p = await inspectDocx(bytes), result = await exportDocxDiscussion(bytes, [comment(p)]); assert.equal(result.projection.comments[0]!.id, key); assert.equal(newComments(result.projection)[0]!.id, '1');
  }
  const variants = [
    (parts: Map<string, Buffer>) => parts.set('word/comments.xml', Buffer.from(parts.get('word/comments.xml')!.toString().replace('</w:comments>', '<w:comment w:id="+0007"><w:p/></w:comment></w:comments>'))),
    (parts: Map<string, Buffer>) => parts.set('word/comments.xml', Buffer.from(parts.get('word/comments.xml')!.toString().replace('w:id="7"', 'w:id="not-a-number"'))),
    (parts: Map<string, Buffer>) => parts.set('word/document.xml', Buffer.from(parts.get('word/document.xml')!.toString().replace('<w:commentRangeEnd w:id="7"/>', ''))),
    (parts: Map<string, Buffer>) => parts.set('word/document.xml', Buffer.from(parts.get('word/document.xml')!.toString().replace('<w:commentReference w:id="7"/>', '<w:commentReference w:id="8"/>'))),
    (parts: Map<string, Buffer>) => parts.set('word/document.xml', Buffer.from(parts.get('word/document.xml')!.toString().replace('<w:commentRangeStart w:id="7"/>', '<w:commentRangeStart w:id="7"/><w:commentRangeStart w:id="07"/>'))),
  ];
  for (const change of variants) { const bytes = await modify(change), original = Buffer.from(bytes); await assert.rejects((async () => exportDocxDiscussion(bytes, [comment(await inspectDocx(bytes))]))(), { status: 422 }); assert.deepEqual(bytes, original); }
});

test('malformed comments relationships, wrong content types and signed packages cannot be exported', async () => {
  const variants = [
    (parts: Map<string, Buffer>) => parts.set('word/_rels/document.xml.rels', Buffer.from(parts.get('word/_rels/document.xml.rels')!.toString().replace('Target="comments.xml"', 'Target="https://127.0.0.1:9/no-fetch" TargetMode="External"'))),
    (parts: Map<string, Buffer>) => parts.set('word/_rels/document.xml.rels', Buffer.from(parts.get('word/_rels/document.xml.rels')!.toString().replace('</Relationships>', `<Relationship Id="duplicate" Type="${office}comments" Target="comments.xml"/></Relationships>`))),
    (parts: Map<string, Buffer>) => parts.set('[Content_Types].xml', Buffer.from(parts.get('[Content_Types].xml')!.toString().replace(commentType, 'application/xml'))),
    (parts: Map<string, Buffer>) => parts.set('word/comments.xml', Buffer.from('<not-comments/>')),
    (parts: Map<string, Buffer>) => parts.set('_rels/.rels', Buffer.from(parts.get('_rels/.rels')!.toString().replace('</Relationships>', '<Relationship Id="signature" Type="http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin" Target="custom/unknown.bin"/></Relationships>'))),
  ];
  const good = await inspectDocx(await fixture());
  for (const change of variants) await assert.rejects(exportDocxDiscussion(await modify(change), [comment(good)]), { status: 422 });
});

test('passages are exact, main-part-only, nonempty UTF-16 selections with no surrogate splitting', async () => {
  const bytes = await fixture(), p = await inspectDocx(bytes), good = comment(p), note = p.editableRanges.find(range => range.part !== p.mainPart)!;
  for (const bad of [{ ...good.passage, quote: 'different' }, { ...good.passage, start: -1 }, { ...good.passage, end: 999 }, { ...good.passage, end: good.passage.start }, { ...good.passage, rangeId: 'forged' }, { rangeId: note.id, start: 1, end: 7, quote: 'Source' }]) await assert.rejects(exportDocxDiscussion(bytes, [{ ...good, passage: bad }]), { status: 422 });
  const emoji = await minimal(false, 'utf8', false), ep = await inspectDocx(emoji);
  await assert.rejects(exportDocxDiscussion(emoji, [{ ...good, passage: { rangeId: ep.editableRanges[0]!.id, start: 4, end: 5, quote: '\ud83d' } }]), { status: 422 });
  for (const invalid of [{ body: '' }, { body: '\u0000' }, { body: '\ud800' }, { author: '' }, { date: '2026-02-30T12:00:00Z' }, { date: 'not-a-date' }]) await assert.rejects(exportDocxDiscussion(bytes, [{ ...good, ...invalid }]), { status: 422 });
});

test('selection, total body and XML fragmentation limits are complete failures; cancellation retains source bytes', async () => {
  const bytes = await fixture(), p = await inspectDocx(bytes), good = comment(p, 'a');
  const full = await exportDocxDiscussion(bytes, Array.from({ length: DOCX_DISCUSSION_LIMITS.threads }, () => good)); assert.equal(newComments(full.projection).length, DOCX_DISCUSSION_LIMITS.threads);
  const large = await exportDocxDiscussion(bytes, [{ ...good, body: 'a'.repeat(DOCX_DISCUSSION_LIMITS.bodyLength) }]); assert.equal(newComments(large.projection)[0]!.blocks[0]!.text.length, DOCX_DISCUSSION_LIMITS.bodyLength);
  for (const input of [[], Array.from({ length: DOCX_DISCUSSION_LIMITS.threads + 1 }, () => good), [{ ...good, body: 'a'.repeat(DOCX_DISCUSSION_LIMITS.bodyLength) }, good]]) await assert.rejects(exportDocxDiscussion(bytes, input), { status: 422 });
  const inflated = await modify(parts => parts.set('word/document.xml', Buffer.from(parts.get('word/document.xml')!.toString().replace('<w:b/>', `<w:b/><w:rFonts w:ascii="${'a'.repeat(600_000)}"/>`))));
  const ip = await inspectDocx(inflated); await assert.rejects(exportDocxDiscussion(inflated, Array.from({ length: 16 }, (_, index) => ({ ...good, passage: passage(ip, 'The original result is clear.', index, index + 1) }))), /fragmentation|XML.*limit/);
  const controller = new AbortController(), pending = exportDocxDiscussion(bytes, [good], controller.signal); controller.abort(); await assert.rejects(pending, { status: 499, code: 'DOCX_CANCELED' }); assert.deepEqual(bytes, await fixture());
});
