import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { transcriptionMonoPcm } from '../client/audio-decode.ts';
import { createLocalTranscriber, type TranscriptionWorkerPort } from '../client/local-transcription.ts';
import { transcriptionAssetResponse } from '../client/transcription-worker-cache.ts';
import { activateSession, lockSession } from '../client/session.ts';
import { createAudioClip } from '../client/audio-inbox.ts';
import { isLocalTranscript, LOCAL_TRANSCRIPTION_LIMITS, TranscriptionCancelledError, type TranscriptionWorkerReply, type TranscriptionWorkerRequest } from '../shared/local-transcription.ts';
import { TRANSCRIPTION_MODEL, TRANSCRIPTION_MODEL_SHA256 } from '../shared/transcription-model.ts';
import type { InstalledTranscriptionModel } from '../client/transcription-model.ts';

const session = () => activateSession({ mode: 'local', workspaceId: 'transcription-unit', account: null, sessionContext: null, csrfToken: null, expiresAt: null });
const clip = () => createAudioClip(new Blob(['exact encoded café 😀\r\n'], { type: 'audio/wav' }), { title: 'Dictation', durationMs: 1000 });
// Tiny assets exercise controller lifecycle only. Genuine model inference is covered by the browser verification.
const prepared = (): InstalledTranscriptionModel => ({ manifest: TRANSCRIPTION_MODEL, manifestId: TRANSCRIPTION_MODEL_SHA256, modelBaseUrl: 'https://example.test/transcription-model/whisper-tiny-en-q8/', files: new Map(TRANSCRIPTION_MODEL.files.map(file => [file.path, new ArrayBuffer(1)])), runtime: { workerUrl: 'https://example.test/assets/transcription-worker-unit.js', factoryUrl: 'https://example.test/assets/transcription-runtime-unit.mjs', wasm: new ArrayBuffer(1) } });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
class ControlledWorker implements TranscriptionWorkerPort {
  onmessage: ((event: MessageEvent<TranscriptionWorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  request: TranscriptionWorkerRequest | null = null;
  terminated = 0;
  postMessage(message: TranscriptionWorkerRequest) { this.request = message; }
  terminate() { this.terminated++; }
  emit(message: TranscriptionWorkerReply) { this.onmessage?.({ data: message } as MessageEvent<TranscriptionWorkerReply>); }
  complete(text = 'A local result.') { assert.ok(this.request); this.emit({ kind: 'complete', runId: this.request.runId, text }); }
}
function harness(patch: Parameters<typeof createLocalTranscriber>[1] = {}) {
  const workers: ControlledWorker[] = [], page = new EventTarget();
  const controller = createLocalTranscriber(session(), { ...patch, dependencies: { controlled: () => true, origin: 'https://example.test', basePath: '/', page, decode: async () => new Float32Array(16000), worker: () => { const worker = new ControlledWorker(); workers.push(worker); return worker; }, ...patch.dependencies } });
  return { controller, workers, page };
}
async function waitWorker(workers: ControlledWorker[]) { for (let i = 0; !workers.length && i < 100; i++) await tick(); assert.equal(workers.length, 1); return workers[0]; }

test('mono projection preserves positions and literal samples, averages stereo, and rejects invalid/oversized decode before channel reads', () => {
  const left = new Float32Array([0, 0.5, -1]), right = new Float32Array([1, -0.5, 0]);
  assert.deepEqual([...transcriptionMonoPcm({ sampleRate: 16000, length: 3, numberOfChannels: 2, getChannelData: n => n ? right : left })], [0.5, 0, -0.5]);
  assert.deepEqual([...left], [0, 0.5, -1]);
  for (const patch of [{ sampleRate: 48000 }, { length: 0 }, { length: 9_600_001 }, { numberOfChannels: 3 }]) assert.throws(() => transcriptionMonoPcm({ sampleRate: 16000, length: 3, numberOfChannels: 1, getChannelData: () => { throw new Error('must not read'); }, ...patch }), /at most 10 minutes/);
  for (const value of [NaN, Infinity, 2]) assert.throws(() => transcriptionMonoPcm({ sampleRate: 16000, length: 1, numberOfChannels: 1, getChannelData: () => new Float32Array([value]) }), /invalid samples/);
});

test('cache-only model lookup returns exact bytes or explicit misses without URL normalization or network fallback', async () => {
  const bytes = new TextEncoder().encode('test café').buffer, files = new Map([['config.json', bytes]]), base = '/__transcription_memory__/model/';
  assert.equal(await transcriptionAssetResponse(files, base, `${base}config.json`).text(), 'test café');
  for (const url of ['https://huggingface.co/model/config.json', `${base}../config.json`, `${base}config.json?download=true`, `${base}missing.json`]) assert.equal(transcriptionAssetResponse(files, base, url).status, 404);
});

test('result pins original encoded SHA256, exact model, literal Unicode text, observed decoded duration and captured clip identity', async () => {
  const { controller, workers } = harness(), source = clip(), originalId = source.id, bytes = Buffer.from(await source.blob.arrayBuffer()), phases: string[] = [];
  const promise = controller.transcribe(source, prepared(), progress => phases.push(progress.phase));
  source.id = 'changed-after-start';
  const worker = await waitWorker(workers);
  worker.emit({ kind: 'progress', runId: worker.request!.runId, phase: 'transcribing' }); worker.complete(' café 😀\r\n');
  const result = await promise;
  assert.equal(result.clipId, originalId); assert.equal(result.audioSha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(result.text, ' café 😀\r\n');
  assert.equal(result.decodedDurationMs, 1000); assert.equal(result.modelManifestSha256, TRANSCRIPTION_MODEL_SHA256); assert.ok(isLocalTranscript(result));
  assert.deepEqual(phases, ['hashing', 'decoding', 'loading-model', 'transcribing']); assert.equal(controller.busy, false); assert.ok(worker.terminated); controller.dispose();
});

test('cancel terminates worker immediately, rejects with a distinct error and ignores late completion', async () => {
  const { controller, workers } = harness(), promise = controller.transcribe(clip(), prepared());
  const worker = await waitWorker(workers); const rejected = assert.rejects(promise, TranscriptionCancelledError);
  controller.cancel(); assert.ok(worker.terminated); worker.complete('stale result'); await rejected; assert.equal(controller.busy, false); controller.dispose();
});

test('session retirement and pagehide cancel active inference rather than returning another account a result', async () => {
  for (const retire of ['lock', 'pagehide']) {
    const { controller, workers, page } = harness(), promise = controller.transcribe(clip(), prepared());
    const worker = await waitWorker(workers), rejected = assert.rejects(promise, TranscriptionCancelledError);
    if (retire === 'lock') lockSession(); else page.dispatchEvent(new Event('pagehide'));
    worker.complete('not visible'); await rejected; assert.ok(worker.terminated); controller.dispose();
  }
});

test('cancel during a delayed native decode resolves promptly and the decoder completion cannot start a worker', async () => {
  let finish!: (value: Float32Array) => void, decoding = false;
  const { controller, workers } = harness({ dependencies: { decode: async () => { decoding = true; return new Promise(resolve => { finish = resolve; }); } } });
  const promise = controller.transcribe(clip(), prepared()); while (!decoding) await tick();
  const rejected = assert.rejects(promise, TranscriptionCancelledError); controller.cancel(); await rejected;
  finish(new Float32Array(16000)); await tick(); assert.equal(workers.length, 0); controller.dispose();
});

test('busy work is not replaced; malformed output is rejected whole and silence may yield a legitimate empty transcript', async () => {
  const { controller, workers } = harness(), first = controller.transcribe(clip(), prepared());
  await assert.rejects(controller.transcribe(clip(), prepared()), /already running/);
  const worker = await waitWorker(workers); worker.complete('x'.repeat(LOCAL_TRANSCRIPTION_LIMITS.maxTextCodeUnits + 1)); await assert.rejects(first, /complete generated text/);
  const second = controller.transcribe(clip(), prepared()); while (workers.length < 2) await tick(); workers[1].complete(''); assert.equal((await second).text, ''); controller.dispose();
});

test('missing SW, wrong manifest, cross-origin/mount runtime and oversized decoded audio fail without running inference', async () => {
  for (const scenario of ['uncontrolled', 'manifest', 'origin', 'mount', 'decoded']) {
    const { controller, workers } = harness({ dependencies: { ...(scenario === 'uncontrolled' ? { controlled: () => false } : {}), ...(scenario === 'decoded' ? { decode: async () => new Float32Array(9_600_001) } : {}) } });
    const model = prepared(); if (scenario === 'manifest') model.manifestId = '0'.repeat(64); if (scenario === 'origin') model.runtime.workerUrl = 'https://remote.test/assets/transcription-worker-unit.js'; if (scenario === 'mount') model.runtime.factoryUrl = 'https://example.test/other/assets/transcription-runtime-unit.mjs';
    await assert.rejects(controller.transcribe(clip(), model)); assert.equal(workers.length, 0); controller.dispose();
  }
});

test('the active predicate retires results synchronously even before the polling fence runs', async () => {
  let active = true; const { controller, workers } = harness({ isActive: () => active }), promise = controller.transcribe(clip(), prepared());
  const worker = await waitWorker(workers); active = false; worker.complete(); await assert.rejects(promise, TranscriptionCancelledError); controller.dispose();
});

test('model invalidation terminates already loaded in-memory inference and disposal removes the listener', async () => {
  let invalidate!: () => void, removed = false;
  const { controller, workers } = harness({ dependencies: { onModelInvalidated: (listener, base) => { assert.equal(base, '/'); invalidate = listener; return () => { removed = true; }; } } });
  const promise = controller.transcribe(clip(), prepared()), worker = await waitWorker(workers);
  const rejected = assert.rejects(promise, TranscriptionCancelledError); invalidate(); worker.complete('retired model'); await rejected; assert.ok(worker.terminated);
  controller.dispose(); assert.equal(removed, true);
});

test('persisted transcript validator rejects changed source/model/options, excessive text and backwards timestamps', async () => {
  const { controller, workers } = harness(), promise = controller.transcribe(clip(), prepared()); (await waitWorker(workers)).complete();
  const valid = await promise;
  for (const patch of [{ audioSha256: 'wrong' }, { audioBytes: 0 }, { modelManifestSha256: '0'.repeat(64) }, { modelRevision: 'other' }, { runtimeVersion: '3.8.1' }, { decodedDurationMs: 600001 }, { options: { ...valid.options, sampleRate: 44100 } }, { completedAt: '2000-01-01T00:00:00.000Z' }, { text: 'x'.repeat(100001) }]) assert.equal(isLocalTranscript({ ...valid, ...patch }), false);
  controller.dispose();
});
