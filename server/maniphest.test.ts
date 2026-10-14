import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import { initializeManiphest, parseManiphestConfig, readManiphestConfig, taskPoints, writeManiphestConfig } from './maniphest.ts';
import { DEFAULT_MANIPHEST_CONFIG, type ManiphestConfig, type ManiphestConfiguration, type ManiphestBulkInput, type ManiphestBulkPreview, type ManiphestBulkReceipt, type ManiphestReport } from '../shared/maniphest.ts';
import { isTaskClosed } from '../shared/tasks.ts';
import type { Task, TaskDetail } from '../shared/types.ts';

const people = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
function editConfig(config: ManiphestConfig, change: (draft: ManiphestConfig) => void) { const draft = structuredClone(config); change(draft); const { version, ...rest } = draft; return { ...rest, expectedVersion: version }; }
function customConfig(config: ManiphestConfig) { return editConfig(config, draft => { draft.statuses.push({ key: 'blocked', name: 'Blocked', closed: false, disabled: false }, { key: 'declined', name: 'Declined', closed: true, disabled: false }); draft.priorities.push({ key: 'critical', name: 'Critical', rank: 100, disabled: false }); draft.fields.push({ key: 'court', name: 'Court', type: 'text', required: true, disabled: false, options: [] }, { key: 'pages', name: 'Pages', type: 'integer', required: false, disabled: false, options: [] }, { key: 'sealed', name: 'Sealed', type: 'boolean', required: false, disabled: false, options: [] }, { key: 'stage', name: 'Stage', type: 'select', required: false, disabled: false, options: ['Draft', 'Filed'] }); draft.forms[0]!.fields.push(...draft.fields.map(field => `custom:${field.key}`)); draft.forms.push({ key: 'filing', name: 'Prepare filing', description: 'Legal drafting intake', disabled: false, fields: ['description', 'points', 'custom:court', 'custom:pages'], defaults: { status: 'blocked', priority: 'critical', points: 2.5, customFields: { court: 'District court', sealed: false } } }); }); }
async function fixture(basePath = '/') {
  const store = new Store({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice Maniphest password' }), bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob Maniphest password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath, maniphestAdminPrincipalIds: [alice.id], automation: { managers: ['alice'] } });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Task admin', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Editor', scopes: ['read', 'write'] }), read: app.auth.createToken(alice.id, { name: 'Read only', scopes: ['read'] }) };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath.replace(/\/$/, '')}`;
  async function request<T = { error: string }>(path: string, method = 'GET', body?: unknown, who: keyof typeof tokens = 'alice', key: string | undefined = randomUUID()) { const response = await fetch(origin + path, { method, headers: { Authorization: `Bearer ${tokens[who].token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() as T, headers: response.headers }; }
  const create = async (extra: object = {}) => { const result = await request<Task>('/api/tasks', 'POST', { title: 'Task', ...extra }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; };
  const configure = async (input = customConfig(readManiphestConfig(store.database))) => { const result = await request<ManiphestConfiguration>('/api/maniphest/config', 'PUT', input); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.config; };
  const bulk = (tasks: Task[], changes: ManiphestBulkInput['changes']): ManiphestBulkInput => ({ expectedAccessEpoch: app.policies.epoch(), expectedConfigVersion: readManiphestConfig(store.database).version, tasks: tasks.map(task => ({ id: task.id, expectedVersion: task.version })), changes });
  const policy = (id: string, rules: object) => { const old = app.policies.policy(id, alice.id); app.policies.setPolicy(id, { expectedVersion: old.version, spaceId: old.spaceId, ...old.rules, ...rules }, alice.id); };
  return { ...app, alice, bob, request, create, configure, bulk, policy, close: async () => { await app.close(); store.close(); } };
}

test('Maniphest config schema is repeatable and historical evidence cannot be rewritten', () => {
  const store = new Store({ path: ':memory:' }); try { const initial = readManiphestConfig(store.database); assert.deepEqual(initial, DEFAULT_MANIPHEST_CONFIG); initializeManiphest(store.database); assert.deepEqual(readManiphestConfig(store.database), initial); assert.throws(() => store.database.exec("UPDATE maniphest_config_history SET data='{}'"), /immutable/); assert.throws(() => store.database.exec('DELETE FROM maniphest_config_history'), /immutable/); store.database.exec('DROP TRIGGER maniphest_config_history_no_update'); store.database.exec('CREATE TRIGGER maniphest_config_history_no_update AFTER UPDATE ON maniphest_config_history BEGIN SELECT 1; END'); assert.throws(() => initializeManiphest(store.database), /Unexpected/); } finally { store.close(); }
});

test('statuses and custom field identities retain historical meaning while choices can retire', () => {
  const config = parseManiphestConfig(customConfig(DEFAULT_MANIPHEST_CONFIG), DEFAULT_MANIPHEST_CONFIG);
  for (const change of [ (draft: ManiphestConfig) => { draft.statuses.find(status => status.key === 'blocked')!.closed = true; }, (draft: ManiphestConfig) => { draft.statuses = draft.statuses.filter(status => status.key !== 'blocked'); }, (draft: ManiphestConfig) => { draft.fields[0]!.type = 'integer'; }, (draft: ManiphestConfig) => { draft.fields.find(field => field.key === 'stage')!.options = ['Filed']; }, (draft: ManiphestConfig) => { draft.priorities = draft.priorities.filter(priority => priority.key !== 'critical'); }, (draft: ManiphestConfig) => { draft.forms = draft.forms.filter(form => form.key !== 'default'); }, (draft: ManiphestConfig) => { draft.fields[0]!.key = '__proto__'; } ]) assert.throws(() => parseManiphestConfig(editConfig(config, change), config));
  const retired = parseManiphestConfig(editConfig(config, draft => { draft.statuses.find(item => item.key === 'declined')!.disabled = true; draft.priorities.find(item => item.key === 'low')!.disabled = true; draft.fields.find(item => item.key === 'stage')!.disabled = true; }), config);
  assert.equal(retired.version, 3); assert.equal(retired.statuses.find(item => item.key === 'declined')?.closed, true);
  for (const value of [0, 0.29, 3.14, 1000000, null]) assert.equal(taskPoints(value), value);
  for (const value of [-1, Infinity, NaN, 0.001, 1000001, '3']) assert.throws(() => taskPoints(value));
});

for (const basePath of ['/', '/mounted/']) test(`task config, typed fields and forms work under ${basePath} without requiring admin for ordinary edits`, async () => {
  const app = await fixture(basePath); try {
    const old = await app.create({ title: 'Existing task' });
    const before = await app.request<ManiphestConfiguration>('/api/maniphest/config'); assert.equal(before.status, 200); assert.equal(before.body.canConfigure, true); assert.equal(before.headers.get('cache-control'), 'no-store');
    assert.equal((await app.request<ManiphestConfiguration>('/api/maniphest/config', 'GET', undefined, 'bob')).body.canConfigure, false);
    const input = customConfig(before.body.config);
    assert.equal((await app.request('/api/maniphest/config', 'PUT', input, 'bob')).status, 403); assert.equal((await app.request('/api/maniphest/config', 'PUT', input, 'read')).status, 403);
    const configured = await app.request<ManiphestConfiguration>('/api/maniphest/config', 'PUT', input, 'alice', 'config-exact'); assert.equal(configured.status, 200); assert.equal(configured.body.config.version, 2);
    assert.deepEqual((await app.request('/api/maniphest/config', 'PUT', input, 'alice', 'config-exact')).body, configured.body);
    assert.equal((await app.request('/api/maniphest/config', 'PUT', { ...input, statuses: [] }, 'alice', 'config-exact')).status, 409);
    assert.equal((await app.request('/api/maniphest/config', 'PUT', input)).status, 409);
    const task = await app.create({ title: 'Filing', formKey: 'filing', expectedConfigVersion: 2, customFields: { pages: 24 } });
    assert.equal(task.status, 'blocked'); assert.equal(task.statusClosed, false); assert.equal(task.priority, 'critical'); assert.equal(task.points, 2.5); assert.deepEqual(task.customFields, { court: 'District court', pages: 24, sealed: false });
    assert.equal((await app.request('/api/tasks', 'POST', { title: 'Missing required value' })).status, 400);
    assert.equal((await app.request('/api/tasks', 'POST', { title: 'Wrong typed value', formKey: 'filing', customFields: { pages: '24' } })).status, 400);
    assert.equal((await app.request('/api/tasks', 'POST', { title: 'Wrong select', formKey: 'filing', customFields: { stage: 'Unknown' } })).status, 400);
    assert.equal((await app.request('/api/tasks', 'POST', { title: 'Stale config', formKey: 'filing', expectedConfigVersion: 1 })).status, 409);
    assert.equal((await app.request('/api/tasks', 'POST', { title: 'Arbitrary duplicate', status: 'duplicate' })).status, 400);
    const updated = await app.request<Task>(`/api/tasks/${task.id}`, 'PATCH', { expectedVersion: task.version, expectedConfigVersion: 2, customFields: { court: 'Appeals court', sealed: true }, points: 0.29, status: 'declined' }, 'bob');
    assert.equal(updated.status, 200, JSON.stringify(updated.body)); assert.equal(updated.body.customFields?.pages, 24); assert.equal(updated.body.statusClosed, true); assert.equal(isTaskClosed(updated.body), true);
    const history = app.store.taskDetail(task.id).history.transactions[0]!; assert.ok(history.changes?.some(change => change.field === 'points' && change.oldValue === '2.5' && change.newValue === '0.29')); assert.ok(history.changes?.some(change => change.field === 'customFields' && change.newValue?.includes('Appeals court')));
    assert.equal((await app.request(`/api/tasks/${old.id}`, 'PATCH', { title: 'Ordinary edit still works', expectedVersion: old.version })).status, 200, 'adding a required field does not break unrelated existing task edits');
    const historyRead = await app.request<{ versions: { config: ManiphestConfig }[] }>('/api/maniphest/config/history'); assert.deepEqual(historyRead.body.versions.map(item => item.config.version), [2, 1]); assert.equal((await app.request('/api/maniphest/config/history', 'GET', undefined, 'bob')).status, 403);
  } finally { await app.close(); }
});

test('bulk edit preview validates every version and field; all tasks and history roll back together', async () => {
  const app = await fixture(); try {
    await app.configure(); const a = await app.create({ formKey: 'filing', title: 'First' }), b = await app.create({ formKey: 'filing', title: 'Second' });
    const input = app.bulk([a, b], { status: 'declined', points: 4.25, customFields: { pages: 12 } });
    const beforeHistory = app.store.taskHistory(a.id).transactions.length;
    const preview = await app.request<ManiphestBulkPreview>('/api/maniphest/bulk/preview', 'POST', input); assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.equal(preview.body.tasks[0]?.before.status, 'blocked'); assert.equal(preview.body.tasks[0]?.after.statusClosed, true); assert.equal(app.store.taskDetail(a.id).task.version, a.version);
    assert.equal((await app.request('/api/maniphest/bulk/preview', 'POST', { ...input, changes: { customFields: { pages: 'no' } } })).status, 400);
    assert.equal((await app.request('/api/maniphest/bulk', 'POST', { ...input, tasks: [...input.tasks, input.tasks[0]] })).status, 400);
    const stale = { ...input, tasks: input.tasks.map((task, i) => i ? { ...task, expectedVersion: task.expectedVersion + 1 } : task) };
    assert.equal((await app.request('/api/maniphest/bulk', 'POST', stale)).status, 409); assert.equal(app.store.taskDetail(a.id).task.version, a.version); assert.equal(app.store.taskHistory(a.id).transactions.length, beforeHistory);
    const saved = await app.request<ManiphestBulkReceipt>('/api/maniphest/bulk', 'POST', input, 'alice', 'bulk-exact'); assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.tasks.length, 2); assert.ok(!JSON.stringify(saved.body).includes('First')); assert.equal(app.store.taskDetail(a.id).task.status, 'declined'); assert.equal(app.store.taskDetail(b.id).task.points, 4.25);
    assert.deepEqual((await app.request('/api/maniphest/bulk', 'POST', input, 'alice', 'bulk-exact')).body, saved.body); assert.equal(app.store.taskDetail(a.id).task.version, a.version + 1);
    assert.equal((await app.request('/api/maniphest/bulk', 'POST', { ...input, changes: { status: 'open' } }, 'alice', 'bulk-exact')).status, 409);
    app.policy(b.id, { edit: people(app.alice.id), view: people(app.alice.id) });
    assert.equal((await app.request('/api/maniphest/bulk', 'POST', app.bulk([app.store.taskDetail(a.id).task, app.store.taskDetail(b.id).task], { priority: 'urgent' }), 'bob')).status, 404);
    assert.equal(app.store.taskDetail(a.id).task.priority, 'critical');
    const fresh = app.bulk([app.store.taskDetail(a.id).task], { points: 9 }); app.policies.createSpace({ name: 'Epoch change' }, app.alice.id); assert.equal((await app.request('/api/maniphest/bulk', 'POST', fresh)).status, 409);
  } finally { await app.close(); }
});

test('dependency status effects inside a selected bulk set are atomic and reopen clears closed semantics', async () => {
  const app = await fixture(); try {
    await app.configure(); const parent = await app.create({ formKey: 'filing' }), child = await app.create({ formKey: 'filing' });
    app.store.updateTaskDependencies(parent.id, { taskId: child.id, action: 'add', expectedVersion: parent.version });
    const selected = [app.store.taskDetail(child.id).task, app.store.taskDetail(parent.id).task];
    const result = await app.request('/api/maniphest/bulk', 'POST', app.bulk(selected, { status: 'declined' })); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(app.store.taskDetail(child.id).task.statusClosed, true); assert.equal(app.store.taskDetail(parent.id).task.statusClosed, true);
    const source = app.store.taskDetail(child.id).task, target = app.store.taskDetail(parent.id).task;
    app.store.mergeTask(source.id, { taskId: target.id, expectedVersion: source.version, expectedTargetVersion: target.version });
    const duplicate = app.store.taskDetail(child.id).task; assert.equal(duplicate.status, 'duplicate'); assert.equal(isTaskClosed(duplicate), true);
    const reopened = app.store.updateTask(child.id, { status: 'blocked', expectedVersion: duplicate.version }); assert.equal(reopened.statusClosed, false); assert.equal(isTaskClosed(reopened), false);
    const retired = editConfig(readManiphestConfig(app.store.database), draft => { draft.statuses.find(status => status.key === 'blocked')!.disabled = true; draft.forms.find(form => form.key === 'filing')!.defaults.status = 'open'; draft.fields.find(field => field.key === 'sealed')!.disabled = true; delete draft.forms.find(form => form.key === 'filing')!.defaults.customFields!.sealed; });
    await app.configure(retired);
    const unchanged = app.store.updateTask(child.id, { expectedVersion: reopened.version, customFields: { ...reopened.customFields, pages: 3 }, title: 'Can edit retired state' }); assert.equal(unchanged.status, 'blocked'); assert.equal(unchanged.customFields?.sealed, false);
    assert.throws(() => app.store.updateTask(parent.id, { expectedVersion: app.store.taskDetail(parent.id).task.version, status: 'blocked' }), /enabled/);
  } finally { await app.close(); }
});

test('reports honor current policy and Space ceilings, frozen custom closure, points and visible project grouping', async () => {
  const app = await fixture(); try {
    await app.configure(); const project = app.store.createProject({ name: 'Visible project' }), hiddenProject = app.store.createProject({ name: 'Secret project' });
    app.policy(hiddenProject.id, { view: people(app.alice.id) });
    const open = await app.create({ formKey: 'filing', points: 3, projectIds: [project.id, hiddenProject.id] }), closed = await app.create({ formKey: 'filing', status: 'declined', points: 5 }), secret = await app.create({ formKey: 'filing', title: 'Hidden task title', points: 999 });
    app.policy(secret.id, { view: people(app.alice.id) });
    const result = await app.request<ManiphestReport>('/api/maniphest/report?groupBy=status', 'GET', undefined, 'bob'); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.deepEqual(result.body.totals, { tasks: 2, open: 1, closed: 1, points: 8, openPoints: 3, closedPoints: 5 }); assert.ok(!JSON.stringify(result.body).includes('Hidden task title'));
    const projects = await app.request<ManiphestReport>('/api/maniphest/report?groupBy=project', 'GET', undefined, 'bob'); assert.ok(!JSON.stringify(projects.body).includes(hiddenProject.id)); assert.ok(!JSON.stringify(projects.body).includes('Secret project')); assert.equal(projects.body.rows.find(row => row.key === project.id)?.tasks, 1);
    assert.equal((await app.request<ManiphestReport>(`/api/maniphest/report?projectId=${hiddenProject.id}`, 'GET', undefined, 'bob')).body.totals.tasks, 0);
    const ceiling = app.policies.createSpace({ name: 'Private', view: people(app.alice.id), edit: people(app.alice.id) }, app.alice.id); app.policy(open.id, { spaceId: ceiling.id });
    assert.equal((await app.request<ManiphestReport>('/api/maniphest/report', 'GET', undefined, 'bob')).body.totals.tasks, 1);
    assert.equal((await app.request('/api/maniphest/report?groupBy=secret')).status, 400); assert.equal((await app.request('/api/maniphest/report?createdAfter=garbage')).status, 400);
    assert.equal(isTaskClosed(app.store.taskDetail(closed.id).task), true);
  } finally { await app.close(); }
});

test('new required fields do not rewrite old snapshots or old idempotent task receipts', async () => {
  const app = await fixture(); try {
    const first = await app.request<Task>('/api/tasks', 'POST', { title: 'Before configuration' }, 'alice', 'task-before-config'); assert.equal(first.status, 201); await app.configure();
    assert.deepEqual((await app.request('/api/tasks', 'POST', { title: 'Before configuration' }, 'alice', 'task-before-config')).body, first.body);
    const history = app.store.taskDetail(first.body.id).history.transactions.find(transaction => transaction.kind === 'create')!; assert.deepEqual(history.snapshot?.customFields, {}); assert.equal(history.snapshot?.status, 'open');
  } finally { await app.close(); }
});


test('custom open and closed tasks participate in workboards with visible point totals', () => {
  const store = new Store({ path: ':memory:' }); try {
    writeManiphestConfig(store.database, customConfig(readManiphestConfig(store.database)), 'operator');
    const project = store.createProject({ name: 'Configured board' }); store.configureWorkboard(project.id, { enabled: true, expectedBoardVersion: 0 });
    const a = store.createTask({ title: 'Open custom status', formKey: 'filing', projectIds: [project.id], points: 3 });
    const b = store.createTask({ title: 'Closed custom status', formKey: 'filing', status: 'declined', projectIds: [project.id], points: 5 });
    let board = store.workboard(project.id); assert.deepEqual(board.columns[0]!.cards.cards.map(card => card.id), [a.id]); assert.equal(board.columns[0]!.visiblePointCount, 3);
    assert.equal(store.workboard(project.id, { status: 'all' }).columns[0]!.visiblePointCount, 8);
    store.updateTask(b.id, { expectedVersion: b.version, status: 'blocked' }); board = store.workboard(project.id); assert.equal(board.columns[0]!.visiblePointCount, 8); assert.equal(board.columns[0]!.visibleCardCount, 2);
    const visibility = { canViewTask: (id: string) => id === a.id, canViewProject: () => true, canEditTask: () => true, canEditProject: () => true }; assert.equal(store.workboard(project.id, {}, visibility).columns[0]!.visiblePointCount, 3);
  } finally { store.close(); }
});

test('Herald applies configured task statuses and priorities, rejecting nonexistent or disabled choices', async () => {
  const app = await fixture(); try {
    await app.configure();
    const rule = { name: 'Configured task routing', contentType: 'task', ruleType: 'global', objectId: null, enabled: true, match: 'all', repetition: 'every', conditions: [{ field: 'title', operator: 'contains', value: 'Route this' }], actions: [{ type: 'task-status', value: 'declined' }, { type: 'task-priority', value: 'critical' }] };
    assert.equal((await app.request('/api/herald/rules', 'POST', { ...rule, actions: [{ type: 'task-status', value: 'invented' }] })).status, 400);
    const created = await app.request('/api/herald/rules', 'POST', rule); assert.equal(created.status, 201, JSON.stringify(created.body));
    const task = await app.create({ title: 'Route this task', formKey: 'filing' }), actual = app.store.taskDetail(task.id).task; assert.equal(actual.status, 'declined'); assert.equal(actual.statusClosed, true); assert.equal(actual.priority, 'critical');
    const changed = editConfig(readManiphestConfig(app.store.database), draft => { draft.statuses.find(item => item.key === 'declined')!.disabled = true; }); await app.configure(changed);
    assert.equal((await app.request('/api/herald/rules', 'POST', { ...rule, name: 'Retired status' })).status, 400);
  } finally { await app.close(); }
});
