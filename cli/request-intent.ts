import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** Bounded regular UTF-8 files only; never follow a final symlink or wait on a pipe. */
export async function readRequestIntent(path: string, label = 'Request', maximumBytes = 256 * 1024): Promise<Record<string, unknown>> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat(), max = maximumBytes;
    if (!Number.isSafeInteger(max) || max < 1 || max > 2 * 1024 * 1024) throw new Error('Invalid request-file byte limit.');
    if (!info.isFile() || info.size > max) throw new Error(`${label} files must be regular files no larger than ${max} bytes.`);
    const bytes = Buffer.alloc(max + 1); let length = 0;
    while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
    if (length > max) throw new Error(`${label} file exceeds ${max} bytes.`);
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
    return value as Record<string, unknown>;
  } finally { await handle.close(); }
}
