import { lifecycleAction } from '../tests/revision-lifecycle-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import { registerFilePolicy } from './policy.ts';
import type { SessionState } from '../shared/auth.ts';
import type { RevisionDependencyInput, RevisionDependencyPage, RevisionDependencyHistory, RevisionDependencyReceipt } from '../shared/revision-dependencies.ts';

const workspace = { kind: 'workspace' as const };
const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
type ErrorBody = { error: string; code?: string };
async function start(basePath = '/') {
  const store = new Store({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice Writer', password: 'Alice dependency test password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob Writer', password: 'Bob dependency test password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const tokens = {
    alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }),
    bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }),
    reader: app.auth.createToken(bob.id, { name: 'Reader', scopes: ['read'] }),
  };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, url = (path: string) => origin + basePath.replace(/\/$/, '') + path;
  async function request<T = ErrorBody>(path: string, method = 'GET', input?: unknown, actor: keyof typeof tokens | null = 'alice', key?: string, extra: Record<string, string> = {}) {
    const response = await fetch(url(path), { method, signal: AbortSignal.timeout(15_000), headers: { ...(actor ? { Authorization: `Bearer ${tokens[actor].token}` } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}), ...extra }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, headers: response.headers, body: await response.json() as T };
  }
  const actor = { principalId: alice.id, displayName: 'Alice Writer', credentialId: tokens.alice.record.id, requestId: 'setup' };
  function revision(kind: 'code' | 'paper' | 'document' = 'code', additional = {}) { return store.createRevision({ testPlan: 'Fixture verification plan.', kind, title: `${kind} revision`, files: [{ path: kind === 'paper' ? 'main.tex' : 'source.txt', content: 'Original exact source\n' }], ...additional }, actor); }
  const policy = (id: string, changes: Record<string, unknown>) => { const current = app.policies.policy(id, alice.id); return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...changes }, alice.id); };
  const path = (id: string) => `/api/revisions/${id}/dependencies`;
  const input = (id: string, add: string[], remove: string[] = [], direction: 'parents' | 'children' = 'parents'): RevisionDependencyInput => ({ direction, add, remove, expectedRelationshipVersion: store.revisionDependencies.version(id), expectedAccessEpoch: app.policies.epoch() });
  let sequence = 0;
  async function change(id: string, add: string[], remove: string[] = [], direction: 'parents' | 'children' = 'parents') {
    const body = input(id, add, remove, direction), key = `change-${++sequence}`, result = await request<RevisionDependencyReceipt>(path(id), 'POST', body, 'alice', key);
    assert.equal(result.status, 200, JSON.stringify(result.body)); return { ...result, input: body, key };
  }
  return { ...app, store, alice, bob, actor, tokens, origin, url, request, revision, policy, path, input, change, close: async () => { await app.close(); store.close(); } };
}

for (const basePath of ['/', '/mounted/']) test(`revision dependencies join code, papers and documents without changing source or acceptance at ${basePath}`, async () => {
  const app = await start(basePath);
  try {
    const code = app.revision(), paper = app.revision('paper'), document = app.revision('document');
    app.store.saveReview(code.revision.id, 1, { provider: 'local', model: 'checks', summary: 'Passed', findings: [] }, app.actor);
    lifecycleAction(app.store, code.revision.id, 'accept_reviewed', app.actor);
    const before = [code, paper, document].map(item => { const detail = app.store.detail(item.revision.id); return { revision: detail.revision, versions: detail.versions, reviews: detail.reviews }; });
    app.policy(paper.revision.id, { edit: members(app.alice.id) });
    const body = app.input(code.revision.id, [paper.revision.id, document.revision.id]);
    const result = await app.request<RevisionDependencyReceipt>(app.path(code.revision.id), 'POST', body, 'bob', 'cross-kind');
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.relationshipVersion, 1);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(result.body).sort(), ['accessEpoch', 'changes', 'createdAt', 'operationId', 'relationshipVersion', 'revisionId']);
    const page = await app.request<RevisionDependencyPage>(app.path(code.revision.id) + '?direction=parents', 'GET', undefined, 'reader');
    assert.deepEqual(page.body.revisions.map(item => item.id), [document.revision.id, paper.revision.id].sort());
    assert.equal(page.body.accessEpoch, app.policies.epoch());
    for (const peer of [paper, document]) {
      const inverse = await app.request<RevisionDependencyPage>(app.path(peer.revision.id) + '?direction=children');
      assert.deepEqual(inverse.body.revisions.map(item => item.id), [code.revision.id]); assert.equal(inverse.body.relationshipVersion, 1);
      const history = await app.request<RevisionDependencyHistory>(app.path(peer.revision.id) + '/history');
      assert.equal(history.body.transactions[0]!.attribution.principalId, app.bob.id); assert.equal(history.body.transactions[0]!.change.direction, 'children');
    }
    assert.deepEqual([code, paper, document].map(item => { const detail = app.store.detail(item.revision.id); return { revision: detail.revision, versions: detail.versions, reviews: detail.reviews }; }), before);
    assert.equal((await app.request(app.path(code.revision.id), 'POST', body, 'reader', 'read-only')).status, 403);
    app.policy(code.revision.id, { edit: members(app.alice.id), interact: workspace });
    assert.equal((await app.request(app.path(code.revision.id), 'POST', body, 'bob', 'cross-kind')).status, 403, 'replay still requires source edit');
  } finally { await app.close(); }
});

