import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { Store } from '../server/store.ts';
import type { ActorAttribution, Project, ProjectDetail, ProjectSnapshot } from '../shared/types.ts';
import { PROJECT_COLOR_HEX } from '../shared/projects.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice Writer', credentialId: 'alice-session', requestId: 'alice-request' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob Reviewer', credentialId: 'bob-token', requestId: 'bob-request' };
const status = (value: number) => (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === value;
const tables = ['entities', 'project_profiles', 'project_aliases', 'project_relations', 'project_transactions', 'project_preference_events', 'policy_meta', 'object_policies', 'activity', 'sequences', 'idempotency'];
const raw = (store: Store, table: string) => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const snapshot = (store: Store) => tables.map(table => raw(store, table));
const epoch = (store: Store) => (store.database.prepare("SELECT value FROM policy_meta WHERE name = 'epoch'").get() as { value: number }).value;
const edit = (store: Store, id: string, data: object, attribution = alice) => store.updateProject(id, { ...data, expectedVersion: store.getProject(id).version }, attribution);
const membership = (store: Store, id: string, action: 'join' | 'leave', attribution = alice) => store.updateProjectMembership(id, { action, expectedVersion: store.projectPreferences(id, attribution.principalId).membership.version }, attribution);
const members = (store: Store, id: string, action: 'add' | 'remove' | 'set', principalIds: string[], attribution = alice) => store.updateProjectMembers(id, { action, principalIds, expectedCollectionVersion: store.projectMembers(id, attribution.principalId).collectionVersion }, attribution);

test('project profiles preserve exact attribution and normalize globally unique Unicode aliases without automatically joining or watching', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const project = store.createProject({ name: 'Café / Research Group', description: 'A profile', icon: 'group', colorKey: 'violet', aliases: ['Old Label', 'old/label', 'CAFÉ RESEARCH GROUP', 'Café / Research Group', '..'] }, alice);
    assert.equal(project.primarySlug, 'café_research_group'); assert.equal(project.primarySlugSource, 'name'); assert.deepEqual(project.aliases, ['café_research_group', 'dotdot', 'old_label'].filter(value => value !== project.primarySlug));
    assert.equal(project.icon, 'group'); assert.equal(project.color, PROJECT_COLOR_HEX.violet); assert.equal(project.colorKey, 'violet'); assert.equal(project.authorId, alice.principalId); assert.equal(project.version, 1); assert.equal(project.membershipLocked, false);
    assert.equal(project.status, 'active'); assert.ok(project.createdAt); assert.equal(project.updatedAt, project.createdAt);
    const detail = store.projectDetail(project.id, alice.principalId);
    assert.deepEqual(detail.project, project); assert.deepEqual(store.state({ configured: false, model: null }).projects, [project]);
    assert.equal(detail.membersVersion, 0); assert.equal(detail.viewer.membership.active, false); assert.equal(detail.viewer.watching.active, false); assert.equal(detail.viewer.silence.active, false);
    assert.equal(detail.history.transactions.length, 1); const created = detail.history.transactions[0]!;
    assert.equal(created.kind, 'create'); assert.equal(created.actor, alice.displayName); assert.deepEqual(created.attribution, alice); assert.deepEqual(created.snapshot, project);
    const before = snapshot(store);
    for (const name of ['CAFÉ RESEARCH GROUP', 'Old Label', '..']) assert.throws(() => store.createProject({ name }, bob), status(409));
    assert.deepEqual(snapshot(store), before);
    assert.throws(() => store.database.exec('UPDATE project_transactions SET data = data'), /immutable/);
    assert.throws(() => store.database.exec('DELETE FROM project_transactions'), /immutable/);
  } finally { store.close(); }
});

