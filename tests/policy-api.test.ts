import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createApp, type AppOptions } from '../server/app.ts';
import { createAuth } from '../server/auth.ts';
import { createStore } from '../server/store.ts';
import type { Audience, ObjectAccess, Space } from '../shared/policy.ts';
import type { AppState, Project, Repository, RevisionDetail, ReviewAnalysis, Task, WikiDetail, WikiDocument, WikiVersion } from '../shared/types.ts';

type ErrorBody = { error: string; code?: string };
type Reply<T> = { status: number; body: T };
const workspace: Audience = { kind: 'workspace' };
const members = (...principalIds: string[]): Audience => ({ kind: 'principals', principalIds });
const paper = { testPlan: 'Fixture verification plan.', title: 'Policy test paper', kind: 'paper', files: [{ path: 'main.tex', content: '\\section{Private source}\nSource protected by the object policy.\n' }] };

async function start(options: AppOptions = {}) {
  const store = createStore({ path: options.databasePath ?? ':memory:' });
  const provisioner = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provisioner.createAccount({ username: 'alice', displayName: 'Alice Writer', password: 'Alice test password sufficiently long' });
  const bob = await provisioner.createAccount({ username: 'bob', displayName: 'Bob Reviewer', password: 'Bob test password sufficiently long' });
  if (!store.documentAtPath('/')) store.createDocument({ title: 'Wiki root', slug: '/', content: 'Document content' });
  const app = createApp({ ...options, store, seed: false, authMode: 'password' });
  const tokens = {
    alice: app.auth.createToken(alice.id, { name: 'Alice test access', scopes: ['read', 'write', 'review:local', 'review:hosted'] }).token,
    bob: app.auth.createToken(bob.id, { name: 'Bob test access', scopes: ['read', 'write', 'review:local', 'review:hosted'] }).token,
  };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const request = async <T = ErrorBody>(actor: keyof typeof tokens, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> => {
    const response = await fetch(`${origin}${path}`, {
      method, signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${tokens[actor]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as T };
  };
  const create = async <T>(actor: keyof typeof tokens, path: string, body: unknown, headers?: Record<string, string>): Promise<T> => {
    const response = await request<T>(actor, path, 'POST', body, headers);
    assert.equal(response.status, 201, `${path}: ${JSON.stringify(response.body)}`);
    return response.body;
  };
  const policy = async (actor: keyof typeof tokens, id: string) => {
    const result = await request<ObjectAccess>(actor, `/api/policies/${id}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const setPolicy = async (actor: keyof typeof tokens, id: string, changes: Partial<{ spaceId: string; view: Audience; edit: Audience; interact: Audience }> = {}) => {
    const current = (await policy(actor, id)).policy;
    const result = await request<ObjectAccess>(actor, `/api/policies/${id}`, 'PUT', { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...changes });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  return { ...app, alice, bob, request, create, policy, setPolicy, close: async () => { await app.close(); store.close(); } };
}

function denied(response: Reply<ErrorBody>, status: 403 | 404): void {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.code, status === 404 ? 'OBJECT_UNAVAILABLE' : 'ACTION_FORBIDDEN');
}

test('a private Space hides all application objects and activity even when object rules grant the workspace', async () => {
  const app = await start();
  try {
    const space = await app.create<Space>('alice', '/api/spaces', { name: 'Confidential research', description: 'A hidden Space description.' });
    assert.deepEqual(space.view, members(app.alice.id));
    assert.deepEqual(space.edit, members(app.alice.id));
    const access = { spaceId: space.id, view: workspace, edit: workspace, interact: workspace };
    const project = await app.create<Project>('alice', '/api/projects', { name: 'Hidden project marker', access });
    const repository = await app.create<Repository>('alice', '/api/repositories', { name: 'Hidden repository marker', remoteUrl: 'https://example.invalid/private.git', access });
    const task = await app.create<Task>('alice', '/api/tasks', { title: 'Hidden task marker', projectId: project.id, access });
    const document = await app.create<WikiDocument>('alice', '/api/documents', { title: 'Hidden wiki marker', slug: 'confidential-wiki', content: 'Hidden source marker', access });
    const revision = await app.create<RevisionDetail>('alice', '/api/revisions', { ...paper, title: 'Hidden paper marker', repositoryId: repository.id, projectId: project.id, access });
    const alice = (await app.request<AppState>('alice', '/api/state')).body;
    const bob = (await app.request<AppState>('bob', '/api/state')).body;
    for (const kind of ['projects', 'repositories', 'tasks', 'documents', 'revisions'] as const) {
      assert.equal(alice[kind].length, kind === 'documents' ? 2 : 1, kind);
      assert.equal(bob[kind].length, kind === 'documents' ? 1 : 0, kind);
    }
    assert.ok(bob.activity.every(event => event.objectId === 'W1'));
    assert.ok(!bob.spaces.some(item => item.id === space.id));
    for (const id of [project.id, repository.id, task.id, document.id, revision.revision.id]) assert.equal(bob.access[id], undefined, id);
    assert.doesNotMatch(JSON.stringify(bob), /Hidden|Confidential research|hidden Space description|private\.git/);
    assert.ok(bob.spaces.some(item => item.id === 'S1' && item.isDefault));
    assert.ok(bob.principals.some(item => item.id === app.bob.id));
    assert.equal(typeof bob.accessEpoch, 'number');
    assert.equal(typeof bob.canCreate, 'boolean');
  } finally { await app.close(); }
});

test('hidden and missing objects have indistinguishable history, source, export and policy responses', async () => {
  let transmissions = 0;
  const app = await start({ aiConfiguration: () => ({ configured: true, model: 'test-model' }), analyzeAI: async () => { transmissions += 1; return { provider: 'openai', model: 'test-model', summary: 'Not authorized to run.', findings: [] }; } });
  try {
    const access = { spaceId: 'S1', view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) };
    const document = await app.create<WikiDocument>('alice', '/api/documents', { title: 'Private wiki', slug: 'private-slug', content: 'Private text', access });
    const revision = await app.create<RevisionDetail>('alice', '/api/revisions', { ...paper, access });
    for (const [hidden, missing] of [
      [`/api/documents/${document.id}`, '/api/documents/W999999'],
      [`/api/documents/${document.id}/history`, '/api/documents/W999999/history'],
      [`/api/documents/${document.id}/versions/1`, '/api/documents/W999999/versions/1'],
      [`/api/revisions/${revision.revision.id}`, '/api/revisions/P999999'],
      [`/api/revisions/${revision.revision.id}/export?version=1`, '/api/revisions/P999999/export?version=1'],
      [`/api/policies/${document.id}`, '/api/policies/W999999'],
    ]) {
      const hiddenResponse = await app.request('bob', hidden!);
      denied(hiddenResponse, 404);
      assert.deepEqual(hiddenResponse, await app.request('bob', missing!));
    }
    denied(await app.request('bob', `/api/revisions/${revision.revision.id}/reviews`, 'POST', { provider: 'openai', expectedVersion: 1 }), 404);
    denied(await app.request('bob', `/api/documents/${document.id}/restore`, 'POST', { version: 1, expectedVersion: 1 }), 404);
    assert.equal(transmissions, 0);
    const hiddenSlug = await app.request('bob', '/api/documents', 'POST', { title: 'Collision', slug: 'private-slug', content: 'Document content' });
    await app.create<WikiDocument>('bob', '/api/documents', { title: 'Visible wiki', slug: 'visible-slug', content: 'Document content' });
    const visibleSlug = await app.request('bob', '/api/documents', 'POST', { title: 'Collision', slug: 'visible-slug', content: 'Document content' });
    assert.equal(hiddenSlug.status, 409);
    assert.deepEqual(hiddenSlug, visibleSlug);
    assert.equal(hiddenSlug.body.error, 'This wiki path is unavailable.');
  } finally { await app.close(); }
});

test('view, edit and interaction rules remain independent of each other and bearer-token scopes', async () => {
  let transmissions = 0;
  const app = await start({ aiConfiguration: () => ({ configured: true, model: 'test-model' }), analyzeAI: async () => { transmissions += 1; return { provider: 'openai', model: 'test-model', summary: 'Authorized review.', findings: [] }; } });
  try {
    const access = { spaceId: 'S1', view: workspace, edit: members(app.alice.id), interact: members(app.alice.id) };
    const revision = await app.create<RevisionDetail>('alice', '/api/revisions', { ...paper, access });
    const path = `/api/revisions/${revision.revision.id}`;
    assert.equal((await app.request('bob', path)).status, 200);
    const comment = { versionId: revision.versions[0]!.id, body: 'Review discussion.' };
    denied(await app.request('bob', `${path}/comments`, 'POST', comment), 403);
    denied(await app.request('bob', `${path}/reviews`, 'POST', { provider: 'openai', expectedVersion: 1 }), 403);
    denied(await app.request('bob', `${path}/versions`, 'POST', { files: paper.files, message: 'Unauthorized edit', expectedVersion: 1 }), 403);
    assert.equal(transmissions, 0);
    const permitted = await app.setPolicy('alice', revision.revision.id, { interact: workspace });
    assert.equal(permitted.capabilities.edit, true);
    const bobPolicy = await app.policy('bob', revision.revision.id);
    assert.equal(bobPolicy.capabilities.view, true); assert.equal(bobPolicy.capabilities.edit, false); assert.equal(bobPolicy.capabilities.interact, true);
    assert.equal((await app.request('bob', `${path}/comments`, 'POST', comment)).status, 201);
    const reader = app.auth.createToken(app.bob.id, { name: 'Read scope only', scopes: ['read'] });
    const readerHeaders = { Authorization: `Bearer ${reader.token}` };
    assert.equal((await app.request('bob', path, 'GET', undefined, readerHeaders)).status, 200);
    assert.equal((await app.request('bob', `${path}/comments`, 'POST', comment, readerHeaders)).status, 403);
    assert.equal((await app.request('bob', '/api/spaces', 'POST', { name: 'Scope denied' }, readerHeaders)).status, 403);
    const localReviewer = app.auth.createToken(app.bob.id, { name: 'Local review only', scopes: ['read', 'review:local'] });
    const localHeaders = { Authorization: `Bearer ${localReviewer.token}` };
    assert.equal((await app.request('bob', `${path}/reviews`, 'POST', { provider: 'local', expectedVersion: 1 }, localHeaders)).status, 201);
    assert.equal((await app.request('bob', `${path}/reviews`, 'POST', { provider: 'openai', expectedVersion: 1 }, localHeaders)).status, 403);
    assert.equal(transmissions, 0);
  } finally { await app.close(); }
});

test('hidden projects are redacted while hidden repositories gate linked revisions, with generic input rejection', async () => {
  const app = await start();
  try {
    const access = { spaceId: 'S1', view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) };
    const project = await app.create<Project>('alice', '/api/projects', { name: 'Confidential project name', access });
    const repository = await app.create<Repository>('alice', '/api/repositories', { name: 'Confidential repository name', remoteUrl: 'https://example.invalid/confidential.git', access });
    const task = await app.create<Task>('alice', '/api/tasks', { title: 'Shared task', projectId: project.id });
    const revision = await app.create<RevisionDetail>('alice', '/api/revisions', { ...paper, projectId: project.id, repositoryId: repository.id });
    const unlinked = await app.create<RevisionDetail>('alice', '/api/revisions', { ...paper, projectId: project.id });
    const state = (await app.request<AppState>('bob', '/api/state')).body;
    assert.deepEqual(state.tasks[0]!.projectIds, []);
    assert.deepEqual(state.revisions.map(item => item.id), [unlinked.revision.id]); assert.equal(state.revisions[0]!.projectId, null); assert.equal(state.revisions[0]!.repositoryId, null);
    assert.doesNotMatch(JSON.stringify(state), /Confidential project name|Confidential repository name|confidential\.git/);
    for (const suffix of ['', '/export']) {
      denied(await app.request('bob', `/api/revisions/${revision.revision.id}${suffix}`), 404);
      const response = await app.request<Pick<RevisionDetail, 'revision'>>('bob', `/api/revisions/${unlinked.revision.id}${suffix}`);
      assert.equal(response.status, 200);
      assert.equal(response.body.revision.projectId, null); assert.equal(response.body.revision.repositoryId, null);
    }
    const editBody = { title: 'Edited without changing the project', expectedVersion: task.version };
    const editHeaders = { 'Idempotency-Key': 'redact-reference-on-replay' };
    const edited = await app.request<Task>('bob', `/api/tasks/${task.id}`, 'PATCH', editBody, editHeaders);
    assert.equal(edited.status, 200); assert.deepEqual(edited.body.projectIds, []);
    assert.deepEqual(await app.request<Task>('bob', `/api/tasks/${task.id}`, 'PATCH', editBody, editHeaders), edited);
    assert.deepEqual((await app.request<AppState>('alice', '/api/state')).body.tasks[0]!.projectIds, [project.id]);
    const hiddenProject = await app.request('bob', '/api/tasks', 'POST', { title: 'Invalid reference', projectId: project.id });
    const missingProject = await app.request('bob', '/api/tasks', 'POST', { title: 'Invalid reference', projectId: 'PROJ999999' });
    assert.equal(hiddenProject.status, 400); assert.deepEqual(hiddenProject, missingProject); assert.equal(hiddenProject.body.error, 'Reference unavailable.');
    const hiddenRepository = await app.request('bob', '/api/revisions', 'POST', { ...paper, repositoryId: repository.id });
    const missingRepository = await app.request('bob', '/api/revisions', 'POST', { ...paper, repositoryId: 'R999999' });
    assert.equal(hiddenRepository.status, 400); assert.deepEqual(hiddenRepository, missingRepository);
    assert.equal((await app.request<AppState>('alice', '/api/state')).body.tasks.length, 1);
  } finally { await app.close(); }
});

test('policy version conflicts and self-lockout cannot modify source snapshots or committed permissions', async () => {
  const app = await start();
  try {
    const document = await app.create<WikiDocument>('alice', '/api/documents', { title: 'Versioned wiki', slug: 'policy-history', content: 'First source.' });
    assert.equal((await app.request('alice', `/api/documents/${document.id}`, 'PUT', { title: document.title, slug: document.slug, content: 'Second source.', expectedVersion: 1 })).status, 200);
    const before = await Promise.all([1, 2].map(version => app.request<WikiVersion>('alice', `/api/documents/${document.id}/versions/${version}`)));
    const initial = (await app.policy('alice', document.id)).policy;
    assert.equal(initial.spaceId, 'S1'); assert.deepEqual(initial.rules.view, workspace);
    const changed = await app.setPolicy('alice', document.id, { edit: members(app.alice.id) });
    assert.equal(changed.policy.version, initial.version + 1);
    const stale = await app.request('alice', `/api/policies/${document.id}`, 'PUT', { expectedVersion: initial.version, spaceId: 'S1', view: workspace, edit: workspace, interact: workspace });
    assert.equal(stale.status, 409);
    const selfLockout = await app.request('alice', `/api/policies/${document.id}`, 'PUT', { expectedVersion: changed.policy.version, spaceId: 'S1', view: members(app.bob.id), edit: members(app.bob.id), interact: members(app.bob.id) });
    assert.equal(selfLockout.status, 400);
    assert.deepEqual((await app.policy('alice', document.id)).policy, changed.policy);
    const after = await Promise.all([1, 2].map(version => app.request<WikiVersion>('alice', `/api/documents/${document.id}/versions/${version}`)));
    assert.ok(after.every((response, index) => response.body.accessEpoch! > before[index]!.body.accessEpoch!));
    const withoutEpoch = (response: Reply<WikiVersion>) => { const { accessEpoch: _epoch, ...body } = response.body; return { ...response, body }; };
    assert.deepEqual(after.map(withoutEpoch), before.map(withoutEpoch));
    const detail = (await app.request<WikiDetail>('alice', `/api/documents/${document.id}`)).body;
    assert.equal(detail.document.version, 2); assert.equal(detail.history.versions.length, 2);
    denied(await app.request('bob', `/api/documents/${document.id}`, 'PUT', { title: document.title, slug: document.slug, content: 'Denied edit.', expectedVersion: 2 }), 403);
  } finally { await app.close(); }
});

test('archived Spaces remain readable but cannot receive new objects or moved policies', async () => {
  const app = await start();
  try {
    const space = await app.create<Space>('alice', '/api/spaces', { name: 'Archive target' });
    const document = await app.create<WikiDocument>('alice', '/api/documents', { title: 'Existing archive content', slug: 'archive-content', content: 'Still readable.', access: { spaceId: space.id } });
    const other = await app.create<Task>('alice', '/api/tasks', { title: 'Must remain outside archive' });
    const archived = await app.request<Space>('alice', `/api/spaces/${space.id}`, 'PATCH', { expectedVersion: space.version, archived: true });
    assert.equal(archived.status, 200); assert.equal(archived.body.archived, true);
    assert.equal((await app.request('alice', `/api/documents/${document.id}`)).status, 200);
    assert.equal((await app.request('alice', `/api/documents/${document.id}/history`)).status, 200);
    const stale = await app.request('alice', `/api/spaces/${space.id}`, 'PATCH', { expectedVersion: space.version, name: 'Stale name' });
    assert.equal(stale.status, 409);
    const creation = await app.request('alice', '/api/tasks', 'POST', { title: 'Cannot enter archive', access: { spaceId: space.id } });
    assert.equal(creation.status, 409, JSON.stringify(creation));
    const current = (await app.policy('alice', other.id)).policy;
    const moved = await app.request('alice', `/api/policies/${other.id}`, 'PUT', { expectedVersion: current.version, spaceId: space.id, ...current.rules });
    assert.equal(moved.status, 409, JSON.stringify(moved));
    assert.deepEqual((await app.policy('alice', other.id)).policy, current);
    assert.equal((await app.request<AppState>('alice', '/api/state')).body.tasks.length, 1);
  } finally { await app.close(); }
});

test('permission changes block create and mutation replay without granting an implicit creator bypass', async () => {
  const app = await start();
  try {
    const createBody = { title: 'Creator loses access' };
    const createHeaders = { 'Idempotency-Key': 'creator-no-longer-authorized' };
    const task = await app.create<Task>('alice', '/api/tasks', createBody, createHeaders);
    const beforeEpoch = (await app.request<AppState>('alice', '/api/state')).body.accessEpoch;
    await app.setPolicy('bob', task.id, { view: members(app.bob.id), edit: members(app.bob.id), interact: members(app.bob.id) });
    denied(await app.request('alice', '/api/tasks', 'POST', createBody, createHeaders), 404);
    denied(await app.request('alice', `/api/policies/${task.id}`), 404);
    const after = (await app.request<AppState>('alice', '/api/state')).body;
    assert.notEqual(after.accessEpoch, beforeEpoch); assert.equal(after.tasks.length, 0);
    const editable = await app.create<Task>('alice', '/api/tasks', { title: 'Edit authority later removed' });
    const editBody = { title: 'Previously committed edit', expectedVersion: editable.version };
    const editHeaders = { 'Idempotency-Key': 'edit-no-longer-authorized' };
    assert.equal((await app.request('alice', `/api/tasks/${editable.id}`, 'PATCH', editBody, editHeaders)).status, 200);
    await app.setPolicy('bob', editable.id, { edit: members(app.bob.id) });
    denied(await app.request('alice', `/api/tasks/${editable.id}`, 'PATCH', editBody, editHeaders), 403);
    const space = await app.create<Space>('alice', '/api/spaces', { name: 'Space access later removed', view: workspace, edit: workspace });
    const spaceBody = { title: 'Previously authorized Space creation', access: { spaceId: space.id } };
    const spaceHeaders = { 'Idempotency-Key': 'space-no-longer-authorized' };
    await app.create<Task>('alice', '/api/tasks', spaceBody, spaceHeaders);
    assert.equal((await app.request('bob', `/api/spaces/${space.id}`, 'PATCH', { expectedVersion: space.version, view: members(app.bob.id), edit: members(app.bob.id) })).status, 200);
    denied(await app.request('alice', '/api/tasks', 'POST', spaceBody, spaceHeaders), 404);
    denied(await app.request('alice', '/api/tasks', 'POST', { ...spaceBody, title: 'New object after Space revocation' }), 404);
    assert.equal((await app.request<AppState>('bob', '/api/state')).body.tasks.length, 3);
  } finally { await app.close(); }
});

test('revoking object access during hosted review discards evidence and idempotent responses', async () => {
  let started!: () => void;
  let finish!: (analysis: ReviewAnalysis) => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const result = new Promise<ReviewAnalysis>(resolve => { finish = resolve; });
  const analysis: ReviewAnalysis = { provider: 'openai', model: 'test-model', summary: 'No longer authorized at commit.', findings: [] };
  const app = await start({ aiConfiguration: () => ({ configured: true, model: 'test-model' }), analyzeAI: async () => { started(); return result; } });
  try {
    // The reviewer is independent of the current author, whose automatic access survives object-rule changes.
    const revision = await app.create<RevisionDetail>('bob', '/api/revisions', paper);
    const pending = app.request('alice', `/api/revisions/${revision.revision.id}/reviews`, 'POST', { provider: 'openai', expectedVersion: 1 }, { 'Idempotency-Key': 'policy-changed-during-ai' });
    await Promise.race([began, pending.then(response => { throw new Error(`Review ended with ${response.status} before invoking the provider.`); })]);
    await app.setPolicy('bob', revision.revision.id, { view: members(app.bob.id), edit: members(app.bob.id), interact: members(app.bob.id) });
    finish(analysis);
    denied(await pending, 404);
    const detail = (await app.request<RevisionDetail>('bob', `/api/revisions/${revision.revision.id}`)).body;
    assert.equal(detail.reviews.length, 0);
    assert.equal(detail.activity.filter(item => item.action === 'reviewed').length, 0);
    assert.equal((app.store.database.prepare('SELECT count(*) AS count FROM idempotency').get() as { count: number }).count, 0);
  } finally { finish(analysis); await app.close(); }
});

test('a competing SQLite policy revocation prevents writes and replay disclosure after the write lock is acquired', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phabricator-policy-lock-'));
  const databasePath = join(directory, 'workspace.sqlite');
  const app = await start({ databasePath });
  const transaction = app.store.transaction.bind(app.store);
  try {
    for (const phase of ['write', 'replay'] as const) {
      const task = await app.create<Task>('alice', '/api/tasks', { title: `Concurrent policy ${phase}` });
      const path = `/api/tasks/${task.id}`;
      const body = { title: `A ${phase} requiring current authority`, expectedVersion: task.version };
      const headers = { 'Idempotency-Key': `policy-lock-${phase}` };
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') {
        assert.equal((await app.request('alice', path, 'PATCH', body, headers)).status, 200);
        replay = app.store.database.prepare('SELECT * FROM idempotency ORDER BY created_at DESC LIMIT 1').get() as typeof replay;
        assert.ok(replay);
        app.store.database.prepare('DELETE FROM idempotency WHERE key = ?').run(replay.key);
      }
      const current = (await app.policy('alice', task.id)).policy;
      const restricted = { ...current, version: current.version + 1, rules: { view: members(app.bob.id), edit: members(app.bob.id), interact: members(app.bob.id) } };
      const before = (await app.request<AppState>('bob', '/api/state')).body.tasks.find(item => item.id === task.id);
      const activityCount = app.store.activities().length;
      const replayCount = (app.store.database.prepare('SELECT count(*) AS count FROM idempotency').get() as { count: number }).count;
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads';
        import { DatabaseSync } from 'node:sqlite';
        const database = new DatabaseSync(workerData.databasePath);
        database.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
        database.prepare('UPDATE object_policies SET data = ? WHERE object_id = ?').run(JSON.stringify(workerData.policy), workerData.policy.objectId);
        database.prepare("UPDATE policy_meta SET value = value + 1 WHERE name = 'epoch'").run();
        if (workerData.replay) {
          const row = workerData.replay;
          database.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run(row.key, row.fingerprint, row.status, row.body, row.created_at);
        }
        parentPort.once('message', () => { database.exec('COMMIT'); database.close(); parentPort.close(); });
        parentPort.postMessage('locked');
      `)}`), { workerData: { databasePath, policy: restricted, replay } });
      let workerFailure: Error | undefined;
      worker.on('error', error => { workerFailure = error; });
      let entered = 0;
      try {
        assert.deepEqual(await once(worker, 'message'), ['locked']);
        // The HTTP prechecks read the old allowed policy through WAL. The
        // actual competing writer commits only when this request acquires its
        // lock; its protected response may become visible at that same point.
        app.store.transaction = function<T>(work: () => T): T {
          entered += 1; app.store.transaction = transaction;
          worker.postMessage('commit'); return transaction(work);
        };
        const response = await app.request('alice', path, 'PATCH', body, headers);
        assert.equal(workerFailure, undefined);
        assert.equal(entered, 1, phase);
        denied(response, 404);
        assert.equal('id' in response.body, false);
        const after = (await app.request<AppState>('bob', '/api/state')).body.tasks.find(item => item.id === task.id);
        assert.deepEqual(after, before, phase);
        assert.equal(app.store.activities().length, activityCount, phase);
        assert.equal((app.store.database.prepare('SELECT count(*) AS count FROM idempotency').get() as { count: number }).count, replayCount + (phase === 'replay' ? 1 : 0), phase);
        assert.deepEqual((await app.policy('bob', task.id)).policy, restricted);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
