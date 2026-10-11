import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.ts';
import type { ActorAttribution, WorkboardBulkMovePreview } from '../shared/types.ts';

const actor = (id: string): ActorAttribution => ({ principalId: id, displayName: id, credentialId: null, requestId: `request-${id}` });
const alice = actor('alice'), bob = actor('bob'), carol = actor('carol'), dora = actor('dora');
const epoch = (s: Store) => Number(s.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value);
const boardVersion = (s: Store, id: string) => s.workboard(id).board.version;
const enable = (s: Store, id: string) => s.configureWorkboard(id, { enabled: true, expectedBoardVersion: boardVersion(s, id) }, alice);
const backlog = (s: Store, id: string) => s.workboard(id).columns.find(row => row.isDefault)!.id;
const move = (s: Store, id: string, taskId: string, columnId: string, position: object = { edge: 'end' }) => s.moveWorkboardCard(id, { taskId, columnId, position, expectedBoardVersion: boardVersion(s, id), expectedTaskVersion: s.taskDetail(taskId).task.version }, alice);
const watch = (s: Store, projectId: string, person: ActorAttribution) => s.updateProjectWatcher(projectId, { principalId: person.principalId, action: 'watch', expectedVersion: 0 }, person);
const input = (p: WorkboardBulkMovePreview) => ({ sourceColumnId: p.sourceColumn.id, destinationProjectId: p.destinationProject.id, destinationColumnId: p.destinationColumn.id, expectedBoardVersion: p.expectedBoardVersion, expectedDestinationBoardVersion: p.expectedDestinationBoardVersion, tasks: p.tasks.map(t => ({ taskId: t.id, expectedTaskVersion: t.version })) });
const preview = (s: Store, source: string, column: string, destination: string, target: string) => s.workboardBulkMovePreview(source, { sourceColumnId: column, destinationProjectId: destination, destinationColumnId: target, status: 'all' });
const snapshot = (s: Store) => (s.database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, s.database.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()]);
function fixture() {
  const store = new Store({ path: ':memory:' });
  store.notifications.configure({ eligible: id => ['alice', 'bob', 'carol', 'dora'].includes(id), canView: () => true });
  const inbox = (id: string) => store.notifications.list(id, { limit: 100 }, epoch(store)).items;
  return { store, inbox };
}

test('mixed bulk board moves notify current watchers once per changed task, including tag-only changes, and replay does not deliver again', () => {
  const { store: s, inbox } = fixture();
  try {
    const source = s.createProject({ name: 'Source' }, alice), destination = s.createProject({ name: 'Destination' }, alice);
    enable(s, source.id); enable(s, destination.id); watch(s, source.id, bob); watch(s, destination.id, carol);
    const target = s.createWorkboardColumn(destination.id, { name: 'Working', expectedBoardVersion: boardVersion(s, destination.id) }, alice).columnId!;
    const first = s.createTask({ title: 'New destination card', ownerId: dora.principalId, projectIds: [source.id] }, alice);
    const already = s.createTask({ title: 'Already placed', ownerId: dora.principalId, projectIds: [source.id, destination.id] }, alice);
    const muted = s.createTask({ title: 'Muted owner card', ownerId: dora.principalId, projectIds: [source.id] }, alice);
    move(s, destination.id, already.id, target);
    s.taskNotifications.mutate(muted.id, dora.principalId, { action: 'mute', expectedMuteVersion: 0, expectedAccessEpoch: epoch(s) }, dora);
    const counts = { bob: inbox('bob').length, carol: inbox('carol').length, dora: inbox('dora').length };
    const selected = preview(s, source.id, backlog(s, source.id), destination.id, target), body = input(selected);
    assert.equal(selected.tasks.find(t => t.id === already.id)!.alreadyInDestination, true);
    const saved = s.mutate('bulk-notifications', 'exact-bulk', () => ({ status: 200, body: s.bulkMoveWorkboardCards(source.id, body, alice) }));
    assert.equal(inbox('bob').length, counts.bob, 'removed source watchers receive no former-recipient union');
    assert.equal(inbox('carol').length, counts.carol + 3);
    assert.equal(inbox('dora').length, counts.dora + 2, 'private mute wins over owner routing');
    const delivered = inbox('carol').slice(0, 3);
    assert.deepEqual(new Set(delivered.map(item => item.object.id)), new Set([first.id, already.id, muted.id]));
    assert.equal(delivered.find(item => item.object.id === already.id)!.event.kind, 'task_projects_changed');
    assert.ok(delivered.filter(item => item.object.id !== already.id).every(item => item.event.kind === 'task_column_changed'));
    assert.equal(new Set(delivered.map(item => item.event.cause.id)).size, 1, 'bulk operation is grouped without dropping distinct task deliveries');
    for (const item of delivered) { assert.deepEqual(s.taskDetail(item.object.id).task.projectIds, [destination.id]); assert.deepEqual(item.event.context, { kind: 'task', taskVersion: s.taskDetail(item.object.id).task.version }); }
    const stable = snapshot(s); assert.deepEqual(s.mutate('bulk-notifications', 'exact-bulk', () => { throw new Error('Unexpected retry execution'); }), saved); assert.deepEqual(snapshot(s), stable);
  } finally { s.close(); }
});

