import { open, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { HttpError } from './validation.ts';

/** Spool the exact decoded Git request, bounding both wire bytes and expansion. */
export async function spoolGitRequest(req: IncomingMessage, path: string, signal: AbortSignal, maximumBytes: number): Promise<number> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('Git request storage requires a positive byte limit.');
  const encoding = req.headers['content-encoding'];
  if (encoding !== undefined && encoding !== 'gzip') throw new HttpError(415, 'Git requests support only identity or gzip content encoding.');
  if (signal.aborted) throw new HttpError(499, 'The Git request was cancelled.');
  const file = await open(path, 'wx', 0o600);
  let completed = false, decodedBytes = 0;
  const limit = (decoded = false) => {
    let bytes = 0;
    return new Transform({ transform(chunk: Buffer, _encoding, next) {
      bytes += chunk.length;
      if (decoded) decodedBytes = bytes;
      next(bytes > maximumBytes ? new HttpError(413, 'Git request exceeds its supported size.') : null, chunk);
    } });
  };
  try {
    const writer = file.createWriteStream();
    if (encoding === 'gzip') await pipeline(req, limit(), createGunzip(), limit(true), writer, { signal });
    else await pipeline(req, limit(true), writer, { signal });
    completed = true; return decodedBytes;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (signal.aborted) throw new HttpError(499, 'The Git request was cancelled.');
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (encoding === 'gzip' && code.startsWith('Z_')) throw new HttpError(400, 'The gzip Git request is incomplete or invalid.');
    throw new HttpError(503, 'The Git request could not be stored.');
  } finally {
    await file.close();
    if (!completed) await rm(path, { force: true });
  }
}