test('profile edit CAS records immutable deltas, retains old name aliases and archived projects remain editable/taggable', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const project = store.createProject({ name: 'Original Name', color: '#ABCDEF', aliases: ['Extra Name'] }, alice); const original = raw(store, 'entities'); const baseline = raw(store, 'project_transactions');
    const updated = edit(store, project.id, { name: 'New Name', aliases: [], colorKey: 'red', icon: 'bugs', description: 'Updated profile', status: 'archived' }, bob);
    assert.equal(updated.project.version, 2); assert.equal(updated.project.status, 'archived'); assert.equal(updated.project.primarySlug, 'new_name'); assert.deepEqual(updated.project.aliases, ['original_name']);
    const event = updated.history.transactions[0]!; assert.equal(event.kind, 'edit'); assert.equal(event.projectVersion, 2); assert.deepEqual(event.attribution, bob);
    assert.deepEqual(event.changes?.find(change => change.field === 'aliases'), { field: 'aliases', oldValue: ['extra_name'], newValue: ['original_name'] });
    assert.deepEqual(event.changes?.find(change => change.field === 'colorKey'), { field: 'colorKey', oldValue: null, newValue: 'red' });
    assert.deepEqual(raw(store, 'entities'), original, 'profile edits do not rewrite original entity evidence'); assert.deepEqual(raw(store, 'project_transactions').slice(0, baseline.length), baseline);
    assert.deepEqual(store.state({ configured: false, model: null }).projects[0], updated.project);
    const before = snapshot(store); assert.throws(() => store.updateProject(project.id, { expectedVersion: 1, name: 'Stale' }, alice), status(409)); assert.deepEqual(snapshot(store), before);
    edit(store, project.id, { description: 'Editing while archived', aliases: [] });
    assert.deepEqual(store.getProject(project.id).aliases, []); assert.equal(store.createTask({ title: 'Archived tag', projectIds: [project.id] }).projectIds[0], project.id);
    assert.equal(edit(store, project.id, { status: 'active' }).project.status, 'active');
    const noChange = snapshot(store); edit(store, project.id, { status: 'active', name: 'New Name', aliases: [] }); assert.deepEqual(snapshot(store), noChange);
  } finally { store.close(); }
});

test('initial and explicit membership changes use one collection revision and per-principal tombstones without changing profile versions', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const initialEpoch = epoch(store); const project = store.createProject({ name: 'Initial members', memberIds: ['bob', 'alice'] }, alice);
    assert.equal(epoch(store), initialEpoch + 1); assert.equal(store.getProject(project.id).version, 1);
    const page = store.projectMembers(project.id, 'alice'); assert.equal(page.collectionVersion, 1); assert.deepEqual(page.members.map(row => [row.principalId, row.version, row.active]), [['alice', 1, true], ['bob', 1, true]]);
    const events = store.projectHistory(project.id).transactions.filter(row => row.kind === 'member');
    assert.equal(events.length, 2); assert.equal(new Set(events.map(row => row.relation!.operationId)).size, 1); assert.ok(events.every(row => row.relation!.reason === 'initial' && row.relation!.membersVersion === 1 && row.projectVersion === 1));
    const unchanged = snapshot(store); members(store, project.id, 'add', ['bob']); members(store, project.id, 'remove', ['carol']); members(store, project.id, 'set', ['bob', 'alice']); assert.deepEqual(snapshot(store), unchanged);
    const set = members(store, project.id, 'set', ['bob', 'carol'], bob);
    assert.equal(set.membersVersion, 2); assert.equal(set.project.version, 1); assert.equal(epoch(store), initialEpoch + 2);
    assert.deepEqual(store.projectPreferences(project.id, 'alice').membership, { projectId: project.id, principalId: 'alice', relation: 'member', active: false, version: 2, updatedAt: set.history.transactions[0]!.createdAt, source: 'direct', sourceProjectIds: [] });
    const latest = set.history.transactions.slice(0, 2); assert.equal(new Set(latest.map(row => row.relation!.operationId)).size, 1); assert.ok(latest.every(row => row.attribution?.principalId === bob.principalId));
    assert.deepEqual(store.projectMembers(project.id, 'alice', undefined, 1).members.map(row => row.principalId), ['bob']); assert.equal(store.projectMembers(project.id, 'alice', undefined, 1).nextAfter, 'bob'); assert.equal(store.projectMembers(project.id, 'alice', 'bob', 1).nextAfter, null);
    const before = snapshot(store); assert.throws(() => store.updateProjectMembers(project.id, { action: 'set', principalIds: [], expectedCollectionVersion: 1 }, alice), status(409)); assert.deepEqual(snapshot(store), before);
    membership(store, project.id, 'join', alice); assert.equal(store.projectPreferences(project.id, 'alice').membership.version, 3); assert.equal(store.projectMembers(project.id, 'alice').collectionVersion, 3);
  } finally { store.close(); }
});

