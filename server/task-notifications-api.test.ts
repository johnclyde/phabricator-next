import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import type { Task, TaskDetail, TaskSubscriptionStatus } from '../shared/types.ts';
import type { NotificationInbox, NotificationReceipt, NotificationSummary } from '../shared/notifications.ts';
import type { TaskMuteSnapshot, TaskMuteReceipt, TaskMuteHistory } from '../shared/task-notifications.ts';

const workspace = { kind: 'workspace' as const }, people = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
async function start(basePath = '/') {
  const store = new Store({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice task notification password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob task notification password' });
  const carol = await provision.createAccount({ username: 'carol', displayName: 'Carol', password: 'Carol task notification password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Editor', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Preferences', scopes: ['read', 'write'] }), carol: app.auth.createToken(carol.id, { name: 'Other reader', scopes: ['read', 'write'] }), read: app.auth.createToken(bob.id, { name: 'Read only', scopes: ['read'] }) };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath.replace(/\/$/, '')}`;
  async function request<T = { error: string; code?: string }>(path: string, method = 'GET', body?: unknown, who: keyof typeof tokens = 'bob', key?: string) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${tokens[who].token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  }
  const policy = (id: string, rules: Record<string, unknown>) => { const p = app.policies.policy(id, alice.id); app.policies.setPolicy(id, { expectedVersion: p.version, spaceId: p.spaceId, ...p.rules, ...rules }, alice.id); };
  const task = async (extra = {}) => { const result = await request<Task>('/api/tasks', 'POST', { title: 'Notification task', description: 'Private task description must not be copied.', ...extra }, 'alice', randomUUID()); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; };
  const inbox = async (who: keyof typeof tokens = 'bob', query = '') => { const result = await request<NotificationInbox>(`/api/notifications${query}`, 'GET', undefined, who); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  const summary = async (who: keyof typeof tokens = 'bob') => { const result = await request<NotificationSummary>('/api/notifications/count', 'GET', undefined, who); assert.equal(result.status, 200); return result.body; };
  const follow = async (id: string, who: 'alice' | 'bob' | 'carol', action = 'subscribe') => { const principal = { alice, bob, carol }[who], current = store.subscriptionStatus(id, principal.id); const result = await request<TaskSubscriptionStatus>(`/api/tasks/${id}/subscriptions`, 'POST', { principalId: principal.id, action, expectedMembershipVersion: current.version }, who, randomUUID()); assert.equal(result.status, 200, JSON.stringify(result.body)); };
  const comment = async (id: string, who: 'alice' | 'bob' | 'carol' = 'alice', key: string = randomUUID()) => { const result = await request(`/api/tasks/${id}/comments`, 'POST', { body: 'Private task comment must not be copied.' }, who, key); assert.equal(result.status, 201, JSON.stringify(result.body)); };
  const edit = async (id: string, fields: Record<string, unknown>, who: 'alice' | 'bob' | 'carol' = 'alice', key: string = randomUUID()) => { const result = await request<Task>(`/api/tasks/${id}`, 'PATCH', { expectedVersion: store.taskDetail(id).task.version, ...fields }, who, key); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  return { ...app, alice, bob, carol, tokens, origin, request, policy, task, inbox, summary, follow, comment, edit, close: async () => { await app.close(); store.close(); } };
}

for (const basePath of ['/', '/mounted/']) test(`task notifications share the private inbox and exact read boundaries at ${basePath}`, async () => {
  const app = await start(basePath);
  try {
    const task = await app.task({ ownerId: app.bob.id });
    let page = await app.inbox('read'); assert.equal(page.items.length, 1); const created = page.items[0]!;
    assert.equal(created.object.id, task.id); assert.equal(created.object.kind, 'task'); assert.equal(created.event.format, 'phabricator.notification-event.v2'); assert.equal(created.event.objectId, task.id); assert.deepEqual(created.event.context, { kind: 'task', taskVersion: 1 });
    assert.equal((await app.summary('alice')).unreadCount, 0, 'actor is excluded');
    await app.comment(task.id, 'alice', 'one-task-comment'); await app.comment(task.id, 'alice', 'one-task-comment');
    page = await app.inbox(); assert.equal(page.items.length, 2); assert.equal(page.items[0]!.event.kind, 'task_commented');
    assert.doesNotMatch(JSON.stringify(page), /Private task|credentialId|requestId|description|comment body/); assert.equal((await app.request('/api/notifications')).headers.get('cache-control'), 'no-store');
    const horizon = page.horizon, input = { action: 'read_object', objectId: task.id, horizon, expectedAccessEpoch: page.accessEpoch };
    assert.equal((await app.request('/api/notifications/read', 'POST', input, 'read', 'scope-denied')).status, 403);
    await app.comment(task.id); const newest = (await app.inbox()).items[0]!;
    const saved = await app.request<NotificationReceipt>('/api/notifications/read', 'POST', input, 'bob', 'read-task'); assert.equal(saved.status, 200); assert.equal(saved.body.changed, true);
    assert.deepEqual((await app.inbox('bob', '?filter=unread')).items.map(item => item.id), [newest.id]);
    assert.deepEqual((await app.request('/api/notifications/read', 'POST', input, 'bob', 'read-task')).body, saved.body); assert.equal((await app.summary()).unreadCount, 1);
    for (const body of [{ ...input, revisionId: task.id }, { action: 'read_object', revisionId: task.id, horizon, expectedAccessEpoch: page.accessEpoch }, { ...input, objectId: 'PROJ1' }]) assert.equal((await app.request('/api/notifications/read', 'POST', body, 'bob', randomUUID())).status, 400);
    const changed = await app.edit(task.id, { title: 'Current task title' }); assert.equal(changed.version, 2); assert.ok((await app.inbox()).items.every(item => item.object.title === 'Current task title')); assert.deepEqual((await app.inbox()).items.find(item => item.id === created.id)!.event.context, { kind: 'task', taskVersion: 1 });
  } finally { await app.close(); }
});

test('task routing honors creator unsubscribe, current owner, former owner and other-person subscription edits', async () => {
  const app = await start();
  try {
    const task = await app.task({ ownerId: app.bob.id }); await app.follow(task.id, 'alice', 'unsubscribe');
    await app.comment(task.id, 'bob'); assert.equal((await app.summary('alice')).unreadCount, 0, 'creation author is not a permanent notification recipient');
    const prior = (await app.summary()).unreadCount; await app.edit(task.id, { ownerId: app.carol.id });
    assert.equal(app.store.subscriptionStatus(task.id, app.bob.id).state, 'subscribed'); assert.equal((await app.summary()).unreadCount, prior + 1); assert.equal((await app.inbox('carol')).items[0]!.event.kind, 'task_owner_changed');
    await app.follow(task.id, 'bob', 'unsubscribe'); const before = (await app.summary()).unreadCount; await app.comment(task.id); assert.equal((await app.summary()).unreadCount, before);
    const sub = app.store.subscriptionStatus(task.id, app.bob.id); const added = await app.request(`/api/tasks/${task.id}/subscriptions`, 'POST', { principalId: app.bob.id, action: 'subscribe', expectedMembershipVersion: sub.version }, 'alice', 'add-person'); assert.equal(added.status, 200);
    assert.equal((await app.inbox()).items[0]!.event.kind, 'task_subscribers_changed');
    await app.edit(task.id, { title: app.store.taskDetail(task.id).task.title }); assert.equal((await app.summary()).unreadCount, before + 1, 'no-effect edits stay quiet');
  } finally { await app.close(); }
});

test('task dependency and merge notifications do not disclose inaccessible peer identifiers or text', async () => {
  const app = await start();
  try {
    const parent = await app.task(), child = await app.task({ title: 'Hidden child title' }); await app.follow(parent.id, 'bob'); await app.follow(child.id, 'carol');
    const added = await app.request<TaskDetail>(`/api/tasks/${parent.id}/dependencies`, 'POST', { taskId: child.id, action: 'add', expectedVersion: parent.version }, 'alice', 'dependency'); assert.equal(added.status, 200);
    assert.equal((await app.inbox()).items[0]!.event.kind, 'task_dependencies_changed'); assert.equal((await app.inbox('carol')).items[0]!.event.kind, 'task_dependencies_changed');
    app.policy(child.id, { view: people(app.alice.id, app.carol.id) }); await app.edit(child.id, { status: 'in_progress' });
    const page = await app.inbox(); assert.equal(page.items[0]!.event.kind, 'task_subtask_status_changed'); assert.equal(page.items[0]!.object.id, parent.id); assert.doesNotMatch(JSON.stringify(page), new RegExp(`Hidden child title|"${child.id}"`));
    const source = await app.task({ title: 'Hidden merge source' }); await app.follow(source.id, 'carol'); app.policy(source.id, { view: people(app.alice.id, app.carol.id) });
    const merged = await app.request(`/api/tasks/${source.id}/merge`, 'POST', { taskId: parent.id, expectedVersion: source.version, expectedTargetVersion: app.store.taskDetail(parent.id).task.version }, 'alice', 'merge'); assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal((await app.inbox()).items[0]!.event.kind, 'task_merged'); assert.doesNotMatch(JSON.stringify(await app.inbox()), new RegExp(`Hidden merge source|"${source.id}"`));
    assert.ok((await app.inbox('carol')).items.some(item => item.object.id === source.id && item.event.kind === 'task_merged'));
  } finally { await app.close(); }
});

test('task delivery uses final creation policy and current Space visibility for rows, counts and exact retry', async () => {
  const app = await start();
  try {
    const actor = { principalId: app.alice.id, displayName: app.alice.displayName, credentialId: app.tokens.alice.record.id, requestId: 'project-fixture' }, project = app.store.createProject({ name: 'Watched' }, actor);
    assert.equal((await app.request(`/api/projects/${project.id}/watchers`, 'POST', { principalId: app.bob.id, action: 'watch', expectedVersion: 0 }, 'bob', 'watch')).status, 200);
    const task = await app.task({ projectIds: [project.id], access: { spaceId: 'S1', view: people(app.alice.id), edit: people(app.alice.id), interact: people(app.alice.id) } });
    app.policy(task.id, { view: workspace, interact: workspace }); assert.equal((await app.summary()).unreadCount, 0, 'temporary creation policy never delivers'); await app.comment(task.id);
    const item = (await app.inbox()).items[0]!, input = { action: 'read', notificationId: item.id, expectedVersion: item.version, expectedAccessEpoch: app.policies.epoch() };
    assert.equal((await app.request('/api/notifications/read', 'POST', input, 'bob', 'later-hidden')).status, 200); assert.equal(app.policies.access(task.id, app.bob.id).edit, false);
    const space = app.policies.createSpace({ name: 'Private ceiling', view: people(app.alice.id), edit: people(app.alice.id) }, app.alice.id); app.policy(task.id, { spaceId: space.id });
    assert.equal((await app.summary()).unreadCount, 0); assert.equal((await app.inbox()).items.length, 0); assert.equal((await app.request('/api/notifications/read', 'POST', input, 'bob', 'later-hidden')).status, 404);
    const summary = await app.summary(); const denied = await app.request('/api/notifications/read', 'POST', { action: 'read_object', objectId: task.id, horizon: summary.horizon, expectedAccessEpoch: summary.accessEpoch }, 'bob', 'hidden-task'); assert.equal(denied.status, 404); assert.equal(denied.body.code, 'NOTIFICATION_UNAVAILABLE');
  } finally { await app.close(); }
});

test('task mute is a private View-only preference with exact no-op recovery, bounded history and owner suppression', async () => {
  const app = await start();
  try {
    const task = await app.task({ ownerId: app.bob.id }); await app.follow(task.id, 'carol');
    const before = app.store.taskDetail(task.id), subscribers = app.store.taskSubscriptions(task.id, app.bob.id), count = (await app.summary()).unreadCount;
    const snapshot = await app.request<TaskMuteSnapshot>(`/api/tasks/${task.id}/mute`, 'GET', undefined, 'read'); assert.equal(snapshot.status, 200); assert.equal(snapshot.body.version, 0); assert.equal(snapshot.body.muted, false);
    const input = { action: 'mute', expectedMuteVersion: snapshot.body.version, expectedAccessEpoch: snapshot.body.accessEpoch };
    assert.equal((await app.request(`/api/tasks/${task.id}/mute`, 'POST', input, 'read', 'readonly-mute')).status, 403);
    const saved = await app.request<TaskMuteReceipt>(`/api/tasks/${task.id}/mute`, 'POST', input, 'bob', 'mute-owner'); assert.equal(saved.status, 200); assert.equal(saved.body.changed, true);
    await app.comment(task.id); assert.equal((await app.summary()).unreadCount, count); assert.equal((await app.summary('carol')).unreadCount, 1);
    assert.deepEqual(app.store.taskDetail(task.id).task, before.task); assert.deepEqual(app.store.taskSubscriptions(task.id, app.bob.id), subscribers);
    const other = await app.request<TaskMuteSnapshot>(`/api/tasks/${task.id}/mute`, 'GET', undefined, 'carol'); assert.equal(other.body.muted, false); assert.equal(other.body.version, 0);
    const current = (await app.request<TaskMuteSnapshot>(`/api/tasks/${task.id}/mute`)).body, unmute = { action: 'unmute', expectedMuteVersion: current.version, expectedAccessEpoch: current.accessEpoch };
    assert.equal((await app.request(`/api/tasks/${task.id}/mute`, 'POST', unmute, 'bob', 'unmute-owner')).status, 200);
    assert.deepEqual((await app.request(`/api/tasks/${task.id}/mute`, 'POST', input, 'bob', 'mute-owner')).body, saved.body); assert.equal((await app.request<TaskMuteSnapshot>(`/api/tasks/${task.id}/mute`)).body.muted, false, 'exact old retry never reapplies mute');
    assert.equal((await app.request(`/api/tasks/${task.id}/mute`, 'POST', input, 'bob', 'stale-mute')).status, 409);
    const history = await app.request<TaskMuteHistory>(`/api/tasks/${task.id}/mute/history?limit=1&expectedMuteVersion=2`); assert.equal(history.status, 200); assert.equal(history.body.entries.length, 1); assert.equal(history.body.nextBefore, 2); assert.equal(history.body.entries[0]!.after, false);
    const next = await app.request<TaskMuteHistory>(`/api/tasks/${task.id}/mute/history?before=2&expectedMuteVersion=2`); assert.equal(next.body.entries[0]!.after, true); assert.equal(next.body.nextBefore, null);
    const otherHistory = await app.request<TaskMuteHistory>(`/api/tasks/${task.id}/mute/history`, 'GET', undefined, 'carol'); assert.deepEqual(otherHistory.body.entries, []); assert.equal(otherHistory.body.version, 0);
    for (const query of ['?principalId=' + app.carol.id, '?before=1', '/history?limit=1&limit=2', '/history?limit=101', '/history?before=0', '/history?expectedMuteVersion=1']) assert.equal((await app.request(`/api/tasks/${task.id}/mute${query}`)).status, query.endsWith('Version=1') ? 409 : 400, query);
    assert.equal((await app.request(`/api/tasks/${task.id}/mute`, 'POST', { ...unmute, expectedMuteVersion: 2, principalId: app.carol.id }, 'bob', 'foreign-mute')).status, 400);
    app.policy(task.id, { view: workspace, edit: people(app.alice.id), interact: people(app.alice.id) });
    // Carol can read but neither edit nor comment, and still owns her preference.
    assert.equal(app.policies.access(task.id, app.carol.id).edit, false); assert.equal(app.policies.access(task.id, app.carol.id).interact, false);
    const carol = (await app.request<TaskMuteSnapshot>(`/api/tasks/${task.id}/mute`, 'GET', undefined, 'carol')).body;
    assert.equal((await app.request(`/api/tasks/${task.id}/mute`, 'POST', { action: 'mute', expectedMuteVersion: carol.version, expectedAccessEpoch: carol.accessEpoch }, 'carol', 'reader-preference')).status, 200);
  } finally { await app.close(); }
});

test('task mute receipt proof rejects foreign owner and cross-key substitution and rolls back failed presentation', async () => {
  const app = await start();
  try {
    const otherTask = await app.task(), task = await app.task(), snapshot = (await app.request<TaskMuteSnapshot>(`/api/tasks/${task.id}/mute`)).body;
    const input = { action: 'unmute', expectedMuteVersion: snapshot.version, expectedAccessEpoch: snapshot.accessEpoch };
    const a = await app.request<TaskMuteReceipt>(`/api/tasks/${task.id}/mute`, 'POST', input, 'bob', 'noop-a'), b = await app.request<TaskMuteReceipt>(`/api/tasks/${task.id}/mute`, 'POST', input, 'bob', 'noop-b'), foreign = await app.request<TaskMuteReceipt>(`/api/tasks/${task.id}/mute`, 'POST', input, 'carol', 'foreign');
    assert.equal(a.status, 200); assert.equal(a.body.changed, false); assert.equal(b.status, 200); assert.equal(foreign.status, 200);
    const other = await app.request<TaskMuteReceipt>(`/api/tasks/${otherTask.id}/mute`, 'POST', input, 'bob', 'other-task'); assert.equal(other.status, 200);
    app.policy(otherTask.id, { view: people(app.alice.id) }); assert.equal(app.policies.access(otherTask.id, app.bob.id).view, false);
    const row = app.store.database.prepare('SELECT key,body FROM idempotency WHERE key LIKE ?').get('%:noop-a') as { key: string; body: string }, getter = app.store.taskNotifications.operation.bind(app.store.taskNotifications); let foreignReads = 0;
    app.store.taskNotifications.operation = id => { if (id === foreign.body.operationId || id === other.body.operationId) { foreignReads++; throw new Error('Foreign preference evidence loaded'); } return getter(id); };
    for (const body of [b.body, foreign.body, { ...a.body, operationId: foreign.body.operationId }, { ...a.body, operationId: other.body.operationId }, { ...a.body, changed: true }]) {
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(body), row.key);
      const rejected = await app.request(`/api/tasks/${task.id}/mute`, 'POST', input, 'bob', 'noop-a'); assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'TASK_MUTE_INVALID_RECEIPT');
    }
    assert.equal(foreignReads, 0); app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key); app.store.taskNotifications.operation = getter;
    const currentToken = app.tokens.bob.record.id; app.tokens.bob = app.auth.createToken(app.bob.id, { name: 'Rotated', scopes: ['read', 'write'] }); app.auth.revokeToken(app.bob.id, currentToken); assert.equal((await app.request(`/api/tasks/${task.id}/mute`, 'POST', input, 'bob', 'noop-a')).status, 200);
    app.store.taskNotifications.operation = () => { throw new Error('Injected proof failure'); };
    const failed = await app.request(`/api/tasks/${task.id}/mute`, 'POST', { ...input, action: 'mute', expectedAccessEpoch: app.policies.epoch() }, 'bob', 'atomic-mute'); assert.equal(failed.status, 409); app.store.taskNotifications.operation = getter;
    assert.equal((await app.request<TaskMuteSnapshot>(`/api/tasks/${task.id}/mute`)).body.version, 0); assert.equal(app.store.database.prepare('SELECT 1 FROM idempotency WHERE key LIKE ?').get('%:atomic-mute'), undefined);
    const space = app.policies.createSpace({ name: 'Hidden task', view: people(app.alice.id), edit: people(app.alice.id) }, app.alice.id); app.policy(task.id, { spaceId: space.id });
    assert.equal((await app.request(`/api/tasks/${task.id}/mute`, 'POST', input, 'bob', 'noop-a')).status, 404); assert.equal((await app.request(`/api/tasks/${task.id}/mute/history`)).status, 404);
  } finally { await app.close(); }
});
