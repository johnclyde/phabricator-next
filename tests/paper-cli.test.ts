import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { PaperBuild } from '../shared/paper-builds.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.ts';
import { createStore } from '../server/store.ts';
import { createAuth } from '../server/auth.ts';

const cli = fileURLToPath(new URL('../cli/index.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
const fixture: PaperBuild = {
  id: 'build-fixture', revisionId: 'P2', versionId: 'version-original', versionNumber: 1,
  contentHash: 'a'.repeat(64), entrypoint: 'paper/main.tex', toolchainId: 'b'.repeat(64),
  requestedBy: 'test-member', toolchain: { engine: 'fixture', image: `sha256:${'c'.repeat(64)}`, bundle: 'fixture' },
  status: 'queued', attempt: 0, createdAt: '2026-10-10T00:00:00.000Z', startedAt: null, finishedAt: null,
  error: null, diagnostics: [], artifacts: [], attempts: [],
};
const input = ['compile', 'P2', '--version-id', fixture.versionId, '--content-hash', fixture.contentHash, '--entrypoint', fixture.entrypoint, '--toolchain-id', fixture.toolchainId, '--request-id', 'saved-intent'];
function command(server: string, cwd: string, args: string[], token = 'test.cli.token') {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, cli, ...args, '--server', server], { cwd, env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', (value: Buffer) => { stdout += value.toString(); }); child.stderr.on('data', (value: Buffer) => { stderr += value.toString(); });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
async function service(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server = createServer((req, res) => { let body = ''; req.on('data', chunk => { body += chunk.toString(); }); req.on('end', () => handler(req, res, body)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/workspace/`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
function json(res: ServerResponse, body: unknown): void { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); }

test('paper CLI submits only explicit exact pins, retains retry identity, validates receipts and never resolves a moving version', async () => {
  const calls: { path: string; method: string; key?: string; body: unknown }[] = []; let corrupt = false;
  const api = await service((req, res, body) => {
    assert.equal(req.headers.authorization, 'Bearer test.cli.token');
    calls.push({ path: req.url!, method: req.method!, key: req.headers['idempotency-key'] as string | undefined, body: body ? JSON.parse(body) : undefined });
    json(res, corrupt ? { ...fixture, versionId: 'newer-version' } : fixture);
  });
  const directory = await mkdtemp(join(tmpdir(), 'paper-cli-pins-'));
  try {
    for (const invalid of [input.filter((_, index) => index !== 2 && index !== 3), [...input, '--version', '9'], [...input, '--entrypoint', '../main.tex'], [...input, '--toolchain-id', 'latest'], input.map(value => value === 'P2' ? 'D2' : value)]) {
      const result = await command(api.url, directory, invalid); assert.equal(result.code, 1); assert.equal(calls.length, 0);
    }
    const first = await command(api.url, directory, [...input, '--json']); const replay = await command(api.url, directory, [...input, '--json']);
    assert.equal(first.code, 0, first.stderr); assert.deepEqual(JSON.parse(first.stdout), fixture); assert.equal(replay.code, 0, replay.stderr);
    assert.equal(first.stderr, replay.stderr); assert.match(first.stderr, /saved-intent/); assert.ok(!first.stderr.includes('test.cli.token'));
    assert.deepEqual(calls[0], calls[1]); assert.deepEqual(calls[0], { path: '/workspace/api/revisions/P2/paper-builds', method: 'POST', key: 'saved-intent', body: { versionId: fixture.versionId, contentHash: fixture.contentHash, entrypoint: fixture.entrypoint, toolchainId: fixture.toolchainId } });
    corrupt = true; const bad = await command(api.url, directory, input); assert.equal(bad.code, 1); assert.equal(bad.stdout, ''); assert.match(bad.stderr, /receipt does not match/);
  } finally { await api.close(); await rm(directory, { recursive: true, force: true }); }
});

test('paper CLI downloads bounded verified artifact bytes into a new private file and refuses corrupt bodies, redirects and overwrites', async () => {
  const bytes = Buffer.from('%PDF-1.7\nCLI transport fixture, not a compilation\n%%EOF\n');
  const digest = createHash('sha256').update(bytes).digest('hex');
  let mode: 'valid' | 'corrupt' | 'oversize' | 'redirect' | 'failed' = 'valid'; let redirected = 0;
  const other = await service((_req, res) => { redirected++; res.end('Should not receive credentials'); });
  const api = await service((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test.cli.token');
    if (req.url!.endsWith('/artifacts/pdf')) {
      if (mode === 'redirect') { res.writeHead(302, { Location: other.url }); res.end(); return; }
      res.setHeader('Content-Type', 'application/pdf'); res.end(mode === 'corrupt' ? Buffer.alloc(bytes.length, 'X') : mode === 'oversize' ? Buffer.concat([bytes, bytes]) : bytes); return;
    }
    json(res, { build: { ...fixture, status: mode === 'failed' ? 'failed' : 'succeeded', artifacts: [{ kind: 'pdf', sha256: digest, bytes: bytes.length, mediaType: 'application/pdf', name: '../../untrusted.pdf' }] }, accessEpoch: 1 });
  });
  const directory = await mkdtemp(join(tmpdir(), 'paper-cli-artifact-'));
  const download = (name: string) => command(api.url, directory, ['download-build', 'P2', fixture.id, '--artifact', 'pdf', '--output', name, '--json']);
  try {
    const good = await download('paper.pdf'); assert.equal(good.code, 0, good.stderr); assert.deepEqual(await readFile(join(directory, 'paper.pdf')), bytes); assert.equal((await stat(join(directory, 'paper.pdf'))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(good.stdout).sha256, digest);
    await writeFile(join(directory, 'keep.pdf'), 'Existing private work');
    assert.equal((await download('keep.pdf')).code, 1); assert.equal(await readFile(join(directory, 'keep.pdf'), 'utf8'), 'Existing private work');
    await symlink('keep.pdf', join(directory, 'alias.pdf')); assert.equal((await download('alias.pdf')).code, 1); assert.equal(await readFile(join(directory, 'keep.pdf'), 'utf8'), 'Existing private work');
    for (const next of ['corrupt', 'oversize', 'redirect', 'failed'] as const) {
      mode = next; const result = await download(`${mode}.pdf`); assert.equal(result.code, 1, mode); await assert.rejects(stat(join(directory, `${mode}.pdf`)), { code: 'ENOENT' });
    }
    assert.equal(redirected, 0);
  } finally { await api.close(); await other.close(); await rm(directory, { recursive: true, force: true }); }
});

test('paper CLI paginates history, safely displays diagnostics, and pins explicit cancel/retry operations', async () => {
  const calls: { path: string; method: string; key?: string; body: string }[] = []; let corruptRetry = false; let repeatOriginal = false;
  const failed: PaperBuild = { ...fixture, status: 'failed', error: 'Unsafe\u001b[31m log', diagnostics: [{ severity: 'error', path: 'paper/main.tex', line: 7, message: 'Bad\u001b[2J command' }] };
  const api = await service((req, res, body) => {
    calls.push({ path: req.url!, method: req.method!, key: req.headers['idempotency-key'] as string | undefined, body });
    if (req.url!.includes('?')) { json(res, { builds: [failed], nextBefore: 5, configuration: { available: true, toolchain: fixture.toolchain, toolchainId: fixture.toolchainId, reason: null }, accessEpoch: 1 }); return; }
    if (req.method === 'GET') { json(res, { build: failed, accessEpoch: 1 }); return; }
    json(res, req.url!.endsWith('/cancel') ? { ...fixture, status: 'canceled' } : repeatOriginal ? failed : { ...fixture, id: 'build-retried', ...(corruptRetry ? { contentHash: 'd'.repeat(64) } : {}) });
  });
  const directory = await mkdtemp(join(tmpdir(), 'paper-cli-actions-'));
  try {
    const list = await command(api.url, directory, ['builds', 'P2', '--before', '10', '--limit', '2']); assert.equal(list.code, 0, list.stderr); assert.match(list.stdout, /More builds: --before 5/); assert.equal(calls[0]!.path, '/workspace/api/revisions/P2/paper-builds?before=10&limit=2');
    const show = await command(api.url, directory, ['build', 'P2', fixture.id]); assert.equal(show.code, 0, show.stderr); assert.ok(!show.stdout.includes('\u001b')); assert.match(show.stdout, /\\u001b/); assert.match(show.stdout, /paper\/main.tex:7/);
    const cancel = await command(api.url, directory, ['cancel-build', 'P2', fixture.id, '--request-id', 'cancel-exact']); assert.equal(cancel.code, 0, cancel.stderr); assert.deepEqual(calls.at(-1), { path: `/workspace/api/revisions/P2/paper-builds/${fixture.id}/cancel`, method: 'POST', key: 'cancel-exact', body: '{}' });
    const retry = ['retry-build', 'P2', fixture.id, '--request-id', 'retry-exact'];
    assert.equal((await command(api.url, directory, retry)).code, 0); assert.deepEqual(calls.at(-1), { path: `/workspace/api/revisions/P2/paper-builds/${fixture.id}/retry`, method: 'POST', key: 'retry-exact', body: '{}' });
    corruptRetry = true; const bad = await command(api.url, directory, retry); assert.equal(bad.code, 1); assert.match(bad.stderr, /receipt does not match/);
    corruptRetry = false; repeatOriginal = true; const unchanged = await command(api.url, directory, retry); assert.equal(unchanged.code, 1); assert.equal(unchanged.stdout, ''); assert.match(unchanged.stderr, /receipt does not match/);
  } finally { await api.close(); await rm(directory, { recursive: true, force: true }); }
});

test('paper CLI integrates with authenticated durable jobs, historical snapshots and continuing source visibility', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-cli-workspace-'));
  const store = createStore({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/workspace/', provisioning: true });
  const author = await provision.createAccount({ username: 'compiler-author', displayName: 'Paper author', password: 'Test-only compiler author password' });
  const owner = await provision.createAccount({ username: 'compiler-owner', displayName: 'Repository owner', password: 'Test-only compiler owner password' });
  const snapshots: string[] = [];
  const app = createApp({ store, seed: false, authMode: 'password', basePath: '/workspace/', paperRunner: {
    toolchain: fixture.toolchain,
    async run(source) { snapshots.push(source.files[0]!.content); return { success: false, error: 'Controlled runner failure, not TeX execution.', diagnostics: [], artifacts: [{ kind: 'log', name: 'compiler.log', mediaType: 'text/plain', data: Buffer.from('Explicit controlled failure') }] }; },
  } });
  const writer = app.auth.createToken(author.id, { name: 'Paper builds', scopes: ['read', 'write'] });
  const reader = app.auth.createToken(author.id, { name: 'Read builds', scopes: ['read'] });
  const repository = store.createRepository({ name: 'Paper sources', remoteUrl: 'https://example.invalid/paper.git' });
  const paper = store.createRevision({ testPlan: 'Fixture verification plan.', kind: 'paper', title: 'CLI job history', repositoryId: repository.id, files: [{ path: 'main.tex', content: 'Original immutable source' }] });
  const original = paper.versions[0]!;
  store.createVersion(paper.revision.id, { expectedVersion: 1, message: 'Later source', files: [{ path: 'main.tex', content: 'A later version must not be compiled implicitly' }] });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/workspace/`;
  const compile = ['compile', paper.revision.id, '--version-id', original.id, '--content-hash', original.contentHash, '--entrypoint', 'main.tex', '--toolchain-id', app.paperBuilds.configuration.toolchainId!, '--request-id', 'durable-paper-cli', '--json'];
  try {
    assert.equal((await command(url, directory, compile, reader.token)).code, 1);
    const submitted = await command(url, directory, compile, writer.token); assert.equal(submitted.code, 0, submitted.stderr);
    const receipt = JSON.parse(submitted.stdout) as PaperBuild; assert.equal(receipt.versionNumber, 1); assert.equal(receipt.status, 'queued');
    for (let attempt = 0; attempt < 100 && snapshots.length === 0; attempt++) await delay(10);
    assert.deepEqual(snapshots, ['Original immutable source']);
    const result = await command(url, directory, ['build', paper.revision.id, receipt.id, '--json'], reader.token); assert.equal(result.code, 0, result.stderr); assert.equal((JSON.parse(result.stdout) as PaperBuild).status, 'failed');
    const retryReceipt = await command(url, directory, compile, writer.token); assert.equal(retryReceipt.code, 0, retryReceipt.stderr); assert.deepEqual(JSON.parse(retryReceipt.stdout), receipt);
    const log = await command(url, directory, ['download-build', paper.revision.id, receipt.id, '--artifact', 'log', '--output', 'compiler.log'], reader.token); assert.equal(log.code, 0, log.stderr); assert.equal(await readFile(join(directory, 'compiler.log'), 'utf8'), 'Explicit controlled failure');
    const policy = app.policies.policy(repository.id, owner.id);
    app.policies.setPolicy(repository.id, { expectedVersion: policy.version, spaceId: policy.spaceId, ...policy.rules, view: { kind: 'principals', principalIds: [owner.id] } }, owner.id);
    for (const args of [compile, ['builds', paper.revision.id], ['build', paper.revision.id, receipt.id], ['download-build', paper.revision.id, receipt.id, '--artifact', 'log', '--output', 'revoked.log']]) assert.equal((await command(url, directory, args, writer.token)).code, 1);
    await assert.rejects(stat(join(directory, 'revoked.log')), { code: 'ENOENT' });
    assert.deepEqual(snapshots, ['Original immutable source']);
  } finally { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
