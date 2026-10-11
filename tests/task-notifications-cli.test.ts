import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { createAuth } from '../server/auth.ts';
import { Store } from '../server/store.ts';
import { taskNotificationsCommand } from '../cli/task-notifications.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';
import type { TaskMuteSnapshot, TaskMuteHistory } from '../shared/task-notifications.ts';
import type { NotificationInbox } from '../shared/notifications.ts';

async function cli(args: string[], token: string) {
  const process = spawn(globalThis.process.execPath, ['--import', 'tsx', 'cli/index.ts', ...args], { cwd: globalThis.process.cwd(), env: { ...globalThis.process.env, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; process.stdout.on('data', data => { stdout += data; }); process.stderr.on('data', data => { stderr += data; });
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => { process.on('error', reject); process.on('exit', code => resolve({ code, stdout, stderr })); });
}
for (const basePath of ['/', '/mounted/']) test(`task notification CLI preserves private mute and generic exact read intentions at ${basePath}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'task-notification-cli-')), store = new Store({ path: ':memory:' }), provision = createAuth({ database: store.database, basePath, mode: 'local', provisioning: true });
  const author = await provision.createAccount({ username: 'author', displayName: 'Author', password: 'Task CLI author password' }), reader = await provision.createAccount({ username: 'reader', displayName: 'Reader', password: 'Task CLI reader password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath }), writer = app.auth.createToken(reader.id, { name: 'Write own preferences', scopes: ['read', 'write'] }), readOnly = app.auth.createToken(reader.id, { name: 'Read', scopes: ['read'] });
  const actor = { principalId: author.id, displayName: author.displayName, credentialId: null, requestId: 'cli-task' };
  try {
    const task = store.createTask({ title: 'CLI task', ownerId: reader.id }, actor);
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath}`;
    const get = await cli(['task-mute', task.id, '--server', url], readOnly.token); assert.equal(get.code, 0, get.stderr); const state = JSON.parse(get.stdout) as TaskMuteSnapshot;
    const intent = { action: 'mute', expectedMuteVersion: state.version, expectedAccessEpoch: state.accessEpoch }, file = join(directory, 'mute.json'); await writeFile(file, JSON.stringify(intent));
    const args = ['set-task-mute', task.id, '--intent', file, '--request-id', 'exact-task-mute', '--server', url]; assert.notEqual((await cli(args, readOnly.token)).code, 0);
    const saved = await cli(args, writer.token); assert.equal(saved.code, 0, saved.stderr); assert.equal(JSON.parse(saved.stdout).inputSha256, createHash('sha256').update(JSON.stringify(intent)).digest('hex'));
    const unread = store.notifications.summary(reader.id, app.policies.epoch()).unreadCount; store.createTaskComment(task.id, { body: 'Suppressed task content' }, actor); assert.equal(store.notifications.summary(reader.id, app.policies.epoch()).unreadCount, unread);
    const history = await cli(['task-mute-history', task.id, '--expected-mute-version', '1', '--limit', '1', '--server', url], readOnly.token); assert.equal(history.code, 0, history.stderr); assert.equal((JSON.parse(history.stdout) as TaskMuteHistory).entries[0]!.after, true);
    const now = store.taskNotifications.snapshot(task.id, reader.id); store.taskNotifications.mutate(task.id, reader.id, { action: 'unmute', expectedMuteVersion: now.version, expectedAccessEpoch: now.accessEpoch }, { principalId: reader.id, displayName: reader.displayName, credentialId: writer.record.id, requestId: 'unmute' }, null);
    const retry = await cli(args, writer.token); assert.equal(retry.code, 0, retry.stderr); assert.deepEqual(JSON.parse(retry.stdout), JSON.parse(saved.stdout)); assert.equal(store.taskNotifications.snapshot(task.id, reader.id).muted, false);
    store.createTaskComment(task.id, { body: 'Private CLI task body' }, actor);
    const listing = await cli(['notifications', '--filter', 'unread', '--server', url], readOnly.token); assert.equal(listing.code, 0, listing.stderr); const page = JSON.parse(listing.stdout) as NotificationInbox; assert.ok(page.items.every(item => item.object.kind === 'task')); assert.doesNotMatch(listing.stdout, /Suppressed task content|Private CLI task body/);
    await writeFile(file, JSON.stringify({ action: 'read_object', objectId: task.id, horizon: page.horizon, expectedAccessEpoch: page.accessEpoch }));
    const marked = await cli(['mark-notifications', '--intent', file, '--request-id', 'task-opening', '--server', url], writer.token); assert.equal(marked.code, 0, marked.stderr); assert.equal(store.notifications.summary(reader.id, app.policies.epoch()).unreadCount, 0);
  } finally { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('task mute CLI retains exact input after uncertain transport and rejects foreign receipts and malformed pagination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'task-mute-intent-')), file = join(directory, 'request.json'), calls: unknown[][] = [], output: string[] = [], recovery: string[] = [], oldOut = console.log, oldError = console.error;
  const input = { action: 'mute', expectedMuteVersion: 7, expectedAccessEpoch: 12 };
  try {
    console.log = value => { output.push(String(value)); }; console.error = value => { recovery.push(String(value)); }; await writeFile(file, JSON.stringify(input));
    const parameters: PaperCLI = { command: 'set-task-mute', args: ['T1'], options: { intent: file, 'request-id': 'same-exact-request' }, optionNames: ['intent', 'request-id'], download: async () => new Uint8Array(), request: async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); throw new Error('Response lost after save'); } };
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(taskNotificationsCommand(parameters), /Response lost/);
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ['/api/tasks/T1/mute', 'POST', input, 'same-exact-request'])); assert.equal(output.length, 0); assert.equal(JSON.parse(recovery[0]!).inputSha256, createHash('sha256').update(JSON.stringify(input)).digest('hex'));
    const receipt = { taskId: 'T2', operationId: randomUUID(), inputSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'), changed: true, accessEpoch: 12 };
    await assert.rejects(taskNotificationsCommand({ ...parameters, request: async <T>() => receipt as T }), /receipt does not match/);
    const link = join(directory, 'symlink'); await symlink(file, link); await assert.rejects(taskNotificationsCommand({ ...parameters, options: { intent: link }, optionNames: ['intent'] }));
    for (const [command, options, optionNames] of [['task-mute', { principal: 'another-person' }, ['principal']], ['task-mute-history', { before: '0' }, ['before']], ['task-mute-history', { limit: '101' }, ['limit']], ['task-mute-history', { limit: '1' }, ['limit', 'limit']], ['task-mute-history', { 'expected-mute-version': '-1' }, ['expected-mute-version']]] as const) await assert.rejects(taskNotificationsCommand({ ...parameters, command, options, optionNames: [...optionNames] }));
    assert.equal(calls.length, 2);
    const history: TaskMuteHistory = { taskId: 'T1', principalId: 'reader', version: 4, entries: [{ id: randomUUID(), taskId: 'T1', principalId: 'reader', version: 3, before: false, after: true, createdAt: '2026-10-11T00:00:00Z', attribution: { principalId: 'reader', displayName: 'Reader', credentialId: null, requestId: 'request' } }], nextBefore: null, accessEpoch: 12 };
    for (const options of [{ before: '3' }, { 'expected-mute-version': '3' }]) await assert.rejects(taskNotificationsCommand({ ...parameters, command: 'task-mute-history', options, optionNames: Object.keys(options), request: async <T>() => history as T }), /does not match/);
  } finally { console.log = oldOut; console.error = oldError; await rm(directory, { recursive: true, force: true }); }
});
