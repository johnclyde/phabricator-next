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
import type { AppState, Project, ProjectDetail, ProjectHistory, ProjectPreferences, ProjectMembersPage, ProjectWatchersPage, Task } from '../shared/types.ts';
import type { ProjectAudience, ObjectAccess, Space } from '../shared/policy.ts';

type ErrorBody = { error: string; code?: string };
type Actor = 'alice' | 'bob' | 'reader';
const selected = (...principalIds: string[]): ProjectAudience => ({ kind: 'principals', principalIds });
const workspace = { kind: 'workspace' } as const;
const members = { kind: 'project-members' } as const;

async function start(databasePath = ':memory:') {
  const store = createStore({ path: databasePath });
  const operator = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await operator.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice projects integration password' });
  const bob = await operator.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob projects integration password' });
  const app = createApp({ store, seed: false, authMode: 'password' });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }).token, bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }).token, reader: app.auth.createToken(bob.id, { name: 'Reader', scopes: ['read'] }).token };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T = ErrorBody>(actor: Actor, path: string, method = 'GET', body?: unknown, key?: string) {
    const result = await fetch(origin + path, { method, signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${tokens[actor]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json() as T };
  }
  async function project(name: string, fields: Record<string, unknown> = {}) { const result = await request<Project>('alice', '/api/projects', 'POST', { name, ...fields }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; }
  async function detail(id: string, actor: Actor = 'alice') { const result = await request<ProjectDetail>(actor, `/api/projects/${id}`); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; }
  async function policy(id: string, fields: Record<string, unknown>, actor: Actor = 'alice') {
    const current = (await request<ObjectAccess>(actor, `/api/policies/${id}`)).body.policy;
    const result = await request<ObjectAccess>(actor, `/api/policies/${id}`, 'PUT', { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...fields });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  return { ...app, alice, bob, tokens, request, project, detail, policy, close: async () => { await app.close(); store.close(); } };
}

test('project profile edits preserve immutable history and aliases, enforce CAS, and archived projects remain usable task tags', async () => {
  const app = await start();
  try {
    const project = await app.project('Research papers', { aliases: ['Research/Notes'], icon: 'folder', colorKey: 'violet' });
    assert.equal(project.version, 1); assert.equal(project.authorId, app.alice.id); assert.ok(project.aliases.includes('research_notes'));
    const before = await app.detail(project.id); assert.equal(before.access?.policy.kind, 'project'); assert.equal(before.access?.capabilities.join, true);
    const update = { expectedVersion: project.version, name: 'Revised research', status: 'archived', aliases: ['review papers'] };
    const changed = await app.request<ProjectDetail>('alice', `/api/projects/${project.id}`, 'PATCH', update, 'metadata');
    assert.equal(changed.status, 200); assert.equal(changed.body.project.version, 2); assert.equal(changed.body.project.status, 'archived');
    assert.equal(changed.body.history.transactions.find(item => item.kind === 'edit')?.attribution?.principalId, app.alice.id);
    const immutable = app.store.database.prepare('SELECT data FROM project_transactions ORDER BY rowid').all();
    assert.equal((await app.request('alice', `/api/projects/${project.id}`, 'PATCH', update)).status, 409);
    const noOp = await app.request<ProjectDetail>('alice', `/api/projects/${project.id}`, 'PATCH', { expectedVersion: 2, name: 'Revised research' });
    assert.equal(noOp.status, 200); assert.equal(noOp.body.project.version, 2); assert.deepEqual(app.store.database.prepare('SELECT data FROM project_transactions ORDER BY rowid').all(), immutable);
    const tagged = await app.request<Task>('bob', '/api/tasks', 'POST', { title: 'Archived tags still organize work', projectIds: [project.id] });
    assert.equal(tagged.status, 201); assert.deepEqual(tagged.body.projectIds, [project.id]);
    const replay = await app.request<ProjectDetail>('alice', `/api/projects/${project.id}`, 'PATCH', update, 'metadata'); assert.equal(replay.status, 200); assert.deepEqual(replay.body.project, changed.body.project);
    assert.equal((await app.request('reader', `/api/projects/${project.id}`, 'PATCH', { expectedVersion: 2, description: 'No write scope' })).status, 403);
    assert.equal((await app.request('alice', `/api/projects/${project.id}`, 'PATCH', { expectedVersion: 2, membershipLocked: true })).status, 400);
  } finally { await app.close(); }
});

test('project names and aliases resolve under current view policy with normalized lookup and identical hidden or missing responses', async () => {
  const app = await start();
  try {
    const project = await app.project('Research Papers', { aliases: ['Evidence/Review', '資料 📚'] });
    for (const slug of ['research_papers', 'RESEARCH PAPERS', 'Evidence/Review', '資料 📚']) {
      const result = await app.request<ProjectDetail>('reader', `/api/projects/resolve?slug=${encodeURIComponent(slug)}`);
      assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.project.id, project.id);
      assert.equal(result.body.viewer.membership.principalId, app.bob.id); assert.equal(typeof result.body.accessEpoch, 'number');
    }
    const updated = await app.request<ProjectDetail>('alice', `/api/projects/${project.id}`, 'PATCH', { expectedVersion: 1, name: 'Revised Research', aliases: [] });
    assert.equal(updated.status, 200);
    for (const slug of ['research_papers', 'revised_research']) assert.equal((await app.request<ProjectDetail>('bob', `/api/projects/resolve?slug=${slug}`)).body.project.id, project.id);
    assert.equal((await app.request('bob', '/api/projects/resolve?slug=evidence_review')).status, 404, 'an explicitly removed alias no longer resolves');
    await app.policy(project.id, { view: selected(app.alice.id), edit: selected(app.alice.id) });
    const missing = await app.request('bob', '/api/projects/resolve?slug=absent_project');
    assert.equal(missing.status, 404); assert.equal(missing.body.code, 'OBJECT_UNAVAILABLE');
    for (const slug of ['research_papers', 'revised_research']) assert.deepEqual(await app.request('bob', `/api/projects/resolve?slug=${slug}`), missing);
    assert.equal((await app.request<ProjectDetail>('alice', '/api/projects/resolve?slug=research_papers')).body.project.name, 'Revised Research');
    for (const query of ['', '?slug=', '?slug=_', '?slug=a&slug=b', '?slug=a&viewer=bob', `?slug=${'a'.repeat(129)}`, `?slug=${'a'.repeat(1025)}`]) assert.equal((await app.request('bob', `/api/projects/resolve${query}`)).status, 400);
  } finally { await app.close(); }
});

test('members automatically view only their project inside its Space; leaving may commit with a content-free receipt but cannot replay after access loss', async () => {
  const app = await start();
  try {
    const project = await app.project('Member visibility', { memberIds: [app.bob.id], access: { spaceId: 'S1', view: selected(app.alice.id), edit: selected(app.alice.id), interact: selected(app.alice.id), join: selected() } });
    const bob = await app.detail(project.id, 'bob');
    assert.deepEqual(bob.access?.capabilities, { view: true, edit: false, interact: false, managePolicy: false, join: false });
    assert.deepEqual(bob.access?.automatic, { kind: 'project-member' });
    assert.equal((await app.request('bob', `/api/projects/${project.id}`, 'PATCH', { expectedVersion: project.version, name: 'No edit grant' })).status, 403);
    const input = { action: 'leave', expectedVersion: bob.viewer.membership.version };
    const left = await app.request<{ id: string; saved: boolean; accessLost: boolean; accessEpoch: number }>('bob', `/api/projects/${project.id}/membership`, 'POST', input, 'leave');
    assert.equal(left.status, 200); assert.deepEqual(Object.keys(left.body).sort(), ['accessEpoch', 'accessLost', 'id', 'saved']); assert.equal(left.body.accessLost, true); assert.ok(left.body.accessEpoch > bob.accessEpoch!);
    assert.equal((await app.request('bob', `/api/projects/${project.id}/membership`, 'POST', input, 'leave')).status, 404);
    for (const path of ['', '/history', '/members', '/watchers', '/preferences']) assert.deepEqual(await app.request('bob', `/api/projects/${project.id}${path}`), await app.request('bob', `/api/projects/PROJ99999${path}`));
    const state = (await app.request<AppState>('bob', '/api/state')).body; assert.equal(state.projects.some(item => item.id === project.id), false); assert.equal(state.joinedProjectIds.includes(project.id), false);
    const history = await app.detail(project.id); assert.equal(history.history.transactions.filter(item => item.relation?.principalId === app.bob.id).at(0)?.relation?.active, false);
    const space = (await app.request<Space>('alice', '/api/spaces', 'POST', { name: 'Outer boundary' })).body;
    const hidden = await app.project('Member cannot cross Space', { memberIds: [app.bob.id], access: { spaceId: space.id } });
    assert.equal((await app.request('bob', `/api/projects/${hidden.id}`)).status, 404);
  } finally { await app.close(); }
});

test('own-project member audiences, editor automatic join and independent collection/member CAS govern membership changes', async () => {
  const app = await start();
  try {
    const project = await app.project('Joining');
    await app.policy(project.id, { edit: selected(app.alice.id), interact: selected(), join: selected() });
    assert.equal((await app.request('bob', `/api/projects/${project.id}/membership`, 'POST', { action: 'join', expectedVersion: 0 })).status, 403);
    const joined = await app.request<ProjectDetail>('alice', `/api/projects/${project.id}/membership`, 'POST', { action: 'join', expectedVersion: 0 }); assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal(joined.body.viewer.membership.active, true); assert.equal(joined.body.project.version, project.version);
    await app.policy(project.id, { edit: members, interact: members, join: workspace });
    const bobJoined = await app.request<ProjectDetail>('bob', `/api/projects/${project.id}/membership`, 'POST', { action: 'join', expectedVersion: 0 }); assert.equal(bobJoined.status, 200); assert.equal(bobJoined.body.access?.capabilities.edit, true);
    const noOp = await app.request<ProjectDetail>('bob', `/api/projects/${project.id}/membership`, 'POST', { action: 'join', expectedVersion: bobJoined.body.viewer.membership.version }); assert.equal(noOp.status, 200); assert.deepEqual(noOp.body, bobJoined.body);
    assert.equal((await app.request('bob', `/api/projects/${project.id}/membership`, 'POST', { action: 'leave', expectedVersion: 0 })).status, 409);
    const replaced = await app.request<ProjectDetail>('alice', `/api/projects/${project.id}/members`, 'POST', { action: 'set', principalIds: [app.alice.id], expectedCollectionVersion: bobJoined.body.membersVersion }); assert.equal(replaced.status, 200);
    assert.equal(replaced.body.membersVersion, bobJoined.body.membersVersion + 1);
    assert.equal((await app.request('alice', `/api/projects/${project.id}/members`, 'POST', { action: 'add', principalIds: [app.bob.id], expectedCollectionVersion: bobJoined.body.membersVersion })).status, 409);
    const task = (await app.request<Task>('alice', '/api/tasks', 'POST', { title: 'Unrelated object', projectIds: [project.id] })).body;
    assert.equal((await app.request('alice', `/api/policies/${task.id}`, 'PUT', { expectedVersion: 1, spaceId: 'S1', view: members, edit: workspace, interact: workspace })).status, 400);
    assert.equal((await app.request('alice', '/api/spaces', 'POST', { name: 'No indirect Space rules', view: members })).status, 400);
    const state = (await app.request<AppState>('alice', '/api/state')).body; assert.ok(state.joinedProjectIds.includes(project.id)); assert.equal(state.watchingProjectIds.includes(project.id), false);
  } finally { await app.close(); }
});

test('watching, membership and private silence remain independent; only self may watch and editors may remove another watcher', async () => {
  const app = await start();
  try {
    const project = await app.project('Independent preferences', { memberIds: [app.bob.id] });
    await app.policy(project.id, { edit: selected(app.alice.id), interact: selected() });
    const first = await app.detail(project.id, 'bob');
    const watched = await app.request<ProjectDetail>('bob', `/api/projects/${project.id}/watchers`, 'POST', { principalId: app.bob.id, action: 'watch', expectedVersion: 0 }); assert.equal(watched.status, 200); assert.equal(watched.body.viewer.watching.active, true);
    const beforeHistory = app.store.database.prepare('SELECT data FROM project_transactions ORDER BY rowid').all(); const beforeActivity = app.store.activities();
    const silenced = await app.request<ProjectPreferences>('bob', `/api/projects/${project.id}/silence`, 'POST', { silenced: true, expectedVersion: 0 }); assert.equal(silenced.status, 200); assert.equal(silenced.body.silence.active, true); assert.equal(silenced.body.watching.active, true); assert.equal(silenced.body.membership.active, true);
    assert.deepEqual(app.store.database.prepare('SELECT data FROM project_transactions ORDER BY rowid').all(), beforeHistory); assert.deepEqual(app.store.activities(), beforeActivity);
    assert.equal(silenced.body.accessEpoch, first.accessEpoch); assert.equal((await app.detail(project.id)).viewer.silence.active, false);
    assert.equal((await app.request('alice', `/api/projects/${project.id}/silence`, 'POST', { silenced: true, expectedVersion: 0 })).status, 403);
    assert.equal((await app.request('alice', `/api/projects/${project.id}/watchers`, 'POST', { principalId: app.bob.id, action: 'watch', expectedVersion: 1 })).status, 403);
    const removed = await app.request<ProjectDetail>('alice', `/api/projects/${project.id}/watchers`, 'POST', { principalId: app.bob.id, action: 'unwatch', expectedVersion: watched.body.viewer.watching.version }); assert.equal(removed.status, 200);
    assert.equal((await app.detail(project.id, 'bob')).viewer.silence.active, true);
    const watchers = (await app.request<ProjectWatchersPage>('bob', `/api/projects/${project.id}/watchers`)).body; assert.deepEqual(watchers.watchers, []); assert.equal(watchers.viewer.silence.active, true);
    const listed = (await app.request<ProjectMembersPage>('alice', `/api/projects/${project.id}/members?limit=1`)).body; assert.equal(listed.members.length, 1); assert.equal('silence' in listed.members[0]!, false);
    const state = (await app.request<AppState>('bob', '/api/state')).body; assert.ok(state.joinedProjectIds.includes(project.id)); assert.equal(state.watchingProjectIds.includes(project.id), false);
  } finally { await app.close(); }
});

test('editor member replacement can surrender edit or view without rollback; stale history pages and alias collisions disclose no hidden project', async () => {
  const app = await start();
  try {
    for (const view of [workspace, members]) {
      const project = await app.project(`Replace self ${view.kind}`, { memberIds: [app.alice.id, app.bob.id], access: { spaceId: 'S1', view, edit: members, interact: workspace } });
      const current = await app.detail(project.id); const input = { action: 'set', principalIds: [app.bob.id], expectedCollectionVersion: current.membersVersion };
      const result = await app.request<ProjectDetail | { saved: true; accessLost: true }>('alice', `/api/projects/${project.id}/members`, 'POST', input, `remove-self-${view.kind}`);
      assert.equal(result.status, 200);
      if (view.kind === 'project-members') assert.equal('accessLost' in result.body && result.body.accessLost, true);
      else { assert.ok('project' in result.body); assert.equal(result.body.access?.capabilities.edit, false); }
      assert.equal((await app.detail(project.id, 'bob')).membersVersion, current.membersVersion + 1);
      assert.equal((await app.request('alice', `/api/projects/${project.id}/members`, 'POST', input, `remove-self-${view.kind}`)).status, view.kind === 'project-members' ? 404 : 403);
    }
    const privateProject = await app.project('Hidden alias owner', { aliases: ['reserved-alias'], access: { spaceId: 'S1', view: selected(app.alice.id), edit: selected(app.alice.id) } });
    const collision = await app.request('bob', '/api/projects', 'POST', { name: 'Visible creation', aliases: ['reserved-alias'] });
    assert.equal(collision.status, 409); assert.doesNotMatch(JSON.stringify(collision.body), new RegExp(`${privateProject.id}|Hidden alias owner`));
    const history = (await app.request<ProjectHistory>('alice', `/api/projects/${privateProject.id}/history?limit=1`)).body;
    assert.equal(history.transactions.length, 1); assert.equal(history.accessEpoch, app.policies.epoch());
    for (const query of ['limit=101', 'limit=0', 'limit=1&limit=2', 'before=0', 'viewer=bob']) assert.equal((await app.request('alice', `/api/projects/${privateProject.id}/history?${query}`)).status, 400);
  } finally { await app.close(); }
});

test('project retries preserve historical bodies, recheck selected principals and current authority, and legacy create receipts disclose no invented metadata', async () => {
  const app = await start();
  try {
    const project = await app.project('Historical project'); const before = await app.detail(project.id);
    const input = { action: 'add', principalIds: [app.bob.id], expectedCollectionVersion: before.membersVersion };
    const added = await app.request<ProjectDetail>('alice', `/api/projects/${project.id}/members`, 'POST', input, 'members-once'); assert.equal(added.status, 200);
    await app.request('alice', `/api/projects/${project.id}`, 'PATCH', { expectedVersion: 1, name: 'Current project' });
    const replay = await app.request<ProjectDetail>('alice', `/api/projects/${project.id}/members`, 'POST', input, 'members-once'); assert.equal(replay.status, 200); assert.equal(replay.body.project.name, 'Historical project'); assert.equal(replay.body.project.version, 1);
    const oldCreate = { name: 'Historical project' }; const oldBody = { id: project.id, name: 'Original bytes', description: '', color: '#2980b9' }; const bytes = JSON.stringify(oldBody);
    app.store.database.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, 201, ?, ?)').run(`${app.auth.workspaceId}:${app.alice.id}:legacy-create`, createHash('sha256').update(JSON.stringify(['POST', '/api/projects', oldCreate])).digest('hex'), bytes, new Date().toISOString());
    const legacy = await app.request<{ id: string; saved: boolean; refreshRequired: boolean; accessEpoch: number }>('alice', '/api/projects', 'POST', oldCreate, 'legacy-create'); assert.equal(legacy.status, 201); assert.equal(legacy.body.refreshRequired, true); assert.deepEqual(Object.keys(legacy.body).sort(), ['accessEpoch', 'id', 'refreshRequired', 'saved']);
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key LIKE ?').get('%:legacy-create') as { body: string }).body, bytes);
    app.auth.setAccountDisabled(app.bob.id, true);
    assert.equal((await app.request('alice', `/api/projects/${project.id}/members`, 'POST', input, 'members-once')).status, 200, 'a retained disabled member does not become a new grant');
    const disabledCurrent = await app.detail(project.id);
    assert.equal((await app.request('alice', `/api/projects/${project.id}/members`, 'POST', { action: 'set', principalIds: [app.bob.id], expectedCollectionVersion: disabledCurrent.membersVersion })).status, 200);
    assert.equal((await app.request('alice', `/api/projects/${project.id}/members`, 'POST', { action: 'add', principalIds: [app.bob.id], expectedCollectionVersion: disabledCurrent.membersVersion })).status, 200);
    assert.equal((await app.request('alice', `/api/projects/${project.id}/members`, 'POST', { action: 'remove', principalIds: [app.bob.id], expectedCollectionVersion: disabledCurrent.membersVersion })).status, 200);
    assert.equal((await app.request('alice', `/api/projects/${project.id}/members`, 'POST', input, 'members-once')).status, 400);
    assert.equal((await app.request('alice', `/api/projects/${project.id}/members`, 'POST', { action: 'add', principalIds: [app.bob.id], expectedCollectionVersion: (await app.detail(project.id)).membersVersion })).status, 400);
    app.auth.setAccountDisabled(app.bob.id, false); app.tokens.bob = app.auth.createToken(app.bob.id, { name: 'Bob enabled', scopes: ['read', 'write'] }).token;
    await app.policy(project.id, { edit: selected(app.bob.id) }, 'bob');
    assert.equal((await app.request('alice', `/api/projects/${project.id}/members`, 'POST', input, 'members-once')).status, 403);
    assert.equal((await app.request('alice', '/api/projects', 'POST', oldCreate, 'legacy-create')).status, 403);
  } finally { await app.close(); }
});

test('project policy or automatic membership revocation while a writer waits prevents mutation and saved response disclosure', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-project-authority-lock-')); const databasePath = join(directory, 'workspace.sqlite');
  const app = await start(databasePath); const transaction = app.store.transaction.bind(app.store);
  try {
    for (const source of ['policy', 'membership'] as const) for (const phase of ['write', 'replay'] as const) {
      const project = await app.project(`Locked ${source} ${phase}`, source === 'membership' ? { memberIds: [app.alice.id, app.bob.id], access: { spaceId: 'S1', view: selected(app.alice.id), edit: members, interact: workspace } } : {});
      const path = `/api/projects/${project.id}`; const input = { expectedVersion: project.version, description: 'Must not disclose or apply after revocation' }; const key = `lock-${source}-${phase}`;
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') {
        assert.equal((await app.request('bob', path, 'PATCH', input, key)).status, 200);
        replay = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as typeof replay;
        assert.ok(replay); app.store.database.prepare('DELETE FROM idempotency WHERE key = ?').run(replay.key);
      }
      const before = ['entities', 'project_profiles', 'project_transactions', 'activity'].map(table => app.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      const policy = (await app.request<ObjectAccess>('alice', `/api/policies/${project.id}`)).body.policy;
      const restricted = { ...policy, version: policy.version + 1, rules: { ...policy.rules, edit: selected(app.alice.id) } };
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads';
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(workerData.databasePath); db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
        if (workerData.source === 'membership') db.prepare("UPDATE project_relations SET active = 0, version = version + 1 WHERE project_id = ? AND principal_id = ? AND relation = 'member'").run(workerData.id, workerData.bob);
        else db.prepare('UPDATE object_policies SET data = ? WHERE object_id = ?').run(JSON.stringify(workerData.policy), workerData.id);
        db.prepare("UPDATE policy_meta SET value = value + 1 WHERE name = 'epoch'").run();
        if (workerData.replay) { const r = workerData.replay; db.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run(r.key, r.fingerprint, r.status, r.body, r.created_at); }
        parentPort.once('message', () => { db.exec('COMMIT'); db.close(); parentPort.close(); }); parentPort.postMessage('locked');
      `)}`), { workerData: { databasePath, id: project.id, bob: app.bob.id, source, policy: restricted, replay } });
      try {
        assert.deepEqual(await once(worker, 'message'), ['locked']); let entered = 0;
        app.store.transaction = function<T>(work: () => T): T { entered++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); };
        const denied = await app.request('bob', path, 'PATCH', input, key);
        assert.equal(entered, 1); assert.equal(denied.status, source === 'membership' ? 404 : 403);
        assert.deepEqual(['entities', 'project_profiles', 'project_transactions', 'activity'].map(table => app.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before);
        assert.doesNotMatch(JSON.stringify(denied.body), /Must not disclose/);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