test('independent self membership, watching and silence versions preserve preferences across leave/rejoin and keep silence private', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const project = store.createProject({ name: 'Preferences' }); membership(store, project.id, 'join', alice); const afterJoin = epoch(store);
    store.updateProjectWatcher(project.id, { principalId: 'alice', action: 'watch', expectedVersion: 0 }, alice);
    const publicHistory = raw(store, 'project_transactions'); const activity = raw(store, 'activity'); const collection = store.projectMembers(project.id, 'alice').collectionVersion;
    const muted = store.updateProjectSilence(project.id, { silenced: true, expectedVersion: 0 }, alice);
    assert.equal(muted.silence.active, true); assert.equal(muted.silence.version, 1); assert.equal(muted.watching.active, true); assert.equal(muted.membership.active, true);
    assert.equal(epoch(store), afterJoin); assert.equal(store.projectMembers(project.id, 'alice').collectionVersion, collection); assert.deepEqual(raw(store, 'project_transactions'), publicHistory); assert.deepEqual(raw(store, 'activity'), activity);
    const audit = raw(store, 'project_preference_events'); assert.equal(audit.length, 1); assert.deepEqual(JSON.parse(String(audit[0]!.data)).attribution, alice);
    assert.equal(store.projectDetail(project.id, 'bob').viewer.silence.active, false); assert.equal(store.projectHistory(project.id).transactions.some(row => row.kind === 'watcher'), true);
    assert.throws(() => store.database.exec('UPDATE project_preference_events SET data = data'), /immutable/); assert.throws(() => store.database.exec('DELETE FROM project_preference_events'), /immutable/);
    const before = snapshot(store); store.updateProjectSilence(project.id, { silenced: true, expectedVersion: 1 }, alice); store.updateProjectWatcher(project.id, { principalId: 'alice', action: 'watch', expectedVersion: 1 }, alice); assert.deepEqual(snapshot(store), before);
    assert.throws(() => store.updateProjectSilence(project.id, { silenced: false, expectedVersion: 0 }, alice), status(409)); assert.throws(() => store.updateProjectWatcher(project.id, { principalId: 'alice', action: 'watch', expectedVersion: 0 }, alice), status(409));
    membership(store, project.id, 'leave', alice); assert.equal(store.projectPreferences(project.id, 'alice').silence.active, true); assert.equal(store.projectPreferences(project.id, 'alice').watching.active, true);
    assert.throws(() => store.updateProjectSilence(project.id, { silenced: false, expectedVersion: 1 }, alice), status(409));
    membership(store, project.id, 'join', alice); store.updateProjectSilence(project.id, { silenced: false, expectedVersion: 1 }, alice);
    assert.equal(store.projectPreferences(project.id, 'alice').silence.version, 2); assert.equal(store.projectPreferences(project.id, 'alice').membership.version, 3);
    store.updateProjectWatcher(project.id, { principalId: 'alice', action: 'unwatch', expectedVersion: 1 }, bob);
    assert.equal(store.projectWatchers(project.id, 'bob').watchers.length, 0); assert.deepEqual(store.projectHistory(project.id).transactions[0]!.attribution, bob);
    assert.throws(() => store.updateProjectWatcher(project.id, { principalId: 'alice', action: 'watch', expectedVersion: 2 }, bob), status(400));
  } finally { store.close(); }
});

test('bounded membership and alias inputs support exact request limits, canonical deduplication and complete paged collections', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const first = Array.from({ length: 100 }, (_, index) => `person${String(index).padStart(3, '0')}`);
    const second = Array.from({ length: 100 }, (_, index) => `person${String(index + 100).padStart(3, '0')}`);
    const project = store.createProject({ name: 'Boundaries', memberIds: first, aliases: Array.from({ length: 100 }, (_, index) => index % 2 ? 'Same/Alias' : 'same alias') }, alice);
    assert.deepEqual(project.aliases, ['same_alias']); members(store, project.id, 'add', second, bob);
    const one = store.projectMembers(project.id, 'alice', undefined, 100); const two = store.projectMembers(project.id, 'alice', one.nextAfter!, 100);
    assert.equal(one.members.length, 100); assert.equal(two.members.length, 100); assert.equal(two.nextAfter, null); assert.deepEqual([...one.members, ...two.members].map(row => row.principalId), [...first, ...second]);
    assert.equal(one.collectionVersion, 2); assert.equal(store.getProject(project.id).version, 1);
    const before = snapshot(store); assert.throws(() => members(store, project.id, 'set', [...first, second[0]!]), status(400)); assert.deepEqual(snapshot(store), before);
    members(store, project.id, 'set', [], alice); assert.equal(store.projectMembers(project.id, 'alice').members.length, 0); assert.equal(store.projectMembers(project.id, 'alice').collectionVersion, 3);
    assert.equal(store.projectPreferences(project.id, first[0]!).membership.version, 2);
    const watcherActors = [alice, bob, { ...alice, principalId: 'carol', displayName: 'Carol' }];
    for (const actor of watcherActors) store.updateProjectWatcher(project.id, { principalId: actor.principalId, action: 'watch', expectedVersion: 0 }, actor);
    const watchers = store.projectWatchers(project.id, alice.principalId, undefined, 2); assert.deepEqual(watchers.watchers.map(row => row.principalId), ['alice', 'bob']); assert.equal(watchers.nextAfter, 'bob');
    assert.deepEqual(store.projectWatchers(project.id, alice.principalId, watchers.nextAfter!, 2).watchers.map(row => row.principalId), ['carol']);
    assert.equal(store.projectHistory(project.id, undefined, 100).transactions.length, 100);
  } finally { store.close(); }
});

