import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fromBufferPromise } from 'yauzl';
import { ZipFile } from 'yazl';
import { inspectDocx, replaceDocx, replaceDocxBatch } from './docx-package.ts';
import { DOCX_BATCH_LIMITS, docxBatchParagraphs, type DocxPassageReplacement } from '../shared/docx-batch.ts';
import type { DocxProjection } from '../shared/docx.ts';

const who = { author: 'Verified Reviewer', date: '2026-02-03T04:05:06.000Z' };
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function entries(bytes: Uint8Array): Promise<Map<string, Buffer>> {
  const zip = await fromBufferPromise(Buffer.from(bytes)), result = new Map<string, Buffer>();
  try { for await (const entry of zip.eachEntry()) { const chunks: Buffer[] = []; for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(Buffer.from(chunk)); result.set(entry.fileName, Buffer.concat(chunks)); } } finally { zip.close(); }
  return result;
}
async function fixture(transform: (xml: string) => string = xml => xml, encoding: 'utf8' | 'utf16le' | 'utf16be' = 'utf8', strict = false): Promise<Buffer> {
  const parts = await entries(await readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url)));
  let xml = transform(parts.get('word/document.xml')!.toString().replace('<w:body>', `<w:body><w:p w:rsidR="BEEF"><w:pPr><w:keepNext/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Alpha 😀 </w:t></w:r><!-- between runs retained --><w:r><w:rPr><w:i/></w:rPr><w:t>beta and gamma</w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t xml:space="preserve"> end.</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph unchanged tail.</w:t></w:r></w:p>`));
  if (strict) { for (const [name, bytes] of parts) if (name.endsWith('.xml') || name.endsWith('.rels')) parts.set(name, Buffer.from(bytes.toString().replaceAll(word, 'http://purl.oclc.org/ooxml/wordprocessingml/main').replaceAll('http://schemas.openxmlformats.org/officeDocument/2006/relationships/', 'http://purl.oclc.org/ooxml/officeDocument/relationships/'))); xml = xml.replaceAll(word, 'http://purl.oclc.org/ooxml/wordprocessingml/main').replaceAll('w:', 'other:').replace('xmlns:w=', 'xmlns:other='); }
  if (encoding !== 'utf8') xml = xml.replace(/encoding=['"]UTF-8['"]/, 'encoding="UTF-16"');
  let data = Buffer.from(xml, encoding === 'utf8' ? 'utf8' : 'utf16le');
  if (encoding === 'utf16be') data = data.swap16();
  if (encoding !== 'utf8') data = Buffer.concat([Buffer.from(encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff]), data]);
  parts.set('word/document.xml', data);
  const zip = new ZipFile(), chunks: Buffer[] = [], done = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on('data', chunk => chunks.push(Buffer.from(chunk))); zip.outputStream.once('end', () => resolve(Buffer.concat(chunks))); zip.outputStream.once('error', reject); });
  for (const [name, bytes] of parts) zip.addBuffer(bytes, name); zip.end(); return done;
}
function edit(projection: DocxProjection, paragraph: string, quote: string, replacement: string): DocxPassageReplacement {
  const block = projection.blocks.find(block => block.text === paragraph); assert.ok(block);
  const start = block.text.indexOf(quote); assert.ok(start >= 0); return { blockId: block.id, start, end: start + quote.length, quote, replacement };
}
const accepted = (projection: DocxProjection) => projection.blocks.map(block => block.runs.filter(run => run.change !== 'deleted' && run.change !== 'moveFrom').map(run => run.text).join(''));
test('multiple Word passages span styled runs and paragraphs atomically, retaining untouched XML and ZIP entries', async () => {
  const bytes = await fixture(), projection = await inspectDocx(bytes);
  const changes = [edit(projection, 'Alpha 😀 beta and gamma end.', '😀 beta and', 'evidence'), edit(projection, 'Second paragraph unchanged tail.', 'Second', 'Revised second'), edit(projection, 'Alpha 😀 beta and gamma end.', 'gamma', 'delta')];
  const result = await replaceDocxBatch(bytes, changes, who), before = await entries(bytes), after = await entries(result.bytes);
  assert.deepEqual([...after.keys()], [...before.keys()]); for (const [name, original] of before) if (name !== projection.mainPart) assert.deepEqual(after.get(name), original, name);
  const original = before.get(projection.mainPart)!.toString(), changed = after.get(projection.mainPart)!.toString();
  assert.ok(changed.includes('<!-- between runs retained -->')); assert.ok(changed.includes('<w:pPr><w:keepNext/></w:pPr>'));
  const unchangedRun = '<w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t xml:space="preserve"> end.</w:t></w:r>'; assert.ok(original.includes(unchangedRun)); assert.ok(changed.includes(unchangedRun));
  assert.ok(changed.includes('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">evidence</w:t>')); assert.ok(changed.includes('<w:rPr><w:i/></w:rPr><w:delText xml:space="preserve">beta and</w:delText>'));
  assert.deepEqual(accepted(result.projection).slice(0, 2), ['Alpha evidence delta end.', 'Revised second paragraph unchanged tail.']);
  const originalAfter = original.slice(original.indexOf('<w:p>', original.indexOf('Second paragraph'))); assert.ok(changed.endsWith(originalAfter));
  assert.deepEqual(await inspectDocx(result.bytes), result.projection); assert.deepEqual(result.projection.notes, projection.notes); assert.deepEqual(result.projection.comments, projection.comments);
  const edits = result.projection.changes.filter(change => change.author === who.author); assert.equal(edits.filter(change => change.kind === 'ins').length, 3); assert.equal(edits.filter(change => change.kind === 'del').map(change => change.text).join('|'), '😀 |beta and|gamma|Second');
});

