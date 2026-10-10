import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { createAuth } from '../server/auth.ts';
import { createStore } from '../server/store.ts';
import type { AppState, Project, ProjectChildPreview, ProjectDetail, ProjectHistory, ProjectMembersPage, ProjectPreferences, Task, TaskDetail } from '../shared/types.ts';
import type { ObjectAccess } from '../shared/policy.ts';

type ErrorBody = { error: string; code?: string };
type Actor = 'alice' | 'bob' | 'carol' | 'reader';
const workspace = { kind: 'workspace' } as const;
const selected = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });

async function start(path = ':memory:') {
  const store = createStore({ path });
  const operator = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await operator.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice hierarchy testing password' });
  const bob = await operator.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob hierarchy testing password' });
  const carol = await operator.createAccount({ username: 'carol', displayName: 'Carol', password: 'Carol hierarchy testing password' });
  const app = createApp({ store, seed: false, authMode: 'password' });
  const tokens = Object.fromEntries([['alice', alice], ['bob', bob], ['carol', carol], ['reader', bob]].map(([name, account]) => {
    const user = account as typeof alice; return [name, app.auth.createToken(user.id, { name: String(name), scopes: name === 'reader' ? ['read'] : ['read', 'write'] }).token];
  })) as Record<Actor, string>;
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T = ErrorBody>(actor: Actor, path: string, method = 'GET', body?: unknown, key?: string) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${tokens[actor]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  }
  async function project(name: string, fields: Record<string, unknown> = {}) { const result = await request<Project>('alice', '/api/projects', 'POST', { name, ...fields }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; }
  async function detail(id: string, actor: Actor = 'alice') { const result = await request<ProjectDetail>(actor, `/api/projects/${id}`); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; }
  async function childInput(parentId: string, name: string, kind: 'project' | 'milestone' = 'project', actor: Actor = 'alice') {
    const result = await request<ProjectChildPreview>(actor, `/api/projects/${parentId}/children/preview?kind=${kind}`); assert.equal(result.status, 200, JSON.stringify(result.body));
    const p = result.body; return { parentId, name, kind, expectedParentVersion: p.expectedParentVersion, expectedHierarchyVersion: p.expectedHierarchyVersion, expectedParentMembersVersion: p.expectedParentMembersVersion, confirmMembershipConversion: p.conversionRequired };
  }
  async function child(parentId: string, name: string, kind: 'project' | 'milestone' = 'project', fields: Record<string, unknown> = {}) { const input = await childInput(parentId, name, kind); const result = await request<Project>('alice', '/api/projects', 'POST', { ...input, ...fields }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; }
  async function policy(id: string, fields: Record<string, unknown>, actor: Actor = 'alice') {
    const existing = (await request<ObjectAccess>(actor, `/api/policies/${id}`)).body.policy;
    const result = await request<ObjectAccess>(actor, `/api/policies/${id}`, 'PUT', { expectedVersion: existing.version, spaceId: existing.spaceId, ...existing.rules, ...fields }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  return { ...app, alice, bob, carol, tokens, request, project, detail, child, childInput, policy, close: async () => { await app.close(); store.close(); } };
}

test('child previews and creation require parent authority, three current pins and explicit first-child membership conversion', async () => {
  const app = await start();
  try {
    const parent = await app.project('Parent', { memberIds: [app.bob.id] });
    await app.policy(parent.id, { edit: selected(app.alice.id) });
    assert.equal((await app.request('bob', `/api/projects/${parent.id}/children/preview?kind=project`)).status, 403);
    const input = await app.childInput(parent.id, 'First leaf');
    assert.equal(input.confirmMembershipConversion, true);
    assert.equal((await app.request('bob', '/api/projects', 'POST', input)).status, 403);
    assert.equal((await app.request('reader', '/api/projects', 'POST', input)).status, 403);
    assert.equal((await app.request('alice', '/api/projects', 'POST', { ...input, confirmMembershipConversion: false })).status, 409);
    const membersBefore = app.store.projectPreferences(parent.id, app.bob.id).membership;
    await app.request('alice', `/api/projects/${parent.id}/members`, 'POST', { action: 'add', principalIds: [app.carol.id], expectedCollectionVersion: input.expectedParentMembersVersion });
    assert.equal((await app.request('alice', '/api/projects', 'POST', input)).status, 409, 'conversion cannot silently transfer a changed member set');
    const child = await app.child(parent.id, 'First leaf');
    assert.equal(child.parentId, parent.id); assert.equal(child.depth, 1); assert.equal(child.membershipMode, 'direct');
    const current = await app.detail(parent.id); assert.equal(current.project.membershipMode, 'descendants'); assert.equal(current.project.version, parent.version);
    assert.equal(current.viewer.membership.version, null);
    const list = (await app.request<ProjectMembersPage>('alice', `/api/projects/${parent.id}/members`)).body;
    assert.deepEqual(list.members.map(row => row.principalId).sort(), [app.bob.id, app.carol.id].sort()); assert.ok(list.members.every(row => row.version === null && row.source === 'descendants'));
    assert.equal(app.store.projectPreferences(child.id, app.bob.id).membership.active, true);
    assert.equal((app.store.database.prepare("SELECT active FROM project_relations WHERE project_id = ? AND principal_id = ? AND relation = 'member'").get(parent.id, app.bob.id) as { active: number }).active, 0);
    assert.ok(membersBefore.version !== null);
    assert.equal((await app.request('bob', `/api/projects/${parent.id}/membership`, 'POST', { action: 'leave', expectedVersion: membersBefore.version })).status, 403);
    assert.equal((await app.request('alice', `/api/projects/${parent.id}/members`, 'POST', { action: 'set', principalIds: [], expectedCollectionVersion: current.membersVersion })).status, 403);
    for (const query of ['kind=project&kind=milestone', 'kind=wrong', 'kind=project&extra=x', '']) assert.equal((await app.request('alice', `/api/projects/${parent.id}/children/preview?${query}`)).status, 400);
    assert.equal((await app.request('alice', `/api/projects/${child.id}`, 'PATCH', { expectedVersion: child.version, parentId: null })).status, 400, 'reparenting is not a metadata edit');
  } finally { await app.close(); }
});

test('ancestor edit grants, child view rules and independent Spaces compose without granting access to tagged tasks', async () => {
  const app = await start();
  try {
    const parent = await app.project('Policy parent');
    const child = await app.child(parent.id, 'Policy child', 'project', { access: { spaceId: 'S1', view: workspace, edit: selected(app.alice.id), interact: selected(app.alice.id), join: selected() } });
    const bob = await app.detail(child.id, 'bob'); assert.equal(bob.access?.capabilities.edit, true); assert.equal(bob.access?.capabilities.interact, false); assert.equal(bob.access?.automatic?.kind, 'project-member');
    assert.equal((await app.request('bob', `/api/projects/${child.id}`, 'PATCH', { expectedVersion: child.version, description: 'Parent editor changed child' })).status, 200);
    await app.policy(child.id, { view: selected(app.alice.id) });
    assert.equal((await app.request('bob', `/api/projects/${child.id}`)).status, 404, 'parent edit never grants child view');
    const hiddenTask = await app.request<Task>('alice', '/api/tasks', 'POST', { title: 'Independent task policy', projectIds: [child.id], access: { spaceId: 'S1', view: selected(app.alice.id), edit: selected(app.alice.id) } }); assert.equal(hiddenTask.status, 201);
    const childNow = await app.detail(child.id);
    await app.request('alice', `/api/projects/${child.id}/members`, 'POST', { action: 'add', principalIds: [app.bob.id], expectedCollectionVersion: childNow.membersVersion });
    assert.equal((await app.request('bob', `/api/projects/${child.id}`)).status, 200, 'leaf membership grants child and ancestor view');
    assert.equal((await app.request('bob', `/api/tasks/${hiddenTask.body.id}`)).status, 404);
    const space = await app.request<{ id: string }>('alice', '/api/spaces', 'POST', { name: 'Alice-only Space' }); assert.equal(space.status, 201);
    await app.policy(parent.id, { spaceId: space.body.id });
    assert.equal((await app.request('bob', `/api/projects/${child.id}`)).status, 404, 'parent Space limits all descendants even if their own Space remains shared');
    assert.equal((await app.request('bob', `/api/projects/resolve?slug=${child.primarySlug}`)).status, 404);
    const state = (await app.request<AppState>('bob', '/api/state')).body; assert.ok(!state.projects.some(item => [parent.id, child.id].includes(item.id)));
  } finally { await app.close(); }
});

test('milestones inherit live policies, Space and membership, retain independent names and numbers, and prohibit direct rule or membership changes', async () => {
  const app = await start();
  try {
    const parent = await app.project('Review rounds', { memberIds: [app.bob.id], colorKey: 'violet' });
    await app.policy(parent.id, { view: selected(app.alice.id), edit: selected(app.alice.id), join: selected() });
    const milestone = await app.child(parent.id, 'Round', 'milestone', { aliases: ['round-one'] });
    const next = await app.child(parent.id, 'Round', 'milestone');
    assert.equal(milestone.primarySlug, null); assert.equal(next.primarySlug, null); assert.equal(milestone.milestoneNumber, 1); assert.equal(next.milestoneNumber, 2);
    assert.equal((await app.detail(parent.id)).project.membershipMode, 'direct', 'milestones do not convert parent membership');
    const bob = await app.detail(milestone.id, 'bob'); assert.equal(bob.viewer.membership.active, true); assert.equal(bob.viewer.membership.version, null); assert.equal(bob.viewer.membership.source, 'inherited'); assert.equal(bob.access?.capabilities.managePolicy, false); assert.equal(bob.access?.inheritedFrom?.projectId, parent.id);
    assert.equal((await app.request<ProjectDetail>('bob', '/api/projects/resolve?slug=round-one')).body.project.id, milestone.id);
    assert.equal((await app.request('alice', `/api/policies/${milestone.id}`, 'PUT', { expectedVersion: bob.access!.policy.version, spaceId: 'S1', ...bob.access!.policy.rules })).status, 403);
    assert.equal((await app.request('alice', `/api/projects/${milestone.id}/membership`, 'POST', { action: 'join', expectedVersion: 0 })).status, 403);
    assert.equal((await app.request('alice', `/api/projects/${milestone.id}/children/preview?kind=project`)).status, 409);
    for (const fields of [{ memberIds: [] }, { access: { spaceId: 'S1' } }, { colorKey: 'blue' }, { icon: 'folder' }, { color: '#ffffff' }]) assert.equal((await app.request('alice', '/api/projects', 'POST', { ...await app.childInput(parent.id, 'Rejected', 'milestone'), ...fields })).status, 400);
    const silenced = await app.request<ProjectPreferences>('bob', `/api/projects/${milestone.id}/silence`, 'POST', { silenced: true, expectedVersion: 0 }); assert.equal(silenced.status, 200); assert.equal(silenced.body.silence.active, true); assert.equal(app.store.projectPreferences(parent.id, app.bob.id).silence.active, false);
    await app.request('alice', `/api/projects/${parent.id}`, 'PATCH', { expectedVersion: parent.version, name: 'Renamed review rounds' });
    assert.equal((await app.detail(milestone.id)).project.displayName, 'Renamed review rounds (Round)');
    const p = await app.detail(parent.id); await app.request('alice', `/api/projects/${parent.id}/members`, 'POST', { action: 'remove', principalIds: [app.bob.id], expectedCollectionVersion: p.membersVersion });
    assert.equal((await app.request('bob', `/api/projects/${milestone.id}`)).status, 404);
  } finally { await app.close(); }
});

test('hierarchy, derived membership provenance and paginated history omit hidden child identities before pagination', async () => {
  const app = await start();
  try {
    const parent = await app.project('Public parent');
    await app.policy(parent.id, { edit: selected(app.alice.id) });
    const hidden = await app.child(parent.id, 'Private child name', 'project', { memberIds: [app.carol.id], access: { spaceId: 'S1', view: selected(app.alice.id), edit: selected(app.alice.id) } });
    const visible = await app.child(parent.id, 'Visible child');
    const bob = await app.detail(parent.id, 'bob'); assert.deepEqual(bob.hierarchy.subprojects.map(item => item.id), [visible.id]); assert.ok(!bob.hierarchy.descendantProjectIds.includes(hidden.id));
    assert.ok(!JSON.stringify(bob).includes(hidden.id)); assert.ok(!JSON.stringify(bob).includes(hidden.name));
    const members = (await app.request<ProjectMembersPage>('bob', `/api/projects/${parent.id}/members`)).body;
    assert.ok(members.members.some(row => row.principalId === app.carol.id)); assert.ok(!JSON.stringify(members).includes(hidden.id), 'parent membership is real, but hidden leaf provenance is omitted');
    const seen: number[] = []; let cursor: number | null = null;
    do {
      const response: { status: number; body: ProjectHistory } = await app.request<ProjectHistory>('bob', `/api/projects/${parent.id}/history?limit=1${cursor === null ? '' : `&before=${cursor}`}`);
      assert.equal(response.status, 200); assert.ok(!JSON.stringify(response.body).includes(hidden.id)); assert.ok(!JSON.stringify(response.body).includes(hidden.name));
      assert.ok(response.body.transactions.length === 1 || response.body.nextBefore === null); seen.push(...response.body.transactions.map(item => item.sequence)); cursor = response.body.nextBefore;
    } while (cursor !== null);
    assert.deepEqual(seen, app.store.projectHistory(parent.id, undefined, 100, id => id !== hidden.id).transactions.map(item => item.sequence));
    assert.deepEqual(await app.request('bob', `/api/projects/${hidden.id}/children/preview?kind=project`), await app.request('bob', '/api/projects/PROJ99999/children/preview?kind=project'));
  } finally { await app.close(); }
});

test('recursive watching keeps direct preferences separate and inherited-only toggles cannot target the wrong row', async () => {
  const app = await start();
  try {
    const root = await app.project('Watching root'); const child = await app.child(root.id, 'Watching child'); const leaf = await app.child(child.id, 'Watching grandchild');
    const watched = await app.request<ProjectDetail>('bob', `/api/projects/${root.id}/watchers`, 'POST', { principalId: app.bob.id, action: 'watch', expectedVersion: 0 }); assert.equal(watched.status, 200);
    const inherited = (await app.detail(leaf.id, 'bob')).viewer; assert.equal(inherited.watching.active, false); assert.equal(inherited.effectiveWatching, true); assert.ok(inherited.watchingInheritedFrom.includes(root.id));
    const state = (await app.request<AppState>('bob', '/api/state')).body; assert.deepEqual(state.watchingProjectIds, [root.id]);
    assert.equal((await app.request('bob', `/api/projects/${leaf.id}/watchers`, 'POST', { principalId: app.bob.id, action: 'unwatch', expectedVersion: 0 })).status, 409);
    await app.request('bob', `/api/projects/${root.id}/watchers`, 'POST', { principalId: app.bob.id, action: 'unwatch', expectedVersion: watched.body.viewer.watching.version });
    const direct = await app.request<ProjectDetail>('bob', `/api/projects/${leaf.id}/watchers`, 'POST', { principalId: app.bob.id, action: 'watch', expectedVersion: 0 }); assert.equal(direct.status, 200);
    await app.request('bob', `/api/projects/${root.id}/watchers`, 'POST', { principalId: app.bob.id, action: 'watch', expectedVersion: 2 });
    const removed = await app.request<ProjectDetail>('bob', `/api/projects/${leaf.id}/watchers`, 'POST', { principalId: app.bob.id, action: 'unwatch', expectedVersion: direct.body.viewer.watching.version }); assert.equal(removed.status, 200); assert.equal(removed.body.viewer.watching.active, false); assert.equal(removed.body.viewer.effectiveWatching, true);
  } finally { await app.close(); }
});

test('task tag conflicts preserve input precedence, remove conflicting hidden descendants without disclosing them, and never change task access', async () => {
  const app = await start();
  try {
    const parent = await app.project('Tag parent'); await app.policy(parent.id, { edit: selected(app.alice.id) });
    const child = await app.child(parent.id, 'Hidden tag child', 'project', { access: { spaceId: 'S1', view: selected(app.alice.id), edit: selected(app.alice.id) } });
    const first = await app.child(parent.id, 'Iteration', 'milestone'); const second = await app.child(parent.id, 'Iteration', 'milestone');
    const created = await app.request<Task>('alice', '/api/tasks', 'POST', { title: 'Ordered tags', projectIds: [parent.id, child.id] }); assert.equal(created.status, 201); assert.deepEqual(created.body.projectIds, [child.id]);
    const replaced = await app.request<TaskDetail>('bob', `/api/tasks/${created.body.id}/projects`, 'POST', { expectedVersion: created.body.version, action: 'add', projectIds: [parent.id] }); assert.equal(replaced.status, 200); assert.deepEqual(replaced.body.task.projectIds, [parent.id]); assert.ok(!JSON.stringify(replaced.body).includes(child.id));
    const milestones = await app.request<TaskDetail>('bob', `/api/tasks/${created.body.id}/projects`, 'POST', { expectedVersion: replaced.body.task.version, action: 'set', projectIds: [second.id, first.id] }); assert.equal(milestones.status, 200); assert.deepEqual(milestones.body.task.projectIds, [first.id], 'last submitted milestone wins, not lexical project ID');
    assert.equal(milestones.body.access?.capabilities.edit, true);
    const added = await app.request<TaskDetail>('bob', `/api/tasks/${created.body.id}/projects`, 'POST', { expectedVersion: milestones.body.task.version, action: 'add', projectIds: [parent.id] }); assert.equal(added.status, 200); assert.deepEqual(added.body.task.projectIds, [parent.id]);
  } finally { await app.close(); }
});

test('saved child retries recheck parent permissions, retain historical names and return minimal refresh receipts for schema11 bodies', async () => {
  const app = await start();
  try {
    const parent = await app.project('Replay parent');
    const input = await app.childInput(parent.id, 'Replay child');
    const created = await app.request<Project>('alice', '/api/projects', 'POST', input, 'child-once'); assert.equal(created.status, 201);
    await app.request('alice', `/api/projects/${created.body.id}`, 'PATCH', { expectedVersion: created.body.version, name: 'Current child name' });
    const replay = await app.request<Project>('alice', '/api/projects', 'POST', input, 'child-once'); assert.equal(replay.status, 201); assert.equal(replay.body.name, 'Replay child');
    const old = { id: parent.id, name: parent.name, description: '', color: parent.color, version: 1, status: 'active', icon: 'project', colorKey: 'blue', primarySlug: parent.primarySlug, primarySlugSource: 'name', aliases: [], authorId: app.alice.id, createdAt: parent.createdAt, updatedAt: parent.updatedAt, membershipLocked: false };
    const oldInput = { name: parent.name }; const key = `${app.auth.workspaceId}:${app.alice.id}:old-project`;
    const raw = JSON.stringify(old); app.store.database.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run(key, createHash('sha256').update(JSON.stringify(['POST', '/api/projects', oldInput])).digest('hex'), 201, raw, new Date().toISOString());
    const oldReplay = await app.request<{ id: string; saved: boolean; refreshRequired: boolean; accessEpoch: number }>('alice', '/api/projects', 'POST', oldInput, 'old-project'); assert.equal(oldReplay.status, 201); assert.deepEqual(Object.keys(oldReplay.body).sort(), ['accessEpoch', 'id', 'refreshRequired', 'saved']); assert.equal(oldReplay.body.refreshRequired, true);
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key=?').get(key) as { body: string }).body, raw);
    await app.policy(parent.id, { view: selected(app.bob.id), edit: selected(app.bob.id) }, 'bob');
    assert.equal((await app.request('alice', '/api/projects', 'POST', input, 'child-once')).status, 400);
    assert.equal((await app.request('alice', `/api/projects/${created.body.id}`)).status, 404);
  } finally { await app.close(); }
});

test('saved project responses never stamp stale hierarchy, membership sources or inherited appearance with a current epoch', async () => {
  const app = await start();
  try {
    const root = await app.project('Structural retries', { memberIds: [app.alice.id] });
    const firstInput = { expectedVersion: 1, description: 'Saved while direct' };
    const first = await app.request<ProjectDetail>('alice', `/api/projects/${root.id}`, 'PATCH', firstInput, 'direct-mode'); assert.equal(first.status, 200);
    const bytes = (key: string) => (app.store.database.prepare('SELECT body FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as { body: string }).body;
    const firstBytes = bytes('direct-mode');
    const child = await app.child(root.id, 'First structural leaf');
    const receipt = async (path: string, method: string, input: unknown, key: string, id: string) => {
      const result = await app.request<{ id: string; saved: boolean; refreshRequired: boolean; accessEpoch: number }>('alice', path, method, input, key);
      assert.equal(result.status, 200, JSON.stringify(result.body)); assert.deepEqual(Object.keys(result.body).sort(), ['accessEpoch', 'id', 'refreshRequired', 'saved']); assert.equal(result.body.id, id); assert.equal(result.body.refreshRequired, true); assert.equal(result.body.accessEpoch, app.policies.epoch());
    };
    await receipt(`/api/projects/${root.id}`, 'PATCH', firstInput, 'direct-mode', root.id); assert.equal(bytes('direct-mode'), firstBytes);
    const secondInput = { expectedVersion: 2, description: 'Saved with a direct child' };
    const second = await app.request<ProjectDetail>('alice', `/api/projects/${root.id}`, 'PATCH', secondInput, 'descendant-mode'); assert.equal(second.status, 200);
    const secondBytes = bytes('descendant-mode');
    const silenceInput = { expectedVersion: 0, silenced: true };
    const silenced = await app.request<ProjectPreferences>('alice', `/api/projects/${root.id}/silence`, 'POST', silenceInput, 'silence-once'); assert.equal(silenced.status, 200); const silenceBytes = bytes('silence-once');
    const grandchild = await app.child(child.id, 'Moved membership source');
    const current = await app.detail(root.id);
    assert.equal(current.project.hierarchyVersion, second.body.project.hierarchyVersion, 'grandchild creation does not touch this hierarchy pin');
    assert.equal(current.membersVersion, second.body.membersVersion, 'the same member union can acquire a different source');
    assert.deepEqual(current.viewer.membership.sourceProjectIds, [grandchild.id]);
    await receipt(`/api/projects/${root.id}`, 'PATCH', secondInput, 'descendant-mode', root.id); assert.equal(bytes('descendant-mode'), secondBytes);
    await receipt(`/api/projects/${root.id}/silence`, 'POST', silenceInput, 'silence-once', root.id); assert.equal(bytes('silence-once'), silenceBytes);

    const milestone = await app.child(root.id, 'Release', 'milestone');
    const milestoneInput = { expectedVersion: 1, description: 'Saved inherited appearance' };
    assert.equal((await app.request('alice', `/api/projects/${milestone.id}`, 'PATCH', milestoneInput, 'milestone-metadata')).status, 200); const milestoneBytes = bytes('milestone-metadata');
    await app.request('alice', `/api/projects/${root.id}`, 'PATCH', { expectedVersion: current.project.version, name: 'Renamed structural root', status: 'archived' });
    await receipt(`/api/projects/${milestone.id}`, 'PATCH', milestoneInput, 'milestone-metadata', milestone.id); assert.equal(bytes('milestone-metadata'), milestoneBytes);
  } finally { await app.close(); }
});

test('ancestor revocation committed while a child write waits denies both a fresh mutation and a newly available saved response', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-hierarchy-authority-lock-')); const databasePath = join(directory, 'workspace.sqlite');
  const app = await start(databasePath); const transaction = app.store.transaction.bind(app.store);
  try {
    for (const phase of ['write', 'replay'] as const) {
      const parent = await app.project(`Locked ancestor ${phase}`);
      const child = await app.child(parent.id, `Locked descendant ${phase}`, 'project', { access: { spaceId: 'S1', view: workspace, edit: selected(app.alice.id) } });
      const path = `/api/projects/${child.id}`; const input = { expectedVersion: child.version, description: 'Private saved descendant response' }; const key = `hierarchy-lock-${phase}`;
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') {
        assert.equal((await app.request('bob', path, 'PATCH', input, key)).status, 200);
        replay = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as typeof replay;
        assert.ok(replay); app.store.database.prepare('DELETE FROM idempotency WHERE key = ?').run(replay.key);
      }
      const before = ['entities', 'project_profiles', 'project_hierarchy', 'project_relations', 'project_transactions', 'activity'].map(table => app.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      const policy = (await app.request<ObjectAccess>('alice', `/api/policies/${parent.id}`)).body.policy;
      const restricted = { ...policy, version: policy.version + 1, rules: { ...policy.rules, view: selected(app.alice.id), edit: selected(app.alice.id) } };
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads';
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(workerData.databasePath); db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
        db.prepare('UPDATE object_policies SET data = ? WHERE object_id = ?').run(JSON.stringify(workerData.policy), workerData.id);
        db.prepare("UPDATE policy_meta SET value = value + 1 WHERE name = 'epoch'").run();
        if (workerData.replay) { const r = workerData.replay; db.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run(r.key, r.fingerprint, r.status, r.body, r.created_at); }
        parentPort.once('message', () => { db.exec('COMMIT'); db.close(); parentPort.close(); }); parentPort.postMessage('locked');
      `)}`), { workerData: { databasePath, id: parent.id, policy: restricted, replay } });
      try {
        assert.deepEqual(await once(worker, 'message'), ['locked']); let entered = 0;
        app.store.transaction = function<T>(work: () => T): T { entered++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); };
        const denied = await app.request('bob', path, 'PATCH', input, key);
        assert.equal(entered, 1); assert.equal(denied.status, 404); assert.equal(denied.body.code, 'OBJECT_UNAVAILABLE'); assert.doesNotMatch(JSON.stringify(denied.body), /Private saved|Locked descendant/);
        assert.deepEqual(['entities', 'project_profiles', 'project_hierarchy', 'project_relations', 'project_transactions', 'activity'].map(table => app.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
