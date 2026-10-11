import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createStore } from '../server/store.ts';
import { createAuth } from '../server/auth.ts';
import { createApp } from '../server/app.ts';
import { revisionReviewerInput, type RevisionReviewerSnapshot } from '../shared/revision-reviewers.ts';
import { revisionReviewersCommand } from '../cli/revision-reviewers.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';

const executable = fileURLToPath(new URL('../cli/index.ts', import.meta.url)), loader = import.meta.resolve('tsx');
function cli(args: string[], token: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, executable, ...args], { env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
function action(snapshot: RevisionReviewerSnapshot) {
  return revisionReviewerInput({ action: 'accept', message: '  Exact CLI judgment\n', expectedReviewerVersion: snapshot.reviewers.version, expectedLifecycleVersion: snapshot.lifecycle.version, expectedAuthorVersion: snapshot.authorship.version, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedAccessEpoch: snapshot.accessEpoch, expectedConfigId: snapshot.configId, expectedEvidenceSha256: snapshot.evidence.sha256 });
}

for (const basePath of ['/', '/review/']) test(`reviewer CLI preserves exact human decisions and historical retries at ${basePath}`, async () => {
  const store = createStore({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const author = await provision.createAccount({ username: 'author', displayName: 'Author', password: 'Strong CLI author password' }), reviewer = await provision.createAccount({ username: 'reviewer', displayName: 'Reviewer', password: 'Strong CLI reviewer password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath }), directory = await mkdtemp(join(tmpdir(), 'revision-reviewers-cli-'));
  try {
    const writer = app.auth.createToken(reviewer.id, { name: 'Reviewer', scopes: ['read', 'write'] }), reader = app.auth.createToken(reviewer.id, { name: 'Read only', scopes: ['read'] });
    const detail = store.createRevision({ kind: 'paper', title: 'CLI reviewer source', files: [{ path: 'draft.txt', content: 'Private exact prose\n' }] }, { principalId: author.id, displayName: author.displayName, credentialId: null, requestId: 'cli-fixture' }), id = detail.revision.id;
    const policy = app.policies.policy(id, author.id); app.policies.setPolicy(id, { expectedVersion: policy.version, spaceId: policy.spaceId, view: { kind: 'workspace' }, edit: { kind: 'principals', principalIds: [author.id] }, interact: { kind: 'workspace' } }, author.id);
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath}`;
    const read = await cli(['revision-reviewers', id, '--server', url], reader.token); assert.equal(read.code, 0, read.stderr); const snapshot = JSON.parse(read.stdout) as RevisionReviewerSnapshot; assert.equal(snapshot.access.capabilities.edit, false);
    const input = action(snapshot), intent = join(directory, 'decision.json'); await writeFile(intent, JSON.stringify(input));
    const args = ['edit-revision-reviewers', id, '--intent', intent, '--request-id', 'exact-cli-review', '--server', url];
    assert.notEqual((await cli(args, reader.token)).code, 0);
    const first = await cli(args, writer.token); assert.equal(first.code, 0, first.stderr); const receipt = JSON.parse(first.stdout); assert.equal(receipt.transaction.toStatus, 'accepted'); assert.equal(receipt.transaction.message, input.message); assert.equal(receipt.transaction.head.versionId, detail.versions[0]!.id);
    const retry = await cli(args, writer.token); assert.equal(retry.code, 0, retry.stderr); assert.deepEqual(JSON.parse(retry.stdout), receipt);
    const metadata = first.stderr.split('\n').find(line => line.includes('inputSha256')); assert.ok(metadata); assert.equal(first.stderr.includes('Private exact prose'), false); assert.equal(first.stderr.includes(input.message), false);
    store.createVersion(id, { expectedVersion: 1, files: [{ path: 'draft.txt', content: 'New exact prose\n' }], message: 'Later source' });
    const historical = await cli(args, writer.token); assert.equal(historical.code, 0, historical.stderr); assert.deepEqual(JSON.parse(historical.stdout).transaction, receipt.transaction);
    assert.notEqual((await cli([...args.slice(0, 5), 'new-stale-review', '--server', url], writer.token)).code, 0);
    const history = await cli(['revision-reviewer-history', id, '--limit', '1', '--server', url], reader.token); assert.equal(history.code, 0, history.stderr); assert.equal(JSON.parse(history.stdout).transactions.length, 1);
    const current = app.policies.policy(id, author.id); app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, interact: { kind: 'principals', principalIds: [author.id] } }, author.id);
    assert.notEqual((await cli(args, writer.token)).code, 0);
  } finally { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('reviewer CLI rejects ambiguous options and unsafe intent files before sending any request', async () => {
  let calls = 0; const request: PaperCLI['request'] = async <T>() => { calls++; return {} as T; };
  const run = (command: string, options: Record<string, string>, optionNames = Object.keys(options)) => revisionReviewersCommand({ command, args: ['P1'], options, optionNames, request, download: async () => new Uint8Array() });
  for (const [command, options, names] of [['revision-reviewers', { limit: '1' }, ['limit']], ['revision-reviewer-history', { limit: '1' }, ['limit', 'limit']], ['revision-reviewer-history', { 'reviewer-version': '-1' }, ['reviewer-version']], ['edit-revision-reviewers', {}, []]] as const) await assert.rejects(run(command, options, [...names]));
  const directory = await mkdtemp(join(tmpdir(), 'reviewer-intents-'));
  try {
    const invalid = join(directory, 'extra.json'); await writeFile(invalid, JSON.stringify({ action: 'accept', extra: true })); await assert.rejects(run('edit-revision-reviewers', { intent: invalid }));
    const link = join(directory, 'link.json'); await symlink(invalid, link); await assert.rejects(run('edit-revision-reviewers', { intent: link }));
    assert.equal(calls, 0); await assert.rejects(run('revision-reviewers', {}), /does not match/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('reviewer mutation CLI never refreshes an exact intent and rejects a forged canonical receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reviewer-recovery-')); const previousOut = console.log, previousError = console.error; const output: unknown[] = [], recovery: string[] = []; const calls: unknown[][] = [];
  try {
    console.log = value => { output.push(value); }; console.error = value => { recovery.push(String(value)); };
    const input = revisionReviewerInput({ action: 'accept', message: 'Private reasoning\n', expectedReviewerVersion: 4, expectedLifecycleVersion: 5, expectedAuthorVersion: 2, expectedVersion: 3, expectedVersionId: 'immutable-v3', expectedContentHash: 'a'.repeat(64), expectedAccessEpoch: 7, expectedConfigId: 'b'.repeat(64), expectedEvidenceSha256: 'c'.repeat(64) });
    const intent = join(directory, 'exact.json'); await writeFile(intent, JSON.stringify(input));
    const request: PaperCLI['request'] = async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); throw new Error('Connection closed after write'); };
    const parameters: PaperCLI = { command: 'edit-revision-reviewers', args: ['P1'], options: { intent, 'request-id': 'original-review' }, optionNames: ['intent', 'request-id'], request, download: async () => new Uint8Array() };
    await assert.rejects(revisionReviewersCommand(parameters), /Connection closed/); await assert.rejects(revisionReviewersCommand(parameters), /Connection closed/);
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ['/api/revisions/P1/reviewers', 'POST', input, 'original-review'])); assert.equal(output.length, 0);
    const record = JSON.parse(recovery[0]!); assert.equal(record.inputSha256, createHash('sha256').update(JSON.stringify(input)).digest('hex')); assert.equal(recovery.some(value => value.includes('Private reasoning')), false);
    await assert.rejects(revisionReviewersCommand({ ...parameters, request: async <T>() => ({ revisionId: 'P1', saved: true }) as T }), /receipt does not match/);
  } finally { console.log = previousOut; console.error = previousError; await rm(directory, { recursive: true, force: true }); }
});
