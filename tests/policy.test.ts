import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Audience, ObjectPolicy, ProjectPolicy, Space } from '../shared/policy.ts';
import { audienceAllows, audienceLabel, effectiveAccess, spaceAccess } from '../shared/policy.ts';
import { initializePolicies, PolicyStore, registerDefaultPolicy } from '../server/policy.ts';

const shared: Audience = { kind: 'workspace' };
const selected = (...principalIds: string[]): Audience => ({ kind: 'principals', principalIds });
const principals = new Set(['alice', 'bob', 'carol', 'local:workspace']);
const options = { principalExists: (id: string) => principals.has(id) };
const status = (expected: number) => (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === expected;
const policyInput = (expectedVersion: number, spaceId = 'S1', view: Audience = shared, edit: Audience = shared, interact: Audience = shared) => ({ expectedVersion, spaceId, view, edit, interact });
function database(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE entities(id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL); INSERT INTO entities(id, kind, data) VALUES ('T1', 'task', '{}'), ('W1', 'document', '{}'); PRAGMA user_version = 3;");
  initializePolicies(db);
  return { db, policies: new PolicyStore(db, options) };
}
function insert(db: DatabaseSync, id: string) {
  const kind = id.startsWith('PROJ') ? 'project' : id.startsWith('R') ? 'repository' : /^[DPL]/.test(id) ? 'revision' : id.startsWith('T') ? 'task' : 'document';
  db.prepare('INSERT INTO entities(id, kind, data) VALUES (?, ?, ?)').run(id, kind, kind === 'revision' ? '{"repositoryId":null}' : '{}');
  registerDefaultPolicy(db, id);
}

test('project capabilities distinguish automatic member view, own-member rules, editor join and the outer Space boundary', () => {
  const space: Space = { id: 'S1', name: 'Shared', description: '', version: 1, archived: false, isDefault: true, view: shared, edit: selected('alice') };
  const policy: ProjectPolicy = { kind: 'project', objectId: 'PROJ1', spaceId: space.id, version: 1, rules: { view: selected('alice'), edit: selected('alice'), interact: selected('alice'), join: selected() } };
  assert.deepEqual(effectiveAccess(policy, space, 'bob', false, true), { view: true, edit: false, interact: false, managePolicy: false, join: false });
  assert.equal(effectiveAccess(policy, space, 'alice').join, true, 'editors may join even when join rule excludes them');
  assert.equal(effectiveAccess(policy, space, 'bob', true, false).view, false, 'task-owner boolean never grants project authority');
  assert.equal(effectiveAccess(policy, { ...space, view: selected('alice') }, 'bob', false, true).view, false);
  const members = { kind: 'project-members' } as const;
  assert.equal(audienceAllows(members, 'bob'), false); assert.equal(audienceAllows(members, 'bob', true), true); assert.equal(audienceAllows(members, '', true), false); assert.equal(audienceLabel(members), 'Project members');
  assert.deepEqual(effectiveAccess({ ...policy, rules: { view: members, edit: members, interact: members, join: members } }, space, 'bob', false, true), { view: true, edit: true, interact: true, managePolicy: true, join: true });
});

test('ancestor edit grants never widen child view, interact or Space access', () => {
  const space: Space = { id: 'S1', name: 'Shared', description: '', version: 1, archived: false, isDefault: true, view: shared, edit: selected('alice') };
  const policy: ProjectPolicy = { kind: 'project', objectId: 'PROJ2', spaceId: space.id, version: 1, rules: { view: shared, edit: selected('alice'), interact: selected('alice'), join: selected() } };
  assert.deepEqual(effectiveAccess(policy, space, 'bob', false, false, { view: true, edit: true }), { view: true, edit: true, interact: false, managePolicy: true, join: true });
  assert.equal(effectiveAccess({ ...policy, rules: { ...policy.rules, view: selected('alice') } }, space, 'bob', false, false, { view: true, edit: true }).view, false);
  assert.equal(effectiveAccess(policy, space, 'bob', false, true, { view: false, edit: true }).view, false, 'even automatic membership cannot skip ancestor view');
  assert.equal(effectiveAccess(policy, { ...space, view: selected('alice') }, 'bob', false, true, { view: true, edit: true }).view, false);
});

test('migration assigns every existing object to an explicit shared Space without inventing ownership', () => {
  const { db, policies } = database();
  try {
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3, 'the root migration owns the schema version');
    const spaces = policies.spaces('alice');
    assert.equal(spaces.length, 1);
    assert.deepEqual(spaces[0], { id: 'S1', name: 'Shared workspace', description: 'The default Space for this workspace.', version: 1, isDefault: true, archived: false, view: shared, edit: shared });
    for (const id of ['T1', 'W1']) for (const principal of principals) {
      assert.deepEqual(policies.policy(id, principal), { objectId: id, spaceId: 'S1', version: 1, rules: { view: shared, edit: shared, interact: shared } });
      assert.deepEqual(policies.access(id, principal), { view: true, edit: true, interact: true, managePolicy: true });
    }
    assert.deepEqual(policies.spaces('unknown'), []);
    assert.deepEqual(policies.access('T1', 'unknown'), { view: false, edit: false, interact: false, managePolicy: false });
    assert.throws(() => policies.policy('T1', ''), status(404));
    assert.throws(() => policies.getSpace('S1', 'unknown'), status(404));
    insert(db, 'P1');
    assert.equal(policies.policy('P1', 'bob').spaceId, 'S1');
    assert.throws(() => registerDefaultPolicy(db, 'P1'), /UNIQUE/);
    assert.throws(() => registerDefaultPolicy(db, 'D404'), /FOREIGN KEY/);
    db.prepare('DELETE FROM object_policies WHERE object_id = ?').run('W1');
    assert.equal(policies.access('W1', 'alice').view, false);
    assert.throws(() => initializePolicies(db), /already exists/);
    assert.throws(() => policies.policy('W1', 'alice'), status(404), 'a repeated migration cannot repair absent policies as shared');
  } finally { db.close(); }
});

