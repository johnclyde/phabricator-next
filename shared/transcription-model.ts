/** Public, immutable model assets. Never contains user audio or transcript data. */
export interface TranscriptionModelAsset { path: string; bytes: number; sha256: string; source: string }
export interface TranscriptionModelManifest { format: 'phabricator.transcription-model.v1'; id: string; repository: string; revision: string; runtime: string; language: 'en'; dtype: 'q8'; license: string; files: readonly TranscriptionModelAsset[] }
export interface TranscriptionRuntimeAsset { path: string; bytes: number; sha256: string }
export interface TranscriptionRuntimeManifest { format: 'phabricator.transcription-runtime.v1'; files: TranscriptionRuntimeAsset[] }
export interface TranscriptionRuntimeUrls { worker: string; factory: string; wasm: string }
export const TRANSCRIPTION_LIMITS = Object.freeze({ manifestBytes: 65_536, modelBytes: 64 * 1024 * 1024, runtimeBytes: 128 * 1024 * 1024, fileBytes: 64 * 1024 * 1024, files: 16 });
export const TRANSCRIPTION_MODEL: Readonly<TranscriptionModelManifest> = {
  "format": "phabricator.transcription-model.v1",
  "id": "whisper-tiny-en-q8",
  "repository": "onnx-community/whisper-tiny.en",
  "revision": "2575352d61be1bf7225cf8f8b268a4678025fc58",
  "runtime": "@huggingface/transformers@4.3.1",
  "language": "en",
  "dtype": "q8",
  "license": "MIT",
  "files": [
    {
      "path": "LICENSE",
      "bytes": 1063,
      "sha256": "b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d",
      "source": "https://raw.githubusercontent.com/openai/whisper/6e3be77e1a105e59086e3e21ff5f609fd6fa89a5/LICENSE"
    },
    {
      "path": "README.md",
      "bytes": 537,
      "sha256": "5f1d9253fc9a536c3cd05bcb20128963e6c545c32294bf3cc4e3b5c0bf570c96",
      "source": "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/2575352d61be1bf7225cf8f8b268a4678025fc58/README.md"
    },
    {
      "path": "config.json",
      "bytes": 2197,
      "sha256": "251ea843b5901a99efa58c0b99b8052c6019aa3e7d2baf46693a1128ff606233",
      "source": "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/2575352d61be1bf7225cf8f8b268a4678025fc58/config.json"
    },
    {
      "path": "generation_config.json",
      "bytes": 1646,
      "sha256": "7b2e8451ed5f118e75fdd991409d72119d21d2fef1eba9723f68fb9c57fe5dc9",
      "source": "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/2575352d61be1bf7225cf8f8b268a4678025fc58/generation_config.json"
    },
    {
      "path": "onnx/decoder_model_merged_quantized.onnx",
      "bytes": 30718858,
      "sha256": "c0592d0749413c960569e1c7fb806b060d5d18f3ebad4a95cbf9a77dc6e9be52",
      "source": "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/2575352d61be1bf7225cf8f8b268a4678025fc58/onnx/decoder_model_merged_quantized.onnx"
    },
    {
      "path": "onnx/encoder_model_quantized.onnx",
      "bytes": 10124993,
      "sha256": "e93ec822f16a8fd264e7de972ad17d615ea7334b75a52d54c50c2e18dd503a25",
      "source": "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/2575352d61be1bf7225cf8f8b268a4678025fc58/onnx/encoder_model_quantized.onnx"
    },
    {
      "path": "preprocessor_config.json",
      "bytes": 339,
      "sha256": "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d",
      "source": "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/2575352d61be1bf7225cf8f8b268a4678025fc58/preprocessor_config.json"
    },
    {
      "path": "tokenizer.json",
      "bytes": 2405679,
      "sha256": "5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0",
      "source": "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/2575352d61be1bf7225cf8f8b268a4678025fc58/tokenizer.json"
    },
    {
      "path": "tokenizer_config.json",
      "bytes": 282662,
      "sha256": "93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c",
      "source": "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/2575352d61be1bf7225cf8f8b268a4678025fc58/tokenizer_config.json"
    }
  ]
};
export const TRANSCRIPTION_MODEL_SHA256 = '0c5fae41342c7c373fc21228fe0a798f5bc0b5d14cb3f0211cc61e3dc3d1f23e';
export const TRANSCRIPTION_MODEL_BYTES = TRANSCRIPTION_MODEL.files.reduce((total, file) => total + file.bytes, 0);
export const transcriptionModelManifestText = () => JSON.stringify(TRANSCRIPTION_MODEL) + "\n";

export function isTranscriptionRuntimePath(path: string): boolean {
  return /^assets\/transcription-(?:worker|runtime)-[A-Za-z0-9_-]+\.(?:js|mjs|wasm)$/.test(path);
}
/** Exact build URL set, bounded metadata, no arbitrary directories or aliases. */
export function validateTranscriptionRuntimeManifest(value: unknown, expectedPaths: readonly string[]): TranscriptionRuntimeManifest {
  const fail = (): never => { throw new Error('The transcription runtime manifest does not match this application build. Reinstall the model.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'files,format' || item.format !== 'phabricator.transcription-runtime.v1' || !Array.isArray(item.files) || item.files.length !== expectedPaths.length || item.files.length > TRANSCRIPTION_LIMITS.files || !item.files.length) return fail();
  const expected = new Set(expectedPaths), actual = new Set<string>(); let bytes = 0;
  if (expected.size !== expectedPaths.length || expectedPaths.some(path => !isTranscriptionRuntimePath(path))) return fail();
  const files: TranscriptionRuntimeAsset[] = [];
  for (const input of item.files) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
    const file = input as Record<string, unknown>;
    if (Object.keys(file).sort().join(',') !== 'bytes,path,sha256' || typeof file.path !== 'string' || !expected.has(file.path) || actual.has(file.path) || !Number.isSafeInteger(file.bytes) || Number(file.bytes) <= 0 || Number(file.bytes) > TRANSCRIPTION_LIMITS.fileBytes || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) return fail();
    actual.add(file.path); bytes += Number(file.bytes); files.push({ path: file.path, bytes: Number(file.bytes), sha256: file.sha256 });
  }
  if (bytes > TRANSCRIPTION_LIMITS.runtimeBytes) return fail();
  return { format: 'phabricator.transcription-runtime.v1', files };
}
