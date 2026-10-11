import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { RevisionVersion } from '../shared/types';
import { sourceSnapshotCanonical } from '../shared/source-snapshot';
import { createDocxPassageAnchor, validDocxPassageAnchor, docxDiscussionBytes, docxDiscussionFilename, validDocxDiscussionExport, type DocxDiscussionExport, type DocxDiscussionExportInput } from '../shared/docx-discussion';
import { DOCX_LIMITS } from '../shared/docx';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const literal = `${'a'.repeat(79)}😀 quote & <literal> 😀${'b'.repeat(79)}`;
export function wordVersion(): RevisionVersion {
  const part = 'word/document.xml';
  const docx: NonNullable<RevisionVersion['docx']> = { format: 'docx', fileName: 'Motion.docx', bytes: 3, sha256: hash('zip'), sourceFile: { fileId: 'F1', bytes: 3, sha256: hash('zip') }, projection: { format: 'phabricator.docx.projection.v1', mainPart: part, blocks: [{ id: 'block', part, kind: 'paragraph', text: literal, runs: [{ text: literal, rangeId: 'range' }] }], notes: [], comments: [], changes: [], editableRanges: [{ id: 'range', blockId: 'block', part, text: literal }], warnings: [] } };
  return { id: 'version-a', revisionId: 'L1', number: 1, files: [], message: 'Imported', createdAt: '2026-01-01T00:00:00.000Z', docx, contentHash: hash(sourceSnapshotCanonical([], [], docx)) };
}
const input: DocxDiscussionExportInput = { versionId: 'version-a', contentHash: wordVersion().contentHash, expectedAccessEpoch: 3, threads: [{ threadId: 'thread-a', expectedThreadVersion: 2 }, { threadId: 'thread-b', expectedThreadVersion: 1 }] };
const exportValue = (bytes = Buffer.from([0, 255, 0xef, 0xbb, 0xbf, 13, 10])): DocxDiscussionExport => ({ format: 'phabricator.docx.discussion-export.v1', revisionId: 'L1', versionId: input.versionId, versionNumber: 1, contentHash: input.contentHash, sourceSha256: wordVersion().docx!.sha256, accessEpoch: 3, threads: input.threads.map(pin => ({ ...pin })), fileName: 'L1-v1-discussion.docx', bytes: bytes.length, sha256: hash(bytes), dataBase64: bytes.toString('base64') });

test('Word anchors preserve exact original package, run, Unicode quotation and bounded context without projecting across versions', () => {
  const version = wordVersion(), quote = 'quote & <literal>', start = literal.indexOf(quote), passage = { rangeId: 'range', start, end: start + quote.length, quote };
  const anchor = createDocxPassageAnchor(version, passage);
  assert.equal(anchor.quote, quote); assert.equal(anchor.versionId, version.id); assert.equal(anchor.part, 'word/document.xml'); assert.equal(anchor.blockId, 'block');
  assert.ok(anchor.prefix.length <= 80 && anchor.suffix.length <= 80); assert.ok(!/[\uD800-\uDFFF]/u.test(anchor.prefix + anchor.suffix));
  assert.ok(validDocxPassageAnchor(anchor, version));
  for (const modified of [{ ...version, id: 'later' }, { ...version, contentHash: 'a'.repeat(64) }]) assert.equal(validDocxPassageAnchor(anchor, modified), false);
  for (const modified of [{ ...anchor, prefix: 'invented' }, { ...anchor, part: 'word/footnotes.xml' }, { ...anchor, blockId: 'other' }]) assert.equal(validDocxPassageAnchor(modified, version), false);
  for (const bad of [{ ...passage, rangeId: 'other' }, { ...passage, start: -1 }, { ...passage, end: start }, { ...passage, start: 79, end: 80, quote: literal.slice(79, 80) }, { ...passage, quote: 'Quote & <literal>' }]) assert.throws(() => createDocxPassageAnchor(version, bad), RangeError);
  const note = structuredClone(version); note.docx!.projection.editableRanges[0]!.part = 'word/footnotes.xml'; assert.throws(() => createDocxPassageAnchor(note, passage));
  const duplicate = structuredClone(version); duplicate.docx!.projection.editableRanges.push({ ...duplicate.docx!.projection.editableRanges[0]! }); assert.throws(() => createDocxPassageAnchor(duplicate, passage));
});

test('Word discussion export verifies literal bytes and every source, thread, access and output identity before download', async () => {
  const version = wordVersion(), expected = Buffer.from(exportValue().dataBase64, 'base64');
  assert.deepEqual(Buffer.from(await docxDiscussionBytes(exportValue(), 'L1', input, version)), expected);
  for (const bad of [
    { ...exportValue(), revisionId: 'L2' }, { ...exportValue(), versionId: 'later' }, { ...exportValue(), versionNumber: 2 },
    { ...exportValue(), contentHash: 'a'.repeat(64) }, { ...exportValue(), sourceSha256: 'a'.repeat(64) }, { ...exportValue(), accessEpoch: 4 },
    { ...exportValue(), threads: [...input.threads].reverse() }, { ...exportValue(), threads: [{ threadId: 'thread-a', expectedThreadVersion: 3 }, input.threads[1]!] },
    { ...exportValue(), fileName: '../secret.docx' }, { ...exportValue(), bytes: 0 }, { ...exportValue(), bytes: DOCX_LIMITS.compressedBytes + 1 },
    { ...exportValue(), dataBase64: exportValue().dataBase64 + '\n' }, { ...exportValue(), sha256: '0'.repeat(64) },
    { ...exportValue(Buffer.from('f')), dataBase64: 'Zh==' },
  ]) await assert.rejects(docxDiscussionBytes(bad, 'L1', input, version));
  assert.equal(validDocxDiscussionExport(exportValue(), 'L1', { ...input, threads: [input.threads[0]!, input.threads[0]!] }, version), false);
  assert.equal(validDocxDiscussionExport(exportValue(), '../../x', input, version), false);
  const maximum = exportValue(Buffer.alloc(DOCX_LIMITS.compressedBytes, 0xff));
  assert.ok(validDocxDiscussionExport(maximum, 'L1', input, version));
  assert.equal(docxDiscussionFilename('L1', 1), 'L1-v1-discussion.docx'); assert.throws(() => docxDiscussionFilename('L1', 0));
});
