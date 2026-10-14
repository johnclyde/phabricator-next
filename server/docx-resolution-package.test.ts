import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fromBufferPromise } from 'yauzl';
import { ZipFile } from 'yazl';
import { inspectDocx, inspectDocxResolution, replaceDocxBatch, resolveDocxChanges } from './docx-package.ts';
import { docxResolutionPreview, type DocxChangeDecision } from '../shared/docx-resolution.ts';

const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const who = { author: 'Workspace Editor', date: '2026-03-04T05:06:07.000Z' };
async function entries(bytes: Uint8Array): Promise<Map<string, Buffer>> {
  const zip = await fromBufferPromise(Buffer.from(bytes)), result = new Map<string, Buffer>();
  try { for await (const entry of zip.eachEntry()) { const chunks: Buffer[] = []; for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(Buffer.from(chunk)); result.set(entry.fileName, Buffer.concat(chunks)); } } finally { zip.close(); } return result;
}
async function fixture(prefix = '', transform: (xml: string) => string = xml => xml, encoding: 'utf8' | 'utf16le' | 'utf16be' = 'utf8'): Promise<Buffer> {
  const parts = await entries(await readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url))), zip = new ZipFile(), chunks: Buffer[] = [];
  let xml = transform(parts.get('word/document.xml')!.toString().replace('<w:body>', `<w:body>${prefix}`));
  if (encoding !== 'utf8') xml = xml.replace(/encoding=['"]UTF-8['"]/, 'encoding="UTF-16"');
  let data = Buffer.from(xml, encoding === 'utf8' ? 'utf8' : 'utf16le'); if (encoding === 'utf16be') data = data.swap16(); if (encoding !== 'utf8') data = Buffer.concat([Buffer.from(encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff]), data]); parts.set('word/document.xml', data);
  const done = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on('data', chunk => chunks.push(Buffer.from(chunk))); zip.outputStream.once('end', () => resolve(Buffer.concat(chunks))); zip.outputStream.once('error', reject); });
  for (const [name, bytes] of parts) zip.addBuffer(bytes, name); zip.end(); return done;
}
const acceptedText = (projection: Awaited<ReturnType<typeof inspectDocx>>) => projection.blocks.map(block => block.runs.filter(run => !['deleted', 'moveFrom'].includes(run.change || '')).map(run => run.text).join(''));
test('accepting or rejecting selected text revisions preserves every unrelated byte and permits another tracked edit', async () => {
  const source = await fixture('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Alpha </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>beta argument.</w:t></w:r></w:p>'), initial = await inspectDocx(source), paragraph = initial.blocks[0]!;
  const edited = await replaceDocxBatch(source, [{ blockId: paragraph.id, start: 0, end: 10, quote: 'Alpha beta', replacement: 'Reviewed evidence' }], who), inspection = await inspectDocxResolution(edited.bytes), selected = inspection.changes.filter(change => change.author === who.author);
  assert.equal(selected.length, 3); assert.ok(inspection.changes.every(change => change.kind === 'ins' || change.kind === 'del'));
  const before = await entries(edited.bytes), originalXML = before.get(initial.mainPart)!.toString();
  for (const action of ['accept', 'reject'] as const) {
    const decisions = selected.map(change => ({ changeId: change.changeId, action })), preview = docxResolutionPreview(inspection, decisions), resolved = await resolveDocxChanges(edited.bytes, decisions), after = await entries(resolved.bytes);
    assert.equal(preview[0]!.before, 'Reviewed evidence argument.'); assert.equal(preview[0]!.after, action === 'accept' ? 'Reviewed evidence argument.' : 'Alpha beta argument.'); assert.equal(acceptedText(resolved.projection)[0], preview[0]!.after);
    for (const [name, bytes] of before) if (name !== initial.mainPart) assert.deepEqual(after.get(name), bytes, name);
    const changedXML = after.get(initial.mainPart)!.toString(); assert.ok(changedXML.endsWith(originalXML.slice(originalXML.indexOf('</w:p>') + '</w:p>'.length))); assert.equal(resolved.projection.changes.filter(change => change.author === who.author).length, 0); assert.equal(resolved.projection.changes.length, initial.changes.length);
    const newParagraph = resolved.projection.blocks[0]!, again = await replaceDocxBatch(resolved.bytes, [{ blockId: newParagraph.id, start: 0, end: newParagraph.text.length, quote: newParagraph.text, replacement: 'Another reviewed argument.' }], who); assert.equal(acceptedText(again.projection)[0], 'Another reviewed argument.');
    assert.deepEqual(await inspectDocx(resolved.bytes), resolved.projection);
  }
});

