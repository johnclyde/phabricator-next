import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.ts';
import type { ActorAttribution, Task, TaskStatus } from '../shared/types.ts';

const actor = (name: string): ActorAttribution => ({ principalId: name, displayName: name, credentialId: null, requestId: `request-${name}` });
const alice = actor('alice'), bob = actor('bob'), carol = actor('carol'), dora = actor('dora');
const epoch = (store: Store) => store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number;
function fixture() {
  const store = new Store({ path: ':memory:' }), hidden = new Set<string>(), disabled = new Set<string>();
  store.notifications.configure({ eligible: person => ['alice', 'bob', 'carol', 'dora'].includes(person) && !disabled.has(person), canView: (id, person) => !hidden.has(`${id}:${person}`) });
  const inbox = (person = 'bob') => store.notifications.list(person, { limit: 100 }, epoch(store)).items;
  const create = (extra: Partial<Task> = {}, author = alice) => store.createTask({ title: 'Task', ...extra }, author);
  const edit = (id: string, fields: object, by = alice) => store.updateTask(id, { expectedVersion: store.taskDetail(id).task.version, ...fields }, by);
  const follow = (id: string, person: ActorAttribution, action: 'subscribe' | 'unsubscribe' = 'subscribe', by = person) => store.updateTaskSubscription(id, { principalId: person.principalId, action, expectedMembershipVersion: store.subscriptionStatus(id, person.principalId).version }, by);
  const mute = (id: string, person = bob, action: 'mute' | 'unmute' = 'mute') => store.taskNotifications.mutate(id, person.principalId, { action, expectedMuteVersion: store.taskNotifications.snapshot(id, person.principalId).version, expectedAccessEpoch: epoch(store) }, person);
  const edge = (id: string, other: string, action: 'add' | 'remove' = 'add') => store.updateTaskDependencies(id, { taskId: other, action, expectedVersion: store.taskDetail(id).task.version }, alice);
  return { store, hidden, disabled, inbox, create, edit, follow, mute, edge };
}
const snapshot = (store: Store) => (store.database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, store.database.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()]);

test('task followers, ancestor watchers and private mute route one post-change event per person', () => {
  const f = fixture(), s = f.store;
  try {
    const root = s.createProject({ name: 'Parent', memberIds: ['bob'] }, alice), preview = s.projectChildPreview(root.id, 'project');
    const child = s.createProject({ name: 'Child', parentId: root.id, kind: 'project', expectedParentVersion: preview.expectedParentVersion, expectedHierarchyVersion: preview.expectedHierarchyVersion, expectedParentMembersVersion: preview.expectedParentMembersVersion, confirmMembershipConversion: true }, alice);
    s.updateProjectWatcher(root.id, { principalId: bob.principalId, action: 'watch', expectedVersion: 0 }, bob);
    s.updateProjectSilence(root.id, { silenced: true, expectedVersion: 0 }, bob);
    s.updateProjectWatcher(child.id, { principalId: carol.principalId, action: 'watch', expectedVersion: 0 }, carol);
    const task = f.create({ ownerId: 'bob', projectIds: [child.id] });
    assert.equal(f.inbox().length, 1, 'owner and ancestor watcher are deduplicated'); assert.equal(f.inbox('carol').length, 1); assert.equal(f.inbox('alice').length, 0);
    f.follow(task.id, bob); assert.equal(f.inbox().length, 1, 'self subscription is quiet');
    f.mute(task.id); const stable = snapshot(s); f.edit(task.id, { title: task.title }); assert.deepEqual(snapshot(s), stable, 'no-effect edit has no notification');
    f.edit(task.id, { title: 'Muted change' }); assert.equal(f.inbox().length, 1, 'mute wins over owner, explicit and watcher routes'); assert.equal(f.inbox('carol').length, 2);
    f.mute(task.id, bob, 'unmute'); f.follow(task.id, alice, 'unsubscribe'); s.createTaskComment(task.id, { body: 'Comment without resubscribing' }, alice);
    assert.equal(s.subscriptionStatus(task.id, 'alice').subscribed, false); assert.equal(f.inbox().length, 2); assert.equal(f.inbox('carol')[0]!.event.kind, 'task_commented');
    f.edit(task.id, { ownerId: 'dora' }); assert.equal(s.subscriptionStatus(task.id, 'bob').state, 'subscribed'); assert.equal(f.inbox()[0]!.event.kind, 'task_owner_changed'); assert.equal(f.inbox('dora').length, 1);
    f.hidden.add(`${task.id}:carol`); f.disabled.add('dora'); f.edit(task.id, { description: 'Hidden source text' }); assert.equal(f.inbox('carol').length, 0); f.disabled.delete('dora'); assert.equal(f.inbox('dora').length, 1, 'disabled recipient was not delivered later changes');
    assert.doesNotMatch(JSON.stringify(f.inbox()), /Hidden source text|projectIds|credentialId|requestId/);
  } finally { s.close(); }
});

