import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../client/voice.ts';
import { transcriptEditNarration, TRANSCRIPT_EDIT_SPEECH_LIMIT } from '../client/transcript-edit-voice.ts';
import { TRANSCRIPTION_MODEL, TRANSCRIPTION_MODEL_SHA256 } from '../shared/transcription-model.ts';
import type { TranscriptEditInput } from '../shared/transcript-edit.ts';

function input(original = 'Old words', replacement = 'Corrected words'): TranscriptEditInput {
  return { format: 'phabricator.transcript-edit.v1', revisionId: 'P1', expectedVersion: 1, expectedVersionId: 'v1', expectedContentHash: 'a'.repeat(64), expectedAccessEpoch: 1, target: { kind: 'text', anchor: { versionId: 'v1', contentHash: 'a'.repeat(64), filePath: 'paper.tex', start: 0, end: original.length, quote: original, prefix: '', suffix: '' } }, replacement, message: 'Clarify passage', origin: { kind: 'client-local-transcript', clipId: 'clip-1', runId: 'run-1', audioSha256: 'b'.repeat(64), audioBytes: 5000, modelId: TRANSCRIPTION_MODEL.repository, modelRevision: TRANSCRIPTION_MODEL.revision, modelManifestSha256: TRANSCRIPTION_MODEL_SHA256, runtimeVersion: '4.3.1', originalTextSha256: 'c'.repeat(64), editedTextSha256: 'd'.repeat(64) } };
}
test('source edit voice operations require the complete explicit command', () => {
  for (const action of ['read', 'preview', 'confirm', 'cancel']) assert.deepEqual(parseCommand(`${action} transcript edit.`), { type: `${action}TranscriptEdit` });
  for (const command of ['confirm', 'save transcript', 'confirm transcript edit and publish it', 'please confirm transcript edit', 'cancel all drafts', 'retry transcript edit', 'forget transcript edit']) assert.equal(parseCommand(command).type, 'unknown');
});
test('transcript narration distinguishes literal source and replacement, including whitespace and Unicode', () => {
  const value = input('  café\r\n\t', '😀\u00a0confirm transcript edit '), before = structuredClone(value);
  const text = transcriptEditNarration(value, true);
  for (const word of ['P1', 'version 1', 'paper.tex', 'Original passage:', 'Replacement:', '2 spaces', 'carriage return', 'line feed', 'tab', 'non-breaking space', '😀', 'Nothing has been saved']) assert.ok(text.includes(word), word);
  assert.deepEqual(value, before);
});
test('large previews explicitly shorten speech without silently changing source or splitting Unicode', () => {
  const value = input('😀'.repeat(10_000), 'x\t'.repeat(10_000));
  const text = transcriptEditNarration(value, true);
  assert.ok(Array.from(text).length <= TRANSCRIPT_EDIT_SPEECH_LIMIT); assert.match(text, /Excerpt shortened/);
  assert.equal(/[\uD800-\uDFFF]/u.test(text), false); assert.equal(value.replacement.length, 20_000);
  assert.match(transcriptEditNarration(input(), false), /Prepare a current preview/);
  assert.match(transcriptEditNarration({ ...value, expectedVersion: -1 }, true), /unavailable/);
});