test('profile, membership and preference validation failures roll back all tables and history, including conflicts after earlier batch effects', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const project = store.createProject({ name: 'Validation' }, alice); store.createProject({ name: 'Taken', aliases: ['Reserved'] }); const before = snapshot(store);
    for (const data of [{ name: '' }, { name: '_' }, { name: 'a'.repeat(129) }, { name: 'taken' }, { name: '\ud800' }, { name: 'Okay', aliases: ['\udfff'] }, { name: 'Okay', aliases: ['reserved'] }, { name: 'Okay', color: 'blue' }, { name: 'Okay', color: '#000000', colorKey: 'blue' }, { name: 'Okay', colorKey: 'nonsense' }, { name: 'Okay', icon: 'milestone' }, { name: 'Okay', aliases: [1] }, { name: 'Okay', aliases: Array(101).fill('x') }, { name: 'Okay', memberIds: ['alice', 'alice'] }]) assert.throws(() => store.createProject(data, alice));
    for (const data of [{}, { membershipLocked: true }, { status: 'closed' }, { aliases: ['Taken'] }, { aliases: null }, { colorKey: null }, { name: '_' }]) assert.throws(() => edit(store, project.id, data, alice));
    for (const principalIds of [['x/y'], ['alice', 'alice'], [1], Array(101).fill('x')]) assert.throws(() => members(store, project.id, 'add', principalIds as string[], alice), status(400));
    assert.throws(() => store.updateProjectMembership(project.id, { action: 'join', expectedVersion: -1 }, alice), status(400));
    assert.throws(() => store.updateProjectMembership(project.id, { action: 'join', expectedVersion: 0.5 }, alice), status(400));
    for (const [beforeCursor, limit] of [[0, 1], [1, 101], [undefined, 0]] as const) assert.throws(() => store.projectHistory(project.id, beforeCursor, limit), status(400));
    assert.throws(() => store.projectMembers(project.id, 'alice', 'bad/cursor'), status(400)); assert.throws(() => store.projectWatchers(project.id, 'alice', undefined, 101), status(400)); assert.deepEqual(snapshot(store), before);
    store.database.exec("CREATE TRIGGER fail_late_member BEFORE INSERT ON project_relations WHEN NEW.principal_id = 'bob' BEGIN SELECT RAISE(ABORT, 'injected membership failure'); END");
    assert.throws(() => members(store, project.id, 'add', ['alice', 'bob'], alice), /injected membership failure/); assert.deepEqual(snapshot(store), before);
    assert.throws(() => store.createProject({ name: 'Atomic creation', memberIds: ['alice', 'bob'] }, alice), /injected membership failure/); assert.deepEqual(snapshot(store), before);
    store.database.exec('DROP TRIGGER fail_late_member');
    store.database.exec("CREATE TRIGGER fail_project_history BEFORE INSERT ON project_transactions WHEN json_extract(NEW.data, '$.kind') = 'edit' BEGIN SELECT RAISE(ABORT, 'injected history failure'); END");
    assert.throws(() => edit(store, project.id, { name: 'Do not retain' }), /injected history failure/); assert.deepEqual(snapshot(store), before);
    store.database.exec('DROP TRIGGER fail_project_history');
    membership(store, project.id, 'join', alice); const joined = snapshot(store);
    store.database.exec("CREATE TRIGGER fail_private_audit BEFORE INSERT ON project_preference_events BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END");
    assert.throws(() => store.updateProjectSilence(project.id, { silenced: true, expectedVersion: 0 }, alice), /injected audit failure/); assert.deepEqual(snapshot(store), joined);
  } finally { store.close(); }
});

test('well-formed astral project aliases round-trip unchanged through canonical SQLite storage', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const project = store.createProject({ name: '🚀 Research', aliases: ['🧪 Methods'] }, alice);
    assert.equal(project.primarySlug, '🚀_research'); assert.deepEqual(project.aliases, ['🧪_methods']);
    assert.deepEqual((store.database.prepare('SELECT slug FROM project_aliases WHERE project_id = ? ORDER BY slug').all(project.id) as { slug: string }[]).map(row => row.slug), ['🚀_research', '🧪_methods']);
    assert.deepEqual(store.getProject(project.id), project);
  } finally { store.close(); }
});