test('Space view is an outer boundary and Space editors have no object edit or creator bypass', () => {
  const { db, policies } = database();
  try {
    const space = policies.createSpace({ name: 'Research' }, 'alice');
    assert.equal(space.id, 'S2'); assert.deepEqual(space.view, selected('alice')); assert.deepEqual(space.edit, selected('alice'));
    policies.configureNew('T1', { spaceId: space.id }, 'alice');
    assert.equal(policies.policy('T1', 'alice').rules.view.kind, 'workspace');
    assert.equal(policies.access('T1', 'bob').view, false);
    assert.deepEqual(policies.spaces('bob').map(item => item.id), ['S1']);
    for (const id of ['T1', space.id, 'T404', 'S404', '../T1']) assert.throws(() => policies.require(id, 'bob', 'view'), status(404));
    policies.updateSpace(space.id, { expectedVersion: 1, view: selected('alice', 'bob') }, 'alice');
    assert.equal(policies.access('T1', 'bob').edit, true, 'Space edit is not required to edit a contained object');
    policies.setPolicy('T1', policyInput(1, space.id, selected('bob'), selected('bob'), selected('bob')), 'bob');
    assert.equal(policies.access(space.id, 'alice').edit, true);
    assert.equal(policies.access('T1', 'alice').view, false, 'neither creator nor Space editor bypasses object view');
    assert.throws(() => policies.describe('T1', 'alice'), status(404));
    assert.throws(() => policies.setPolicy('T1', policyInput(2, space.id), 'alice'), status(404));
    assert.throws(() => policies.updateSpace(space.id, { expectedVersion: 2, name: 'Take over' }, 'bob'), status(403));
    policies.updateSpace(space.id, { expectedVersion: 2, view: selected('alice') }, 'alice');
    assert.equal(policies.access('T1', 'bob').view, false, 'revoking Space membership overrides an explicit object grant');
  } finally { db.close(); }
});

