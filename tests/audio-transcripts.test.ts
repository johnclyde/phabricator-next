import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioClip, createAudioInbox, AudioInboxError, type AudioInboxEntry, type AudioInboxMutation, type AudioInboxStore, type AudioClip } from '../client/audio-inbox';
import { audioSha256, emptyAudioTranscripts } from '../client/audio-transcripts';
import { discardTemporaryTranscript, hasTemporaryTranscripts, retainTemporaryTranscript, temporaryTranscript } from '../client/audio-transcript-drafts';
import { activateSession, lockSession, SessionChangedError } from '../client/session';
import { TRANSCRIPTION_MODEL, TRANSCRIPTION_MODEL_SHA256 } from '../shared/transcription-model';
import type { LocalTranscript } from '../shared/local-transcription';

const session = (mode: 'local' | 'password' = 'local', who = 'alice') => activateSession({ mode, workspaceId: 'transcripts', account: mode === 'local' ? null : { id: who, username: who, displayName: who, disabled: false }, sessionContext: mode === 'local' ? null : who, csrfToken: mode === 'local' ? null : who, expiresAt: null });
const source = () => createAudioClip(new Blob(['literal encoded audio fixture'], { type: 'audio/wav' }), { title: 'Speech note', durationMs: 1000 });
const transcript = async (clip: AudioClip, runId = 'run-1', text = 'Original model words.'): Promise<LocalTranscript> => ({ format: 'phabricator.local-transcript.v1', runId, clipId: clip.id, audioSha256: await audioSha256(clip), audioBytes: clip.bytes, mimeType: clip.mimeType, createdAt: '2026-10-12T12:00:00.000Z', completedAt: '2026-10-12T12:00:01.000Z', decodedDurationMs: 1000, modelId: TRANSCRIPTION_MODEL.repository, modelRevision: TRANSCRIPTION_MODEL.revision, modelManifestSha256: TRANSCRIPTION_MODEL_SHA256, runtimeVersion: '4.3.1', device: 'wasm', dtype: 'q8', language: 'en', options: { sampleRate: 16000, chunkLengthS: 30, strideLengthS: 5 }, text });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
class Database {
  rows = new Map<IDBValidKey, unknown>(); queue = Promise.resolve(); fail: Error | null = null;
  beforeWrite: (() => Promise<void>) | null = null;
  store(): AudioInboxStore {
    let closed = false;
    return { transaction: <T>(mode: 'readonly' | 'readwrite', signal: AbortSignal, fn: (rows: readonly AudioInboxEntry[]) => AudioInboxMutation<T>): Promise<T> => {
      const work = this.queue.then(async () => {
        const check = () => { if (closed || signal.aborted) throw new SessionChangedError(); }; check();
        const change = fn([...this.rows].map(([key, value]) => ({ key, value: structuredClone(value) })));
        if (mode === 'readwrite') { await this.beforeWrite?.(); check(); if (this.fail) throw this.fail; }
        if (change.put) { assert.equal(this.rows.has(change.put.key), false); this.rows.set(change.put.key, structuredClone(change.put.value)); }
        if (change.update) { assert.equal(this.rows.has(change.update.key), true); this.rows.set(change.update.key, structuredClone(change.update.value)); }
        if (change.deleteKey) this.rows.delete(change.deleteKey);
        return change.result;
      }); this.queue = work.then(() => {}, () => {}); return work;
    }, close() { closed = true; } };
  }
}

test('legacy audio rows get an explicit transcript save; original bytes and model output remain immutable across draft edits', async () => {
  const db = new Database(), context = session(), inbox = createAudioInbox(context, { store: db.store() }), clip = source();
  try {
    await inbox.save(clip); assert.deepEqual(await inbox.readTranscripts(clip.id), emptyAudioTranscripts());
    const original = await transcript(clip), result = await inbox.saveTranscript(clip.id, 0, original, { runId: original.runId, text: 'Corrected draft café.' });
    assert.equal(result.version, 1); assert.equal(result.runs[0]!.text, original.text); assert.equal(result.draft?.text, 'Corrected draft café.');
    const edited = await inbox.saveTranscript(clip.id, 1, null, { runId: original.runId, text: '' });
    assert.equal(edited.version, 2); assert.equal(edited.draft?.text, ''); assert.equal(edited.runs[0]!.text, original.text);
    assert.deepEqual(await (await inbox.read(clip.id))!.blob.arrayBuffer(), await clip.blob.arrayBuffer());
    result.runs[0]!.text = 'Mutated returned value'; assert.equal((await inbox.readTranscripts(clip.id)).runs[0]!.text, original.text);
    await assert.rejects(inbox.saveTranscript(clip.id, 2, { ...original, text: 'Overwrite original' }, { runId: original.runId, text: 'Draft' }), /immutable model result/);
    assert.equal((await inbox.readTranscripts(clip.id)).version, 2);
  } finally { inbox.dispose(); lockSession(); }
});