test('safe integer bounds reject overflow without partially advancing metadata, membership or preference history', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const project = store.createProject({ name: 'Integer bounds' });
    store.database.prepare('UPDATE project_profiles SET data = ? WHERE project_id = ?').run(JSON.stringify({ ...project, version: Number.MAX_SAFE_INTEGER }), project.id);
    let before = snapshot(store); assert.throws(() => edit(store, project.id, { description: 'Overflow' }), status(409)); assert.deepEqual(snapshot(store), before);
    store.database.prepare('UPDATE project_profiles SET members_version = ? WHERE project_id = ?').run(Number.MAX_SAFE_INTEGER, project.id);
    before = snapshot(store); assert.throws(() => membership(store, project.id, 'join', alice), status(409)); assert.deepEqual(snapshot(store), before);
    store.database.prepare('UPDATE project_profiles SET members_version = 0 WHERE project_id = ?').run(project.id);
    store.database.prepare("INSERT INTO project_relations (project_id, principal_id, relation, active, version, updated_at) VALUES (?, ?, 'watcher', 0, ?, ?)").run(project.id, 'alice', Number.MAX_SAFE_INTEGER, '2026-10-10T12:00:00.000Z');
    before = snapshot(store); assert.throws(() => store.updateProjectWatcher(project.id, { principalId: 'alice', action: 'watch', expectedVersion: Number.MAX_SAFE_INTEGER }, alice), status(409)); assert.deepEqual(snapshot(store), before);
  } finally { store.close(); }
});

test('operator local membership handoff retains authorship and mail preferences, deduplicates members and rolls back atomically', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const local = { ...alice, principalId: 'local:workspace', displayName: 'You' }; const operator = { principalId: 'operator:terminal', displayName: 'Operator', credentialId: null, requestId: 'operator-request' };
    const a = store.createProject({ name: 'First', memberIds: [local.principalId] }, local); const b = store.createProject({ name: 'Second', memberIds: [local.principalId, bob.principalId] }, local);
    store.updateProjectWatcher(a.id, { principalId: local.principalId, action: 'watch', expectedVersion: 0 }, local); store.updateProjectSilence(a.id, { silenced: true, expectedVersion: 0 }, local);
    const before = snapshot(store);
    store.database.exec(`CREATE TRIGGER fail_transfer BEFORE INSERT ON project_transactions WHEN NEW.project_id = '${b.id}' AND json_extract(NEW.data, '$.relation.reason') = 'transferred' BEGIN SELECT RAISE(ABORT, 'injected transfer failure'); END`);
    assert.throws(() => store.transferLocalProjectMemberships(local.principalId, bob.principalId, operator), /injected transfer failure/); assert.deepEqual(snapshot(store), before); store.database.exec('DROP TRIGGER fail_transfer');
    assert.equal(store.transferLocalProjectMemberships(local.principalId, bob.principalId, operator), 2);
    for (const project of [a, b]) {
      assert.equal(store.getProject(project.id).authorId, local.principalId); assert.equal(store.getProject(project.id).version, 1);
      assert.equal(store.projectPreferences(project.id, local.principalId).membership.active, false); assert.equal(store.projectPreferences(project.id, local.principalId).membership.version, 2);
      assert.deepEqual(store.projectMembers(project.id, bob.principalId).members.map(row => row.principalId), [bob.principalId]);
      assert.ok(store.projectHistory(project.id).transactions.filter(row => row.relation?.reason === 'transferred').every(row => row.attribution?.principalId === operator.principalId));
    }
    assert.equal(store.projectPreferences(b.id, bob.principalId).membership.version, 1); assert.equal(store.projectPreferences(a.id, local.principalId).watching.active, true); assert.equal(store.projectPreferences(a.id, local.principalId).silence.active, true); assert.equal(store.projectPreferences(a.id, bob.principalId).silence.active, false);
    const after = snapshot(store); assert.equal(store.transferLocalProjectMemberships(local.principalId, bob.principalId, operator), 0); assert.deepEqual(snapshot(store), after);
  } finally { store.close(); }
});

