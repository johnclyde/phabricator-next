import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTranscriptSource, transcriptTextSha256, type TranscriptClip } from '../client/transcript-source.ts';
import { createAudioClip, createAudioInbox, type AudioClip, type AudioInbox } from '../client/audio-inbox.ts';
import { retainTemporaryAudio, discardTemporaryAudio } from '../client/audio-draft.ts';
import { retainTemporaryTranscript } from '../client/audio-transcript-drafts.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import { TRANSCRIPTION_MODEL, TRANSCRIPTION_MODEL_SHA256 } from '../shared/transcription-model.ts';
import type { LocalTranscript } from '../shared/local-transcription.ts';

const encoded = 'Audio test fixture bytes: local only.';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const session = (who = 'alice') => activateSession({ mode: 'password', workspaceId: 'source-edit', account: { id: who, username: who, displayName: who, disabled: false }, sessionContext: who, csrfToken: who, expiresAt: null });
const clip = (blob = new Blob([encoded], { type: 'audio/wav' })) => createAudioClip(blob, { title: 'Prose note', durationMs: 1000 });
const transcript = (audio: AudioClip, runId = 'run-1', text = 'Original model words'): LocalTranscript => ({ format: 'phabricator.local-transcript.v1', runId, clipId: audio.id, audioSha256: hash(encoded), audioBytes: audio.bytes, mimeType: audio.mimeType, createdAt: '2026-10-12T12:00:00.000Z', completedAt: '2026-10-12T12:00:01.000Z', decodedDurationMs: 1000, modelId: TRANSCRIPTION_MODEL.repository, modelRevision: TRANSCRIPTION_MODEL.revision, modelManifestSha256: TRANSCRIPTION_MODEL_SHA256, runtimeVersion: '4.3.1', device: 'wasm', dtype: 'q8', language: 'en', options: { sampleRate: 16000, chunkLengthS: 30, strideLengthS: 5 }, text });
const selected = (audio: AudioClip, temporary: boolean): TranscriptClip => ({ id: audio.id, title: audio.title, createdAt: audio.createdAt, mimeType: audio.mimeType, durationMs: audio.durationMs, bytes: audio.bytes, temporary });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function unavailableInbox(counters = { list: 0, read: 0 }) {
  return { list: async () => { counters.list++; throw new Error('Local storage unavailable'); }, read: async () => { counters.read++; throw new Error('No saved audio'); }, dispose() {} } as unknown as AudioInbox;
}

test('inventory and selection are explicit local actions; exact draft run wins over displayed and newly pending runs', async () => {
  const context = session(), inbox = createAudioInbox(context), audio = clip();
  let calls = 0, network = 0; const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { network++; throw new Error('No network allowed'); };
  const source = createTranscriptSource(context, { inbox: { ...inbox, list: async () => { calls++; return inbox.list(); } } });
  try {
    assert.equal(calls, 0); await inbox.save(audio);
    const original = transcript(audio), edited = '  Corrected café 😀\r\n\\cite{legal}\t ';
    await inbox.saveTranscript(audio.id, 0, original, { runId: original.runId, text: 'Saved draft' });
    retainTemporaryTranscript(context, audio.id, { pending: transcript(audio, 'run-2', 'Different output'), draft: { runId: 'run-1', text: edited }, selectedRunId: 'run-2' });
    const listing = await source.list(); assert.equal(calls, 1); assert.equal(listing.clips.length, 1);
    assert.equal('blob' in listing.clips[0]!, false); assert.equal('text' in listing.clips[0]!, false);
    const choice = await source.select(listing.clips[0]!);
    assert.equal(choice.replacement, edited); assert.equal(choice.origin.runId, 'run-1');
    assert.equal(choice.origin.originalTextSha256, hash(original.text)); assert.equal(choice.origin.editedTextSha256, hash(edited)); assert.equal(choice.origin.audioSha256, hash(encoded));
    assert.deepEqual(Object.keys(choice).sort(), ['origin', 'replacement', 'title']);
    assert.equal('text' in choice.origin, false); assert.equal('blob' in choice, false);
    assert.equal((await inbox.readTranscripts(audio.id)).draft?.text, 'Saved draft'); assert.equal(network, 0);
  } finally { globalThis.fetch = realFetch; source.dispose(); lockSession(); }
});

test('temporary clips and unsaved drafts remain selectable when durable audio storage is unavailable', async () => {
  const context = session(), audio = clip(), counters = { list: 0, read: 0 }, source = createTranscriptSource(context, { inbox: unavailableInbox(counters) });
  try {
    retainTemporaryAudio(context, { clip: audio, notice: 'Not saved' });
    retainTemporaryTranscript(context, audio.id, { pending: transcript(audio), draft: { runId: 'run-1', text: 'Literal temporary replacement' }, selectedRunId: 'run-1' });
    const listing = await source.list(); assert.equal(listing.clips[0]!.temporary, true); assert.match(listing.issues[0]!.message, /storage unavailable/);
    assert.equal((await source.select(listing.clips[0]!)).replacement, 'Literal temporary replacement'); assert.equal(counters.read, 0);
    discardTemporaryAudio(context); await assert.rejects(source.select(listing.clips[0]!), /changed or is unavailable/);
  } finally { source.dispose(); lockSession(); }
});