test('resolution pins lexical change identities even when imported IDs alias, and mixed decisions retain unselected XML', async () => {
  const keep = '<w:ins w:id="1" w:author="Imported"><w:r><w:t>keep insertion</w:t></w:r></w:ins>', remove = '<w:ins w:id=" +001 " w:author="Imported"><w:r><w:t>remove insertion</w:t></w:r></w:ins>';
  const bytes = await fixture(`<w:p>${keep}${remove}<w:del w:id="1" w:author="Imported"><w:r><w:delText>restore deletion</w:delText></w:r></w:del></w:p>`), inspection = await inspectDocxResolution(bytes), targets = inspection.changes.filter(change => ['remove insertion', 'restore deletion'].includes(change.text)); assert.equal(targets.length, 2); assert.notEqual(targets[0]!.changeId, targets[1]!.changeId);
  const result = await resolveDocxChanges(bytes, targets.map(change => ({ changeId: change.changeId, action: 'reject' }))), xml = (await entries(result.bytes)).get('word/document.xml')!.toString(); assert.ok(xml.includes(keep)); assert.ok(!xml.includes(remove)); assert.ok(xml.includes('<w:t>restore deletion</w:t>')); assert.equal(acceptedText(result.projection)[0], 'keep insertionrestore deletion');
  const supported = inspection.changes[0]!; for (const decisions of [[{ changeId: supported.changeId, action: 'accept' }, { changeId: 'w:id:1', action: 'accept' }], [{ changeId: supported.changeId, action: 'accept' }, { changeId: supported.changeId, action: 'reject' }]] as DocxChangeDecision[][]) await assert.rejects(resolveDocxChanges(bytes, decisions), { status: 422 });
  assert.deepEqual(await inspectDocxResolution(bytes), inspection);
});

test('UTF-8/UTF-16 and wrapper-local namespace bindings survive accepting insertions and restoring deletions', async () => {
  for (const encoding of ['utf8', 'utf16le', 'utf16be'] as const) for (const strict of [false, true]) {
    const namespace = strict ? 'http://purl.oclc.org/ooxml/wordprocessingml/main' : word;
    const bytes = await fixture(`<w:p><w:ins xmlns:q="${namespace}" w:id="70"><q:r><q:rPr><q:b/></q:rPr><q:t>New &amp; 😀</q:t></q:r></w:ins><w:del xmlns="${namespace}" w:id="71"><r><rPr><i/></rPr><delText xml:space="preserve"> old &#13; text</delText></r></w:del></w:p>`, xml => strict ? xml.replaceAll(word, namespace) : xml, encoding), inspection = await inspectDocxResolution(bytes), selected = inspection.changes.filter(change => change.text.includes('😀') || change.text.includes('old \r text'));
    assert.equal(selected.length, 2); const result = await resolveDocxChanges(bytes, selected.map(change => ({ changeId: change.changeId, action: change.kind === 'ins' ? 'accept' : 'reject' }))); assert.equal(acceptedText(result.projection)[0], 'New & 😀 old \r text');
    const before = await entries(bytes), after = await entries(result.bytes); for (const [name, bytes] of before) if (name !== result.projection.mainPart) assert.deepEqual(after.get(name), bytes); if (encoding !== 'utf8') assert.deepEqual(after.get(result.projection.mainPart)!.subarray(0, 2), before.get(result.projection.mainPart)!.subarray(0, 2));
    const block = result.projection.blocks[0]!; assert.equal(result.projection.editableRanges.filter(range => range.blockId === block.id).length, 2);
  }
});

test('unsafe, nested, field, note, table and formatting/move selections reject the entire request', async () => {
  const insertion = '<w:ins w:id="81"><w:r><w:t>Unsafe target</w:t></w:r></w:ins>';
  for (const markup of [`<w:p><w:ins w:id="80">${insertion}</w:ins></w:p>`, `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r></w:p><w:p>${insertion}</w:p><w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`, `<w:p>${insertion}<w:r><w:footnoteReference w:id="2"/></w:r></w:p>`, `<w:tbl><w:tr><w:tc><w:p>${insertion}</w:p></w:tc></w:tr></w:tbl>`, `<w:p><w:pPr><w:pPrChange w:id="83"><w:pPr/></w:pPrChange></w:pPr>${insertion}</w:p>`, `<w:p><w:moveFrom w:id="84"><w:r><w:t>Unsafe target</w:t></w:r></w:moveFrom></w:p>`, `<w:bookmarkStart w:id="99" w:name="test"/><w:p>${insertion}</w:p><w:bookmarkEnd w:id="99"/>`]) {
    const bytes = await fixture(markup), projection = await inspectDocx(bytes), inspection = await inspectDocxResolution(bytes), target = projection.changes.find(change => change.text === 'Unsafe target')!; assert.ok(target); assert.ok(inspection.unsupportedChanges.some(change => change.changeId === target.id));
    const supported = inspection.changes[0]!; assert.ok(supported); await assert.rejects(resolveDocxChanges(bytes, [{ changeId: supported.changeId, action: 'accept' }, { changeId: target.id, action: 'reject' }]), { status: 422 }); assert.deepEqual(await inspectDocx(bytes), projection);
  }
});

test('more than 64 supported changes resolve completely without a fixed count cap', async () => {
  const bytes = await fixture(Array.from({ length: 90 }, (_, index) => `<w:p><w:ins w:id="${100 + index}"><w:r><w:t>Change ${index}</w:t></w:r></w:ins></w:p>`).join('')), inspection = await inspectDocxResolution(bytes), decisions = inspection.changes.map(change => ({ changeId: change.changeId, action: 'accept' as const }));
  assert.ok(decisions.length > 90); const result = await resolveDocxChanges(bytes, decisions); assert.equal(result.projection.changes.length, 0); assert.equal(acceptedText(result.projection)[89], 'Change 89');
});