test('concurrent per-person joins coexist, collection edits conflict, and saved mutation responses remain immutable across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-projects-')); const path = join(directory, 'workspace.sqlite'); let first = new Store({ path }); let second = new Store({ path });
  try {
    const project = first.createProject({ name: 'Concurrent project' });
    first.updateProjectMembership(project.id, { action: 'join', expectedVersion: 0 }, alice); second.updateProjectMembership(project.id, { action: 'join', expectedVersion: 0 }, bob);
    assert.deepEqual(first.projectMembers(project.id, 'alice').members.map(row => row.principalId), ['alice', 'bob']);
    assert.throws(() => first.updateProjectMembers(project.id, { action: 'set', principalIds: [], expectedCollectionVersion: 1 }, alice), status(409));
    const result = first.mutate('profile-once', 'same-input', () => ({ status: 200, body: first.updateProject(project.id, { expectedVersion: 1, description: 'Saved' }, alice) }));
    edit(second, project.id, { description: 'Later' }, bob); membership(second, project.id, 'leave', bob);
    const before = snapshot(first); assert.deepEqual(first.mutate('profile-once', 'same-input', () => { throw new Error('Must not repeat'); }), result); assert.deepEqual(snapshot(first), before); assert.equal((result.body as ProjectDetail).project.description, 'Saved');
    first.close(); second.close(); first = new Store({ path }); second = new Store({ path }); assert.deepEqual(snapshot(first), before); assert.deepEqual(first.replay('profile-once', 'same-input'), result); assert.equal(first.getProject(project.id).description, 'Later');
    const newest = first.projectHistory(project.id, undefined, 2); assert.equal(newest.transactions.length, 2); assert.ok(newest.nextBefore); const older = first.projectHistory(project.id, newest.nextBefore!, 100); assert.equal(older.nextBefore, null); assert.equal(older.firstAvailableSequence, 1); assert.equal(new Set([...newest.transactions, ...older.transactions].map(item => item.id)).size, 6);
  } finally { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('project writers acquire the SQLite write lock before reading metadata or member CAS versions', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-project-lock-')); const path = join(directory, 'workspace.sqlite'); const store = new Store({ path }); let worker: Worker | undefined;
  try {
    const project = store.createProject({ name: 'Writer lock' });
    worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
      import { parentPort, workerData } from 'node:worker_threads';
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(workerData.path); db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
      db.prepare("UPDATE project_profiles SET data = json_set(data, '$.version', 2, '$.description', 'Concurrent update'), members_version = 1 WHERE project_id = ?").run(workerData.id);
      parentPort.once('message', () => { db.exec('COMMIT'); db.close(); parentPort.close(); }); parentPort.postMessage('locked');
    `)}`), { workerData: { path, id: project.id } });
    assert.deepEqual(await once(worker, 'message'), ['locked']); const prepare = store.database.prepare.bind(store.database); let waited = 0;
    store.database.prepare = (sql: string) => { if (sql === "UPDATE sequences SET value = value WHERE name = 'project'") { waited++; worker!.postMessage('commit'); } return prepare(sql); };
    try { assert.throws(() => store.updateProject(project.id, { expectedVersion: 1, description: 'Stale write' }, alice), status(409)); assert.equal(waited, 1); }
    finally { store.database.prepare = prepare; }
    assert.equal(store.getProject(project.id).description, 'Concurrent update'); assert.equal(store.getProject(project.id).version, 2);
    assert.throws(() => store.updateProjectMembers(project.id, { action: 'add', principalIds: ['alice'], expectedCollectionVersion: 0 }, alice), status(409)); assert.equal(store.projectHistory(project.id).transactions.length, 1);
  } finally { if (worker) await worker.terminate(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

function schemaTen(path: string): { projects: ProjectSnapshot[]; preserved: Map<string, unknown[]> } {
  const db = new DatabaseSync(path);
  try {
    // Construct historical schema 10 directly. No current Store is relabeled.
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('project','repository','revision','task','document')), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX entities_kind ON entities(kind);
      CREATE UNIQUE INDEX documents_slug ON entities(json_extract(data, '$.slug')) WHERE kind = 'document';
      CREATE TABLE versions (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), number INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(revision_id, number));
      CREATE TABLE comments (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE reviews (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE activity (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, object_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX activity_object ON activity(object_id, sequence);
      CREATE TABLE sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE idempotency (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), created_at TEXT NOT NULL);
      CREATE TABLE wiki_versions (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES entities(id), number INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(document_id, number));
      CREATE TABLE review_threads (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), root_comment_id TEXT NOT NULL UNIQUE REFERENCES comments(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE thread_events (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), thread_id TEXT NOT NULL REFERENCES review_threads(id), version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE suggestion_applications (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), comment_id TEXT NOT NULL UNIQUE REFERENCES comments(id), thread_id TEXT NOT NULL REFERENCES review_threads(id), from_version_id TEXT NOT NULL REFERENCES versions(id), to_version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE task_transactions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES entities(id), sequence INTEGER NOT NULL, task_version INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(task_id, sequence));
      CREATE TABLE task_dependencies (task_id TEXT NOT NULL REFERENCES entities(id), dependency_id TEXT NOT NULL REFERENCES entities(id), PRIMARY KEY(task_id, dependency_id), CHECK(task_id <> dependency_id));
      CREATE TABLE task_subscriptions (task_id TEXT NOT NULL REFERENCES entities(id), principal_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('subscribed','unsubscribed')), version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(task_id, principal_id));
      CREATE TABLE task_duplicates (source_id TEXT NOT NULL REFERENCES entities(id), target_id TEXT NOT NULL REFERENCES entities(id), operation_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(source_id, target_id), CHECK(source_id <> target_id));
      CREATE TABLE task_projects (task_id TEXT NOT NULL REFERENCES entities(id), project_id TEXT NOT NULL REFERENCES entities(id), PRIMARY KEY(task_id, project_id));
      CREATE INDEX task_projects_project ON task_projects(project_id, task_id);
      CREATE TABLE policy_spaces (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE object_policies (object_id TEXT PRIMARY KEY REFERENCES entities(id), space_id TEXT NOT NULL REFERENCES policy_spaces(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX object_policies_space ON object_policies(space_id);
      CREATE TABLE policy_meta (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO policy_meta (name,value) VALUES ('epoch',7),('space_sequence',1);
      INSERT INTO sequences (name,value) VALUES ('project',7),('task',1);
      PRAGMA user_version = 10;
    `);
    for (const table of ['wiki_versions', 'comments', 'thread_events', 'suggestion_applications', 'task_transactions', 'task_duplicates']) for (const operation of ['update', 'delete']) db.exec(`CREATE TRIGGER ${table}_no_${operation} BEFORE ${operation.toUpperCase()} ON ${table} BEGIN SELECT RAISE(ABORT, 'Historical evidence is immutable'); END`);
    const workspace = { kind: 'workspace' }; const space = { id: 'S1', name: 'Shared workspace', description: '', version: 1, isDefault: true, archived: false, view: workspace, edit: workspace }; db.prepare('INSERT INTO policy_spaces(id,data) VALUES (?,?)').run(space.id, JSON.stringify(space, null, 2));
    const projects: ProjectSnapshot[] = ['Same Name', 'Same/Name', 'legacy-proj1', '_', '日本語研究', 'Unrelated', '\ud800'].map((name, index) => ({ id: `PROJ${index + 1}`, name, description: `Original description ${index + 1}`, color: index === 4 ? PROJECT_COLOR_HEX.blue : '#123456' }));
    for (const project of projects) {
      db.prepare("INSERT INTO entities(id,kind,data) VALUES (?,'project',?)").run(project.id, JSON.stringify(project, null, 2));
      db.prepare('INSERT INTO object_policies(object_id,space_id,data) VALUES (?, ?, ?)').run(project.id, 'S1', JSON.stringify({ objectId: project.id, spaceId: 'S1', version: 3, rules: { view: workspace, edit: { kind: 'principals', principalIds: ['alice'] }, interact: workspace } }, null, 2));
    }
    const task = { id: 'T1', title: 'Historical tagged task', description: '', status: 'open', priority: 'normal', ownerId: null, authorId: null, version: 3, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    db.prepare("INSERT INTO entities(id,kind,data) VALUES (?,'task',?)").run(task.id, JSON.stringify(task, null, 2)); db.prepare('INSERT INTO task_projects(task_id,project_id) VALUES (?,?)').run(task.id, 'PROJ1');
    db.prepare('INSERT INTO object_policies(object_id,space_id,data) VALUES (?, ?, ?)').run(task.id, 'S1', JSON.stringify({ objectId: task.id, spaceId: 'S1', version: 1, rules: { view: workspace, edit: workspace, interact: workspace } }, null, 2));
    db.prepare('INSERT INTO task_transactions(id,task_id,sequence,task_version,data) VALUES (?,?,?,?,?)').run('historical-task', task.id, 1, task.version, JSON.stringify({ id: 'historical-task', taskId: task.id, sequence: 1, taskVersion: task.version, kind: 'legacy', actor: null, createdAt: task.createdAt, snapshot: { ...task, projectId: 'PROJ1' } }, null, 2));
    db.prepare('INSERT INTO activity(id,object_id,data) VALUES (?,?,?)').run('old-project-event', 'PROJ1', JSON.stringify({ id: 'old-project-event', objectId: 'PROJ1', actor: 'You', action: 'created', detail: 'Historical project', createdAt: task.createdAt }, null, 2));
    db.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES (?,?,?,?,?)').run('old-project-response', 'legacy-input', 201, JSON.stringify(projects[0], null, 2), task.createdAt);
    const preserved = new Map(['entities', 'task_projects', 'task_transactions', 'activity', 'idempotency', 'policy_spaces', 'policy_meta'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    return { projects, preserved };
  } finally { db.close(); }
}

test('schema 11 migration preserves old bytes, invents no authorship/membership, and deterministically resolves colliding legacy names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-project-migrate-')); const path = join(directory, 'workspace.sqlite'); const legacy = schemaTen(path); let store = new Store({ path });
  try {
    assert.equal((store.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 26);
    for (const [table, rows] of legacy.preserved) assert.deepEqual(raw(store, table), rows, `${table} retains its exact historical data`);
    const projects = legacy.projects.map(project => store.getProject(project.id)); assert.deepEqual(projects.map(project => project.primarySlug), ['legacy-proj1-2', 'legacy-proj2', 'legacy-proj1', 'legacy-proj4', '日本語研究', 'unrelated', 'legacy-proj7']);
    assert.deepEqual(projects.map(project => project.primarySlugSource), ['generated', 'generated', 'name', 'generated', 'name', 'name', 'generated']);
    assert.equal(projects[4]!.colorKey, 'blue'); assert.equal(projects[0]!.colorKey, null);
    for (const [index, project] of projects.entries()) {
      assert.equal(project.name, legacy.projects[index]!.name); assert.equal(project.authorId, null); assert.equal(project.createdAt, null); assert.equal(project.updatedAt, null); assert.equal(project.version, 1); assert.equal(project.status, 'active');
      const history = store.projectHistory(project.id); assert.equal(history.transactions.length, 1); assert.equal(history.transactions[0]!.kind, 'legacy'); assert.equal(history.transactions[0]!.actor, null); assert.equal(history.transactions[0]!.createdAt, null); assert.equal(history.transactions[0]!.attribution, undefined); assert.deepEqual(history.transactions[0]!.snapshot, legacy.projects[index]);
      assert.equal(store.projectMembers(project.id, 'alice').members.length, 0); assert.equal(store.projectWatchers(project.id, 'alice').watchers.length, 0);
      const policy = JSON.parse((store.database.prepare('SELECT data FROM object_policies WHERE object_id = ?').get(project.id) as { data: string }).data); assert.equal(policy.version, 3); assert.equal(policy.kind, 'project'); assert.deepEqual(policy.rules.join, { kind: 'workspace' }); assert.deepEqual(policy.rules.edit, { kind: 'principals', principalIds: ['alice'] });
    }
    const oldReplay = (legacy.preserved.get('idempotency')![0] as { body: string }).body; assert.equal((raw(store, 'idempotency')[0] as { body: string }).body, oldReplay);
    edit(store, 'PROJ1', { name: 'New canonical name' }, alice); assert.ok(store.getProject('PROJ1').aliases.includes('legacy-proj1-2'));
    assert.deepEqual(raw(store, 'entities'), legacy.preserved.get('entities')); assert.deepEqual(store.taskDetail('T1').task.projectIds, ['PROJ1']);
    const after = snapshot(store); store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store), after);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schema 11 migration failures roll back new tables and schema, and retry after repair preserves old records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-project-migrate-fail-')); const path = join(directory, 'workspace.sqlite'); const legacy = schemaTen(path); let db = new DatabaseSync(path);
  try {
    const original = (db.prepare("SELECT data FROM entities WHERE id = 'PROJ1'").get() as { data: string }).data;
    db.prepare("UPDATE entities SET data = ? WHERE id = 'PROJ1'").run(JSON.stringify({ ...legacy.projects[0], name: null })); db.close();
    assert.throws(() => new Store({ path })); db = new DatabaseSync(path);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 10); assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'project_profiles'").get(), undefined);
    assert.deepEqual(db.prepare('SELECT * FROM idempotency ORDER BY rowid').all(), legacy.preserved.get('idempotency'));
    db.prepare("UPDATE entities SET data = ? WHERE id = 'PROJ1'").run(original); db.close();
    const store = new Store({ path }); try { assert.equal(store.getProject('PROJ1').name, legacy.projects[0]!.name); assert.deepEqual(raw(store, 'entities'), legacy.preserved.get('entities')); } finally { store.close(); }
    db = new DatabaseSync(path);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
