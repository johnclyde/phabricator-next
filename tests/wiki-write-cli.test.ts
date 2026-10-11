import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { wikiWriteCommand } from '../cli/wiki-write.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';
import { startWikiApi } from '../server/wiki-api-test-support.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const source = 'Private original body\r\nwith exact whitespace.  ';
const dictionary = (patch: Record<string, unknown> = {}) => ({ phid: 'PHID-WIKI-aaaaaaaaaaaaaaaaaaaa', uri: 'http://localhost/w/article/', slug: 'article/', version: 1, authorPHID: null, title: 'Original title', content: source, status: 'exists', description: '', dateCreated: 1_800_000_000, ...patch });
const envelope = (patch: Record<string, unknown> = {}) => ({ result: dictionary(patch), error_code: null, error_info: null });
type Call = { path: string; method: string | undefined; body: unknown; requestId: string | undefined };
async function exercise(path: string, options: PaperCLI['options'] = {}, response: unknown = envelope(), command = 'create-wiki', reject = false) {
  const calls: Call[] = [], stdout: string[] = [], stderr: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...values: unknown[]) => stdout.push(values.join(' ')); console.error = (...values: unknown[]) => stderr.push(values.join(' '));
  try {
    const handled = await wikiWriteCommand({ command, args: [path], options, optionNames: Object.keys(options), request: async <T>(url: string, method?: string, body?: unknown, requestId?: string) => { calls.push({ path: url, method, body, requestId }); if (reject) throw new Error('Lost response'); return response as T; }, download: async () => { throw new Error('Unexpected download'); } });
    return { handled, calls, stdout, stderr, error: undefined };
  } catch (failure) { return { handled: undefined, calls, stdout, stderr, error: failure }; }
  finally { console.log = log; console.error = error; }
}
async function fixture(run: (directory: string, path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-cli-')); const path = join(directory, 'request.json');
  try { await writeFile(path, JSON.stringify({ slug: 'Article', title: 'Original title', content: source })); await run(directory, path); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
function recovery(stderr: string[]) { const match = /^Wiki request: (\{.*\})\. Retain/.exec(stderr[0] ?? ''); assert.ok(match); return JSON.parse(match[1]!) as { requestId: string; requestSha256: string; inputPath: string; path: string }; }

test('wiki write CLI sends one canonical explicit mutation and reports source-free escaped receipt metadata', async () => fixture(async (_directory, path) => {
  const title = ' Exact title \u001b[2J\u202e ';
  const request = { slug: '//ARTICLE//', title, content: source, description: 'Private description' };
  await writeFile(path, JSON.stringify(request));
  const result = await exercise(path, { json: true, 'request-id': 'wiki-explicit-key' }, envelope({ title, description: request.description }));
  assert.equal(result.error, undefined); assert.equal(result.handled, true);
  assert.deepEqual(result.calls, [{ path: '/api/phriction.create', method: 'POST', body: { ...request, slug: 'article/' }, requestId: 'wiki-explicit-key' }]);
  const printed = JSON.parse(result.stdout.join('')) as Record<string, unknown>;
  assert.equal(printed.title, title); assert.equal(printed.contentSha256, sha(source)); assert.equal(printed.version, 1);
  assert.equal('content' in printed, false); assert.equal('description' in printed, false);
  assert.equal(result.stdout.join('').includes(source), false); assert.equal(result.stderr.join('').includes(source), false);
  assert.equal(/[\u001b\u202e]/.test(result.stdout.join('') + result.stderr.join('')), false);
  assert.equal(recovery(result.stderr).requestSha256, sha(JSON.stringify(result.calls[0]!.body)));
  assert.match(result.stderr.join(''), /publishes immediately/);
}));

test('wiki write CLI retains generated request ID and exact submitted digest after an uncertain response', async () => fixture(async (_directory, path) => {
  const lost = await exercise(path, {}, envelope(), 'create-wiki', true);
  assert.ok(lost.error); assert.equal(lost.calls.length, 1); assert.equal(lost.stdout.length, 0);
  const saved = recovery(lost.stderr); assert.match(saved.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(saved.inputPath, path); assert.equal(saved.requestSha256, sha(JSON.stringify(lost.calls[0]!.body)));
  const retry = await exercise(path, { 'request-id': saved.requestId });
  assert.equal(retry.error, undefined); assert.deepEqual(retry.calls, lost.calls); assert.deepEqual(recovery(retry.stderr), saved);
  assert.match(retry.stdout.join(''), /historical or unchanged/);
}));

test('wiki edit preserves ignored fields and never assumes input content equals the returned published source', async () => fixture(async (_directory, path) => {
  for (const fields of [{ title: '', content: '0' }, { title: null, content: null }, { content: 'Newest draft body' }, { description: 'Description only' }, { description: null }]) {
    await writeFile(path, JSON.stringify({ slug: 'article/', ...fields }));
    const result = await exercise(path, { json: true }, envelope(), 'edit-wiki');
    assert.equal(result.error, undefined); assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0]!.path, '/api/phriction.edit'); assert.deepEqual(result.calls[0]!.body, { slug: 'article/', ...fields });
    assert.equal((JSON.parse(result.stdout.join('')) as { contentSha256: string }).contentSha256, sha(source));
  }
  await writeFile(path, JSON.stringify({ slug: '   ', title: ' ', content: '0' }));
  const whitespace = await exercise(path, {}, envelope({ slug: '_/', uri: 'http://localhost/w/_/', title: ' ', content: '0' }));
  assert.equal(whitespace.error, undefined); assert.deepEqual(whitespace.calls[0]!.body, { slug: '_/', title: ' ', content: '0' });
  await writeFile(path, JSON.stringify({ slug: 'article/' }));
  const historicalSlug = await exercise(path, {}, envelope({ slug: 'Article' }), 'edit-wiki');
  assert.equal(historicalSlug.error, undefined, 'An unchanged legacy version may retain its original noncanonical slug.');
}));

test('wiki write rejects invalid or secret-bearing JSON inputs before any request', async () => fixture(async (_directory, path) => {
  const valid = { slug: 'article/', title: 'Title', content: source };
  const invalid: unknown[] = [[], null, {}, { ...valid, slug: '' }, { ...valid, slug: 'x'.repeat(513) }, { ...valid, slug: 'x'.repeat(128) }, { ...valid, title: '' }, { ...valid, title: 'x'.repeat(241) }, { ...valid, content: '' }, { ...valid, content: 'x'.repeat(500_001) }, { ...valid, description: 'x'.repeat(10_001) }, { ...valid, title: '\ud800' }, { ...valid, content: 'bad\0source' }, { ...valid, '__conduit__': { token: 'private-token' } }, { ...valid, 'api.token': 'private-token' }, { ...valid, expectedVersion: 1 }];
  for (const value of invalid) {
    await writeFile(path, JSON.stringify(value)); const result = await exercise(path);
    assert.ok(result.error, JSON.stringify(value).slice(0, 100)); assert.equal(result.calls.length, 0); assert.deepEqual(result.stderr, []);
  }
  await writeFile(path, JSON.stringify(valid));
  for (const options of [{ title: 'wrong source' }, { 'request-id': 'has space' }, { version: '1' }]) { const result = await exercise(path, options); assert.ok(result.error); assert.equal(result.calls.length, 0); }
}));

test('wiki write accepts legacy read-length edit paths and rejects malformed, oversized, special or linked files', async () => fixture(async (directory, path) => {
  const slug = `${'x'.repeat(200)}/`; await writeFile(path, JSON.stringify({ slug, title: 'Title' }));
  const legacy = await exercise(path, {}, envelope({ slug, uri: `http://localhost/w/${slug}`, title: 'Title' }), 'edit-wiki'); assert.equal(legacy.error, undefined);
  const linked = join(directory, 'linked.json'); await symlink(path, linked);
  const folder = join(directory, 'folder'); await mkdir(folder);
  for (const filename of [linked, folder]) { const result = await exercise(filename); assert.ok(result.error); assert.equal(result.calls.length, 0); }
  for (const content of [Buffer.from([0xff]), '{"content":"private-source-fragment",', ' '.repeat(2_000_001)]) {
    await writeFile(path, content); const result = await exercise(path); assert.ok(result.error); assert.equal(result.calls.length, 0); assert.equal(String(result.error).includes('private-source-fragment'), false);
  }
}));

test('wiki write treats Conduit 200 errors and malformed or mismatched receipts as failures without source disclosure', async () => fixture(async (_directory, path) => {
  for (const response of [null, {}, { result: dictionary(), error_code: 'ERR-BAD-DOCUMENT', error_info: source }, { result: dictionary(), error_code: null, error_info: 'Contradictory success' }, ...[{ slug: 'other/' }, { phid: 'W1' }, { version: 0 }, { authorPHID: 7 }, { title: 7 }, { content: 7 }, { status: 'unknown' }, { description: null }, { dateCreated: 0.5 }, { uri: 'javascript:alert(1)' }, { uri: 'https://username:password@localhost/w/article/' }].map(envelope)]) {
    const result = await exercise(path, {}, response); assert.ok(result.error); assert.equal(result.calls.length, 1); assert.deepEqual(result.stdout, []); assert.equal(String(result.error).includes(source), false);
  }
}));

test('wiki creation verifies exact source and first publication even when a substituted receipt has the same path', async () => fixture(async (_directory, path) => {
  for (const patch of [{ version: 2 }, { status: 'deleted' }, { title: 'Substituted title' }, { content: 'Substituted body' }, { description: 'Substituted description' }]) {
    const result = await exercise(path, {}, envelope(patch)); assert.ok(result.error); assert.match(String(result.error), /differs from the exact submitted source/); assert.equal(result.stdout.length, 0);
  }
  await writeFile(path, JSON.stringify({ slug: 'article/', title: 'Original title', content: source, description: null }));
  const valid = await exercise(path); assert.equal(valid.error, undefined);
}));

test('wiki edit binds effective titles while allowing ignored titles and server-filtered body or description', async () => fixture(async (_directory, path) => {
  for (const title of ['Changed title', ' ']) {
    await writeFile(path, JSON.stringify({ slug: 'article/', title, content: 'Latest draft body', description: 'Ignored description' }));
    const substituted = await exercise(path, {}, envelope(), 'edit-wiki'); assert.ok(substituted.error); assert.match(String(substituted.error), /differs from the submitted title/); assert.equal(substituted.stdout.length, 0);
    const valid = await exercise(path, {}, envelope({ title }), 'edit-wiki'); assert.equal(valid.error, undefined);
  }
  for (const title of ['', '0', null]) {
    await writeFile(path, JSON.stringify({ slug: 'article/', title })); const ignored = await exercise(path, {}, envelope(), 'edit-wiki'); assert.equal(ignored.error, undefined);
  }
}));

const cli = fileURLToPath(new URL('../cli/index.ts', import.meta.url)); const loader = import.meta.resolve('tsx');
function runCLI(cwd: string, args: string[], token: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, cli, ...args], { cwd, env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); }); child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