test('same-row transcript CAS prevents two views from silently overwriting, while caller intent is captured before awaits', async () => {
  const db = new Database(), context = session(), first = createAudioInbox(context, { store: db.store() }), second = createAudioInbox(context, { store: db.store() }), clip = source();
  try {
    await first.save(clip); const result = await transcript(clip), edit = { runId: result.runId, text: 'First intent' };
    const saving = first.saveTranscript(clip.id, 0, result, edit); result.text = 'Mutated after invocation'; edit.text = 'Late edit';
    await saving; assert.equal((await first.readTranscripts(clip.id)).runs[0]!.text, 'Original model words.'); assert.equal((await first.readTranscripts(clip.id)).draft?.text, 'First intent');
    const attempts = await Promise.allSettled([first.saveTranscript(clip.id, 1, null, { runId: result.runId, text: 'A' }), second.saveTranscript(clip.id, 1, null, { runId: result.runId, text: 'B' })]);
    assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1); const failed = attempts.find(value => value.status === 'rejected') as PromiseRejectedResult; assert.equal(failed.reason.code, 'conflict'); assert.match(failed.reason.message, /another view/);
    assert.equal((await second.readTranscripts(clip.id)).version, 2);
  } finally { first.dispose(); second.dispose(); lockSession(); }
});

test('transcript count never silently evicts output; explicit clear preserves audio and delete removes both', async () => {
  const db = new Database(), context = session(), inbox = createAudioInbox(context, { store: db.store() }), clip = source();
  try {
    await inbox.save(clip);
    for (let index = 0; index < 5; index++) { const result = await transcript(clip, `run-${index}`, index === 0 ? '' : `Output ${index}`); await inbox.saveTranscript(clip.id, index, result, { runId: result.runId, text: result.text }); }
    const sixth = await transcript(clip, 'run-6'); await assert.rejects(inbox.saveTranscript(clip.id, 5, sixth, { runId: sixth.runId, text: sixth.text }), /five saved/);
    assert.equal((await inbox.readTranscripts(clip.id)).runs.length, 5);
    assert.deepEqual(await inbox.clearTranscripts(clip.id, 5), { ...emptyAudioTranscripts(), version: 6 });
    assert.ok(await inbox.read(clip.id)); await inbox.saveTranscript(clip.id, 6, sixth, { runId: sixth.runId, text: sixth.text });
    assert.equal(await inbox.delete(clip.id), true); await assert.rejects(inbox.readTranscripts(clip.id), /exact saved audio/); assert.equal(db.rows.size, 0);
  } finally { inbox.dispose(); lockSession(); }
});

test('corrupt transcript pins and changed same-length bytes never hide or overwrite original audio', async () => {
  const db = new Database(), context = session(), inbox = createAudioInbox(context, { store: db.store() }), clip = source();
  try {
    await inbox.save(clip); const output = await transcript(clip);
    for (const patch of [{ clipId: 'another' }, { audioSha256: 'f'.repeat(64) }, { audioBytes: 1 }, { mimeType: 'audio/ogg' }, { modelManifestSha256: 'f'.repeat(64) }]) {
      await assert.rejects(inbox.saveTranscript(clip.id, 0, { ...output, ...patch }, { runId: output.runId, text: 'No' })); assert.equal((await inbox.readTranscripts(clip.id)).version, 0);
    }
    await inbox.saveTranscript(clip.id, 0, output, { runId: output.runId, text: 'Draft' });
    const row = db.rows.get(clip.id) as Record<string, unknown>; row.blob = new Blob(['x'.repeat(clip.bytes)], { type: clip.mimeType });
    await assert.rejects(inbox.readTranscripts(clip.id), /different audio bytes/); assert.ok(await inbox.read(clip.id)); assert.equal((await inbox.list()).clips.length, 1);
    row.transcripts = { format: 'future', privateUnknown: 'preserve' }; const before = structuredClone(row);
    await assert.rejects(inbox.readTranscripts(clip.id), /malformed or unsupported/); await assert.rejects(inbox.clearTranscripts(clip.id, 1)); assert.deepEqual(db.rows.get(clip.id), before); assert.ok(await inbox.read(clip.id));
  } finally { inbox.dispose(); lockSession(); }
});

