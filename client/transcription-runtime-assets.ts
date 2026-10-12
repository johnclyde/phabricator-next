import worker from './transcription-worker.ts?worker&url';
import factory from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';
import wasm from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';

/** Merely importing these URLs never downloads the large runtime. Explicit model setup owns that. */
export const transcriptionRuntimeAssets = Object.freeze({ worker, factory, wasm });
