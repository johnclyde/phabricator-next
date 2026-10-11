import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
import { revisionAuthorInput, type RevisionAuthorshipSnapshot, type RevisionAuthorInput } from '../shared/revision-authorship.ts';
import { revisionAuthorshipCommand } from '../cli/revision-authorship.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';

const executable = fileURLToPath(new URL('../cli/index.ts', import.meta.url)), loader = import.meta.resolve('tsx');
function cli(args: string[], token: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, executable, ...args], { env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
for (const basePath of ['/', '/review/']) test(`author CLI reads, transfers and confirms exact private handoffs at ${basePath}`, async () => {
  const store = createStore({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = await provision.createAccount({ username: 'writer', displayName: 'Original writer', password: 'Strong author fixture password' });
  const bob = await provision.createAccount({ username: 'editor', displayName: 'Next writer', password: 'Strong second author password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath }), directory = await mkdtemp(join(tmpdir(), 'revision-author-cli-'));
  try {
    const writer = app.auth.createToken(alice.id, { name: 'Writer', scopes: ['read', 'write'] }), reader = app.auth.createToken(alice.id, { name: 'Reader', scopes: ['read'] }), recipient = app.auth.createToken(bob.id, { name: 'Recipient', scopes: ['read', 'write'] });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath}`;
    const response = await fetch(new URL('api/revisions', url), { method: 'POST', headers: { Authorization: `Bearer ${writer.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ testPlan: 'Fixture verification plan.', kind: 'paper', title: 'Private draft', files: [{ path: 'draft.txt', content: 'Private immutable prose.\n' }] }) });
    assert.equal(response.status, 201); const detail = await response.json() as RevisionDetail, id = detail.revision.id;
    const policy = app.policies.policy(id, alice.id), onlyBob = { kind: 'principals' as const, principalIds: [bob.id] };
    app.policies.setPolicy(id, { expectedVersion: policy.version, spaceId: policy.spaceId, view: onlyBob, edit: onlyBob, interact: onlyBob }, alice.id);
    const read = await cli(['revision-author', id, '--server', url], reader.token); assert.equal(read.code, 0, read.stderr);
    const snapshot = JSON.parse(read.stdout) as RevisionAuthorshipSnapshot; assert.equal(snapshot.authorship.author?.principalId, alice.id); assert.equal(snapshot.access.capabilities.interact, false);
    const input: RevisionAuthorInput = revisionAuthorInput({ action: 'assign', authorId: bob.id, expectedAuthorVersion: snapshot.authorship.version, expectedReviewerVersion: snapshot.reviewerVersion, expectedLifecycleVersion: snapshot.lifecycleVersion, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedAccessEpoch: snapshot.accessEpoch, message: 'Continue this manuscript.' });
    const intent = join(directory, 'transfer.json'); await writeFile(intent, JSON.stringify(input));
    const args = ['edit-revision-author', id, '--intent', intent, '--request-id', 'exact-cli-handoff', '--server', url];
    assert.notEqual((await cli(args, reader.token)).code, 0);
    const first = await cli(args, writer.token); assert.equal(first.code, 0, first.stderr); const ack = JSON.parse(first.stdout); assert.equal(ack.accessLost, true); assert.equal(ack.saved, true); assert.equal(ack.inputSha256, createHash('sha256').update(JSON.stringify(input)).digest('hex')); assert.doesNotMatch(first.stdout, /Private immutable|Original writer|Next writer|Continue this/);
    const retry = await cli(args, writer.token); assert.equal(retry.code, 0, retry.stderr); assert.deepEqual(JSON.parse(retry.stdout), ack);
    assert.notEqual((await cli(['revision-author', id, '--server', url], writer.token)).code, 0);
    const current = await cli(['revision-author', id, '--server', url], recipient.token); assert.equal(current.code, 0, current.stderr); const newSnapshot = JSON.parse(current.stdout) as RevisionAuthorshipSnapshot; assert.equal(newSnapshot.authorship.author?.principalId, bob.id); assert.equal(newSnapshot.authorship.originalAuthor?.principalId, alice.id); assert.equal(newSnapshot.authorship.version, 1);
    const history = await cli(['revision-author-history', id, '--author-version', '1', '--limit', '1', '--server', url], recipient.token); assert.equal(history.code, 0, history.stderr); assert.equal(JSON.parse(history.stdout).transactions.length, 1);
    assert.deepEqual(store.detail(id).versions, detail.versions); assert.equal(store.detail(id).revision.status, detail.revision.status);
    app.auth.revokeToken(alice.id, writer.record.id); assert.notEqual((await cli(args, writer.token)).code, 0);
  } finally { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('author CLI rejects ambiguous options and forged operation acknowledgments before printing', async () => {
  let calls = 0; const request: PaperCLI['request'] = async <T>() => { calls++; return {} as T; };
  const run = (command: string, options: Record<string, string>, optionNames = Object.keys(options)) => revisionAuthorshipCommand({ command, args: ['P1'], options, optionNames, request, download: async () => new Uint8Array() });
  for (const [command, options, names] of [['revision-author', { limit: '1' }, ['limit']], ['revision-author-history', { limit: '1' }, ['limit', 'limit']], ['revision-author-history', { 'author-version': '-1' }, ['author-version']], ['edit-revision-author', {}, []]] as const) await assert.rejects(run(command, options, [...names]));
  assert.equal(calls, 0); await assert.rejects(run('revision-author', {}), /does not match/);
  const directory = await mkdtemp(join(tmpdir(), 'author-receipt-'));
  try {
    const input = revisionAuthorInput({ action: 'commandeer', expectedAuthorVersion: 0, expectedVersion: 1, expectedVersionId: 'head', expectedContentHash: 'a'.repeat(64), expectedAccessEpoch: 1, message: '' });
    const intent = join(directory, 'request.json'); await writeFile(intent, JSON.stringify(input));
    const error = console.error; console.error = () => {};
    try { await assert.rejects(revisionAuthorshipCommand({ command: 'edit-revision-author', args: ['P1'], options: { intent, 'request-id': 'explicit' }, optionNames: ['intent', 'request-id'], request: async <T>() => ({ revisionId: 'P1', operationId: 'operation', inputSha256: '0'.repeat(64), saved: true, accessLost: true, accessEpoch: 2 }) as T, download: async () => new Uint8Array() }), /does not match/); }
    finally { console.error = error; }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
