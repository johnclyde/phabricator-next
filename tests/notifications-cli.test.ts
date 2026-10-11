import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Store } from '../server/store.ts';
import { createAuth } from '../server/auth.ts';
import { createApp } from '../server/app.ts';
import { notificationsCommand } from '../cli/notifications.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';
import { notificationReadInput, type NotificationInbox, type NotificationReceipt, type NotificationSummary } from '../shared/notifications.ts';

const executable = fileURLToPath(new URL('../cli/index.ts', import.meta.url)), loader = import.meta.resolve('tsx');
function cli(args: string[], token: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, executable, ...args], { env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (value: Buffer) => { stdout += value; }); child.stderr.on('data', (value: Buffer) => { stderr += value; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
for (const basePath of ['/', '/review/']) test(`notification CLI uses scoped inboxes and exact read recovery at ${basePath}`, async () => {
  const store = new Store({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const author = await provision.createAccount({ username: 'author', displayName: 'Author', password: 'Strong notification author password' }), reader = await provision.createAccount({ username: 'reader', displayName: 'Reader', password: 'Strong notification reader password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath }), directory = await mkdtemp(join(tmpdir(), 'notification-cli-'));
  try {
    const writer = app.auth.createToken(reader.id, { name: 'Preferences writer', scopes: ['read', 'write'] }), readOnly = app.auth.createToken(reader.id, { name: 'Read only', scopes: ['read'] });
    const actor = { principalId: author.id, displayName: author.displayName, credentialId: null, requestId: 'notification-cli-author' }, readerActor = { ...actor, principalId: reader.id, displayName: reader.displayName };
    const detail = store.createRevision({ kind: 'paper', title: 'Notification \u202e title', testPlan: 'Read source.', files: [{ path: 'paper.txt', content: 'Private paper body' }] }, actor), id = detail.revision.id;
    const policy = app.policies.policy(id, author.id); app.policies.setPolicy(id, { expectedVersion: policy.version, spaceId: policy.spaceId, view: { kind: 'workspace' }, edit: { kind: 'principals', principalIds: [author.id] }, interact: { kind: 'workspace' } }, author.id);
    const following = store.revisionSubscriptions.snapshot(id, reader.id); store.revisionSubscriptions.mutate(id, { action: 'subscribe', principalId: reader.id, expectedSubscriptionVersion: following.viewer.version, expectedAuthorVersion: following.authorVersion, expectedReviewerVersion: following.reviewerVersion, expectedAccessEpoch: app.policies.epoch() }, readerActor);
    store.createComment(id, { versionId: detail.versions[0]!.id, body: 'Private comment body' }, actor);
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath}`;
    const listing = await cli(['notifications', '--filter', 'unread', '--limit', '1', '--server', url], readOnly.token); assert.equal(listing.code, 0, listing.stderr); assert.equal(listing.stdout.includes('\u202e'), false); assert.doesNotMatch(listing.stdout, /Private paper|Private comment|credentialId/);
    const page = JSON.parse(listing.stdout) as NotificationInbox; assert.equal(page.principalId, reader.id); assert.equal(page.items.length, 1);
    const counts = await cli(['notification-count', '--server', url], readOnly.token); assert.equal(counts.code, 0, counts.stderr); assert.equal((JSON.parse(counts.stdout) as NotificationSummary).unreadCount, 1);
    const input = notificationReadInput({ action: 'read', notificationId: page.items[0]!.id, expectedVersion: page.items[0]!.version, expectedAccessEpoch: page.accessEpoch }), path = join(directory, 'read.json'); await writeFile(path, JSON.stringify(input));
    const args = ['mark-notifications', '--intent', path, '--request-id', 'exact-cli-read', '--server', url]; assert.notEqual((await cli(args, readOnly.token)).code, 0);
    const saved = await cli(args, writer.token); assert.equal(saved.code, 0, saved.stderr); const receipt = JSON.parse(saved.stdout) as NotificationReceipt; assert.equal(receipt.inputSha256, createHash('sha256').update(JSON.stringify(input)).digest('hex')); assert.equal(saved.stderr.includes(page.items[0]!.id), false);
    const current = store.notifications.list(reader.id, {}, app.policies.epoch()).items[0]!; store.notifications.mutate(reader.id, { action: 'unread', notificationId: current.id, expectedVersion: current.version, expectedAccessEpoch: app.policies.epoch() }, readerActor);
    const retry = await cli(args, writer.token); assert.equal(retry.code, 0, retry.stderr); assert.deepEqual(JSON.parse(retry.stdout), receipt); assert.equal(store.notifications.summary(reader.id, app.policies.epoch()).unreadCount, 1);
    const through = store.notifications.summary(reader.id, app.policies.epoch()); await writeFile(path, JSON.stringify({ action: 'read_through', horizon: through.horizon, expectedAccessEpoch: through.accessEpoch }));
    store.createComment(id, { versionId: detail.versions[0]!.id, body: 'Later arrival' }, actor);
    assert.equal((await cli(['mark-notifications', '--intent', path, '--request-id', 'read-observed', '--server', url], writer.token)).code, 0); assert.equal(store.notifications.summary(reader.id, app.policies.epoch()).unreadCount, 1);
    const p = app.policies.policy(id, author.id); app.policies.setPolicy(id, { expectedVersion: p.version, spaceId: p.spaceId, ...p.rules, view: { kind: 'principals', principalIds: [author.id] } }, author.id);
    await writeFile(path, JSON.stringify(input)); assert.notEqual((await cli(args, writer.token)).code, 0); const hidden = await cli(['notification-count', '--server', url], readOnly.token); assert.equal(hidden.code, 0); assert.equal(JSON.parse(hidden.stdout).unreadCount, 0);
  } finally { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('notification CLI preserves uncertain exact intentions, validates receipts, and rejects unsafe or ambiguous input before transport', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notification-intent-')), file = join(directory, 'read.json'), calls: unknown[][] = [], output: string[] = [], recovery: string[] = [], oldOut = console.log, oldError = console.error;
  try {
    console.log = value => { output.push(String(value)); }; console.error = value => { recovery.push(String(value)); };
    const input = notificationReadInput({ action: 'read_object', revisionId: 'P1', horizon: 'h'.repeat(720), expectedAccessEpoch: 4 }); assert.equal(input.action, 'read_object'); assert.ok('horizon' in input); await writeFile(file, JSON.stringify(input));
    const parameters: PaperCLI = { command: 'mark-notifications', args: [], options: { intent: file, 'request-id': 'uncertain-read' }, optionNames: ['intent', 'request-id'], download: async () => new Uint8Array(), request: async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); throw new Error('Response lost after save'); } };
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(notificationsCommand(parameters), /Response lost/);
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ['/api/notifications/read', 'POST', input, 'uncertain-read'])); assert.equal(output.length, 0); assert.equal(recovery[0]!.includes(input.horizon), false); assert.equal(JSON.parse(recovery[0]!).inputSha256, createHash('sha256').update(JSON.stringify(input)).digest('hex'));
    const receipt = { operationId: randomUUID(), inputSha256: 'a'.repeat(64), changed: true, accessEpoch: 4 };
    await assert.rejects(notificationsCommand({ ...parameters, request: async <T>() => receipt as T }), /receipt does not match/);
    const link = join(directory, 'link.json'); await symlink(file, link); await assert.rejects(notificationsCommand({ ...parameters, options: { intent: link }, optionNames: ['intent'] }));
    for (const [command, options, optionNames, args] of [['notifications', { filter: 'unknown' }, ['filter'], []], ['notifications', { limit: '101' }, ['limit'], []], ['notifications', { limit: '1' }, ['limit', 'limit'], []], ['notifications', { before: 'invalid' }, ['before'], []], ['notification-count', { limit: '1' }, ['limit'], []], ['notifications', {}, [], ['another-person']]] as const) await assert.rejects(notificationsCommand({ ...parameters, command, options, optionNames: [...optionNames], args: [...args] }));
    assert.equal(calls.length, 2, 'no validation failure fetches new state or posts');
  } finally { console.log = oldOut; console.error = oldError; await rm(directory, { recursive: true, force: true }); }
});

test('notification CLI rejects structurally valid pages with the wrong read filter or repeated cursor', async () => {
  const old = console.log; console.log = () => {};
  const token = 'b'.repeat(720), event = { id: randomUUID(), revisionId: 'P1', kind: 'commented' as const, cause: { type: 'comment', id: randomUUID() }, actor: null, createdAt: '2026-10-11T00:00:00.000Z', head: null };
  const page: NotificationInbox = { principalId: 'reader', items: [{ id: randomUUID(), event, revision: { id: 'P1', title: 'Source', kind: 'paper' }, read: true, version: 1 }], nextBefore: token, horizon: token, unreadCount: 0, readVersion: 1, accessEpoch: 2 };
  const request = async <T>() => page as T;
  try {
    await assert.rejects(notificationsCommand({ command: 'notifications', args: [], options: { filter: 'unread' }, optionNames: ['filter'], download: async () => new Uint8Array(), request }), /does not match/);
    await assert.rejects(notificationsCommand({ command: 'notifications', args: [], options: { before: token }, optionNames: ['before'], download: async () => new Uint8Array(), request }), /does not match/);
  } finally { console.log = old; }
});