test('revision relations and history filter each current peer independently without granting source or peer access', async () => {
  const app = await start();
  try {
    const source = app.revision(), peers = [app.revision(), app.revision(), app.revision()];
    await app.change(source.revision.id, peers.map(peer => peer.revision.id));
    app.policy(peers[1]!.revision.id, { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) });
    const root = app.path(source.revision.id), first = await app.request<RevisionDependencyPage>(root + '?direction=parents&limit=1', 'GET', undefined, 'bob');
    assert.equal(first.body.revisions.length, 1); assert.equal(first.body.nextAfter, peers[0]!.revision.id);
    const second = await app.request<RevisionDependencyPage>(root + `?direction=parents&limit=1&after=${first.body.nextAfter}&expectedRelationshipVersion=1`, 'GET', undefined, 'bob');
    assert.deepEqual(second.body.revisions.map(item => item.id), [peers[2]!.revision.id]); assert.equal(second.body.nextAfter, null);
    const history = await app.request<RevisionDependencyHistory>(root + '/history?limit=1', 'GET', undefined, 'bob');
    const older = await app.request<RevisionDependencyHistory>(root + `/history?limit=1&before=${history.body.nextBefore}`, 'GET', undefined, 'bob');
    assert.equal(older.body.transactions.length, 1); assert.equal(older.body.nextBefore, null);
    for (const response of [first, second, history, older]) assert.equal(JSON.stringify(response.body).includes(peers[1]!.revision.id), false);
    assert.equal((await app.request(`/api/revisions/${peers[1]!.revision.id}`, 'GET', undefined, 'bob')).status, 404);
    const hidden = await app.request(root, 'POST', app.input(source.revision.id, [], [peers[1]!.revision.id]), 'bob', 'hidden-remove');
    const missing = await app.request(root, 'POST', app.input(source.revision.id, ['D99999']), 'bob', 'missing-add');
    assert.equal(hidden.status, 404); assert.deepEqual(hidden.body, missing.body);
    assert.equal(hidden.body.code, 'REVISION_DEPENDENCY_UNAVAILABLE');
    app.policy(source.revision.id, { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) });
    assert.equal((await app.request<RevisionDependencyPage>(app.path(peers[0]!.revision.id) + '?direction=children', 'GET', undefined, 'bob')).body.revisions.length, 0);
    assert.equal((await app.request(root + '/history', 'GET', undefined, 'bob')).status, 404);
  } finally { await app.close(); }
});