test('task owners receive all object capabilities within their Space, while creators and other objects do not', () => {
  const { db, policies } = database();
  try {
    db.prepare('UPDATE entities SET data = ? WHERE id = ?').run(JSON.stringify({ ownerId: 'bob', authorId: 'carol' }), 'T1');
    policies.setPolicy('T1', policyInput(1, 'S1', selected(), selected(), selected()), 'bob');
    assert.deepEqual(policies.access('T1', 'bob'), { view: true, edit: true, interact: true, managePolicy: true });
    assert.deepEqual(policies.describe('T1', 'bob').automatic, { kind: 'task-owner', principalId: 'bob' });
    assert.match(policies.describe('T1', 'bob').interactLabel, /task owner/);
    assert.equal(policies.access('T1', 'carol').view, false, 'creation does not grant permanent access');
    db.prepare('UPDATE entities SET data = ? WHERE id = ?').run(JSON.stringify({ ownerId: 'bob' }), 'W1');
    policies.setPolicy('W1', policyInput(1, 'S1', selected('alice'), selected('alice'), selected('alice')), 'alice');
    assert.equal(policies.access('W1', 'bob').view, false, 'owner behavior is specific to tasks');
    const space = policies.createSpace({ name: 'Owner boundary', view: selected('alice', 'bob'), edit: selected('alice') }, 'alice');
    policies.setPolicy('T1', policyInput(2, space.id, selected(), selected(), selected()), 'bob');
    policies.updateSpace(space.id, { expectedVersion: 1, view: selected('alice') }, 'alice');
    assert.equal(policies.access('T1', 'bob').view, false, 'ownership does not bypass the Space');
    assert.throws(() => policies.describe('T1', 'bob'), { status: 404, code: 'OBJECT_UNAVAILABLE' });
    policies.updateSpace(space.id, { expectedVersion: 2, view: selected('alice', 'bob') }, 'alice');
    assert.equal(policies.access('T1', 'bob').edit, true);
    db.prepare('UPDATE entities SET data = ? WHERE id = ?').run(JSON.stringify({ ownerId: 'carol' }), 'T1');
    assert.equal(policies.access('T1', 'bob').view, false, 'ownership is read from the current task, not cached policy metadata');
    assert.equal(policies.access('T1', 'carol').view, false, 'new owner remains outside the Space');
  } finally { db.close(); }
});

test('view, edit and interact grants are distinct, with view required for every operation', () => {
  const { db, policies } = database();
  try {
    policies.setPolicy('T1', policyInput(1, 'S1', shared, selected('alice'), selected('bob')), 'alice');
    assert.deepEqual(policies.access('T1', 'bob'), { view: true, edit: false, interact: true, managePolicy: false });
    assert.deepEqual(policies.access('T1', 'carol'), { view: true, edit: false, interact: false, managePolicy: false });
    policies.require('T1', 'bob', 'interact');
    assert.throws(() => policies.require('T1', 'bob', 'edit'), status(403));
    assert.throws(() => policies.require('T1', 'bob', 'edit'), { status: 403, code: 'ACTION_FORBIDDEN' });
    assert.throws(() => policies.require('T1', 'alice', 'interact'), status(403));
    policies.setPolicy('T1', policyInput(2, 'S1', selected('alice'), shared, shared), 'alice');
    assert.deepEqual(policies.access('T1', 'bob'), { view: false, edit: false, interact: false, managePolicy: false });
    assert.throws(() => policies.require('T1', 'bob', 'view'), { status: 404, code: 'OBJECT_UNAVAILABLE' });
    assert.throws(() => policies.require('T999', 'bob', 'view'), { status: 404, code: 'OBJECT_UNAVAILABLE' });
    policies.setPolicy('T1', policyInput(3, 'S1', shared, selected('alice'), selected()), 'alice');
    assert.equal(policies.access('T1', 'alice').interact, false, 'object editing does not imply interaction');
    const space = policies.getSpace('S1', 'alice');
    assert.equal(spaceAccess(space, 'alice').interact, true, 'Space interaction follows its view rule');
  } finally { db.close(); }
});

test('policy edits retain the editor, validate principals and reject stale versions atomically', () => {
  const { db, policies } = database();
  try {
    const initial = policies.epoch();
    assert.throws(() => policies.setPolicy('T1', policyInput(1, 'S1', selected('bob')), 'alice'), status(400));
    assert.throws(() => policies.setPolicy('T1', policyInput(1, 'S1', shared, selected('bob')), 'alice'), status(400));
    assert.throws(() => policies.setPolicy('T1', policyInput(2), 'alice'), status(409));
    assert.equal(policies.epoch(), initial);
    assert.equal(policies.policy('T1', 'alice').version, 1);
    const saved = policies.setPolicy('T1', policyInput(1, 'S1', selected('bob', 'alice')), 'alice');
    assert.equal(saved.version, 2); assert.deepEqual(saved.rules.view, selected('alice', 'bob'));
    assert.equal(policies.epoch(), initial + 1);
    assert.throws(() => policies.setPolicy('T1', policyInput(1), 'alice'), status(409));
    assert.throws(() => policies.updateSpace('S1', { expectedVersion: 1, edit: selected('bob') }, 'alice'), status(400));
    assert.throws(() => policies.createSpace({ name: 'Invalid', view: selected('bob') }, 'alice'), status(400));
    assert.equal(policies.createSpace({ name: 'Valid' }, 'alice').id, 'S2', 'failed mutations do not consume IDs');
    assert.throws(() => policies.configureNew('T1', undefined, 'alice'), status(409));
  } finally { db.close(); }
});

