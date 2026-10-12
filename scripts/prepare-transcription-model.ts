import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRANSCRIPTION_MODEL, TRANSCRIPTION_MODEL_SHA256, transcriptionModelManifestText, type TranscriptionModelManifest } from '../shared/transcription-model.ts';

/** Explicit operator command only. Fresh destination and atomic promotion preserve previous releases. */
export async function prepareTranscriptionModel(directory: string, options: { fetch?: typeof fetch; model?: TranscriptionModelManifest; signal?: AbortSignal } = {}): Promise<void> {
  const target = resolve(directory), model = options.model ?? TRANSCRIPTION_MODEL, fetcher = options.fetch ?? fetch;
  if (!directory || directory.trim() !== directory || directory.includes('\0')) throw new Error('Choose a fresh destination with --directory PATH.');
  try { await lstat(target); throw new Error('The model destination already exists. Choose a fresh directory; nothing was overwritten.'); } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.staging-${randomUUID()}`; await mkdir(temporary, { mode: 0o755 });
  const check = () => { if (options.signal?.aborted) throw new DOMException('Model staging was canceled.', 'AbortError'); };
  try {
    for (const file of model.files) {
      check(); const response = await fetcher(file.source, { signal: options.signal, credentials: 'omit', redirect: 'follow' });
      if (response.status !== 200 || (response.url && !response.url.startsWith('https://'))) throw new Error(`Could not download public model asset ${file.path}.`);
      const length = response.headers.get('content-length'); if (length && (!/^\d+$/.test(length) || Number(length) > file.bytes)) throw new Error(`Oversized model asset ${file.path}.`);
      const reader = response.body?.getReader(); if (!reader) throw new Error(`Missing model asset ${file.path}.`);
      const chunks: Uint8Array[] = []; let size = 0;
      const abort = () => { void reader.cancel().catch(() => {}); }; options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      try { while (true) { check(); const item = await reader.read(); check(); if (item.done) break; size += item.value.length; if (size > file.bytes) { await reader.cancel(); throw new Error(`Oversized model asset ${file.path}.`); } chunks.push(item.value); } } finally { options.signal?.removeEventListener('abort', abort); reader.releaseLock(); }
      check(); const bytes = Buffer.concat(chunks);
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Pinned SHA-256 or length mismatch for ${file.path}.`);
      const path = resolve(temporary, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { flag: 'wx', mode: 0o644 });
    }
    check(); await writeFile(resolve(temporary, 'manifest.json'), model === TRANSCRIPTION_MODEL ? transcriptionModelManifestText() : JSON.stringify(model) + '\n', { flag: 'wx', mode: 0o644 });
    // A destination created during download is never replaced (rename also rejects nonempty directories).
    try { await lstat(target); throw new Error('The destination appeared during staging; nothing was overwritten.'); } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    await rename(temporary, target);
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--directory' || !args[1]) { console.error('Usage: npm run transcription:model -- --directory FRESH_DIRECTORY'); process.exitCode = 1; }
  else {
    const controller = new AbortController(); const cancel = () => controller.abort(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try { await prepareTranscriptionModel(args[1], { signal: controller.signal }); console.log(`Public Whisper assets staged at ${resolve(args[1])}. Manifest SHA-256: ${TRANSCRIPTION_MODEL_SHA256}. Set APP_TRANSCRIPTION_MODEL_DIR to this directory.`); }
    catch (error) { console.error(error instanceof Error ? error.message : 'Model staging failed.'); process.exitCode = 1; }
    finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  }
}