test('batch rejects overlap, duplicates, malformed final edits and Unicode splits without changing input', async () => {
  const bytes = await fixture(), exact = Buffer.from(bytes), projection = await inspectDocx(bytes), first = edit(projection, 'Alpha 😀 beta and gamma end.', '😀 beta', 'review');
  const valid = edit(projection, 'Second paragraph unchanged tail.', 'Second', 'Next');
  for (const last of [{ ...valid, quote: 'forged' }, { ...valid, blockId: 'stale' }, { ...valid, replacement: '\ud800' }, { ...valid, replacement: '\n' }, { ...first, start: 7, end: 8, quote: '\ude00' }, first, { ...first, start: first.start + 2, quote: first.quote.slice(2) }]) await assert.rejects(replaceDocxBatch(bytes, [first, last], who), { status: 422 });
  assert.deepEqual(bytes, exact); assert.deepEqual(await inspectDocx(bytes), projection);
  await assert.rejects(replaceDocxBatch(bytes, [], who), { status: 422 });
  await assert.rejects(replaceDocxBatch(bytes, [first, { ...valid, replacement: 'x'.repeat(DOCX_BATCH_LIMITS.serializedBytes) }], who), /512 KiB/);
});

test('batch preserves UTF-8/UTF-16 bytes and namespace variations through real ZIP roundtrips', async () => {
  for (const encoding of ['utf8', 'utf16le', 'utf16be'] as const) {
    const bytes = await fixture(xml => xml, encoding, true), projection = await inspectDocx(bytes);
    const result = await replaceDocxBatch(bytes, [edit(projection, 'Alpha 😀 beta and gamma end.', '😀 beta', 'A & B < C 😀'), edit(projection, 'Second paragraph unchanged tail.', 'unchanged', '')], who);
    assert.deepEqual(accepted(result.projection).slice(0, 2), ['Alpha A & B < C 😀 and gamma end.', 'Second paragraph  tail.']);
    const before = await entries(bytes), after = await entries(result.bytes); for (const [name, original] of before) if (name !== projection.mainPart) assert.deepEqual(after.get(name), original);
    if (encoding !== 'utf8') assert.deepEqual(after.get(projection.mainPart)!.subarray(0, 2), before.get(projection.mainPart)!.subarray(0, 2));
  }
});