test('milestone proxy moves group tag and column changes while same-column reordering and complete bulk no-ops are silent', () => {
  const { store: s, inbox } = fixture();
  try {
    const parent = s.createProject({ name: 'Parent' }, alice), destination = s.createProject({ name: 'Other board' }, alice);
    enable(s, parent.id); enable(s, destination.id);
    const p = s.projectChildPreview(parent.id, 'milestone'), milestone = s.createProject({ name: 'Release', parentId: parent.id, kind: 'milestone', expectedParentVersion: p.expectedParentVersion, expectedHierarchyVersion: p.expectedHierarchyVersion, expectedParentMembersVersion: p.expectedParentMembersVersion, ...(p.conversionRequired ? { confirmMembershipConversion: true } : {}) }, alice);
    watch(s, parent.id, bob); watch(s, milestone.id, carol); watch(s, destination.id, dora);
    const proxy = s.workboard(parent.id).columns.find(row => row.proxyProjectId === milestone.id)!.id;
    const first = s.createTask({ title: 'First', projectIds: [parent.id] }, alice), second = s.createTask({ title: 'Second', projectIds: [parent.id] }, alice);
    const bobBefore = inbox('bob').length; move(s, parent.id, first.id, proxy); move(s, parent.id, second.id, proxy);
    assert.equal(inbox('bob').length, bobBefore + 2); assert.equal(inbox('carol').length, 2);
    assert.ok(inbox('carol').every(item => item.event.kind === 'task_column_changed'));
    const count = inbox('bob').length; move(s, parent.id, second.id, proxy, { beforeTaskId: first.id }); assert.equal(inbox('bob').length, count); assert.equal(inbox('carol').length, 2);
    const shown = preview(s, parent.id, proxy, destination.id, backlog(s, destination.id)); s.bulkMoveWorkboardCards(parent.id, input(shown), alice);
    assert.equal(inbox('bob').length, count + 2); assert.equal(inbox('carol').length, 4); assert.equal(inbox('dora').length, 2);
    assert.deepEqual(s.taskDetail(first.id).task.projectIds, [milestone.id, destination.id].sort());
    const stable = snapshot(s); s.bulkMoveWorkboardCards(parent.id, input(preview(s, parent.id, proxy, destination.id, backlog(s, destination.id))), alice); assert.deepEqual(snapshot(s), stable);
    s.bulkMoveWorkboardCards(parent.id, input(preview(s, parent.id, proxy, parent.id, backlog(s, parent.id))), alice);
    assert.equal(inbox('bob').length, count + 4); assert.equal(inbox('carol').length, 4, 'removed milestone watchers receive no subsequent move'); assert.equal(inbox('dora').length, 4);
    assert.deepEqual(s.taskDetail(first.id).task.projectIds, [parent.id, destination.id].sort());
  } finally { s.close(); }
});

test('a delivery failure in a later bulk card rolls back all placements, tags, events and idempotency', () => {
  const { store: s } = fixture();
  try {
    const source = s.createProject({ name: 'Source' }, alice), destination = s.createProject({ name: 'Destination' }, alice);
    enable(s, source.id); enable(s, destination.id); watch(s, destination.id, bob);
    const first = s.createTask({ title: 'First', projectIds: [source.id] }, alice); s.createTask({ title: 'Second', projectIds: [source.id] }, alice);
    const body = input(preview(s, source.id, backlog(s, source.id), destination.id, backlog(s, destination.id)));
    assert.equal(body.tasks.at(-1)!.taskId, first.id, 'failure occurs after an earlier card was published');
    s.database.exec(`CREATE TRIGGER fail_late_board_delivery BEFORE INSERT ON notification_deliveries WHEN (SELECT revision_id FROM notification_events WHERE id=NEW.event_id)='${first.id}' BEGIN SELECT RAISE(ABORT,'forced late delivery failure'); END`);
    const stable = snapshot(s); assert.throws(() => s.mutate('atomic-bulk', 'bulk-input', () => ({ status: 200, body: s.bulkMoveWorkboardCards(source.id, body, alice) })), /forced late delivery failure/); assert.deepEqual(snapshot(s), stable);
  } finally { s.close(); }
});