test('the draft needs its original result; neither displayed text nor a different available run is substituted', async () => {
  const context = session(), inbox = createAudioInbox(context), audio = clip(), source = createTranscriptSource(context, { inbox });
  try {
    await inbox.save(audio); await inbox.saveTranscript(audio.id, 0, transcript(audio), { runId: 'run-1', text: 'Saved draft' });
    retainTemporaryTranscript(context, audio.id, { pending: transcript(audio, 'run-2'), draft: { runId: 'missing', text: 'Keep this orphaned text' }, selectedRunId: 'run-2' });
    await assert.rejects(source.select(selected(audio, false)), /original model result is unavailable/);
    for (const text of ['', 'x'.repeat(20_001), '\ud800', 'x\0y']) {
      retainTemporaryTranscript(context, audio.id, { pending: transcript(audio), draft: { runId: 'run-1', text }, selectedRunId: 'run-1' });
      await assert.rejects(source.select(selected(audio, false)), /Transcript replacement/);
    }
    retainTemporaryTranscript(context, audio.id, { pending: { ...transcript(audio), text: 'Replaced immutable output' }, draft: { runId: 'run-1', text: 'Draft' }, selectedRunId: 'run-1' });
    await assert.rejects(source.select(selected(audio, false)), /Two original model results/);
    assert.equal((await inbox.readTranscripts(audio.id)).draft?.text, 'Saved draft'); assert.ok(await inbox.read(audio.id));
  } finally { source.dispose(); lockSession(); }
});

test('actual bytes and metadata are checked; same-size different audio cannot inherit transcript provenance', async () => {
  const context = session(), audio = clip(new Blob(['x'.repeat(encoded.length)], { type: 'audio/wav' })), source = createTranscriptSource(context, { inbox: unavailableInbox() });
  try {
    retainTemporaryAudio(context, { clip: audio, notice: '' });
    retainTemporaryTranscript(context, audio.id, { pending: transcript(audio), draft: { runId: 'run-1', text: 'Edited' }, selectedRunId: 'run-1' });
    await assert.rejects(source.select(selected(audio, true)), /different audio bytes/);
    await assert.rejects(source.select({ ...selected(audio, true), title: 'Wrong identity' }), /changed or is unavailable/);
    retainTemporaryTranscript(context, audio.id, { pending: { ...transcript(audio), clipId: 'wrong' }, draft: { runId: 'run-1', text: 'Edited' }, selectedRunId: 'run-1' });
    await assert.rejects(source.select(selected(audio, true)), /does not match this recording/);
  } finally { source.dispose(); lockSession(); }
});

test('changing an unsaved draft while audio is being read retires preparation instead of mixing hashes and text', async () => {
  const entered = deferred(), proceed = deferred();
  class SlowBlob extends Blob { override async arrayBuffer() { entered.resolve(); await proceed.promise; return super.arrayBuffer(); } }
  const context = session(), audio = clip(new SlowBlob([encoded], { type: 'audio/wav' })), source = createTranscriptSource(context, { inbox: unavailableInbox() });
  try {
    const run = transcript(audio); retainTemporaryAudio(context, { clip: audio, notice: '' });
    retainTemporaryTranscript(context, audio.id, { pending: run, draft: { runId: run.runId, text: 'First wording' }, selectedRunId: run.runId });
    const operation = source.select(selected(audio, true)); await entered.promise;
    retainTemporaryTranscript(context, audio.id, { pending: run, draft: { runId: run.runId, text: 'Second wording' }, selectedRunId: run.runId });
    proceed.resolve(); await assert.rejects(operation, /changed while preparing/);
  } finally { proceed.resolve(); source.dispose(); lockSession(); }
});

test('clearing saved original results during preparation fails while keeping audio and local draft recoverable', async () => {
  const context = session(), inbox = createAudioInbox(context), audio = clip(); let reads = 0;
  const source = createTranscriptSource(context, { inbox: { ...inbox, readTranscripts: async id => { if (++reads === 2) await inbox.clearTranscripts(id, 1); return inbox.readTranscripts(id); } } });
  try {
    await inbox.save(audio); await inbox.saveTranscript(audio.id, 0, transcript(audio), { runId: 'run-1', text: 'Saved draft' });
    retainTemporaryTranscript(context, audio.id, { pending: null, draft: { runId: 'run-1', text: 'Unsaved correction' }, selectedRunId: 'run-1' });
    await assert.rejects(source.select(selected(audio, false)), /original model result is unavailable/); assert.ok(await inbox.read(audio.id));
  } finally { source.dispose(); lockSession(); }
});

test('session retirement, disposal and caller authority fences reject late local reads', async () => {
  for (const mode of ['session', 'dispose', 'authority'] as const) {
    const entered = deferred(), proceed = deferred(); let current = true;
    class SlowBlob extends Blob { override async arrayBuffer() { entered.resolve(); await proceed.promise; return super.arrayBuffer(); } }
    const context = session(), audio = clip(new SlowBlob([encoded], { type: 'audio/wav' })), source = createTranscriptSource(context, { inbox: unavailableInbox(), isActive: () => current });
    try {
      retainTemporaryAudio(context, { clip: audio, notice: '' }); retainTemporaryTranscript(context, audio.id, { pending: transcript(audio), draft: { runId: 'run-1', text: 'Sensitive correction' }, selectedRunId: 'run-1' });
      const operation = source.select(selected(audio, true)); await entered.promise;
      if (mode === 'session') session('bob'); else if (mode === 'dispose') source.dispose(); else current = false;
      proceed.resolve(); await assert.rejects(operation, SessionChangedError);
    } finally { proceed.resolve(); source.dispose(); lockSession(); }
  }
});

test('text hashing keeps canonical-distinct Unicode and original whitespace separate', async () => {
  assert.equal(await transcriptTextSha256('café\r\n'), hash('café\r\n'));
  assert.notEqual(await transcriptTextSha256('é'), await transcriptTextSha256('e\u0301'));
  assert.notEqual(await transcriptTextSha256('x'), await transcriptTextSha256(' x'));
  await assert.rejects(transcriptTextSha256('\ud800'), /Unicode/);
});