test('exact dependency batches prevent cycles through hidden intermediate nodes and roll back all edits', async () => {
  const app = await start();
  try {
    const a = app.revision(), hidden = app.revision(), c = app.revision(), other = app.revision();
    await app.change(a.revision.id, [hidden.revision.id]); await app.change(hidden.revision.id, [c.revision.id]);
    app.policy(hidden.revision.id, { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) });
    const attempted = app.input(c.revision.id, [other.revision.id, a.revision.id]);
    const cycle = await app.request(app.path(c.revision.id), 'POST', attempted, 'bob', 'hidden-cycle');
    assert.equal(cycle.status, 409); assert.equal(cycle.body.code, 'REVISION_DEPENDENCY_CYCLE'); assert.equal(JSON.stringify(cycle.body).includes(hidden.revision.id), false);
    assert.equal(app.store.revisionDependencies.version(c.revision.id), 1); assert.equal(app.store.revisionDependencies.version(other.revision.id), 0);
    const page = await app.request<RevisionDependencyPage>(app.path(c.revision.id) + '?direction=parents'); assert.deepEqual(page.body.revisions, []);
    const before = app.store.database.prepare('SELECT * FROM revision_dependency_edges ORDER BY child_id,parent_id').all();
    const concurrent = app.input(a.revision.id, [other.revision.id]);
    const attempts = await Promise.all(['concurrent-a', 'concurrent-b'].map(key => app.request(app.path(a.revision.id), 'POST', concurrent, 'alice', key)));
    assert.deepEqual(attempts.map(item => item.status).sort(), [200, 409]);
    assert.equal(app.store.database.prepare('SELECT COUNT(*) AS n FROM revision_dependency_edges').get()!.n, before.length + 1);
    const stale = await app.request(app.path(a.revision.id) + '?direction=parents&expectedRelationshipVersion=1');
    assert.equal(stale.status, 409); assert.equal(stale.body.code, 'REVISION_DEPENDENCIES_CHANGED');
    const swap = await app.change(a.revision.id, [c.revision.id], [hidden.revision.id]); assert.equal(swap.body.changes[0]!.action, 'removed');
    assert.equal((await app.request(app.path(a.revision.id), 'POST', app.input(a.revision.id, [c.revision.id]), 'alice', 'exists')).body.code, 'REVISION_DEPENDENCY_EXISTS');
    assert.equal((await app.request(app.path(a.revision.id), 'POST', app.input(a.revision.id, [], [hidden.revision.id]), 'alice', 'missing')).body.code, 'REVISION_DEPENDENCY_MISSING');
  } finally { await app.close(); }
});

test('saved dependency receipts survive later graph edits and credential rotation but not revoked current references', async () => {
  const app = await start();
  try {
    const source = app.revision(), a = app.revision(), b = app.revision();
    const first = await app.change(source.revision.id, [b.revision.id, a.revision.id]);
    await app.change(source.revision.id, [], [a.revision.id]);
    app.tokens.alice = app.auth.createToken(app.alice.id, { name: 'Rotated', scopes: ['read', 'write'] });
    const replay = await app.request<RevisionDependencyReceipt>(app.path(source.revision.id), 'POST', { ...first.input, add: [...first.input.add].reverse() }, 'alice', first.key);
    assert.equal(replay.status, 200); assert.deepEqual(replay.body, first.body); assert.equal(replay.body.relationshipVersion, 1);
    assert.equal((await app.request(app.path(source.revision.id), 'POST', { ...first.input, remove: [a.revision.id], add: [] }, 'alice', first.key)).status, 409);
    const space = app.policies.createSpace({ name: 'Private peer', view: workspace, edit: members(app.alice.id) }, app.alice.id);
    app.policy(a.revision.id, { spaceId: space.id });
    const bobInput = app.input(source.revision.id, [a.revision.id]);
    assert.equal((await app.request(app.path(source.revision.id), 'POST', bobInput, 'bob', 'bob-request')).status, 200);
    app.policies.updateSpace(space.id, { expectedVersion: space.version, view: members(app.alice.id) }, app.alice.id);
    const denied = await app.request(app.path(source.revision.id), 'POST', bobInput, 'bob', 'bob-request');
    assert.equal(denied.status, 404); assert.equal(denied.body.code, 'REVISION_DEPENDENCY_UNAVAILABLE');
    assert.equal((await app.request(app.path(source.revision.id) + '?direction=parents', 'GET', undefined, 'bob')).status, 200, 'a hidden dependency does not hide the source');
    app.auth.revokeToken(app.bob.id, app.tokens.bob.record.id);
    assert.equal((await app.request(app.path(source.revision.id), 'POST', bobInput, 'bob', 'bob-request')).status, 401);
  } finally { await app.close(); }
});