test('other-person subscription changes notify only current recipients and implicit subscription side effects stay grouped', () => {
  const f = fixture(), s = f.store;
  try {
    const task = f.create(); f.follow(task.id, bob, 'subscribe', alice);
    assert.equal(f.inbox().length, 1); assert.equal(f.inbox()[0]!.event.kind, 'task_subscribers_changed');
    f.follow(task.id, carol, 'subscribe', alice); assert.equal(f.inbox().length, 2); assert.equal(f.inbox('carol').length, 1);
    f.follow(task.id, carol, 'unsubscribe', alice); assert.equal(f.inbox().length, 3); assert.equal(f.inbox('carol').length, 1, 'removed recipients do not receive mail-only old-recipient union');
    s.createTaskComment(task.id, { body: 'A new participant' }, dora); assert.equal(f.inbox().length, 4); assert.equal(f.inbox()[0]!.event.kind, 'task_commented'); assert.equal(f.inbox('dora').length, 0);
    f.follow(task.id, bob, 'unsubscribe'); f.follow(task.id, bob); assert.equal(f.inbox().length, 4);
  } finally { s.close(); }
});

test('explicit dependencies notify both endpoints and all status changes notify only actor-visible parents', () => {
  const f = fixture(), s = f.store;
  try {
    const parent = f.create({ ownerId: 'bob' }), hiddenParent = f.create({ ownerId: 'bob' }), child = f.create({ ownerId: 'bob' });
    f.edge(parent.id, child.id); assert.deepEqual(new Set(f.inbox().slice(0, 2).map(item => item.object.id)), new Set([parent.id, child.id]));
    assert.ok(f.inbox().slice(0, 2).every(item => item.event.kind === 'task_dependencies_changed'));
    f.edge(hiddenParent.id, child.id); f.hidden.add(`${hiddenParent.id}:alice`);
    for (const status of ['in_progress', 'resolved'] as TaskStatus[]) {
      const count = f.inbox().length, oldHistory = s.taskHistory(hiddenParent.id).transactions.length;
      f.edit(child.id, { status }); const events = f.inbox().slice(0, 2);
      assert.equal(f.inbox().length, count + 2); assert.deepEqual(new Set(events.map(item => item.object.id)), new Set([child.id, parent.id]));
      assert.equal(events.find(item => item.object.id === parent.id)!.event.kind, 'task_subtask_status_changed');
      assert.equal(s.taskHistory(hiddenParent.id).transactions.length, oldHistory + 1, 'existing hidden-parent history remains intact without an alert');
      assert.ok(events.every(item => item.event.context.kind === 'task' && item.event.context.taskVersion === s.taskDetail(item.object.id).task.version));
    }
    const target = f.create(); s.mergeTask(child.id, { taskId: target.id, expectedVersion: s.taskDetail(child.id).task.version, expectedTargetVersion: target.version }, alice);
    const closedCount = f.inbox().length; f.edit(child.id, { status: 'resolved' });
    assert.equal(f.inbox().length, closedCount + 2, 'duplicate to resolved is a visible closed-to-closed status change');
    const count = f.inbox().length; f.edge(parent.id, child.id, 'remove'); assert.equal(f.inbox().length, count + 2);
  } finally { s.close(); }
});

