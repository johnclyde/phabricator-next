import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TRANSCRIPTION_MODEL, TRANSCRIPTION_MODEL_SHA256, transcriptionModelManifestText, type TranscriptionModelManifest } from '../shared/transcription-model.ts';
import { HttpError } from './validation.ts';

export function transcriptionModelDirectory(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value || value.trim() !== value || value.includes('\0')) throw new Error('APP_TRANSCRIPTION_MODEL_DIR must name a staged public model directory.');
  return resolve(value);
}

/** Fixed allowlist only: never expose a directory listing or other operator files. */
export async function serveTranscriptionModel(req: IncomingMessage, res: ServerResponse, path: string, directory: string | undefined, model: TranscriptionModelManifest = TRANSCRIPTION_MODEL, manifestSha256 = TRANSCRIPTION_MODEL_SHA256): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(404, 'Model asset not found.');
  if (!directory) throw new HttpError(503, 'Local transcription is not staged. Ask the operator to prepare the public model assets.');
  const manifest = path === '/transcription-model/manifest.json';
  const prefix = `/transcription-model/${model.id}/`;
  const asset = path.startsWith(prefix) ? model.files.find(file => file.path === path.slice(prefix.length)) : undefined;
  if (!manifest && !asset) throw new HttpError(404, 'Model asset not found.');
  try {
    const root = await realpath(directory), name = manifest ? 'manifest.json' : asset!.path;
    const file = await realpath(resolve(root, name)), local = relative(root, file);
    if (isAbsolute(local) || local.startsWith('..')) throw new Error('outside root');
    const metadata = await stat(file), expectedBytes = manifest ? Buffer.byteLength(model === TRANSCRIPTION_MODEL ? transcriptionModelManifestText() : JSON.stringify(model) + '\n') : asset!.bytes;
    if (!metadata.isFile() || metadata.size !== expectedBytes) throw new Error('size mismatch');
    const bytes = await readFile(file);
    if (bytes.length !== expectedBytes || createHash('sha256').update(bytes).digest('hex') !== (manifest ? manifestSha256 : asset!.sha256)) throw new Error('digest mismatch');
    res.setHeader('Content-Type', manifest || name.endsWith('.json') ? 'application/json; charset=utf-8' : name.endsWith('.onnx') ? 'application/octet-stream' : 'text/plain; charset=utf-8');
    res.setHeader('Content-Length', bytes.length);
    // Only explicit browser installation retains these public files; never fill the HTTP cache implicitly.
    res.setHeader('Cache-Control', 'no-store'); res.statusCode = 200;
    if (req.method === 'HEAD') res.end(); else res.end(bytes);
  } catch { throw new HttpError(503, 'The staged transcription asset is missing or failed its pinned integrity check. Ask the operator to restage the model.'); }
}
