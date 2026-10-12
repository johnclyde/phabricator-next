import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioCapture, type AudioCaptureResult, type AudioCaptureState } from '../client/audio-recorder.ts';
import { AUDIO_INBOX_LIMITS } from '../client/audio-inbox.ts';
import { claimMicrophone } from '../client/microphone.ts';

function setup(options: { pending?: boolean; denied?: boolean; failure?: 'constructor' | 'start'; final?: Blob } = {}) {
  const originals = [Object.getOwnPropertyDescriptor(globalThis, 'navigator'), Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder')];
  const states: AudioCaptureState[] = [], results: AudioCaptureResult[] = [], errors: string[] = [], microphone: boolean[] = [];
  const flags = { active: true, stops: 0, requests: 0 };
  const track = Object.assign(new EventTarget(), { readyState: 'live', stop() { this.readyState = 'ended'; flags.stops++; } });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  let grant!: (stream: MediaStream) => void;
  const permission = options.pending ? new Promise<MediaStream>(resolve => { grant = resolve; }) : Promise.resolve(stream);
  const recorders: Recorder[] = [];
  class Recorder {
    static isTypeSupported(type: string) { return type === 'audio/webm;codecs=opus'; }
    state = 'inactive'; mimeType = 'audio/webm;codecs=opus';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { if (options.failure === 'constructor') throw new Error('unsupported'); recorders.push(this); }
    start(timeslice: number) { assert.equal(timeslice, 1000); if (options.failure === 'start') throw new Error('failed'); this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: options.final ?? new Blob(['last'], { type: this.mimeType }) }); this.onstop?.(); }); }
    data(blob: Blob) { this.ondataavailable?.({ data: blob }); }
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async (constraints: unknown) => { assert.deepEqual(constraints, { audio: true, video: false }); flags.requests++; if (options.denied) throw new DOMException('denied', 'NotAllowedError'); return permission; } } } });
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: Recorder });
  const capture = new AudioCapture({ active: () => flags.active, changed: value => states.push(value), completed: value => results.push(value), failed: value => errors.push(value), microphone: value => microphone.push(value) });
  return { capture, states, results, errors, microphone, flags, recorders, grant: () => grant(stream), restore: () => { capture.cancel(); for (const [index, name] of ['navigator', 'MediaRecorder'].entries()) { const original = originals[index]; if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); } } };
}
const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));

test('capture preempts command listening, retains complete ordered bytes and releases every track and lease', async () => {
  const fixture = setup(); let stoppedCommands = 0;
  const command = claimMicrophone('commands', () => { stoppedCommands++; command(); });
  try {
    await fixture.capture.start(); assert.equal(stoppedCommands, 1); assert.equal(fixture.flags.requests, 1);
    assert.throws(() => claimMicrophone('commands', () => {}), /Stop the audio recording/);
    fixture.recorders[0]!.data(new Blob(['first'], { type: 'audio/webm;codecs=opus' }));
    fixture.capture.stop(); assert.ok(fixture.flags.stops > 0); await flush();
    assert.equal(fixture.results.length, 1); assert.equal(await fixture.results[0]!.blob.text(), 'firstlast');
    assert.equal(fixture.results[0]!.blob.type, 'audio/webm;codecs=opus'); assert.ok(fixture.results[0]!.durationMs > 0);
    assert.deepEqual(fixture.errors, []); assert.deepEqual(fixture.microphone, [true, false]);
    claimMicrophone('commands', () => {})();
  } finally { command(); fixture.restore(); }
});

test('canceled permission and a late grant cannot start capture or reclaim a newer microphone lease', async () => {
  const fixture = setup({ pending: true });
  try {
    const started = fixture.capture.start(); assert.equal(fixture.states.at(-1)!.phase, 'requesting');
    fixture.capture.cancel(); const next = claimMicrophone('commands', () => {});
    fixture.grant(); await started; assert.equal(fixture.recorders.length, 0); assert.equal(fixture.flags.stops, 1);
    assert.deepEqual(fixture.results, []); assert.deepEqual(fixture.errors, []);
    assert.throws(() => claimMicrophone('commands', () => {}), /already active/); next();
  } finally { fixture.restore(); }
});

test('retired authority fences an otherwise successful pending microphone grant', async () => {
  const fixture = setup({ pending: true });
  try { const started = fixture.capture.start(); fixture.flags.active = false; fixture.grant(); await started; assert.equal(fixture.recorders.length, 0); assert.equal(fixture.flags.stops, 1); assert.equal(fixture.capture.busy, false); claimMicrophone('commands', () => {})(); }
  finally { fixture.restore(); }
});

test('permission denial and recorder construction/start failures release their lease and all acquired tracks', async () => {
  for (const option of [{ denied: true }, { failure: 'constructor' as const }, { failure: 'start' as const }]) {
    const fixture = setup(option);
    try { await fixture.capture.start(); assert.equal(fixture.errors.length, 1); assert.equal(fixture.results.length, 0); assert.equal(fixture.capture.busy, false); if (!('denied' in option)) assert.ok(fixture.flags.stops > 0); claimMicrophone('commands', () => {})(); }
    finally { fixture.restore(); }
  }
});

test('zero-byte completion and recorder errors cannot masquerade as a completed clip', async () => {
  const empty = setup({ final: new Blob([], { type: 'audio/webm' }) });
  try { await empty.capture.start(); empty.capture.stop(); await flush(); assert.match(empty.errors[0]!, /No audio bytes/); assert.equal(empty.results.length, 0); }
  finally { empty.restore(); }
  const failed = setup();
  try { await failed.capture.start(); failed.recorders[0]!.data(new Blob(['before error'])); failed.recorders[0]!.onerror?.(); await flush(); assert.match(failed.errors[0]!, /recording error/); assert.equal(failed.results.length, 0); assert.ok(failed.flags.stops > 0); }
  finally { failed.restore(); }
});

test('delayed chunks beyond the complete byte bound discard the whole capture, never a trimmed container', async () => {
  const fixture = setup();
  try { await fixture.capture.start(); fixture.recorders[0]!.data(new Blob(['small'])); fixture.recorders[0]!.data(new Blob([new Uint8Array(AUDIO_INBOX_LIMITS.maxClipBytes)])); await flush(); assert.match(fixture.errors[0]!, /beyond the 25 MiB limit/); assert.equal(fixture.results.length, 0); assert.equal(fixture.capture.busy, false); assert.ok(fixture.flags.stops > 0); }
  finally { fixture.restore(); }
});

test('observed duration is not silently clamped after an overdue stop', async context => {
  const fixture = setup(); let clock = 1000;
  context.mock.method(performance, 'now', () => clock);
  try { await fixture.capture.start(); clock += AUDIO_INBOX_LIMITS.maxDurationMs + 1; fixture.capture.stop(); await flush(); assert.match(fixture.errors[0]!, /beyond the ten-minute limit/); assert.equal(fixture.results.length, 0); }
  finally { fixture.restore(); }
});

test('cancel after stopping retires queued finalization instead of reviving a departed page', async () => {
  const fixture = setup();
  try { await fixture.capture.start(); fixture.capture.stop(); fixture.capture.cancel(); await flush(); assert.deepEqual(fixture.results, []); assert.deepEqual(fixture.errors, []); assert.equal(fixture.capture.busy, false); }
  finally { fixture.restore(); }
});
