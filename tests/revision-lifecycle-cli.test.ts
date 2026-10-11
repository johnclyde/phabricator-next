import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createStore } from '../server/store.ts';
import { createAuth } from '../server/auth.ts';
import { createApp } from '../server/app.ts';
import type { RevisionDetail } from '../shared/types.ts';
import { revisionLifecycleInput, type RevisionLifecycleSnapshot } from '../shared/revision-lifecycle.ts';
import { revisionLifecycleCommand } from '../cli/revision-lifecycle.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';
const executable = fileURLToPath(new URL('../cli/index.ts', import.meta.url)), loader = import.meta.resolve('tsx');
function cli(args: string[], token: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, executable, ...args], { env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
for (const basePath of ['/', '/review/']) test(`lifecycle CLI acts on exact snapshots and retries immutable receipts at ${basePath}`, async () => {
  const store = createStore({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const account = await provision.createAccount({ username: 'writer', displayName: 'Writer', password: 'Strong lifecycle fixture password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath }), directory = await mkdtemp(join(tmpdir(), 'revision-lifecycle-cli-'));
  try {
    const writer = app.auth.createToken(account.id, { name: 'Writer', scopes: ['read', 'write'] }), reader = app.auth.createToken(account.id, { name: 'Reader', scopes: ['read'] });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath}`;
    const response = await fetch(new URL('api/revisions', url), { method: 'POST', headers: { Authorization: `Bearer ${writer.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ kind: 'paper', title: 'Exact lifecycle source', draft: true, files: [{ path: 'draft.txt', content: 'Immutable prose.\n' }] }) });
    assert.equal(response.status, 201); const detail = await response.json() as RevisionDetail, id = detail.revision.id;
    assert.equal(detail.revision.status, 'draft');
    const read = await cli(['revision-lifecycle', id, '--server', url], reader.token); assert.equal(read.code, 0, read.stderr);
    const snapshot = JSON.parse(read.stdout) as RevisionLifecycleSnapshot;
    const input = revisionLifecycleInput({ action: 'request_review', message: 'Ready for review', expectedLifecycleVersion: snapshot.lifecycle.version, expectedReviewerVersion: snapshot.reviewers.version, expectedAuthorVersion: snapshot.authorship.version, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedAccessEpoch: snapshot.accessEpoch, expectedConfigId: snapshot.configId, expectedEvidenceSha256: snapshot.evidence.sha256 });
    const intent = join(directory, 'action.json'); await writeFile(intent, JSON.stringify(input));
    const args = ['edit-revision-lifecycle', id, '--intent', intent, '--request-id', 'exact-cli-action', '--server', url];
    assert.notEqual((await cli(args, reader.token)).code, 0);
    const first = await cli(args, writer.token); assert.equal(first.code, 0, first.stderr); const receipt = JSON.parse(first.stdout); assert.equal(receipt.transaction.toStatus, 'needs_review');
    const retry = await cli(args, writer.token); assert.equal(retry.code, 0, retry.stderr); assert.deepEqual(JSON.parse(retry.stdout), receipt);
    const history = await cli(['revision-lifecycle-history', id, '--lifecycle-version', '1', '--limit', '1', '--server', url], reader.token); assert.equal(history.code, 0, history.stderr); assert.equal(JSON.parse(history.stdout).transactions.length, 1);
    assert.deepEqual(store.detail(id).versions, detail.versions);
    assert.notEqual((await cli(['edit-revision-lifecycle', id, '--intent', intent, '--request-id', 'new-stale-action', '--server', url], writer.token)).code, 0);
    app.auth.revokeToken(account.id, writer.record.id); assert.notEqual((await cli(args, writer.token)).code, 0);
  } finally { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
test('lifecycle CLI rejects ambiguous options, forged responses and extra intent fields', async () => {
  let calls = 0; const request: PaperCLI['request'] = async <T>() => { calls++; return {} as T; };
  const run = (command: string, options: Record<string, string>, optionNames = Object.keys(options)) => revisionLifecycleCommand({ command, args: ['P1'], options, optionNames, request, download: async () => new Uint8Array() });
  for (const [command, options, names] of [['revision-lifecycle', { limit: '1' }, ['limit']], ['revision-lifecycle-history', { limit: '1' }, ['limit', 'limit']], ['revision-lifecycle-history', { 'lifecycle-version': '-1' }, ['lifecycle-version']], ['edit-revision-lifecycle', {}, []]] as const) await assert.rejects(run(command, options, [...names]));
  assert.equal(calls, 0); await assert.rejects(run('revision-lifecycle', {}), /does not match/);
});