test('canonical saved receipt substitutions cannot borrow another request, author, revision, or hidden operation', async () => {
  const app = await start();
  try {
    const source = app.revision(), peer = app.revision(), other = app.revision(), hidden = app.revision();
    const original = await app.change(source.revision.id, [peer.revision.id]);
    const next = await app.change(source.revision.id, [other.revision.id]);
    const foreign = await app.change(hidden.revision.id, [peer.revision.id]);
    const row = app.store.database.prepare('SELECT key,body FROM idempotency WHERE key LIKE ?').get(`%:${original.key}`) as { key: string; body: string };
    assert.ok(row);
    const current = app.policies.policy(hidden.revision.id, app.bob.id);
    app.policies.setPolicy(hidden.revision.id, { expectedVersion: current.version, spaceId: current.spaceId, view: members(app.bob.id), edit: members(app.bob.id), interact: members(app.bob.id) }, app.bob.id);
    const canonical = app.store.revisionDependencies.receipt.bind(app.store.revisionDependencies); let hiddenLoads = 0;
    app.store.revisionDependencies.receipt = id => { if (id === foreign.body.operationId) hiddenLoads++; return canonical(id); };
    for (const substitute of [next.body, foreign.body, { ...original.body, operationId: foreign.body.operationId }, { ...original.body, operationId: 'missing' }, { ...original.body, changes: [] }]) {
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(substitute), row.key);
      const result = await app.request(app.path(source.revision.id), 'POST', original.input, 'alice', original.key);
      assert.equal(result.status, 409); assert.equal(result.body.code, 'REVISION_DEPENDENCY_INVALID_RECEIPT');
    }
    assert.equal(hiddenLoads, 0, 'owner check precedes hidden operation content loading');
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key);
    assert.equal((await app.request(app.path(source.revision.id), 'POST', original.input, 'alice', original.key)).status, 200);
    const bobBody = app.input(source.revision.id, [], [other.revision.id]);
    const bob = await app.request<RevisionDependencyReceipt>(app.path(source.revision.id), 'POST', bobBody, 'bob', 'bob-operation'); assert.equal(bob.status, 200);
    const operation = canonical(bob.body.operationId);
    app.store.revisionDependencies.receipt = id => id === original.body.operationId ? { ...canonical(id), attribution: operation.attribution } : canonical(id);
    assert.equal((await app.request(app.path(source.revision.id), 'POST', original.input, 'alice', original.key)).body.code, 'REVISION_DEPENDENCY_INVALID_RECEIPT');
  } finally { await app.close(); }
});