test('archiving preserves reads and existing placement, but prevents new destinations', () => {
  const { db, policies } = database();
  try {
    const initialEpoch = policies.epoch();
    assert.throws(() => policies.updateSpace('S1', { expectedVersion: 1, archived: true }, 'alice'), { status: 400, message: 'The default Space cannot be archived.' });
    assert.equal(policies.getSpace('S1', 'alice').archived, false);
    assert.equal(policies.getSpace('S1', 'alice').version, 1);
    assert.equal(policies.epoch(), initialEpoch);
    const space = policies.createSpace({ name: 'Archive', view: shared, edit: shared }, 'alice');
    policies.configureNew('T1', { spaceId: space.id }, 'alice');
    const archived = policies.updateSpace(space.id, { expectedVersion: 1, archived: true }, 'alice');
    assert.equal(archived.archived, true);
    assert.equal(policies.spaces('bob').find(item => item.id === space.id)!.archived, true);
    policies.require('T1', 'bob', 'view');
    policies.setPolicy('T1', policyInput(1, space.id), 'bob');
    assert.throws(() => policies.setPolicy('W1', policyInput(1, space.id), 'bob'), status(409));
    assert.throws(() => policies.configureNew('W1', { spaceId: space.id }, 'bob'), status(409));
    assert.equal(policies.policy('W1', 'bob').spaceId, 'S1');
    policies.setPolicy('T1', policyInput(2), 'bob');
    assert.equal(policies.policy('T1', 'bob').spaceId, 'S1');
    policies.updateSpace(space.id, { expectedVersion: 2, archived: false }, 'alice');
    policies.setPolicy('W1', policyInput(1, space.id), 'bob');
    assert.equal(policies.policy('W1', 'bob').spaceId, space.id);
  } finally { db.close(); }
});

test('strict bounded policy inputs do not write on malformed audiences, fields or versions', () => {
  const { db, policies } = database();
  try {
    const malformed: unknown[] = [null, [], {}, { kind: 'public' }, { kind: 'workspace', principalIds: [] }, { kind: 'workspace', extra: true }, { kind: 'principals' }, { kind: 'principals', principalIds: 'alice' }, selected('alice', 'alice'), selected('unknown'), selected('a'.repeat(129)), selected('alice\n'), { kind: 'principals', principalIds: [1] }, selected(...Array.from({ length: 101 }, (_, index) => `person${index}`))];
    const before = policies.epoch();
    for (const view of malformed) assert.throws(() => policies.setPolicy('T1', { ...policyInput(1), view }, 'alice'), status(400));
    for (const input of [null, [], { name: 'Good', unknown: true }, { name: '' }, { name: 'x'.repeat(121) }, { name: 'Good', description: 'x'.repeat(10_001) }]) assert.throws(() => policies.createSpace(input, 'alice'), status(400));
    for (const expectedVersion of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => policies.setPolicy('T1', { ...policyInput(1), expectedVersion }, 'alice'), status(400));
    for (const spaceId of ['', '/S1', 'S01', 'S1?', 'S'.repeat(1000)]) assert.throws(() => policies.setPolicy('T1', { ...policyInput(1), spaceId }, 'alice'), status(400));
    assert.throws(() => policies.setPolicy('T1', { ...policyInput(1), owner: 'alice' }, 'alice'), status(400));
    assert.throws(() => policies.updateSpace('S1', { expectedVersion: 1, archived: 'true' }, 'alice'), status(400));
    assert.throws(() => policies.updateSpace('S1', { expectedVersion: 1 }, 'alice'), status(400));
    assert.throws(() => policies.configureNew('W1', {}, 'alice'), status(400));
    assert.throws(() => policies.configureNew('W1', { spaceId: 'S404' }, 'alice'), status(404));
    assert.throws(() => policies.createSpace({ name: 'Test' }, 'unknown'), status(404));
    assert.equal(policies.epoch(), before);
    assert.equal(policies.policy('T1', 'alice').version, 1);
  } finally { db.close(); }
});

