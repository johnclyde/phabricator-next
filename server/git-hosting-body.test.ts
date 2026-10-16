import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage } from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { spoolGitRequest } from './git-hosting-body.ts';

const status = (expected: number) => (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === expected;
function request(bytes: Buffer, encoding?: string) { return Object.assign(Readable.from([bytes]), { headers: encoding === undefined ? {} : { 'content-encoding': encoding } }) as unknown as IncomingMessage; }
async function fixture(work: (path: string) => Promise<void>) { const root = await mkdtemp(join(tmpdir(), 'phab-git-body-')); try { await work(join(root, 'request')); } finally { await rm(root, { force: true, recursive: true }); } }

for (const encoding of [undefined, 'gzip']) test(`Git request spooling preserves binary protocol bytes with ${encoding ?? 'identity'} encoding`, async () => fixture(async path => {
  const content = Buffer.from([0, 255, 1, 13, 10, 0, 42]), body = encoding ? gzipSync(content) : content;
  const length = await spoolGitRequest(request(body, encoding), path, new AbortController().signal, 1_024);
  assert.equal(length, content.length); assert.deepEqual(await readFile(path), content); assert.equal((await stat(path)).mode & 0o777, 0o600);
}));

test('Git request spooling bounds both wire size and gzip expansion and removes partial files', async () => fixture(async path => {
  for (const [body, encoding, maximum] of [
    [Buffer.alloc(1_025, 42), undefined, 1_024],
    [gzipSync(Buffer.alloc(65_536, 42)), 'gzip', 1_024],
    [gzipSync(Buffer.alloc(1)), 'gzip', 10],
  ] as const) {
    await assert.rejects(spoolGitRequest(request(body, encoding), path, new AbortController().signal, maximum), status(413));
    await assert.rejects(stat(path), { code: 'ENOENT' });
  }
}));

test('Git request spooling rejects malformed gzip, unsupported encoding and preexisting destinations', async () => fixture(async path => {
  for (const body of [Buffer.from('not gzip'), gzipSync(Buffer.from('protocol')).subarray(0, 12)]) {
    await assert.rejects(spoolGitRequest(request(body, 'gzip'), path, new AbortController().signal, 1_024), status(400));
    await assert.rejects(stat(path), { code: 'ENOENT' });
  }
  for (const encoding of ['deflate', 'br', 'gzip, gzip', '']) {
    await assert.rejects(spoolGitRequest(request(Buffer.from('protocol'), encoding), path, new AbortController().signal, 1_024), status(415));
    await assert.rejects(stat(path), { code: 'ENOENT' });
  }
  await writeFile(path, 'Preserve existing data', { mode: 0o600 });
  await assert.rejects(spoolGitRequest(request(Buffer.from('replacement')), path, new AbortController().signal, 1_024), { code: 'EEXIST' });
  assert.equal(await readFile(path, 'utf8'), 'Preserve existing data');
}));

test('Git request spooling cancels an unfinished stream and cleans partial data', async () => fixture(async path => {
  const input = Object.assign(new PassThrough(), { headers: {} }) as unknown as IncomingMessage, controller = new AbortController();
  const pending = spoolGitRequest(input, path, controller.signal, 1_024);
  const rejection = assert.rejects(pending, status(499));
  input.push(Buffer.from('unfinished Git protocol')); controller.abort(); await rejection;
  await assert.rejects(stat(path), { code: 'ENOENT' });
  await assert.rejects(spoolGitRequest(request(Buffer.from('unused')), path, AbortSignal.abort(), 1_024), status(499));
  await assert.rejects(stat(path), { code: 'ENOENT' });
}));