test('semantic merges emit once per source and destination after follower carryover, leaving derived parent changes quiet', () => {
  const f = fixture(), s = f.store;
  try {
    const source = f.create({ ownerId: 'bob' }), target = f.create({}, carol), parent = f.create({ ownerId: 'bob' }); f.edge(parent.id, source.id); f.mute(target.id);
    const count = f.inbox().length, parentHistory = s.taskHistory(parent.id).transactions.length;
    s.mergeTask(source.id, { taskId: target.id, expectedVersion: s.taskDetail(source.id).task.version, expectedTargetVersion: target.version }, alice);
    assert.equal(s.subscriptionStatus(target.id, 'bob').subscribed, true); assert.equal(f.inbox().length, count + 1); assert.equal(f.inbox()[0]!.object.id, source.id); assert.equal(f.inbox()[0]!.event.kind, 'task_merged');
    assert.equal(s.taskHistory(parent.id).transactions.length, parentHistory + 1);
    const events = s.database.prepare("SELECT revision_id,data FROM notification_events WHERE cause_type='task_merge'").all();
    assert.equal(events.length, 2); assert.deepEqual(new Set(events.map(row => row.revision_id)), new Set([source.id, target.id]));
  } finally { s.close(); }
});

test('real board column and tag changes notify once while same-column reordering is quiet', () => {
  const f = fixture(), s = f.store;
  try {
    const project = s.createProject({ name: 'Board' }, alice); s.configureWorkboard(project.id, { enabled: true, expectedBoardVersion: 0 }, alice);
    const columnId = s.createWorkboardColumn(project.id, { name: 'Doing', expectedBoardVersion: s.workboard(project.id).board.version }, alice).columnId!;
    const a = f.create({ ownerId: 'bob', projectIds: [project.id] }), b = f.create({ ownerId: 'bob', projectIds: [project.id] });
    const move = (id: string, position: object = { edge: 'end' }) => s.moveWorkboardCard(project.id, { taskId: id, columnId, position, expectedBoardVersion: s.workboard(project.id).board.version, expectedTaskVersion: s.taskDetail(id).task.version }, alice);
    move(a.id); move(b.id); assert.equal(f.inbox().length, 4); assert.ok(f.inbox().slice(0, 2).every(item => item.event.kind === 'task_column_changed'));
    move(b.id, { beforeTaskId: a.id }); assert.equal(f.inbox().length, 4); assert.deepEqual(s.workboard(project.id).columns.find(c => c.id === columnId)!.cards.cards.map(t => t.id), [b.id, a.id]);
    const other = s.createProject({ name: 'Another project' }, alice); s.updateTaskProjects(a.id, { action: 'add', projectIds: [other.id], expectedVersion: s.taskDetail(a.id).task.version }, alice);
    assert.equal(f.inbox().length, 5); assert.equal(f.inbox()[0]!.event.kind, 'task_projects_changed');
  } finally { s.close(); }
});

test('delivery failures roll back task, parent, workboard, public history and retry receipts atomically', () => {
  const f = fixture(), s = f.store;
  try {
    const parent = f.create({ ownerId: 'bob' }), child = f.create({ ownerId: 'bob' }); f.edge(parent.id, child.id);
    s.database.exec("CREATE TRIGGER fail_task_delivery BEFORE INSERT ON notification_deliveries BEGIN SELECT RAISE(ABORT,'forced task delivery failure'); END");
    const before = snapshot(s); assert.throws(() => s.mutate('task-change', 'exact-request', () => ({ status: 200, body: f.edit(child.id, { status: 'resolved' }) })), /forced task delivery failure/); assert.deepEqual(snapshot(s), before);
    s.database.exec('DROP TRIGGER fail_task_delivery'); const response = s.mutate('task-change', 'exact-request', () => ({ status: 200, body: f.edit(child.id, { status: 'resolved' }) })), after = snapshot(s);
    assert.deepEqual(s.mutate('task-change', 'exact-request', () => { throw new Error('must not rerun'); }), response); assert.deepEqual(snapshot(s), after);
    assert.equal(f.inbox().slice(0, 2).filter(item => item.event.kind === 'task_subtask_status_changed').length, 1);
  } finally { s.close(); }
});
