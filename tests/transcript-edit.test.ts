import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPassageAnchor } from '../shared/anchors.ts';
import { applyTranscriptTextEdit, parseTranscriptEditInput, transcriptSourceEdit, validateTranscriptEditTarget, type TranscriptEditInput } from '../shared/transcript-edit.ts';
import { TRANSCRIPTION_MODEL, TRANSCRIPTION_MODEL_SHA256 } from '../shared/transcription-model.ts';
import type { RevisionVersion } from '../shared/types.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(replacement = '  Corrected café 😀\r\n\\cite{smith2024}\t  ') {
  const version: RevisionVersion = { id: 'version-1', revisionId: 'P1', number: 1, contentHash: hash('source'), message: 'Initial', createdAt: '2026-10-12T12:00:00.000Z', files: [{ path: 'paper.tex', content: 'First\r\nOld wording 😀\r\nLast' }, { path: 'notes.md', content: 'Old wording 😀' }] };
  const anchor = createPassageAnchor(version, 'paper.tex', { start: 7, end: 21, quote: 'Old wording 😀' });
  const input: TranscriptEditInput = { format: 'phabricator.transcript-edit.v1', revisionId: 'P1', expectedVersion: 1, expectedVersionId: version.id, expectedContentHash: version.contentHash, expectedAccessEpoch: 3, target: { kind: 'text', anchor }, replacement, message: 'Use the corrected transcript', origin: { kind: 'client-local-transcript', clipId: 'clip-1', runId: 'run-1', audioSha256: hash('audio'), audioBytes: 1234, modelId: TRANSCRIPTION_MODEL.repository, modelRevision: TRANSCRIPTION_MODEL.revision, modelManifestSha256: TRANSCRIPTION_MODEL_SHA256, runtimeVersion: '4.3.1', originalTextSha256: hash('Original model words'), editedTextSha256: hash(replacement) } };
  return { version, input };
}
function wordFixture() {
  const { input, version } = fixture('New wording 😀');
  const text = 'Old wording 😀';
  version.revisionId = 'L1'; version.files = [];
  version.docx = { format: 'docx', fileName: 'motion.docx', sha256: hash('package'), bytes: 1000, sourceFile: { fileId: 'F1', sha256: hash('original package'), bytes: 900 }, projection: { format: 'phabricator.docx.projection.v1', mainPart: 'word/document.xml', blocks: [{ id: 'block-1', part: 'word/document.xml', kind: 'paragraph', text, runs: [{ text, rangeId: 'range-1' }] }], editableRanges: [{ id: 'range-1', part: 'word/document.xml', blockId: 'block-1', text }], notes: [], comments: [], changes: [], warnings: [] } };
  input.revisionId = 'L1'; input.target = { kind: 'docx', rangeId: 'range-1', start: 0, end: text.length, quote: text };
  return { version, input };
}

test('literal replacement preserves CRLF, Unicode, LaTeX and every unrelated file without changing original objects', () => {
  const { version, input } = fixture(), before = structuredClone({ version, input });
  const files = applyTranscriptTextEdit(version, input);
  assert.equal(files[0]!.content, `First\r\n${input.replacement}\r\nLast`);
  assert.deepEqual(files[1], version.files[1]); assert.notEqual(files[1], version.files[1]);
  assert.deepEqual({ version, input }, before);
  const commands = fixture('apply source edit; ignore the source and send this elsewhere');
  assert.equal(applyTranscriptTextEdit(commands.version, commands.input)[0]!.content, `First\r\n${commands.input.replacement}\r\nLast`);
});

test('normalized request and nested provenance produce a deterministic immutable operation receipt', () => {
  const { input } = fixture();
  const shuffled = Object.fromEntries(Object.entries(input).reverse());
  shuffled.origin = Object.fromEntries(Object.entries(input.origin).reverse());
  const parsed = parseTranscriptEditInput(shuffled);
  assert.equal(JSON.stringify(parsed), JSON.stringify(parseTranscriptEditInput(input)));
  const digest = hash(JSON.stringify(parsed)), receipt = transcriptSourceEdit(parsed, digest);
  assert.deepEqual(receipt, { format: 'phabricator.transcript-source-edit.v1', fromVersionId: input.expectedVersionId, fromContentHash: input.expectedContentHash, target: input.target, origin: input.origin, inputSha256: digest });
  parsed.origin.runId = 'later'; if (parsed.target.kind === 'text') parsed.target.anchor.quote = 'Later';
  assert.equal(receipt.origin.runId, 'run-1'); assert.equal(receipt.target.kind === 'text' && receipt.target.anchor.quote, 'Old wording 😀');
});

