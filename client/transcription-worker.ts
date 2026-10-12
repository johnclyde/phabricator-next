import { env, pipeline } from '@huggingface/transformers';
import { LOCAL_TRANSCRIPTION_LIMITS as LIMITS, type TranscriptionWorkerRequest, type TranscriptionWorkerReply } from '../shared/local-transcription';
import { transcriptionAssetResponse } from './transcription-worker-cache';

// Installed worker and ORT factory module loads are separately verified by the controlling service worker.
// This worker has no network capability for model/audio requests, even on a library cache miss.
const denyNetwork = () => { throw new Error('Network access is disabled during local transcription.'); };
globalThis.fetch = async () => denyNetwork();
Object.defineProperty(globalThis, 'XMLHttpRequest', { value: class { constructor() { denyNetwork(); } }, configurable: false });
Object.defineProperty(globalThis, 'WebSocket', { value: class { constructor() { denyNetwork(); } }, configurable: false });
Object.defineProperty(globalThis, 'importScripts', { value: denyNetwork, configurable: false });
let started = false;
const send = (message: TranscriptionWorkerReply) => globalThis.postMessage(message);
globalThis.onmessage = async (event: MessageEvent<TranscriptionWorkerRequest>) => {
  if (started) return;
  started = true;
  const request = event.data;
  try {
    if (!(request.samples instanceof Float32Array) || !request.samples.length || request.samples.length > LIMITS.maxSamples || !(request.files instanceof Map) || request.files.size > 16 || !(request.wasm instanceof ArrayBuffer)) throw new Error('The local transcription input is invalid or exceeds its bounds.');
    const factory = new URL(request.factoryUrl, globalThis.location.href);
    if (factory.origin !== globalThis.location.origin || !/^https?:$/.test(factory.protocol)) throw new Error('The installed runtime factory must belong to this application.');
    env.allowRemoteModels = false; env.allowLocalModels = true; env.useBrowserCache = false; env.useFSCache = false; env.useFS = false; env.useWasmCache = false;
    env.localModelPath = '/__transcription_memory__/';
    const memoryBase = `${env.localModelPath}${request.modelId}/`;
    env.useCustomCache = true;
    env.customCache = {
      match: async key => { const response = transcriptionAssetResponse(request.files, memoryBase, key); return response.status === 200 ? response : undefined; },
      put: async () => { throw new Error('Local transcription cannot add model assets.'); },
    };
    // v4's local miss path calls env.fetch. It returns an in-memory404 so optional config stays optional.
    env.fetch = async input => transcriptionAssetResponse(request.files, memoryBase, String(input));
    const wasm = env.backends.onnx.wasm;
    if (!wasm) throw new Error('The CPU WebAssembly runtime is unavailable.');
    wasm.numThreads = 1; wasm.proxy = false; wasm.wasmPaths = { mjs: factory.href }; wasm.wasmBinary = request.wasm;
    send({ runId: request.runId, kind: 'progress', phase: 'loading-model' });
    const transcriber = await pipeline('automatic-speech-recognition', request.modelId, { revision: request.modelRevision, device: 'wasm', dtype: 'q8', local_files_only: true });
    send({ runId: request.runId, kind: 'progress', phase: 'transcribing' });
    const output = await transcriber(request.samples, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: false });
    if (Array.isArray(output) || typeof output.text !== 'string' || output.text.length > LIMITS.maxTextCodeUnits) throw new Error('The complete transcript exceeded the supported output limit. No partial transcript was saved.');
    send({ runId: request.runId, kind: 'complete', text: output.text });
    await transcriber.dispose();
  } catch (error) {
    send({ runId: request.runId, kind: 'error', message: error instanceof Error ? error.message.slice(0, 600) : 'Local transcription failed.' });
  }
};