test('complex paragraphs are refused rather than flattened, including field, note, revision, hyperlink and bookmark markup', async () => {
  for (const markup of ['<w:bookmarkStart w:id="99" w:name="bookmark"/>', '<w:r><w:footnoteReference w:id="2"/></w:r>', '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>', '<w:ins w:id="77"><w:r><w:t>inserted</w:t></w:r></w:ins>', '<w:hyperlink><w:r><w:t>linked</w:t></w:r></w:hyperlink>']) {
    const bytes = await fixture(xml => xml.replace('<!-- between runs retained -->', markup)), projection = await inspectDocx(bytes), block = projection.blocks[0]!;
    await assert.rejects(replaceDocxBatch(bytes, [{ blockId: block.id, start: 0, end: 5, quote: 'Alpha', replacement: 'Revised' }], who), { status: 422 });
  }
});

test('the batch supports more than 64 passages with no fixed count cap', async () => {
  const bytes = await fixture(xml => xml.replace('<w:body>', '<w:body>' + Array.from({ length: 80 }, (_, i) => `<w:p><w:r><w:t>Passage ${i} original.</w:t></w:r></w:p>`).join(''))), projection = await inspectDocx(bytes);
  const changes = docxBatchParagraphs(projection).slice(0, 80).map(block => ({ blockId: block.id, start: 0, end: 7, quote: 'Passage', replacement: 'Reviewed' }));
  const result = await replaceDocxBatch(bytes, changes, who); assert.equal(result.projection.changes.filter(change => change.author === who.author && change.kind === 'ins').length, 80); assert.ok(accepted(result.projection).slice(0, 80).every(text => text.startsWith('Reviewed')));
});

test('batch and single-run revision IDs avoid signed and whitespace decimal aliases', async () => {
  const bytes = await fixture(xml => xml.replace('<w:body>', '<w:body><w:p><w:ins w:id=" +00900 " w:author="Original"><w:r><w:t>Existing revision.</w:t></w:r></w:ins></w:p>')), projection = await inspectDocx(bytes);
  const original = (await entries(bytes)).get(projection.mainPart)!.toString(), preserved = '<w:ins w:id=" +00900 " w:author="Original"><w:r><w:t>Existing revision.</w:t></w:r></w:ins>';
  assert.ok(original.includes(preserved));
  const range = projection.editableRanges.find(item => item.text === 'Alpha 😀 ')!;
  const single = await replaceDocx(bytes, { rangeId: range.id, start: 0, end: 5, quote: 'Alpha', replacement: 'Single' }, who);
  const batch = await replaceDocxBatch(bytes, [edit(projection, 'Alpha 😀 beta and gamma end.', '😀 beta', 'Batch')], who);
  for (const output of [single, batch]) {
    const xml = (await entries(output.bytes)).get(projection.mainPart)!.toString(); assert.ok(xml.includes(preserved));
    const allocated = [...xml.matchAll(/(?:docxEdit|docxBatch):id="(\d+)"/g)].map(match => Number(match[1])); assert.ok(allocated.length >= 2); assert.equal(new Set(allocated).size, allocated.length); assert.ok(allocated.every(value => value > 900));
  }
  const exhausted = await fixture(xml => xml.replace('<w:body>', '<w:body><w:p><w:ins w:id=" +2147483647 "><w:r><w:t>Existing revision.</w:t></w:r></w:ins></w:p>')), exhaustedProjection = await inspectDocx(exhausted);
  await assert.rejects(replaceDocxBatch(exhausted, [edit(exhaustedProjection, 'Alpha 😀 beta and gamma end.', 'Alpha', 'Batch')], who), /revision IDs exceed/);
});