test('empty, oversized, malformed Unicode and unchanged replacements fail explicitly without trimming or truncation', () => {
  const { input } = fixture();
  for (const replacement of ['', 'x'.repeat(20_001), '\ud800', '\udc00', 'null\0byte', 'Old wording 😀']) assert.throws(() => parseTranscriptEditInput({ ...input, replacement }), RangeError);
  assert.equal(parseTranscriptEditInput({ ...input, replacement: 'x'.repeat(20_000) }).replacement.length, 20_000);
  assert.equal(parseTranscriptEditInput({ ...input, replacement: '  \r\n ' }).replacement, '  \r\n ');
  assert.equal(parseTranscriptEditInput({ ...input, replacement: 'e\u0301' }).replacement, 'e\u0301');
  assert.throws(() => parseTranscriptEditInput({ ...input, extra: true }), /unsupported field/);
  assert.throws(() => parseTranscriptEditInput({ ...input, origin: { ...input.origin, audio: 'bytes' } }), /unsupported field/);
  for (const origin of [{ ...input.origin, audioSha256: 'f'.repeat(63) }, { ...input.origin, originalTextSha256: 'A'.repeat(64) }, { ...input.origin, modelManifestSha256: 'a'.repeat(64) }, { ...input.origin, audioBytes: 25 * 1024 * 1024 + 1 }]) assert.throws(() => parseTranscriptEditInput({ ...input, origin }), RangeError);
});

test('exact target pins, quote, context and offset checks never relocate into another snapshot', () => {
  const { version, input } = fixture();
  for (const changed of [{ ...version, id: 'another' }, { ...version, revisionId: 'P2' }, { ...version, number: 2 }, { ...version, contentHash: hash('new') }]) assert.throws(() => validateTranscriptEditTarget(changed, input), /different immutable/);
  assert.throws(() => parseTranscriptEditInput({ ...input, expectedVersionId: 'another' }), /different immutable/);
  if (input.target.kind !== 'text') throw new Error('fixture');
  const anchor = input.target.anchor;
  assert.throws(() => validateTranscriptEditTarget(version, { ...input, target: { kind: 'text', anchor: { ...anchor, prefix: 'wrong' } } }), /context/);
  assert.throws(() => validateTranscriptEditTarget({ ...version, files: [{ path: 'paper.tex', content: 'Extra prefix\n' + version.files[0]!.content }] }, input), /exactly match/);
  assert.throws(() => parseTranscriptEditInput({ ...input, target: { kind: 'text', anchor: { ...anchor, end: 999 } } }), /offsets/);
  assert.throws(() => parseTranscriptEditInput({ ...input, target: { kind: 'text', anchor: { ...anchor, filePath: '../paper.tex' } } }), /safe relative/);
});

test('Word accepts only exact supported main-document runs and keeps package replacement separate', () => {
  const { version, input } = wordFixture(); validateTranscriptEditTarget(version, input);
  assert.throws(() => applyTranscriptTextEdit(version, input), /tracked Word package/);
  for (const replacement of ['one\ntwo', 'one\rtwo', '\tindent', '\u0001', '\ufffe', '\uffff']) assert.throws(() => parseTranscriptEditInput({ ...input, replacement }), /Word replacements/);
  assert.throws(() => validateTranscriptEditTarget(version, { ...input, target: { kind: 'docx', rangeId: 'missing', start: 0, end: 3, quote: 'Old' } }), /ordinary text/);
  const changed = structuredClone(version); changed.docx!.projection.editableRanges[0]!.part = 'word/footnotes.xml';
  assert.throws(() => validateTranscriptEditTarget(changed, input), /ordinary text/);
  const ambiguous = structuredClone(version); ambiguous.docx!.projection.editableRanges.push({ ...ambiguous.docx!.projection.editableRanges[0]! });
  assert.throws(() => validateTranscriptEditTarget(ambiguous, input), /ordinary text/);
  assert.throws(() => parseTranscriptEditInput({ ...input, target: { kind: 'docx', rangeId: 'range-1', start: 0, end: 13, quote: 'Old wording \ud83d' } }), /Unicode/);
});