test('revision dependency authority includes repository and historical source File ceilings', async () => {
  const app = await start();
  try {
    const source = app.revision();
    const repository = app.store.createRepository({ name: 'Restricted repository', remoteUrl: 'https://example.com/source.git' }, app.actor);
    const code = app.revision('code', { repositoryId: repository.id });
    app.policy(repository.id, { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) });
    assert.equal((await app.request(app.path(source.revision.id), 'POST', app.input(source.revision.id, [code.revision.id]), 'bob', 'repository-ceiling')).body.code, 'REVISION_DEPENDENCY_UNAVAILABLE');
    const bytes = Buffer.from('%PDF-1.4\nFigure original');
    const file = app.store.files.upload({ name: 'figure.pdf', dataBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, app.actor);
    registerFilePolicy(app.store.database, file.id, app.alice.id);
    const paper = app.revision('paper', { assets: [{ path: 'figure.pdf', fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: 'application/pdf' }], shareAssets: true });
    await app.change(source.revision.id, [paper.revision.id]);
    const space = app.policies.createSpace({ name: 'Figure ceiling', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy(file.id, { spaceId: space.id });
    const read = await app.request<RevisionDependencyPage>(app.path(source.revision.id) + '?direction=parents', 'GET', undefined, 'bob'); assert.deepEqual(read.body.revisions, []);
    assert.equal((await app.request(app.path(source.revision.id), 'POST', app.input(source.revision.id, [], [paper.revision.id]), 'bob', 'figure-ceiling')).body.code, 'REVISION_DEPENDENCY_UNAVAILABLE');
  } finally { await app.close(); }
});

test('strict dependency transport rejects ambiguous parameters, stale access and missing CSRF before mutation', async () => {
  const app = await start('/mounted/');
  try {
    const source = app.revision(), peer = app.revision(), path = app.path(source.revision.id), input = app.input(source.revision.id, [peer.revision.id]);
    for (const query of ['', '?direction=invalid', '?direction=parents&direction=children', '?direction=parents&limit=101', '?direction=parents&after=', '?direction=parents&expectedRelationshipVersion=-1', '?direction=parents&unexpected=secret', '/history?direction=parents', '/history?before=0']) assert.equal((await app.request(path + query)).status, 400, query);
    assert.equal((await app.request(path, 'POST', input)).status, 400);
    for (const value of [{ ...input, extra: 'private' }, { ...input, add: [] }, { ...input, add: [peer.revision.id, peer.revision.id] }, { ...input, expectedRelationshipVersion: -1 }, { ...input, add: [source.revision.id] }]) assert.equal((await app.request(path, 'POST', value, 'alice', 'bad-input')).status, 400);
    app.policy(peer.revision.id, { edit: members(app.alice.id) });
    assert.equal((await app.request(path, 'POST', input, 'alice', 'old-epoch')).body.code, 'ACCESS_EPOCH_CHANGED');
    const boot = await app.request<SessionState>('/api/session', 'GET', undefined, null);
    const cookie = boot.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
    const login = await app.request<SessionState>('/api/login', 'POST', { username: 'alice', password: 'Alice dependency test password' }, null, undefined, { Cookie: cookie, Origin: app.origin, 'X-CSRF-Token': boot.body.csrfToken! });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const sessionCookie = login.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
    const current = app.input(source.revision.id, [peer.revision.id]);
    const headers = { Cookie: sessionCookie, Origin: app.origin, 'X-Session-Context': login.body.sessionContext! };
    assert.equal((await app.request(path, 'POST', current, null, 'csrf-required', headers)).status, 403);
    assert.equal((await app.request(path, 'POST', current, null, 'csrf-required', { ...headers, 'X-CSRF-Token': login.body.csrfToken! })).status, 200);
  } finally { await app.close(); }
});

test('dependency writes recheck touched peer authority under the writer lock and roll back activity failures', async () => {
  const app = await start();
  try {
    const source = app.revision(), peer = app.revision(), input = app.input(source.revision.id, [peer.revision.id]);
    const mutate = app.store.mutate.bind(app.store); let intercepted = false;
    app.store.mutate = (...args) => {
      if (!intercepted) { intercepted = true; app.policy(peer.revision.id, { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) }); }
      return mutate(...args);
    };
    const denied = await app.request(app.path(source.revision.id), 'POST', input, 'bob', 'access-at-lock');
    assert.equal(denied.status, 404); assert.equal(denied.body.code, 'REVISION_DEPENDENCY_UNAVAILABLE');
    assert.equal(app.store.revisionDependencies.version(source.revision.id), 0); assert.deepEqual(app.store.database.prepare('SELECT * FROM revision_dependency_operations').all(), []);
    app.store.mutate = mutate;
    const event = app.store.event.bind(app.store), before = app.store.activities();
    app.store.event = (...args) => { if (args[0] === peer.revision.id) throw new Error('Injected activity write failure'); return event(...args); };
    const failed = await app.request(app.path(source.revision.id), 'POST', app.input(source.revision.id, [peer.revision.id]), 'alice', 'activity-atomic');
    assert.equal(failed.status, 500); assert.equal(app.store.revisionDependencies.version(source.revision.id), 0); assert.deepEqual(app.store.activities(), before);
    assert.deepEqual(app.store.database.prepare('SELECT * FROM revision_dependency_operations').all(), []);
    app.store.event = event;
    await app.change(source.revision.id, [peer.revision.id]);
    for (const id of [source.revision.id, peer.revision.id]) {
      const activity = app.store.activities(id).find(item => item.action === 'dependencies_changed'); assert.ok(activity);
      assert.equal(activity.detail, 'Updated revision dependencies.');
    }
  } finally { await app.close(); }
});
