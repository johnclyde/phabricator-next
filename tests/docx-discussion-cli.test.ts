import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app';
import { createAuth } from '../server/auth';
import { createStore } from '../server/store';
import { inspectDocx } from '../server/docx-package';
import type { RevisionDetail, ReviewComment } from '../shared/types';
import type { FileRecord } from '../shared/files';
import { docxDiscussionCommand } from '../cli/docx-discussion';
import type { PaperCLI } from '../cli/paper-builds';

const executable = fileURLToPath(new URL('../cli/index.ts', import.meta.url)), loader = import.meta.resolve('tsx');
function cli(args: string[], token: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, executable, ...args], { env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
for (const basePath of ['/', '/review/']) test(`Word CLI creates exact passage threads and exports complete attributed discussion with read scope at ${basePath}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-word-discussion-cli-')), store = createStore({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const account = await provision.createAccount({ username: 'writer', displayName: 'CLI Writer', password: 'A strong local Word test password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  try {
    const writer = app.auth.createToken(account.id, { name: 'Writer', scopes: ['read', 'write'] }), reader = app.auth.createToken(account.id, { name: 'Reader', scopes: ['read'] });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath}`;
    const request = async <T>(path: string, input?: unknown) => {
      const response = await fetch(new URL(`api${path}`, url), { method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${writer.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(input ? { body: JSON.stringify(input) } : {}) });
      const value: unknown = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value as T;
    };
    const source = await readFile(new URL('./fixtures/docx/roundtrip.docx', import.meta.url));
    const file = await request<FileRecord>('/files', { name: 'Motion.docx', sha256: createHash('sha256').update(source).digest('hex'), bytes: source.length, dataBase64: source.toString('base64') });
    const original = await request<RevisionDetail>('/revisions/docx', { testPlan: 'Fixture verification plan.', title: 'CLI Word review', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: false, expectedAccessEpoch: app.policies.epoch() });
    const id = original.revision.id, version = original.versions[0]!, range = version.docx!.projection.editableRanges.find(item => item.text === 'The original result is clear.')!;
    const commentInput = { versionId: version.id, body: '  The private citation needs evidence.\n', docxPassage: { rangeId: range.id, start: 4, end: 12, quote: 'original' } };
    const intent = join(directory, 'comment.json'); await writeFile(intent, JSON.stringify(commentInput));
    const args = ['comment-docx', id, '--intent', intent, '--request-id', 'exact-comment', '--server', url];
    const first = await cli(args, writer.token); assert.equal(first.code, 0, first.stderr); assert.ok(!first.stdout.includes(commentInput.body) && !first.stderr.includes(commentInput.body));
    const receipt = JSON.parse(first.stdout) as { threadId: string; commentId: string };
    const retry = await cli(args, writer.token); assert.equal(retry.code, 0, retry.stderr); assert.deepEqual(JSON.parse(retry.stdout), JSON.parse(first.stdout));
    await request<ReviewComment>(`/revisions/${id}/threads/${receipt.threadId}/replies`, { body: 'A full reply retained in the exported comment.', viewedVersionId: version.id });
    const detail = await request<RevisionDetail>(`/revisions/${id}`), thread = detail.threads.find(item => item.id === receipt.threadId)!;
    assert.equal(detail.comments.find(item => item.id === receipt.commentId)!.body, commentInput.body);
    const exportIntent = join(directory, 'export.json'), output = join(directory, 'reviewed.docx');
    const exportInput = { versionId: version.id, contentHash: version.contentHash, expectedAccessEpoch: app.policies.epoch(), threads: [{ threadId: thread.id, expectedThreadVersion: thread.version }] };
    await writeFile(exportIntent, JSON.stringify(exportInput));
    const exportArgs = ['export-docx-discussion', id, '--intent', exportIntent, '--output', output, '--server', url];
    const exported = await cli(exportArgs, reader.token); assert.equal(exported.code, 0, exported.stderr);
    const bytes = await readFile(output), metadata = JSON.parse(exported.stdout); assert.equal(metadata.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(metadata.bytes, bytes.length); assert.equal((await stat(output)).mode & 0o777, 0o600);
    const projection = await inspectDocx(bytes); assert.equal(projection.comments.length, version.docx!.projection.comments.length + 1);
    const bodies = projection.comments.flatMap(comment => comment.blocks.map(block => block.text)).join('\n'); assert.ok(bodies.includes(commentInput.body)); assert.ok(bodies.includes('A full reply retained')); assert.ok(bodies.includes('CLI Writer')); assert.ok(bodies.includes(receipt.threadId));
    assert.deepEqual(Buffer.from(store.docxBytes(id, version.id)), source); assert.deepEqual((await request<RevisionDetail>(`/revisions/${id}`)).versions, original.versions);
    assert.notEqual((await cli(exportArgs, reader.token)).code, 0); assert.deepEqual(await readFile(output), bytes);
    const linked = join(directory, 'linked.docx'); await symlink(output, linked); assert.notEqual((await cli(exportArgs.map(value => value === output ? linked : value), reader.token)).code, 0); assert.deepEqual(await readFile(output), bytes);
    await request(`/revisions/${id}/threads/${receipt.threadId}/replies`, { body: 'Concurrent new reply', viewedVersionId: version.id });
    const stalePath = join(directory, 'stale.docx'); const stale = await cli(exportArgs.map(value => value === output ? stalePath : value), reader.token); assert.notEqual(stale.code, 0); await assert.rejects(stat(stalePath));
    const noWrite = await cli(args.map(value => value === 'exact-comment' ? 'reader-comment' : value), reader.token); assert.notEqual(noWrite.code, 0);
    assert.ok((await readdir(directory)).every(name => !name.startsWith('.phabricator-word-')));
  } finally { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Word discussion CLI rejects malformed requests, duplicate options and symlinked intent files before sending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-word-invalid-')), intent = join(directory, 'intent.json'); let calls = 0;
  const request: PaperCLI['request'] = async <T>() => { calls++; return {} as T; };
  const run = (optionNames = ['intent', 'output']) => docxDiscussionCommand({ command: 'export-docx-discussion', args: ['L1'], options: { intent, output: join(directory, 'out.docx') }, optionNames, request, download: async () => new Uint8Array() });
  try {
    const base = { versionId: 'version', contentHash: 'a'.repeat(64), expectedAccessEpoch: 1, threads: [{ threadId: 'thread', expectedThreadVersion: 1 }] };
    for (const bad of [{ ...base, threads: [] }, { ...base, threads: [base.threads[0], base.threads[0]] }, { ...base, threads: [{ threadId: 'thread', expectedThreadVersion: 0 }] }, { ...base, expectedAccessEpoch: -1 }, { ...base, extra: 'ignored?' }]) { await writeFile(intent, JSON.stringify(bad)); await assert.rejects(run()); }
    await writeFile(intent, JSON.stringify(base)); await assert.rejects(run(['intent', 'intent', 'output']));
    const link = join(directory, 'link.json'); await symlink(intent, link); await assert.rejects(docxDiscussionCommand({ command: 'export-docx-discussion', args: ['L1'], options: { intent: link, output: 'new.docx' }, optionNames: ['intent', 'output'], request, download: async () => new Uint8Array() }));
    assert.equal(calls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
