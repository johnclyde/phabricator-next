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
import { objectSubscriptionInput, type ObjectSubscriptionInput, type ObjectSubscriptionSnapshot, type ObjectSubscriptionHistory, type ObjectMuteHistory } from '../shared/object-subscriptions.ts';
import { objectSubscriptionsCommand } from '../cli/object-subscriptions.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';

const executable = fileURLToPath(new URL('../cli/index.ts', import.meta.url)), loader = import.meta.resolve('tsx');
function cli(args: string[], token: string, cwd?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, executable, ...args], { cwd, env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
function action(snapshot: ObjectSubscriptionSnapshot, action: ObjectSubscriptionInput['action'] = 'subscribe') {
  return objectSubscriptionInput({ action, principalId: snapshot.viewer.principalId, expectedAccessEpoch: snapshot.accessEpoch, ...(['mute', 'unmute'].includes(action) ? { expectedMuteVersion: snapshot.mute.version } : { expectedSubscriptionVersion: snapshot.viewer.version }) });
}
for (const basePath of ['/', '/review/']) test(`following CLI preserves exact requests and private mute at ${basePath}`, async () => {
  const store = createStore({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const author = await provision.createAccount({ username: 'author', displayName: 'Author', password: 'Strong CLI author password' }), follower = await provision.createAccount({ username: 'follower', displayName: 'Follower', password: 'Strong CLI follower password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath }), directory = await mkdtemp(join(tmpdir(), 'revision-following-cli-'));
  try {
    const writer = app.auth.createToken(follower.id, { name: 'Follower', scopes: ['read', 'write'] }), reader = app.auth.createToken(follower.id, { name: 'Read only', scopes: ['read'] });
    const document = store.createDocument({ slug: '/', title: 'CLI following source', content: 'Private exact prose\n' }, { principalId: author.id, displayName: author.displayName, credentialId: null, requestId: 'cli-fixture' }), id = document.id;
    const policy = app.policies.policy(id, author.id); app.policies.setPolicy(id, { expectedVersion: policy.version, spaceId: policy.spaceId, view: { kind: 'workspace' }, edit: { kind: 'principals', principalIds: [author.id] }, interact: { kind: 'principals', principalIds: [author.id] } }, author.id);
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath}`;
    const read = await cli(['object-subscriptions', id, '--server', url], reader.token); assert.equal(read.code, 0, read.stderr); const snapshot = JSON.parse(read.stdout) as ObjectSubscriptionSnapshot; assert.equal(snapshot.access.capabilities.interact, false); assert.equal(snapshot.access.capabilities.edit, false);
    const input = action(snapshot), intent = join(directory, 'follow.json'); await writeFile(intent, JSON.stringify(input)); const args = ['edit-object-subscriptions', id, '--intent', intent, '--request-id', 'original-cli-follow', '--server', url];
    assert.notEqual((await cli(args, reader.token)).code, 0); const saved = await cli(args, writer.token); assert.equal(saved.code, 0, saved.stderr); const receipt = JSON.parse(saved.stdout); assert.equal(receipt.kind, 'subscription'); assert.equal(receipt.status.following, true); assert.equal(saved.stderr.includes('Private exact prose'), false);
    store.updateDocument(id, { expectedVersion: 1, slug: document.slug, title: 'CLI following source', content: 'Later source\n' });
    const replay = await cli(args, writer.token); assert.equal(replay.code, 0, replay.stderr); assert.deepEqual(JSON.parse(replay.stdout).transaction, receipt.transaction);
    const inspected = await cli(['object-subscription-status', id, '--principal', follower.id, '--server', url], reader.token); assert.equal(inspected.code, 0, inspected.stderr); assert.equal(JSON.parse(inspected.stdout).status.version, 1); assert.equal('mute' in JSON.parse(inspected.stdout), false);
    const current = JSON.parse((await cli(['object-subscriptions', id, '--server', url], reader.token)).stdout) as ObjectSubscriptionSnapshot;
    await writeFile(intent, JSON.stringify(action(current, 'mute'))); const muted = await cli(['edit-object-subscriptions', id, '--intent', intent, '--request-id', 'private-cli-mute', '--server', url], writer.token); assert.equal(muted.code, 0, muted.stderr); assert.equal(JSON.parse(muted.stdout).mute.muted, true);
    const publicHistory = await cli(['object-subscription-history', id, '--subscription-version', '1', '--limit', '1', '--server', url], reader.token), privateHistory = await cli(['object-mute-history', id, '--mute-version', '1', '--limit', '1', '--server', url], reader.token); assert.equal(publicHistory.code, 0, publicHistory.stderr); assert.equal(privateHistory.code, 0, privateHistory.stderr); assert.equal(JSON.parse(publicHistory.stdout).transactions.length, 1); assert.equal(JSON.parse(privateHistory.stdout).principalId, follower.id);
    const now = app.policies.policy(id, author.id); app.policies.setPolicy(id, { expectedVersion: now.version, spaceId: now.spaceId, ...now.rules, view: { kind: 'principals', principalIds: [author.id] } }, author.id); assert.notEqual((await cli(['object-mute-history', id, '--server', url], reader.token)).code, 0);
    await writeFile(intent, JSON.stringify(input)); assert.notEqual((await cli(args, writer.token)).code, 0);
  } finally { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('following CLI rejects unknown or duplicate options and unsafe intent files before transport', async () => {
  let calls = 0; const request: PaperCLI['request'] = async <T>() => { calls++; return {} as T; };
  const run = (command: string, options: Record<string, string>, optionNames = Object.keys(options)) => objectSubscriptionsCommand({ command, args: ['W1'], options, optionNames, request, download: async () => new Uint8Array() });
  for (const [command, options, names] of [['object-subscriptions', { principal: 'someone' }, ['principal']], ['object-mute-history', { principal: 'someone' }, ['principal']], ['object-subscription-history', { limit: '1' }, ['limit', 'limit']], ['object-subscription-history', { 'subscription-version': '-1' }, ['subscription-version']], ['object-subscription-status', {}, []], ['edit-object-subscriptions', {}, []]] as const) await assert.rejects(run(command, options, [...names]));
  const directory = await mkdtemp(join(tmpdir(), 'subscription-intents-'));
  try { const invalid = join(directory, 'extra.json'); await writeFile(invalid, JSON.stringify({ action: 'subscribe', extra: true })); await assert.rejects(run('edit-object-subscriptions', { intent: invalid })); const link = join(directory, 'link.json'); await symlink(invalid, link); await assert.rejects(run('edit-object-subscriptions', { intent: link })); assert.equal(calls, 0); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test('uncertain following CLI requests retain exact people, counters, digest and request ID without a refresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'subscription-recovery-')), path = join(directory, 'request.json'), oldOut = console.log, oldError = console.error; const output: unknown[] = [], recovery: string[] = [], calls: unknown[][] = [];
  try {
    console.log = value => { output.push(value); }; console.error = value => { recovery.push(String(value)); };
    const input = objectSubscriptionInput({ action: 'subscribe', principalId: 'human-follower', expectedSubscriptionVersion: 4, expectedAccessEpoch: 9 }); await writeFile(path, JSON.stringify(input));
    const parameters: PaperCLI = { command: 'edit-object-subscriptions', args: ['W1'], options: { intent: path, 'request-id': 'uncertain-follow' }, optionNames: ['intent', 'request-id'], download: async () => new Uint8Array(), request: async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); throw new Error('Connection closed after save'); } };
    await assert.rejects(objectSubscriptionsCommand(parameters), /Connection closed/); await assert.rejects(objectSubscriptionsCommand(parameters), /Connection closed/);
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ['/api/objects/W1/subscriptions', 'POST', input, 'uncertain-follow'])); assert.equal(output.length, 0); assert.equal(JSON.parse(recovery[0]!).inputSha256, createHash('sha256').update(JSON.stringify(input)).digest('hex')); assert.equal(recovery[0]!.includes('human-follower'), false);
    await assert.rejects(objectSubscriptionsCommand({ ...parameters, request: async <T>() => ({ objectId: 'W1', saved: true }) as T }), /receipt does not match/);
  } finally { console.log = oldOut; console.error = oldError; await rm(directory, { recursive: true, force: true }); }
});

test('following CLI rejects well-shaped pages with the wrong requested cursor or snapshot pin', async () => {
  const old = console.log; console.log = () => {};
  const attribution = { principalId: 'actor', displayName: 'Actor', credentialId: null, requestId: 'request' }, now = '2026-10-11T00:00:00.000Z';
  const transaction = { id: 'f973eea8-26ad-407c-8c75-b58c700a5157', objectId: 'W1', operationId: '62056d88-a16b-4229-afb0-1a120d9b057f', subscriptionVersion: 3, principalId: 'follower', displayName: 'Follower', version: 1, before: null, after: 'subscribed' as const, reason: 'explicit' as const, commentId: null, attribution, createdAt: now };
  const history: ObjectSubscriptionHistory = { objectId: 'W1', subscriptionVersion: 3, transactions: [transaction], nextBefore: null, accessEpoch: 1 };
  const mute: ObjectMuteHistory = { objectId: 'W1', principalId: 'actor', muteVersion: 3, transactions: [{ id: '5e20883c-3bcd-48fa-88f3-b54f66340a32', objectId: 'W1', operationId: '62056d88-a16b-4229-afb0-1a120d9b057f', principalId: 'actor', version: 3, before: false, after: true, attribution, createdAt: now }], nextBefore: null, accessEpoch: 1 };
  const viewer = { objectId: 'W1', principalId: 'actor', displayName: null, version: 0, state: null, automatic: [], following: false, updatedAt: null };
  const snapshot: ObjectSubscriptionSnapshot = { objectId: 'W1', subscriptionVersion: 3, subscribers: [{ ...viewer, principalId: 'follower', displayName: 'Follower', version: 1, state: 'subscribed', following: true, updatedAt: now }], viewer, mute: { objectId: 'W1', principalId: 'actor', version: 0, muted: false, updatedAt: null }, nextAfter: null, accessEpoch: 1, access: { policy: { objectId: 'W1', spaceId: 'S1', version: 1, rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: '', editLabel: '', interactLabel: '' } };
  const run = (command: string, options: Record<string, string>, result: unknown) => objectSubscriptionsCommand({ command, args: ['W1'], options, optionNames: Object.keys(options), download: async () => new Uint8Array(), request: async <T>() => result as T });
  try {
    await assert.rejects(run('object-subscription-history', { before: '3' }, history), /history cursor/);
    await assert.rejects(run('object-mute-history', { before: '3' }, mute), /history cursor/);
    await assert.rejects(run('object-subscriptions', { after: 'follower' }, snapshot), /subscriber cursor/);
    await assert.rejects(run('object-subscriptions', { 'subscription-version': '2' }, snapshot), /different inspected version/);
    await assert.rejects(run('object-subscription-status', { principal: 'other' }, { status: viewer, accessEpoch: 1 }), /does not match/);
  } finally { console.log = old; }
});
