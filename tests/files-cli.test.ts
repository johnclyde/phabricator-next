import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileCommand } from '../cli/files.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';
import type { FileRecord } from '../shared/files.ts';

const content = Buffer.from('immutable CLI upload bytes');
const file: FileRecord = { id: 'F1', sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length, mediaType: 'application/octet-stream', originalName: 'figure.bin', authorId: 'member', createdAt: '2026-10-10', dimensions: null, name: 'figure.bin', altText: '', status: 'active', version: 1, updatedAt: '2026-10-10' };
async function quiet(work: () => Promise<void>) {
  const log = console.log; const error = console.error; const output: string[] = [];
  console.log = console.error = (...items: unknown[]) => { output.push(items.map(String).join(' ')); };
  try { await work(); return output; } finally { console.log = log; console.error = error; }
}
function command(command: string, args: string[], options: PaperCLI['options'], request: PaperCLI['request'], download: PaperCLI['download'] = async () => content) {
  return fileCommand({ command, args, options, optionNames: Object.keys(options), request, download });
}

test('Files CLI verifies upload identity, prints source-free retry intent and refuses symlinks and unrecognized options before transmission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'files-cli-')); const path = join(directory, 'figure.bin'); await writeFile(path, content); await symlink(path, join(directory, 'link'));
  const calls: unknown[][] = []; const request: PaperCLI['request'] = async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); return file as T; };
  try {
    const output = await quiet(async () => {
      await command('upload-file', [path], { 'request-id': 'same-request', json: true }, request);
      await command('upload-file', [path], { 'request-id': 'same-request', json: true }, request);
      await assert.rejects(command('upload-file', [join(directory, 'link')], {}, request));
      await assert.rejects(command('upload-file', [path], { source: 'unsupported' }, request), /unsupported/);
    });
    assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
    assert.equal(calls[0]![0], '/api/files'); assert.equal(calls[0]![3], 'same-request');
    assert.deepEqual(calls[0]![2], { name: 'figure.bin', dataBase64: content.toString('base64'), sha256: file.sha256, bytes: content.length });
    assert.ok(output.every(item => !item.includes(content.toString('base64')) && !item.includes(content.toString())));
    await quiet(async () => { await assert.rejects(command('upload-file', [path], {}, async <T>() => ({ ...file, sha256: '0'.repeat(64) }) as T), /receipt does not match/); });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Files CLI downloads only verified bytes to an exclusive private path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'files-cli-download-')); const output = join(directory, 'saved.bin');
  const request: PaperCLI['request'] = async <T>() => ({ file }) as T;
  try {
    await quiet(async () => { await command('download-file', ['F1'], { output }, request); });
    assert.deepEqual(await readFile(output), content); assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(command('download-file', ['F1'], { output }, request), /EEXIST/);
    await assert.rejects(command('download-file', ['F1'], { output: join(directory, 'corrupt') }, request, async () => Buffer.alloc(content.length)), /SHA-256/);
    await assert.rejects(stat(join(directory, 'corrupt')), /ENOENT/);
    await assert.rejects(command('download-file', ['F1'], { output: join(directory, 'wrong-id') }, async <T>() => ({ file: { ...file, id: 'F2' } }) as T), /immutable File/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Files CLI attachment requires explicit reviewed access epoch and zero-version CAS for a new binding', async () => {
  const calls: unknown[][] = []; const request: PaperCLI['request'] = async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); return { saved: true } as T; };
  await assert.rejects(command('attach-file', ['F1'], { object: 'P2', mode: 'attach', version: '0' }, request), /access-epoch/); assert.equal(calls.length, 0);
  await quiet(async () => { await command('attach-file', ['F1'], { object: 'P2', mode: 'attach', version: '0', 'access-epoch': '12', 'request-id': 'attach' }, request); });
  assert.deepEqual(calls, [['/api/files/F1/attachments', 'POST', { objectId: 'P2', mode: 'attach', expectedVersion: 0, expectedAccessEpoch: 12 }, 'attach']]);
});

test('Files CLI figure replacement reuses only explicitly pinned text and validates combined namespace before mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'files-cli-figures-')); const path = join(directory, 'manifest.json');
  const asset = { path: 'figures/chart.pdf', fileId: 'F1', sha256: 'b'.repeat(64), bytes: 128, mediaType: 'application/pdf' }; await writeFile(path, JSON.stringify([asset]));
  const files = [{ path: 'paper.tex', content: 'Original pinned text' }]; const hash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const source = { revision: { id: 'P2' }, version: { id: 'version-id', revisionId: 'P2', number: 2, contentHash: hash, files } };
  const calls: unknown[][] = []; const request: PaperCLI['request'] = async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); return source as T; };
  const options = { 'assets-manifest': path, version: '2', 'version-id': 'version-id', 'content-hash': hash, 'access-epoch': '9', 'share-assets': true, message: 'Updated figure', 'request-id': 'figures' };
  try {
    await quiet(async () => { await command('set-figures', ['P2'], options, request); });
    assert.equal(calls[0]![0], '/api/revisions/P2/export?version=2'); assert.equal(calls[1]![0], '/api/revisions/P2/versions');
    assert.deepEqual(calls[1]![2], { files: source.version.files, assets: [asset], message: options.message, expectedVersion: 2, expectedVersionId: 'version-id', expectedContentHash: hash, expectedAccessEpoch: 9, shareAssets: true });
    calls.length = 0;
    await assert.rejects(command('set-figures', ['P2'], { ...options, 'version-id': 'wrong-id' }, request), /reviewed pins/); assert.equal(calls.length, 1);
    await assert.rejects(command('set-figures', ['P2'], options, async <T>() => ({ ...source, version: { ...source.version, files: [{ path: 'paper.tex', content: 'Changed after inspection' }] } }) as T), /source bytes differ/);
    await writeFile(path, JSON.stringify([{ ...asset, path: 'paper.tex' }])); calls.length = 0;
    await assert.rejects(command('set-figures', ['P2'], options, request)); assert.equal(calls.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