for (const mount of ['/', '/review/']) test(`wiki create/edit CLI publishes explicit requests and recovers historical receipts at ${mount}`, async () => fixture(async (directory, path) => {
  const app = await startWikiApi(mount);
  const command = (name: string, key: string, token = app.tokens.alice.token) => runCLI(directory, [name, path, '--request-id', key, '--json', '--server', app.url('/')], token);
  try {
    await app.document('/');
    const created = await command('create-wiki', 'cli-wiki-create'); assert.equal(created.code, 0, created.stderr);
    const meta = JSON.parse(created.stdout) as { slug: string; version: number; contentSha256: string }; assert.equal(meta.slug, 'article/'); assert.equal(meta.version, 1); assert.equal(meta.contentSha256, sha(source));
    assert.ok(!created.stdout.includes(source)); assert.ok(!created.stderr.includes(app.tokens.alice.token));
    const document = app.store.state({ configured: false, model: null }).documents.find(item => item.slug === 'article/')!; assert.ok(document);
    await app.operation(document.id, 'drafts', { title: 'Shared draft title', content: 'Shared draft body' });
    await writeFile(path, JSON.stringify({ slug: 'article/', title: ' Published title with spaces ', description: 'Title-only immediate publish' }));
    const edited = await command('edit-wiki', 'cli-wiki-edit'); assert.equal(edited.code, 0, edited.stderr);
    const editedMeta = JSON.parse(edited.stdout) as { version: number; title: string; contentSha256: string }; assert.equal(editedMeta.version, 3); assert.equal(editedMeta.title, ' Published title with spaces '); assert.equal(editedMeta.contentSha256, sha(source));
    const detail = app.store.documentDetail(document.id); assert.equal(detail.document.publication!.publishedVersion, 3); assert.equal(detail.document.content, source); assert.equal(app.store.documentVersion(document.id, 2).content, 'Shared draft body');
    await app.operation(document.id, 'drafts', { title: editedMeta.title, content: 'Newer draft body' });
    const replay = await command('edit-wiki', 'cli-wiki-edit'); assert.equal(replay.code, 0, replay.stderr); assert.deepEqual(JSON.parse(replay.stdout), editedMeta); assert.equal(app.store.documentDetail(document.id).document.version, 4);
    await writeFile(path, JSON.stringify({ slug: 'article/', content: 'Newer draft body' }));
    const ignored = await command('edit-wiki', 'cli-wiki-noop'); assert.equal(ignored.code, 0, ignored.stderr); assert.equal((JSON.parse(ignored.stdout) as { version: number }).version, 3); assert.equal(app.store.documentDetail(document.id).document.version, 4);
    const changed = await command('edit-wiki', 'cli-wiki-edit'); assert.equal(changed.code, 1); assert.equal(changed.stdout, '');
    const denied = await command('edit-wiki', 'cli-wiki-reader', app.tokens.reader.token); assert.equal(denied.code, 1); assert.match(denied.stderr, /ERR-INVALID-AUTH/); assert.equal(denied.stdout, '');
  } finally { await app.close(); }
}));