test('quota and canceled commit retain unsaved text, never return successful transcript persistence', async () => {
  const db = new Database(), context = session(), inbox = createAudioInbox(context, { store: db.store() }), clip = source();
  await inbox.save(clip); const output = await transcript(clip), edit = { runId: output.runId, text: 'Exportable draft' };
  db.fail = new DOMException('Full', 'QuotaExceededError');
  await assert.rejects(inbox.saveTranscript(clip.id, 0, output, edit), error => error instanceof AudioInboxError && error.code === 'quota'); assert.equal(output.text, 'Original model words.'); assert.equal(edit.text, 'Exportable draft'); assert.equal((await inbox.readTranscripts(clip.id)).version, 0);
  db.fail = null; const held = deferred(), reached = deferred(); db.beforeWrite = async () => { reached.resolve(); await held.promise; };
  const pending = inbox.saveTranscript(clip.id, 0, output, edit); await reached.promise; lockSession(); held.resolve(); await assert.rejects(pending, SessionChangedError);
  assert.equal((db.rows.get(clip.id) as Record<string, unknown>).transcripts, undefined); inbox.dispose();
});

test('protected transcript results and drafts survive route handles only, never IndexedDB or account replacement', async () => {
  let opened = 0; const forbidden = { open() { opened++; throw new Error('No private IDB'); } } as unknown as IDBFactory;
  const context = session('password'), first = createAudioInbox(context, { indexedDB: forbidden }), clip = source();
  try {
    await first.save(clip); const output = await transcript(clip); const response = await first.saveTranscript(clip.id, 0, output, { runId: output.runId, text: 'Private draft' }); response.runs[0]!.text = 'Must not alias memory'; response.draft!.text = 'Must not alias draft'; first.dispose();
    const second = createAudioInbox(context, { indexedDB: forbidden }); assert.equal((await second.readTranscripts(clip.id)).runs[0]!.text, output.text); assert.equal((await second.readTranscripts(clip.id)).draft?.text, 'Private draft');
    const bob = session('password', 'bob'); await assert.rejects(second.readTranscripts(clip.id), SessionChangedError); second.dispose();
    const replacement = createAudioInbox(bob, { indexedDB: forbidden }); assert.equal((await replacement.list()).clips.length, 0); replacement.dispose(); assert.equal(opened, 0);
  } finally { first.dispose(); lockSession(); }
});

test('unsaved transcript lifetime survives hash navigation, but clears pagehide and rejects expired or replaced sessions', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window'), events = new EventTarget(); Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  try {
    const context = session(), clip = source(), result = await transcript(clip), value = { pending: result, draft: { runId: result.runId, text: 'Edited' }, selectedRunId: result.runId };
    retainTemporaryTranscript(context, clip.id, value); value.draft.text = 'Caller mutation'; assert.equal(temporaryTranscript(context, clip.id)?.draft?.text, 'Edited'); assert.equal(hasTemporaryTranscripts(context), true);
    events.dispatchEvent(new Event('pagehide')); assert.equal(hasTemporaryTranscripts(context), false);
    retainTemporaryTranscript(context, clip.id, value); discardTemporaryTranscript(context, clip.id); assert.equal(hasTemporaryTranscripts(context), false);
    retainTemporaryTranscript(context, clip.id, value); const replacement = session('password'); assert.equal(hasTemporaryTranscripts(context), false); assert.equal(hasTemporaryTranscripts(replacement), false); assert.throws(() => retainTemporaryTranscript(context, clip.id, value), SessionChangedError);
    replacement.state.expiresAt = new Date(0).toISOString(); assert.throws(() => retainTemporaryTranscript(replacement, clip.id, value), SessionChangedError); assert.equal(hasTemporaryTranscripts(replacement), false);
  } finally { lockSession(); if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); }
});