test('policy transactions nest inside entity mutations and roll back changes and epoch together', () => {
  const { db, policies } = database();
  try {
    const before = policies.epoch();
    db.exec('BEGIN IMMEDIATE');
    insert(db, 'P1');
    const space = policies.createSpace({ name: 'Rolled back' }, 'alice');
    policies.configureNew('P1', { spaceId: space.id }, 'alice');
    policies.setPolicy('T1', policyInput(1, 'S1', selected('alice')), 'alice');
    assert.equal(policies.access('T1', 'bob').view, false);
    db.exec('ROLLBACK');
    assert.equal(policies.epoch(), before);
    assert.equal(policies.access('T1', 'bob').view, true);
    assert.equal(policies.access('P1', 'alice').view, false);
    assert.deepEqual(policies.spaces('alice').map(item => item.id), ['S1']);
    db.exec('BEGIN IMMEDIATE');
    policies.setPolicy('T1', policyInput(1, 'S1', selected('alice')), 'alice');
    assert.throws(() => policies.setPolicy('W1', policyInput(1, 'S1', selected('bob')), 'alice'), status(400));
    db.exec('COMMIT');
    assert.equal(policies.access('T1', 'bob').view, false, 'a failed inner savepoint leaves the outer transaction usable');
    assert.equal(policies.access('W1', 'bob').view, true);
  } finally { db.close(); }
});

test('grants, Space versions and epoch survive reopening the workspace', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-policy-')); const path = join(directory, 'workspace.sqlite');
  let db: DatabaseSync | undefined;
  try {
    const first = database(path); db = first.db;
    const space = first.policies.createSpace({ name: 'Private research' }, 'alice');
    first.policies.configureNew('W1', { spaceId: space.id, interact: selected() }, 'alice');
    first.policies.updateSpace(space.id, { expectedVersion: 1, description: 'Retained settings' }, 'alice');
    const epoch = first.policies.epoch(); db.close();
    db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys = ON');
    const policies = new PolicyStore(db, options);
    assert.equal(policies.epoch(), epoch);
    assert.equal(policies.getSpace(space.id, 'alice').version, 2);
    assert.equal(policies.getSpace(space.id, 'alice').description, 'Retained settings');
    assert.equal(policies.access('W1', 'bob').view, false);
    assert.equal(policies.access('W1', 'alice').interact, false);
    assert.equal(policies.createSpace({ name: 'Next' }, 'alice').id, 'S3');
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('portable labels report explicit audiences and never infer privacy from a Space name', () => {
  const { db, policies } = database();
  try {
    assert.equal(audienceLabel(shared), 'Workspace members');
    assert.equal(audienceLabel(selected()), 'No one');
    assert.equal(audienceLabel(selected('alice')), '1 selected member');
    assert.equal(audienceLabel(selected('alice', 'bob')), '2 selected members');
    assert.equal(audienceAllows(shared, ''), false);
    const space = policies.createSpace({ name: 'Very private', view: shared, edit: shared }, 'alice');
    policies.configureNew('T1', { spaceId: space.id }, 'alice');
    assert.equal(policies.describe('T1', 'alice').viewLabel, 'Workspace members');
    policies.updateSpace(space.id, { expectedVersion: 1, view: selected('alice') }, 'alice');
    assert.equal(policies.describe('T1', 'alice').viewLabel, 'Workspace members; limited by Space access');
    assert.equal(policies.describe('T1', 'alice').editLabel, 'Workspace members; limited by Space access; requires object view access');
    const policy: ObjectPolicy = policies.policy('T1', 'alice');
    const unrelated: Space = policies.getSpace('S1', 'alice');
    assert.equal(effectiveAccess(policy, unrelated, 'alice').view, false, 'mismatched Space cannot accidentally allow access');
  } finally { db.close(); }
});
