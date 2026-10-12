import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import { evaluateRevisionView, validRevisionViewResult, type RevisionViewFilters, type RevisionViewResult, type RevisionViewSnapshot, type RevisionViewsSnapshot } from '../shared/revision-views.ts';
import type { AppState, ActorAttribution } from '../shared/types.ts';

const filters = (patch: Partial<RevisionViewFilters> = {}): RevisionViewFilters => ({ kind: 'paper', query: '', status: 'all', projectId: null, following: false, authored: false, ...patch });
type ErrorBody = { error: string; code?: string };
async function fixture(basePath = '/') {
  const store = new Store({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const password = 'Saved view API fixture password';
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }) };
  const actor: ActorAttribution = { principalId: alice.id, displayName: alice.displayName, credentialId: tokens.alice.record.id, requestId: 'revision-view-api' };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath.replace(/\/$/, '')}`;
  const raw = async <T = ErrorBody>(path: string, method = 'GET', body?: string, who: keyof typeof tokens = 'alice', key?: string) => {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${tokens[who].token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body }) });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  };
  const request = <T = ErrorBody>(path: string, method = 'GET', value?: unknown, who: keyof typeof tokens = 'alice', key?: string) => raw<T>(path, method, value === undefined ? undefined : JSON.stringify(value), who, key);
  const input = (name = 'My papers', patch: Partial<RevisionViewFilters> = {}) => ({ name, filters: filters(patch), expectedAccessEpoch: app.policies.epoch() });
  const save = async (data = input(), who: keyof typeof tokens = 'alice', key = randomUUID()) => {
    const response = await request<RevisionViewResult>('/api/revision-views', 'POST', data, who, key);
    assert.equal(response.status, 200, JSON.stringify(response.body)); assert.ok(validRevisionViewResult(response.body, 'create', data));
    return { data, key, receipt: response.body, id: response.body.view.id };
  };
  const policy = (id: string, visible: boolean) => {
    const current = app.policies.policy(id, alice.id);
    app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, view: visible ? { kind: 'workspace' } : { kind: 'principals', principalIds: [alice.id] } }, alice.id);
  };
  return { ...app, alice, bob, actor, tokens, raw, request, input, save, policy, close: async () => { await app.close(); store.close(); } };
}

for (const mount of ['/', '/mounted/']) test(`saved-view API keeps owner discovery private and resolves ownership before parsing at ${mount}`, async () => {
  const f = await fixture(mount);
  try {
    const before = f.store.state({ configured: false, model: null }), saved = await f.save(f.input('Private @bob research', { query: 'Private literal [draft]' }));
    const mine = await f.request<RevisionViewsSnapshot>('/api/revision-views');
    assert.equal(mine.status, 200); assert.equal(mine.headers.get('cache-control'), 'no-store'); assert.deepEqual(mine.body.views, [saved.receipt.view]);
    assert.deepEqual((await f.request<RevisionViewsSnapshot>('/api/revision-views', 'GET', undefined, 'bob')).body.views, []);
    assert.deepEqual((await f.request<RevisionViewSnapshot>(`/api/revision-views/${saved.id}`)).body.view, saved.receipt.view);
    for (const suffix of ['', '?ownerId=' + f.alice.id]) {
      const foreign = await f.request(`/api/revision-views/${saved.id}${suffix}`, 'GET', undefined, 'bob');
      const missing = await f.request(`/api/revision-views/RV99999${suffix}`, 'GET', undefined, 'bob');
      assert.equal(foreign.status, 404); assert.deepEqual(foreign.body, missing.body);
    }
    for (const [method, suffix] of [['PUT', ''], ['POST', '/delete']] as const) {
      const foreign = await f.raw(`/api/revision-views/${saved.id}${suffix}?unsupported=1`, method, '{invalid', 'bob');
      const missing = await f.raw(`/api/revision-views/RV99999${suffix}?unsupported=1`, method, '{invalid', 'bob');
      assert.equal(foreign.status, 404); assert.deepEqual(foreign.body, missing.body);
    }
    assert.equal((await f.request('/api/revision-views?ownerId=' + f.alice.id)).status, 400);
    assert.equal((await f.request(`/api/revision-views/${saved.id}?ownerId=` + f.alice.id)).status, 400);
    assert.equal((await f.request('/api/revision-views', 'POST', { ...f.input('Injected owner'), principalId: f.bob.id }, 'alice', randomUUID())).status, 400);
    assert.equal((await f.request('/api/revision-views', 'POST', f.input())).status, 400);
    assert.deepEqual(f.store.state({ configured: false, model: null }), before);
    assert.equal(f.store.notifications.summary(f.bob.id, f.policies.epoch()).unreadCount, 0);
    assert.doesNotMatch(JSON.stringify((await f.request('/api/state', 'GET', undefined, 'bob')).body), /Private literal|Private @bob/);
    const sameKey = await f.save(saved.data, 'bob', saved.key); assert.notEqual(sameKey.id, saved.id);
  } finally { await f.close(); }
});

test('saved-view retries preserve immutable historical results through edit, access changes and terminal deletion', async () => {
  const f = await fixture();
  try {
    const saved = await f.save(), route = `/api/revision-views/${saved.id}`, edit = { ...f.input('Renamed'), expectedVersion: 1 }, key = randomUUID();
    const edited = await f.request<RevisionViewResult>(route, 'PUT', edit, 'alice', key); assert.equal(edited.status, 200); assert.equal(edited.body.view.version, 2);
    assert.equal((await f.request(route, 'PUT', edit, 'alice', randomUUID())).status, 409);
    assert.equal((await f.request(route, 'PUT', { ...edit, name: 'Different intent' }, 'alice', key)).status, 409);
    f.store.database.exec("UPDATE policy_meta SET value=value+1 WHERE name='epoch'");
    const oldCreate = await f.request<RevisionViewResult>('/api/revision-views', 'POST', saved.data, 'alice', saved.key);
    assert.equal(oldCreate.status, 200); assert.deepEqual(oldCreate.body.view, saved.receipt.view); assert.equal(oldCreate.body.accessEpoch, f.policies.epoch());
    assert.equal((await f.request(route, 'PUT', { ...edit, expectedVersion: 2 }, 'alice', randomUUID())).status, 409);
    const deletion = { expectedVersion: 2, expectedAccessEpoch: f.policies.epoch() }, deleteKey = randomUUID();
    const removed = await f.request<RevisionViewResult>(route + '/delete', 'POST', deletion, 'alice', deleteKey); assert.equal(removed.status, 200); assert.ok(removed.body.deleted); assert.equal(removed.body.view.version, 3);
    assert.equal((await f.request(route)).status, 404); assert.deepEqual((await f.request<RevisionViewsSnapshot>('/api/revision-views')).body.views, []);
    assert.deepEqual((await f.request<RevisionViewResult>(route + '/delete', 'POST', deletion, 'alice', deleteKey)).body, removed.body);
    assert.deepEqual((await f.request<RevisionViewResult>(route, 'PUT', edit, 'alice', key)).body, { ...edited.body, accessEpoch: f.policies.epoch() });
    assert.equal((await f.request(route, 'PUT', { ...f.input('No resurrection'), expectedVersion: 3 }, 'alice', randomUUID())).status, 409);
  } finally { await f.close(); }
});

test('saved project constraints survive later access loss without names or broadened results', async () => {
  const f = await fixture();
  try {
    const project = f.store.createProject({ name: 'Confidential project label' }, f.actor); f.policy(project.id, true);
    const saved = await f.save(f.input('Matter search', { projectId: project.id }), 'bob');
    f.policy(project.id, false);
    const got = await f.request<RevisionViewSnapshot>(`/api/revision-views/${saved.id}`, 'GET', undefined, 'bob'); assert.equal(got.status, 200); assert.equal(got.body.view.filters.projectId, project.id);
    assert.doesNotMatch(JSON.stringify(got.body), /Confidential project label/);
    const state = await f.request<AppState>('/api/state', 'GET', undefined, 'bob'); assert.ok(!state.body.projects.some(p => p.id === project.id)); assert.deepEqual(evaluateRevisionView(got.body.view.filters, state.body), []);
    assert.equal((await f.request('/api/revision-views', 'POST', f.input('New invisible filter', { projectId: project.id }), 'bob', randomUUID())).status, 404);
    assert.equal((await f.request('/api/revision-views', 'POST', f.input('Missing filter', { projectId: 'PROJ99999' }), 'bob', randomUUID())).status, 404);
    const renamed = await f.request<RevisionViewResult>(`/api/revision-views/${saved.id}`, 'PUT', { ...f.input('Renamed unavailable matter', { projectId: project.id }), expectedVersion: 1 }, 'bob', randomUUID());
    assert.equal(renamed.status, 200); assert.equal(renamed.body.view.filters.projectId, project.id);
    assert.equal((await f.request(`/api/revision-views/${saved.id}`, 'PUT', { ...f.input('Changed unavailable', { projectId: 'PROJ99999' }), expectedVersion: 2 }, 'bob', randomUUID())).status, 404);
    assert.equal((await f.request(`/api/revision-views/${saved.id}/delete`, 'POST', { expectedVersion: 2, expectedAccessEpoch: f.policies.epoch() }, 'bob', randomUUID())).status, 200);
  } finally { await f.close(); }
});

test('saved-view presenter rejects foreign and same-owner receipt substitutions without exposing contents', async () => {
  const f = await fixture();
  try {
    const one = await f.save(f.input('First private view')), two = await f.save(f.input('Second private view')), foreign = await f.save(f.input('Bob secret view'), 'bob');
    const row = f.store.database.prepare('SELECT key,body FROM idempotency WHERE key LIKE ?').get(`%:${one.key}`) as { key: string; body: string };
    for (const value of [two.receipt, foreign.receipt, { ...one.receipt, view: { ...one.receipt.view, name: 'Forged value' } }]) {
      f.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(value), row.key);
      const replay = await f.request('/api/revision-views', 'POST', one.data, 'alice', one.key);
      assert.equal(replay.status, 409); assert.doesNotMatch(JSON.stringify(replay.body), /Second private view|Bob secret view|Forged value/);
    }
    f.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key);
    assert.deepEqual((await f.request('/api/revision-views', 'POST', one.data, 'alice', one.key)).body, one.receipt);
    assert.equal((await f.request<RevisionViewsSnapshot>('/api/revision-views')).body.views.length, 2);
  } finally { await f.close(); }
});
