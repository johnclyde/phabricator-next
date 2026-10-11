import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, symlink, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pasteCommand } from '../cli/pastes.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';
import { PASTE_MAX_BYTES, type PasteRecord, type PasteVersion } from '../shared/pastes.ts';

const content = '\uFEFF  const result = "🦆";\r\n\rLast line\n  ';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const record = (patch: Partial<PasteRecord> = {}): PasteRecord => ({ id: 'PA1', title: '', language: null, status: 'active', authorId: 'U1', version: 1, contentVersion: 1, contentHash: sha(content), bytes: Buffer.byteLength(content), lineCount: 4, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', ...patch });
const version = (patch: Partial<PasteVersion> = {}): PasteVersion => ({ pasteId: 'PA1', number: 1, content, sha256: sha(content), bytes: Buffer.byteLength(content), lineCount: 4, createdAt: '2026-10-10T00:00:00.000Z', attribution: { principalId: 'U1', displayName: 'Author', credentialId: null, requestId: 'original' }, ...patch });
function context(command: string, options: PaperCLI['options'] = {}, args = ['PA1']) {
  const calls: { path: string; method?: string; body?: unknown; key?: string }[] = [];
  const cli: PaperCLI = { command, args, options, optionNames: Object.keys(options), request: async <T>(path: string, method?: string, body?: unknown, key?: string) => { calls.push({ path, method, body, key }); return record() as T; }, download: async () => Buffer.from(content) };
  return { cli, calls };
}
async function capture(work: (output: string[], errors: string[]) => Promise<void>): Promise<void> {
  const log = console.log, error = console.error, output: string[] = [], errors: string[] = [];
  console.log = (...values: unknown[]) => output.push(values.join(' ')); console.error = (...values: unknown[]) => errors.push(values.join(' '));
  try { await work(output, errors); } finally { console.log = log; console.error = error; }
}
async function directory(work: (path: string) => Promise<void>) { const path = await mkdtemp(join(tmpdir(), 'paste-cli-')); try { await work(path); } finally { await rm(path, { recursive: true, force: true }); } }

test('Paste CLI distinguishes PA identifiers, validates exact versions, and preserves bounded filter identities', async () => capture(async () => {
  const badId = context('paste', {}, ['P1']); await assert.rejects(pasteCommand(badId.cli), /PA1/); assert.equal(badId.calls.length, 0);
  const exact = context('paste-version'); await assert.rejects(pasteCommand(exact.cli), /--version/); assert.equal(exact.calls.length, 0);
  exact.cli.options.version = '1'; exact.cli.optionNames = ['version']; exact.cli.request = async <T>(path: string) => { assert.equal(path, '/api/pastes/PA1/versions/1'); return { version: version({ number: 2 }) } as T; };
  await assert.rejects(pasteCommand(exact.cli), /different version/);
  const listing = context('pastes', { query: 'x&status=archived', author: 'U1', language: '', status: 'all', 'created-after': '2026-01-01T00:00:00Z', before: '20', limit: '100', json: true }, []);
  listing.cli.request = async <T>(path: string) => { const url = new URL(path, 'http://127.0.0.1'); assert.equal(url.pathname, '/api/pastes'); assert.equal(url.searchParams.get('query'), 'x&status=archived'); assert.equal(url.searchParams.get('authorId'), 'U1'); assert.equal(url.searchParams.get('createdAfter'), '2026-01-01T00:00:00Z'); assert.equal(url.searchParams.get('language'), ''); return { pastes: [], nextBefore: null } as T; };
  assert.equal(await pasteCommand(listing.cli), true); listing.cli.options.limit = '101'; await assert.rejects(pasteCommand(listing.cli), /100/);
  const unexpected = context('paste', { title: 'ignored?' }); await assert.rejects(pasteCommand(unexpected.cli), /unsupported option/); assert.equal(unexpected.calls.length, 0);
  assert.equal(await pasteCommand(context('unrelated').cli), false);
}));

test('Paste creation preserves exact BOM and UTF-8 newline bytes with stable uncertain-result request identity', async () => capture(async (_output, errors) => directory(async path => {
  const input = join(path, 'source.txt'); await writeFile(input, content);
  const setup = context('create-paste', { title: '  snippet.ts  ', language: 'typescript', space: 'S2', 'request-id': 'original-create' }, [input]);
  setup.cli.request = async <T>(url: string, method?: string, body?: unknown, key?: string) => { setup.calls.push({ path: url, method, body, key }); return record({ title: 'snippet.ts', language: 'typescript' }) as T; };
  assert.equal(await pasteCommand(setup.cli), true); assert.equal(await pasteCommand(setup.cli), true);
  assert.deepEqual(setup.calls[0], setup.calls[1]); assert.deepEqual(setup.calls[0], { path: '/api/pastes', method: 'POST', key: 'original-create', body: { title: 'snippet.ts', language: 'typescript', content, access: { spaceId: 'S2' } } });
  assert.equal(errors[0], errors[1]); assert.ok(!errors.join('').includes('result')); assert.match(errors[0]!, /inputHash/);
  setup.cli.request = async <T>() => record({ title: 'snippet.ts', language: 'typescript', contentHash: sha(content.slice(1)) }) as T;
  await assert.rejects(pasteCommand(setup.cli), /exact submitted changes/);
})));

test('Paste inputs reject symlinks, directories, malformed UTF-8, NUL, empty and oversized files before sending', async () => capture(async () => directory(async path => {
  const input = join(path, 'source.txt'), link = join(path, 'link.txt'); await writeFile(input, content); await symlink(input, link);
  const setup = context('create-paste', {}, [link]); await assert.rejects(pasteCommand(setup.cli));
  setup.cli.args = [path]; await assert.rejects(pasteCommand(setup.cli), /regular UTF-8/);
  setup.cli.args = [input];
  for (const invalid of [Buffer.from([0xff]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('before\0after'), Buffer.alloc(0), Buffer.alloc(PASTE_MAX_BYTES + 1, 65)]) { await writeFile(input, invalid); await assert.rejects(pasteCommand(setup.cli)); }
  assert.equal(setup.calls.length, 0);
})));

test('metadata edits use the explicit version and accept exact no-ops without fetching a newer head', async () => capture(async () => {
  const setup = context('edit-paste', { title: 'retitled', language: '', 'request-id': 'same-edit' }); await assert.rejects(pasteCommand(setup.cli), /--version/); assert.equal(setup.calls.length, 0);
  setup.cli.options.version = '4'; setup.cli.optionNames.push('version');
  for (const returnedVersion of [4, 5]) {
    setup.cli.request = async <T>(path: string, method?: string, body?: unknown, requestId?: string) => { assert.equal(path, '/api/pastes/PA1'); assert.equal(method, 'PATCH'); assert.equal(requestId, 'same-edit'); assert.deepEqual(body, { expectedVersion: 4, title: 'retitled', language: null }); return record({ title: 'retitled', version: returnedVersion }) as T; };
    assert.equal(await pasteCommand(setup.cli), true);
  }
  setup.cli.request = async <T>() => record({ title: 'retitled', version: 6 }) as T; await assert.rejects(pasteCommand(setup.cli), /exact submitted changes/);
  const archive = context('archive-paste', { version: '5', 'request-id': 'archive' }); archive.cli.request = async <T>(_path: string, method?: string, body?: unknown) => { assert.equal(method, 'PATCH'); assert.deepEqual(body, { expectedVersion: 5, status: 'archived' }); return record({ version: 6, status: 'archived' }) as T; }; assert.equal(await pasteCommand(archive.cli), true);
}));

test('comments remain pinned to the requested old content version and never log their text in request recovery metadata', async () => capture(async (_output, errors) => directory(async path => {
  const input = join(path, 'comment.txt'); await writeFile(input, '  Inspection of version one.\n');
  const setup = context('comment-paste', { version: '1', 'comment-file': input, 'request-id': 'comment-one' });
  setup.cli.request = async <T>(path: string, method?: string, body?: unknown, key?: string) => { assert.equal(path, '/api/pastes/PA1/comments'); assert.equal(method, 'POST'); assert.equal(key, 'comment-one'); assert.deepEqual(body, { contentVersion: 1, body: 'Inspection of version one.' }); return { pasteId: 'PA1', kind: 'comment', contentVersion: 1, comment: 'Inspection of version one.' } as T; };
  assert.equal(await pasteCommand(setup.cli), true); assert.ok(!errors.join('').includes('Inspection'));
  setup.cli.request = async <T>() => ({ pasteId: 'PA1', kind: 'comment', contentVersion: 2, comment: 'Inspection of version one.' }) as T; await assert.rejects(pasteCommand(setup.cli), /exact version and comment/);
})));

test('raw downloads verify the selected snapshot before exclusive creation and preserve all original bytes', async () => capture(async () => directory(async path => {
  const output = join(path, 'download.txt'), setup = context('download-paste', { version: '1', output });
  setup.cli.request = async <T>(path: string) => { assert.equal(path, '/api/pastes/PA1/versions/1'); return { version: version() } as T; };
  setup.cli.download = async (path, limit) => { assert.equal(path, '/api/pastes/PA1/raw?version=1'); assert.equal(limit, Buffer.byteLength(content)); return Buffer.from(content.slice(1)); };
  await assert.rejects(pasteCommand(setup.cli), /No output was written/); await assert.rejects(stat(output), { code: 'ENOENT' });
  setup.cli.download = async () => Buffer.from(content); assert.equal(await pasteCommand(setup.cli), true); assert.deepEqual(await readFile(output), Buffer.from(content)); assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(pasteCommand(setup.cli), { code: 'EEXIST' }); assert.deepEqual(await readFile(output), Buffer.from(content));
  const link = join(path, 'linked-output'); await symlink(output, link); setup.cli.options.output = link; await assert.rejects(pasteCommand(setup.cli), { code: 'EEXIST' });
  setup.cli.options.output = join(path, 'wrong-version.txt'); setup.cli.request = async <T>() => ({ version: version({ sha256: 'f'.repeat(64) }) }) as T; await assert.rejects(pasteCommand(setup.cli), /immutable hash/); await assert.rejects(stat(String(setup.cli.options.output)), { code: 'ENOENT' });
})));

test('history and content version lists keep cursor bounds and escape terminal control sequences', async () => capture(async output => {
  for (const [command, endpoint, response] of [['paste-history', 'history', { transactions: [{ comment: '\u001b[2J\u202etext' }], nextBefore: 1 }], ['paste-versions', 'versions', { versions: [{ number: 1 }], nextBefore: null }]] as const) {
    const setup = context(command, { before: '2', limit: '1' }); setup.cli.request = async <T>(path: string) => { assert.equal(path, `/api/pastes/PA1/${endpoint}?before=2&limit=1`); return response as T; }; assert.equal(await pasteCommand(setup.cli), true);
  }
  assert.equal(output.join('').includes('\u001b'), false); assert.equal(output.join('').includes('\u202e'), false); assert.match(output.join(''), /\\u001b/); assert.match(output.join(''), /\\u202e/);
}));
