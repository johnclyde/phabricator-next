import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { DOCX_LIMITS, type DocxProjection, type DocxReplacement } from '../shared/docx.ts';
import { HttpError } from './validation.ts';

let active = 0;
const MAX_WORKERS = 2;
type Result = { bytes: Uint8Array; projection: DocxProjection };

/** Parsing is bounded in a disposable worker, never on the API event loop. */
async function run(bytes: Uint8Array, replacement?: DocxReplacement, attribution?: { author: string; date: string }, signal?: AbortSignal): Promise<Result> {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > DOCX_LIMITS.compressedBytes) throw new HttpError(422, 'DOCX packages must contain at most 16 MiB.', 'DOCX_INVALID_PACKAGE');
  if (signal?.aborted) throw new HttpError(499, 'DOCX processing was canceled.', 'DOCX_CANCELED');
  if (active >= MAX_WORKERS) throw new HttpError(503, 'DOCX processing is busy. Retry this exact request later.', 'DOCX_BUSY');
  active++;
  let worker: Worker | undefined;
  try {
    worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      require('tsx/cjs');
      const { processDocx } = require(workerData.module);
      processDocx(workerData.bytes, workerData.replacement, workerData.attribution)
        .then(result => parentPort.postMessage({ ok: true, result }))
        .catch(error => parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : 'Invalid DOCX package.' }));`, {
      eval: true, execArgv: [], workerData: { module: fileURLToPath(new URL('./docx-package-worker.ts', import.meta.url)), bytes, replacement, attribution },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    return await new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => finish(new HttpError(503, 'DOCX processing exceeded its time limit.', 'DOCX_LIMIT')), DOCX_LIMITS.deadlineMs);
      const abort = () => finish(new HttpError(499, 'DOCX processing was canceled.', 'DOCX_CANCELED'));
      let settled = false;
      const finish = (error?: Error, result?: Result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result!);
      };
      signal?.addEventListener('abort', abort, { once: true });
      worker!.once('message', (message: { ok: boolean; result?: Result; message?: string }) => {
        if (message.ok && message.result) finish(undefined, message.result);
        else finish(new HttpError(422, (message.message || 'Invalid DOCX package.').slice(0, 400), 'DOCX_UNSUPPORTED'));
      });
      worker!.once('error', () => finish(new HttpError(503, 'DOCX worker failed or exceeded its resource limit.', 'DOCX_LIMIT')));
      worker!.once('exit', () => finish(new HttpError(503, 'DOCX worker ended before completing.', 'DOCX_LIMIT')));
      if (signal?.aborted) abort();
    });
  } finally { await worker?.terminate(); active--; }
}

export async function inspectDocx(bytes: Uint8Array, signal?: AbortSignal): Promise<DocxProjection> { return (await run(bytes, undefined, undefined, signal)).projection; }
export async function replaceDocx(bytes: Uint8Array, replacement: DocxReplacement, attribution: { author: string; date: string }, signal?: AbortSignal): Promise<Result> { return run(bytes, replacement, attribution, signal); }
